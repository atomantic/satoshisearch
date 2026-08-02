/*
 * Pollard's kangaroo (lambda) — interval ECDLP on secp256k1.
 *
 * Given P = k·G with k ∈ [lo, hi], recover k in expected ~2·√(hi−lo+1)
 * group operations via tame/wild herds and distinguished points.
 */
#ifndef SATOSHI_KANGAROO_H
#define SATOSHI_KANGAROO_H

#include <secp256k1.h>
#include <stdbool.h>
#include <stdint.h>

typedef struct {
  uint8_t pubkey[65]; /* compressed (33) or uncompressed (65) */
  size_t pubkey_len;
  uint8_t lo[32]; /* inclusive, big-endian scalar */
  uint8_t hi[32]; /* inclusive, big-endian scalar */
  int threads;
  int dp_bits;      /* trailing zero bits of x for DP; 0 = auto */
  uint64_t max_ops; /* 0 = unlimited */
  /** Optional progress callback (ops, dps, elapsed_ms). May be NULL. */
  void (*on_progress)(uint64_t ops, uint64_t dps, uint64_t elapsed_ms, void *user);
  void *progress_user;
  /** Poll for cooperative cancel; return true to stop. May be NULL. */
  bool (*should_stop)(void *user);
  void *stop_user;
} KangarooJob;

typedef struct {
  bool found;
  bool cancelled;
  bool exhausted; /* hit max_ops without a hit */
  uint8_t priv[32];
  uint64_t ops;
  uint64_t dps;
  uint64_t elapsed_ms;
  char err[256];
} KangarooResult;

/** Run kangaroo. Returns false only on hard setup failure (err filled). */
bool kangaroo_solve(const secp256k1_context *ctx, const KangarooJob *job, KangarooResult *out);

/** Built-in self-tests (known small keys). Returns 0 on success. */
int kangaroo_selftest(void);

#endif
