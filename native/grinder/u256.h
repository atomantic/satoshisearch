/* Minimal big-endian 256-bit unsigned helpers for kangaroo distances. */
#ifndef SATOSHI_U256_H
#define SATOSHI_U256_H

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  uint8_t b[32];
} u256;

static inline void u256_zero(u256 *x) { memset(x->b, 0, 32); }

static inline void u256_set_u64(u256 *x, uint64_t v) {
  u256_zero(x);
  for (int i = 0; i < 8; i++) x->b[31 - i] = (uint8_t)(v >> (8 * i));
}

static inline void u256_copy(u256 *d, const u256 *s) { memcpy(d->b, s->b, 32); }

static inline int u256_cmp(const u256 *a, const u256 *b) {
  return memcmp(a->b, b->b, 32);
}

/** d = a + b (wrapping mod 2^256). Returns carry out. */
static inline int u256_add(u256 *d, const u256 *a, const u256 *b) {
  unsigned carry = 0;
  for (int i = 31; i >= 0; i--) {
    unsigned s = (unsigned)a->b[i] + (unsigned)b->b[i] + carry;
    d->b[i] = (uint8_t)s;
    carry = s >> 8;
  }
  return (int)carry;
}

/** d = a - b (wrapping). Returns 1 if a < b (borrow). */
static inline int u256_sub(u256 *d, const u256 *a, const u256 *b) {
  int borrow = 0;
  for (int i = 31; i >= 0; i--) {
    int s = (int)a->b[i] - (int)b->b[i] - borrow;
    if (s < 0) {
      s += 256;
      borrow = 1;
    } else {
      borrow = 0;
    }
    d->b[i] = (uint8_t)s;
  }
  return borrow;
}

/** floor(log2(x)); 0 if x==0. */
static inline int u256_bitlen(const u256 *x) {
  for (int i = 0; i < 32; i++) {
    if (x->b[i]) {
      int bit = 8 * (31 - i);
      uint8_t v = x->b[i];
      while (v >>= 1) bit++;
      return bit + 1;
    }
  }
  return 0;
}

#endif
