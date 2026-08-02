/* Open-addressing sets for hash160 (20 B) and raw pubkeys (33/65 B). */
#ifndef SATOSHI_GRIND_SET_H
#define SATOSHI_GRIND_SET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * One open-addressing table shared by both set flavours. Keys are fixed-stride
 * slots; `tags[i]` is the key length stored in slot i (0 = empty), which
 * doubles as the occupancy flag and lets variable-length pubkeys share the
 * 65-byte stride.
 */
typedef struct {
  uint8_t *keys;  /* cap * stride, unused tail bytes zeroed */
  uint8_t *tags;  /* cap bytes: 0 empty, else key length in that slot */
  size_t cap;
  size_t len;
  size_t stride;
} ByteSet;

/* Distinct wrapper types so the two flavours can't be mixed up at call sites. */
typedef struct {
  ByteSet set;
} H160Set;

typedef struct {
  ByteSet set;
} PubSet;

bool h160_set_init(H160Set *s, size_t expected);
void h160_set_free(H160Set *s);
bool h160_set_insert(H160Set *s, const uint8_t key[20]);
bool h160_set_has(const H160Set *s, const uint8_t key[20]);

bool pub_set_init(PubSet *s, size_t expected);
void pub_set_free(PubSet *s);
bool pub_set_insert(PubSet *s, const uint8_t *key, size_t len);
bool pub_set_has(const PubSet *s, const uint8_t *key, size_t len);

#endif
