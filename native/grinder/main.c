/*
 * satoshi-grind — native hot loop for the SatoshiSearch grinder.
 *
 * Speaks a length-prefixed binary protocol on stdin/stdout. Node (pool.ts)
 * loads the match-set once, then streams work units:
 *
 *   BATCH — packed 32-byte private keys (arbitrary sources)
 *   RANGE — sequential scalars [start, start+count) generated here, using
 *           pubkey_create once then secp256k1_ec_pubkey_tweak_add(+1) so we
 *           walk the curve instead of re-multiplying every key.
 *
 * Per key: libsecp256k1 → compressed + uncompressed → HASH160 → binary sets.
 * Origins stay on the Node side (results carry the batch index only).
 *
 * Usage:
 *   satoshi-grind [--threads N]          # protocol mode (default)
 *   satoshi-grind --bench [keys]         # BATCH-style throughput
 *   satoshi-grind --bench-range [keys]   # RANGE-mode throughput
 *   satoshi-grind --selftest
 */
#include "hash.h"
#include "set.h"

#include <secp256k1.h>

#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* ---- framing ----------------------------------------------------------- */

enum {
  MSG_INIT = 1,
  MSG_READY = 2,
  MSG_BATCH = 3,
  MSG_RESULT = 4,
  MSG_ERROR = 5,
  MSG_RANGE = 6
};

enum {
  KIND_H160_COMP = 0,
  KIND_H160_UNCOMP = 1,
  KIND_PUBKEY = 2
};

static const uint8_t SECKEY_ONE[32] = {
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};

static bool write_all(const void *buf, size_t n) {
  const uint8_t *p = buf;
  while (n) {
    ssize_t w = write(STDOUT_FILENO, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    p += (size_t)w;
    n -= (size_t)w;
  }
  return true;
}

static bool read_all(void *buf, size_t n) {
  uint8_t *p = buf;
  while (n) {
    ssize_t r = read(STDIN_FILENO, p, n);
    if (r == 0) return false;
    if (r < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    p += (size_t)r;
    n -= (size_t)r;
  }
  return true;
}

/* Little-endian u32 codec shared by the framing and payload readers/writers. */
static uint32_t rd_u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void put_u32(uint8_t *b, size_t *o, uint32_t v) {
  b[*o] = (uint8_t)v;
  b[*o + 1] = (uint8_t)(v >> 8);
  b[*o + 2] = (uint8_t)(v >> 16);
  b[*o + 3] = (uint8_t)(v >> 24);
  *o += 4;
}

static bool write_u32(uint32_t v) {
  uint8_t b[4];
  size_t o = 0;
  put_u32(b, &o, v);
  return write_all(b, 4);
}

static bool read_u32(uint32_t *out) {
  uint8_t b[4];
  if (!read_all(b, 4)) return false;
  *out = rd_u32(b);
  return true;
}

static void die(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
  exit(1);
}

/* ---- 256-bit big-endian scalar helpers -------------------------------- */

static void be256_inc(uint8_t n[32]) {
  for (int i = 31; i >= 0; i--) {
    if (++n[i] != 0) break;
  }
}

static void be256_add_u32(uint8_t n[32], uint32_t add) {
  uint32_t carry = add;
  for (int i = 31; i >= 0 && carry; i--) {
    uint32_t s = (uint32_t)n[i] + carry;
    n[i] = (uint8_t)s;
    carry = s >> 8;
  }
}

static void be256_copy_add_u32(uint8_t out[32], const uint8_t start[32], uint32_t off) {
  memcpy(out, start, 32);
  if (off) be256_add_u32(out, off);
}

/* ---- match result collection ------------------------------------------ */

typedef struct {
  uint32_t index;
  uint8_t kind;
  uint8_t mlen;
  uint8_t matched[65];
  uint8_t priv[32];
} Match;

typedef struct {
  Match *items;
  size_t len;
  size_t cap;
  uint32_t checked;
} MatchList;

static void ml_init(MatchList *ml) {
  memset(ml, 0, sizeof(*ml));
}

static void ml_free(MatchList *ml) {
  free(ml->items);
  memset(ml, 0, sizeof(*ml));
}

static bool ml_push(MatchList *ml, const Match *m) {
  if (ml->len == ml->cap) {
    size_t nc = ml->cap ? ml->cap * 2 : 8;
    Match *n = realloc(ml->items, nc * sizeof(Match));
    if (!n) return false;
    ml->items = n;
    ml->cap = nc;
  }
  ml->items[ml->len++] = *m;
  return true;
}

/* ---- match one pubkey/priv pair --------------------------------------- */

static void check_pub(const secp256k1_context *ctx, const H160Set *h160s, const PubSet *pubs,
                      const secp256k1_pubkey *pub, const uint8_t priv[32], uint32_t index,
                      MatchList *out) {
  out->checked++;

  uint8_t comp[33];
  uint8_t uncomp[65];
  size_t clen = 33, ulen = 65;
  secp256k1_ec_pubkey_serialize(ctx, comp, &clen, pub, SECP256K1_EC_COMPRESSED);
  secp256k1_ec_pubkey_serialize(ctx, uncomp, &ulen, pub, SECP256K1_EC_UNCOMPRESSED);

  Match m;
  m.index = index;
  memcpy(m.priv, priv, 32);

  if (pubs->set.len) {
    if (pub_set_has(pubs, comp, 33)) {
      m.kind = KIND_PUBKEY;
      m.mlen = 33;
      memcpy(m.matched, comp, 33);
      ml_push(out, &m);
      return;
    }
    if (pub_set_has(pubs, uncomp, 65)) {
      m.kind = KIND_PUBKEY;
      m.mlen = 65;
      memcpy(m.matched, uncomp, 65);
      ml_push(out, &m);
      return;
    }
  }

  uint8_t h[20];
  hash160(comp, 33, h);
  if (h160_set_has(h160s, h)) {
    m.kind = KIND_H160_COMP;
    m.mlen = 20;
    memcpy(m.matched, h, 20);
    ml_push(out, &m);
    return;
  }
  hash160(uncomp, 65, h);
  if (h160_set_has(h160s, h)) {
    m.kind = KIND_H160_UNCOMP;
    m.mlen = 20;
    memcpy(m.matched, h, 20);
    ml_push(out, &m);
  }
}

static void check_one(const secp256k1_context *ctx, const H160Set *h160s, const PubSet *pubs,
                      const uint8_t priv[32], uint32_t index, MatchList *out) {
  secp256k1_pubkey pub;
  if (!secp256k1_ec_pubkey_create(ctx, &pub, priv)) return;
  check_pub(ctx, h160s, pubs, &pub, priv, index, out);
}

/* ---- thread fan-out ---------------------------------------------------- */

/*
 * Head shared by every worker arg struct. run_threads() fills in the index
 * slice and drains `local`, so it must be the first member of the concrete
 * arg struct — the worker pointer it hands out is also the WorkerCommon.
 */
typedef struct {
  MatchList local;
  uint32_t start; /* inclusive index into the work unit */
  uint32_t end;   /* exclusive */
} WorkerCommon;

/*
 * Split [0, count) into `threads` contiguous slices, run `fn` over each, and
 * merge the per-thread MatchLists into `out`. `args` is a caller-allocated
 * array of `threads` structs of size `argsize`, each starting with a
 * WorkerCommon and pre-filled with the work-specific fields. Threads that
 * fail to spawn run inline. Returns false only if merging runs out of memory.
 */
static bool run_threads(void *(*fn)(void *), void *args, size_t argsize, int threads,
                        uint32_t count, MatchList *out) {
  pthread_t *ths = calloc((size_t)threads, sizeof(pthread_t));
  if (!ths) return false;

  uint32_t chunk = (count + (uint32_t)threads - 1) / (uint32_t)threads;
  for (int t = 0; t < threads; t++) {
    uint32_t start = (uint32_t)t * chunk;
    if (start >= count) break;
    uint32_t end = start + chunk;
    if (end > count) end = count;
    WorkerCommon *wc = (WorkerCommon *)((uint8_t *)args + (size_t)t * argsize);
    wc->start = start;
    wc->end = end;
    if (pthread_create(&ths[t], NULL, fn, wc) != 0) {
      fn(wc);
      ths[t] = 0;
    }
  }

  bool ok = true;
  for (int t = 0; t < threads; t++) {
    WorkerCommon *wc = (WorkerCommon *)((uint8_t *)args + (size_t)t * argsize);
    if (wc->end <= wc->start) continue;
    if (ths[t]) pthread_join(ths[t], NULL);
    if (ok) {
      out->checked += wc->local.checked;
      for (size_t i = 0; i < wc->local.len; i++) {
        if (!ml_push(out, &wc->local.items[i])) {
          ok = false;
          break;
        }
      }
    }
    ml_free(&wc->local);
  }
  free(ths);
  return ok;
}

/* ---- BATCH workers ---------------------------------------------------- */

typedef struct {
  WorkerCommon c; /* must stay first */
  const secp256k1_context *ctx;
  const H160Set *h160s;
  const PubSet *pubs;
  const uint8_t *privs;
} BatchWorkerArg;

static void *batch_worker_fn(void *arg) {
  BatchWorkerArg *wa = arg;
  ml_init(&wa->c.local);
  for (uint32_t i = wa->c.start; i < wa->c.end; i++) {
    check_one(wa->ctx, wa->h160s, wa->pubs, wa->privs + (size_t)i * 32, i, &wa->c.local);
  }
  return NULL;
}

static bool grind_batch(const secp256k1_context *ctx, const H160Set *h160s, const PubSet *pubs,
                        const uint8_t *privs, uint32_t count, int threads, MatchList *out) {
  ml_init(out);
  if (count == 0) return true;

  if (threads < 1) threads = 1;
  if ((uint32_t)threads > count) threads = (int)count;

  BatchWorkerArg *args = calloc((size_t)threads, sizeof(BatchWorkerArg));
  if (!args) return false;
  for (int t = 0; t < threads; t++) {
    args[t].ctx = ctx;
    args[t].h160s = h160s;
    args[t].pubs = pubs;
    args[t].privs = privs;
  }

  bool ok = run_threads(batch_worker_fn, args, sizeof(BatchWorkerArg), threads, count, out);
  free(args);
  return ok;
}

/* ---- RANGE workers (sequential + tweak_add) --------------------------- */

typedef struct {
  WorkerCommon c; /* must stay first */
  const secp256k1_context *ctx;
  const H160Set *h160s;
  const PubSet *pubs;
  const uint8_t *range_start; /* 32-byte BE scalar for index 0 */
} RangeWorkerArg;

static void *range_worker_fn(void *arg) {
  RangeWorkerArg *wa = arg;
  ml_init(&wa->c.local);
  if (wa->c.start >= wa->c.end) return NULL;

  uint8_t priv[32];
  be256_copy_add_u32(priv, wa->range_start, wa->c.start);

  secp256k1_pubkey pub;
  bool have_pub = false;

  for (uint32_t i = wa->c.start; i < wa->c.end; i++) {
    if (!have_pub) {
      if (secp256k1_ec_seckey_verify(wa->ctx, priv) &&
          secp256k1_ec_pubkey_create(wa->ctx, &pub, priv)) {
        have_pub = true;
      } else {
        /* invalid scalar — advance and re-create next */
        be256_inc(priv);
        continue;
      }
    }

    check_pub(wa->ctx, wa->h160s, wa->pubs, &pub, priv, i, &wa->c.local);

    if (i + 1 >= wa->c.end) break;

    be256_inc(priv);
    /* Walk the curve: P_{k+1} = P_k + G via tweak_add(1). Far cheaper than
     * full scalar mult. On rare failure, fall back to create from priv. */
    if (!secp256k1_ec_pubkey_tweak_add(wa->ctx, &pub, SECKEY_ONE)) {
      have_pub = false;
      if (secp256k1_ec_seckey_verify(wa->ctx, priv) &&
          secp256k1_ec_pubkey_create(wa->ctx, &pub, priv)) {
        have_pub = true;
      }
    }
  }
  return NULL;
}

static bool grind_range(const secp256k1_context *ctx, const H160Set *h160s, const PubSet *pubs,
                        const uint8_t start[32], uint32_t count, int threads, MatchList *out) {
  ml_init(out);
  if (count == 0) return true;

  if (threads < 1) threads = 1;
  if ((uint32_t)threads > count) threads = (int)count;

  RangeWorkerArg *args = calloc((size_t)threads, sizeof(RangeWorkerArg));
  if (!args) return false;
  for (int t = 0; t < threads; t++) {
    args[t].ctx = ctx;
    args[t].h160s = h160s;
    args[t].pubs = pubs;
    args[t].range_start = start;
  }

  bool ok = run_threads(range_worker_fn, args, sizeof(RangeWorkerArg), threads, count, out);
  free(args);
  return ok;
}

/* ---- protocol handlers ------------------------------------------------ */

static bool send_msg(uint32_t type, const void *payload, uint32_t plen) {
  if (!write_u32(type)) return false;
  if (!write_u32(plen)) return false;
  if (plen && !write_all(payload, plen)) return false;
  return true;
}

static bool send_error(const char *msg) {
  uint32_t n = (uint32_t)strlen(msg);
  if (!write_u32(MSG_ERROR)) return false;
  if (!write_u32(n)) return false;
  return write_all(msg, n);
}

static bool handle_init(const uint8_t *payload, uint32_t plen, H160Set *h160s, PubSet *pubs) {
  if (plen < 8) return false;
  uint32_t off = 0;
  uint32_t n_h160 = rd_u32(payload + off);
  off += 4;
  if (off + n_h160 * 20u + 4u > plen) return false;
  if (!h160_set_init(h160s, n_h160)) return false;
  for (uint32_t i = 0; i < n_h160; i++) {
    if (!h160_set_insert(h160s, payload + off)) return false;
    off += 20;
  }
  uint32_t n_pub = rd_u32(payload + off);
  off += 4;
  if (!pub_set_init(pubs, n_pub)) return false;
  for (uint32_t i = 0; i < n_pub; i++) {
    if (off >= plen) return false;
    uint8_t len = payload[off++];
    if ((len != 33 && len != 65) || off + len > plen) return false;
    if (!pub_set_insert(pubs, payload + off, len)) return false;
    off += len;
  }
  return true;
}

static bool send_result(uint32_t id, const MatchList *ml) {
  size_t need = 12;
  for (size_t i = 0; i < ml->len; i++) {
    need += 4 + 1 + 1 + ml->items[i].mlen + 32;
  }
  uint8_t *buf = malloc(need);
  if (!buf) return false;
  size_t o = 0;
  put_u32(buf, &o, id);
  put_u32(buf, &o, ml->checked);
  put_u32(buf, &o, (uint32_t)ml->len);
  for (size_t i = 0; i < ml->len; i++) {
    const Match *m = &ml->items[i];
    put_u32(buf, &o, m->index);
    buf[o++] = m->kind;
    buf[o++] = m->mlen;
    memcpy(buf + o, m->matched, m->mlen);
    o += m->mlen;
    memcpy(buf + o, m->priv, 32);
    o += 32;
  }
  bool ok = send_msg(MSG_RESULT, buf, (uint32_t)o);
  free(buf);
  return ok;
}

static int protocol_loop(int threads) {
  secp256k1_context *ctx = secp256k1_context_create(SECP256K1_CONTEXT_NONE);
  if (!ctx) die("secp256k1_context_create failed");

  H160Set h160s;
  PubSet pubs;
  memset(&h160s, 0, sizeof(h160s));
  memset(&pubs, 0, sizeof(pubs));
  bool inited = false;

  for (;;) {
    uint32_t type, plen;
    if (!read_u32(&type)) break;
    if (!read_u32(&plen)) {
      send_error("truncated payload length");
      break;
    }
    uint8_t *payload = NULL;
    if (plen) {
      payload = malloc(plen);
      if (!payload || !read_all(payload, plen)) {
        free(payload);
        send_error("truncated payload");
        break;
      }
    }

    if (type == MSG_INIT) {
      h160_set_free(&h160s);
      pub_set_free(&pubs);
      if (!handle_init(payload, plen, &h160s, &pubs)) {
        free(payload);
        send_error("bad INIT");
        break;
      }
      free(payload);
      inited = true;
      if (!send_msg(MSG_READY, NULL, 0)) break;
      continue;
    }

    if (type == MSG_BATCH) {
      if (!inited) {
        free(payload);
        send_error("BATCH before INIT");
        break;
      }
      if (plen < 8) {
        free(payload);
        send_error("short BATCH");
        break;
      }
      uint32_t id = rd_u32(payload);
      uint32_t count = rd_u32(payload + 4);
      if (8u + count * 32u != plen) {
        free(payload);
        send_error("BATCH length mismatch");
        break;
      }
      MatchList ml;
      if (!grind_batch(ctx, &h160s, &pubs, payload + 8, count, threads, &ml)) {
        free(payload);
        ml_free(&ml);
        send_error("grind OOM");
        break;
      }
      free(payload);
      if (!send_result(id, &ml)) {
        ml_free(&ml);
        break;
      }
      ml_free(&ml);
      continue;
    }

    if (type == MSG_RANGE) {
      if (!inited) {
        free(payload);
        send_error("RANGE before INIT");
        break;
      }
      /* id:u32, count:u32, start:32 */
      if (plen != 8 + 32) {
        free(payload);
        send_error("RANGE length mismatch");
        break;
      }
      uint32_t id = rd_u32(payload);
      uint32_t count = rd_u32(payload + 4);
      const uint8_t *start = payload + 8;
      MatchList ml;
      if (!grind_range(ctx, &h160s, &pubs, start, count, threads, &ml)) {
        free(payload);
        ml_free(&ml);
        send_error("range OOM");
        break;
      }
      free(payload);
      if (!send_result(id, &ml)) {
        ml_free(&ml);
        break;
      }
      ml_free(&ml);
      continue;
    }

    free(payload);
    send_error("unknown message type");
    break;
  }

  h160_set_free(&h160s);
  pub_set_free(&pubs);
  secp256k1_context_destroy(ctx);
  return 0;
}

/* ---- bench / selftest ------------------------------------------------- */

static void int_to_priv(uint64_t n, uint8_t out[32]) {
  memset(out, 0, 32);
  for (int i = 0; i < 8; i++) out[31 - i] = (uint8_t)(n >> (i * 8));
}

static double now_sec(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static int run_bench(uint32_t keys, int threads, bool range_mode) {
  secp256k1_context *ctx = secp256k1_context_create(SECP256K1_CONTEXT_NONE);
  H160Set h160s;
  PubSet pubs;
  h160_set_init(&h160s, 1);
  pub_set_init(&pubs, 1);

  uint8_t plant_priv[32];
  int_to_priv(42, plant_priv);
  secp256k1_pubkey pub;
  if (!secp256k1_ec_pubkey_create(ctx, &pub, plant_priv)) die("bench plant failed");
  uint8_t comp[33];
  size_t clen = 33;
  secp256k1_ec_pubkey_serialize(ctx, comp, &clen, &pub, SECP256K1_EC_COMPRESSED);
  uint8_t h[20];
  hash160(comp, 33, h);
  h160_set_insert(&h160s, h);

  MatchList ml;
  double t0 = now_sec();
  if (range_mode) {
    uint8_t start[32];
    int_to_priv(1, start);
    if (!grind_range(ctx, &h160s, &pubs, start, keys, threads, &ml)) die("grind failed");
  } else {
    uint8_t *privs = malloc((size_t)keys * 32);
    if (!privs) die("OOM");
    for (uint32_t i = 0; i < keys; i++) int_to_priv(i + 1, privs + (size_t)i * 32);
    if (!grind_batch(ctx, &h160s, &pubs, privs, keys, threads, &ml)) die("grind failed");
    free(privs);
  }
  double dt = now_sec() - t0;
  double rate = dt > 0 ? (double)ml.checked / dt : 0;

  printf("satoshi-grind bench%s: checked=%u matches=%zu threads=%d time=%.3fs rate=%.0f keys/s\n",
         range_mode ? "-range" : "", ml.checked, ml.len, threads, dt, rate);

  ml_free(&ml);
  h160_set_free(&h160s);
  pub_set_free(&pubs);
  secp256k1_context_destroy(ctx);
  return 0;
}

static int run_selftest(void) {
  uint8_t priv[32];
  memset(priv, 0, 32);
  priv[31] = 1;

  secp256k1_context *ctx = secp256k1_context_create(SECP256K1_CONTEXT_NONE);
  secp256k1_pubkey pub;
  if (!secp256k1_ec_pubkey_create(ctx, &pub, priv)) die("pubkey create failed");

  uint8_t comp[33];
  size_t clen = 33;
  secp256k1_ec_pubkey_serialize(ctx, comp, &clen, &pub, SECP256K1_EC_COMPRESSED);

  static const uint8_t expect_comp[33] = {
      0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62,
      0x95, 0xce, 0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28,
      0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98};
  if (memcmp(comp, expect_comp, 33) != 0) {
    fprintf(stderr, "selftest: compressed pubkey mismatch\n");
    return 1;
  }

  uint8_t h[20];
  hash160(comp, 33, h);
  static const uint8_t expect_h160[20] = {0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94,
                                          0x1c, 0x45, 0xd1, 0xb3, 0xa3, 0x23, 0xf1, 0x43, 0x3b, 0xd6};
  if (memcmp(h, expect_h160, 20) != 0) {
    fprintf(stderr, "selftest: hash160 mismatch\n");
    return 1;
  }

  H160Set empty, planted;
  PubSet pubs;
  h160_set_init(&empty, 1);
  h160_set_init(&planted, 1);
  pub_set_init(&pubs, 1);
  h160_set_insert(&planted, h);

  MatchList ml;
  grind_batch(ctx, &empty, &pubs, priv, 1, 1, &ml);
  if (ml.len != 0) {
    fprintf(stderr, "selftest: empty set should not match\n");
    return 1;
  }
  ml_free(&ml);
  grind_batch(ctx, &planted, &pubs, priv, 1, 1, &ml);
  if (ml.len != 1 || ml.items[0].kind != KIND_H160_COMP) {
    fprintf(stderr, "selftest: planted hash160 should match compressed\n");
    return 1;
  }
  ml_free(&ml);

  /* RANGE mode: plant key 42, walk [1, 100) via tweak_add, expect index 41 */
  uint8_t plant42[32];
  int_to_priv(42, plant42);
  secp256k1_pubkey pub42;
  if (!secp256k1_ec_pubkey_create(ctx, &pub42, plant42)) {
    fprintf(stderr, "selftest: plant42 create failed\n");
    return 1;
  }
  uint8_t comp42[33];
  size_t c42 = 33;
  secp256k1_ec_pubkey_serialize(ctx, comp42, &c42, &pub42, SECP256K1_EC_COMPRESSED);
  uint8_t h42[20];
  hash160(comp42, 33, h42);
  H160Set range_set;
  h160_set_init(&range_set, 1);
  h160_set_insert(&range_set, h42);

  uint8_t start[32];
  int_to_priv(1, start);
  grind_range(ctx, &range_set, &pubs, start, 100, 2, &ml);
  if (ml.len != 1 || ml.items[0].index != 41) {
    fprintf(stderr, "selftest: range should match index 41 (key 42), got len=%zu index=%u\n",
            ml.len, ml.len ? ml.items[0].index : 0);
    return 1;
  }
  if (memcmp(ml.items[0].priv, plant42, 32) != 0) {
    fprintf(stderr, "selftest: range match priv mismatch\n");
    return 1;
  }
  ml_free(&ml);
  h160_set_free(&range_set);

  h160_set_free(&empty);
  h160_set_free(&planted);
  pub_set_free(&pubs);
  secp256k1_context_destroy(ctx);
  printf("satoshi-grind selftest: ok\n");
  return 0;
}

static int default_threads(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if (n < 1) n = 1;
  if (n > 1) n -= 1;
  return (int)n;
}

int main(int argc, char **argv) {
  int threads = default_threads();
  bool bench = false;
  bool bench_range = false;
  bool selftest = false;
  uint32_t bench_keys = 200000;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
      threads = atoi(argv[++i]);
      if (threads < 1) threads = 1;
    } else if (strcmp(argv[i], "--bench") == 0) {
      bench = true;
      if (i + 1 < argc && argv[i + 1][0] != '-') bench_keys = (uint32_t)atoi(argv[++i]);
    } else if (strcmp(argv[i], "--bench-range") == 0) {
      bench_range = true;
      if (i + 1 < argc && argv[i + 1][0] != '-') bench_keys = (uint32_t)atoi(argv[++i]);
    } else if (strcmp(argv[i], "--selftest") == 0) {
      selftest = true;
    } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      fprintf(stderr,
              "Usage: %s [--threads N] | --bench [keys] | --bench-range [keys] | --selftest\n"
              "Protocol mode (default): binary frames on stdin/stdout.\n",
              argv[0]);
      return 0;
    } else {
      die("unknown arg: %s", argv[i]);
    }
  }

  if (selftest) return run_selftest();
  if (bench_range) return run_bench(bench_keys, threads, true);
  if (bench) return run_bench(bench_keys, threads, false);
  return protocol_loop(threads);
}
