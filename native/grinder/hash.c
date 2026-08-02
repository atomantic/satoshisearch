/*
 * Compact SHA-256 and RIPEMD-160 (public-domain style).
 * Enough for Bitcoin hash160; not a general-purpose crypto suite.
 */
#include "hash.h"
#include <string.h>

/* ---------- SHA-256 ---------- */

static uint32_t rotr32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void sha256_transform(uint32_t state[8], const uint8_t block[64]) {
  static const uint32_t K[64] = {
      0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
      0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
      0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
      0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
      0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
      0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
      0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
      0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
      0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
      0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
      0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};
  uint32_t w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
           ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
  }
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    uint32_t ch = (e & f) ^ ((~e) & g);
    uint32_t t1 = h + S1 + ch + K[i] + w[i];
    uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

void sha256(const uint8_t *data, size_t len, uint8_t out[32]) {
  uint32_t state[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                       0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  uint8_t block[64];
  size_t i = 0;
  while (i + 64 <= len) {
    sha256_transform(state, data + i);
    i += 64;
  }
  size_t rem = len - i;
  memcpy(block, data + i, rem);
  block[rem++] = 0x80;
  if (rem > 56) {
    memset(block + rem, 0, 64 - rem);
    sha256_transform(state, block);
    rem = 0;
  }
  memset(block + rem, 0, 56 - rem);
  uint64_t bits = (uint64_t)len * 8;
  for (int j = 0; j < 8; j++) block[63 - j] = (uint8_t)(bits >> (j * 8));
  sha256_transform(state, block);
  for (int j = 0; j < 8; j++) {
    out[j * 4] = (uint8_t)(state[j] >> 24);
    out[j * 4 + 1] = (uint8_t)(state[j] >> 16);
    out[j * 4 + 2] = (uint8_t)(state[j] >> 8);
    out[j * 4 + 3] = (uint8_t)state[j];
  }
}

/* ---------- RIPEMD-160 ---------- */

static uint32_t rotl32(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }

#define F1(x, y, z) ((x) ^ (y) ^ (z))
#define F2(x, y, z) (((x) & (y)) | ((~x) & (z)))
#define F3(x, y, z) (((x) | (~(y))) ^ (z))
#define F4(x, y, z) (((x) & (z)) | ((y) & (~(z))))
#define F5(x, y, z) ((x) ^ ((y) | (~(z))))

#define R(a, b, c, d, e, f, x, s) \
  do { \
    (a) += (f) + (x); \
    (a) = rotl32((a), (s)) + (e); \
    (c) = rotl32((c), 10); \
  } while (0)

static void ripemd160_transform(uint32_t state[5], const uint8_t block[64]) {
  static const int r1[80] = {0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14, 15,
                             7,  4,  13, 1,  10, 6,  15, 3,  12, 0,  9,  5,  2,  14, 11, 8,
                             3,  10, 14, 4,  9,  15, 8,  1,  2,  7,  0,  6,  13, 11, 5,  12,
                             1,  9,  11, 10, 0,  8,  12, 4,  13, 3,  7,  15, 14, 5,  6,  2,
                             4,  0,  5,  9,  7,  12, 2,  10, 14, 1,  3,  8,  11, 6,  15, 13};
  static const int r2[80] = {5,  14, 7,  0,  9,  2,  11, 4,  13, 6,  15, 8,  1,  10, 3,  12,
                             6,  11, 3,  7,  0,  13, 5,  10, 14, 15, 8,  12, 4,  9,  1,  2,
                             15, 5,  1,  3,  7,  14, 6,  9,  11, 8,  12, 2,  10, 0,  4,  13,
                             8,  6,  4,  1,  3,  11, 15, 0,  5,  12, 2,  13, 9,  7,  10, 14,
                             12, 15, 10, 4,  1,  5,  8,  7,  6,  2,  13, 14, 0,  3,  9,  11};
  static const int s1[80] = {11, 14, 15, 12, 5,  8,  7,  9,  11, 13, 14, 15, 6,  7,  9,  8,
                             7,  6,  8,  13, 11, 9,  7,  15, 7,  12, 15, 9,  11, 7,  13, 12,
                             11, 13, 6,  7,  14, 9,  13, 15, 14, 8,  13, 6,  5,  12, 7,  5,
                             11, 12, 14, 15, 14, 15, 9,  8,  9,  14, 5,  6,  8,  6,  5,  12,
                             9,  15, 5,  11, 6,  8,  13, 12, 5,  12, 13, 14, 11, 8,  5,  6};
  static const int s2[80] = {8,  9,  9,  11, 13, 15, 15, 5,  7,  7,  8,  11, 14, 14, 12, 6,
                             9,  13, 15, 7,  12, 8,  9,  11, 7,  7,  12, 7,  6,  15, 13, 11,
                             9,  7,  15, 11, 8,  6,  6,  14, 12, 13, 5,  14, 13, 13, 7,  5,
                             15, 5,  8,  11, 14, 14, 6,  14, 6,  9,  12, 9,  12, 5,  15, 8,
                             8,  5,  12, 9,  12, 5,  14, 6,  8,  13, 6,  5,  15, 13, 11, 11};
  static const uint32_t K1[5] = {0x00000000u, 0x5a827999u, 0x6ed9eba1u, 0x8f1bbcdcu, 0xa953fd4eu};
  static const uint32_t K2[5] = {0x50a28be6u, 0x5c4dd124u, 0x6d703ef3u, 0x7a6d76e9u, 0x00000000u};

  uint32_t X[16];
  for (int i = 0; i < 16; i++) {
    X[i] = ((uint32_t)block[i * 4]) | ((uint32_t)block[i * 4 + 1] << 8) |
           ((uint32_t)block[i * 4 + 2] << 16) | ((uint32_t)block[i * 4 + 3] << 24);
  }

  uint32_t al = state[0], bl = state[1], cl = state[2], dl = state[3], el = state[4];
  uint32_t ar = state[0], br = state[1], cr = state[2], dr = state[3], er = state[4];

  for (int j = 0; j < 80; j++) {
    uint32_t fl, fr;
    int round = j / 16;
    switch (round) {
      case 0:
        fl = F1(bl, cl, dl);
        fr = F5(br, cr, dr);
        break;
      case 1:
        fl = F2(bl, cl, dl);
        fr = F4(br, cr, dr);
        break;
      case 2:
        fl = F3(bl, cl, dl);
        fr = F3(br, cr, dr);
        break;
      case 3:
        fl = F4(bl, cl, dl);
        fr = F2(br, cr, dr);
        break;
      default:
        fl = F5(bl, cl, dl);
        fr = F1(br, cr, dr);
        break;
    }
    R(al, bl, cl, dl, el, fl + K1[round], X[r1[j]], s1[j]);
    uint32_t t = al;
    al = el;
    el = dl;
    dl = cl;
    cl = bl;
    bl = t;

    R(ar, br, cr, dr, er, fr + K2[round], X[r2[j]], s2[j]);
    t = ar;
    ar = er;
    er = dr;
    dr = cr;
    cr = br;
    br = t;
  }

  uint32_t t = state[1] + cl + dr;
  state[1] = state[2] + dl + er;
  state[2] = state[3] + el + ar;
  state[3] = state[4] + al + br;
  state[4] = state[0] + bl + cr;
  state[0] = t;
}

void ripemd160(const uint8_t *data, size_t len, uint8_t out[20]) {
  uint32_t state[5] = {0x67452301u, 0xefcdab89u, 0x98badcfeu, 0x10325476u, 0xc3d2e1f0u};
  uint8_t block[64];
  size_t i = 0;
  while (i + 64 <= len) {
    ripemd160_transform(state, data + i);
    i += 64;
  }
  size_t rem = len - i;
  memcpy(block, data + i, rem);
  block[rem++] = 0x80;
  if (rem > 56) {
    memset(block + rem, 0, 64 - rem);
    ripemd160_transform(state, block);
    rem = 0;
  }
  memset(block + rem, 0, 56 - rem);
  uint64_t bits = (uint64_t)len * 8;
  for (int j = 0; j < 8; j++) block[56 + j] = (uint8_t)(bits >> (j * 8));
  ripemd160_transform(state, block);
  for (int j = 0; j < 5; j++) {
    out[j * 4] = (uint8_t)state[j];
    out[j * 4 + 1] = (uint8_t)(state[j] >> 8);
    out[j * 4 + 2] = (uint8_t)(state[j] >> 16);
    out[j * 4 + 3] = (uint8_t)(state[j] >> 24);
  }
}
