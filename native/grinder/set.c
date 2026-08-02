#include "set.h"
#include <stdlib.h>
#include <string.h>

#define H160_STRIDE 20
#define PUB_STRIDE 65

static size_t next_pow2(size_t n) {
  size_t c = 16;
  while (c < n) c <<= 1;
  return c;
}

static uint64_t fnv1a(const uint8_t *p, size_t n) {
  uint64_t h = 14695981039346656037ULL;
  for (size_t i = 0; i < n; i++) {
    h ^= p[i];
    h *= 1099511628211ULL;
  }
  return h;
}

static bool bs_init(ByteSet *s, size_t expected, size_t stride) {
  memset(s, 0, sizeof(*s));
  s->stride = stride;
  s->cap = next_pow2(expected * 2 + 16);
  s->keys = calloc(s->cap, stride);
  s->tags = calloc(s->cap, 1);
  return s->keys && s->tags;
}

static void bs_free(ByteSet *s) {
  free(s->keys);
  free(s->tags);
  memset(s, 0, sizeof(*s));
}

static bool bs_insert(ByteSet *s, const uint8_t *key, size_t len);

static bool bs_rehash(ByteSet *s, size_t new_cap) {
  uint8_t *ok = s->keys;
  uint8_t *ot = s->tags;
  size_t oc = s->cap;
  size_t stride = s->stride;
  s->keys = calloc(new_cap, stride);
  s->tags = calloc(new_cap, 1);
  if (!s->keys || !s->tags) return false;
  s->cap = new_cap;
  s->len = 0;
  for (size_t i = 0; i < oc; i++) {
    if (ot[i]) {
      if (!bs_insert(s, ok + i * stride, ot[i])) return false;
    }
  }
  free(ok);
  free(ot);
  return true;
}

static bool bs_insert(ByteSet *s, const uint8_t *key, size_t len) {
  if (s->len * 10 >= s->cap * 7) {
    if (!bs_rehash(s, s->cap * 2)) return false;
  }
  uint64_t h = fnv1a(key, len);
  size_t i = (size_t)(h & (s->cap - 1));
  for (;;) {
    if (!s->tags[i]) {
      s->tags[i] = (uint8_t)len;
      memcpy(s->keys + i * s->stride, key, len);
      s->len++;
      return true;
    }
    if (s->tags[i] == len && memcmp(s->keys + i * s->stride, key, len) == 0) return true;
    i = (i + 1) & (s->cap - 1);
  }
}

static bool bs_has(const ByteSet *s, const uint8_t *key, size_t len) {
  if (!s->cap) return false;
  uint64_t h = fnv1a(key, len);
  size_t i = (size_t)(h & (s->cap - 1));
  for (;;) {
    if (!s->tags[i]) return false;
    if (s->tags[i] == len && memcmp(s->keys + i * s->stride, key, len) == 0) return true;
    i = (i + 1) & (s->cap - 1);
  }
}

bool h160_set_init(H160Set *s, size_t expected) {
  return bs_init(&s->set, expected, H160_STRIDE);
}

void h160_set_free(H160Set *s) {
  bs_free(&s->set);
}

bool h160_set_insert(H160Set *s, const uint8_t key[20]) {
  return bs_insert(&s->set, key, H160_STRIDE);
}

bool h160_set_has(const H160Set *s, const uint8_t key[20]) {
  return bs_has(&s->set, key, H160_STRIDE);
}

bool pub_set_init(PubSet *s, size_t expected) {
  return bs_init(&s->set, expected, PUB_STRIDE);
}

void pub_set_free(PubSet *s) {
  bs_free(&s->set);
}

bool pub_set_insert(PubSet *s, const uint8_t *key, size_t len) {
  if (len != 33 && len != 65) return false;
  return bs_insert(&s->set, key, len);
}

bool pub_set_has(const PubSet *s, const uint8_t *key, size_t len) {
  if (len != 33 && len != 65) return false;
  return bs_has(&s->set, key, len);
}
