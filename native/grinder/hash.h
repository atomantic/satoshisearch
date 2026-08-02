/* SHA-256 + RIPEMD-160 for Bitcoin hash160. Public-domain style compact impls. */
#ifndef SATOSHI_GRIND_HASH_H
#define SATOSHI_GRIND_HASH_H

#include <stddef.h>
#include <stdint.h>

void sha256(const uint8_t *data, size_t len, uint8_t out[32]);
void ripemd160(const uint8_t *data, size_t len, uint8_t out[20]);

/** Bitcoin HASH160 = RIPEMD160(SHA256(data)). */
static inline void hash160(const uint8_t *data, size_t len, uint8_t out[20]) {
  uint8_t mid[32];
  sha256(data, len, mid);
  ripemd160(mid, 32, out);
}

#endif
