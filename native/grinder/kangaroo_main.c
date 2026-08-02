/*
 * satoshi-kangaroo — CLI for Pollard's kangaroo (interval ECDLP).
 *
 * Usage:
 *   satoshi-kangaroo --selftest
 *   satoshi-kangaroo --pubkey HEX --lo HEX --hi HEX [--threads N] [--dp N] [--max-ops N]
 *
 * Machine-readable events on stdout (JSON lines):
 *   {"event":"progress","ops":…,"dps":…,"opsPerSec":…,"elapsedMs":…}
 *   {"event":"found","priv":"…64 hex…","ops":…,"elapsedMs":…}
 *   {"event":"exhausted","ops":…}
 *   {"event":"cancelled","ops":…}
 *   {"event":"error","message":"…"}
 *
 * Human progress also on stderr.
 */
#include "kangaroo.h"

#include <pthread.h>
#include <secp256k1.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t g_stop = 0;

static void on_sig(int sig) {
  (void)sig;
  g_stop = 1;
}

static bool should_stop(void *user) {
  (void)user;
  return g_stop != 0;
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static bool parse_hex(const char *s, uint8_t *out, size_t out_len) {
  size_t n = strlen(s);
  if (n >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    s += 2;
    n -= 2;
  }
  if (n != out_len * 2) return false;
  for (size_t i = 0; i < out_len; i++) {
    int hi = hex_nibble(s[i * 2]);
    int lo = hex_nibble(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return true;
}

/**
 * Parse hex scalar of any length ≤ 64 nibbles into 32-byte big-endian
 * (left-padded with zeros). Odd-length hex is fine — e.g. 2^139 is 35 digits
 * (`8000…`) as stored by the puzzle indexer; we prepend a 0 nibble.
 */
static bool parse_hex_scalar(const char *s, uint8_t out[32]) {
  memset(out, 0, 32);
  size_t n = strlen(s);
  if (n >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    s += 2;
    n -= 2;
  }
  if (n == 0 || n > 64) return false;

  /* Build a temporary even-length nibble string (pad one leading 0 if odd). */
  char tmp[65];
  size_t off = 0;
  if (n & 1) {
    tmp[0] = '0';
    off = 1;
  }
  memcpy(tmp + off, s, n);
  tmp[off + n] = '\0';
  size_t digits = off + n; /* even, ≤ 64 */
  size_t bytes = digits / 2;
  return parse_hex(tmp, out + (32 - bytes), bytes);
}

static bool parse_pubkey(const char *s, uint8_t out[65], size_t *out_len) {
  size_t n = strlen(s);
  if (n >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    s += 2;
    n -= 2;
  }
  if (n == 66) {
    *out_len = 33;
    return parse_hex(s, out, 33);
  }
  if (n == 130) {
    *out_len = 65;
    return parse_hex(s, out, 65);
  }
  return false;
}

static void hex_print(const uint8_t *b, size_t n, char *out) {
  static const char *H = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[i * 2] = H[b[i] >> 4];
    out[i * 2 + 1] = H[b[i] & 0xf];
  }
  out[n * 2] = 0;
}

typedef struct {
  uint64_t last_ops;
  uint64_t last_ms;
} ProgState;

static void on_progress(uint64_t ops, uint64_t dps, uint64_t elapsed_ms, void *user) {
  ProgState *ps = user;
  double rate = 0;
  if (elapsed_ms > ps->last_ms) {
    rate = (double)(ops - ps->last_ops) * 1000.0 / (double)(elapsed_ms - ps->last_ms);
  } else if (elapsed_ms > 0) {
    rate = (double)ops * 1000.0 / (double)elapsed_ms;
  }
  ps->last_ops = ops;
  ps->last_ms = elapsed_ms;

  printf("{\"event\":\"progress\",\"ops\":%llu,\"dps\":%llu,\"opsPerSec\":%.0f,\"elapsedMs\":%llu}\n",
         (unsigned long long)ops, (unsigned long long)dps, rate, (unsigned long long)elapsed_ms);
  fflush(stdout);
  /* Human line only for an interactive terminal — under the engine it is a
   * duplicate of the JSON above, and its bare \r makes it a poor log line. */
  if (isatty(STDERR_FILENO)) {
    fprintf(stderr, "\r  kangaroo  ops=%llu  dps=%llu  %.0f ops/s  %llums   ",
            (unsigned long long)ops, (unsigned long long)dps, rate,
            (unsigned long long)elapsed_ms);
    fflush(stderr);
  }
}

/*
 * Parent-death guard. The sequential grinder is owned by its stdin pipe (it
 * blocks in read() and exits on EOF), so it can never outlive the Node parent.
 * This binary has no stdin protocol, so opt into the same ownership explicitly:
 * the caller passes --stop-on-stdin-eof and keeps a pipe open. Without the flag
 * (plain CLI use, where stdin may be /dev/null) nothing changes.
 */
static void *stdin_eof_watch(void *arg) {
  (void)arg;
  char buf[64];
  ssize_t r;
  while ((r = read(STDIN_FILENO, buf, sizeof(buf))) > 0) { /* drain and ignore */
  }
  if (r == 0) g_stop = 1; /* parent closed the pipe / died */
  return NULL;
}

static void usage(const char *argv0) {
  fprintf(stderr,
          "Usage:\n"
          "  %s --selftest\n"
          "  %s --pubkey HEX --lo HEX --hi HEX [--threads N] [--dp N] [--max-ops N]\n"
          "     [--stop-on-stdin-eof]   exit when the parent closes stdin\n",
          argv0, argv0);
}

int main(int argc, char **argv) {
  const char *pubkey_s = NULL;
  const char *lo_s = NULL;
  const char *hi_s = NULL;
  int threads = 0;
  int dp = 0;
  uint64_t max_ops = 0;
  bool selftest = false;
  bool stop_on_eof = false;

  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--selftest")) selftest = true;
    else if (!strcmp(argv[i], "--stop-on-stdin-eof")) stop_on_eof = true;
    else if (!strcmp(argv[i], "--pubkey") && i + 1 < argc) pubkey_s = argv[++i];
    else if (!strcmp(argv[i], "--lo") && i + 1 < argc) lo_s = argv[++i];
    else if (!strcmp(argv[i], "--hi") && i + 1 < argc) hi_s = argv[++i];
    else if (!strcmp(argv[i], "--threads") && i + 1 < argc) threads = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--dp") && i + 1 < argc) dp = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--max-ops") && i + 1 < argc) max_ops = strtoull(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
      usage(argv[0]);
      return 0;
    } else {
      fprintf(stderr, "unknown arg: %s\n", argv[i]);
      usage(argv[0]);
      return 2;
    }
  }

  if (selftest) return kangaroo_selftest();

  if (!pubkey_s || !lo_s || !hi_s) {
    usage(argv[0]);
    return 2;
  }

  if (threads <= 0) {
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    threads = n > 1 ? (int)n - 1 : 1;
  }

  KangarooJob job;
  memset(&job, 0, sizeof(job));
  if (!parse_pubkey(pubkey_s, job.pubkey, &job.pubkey_len)) {
    printf("{\"event\":\"error\",\"message\":\"bad --pubkey\"}\n");
    return 2;
  }
  if (!parse_hex_scalar(lo_s, job.lo) || !parse_hex_scalar(hi_s, job.hi)) {
    printf("{\"event\":\"error\",\"message\":\"bad --lo/--hi\"}\n");
    return 2;
  }
  job.threads = threads;
  job.dp_bits = dp;
  job.max_ops = max_ops;

  ProgState ps = {0};
  job.on_progress = on_progress;
  job.progress_user = &ps;
  job.should_stop = should_stop;

  signal(SIGINT, on_sig);
  signal(SIGTERM, on_sig);

  if (stop_on_eof) {
    pthread_t eof_th;
    if (pthread_create(&eof_th, NULL, stdin_eof_watch, NULL) == 0) pthread_detach(eof_th);
  }

  secp256k1_context *ctx = secp256k1_context_create(SECP256K1_CONTEXT_NONE);
  if (!ctx) {
    printf("{\"event\":\"error\",\"message\":\"secp context\"}\n");
    return 1;
  }

  fprintf(stderr, "satoshi-kangaroo  threads=%d  dp=%d  max_ops=%llu\n", threads, dp,
          (unsigned long long)max_ops);

  KangarooResult res;
  if (!kangaroo_solve(ctx, &job, &res)) {
    printf("{\"event\":\"error\",\"message\":\"%s\"}\n", res.err[0] ? res.err : "solve failed");
    secp256k1_context_destroy(ctx);
    return 1;
  }
  secp256k1_context_destroy(ctx);
  fputc('\n', stderr);

  if (res.found) {
    char hex[65];
    hex_print(res.priv, 32, hex);
    printf("{\"event\":\"found\",\"priv\":\"%s\",\"ops\":%llu,\"dps\":%llu,\"elapsedMs\":%llu}\n",
           hex, (unsigned long long)res.ops, (unsigned long long)res.dps,
           (unsigned long long)res.elapsed_ms);
    /* Key goes to the caller on stdout only — never to stderr, which lands in
     * pm2/docker logs and terminal scrollback. */
    fprintf(stderr, "FOUND  (%llu ops, %llums)\n", (unsigned long long)res.ops,
            (unsigned long long)res.elapsed_ms);
    return 0;
  }
  if (res.cancelled) {
    printf("{\"event\":\"cancelled\",\"ops\":%llu,\"elapsedMs\":%llu}\n",
           (unsigned long long)res.ops, (unsigned long long)res.elapsed_ms);
    return 130;
  }
  if (res.exhausted) {
    printf("{\"event\":\"exhausted\",\"ops\":%llu,\"elapsedMs\":%llu}\n",
           (unsigned long long)res.ops, (unsigned long long)res.elapsed_ms);
    return 1;
  }
  printf("{\"event\":\"error\",\"message\":\"stopped without result\"}\n");
  return 1;
}
