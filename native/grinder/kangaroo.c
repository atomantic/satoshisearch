/*
 * Multi-threaded Pollard's kangaroo for secp256k1 interval ECDLP.
 *
 * Tame herd walks from known scalars near the upper end of [lo, hi].
 * Wild herd walks from the target pubkey (plus small offsets).
 * Same jump function; distinguished points (low x-bits) stored in a shared
 * table. A tame↔wild collision recovers k = d_tame − d_wild.
 */
#include "kangaroo.h"
#include "u256.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define N_JUMPS 32
#define HERD_TAME 0
#define HERD_WILD 1

/* ---- time -------------------------------------------------------------- */

static uint64_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)ts.tv_nsec / 1000000ull;
}

/* ---- DP hash table ----------------------------------------------------- */

typedef struct {
  uint8_t x[32];
  u256 dist;
  uint8_t herd; /* HERD_TAME / HERD_WILD */
  uint8_t used;
} DpEntry;

typedef struct {
  DpEntry *tab;
  size_t cap; /* power of two */
  size_t len;
  pthread_mutex_t mu;
} DpTable;

static uint64_t xhash(const uint8_t x[32]) {
  uint64_t h = 14695981039346656037ull;
  for (int i = 0; i < 32; i++) {
    h ^= x[i];
    h *= 1099511628211ull;
  }
  return h;
}

static bool dp_init(DpTable *t, size_t cap) {
  size_t c = 1024;
  while (c < cap) c <<= 1;
  t->tab = calloc(c, sizeof(DpEntry));
  if (!t->tab) return false;
  t->cap = c;
  t->len = 0;
  pthread_mutex_init(&t->mu, NULL);
  return true;
}

static void dp_free(DpTable *t) {
  free(t->tab);
  pthread_mutex_destroy(&t->mu);
  memset(t, 0, sizeof(*t));
}

static bool dp_grow(DpTable *t) {
  size_t ncap = t->cap * 2;
  DpEntry *ntab = calloc(ncap, sizeof(DpEntry));
  if (!ntab) return false;
  for (size_t i = 0; i < t->cap; i++) {
    if (!t->tab[i].used) continue;
    uint64_t h = xhash(t->tab[i].x);
    size_t j = (size_t)h & (ncap - 1);
    while (ntab[j].used) j = (j + 1) & (ncap - 1);
    ntab[j] = t->tab[i];
  }
  free(t->tab);
  t->tab = ntab;
  t->cap = ncap;
  return true;
}

/*
 * Insert or probe. On same-herd duplicate of same x, keep the entry (first wins).
 * On cross-herd collision, write *other and return 1.
 * Returns 0 if stored/no collision, 1 if cross collision, -1 on OOM.
 */
static int dp_insert(DpTable *t, const uint8_t x[32], const u256 *dist, uint8_t herd,
                     u256 *other_dist, uint8_t *other_herd) {
  pthread_mutex_lock(&t->mu);
  if (t->len * 10 >= t->cap * 7) {
    if (!dp_grow(t)) {
      pthread_mutex_unlock(&t->mu);
      return -1;
    }
  }
  uint64_t h = xhash(x);
  size_t i = (size_t)h & (t->cap - 1);
  for (;;) {
    DpEntry *e = &t->tab[i];
    if (!e->used) {
      e->used = 1;
      memcpy(e->x, x, 32);
      u256_copy(&e->dist, dist);
      e->herd = herd;
      t->len++;
      pthread_mutex_unlock(&t->mu);
      return 0;
    }
    if (memcmp(e->x, x, 32) == 0) {
      if (e->herd != herd) {
        u256_copy(other_dist, &e->dist);
        *other_herd = e->herd;
        pthread_mutex_unlock(&t->mu);
        return 1;
      }
      /* same herd, same point — ignore */
      pthread_mutex_unlock(&t->mu);
      return 0;
    }
    i = (i + 1) & (t->cap - 1);
  }
}

/* ---- jump table -------------------------------------------------------- */

typedef struct {
  u256 size[N_JUMPS];
  /* size[i]·G, precomputed once so each step is a point add, not a scalar mul. */
  secp256k1_pubkey pt[N_JUMPS];
} JumpTable;

static uint64_t splitmix64(uint64_t *s) {
  uint64_t z = (*s += 0x9E3779B97F4A7C15ull);
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  return z ^ (z >> 31);
}

/*
 * Kangaroo cost is width/(2m) + m for mean jump m, minimised at m = √(width/2).
 * So draw jump sizes uniformly from [1, 2^(bitlen/2)], giving mean ≈ √width / 2.
 *
 * Sizes must be ODD: a table whose entries share a factor confines tame and wild
 * to different cosets of that factor's lattice, and they can then never collide.
 * The draw is deterministic (fixed seed) so runs stay reproducible.
 */
static bool jumps_build(const secp256k1_context *ctx, JumpTable *jt, const u256 *width) {
  int wbits = u256_bitlen(width);
  int max_exp = wbits / 2;
  if (max_exp < 1) max_exp = 1;
  if (max_exp > 120) max_exp = 120; /* keep jumps well below curve order */

  uint64_t seed = 0x5361746F73686921ull; /* "Satoshi!" */
  for (int i = 0; i < N_JUMPS; i++) {
    u256_zero(&jt->size[i]);
    /* max_exp ≤ 120, so two 64-bit draws cover every bit we may keep. */
    uint64_t hi64 = splitmix64(&seed);
    uint64_t lo64 = splitmix64(&seed);
    for (int b = 0; b < 8; b++) {
      jt->size[i].b[31 - b] = (uint8_t)(lo64 >> (8 * b));
      jt->size[i].b[23 - b] = (uint8_t)(hi64 >> (8 * b));
    }
    /* Mask to max_exp bits, then force odd (also guarantees non-zero). */
    for (int bit = max_exp; bit < 256; bit++) {
      jt->size[i].b[31 - (bit / 8)] &= (uint8_t)~(1u << (bit % 8));
    }
    jt->size[i].b[31] |= 1u;

    if (!secp256k1_ec_pubkey_create(ctx, &jt->pt[i], jt->size[i].b)) return false;
  }
  return true;
}

static int jump_index(const uint8_t x[32]) {
  /* Mix a few bytes so consecutive points diverge. */
  uint32_t v = ((uint32_t)x[28] << 24) | ((uint32_t)x[29] << 16) | ((uint32_t)x[30] << 8) |
               (uint32_t)x[31];
  v ^= ((uint32_t)x[0] << 16) | (uint32_t)x[1];
  return (int)(v % N_JUMPS);
}

static bool is_distinguished(const uint8_t x[32], int dp_bits) {
  if (dp_bits <= 0) return true;
  int full = dp_bits / 8;
  int rem = dp_bits % 8;
  for (int i = 0; i < full; i++) {
    if (x[31 - i] != 0) return false;
  }
  if (rem) {
    uint8_t mask = (uint8_t)((1u << rem) - 1);
    if ((x[31 - full] & mask) != 0) return false;
  }
  return true;
}

/* ---- kangaroo state ---------------------------------------------------- */

typedef struct {
  secp256k1_pubkey pub;
  u256 dist;
  uint8_t herd;
} Roo;

typedef struct {
  const secp256k1_context *ctx;
  const JumpTable *jumps;
  DpTable *dps;
  int dp_bits;
  Roo *roos;
  int n_roos;
  uint64_t *ops_counter;
  uint64_t ops_local; /* thread-private; flushed to *ops_counter in batches */
  uint64_t *dp_counter;
  volatile int *found;
  volatile int *stop;
  u256 *found_priv; /* written under found lock */
  pthread_mutex_t *found_mu;
  const u256 *lo;
  const u256 *hi;
  const secp256k1_pubkey *target_pub;
} WorkerArg;

static bool point_x(const secp256k1_context *ctx, const secp256k1_pubkey *p, uint8_t x[32]) {
  uint8_t comp[33];
  size_t len = 33;
  if (!secp256k1_ec_pubkey_serialize(ctx, comp, &len, p, SECP256K1_EC_COMPRESSED)) return false;
  memcpy(x, comp + 1, 32);
  return true;
}

static bool verify_priv(const secp256k1_context *ctx, const uint8_t priv[32],
                        const secp256k1_pubkey *target) {
  secp256k1_pubkey got;
  if (!secp256k1_ec_seckey_verify(ctx, priv)) return false;
  if (!secp256k1_ec_pubkey_create(ctx, &got, priv)) return false;
  uint8_t a[33], b[33];
  size_t la = 33, lb = 33;
  secp256k1_ec_pubkey_serialize(ctx, a, &la, &got, SECP256K1_EC_COMPRESSED);
  secp256k1_ec_pubkey_serialize(ctx, b, &lb, target, SECP256K1_EC_COMPRESSED);
  return la == lb && memcmp(a, b, la) == 0;
}

static bool try_recover(WorkerArg *wa, const u256 *d_tame, const u256 *d_wild) {
  /* k = d_tame - d_wild */
  u256 k;
  if (u256_sub(&k, d_tame, d_wild)) {
    /* borrow: d_tame < d_wild — not a valid positive key for our setup */
    return false;
  }
  if (u256_cmp(&k, wa->lo) < 0 || u256_cmp(&k, wa->hi) > 0) return false;
  if (!verify_priv(wa->ctx, k.b, wa->target_pub)) return false;

  pthread_mutex_lock(wa->found_mu);
  if (!*wa->found) {
    u256_copy(wa->found_priv, &k);
    *wa->found = 1;
    *wa->stop = 1;
  }
  pthread_mutex_unlock(wa->found_mu);
  return true;
}

/* Batch counter flushes: one shared atomic per jump serialises every worker
 * on the same cache line, which dominates once the jump itself is a point add. */
#define OPS_FLUSH 4096

static void ops_flush(WorkerArg *wa) {
  if (!wa->ops_local) return;
  __atomic_fetch_add(wa->ops_counter, wa->ops_local, __ATOMIC_RELAXED);
  wa->ops_local = 0;
}

static void step_roo(WorkerArg *wa, Roo *r) {
  uint8_t x[32];
  if (!point_x(wa->ctx, &r->pub, x)) return;

  int ji = jump_index(x);
  /* point += jump[i]·G — the jump points are precomputed, so this is an add.
   * combine() zeroes its output before reading inputs, so it cannot alias. */
  secp256k1_pubkey next;
  const secp256k1_pubkey *ins[2] = {&r->pub, &wa->jumps->pt[ji]};
  if (!secp256k1_ec_pubkey_combine(wa->ctx, &next, ins, 2)) {
    /* landed on infinity — vanishingly rare; skip the jump */
    return;
  }
  r->pub = next;
  u256_add(&r->dist, &r->dist, &wa->jumps->size[ji]);
  if (++wa->ops_local >= OPS_FLUSH) ops_flush(wa);

  if (!point_x(wa->ctx, &r->pub, x)) return;
  if (!is_distinguished(x, wa->dp_bits)) return;

  __atomic_fetch_add(wa->dp_counter, 1, __ATOMIC_RELAXED);

  u256 other;
  uint8_t other_herd;
  int rc = dp_insert(wa->dps, x, &r->dist, r->herd, &other, &other_herd);
  if (rc != 1) return;

  /* Cross-herd collision */
  const u256 *dt, *dw;
  if (r->herd == HERD_TAME) {
    dt = &r->dist;
    dw = &other;
  } else {
    dt = &other;
    dw = &r->dist;
  }
  try_recover(wa, dt, dw);
}

static void *worker_fn(void *arg) {
  WorkerArg *wa = arg;
  /* Each worker loops its assigned kangaroos until stop. */
  while (!__atomic_load_n(wa->stop, __ATOMIC_RELAXED)) {
    for (int i = 0; i < wa->n_roos; i++) {
      if (__atomic_load_n(wa->stop, __ATOMIC_RELAXED)) break;
      step_roo(wa, &wa->roos[i]);
    }
  }
  ops_flush(wa);
  return NULL;
}

/* ---- public API -------------------------------------------------------- */

static int auto_dp_bits(const u256 *width) {
  /* Aim for ~2^20 DPs over a full expected run: ops≈2√w, DP rate 2^{-dp}.
   * dp ≈ log2(√w) - 10 ≈ bitlen/2 - 10, clamped. */
  int wbits = u256_bitlen(width);
  /* Small intervals: fewer trailing zeros so we actually hit DPs. */
  if (wbits < 32) return 4;
  if (wbits < 48) return 8;
  int dp = wbits / 2 - 10;
  return dp > 24 ? 24 : dp;
}

bool kangaroo_solve(const secp256k1_context *ctx, const KangarooJob *job, KangarooResult *out) {
  memset(out, 0, sizeof(*out));
  if (!ctx || !job) {
    snprintf(out->err, sizeof(out->err), "null args");
    return false;
  }

  u256 lo, hi, width;
  memcpy(lo.b, job->lo, 32);
  memcpy(hi.b, job->hi, 32);
  if (u256_cmp(&lo, &hi) > 0) {
    snprintf(out->err, sizeof(out->err), "lo > hi");
    return false;
  }
  /* width = hi - lo + 1 */
  u256_sub(&width, &hi, &lo);
  u256 one;
  u256_set_u64(&one, 1);
  u256_add(&width, &width, &one);

  secp256k1_pubkey target;
  if (!secp256k1_ec_pubkey_parse(ctx, &target, job->pubkey, job->pubkey_len)) {
    snprintf(out->err, sizeof(out->err), "bad pubkey");
    return false;
  }

  int threads = job->threads > 0 ? job->threads : 1;
  if (threads > 256) threads = 256;
  int dp_bits = job->dp_bits > 0 ? job->dp_bits : auto_dp_bits(&width);

  JumpTable jumps;
  if (!jumps_build(ctx, &jumps, &width)) {
    snprintf(out->err, sizeof(out->err), "jump table build failed");
    return false;
  }

  DpTable dps;
  /* Start table sized for modest runs; grows as needed. */
  if (!dp_init(&dps, 1u << 16)) {
    snprintf(out->err, sizeof(out->err), "dp table OOM");
    return false;
  }

  /*
   * Kangaroos per process: 2 per thread (1 tame + 1 wild).
   * Tame i starts at scalar (hi - i) with dist = hi - i  (known dlog).
   * Wild i starts at target + i·G with dist = i.
   */
  int n_roos = threads * 2;
  if (n_roos < 4) n_roos = 4;

  Roo *roos = calloc((size_t)n_roos, sizeof(Roo));
  if (!roos) {
    dp_free(&dps);
    snprintf(out->err, sizeof(out->err), "roos OOM");
    return false;
  }

  uint8_t g_seckey_one[32] = {0};
  g_seckey_one[31] = 1;

  for (int i = 0; i < n_roos; i++) {
    if (i % 2 == 0) {
      /* tame */
      u256 start;
      u256_copy(&start, &hi);
      /* offset i/2 downward: start = hi - (i/2) */
      u256 off;
      u256_set_u64(&off, (uint64_t)(i / 2));
      if (u256_cmp(&start, &off) >= 0) u256_sub(&start, &start, &off);
      else u256_copy(&start, &lo);

      if (!secp256k1_ec_seckey_verify(ctx, start.b) ||
          !secp256k1_ec_pubkey_create(ctx, &roos[i].pub, start.b)) {
        /* fallback: hi itself */
        memcpy(start.b, hi.b, 32);
        if (!secp256k1_ec_pubkey_create(ctx, &roos[i].pub, start.b)) {
          free(roos);
          dp_free(&dps);
          snprintf(out->err, sizeof(out->err), "tame start failed");
          return false;
        }
      }
      u256_copy(&roos[i].dist, &start);
      roos[i].herd = HERD_TAME;
    } else {
      /* wild: P + offset·G */
      int off = i / 2;
      roos[i].pub = target;
      u256_set_u64(&roos[i].dist, (uint64_t)off);
      for (int j = 0; j < off; j++) {
        if (!secp256k1_ec_pubkey_tweak_add(ctx, &roos[i].pub, g_seckey_one)) break;
      }
      roos[i].herd = HERD_WILD;
    }
  }

  uint64_t ops = 0, dpc = 0;
  volatile int found = 0, stop = 0;
  u256 found_priv;
  u256_zero(&found_priv);
  pthread_mutex_t found_mu = PTHREAD_MUTEX_INITIALIZER;

  /* Partition roos across threads */
  pthread_t *ths = calloc((size_t)threads, sizeof(pthread_t));
  WorkerArg *wargs = calloc((size_t)threads, sizeof(WorkerArg));
  if (!ths || !wargs) {
    free(ths);
    free(wargs);
    free(roos);
    dp_free(&dps);
    snprintf(out->err, sizeof(out->err), "thread OOM");
    return false;
  }

  int base = 0;
  int chunk = (n_roos + threads - 1) / threads;
  for (int t = 0; t < threads; t++) {
    int n = chunk;
    if (base + n > n_roos) n = n_roos - base;
    wargs[t].ctx = ctx;
    wargs[t].jumps = &jumps;
    wargs[t].dps = &dps;
    wargs[t].dp_bits = dp_bits;
    wargs[t].roos = roos + base;
    wargs[t].n_roos = n;
    wargs[t].ops_counter = &ops;
    wargs[t].dp_counter = &dpc;
    wargs[t].found = &found;
    wargs[t].stop = &stop;
    wargs[t].found_priv = &found_priv;
    wargs[t].found_mu = &found_mu;
    wargs[t].lo = &lo;
    wargs[t].hi = &hi;
    wargs[t].target_pub = &target;
    base += n;
  }

  uint64_t t0 = now_ms();
  for (int t = 0; t < threads; t++) {
    if (wargs[t].n_roos <= 0) continue;
    /* On failure leave the slot empty — running worker_fn inline here would
     * block the monitor loop that is the only thing able to set `stop`. */
    if (pthread_create(&ths[t], NULL, worker_fn, &wargs[t]) != 0) ths[t] = 0;
  }

  /* Progress / cancel / max_ops monitor on this thread */
  while (!found && !stop) {
    if (job->should_stop && job->should_stop(job->stop_user)) {
      stop = 1;
      out->cancelled = true;
      break;
    }
    uint64_t o = __atomic_load_n(&ops, __ATOMIC_RELAXED);
    uint64_t d = __atomic_load_n(&dpc, __ATOMIC_RELAXED);
    uint64_t elapsed = now_ms() - t0;
    if (job->on_progress) job->on_progress(o, d, elapsed, job->progress_user);
    if (job->max_ops && o >= job->max_ops) {
      stop = 1;
      out->exhausted = true;
      break;
    }
    /* Consumers poll on the order of seconds; emitting at 20Hz just burned
     * pipe bandwidth and JSON parses. 250ms keeps cancel latency sub-second. */
    struct timespec ts = {.tv_sec = 0, .tv_nsec = 250 * 1000 * 1000};
    nanosleep(&ts, NULL);
  }

  stop = 1;
  for (int t = 0; t < threads; t++) {
    if (ths[t]) pthread_join(ths[t], NULL);
  }

  out->ops = __atomic_load_n(&ops, __ATOMIC_RELAXED);
  out->dps = __atomic_load_n(&dpc, __ATOMIC_RELAXED);
  out->elapsed_ms = now_ms() - t0;
  if (found) {
    out->found = true;
    memcpy(out->priv, found_priv.b, 32);
  }

  free(ths);
  free(wargs);
  free(roos);
  dp_free(&dps);
  pthread_mutex_destroy(&found_mu);
  return true;
}

/* ---- selftest ---------------------------------------------------------- */

static bool solve_known(const secp256k1_context *ctx, uint64_t k, uint64_t lo, uint64_t hi) {
  uint8_t priv[32] = {0};
  for (int i = 0; i < 8; i++) priv[31 - i] = (uint8_t)(k >> (8 * i));

  secp256k1_pubkey pub;
  if (!secp256k1_ec_pubkey_create(ctx, &pub, priv)) return false;
  uint8_t comp[33];
  size_t len = 33;
  secp256k1_ec_pubkey_serialize(ctx, comp, &len, &pub, SECP256K1_EC_COMPRESSED);

  KangarooJob job;
  memset(&job, 0, sizeof(job));
  memcpy(job.pubkey, comp, 33);
  job.pubkey_len = 33;
  for (int i = 0; i < 8; i++) {
    job.lo[31 - i] = (uint8_t)(lo >> (8 * i));
    job.hi[31 - i] = (uint8_t)(hi >> (8 * i));
  }
  job.threads = 2;
  job.dp_bits = 4;
  job.max_ops = 50ull * 1000 * 1000; /* safety cap for CI */

  KangarooResult res;
  if (!kangaroo_solve(ctx, &job, &res)) return false;
  if (!res.found) {
    fprintf(stderr, "selftest miss k=%llu ops=%llu\n", (unsigned long long)k,
            (unsigned long long)res.ops);
    return false;
  }
  if (memcmp(res.priv, priv, 32) != 0) {
    fprintf(stderr, "selftest wrong key for k=%llu\n", (unsigned long long)k);
    return false;
  }
  return true;
}

int kangaroo_selftest(void) {
  secp256k1_context *ctx = secp256k1_context_create(SECP256K1_CONTEXT_NONE);
  if (!ctx) return 1;

  struct {
    uint64_t k, lo, hi;
  } cases[] = {
      {1000ull, 1ull, 5000ull},
      {0x12345ull, 0x10000ull, 0x20000ull},
      {0xABCDEFULL, 0xA00000ull, 0xF00000ull},
  };
  int n = (int)(sizeof(cases) / sizeof(cases[0]));
  for (int i = 0; i < n; i++) {
    if (!solve_known(ctx, cases[i].k, cases[i].lo, cases[i].hi)) {
      secp256k1_context_destroy(ctx);
      return 2 + i;
    }
    fprintf(stderr, "kangaroo selftest case %d ok (k=0x%llx)\n", i,
            (unsigned long long)cases[i].k);
  }
  secp256k1_context_destroy(ctx);
  fprintf(stderr, "kangaroo selftest: all %d cases passed\n", n);
  return 0;
}
