#include "walk.h"

/*
 * The only translation unit that reaches into libsecp256k1's internals. The
 * vendored headers declare everything `static`, so including the *_impl.h
 * files gives this TU its own private copy of the field/group code — nothing
 * collides with the symbols already in libsecp256k1.a at link time.
 */
#define SECP256K1_BUILD
#include <secp256k1.h>

#include "assumptions.h"
#include "util.h"

#include "int128_impl.h" /* before field_impl.h: modinv64 uses it */
#include "field_impl.h"
#include "group_impl.h"

#include <stdlib.h>
#include <string.h>

struct walk_ctx {
  const secp256k1_context *ctx; /* borrowed; only used to seed the walk */
  secp256k1_gej cur;            /* next point to emit */
  bool ready;
  secp256k1_gej jbuf[WALK_BLOCK];
  secp256k1_ge abuf[WALK_BLOCK];
};

walk_ctx *walk_create(const secp256k1_context *ctx) {
  if (!ctx) return NULL;
  walk_ctx *w = calloc(1, sizeof(*w));
  if (!w) return NULL;
  w->ctx = ctx;
  w->ready = false;
  return w;
}

void walk_destroy(walk_ctx *w) {
  free(w);
}

bool walk_start(walk_ctx *w, const uint8_t priv[32]) {
  w->ready = false;

  /* Seed via the public API (one ecmult_gen), then re-parse the serialized
   * point into a group element — secp256k1_pubkey_load is not reachable from
   * outside the library, and this happens once per work unit, not per key. */
  secp256k1_pubkey pub;
  if (!secp256k1_ec_seckey_verify(w->ctx, priv)) return false;
  if (!secp256k1_ec_pubkey_create(w->ctx, &pub, priv)) return false;

  uint8_t ser[65];
  size_t len = sizeof(ser);
  if (!secp256k1_ec_pubkey_serialize(w->ctx, ser, &len, &pub, SECP256K1_EC_UNCOMPRESSED)) return false;
  if (len != 65) return false;

  secp256k1_fe x, y;
  if (!secp256k1_fe_set_b32_limit(&x, ser + 1)) return false;
  if (!secp256k1_fe_set_b32_limit(&y, ser + 33)) return false;

  secp256k1_ge ge;
  secp256k1_ge_set_xy(&ge, &x, &y);
  secp256k1_gej_set_ge(&w->cur, &ge);

  w->ready = true;
  return true;
}

/*
 * Affine point -> SEC1. `uncomp` may be NULL. Normalizes `p` in place —
 * ge_set_all_gej_var leaves coordinates unnormalized (magnitude 1), and the
 * caller's abuf is walk-owned scratch that is dead after serialization.
 */
static void ser_point(secp256k1_ge *p, uint8_t comp[33], uint8_t *uncomp) {
  secp256k1_fe_normalize_var(&p->x);
  secp256k1_fe_normalize_var(&p->y);

  comp[0] = secp256k1_fe_is_odd(&p->y) ? SECP256K1_TAG_PUBKEY_ODD : SECP256K1_TAG_PUBKEY_EVEN;
  secp256k1_fe_get_b32(comp + 1, &p->x);

  if (uncomp) {
    uncomp[0] = SECP256K1_TAG_PUBKEY_UNCOMPRESSED;
    memcpy(uncomp + 1, comp + 1, 32);
    secp256k1_fe_get_b32(uncomp + 33, &p->y);
  }
}

uint32_t walk_next(walk_ctx *w, uint32_t n, uint8_t *comp, uint8_t *uncomp) {
  if (!w->ready || n == 0) return 0;
  if (n > WALK_BLOCK) n = WALK_BLOCK;

  /* One point addition per key, all in Jacobian — no inversion in this loop. */
  w->jbuf[0] = w->cur;
  for (uint32_t i = 1; i < n; i++) {
    secp256k1_gej_add_ge_var(&w->jbuf[i], &w->jbuf[i - 1], &secp256k1_ge_const_g, NULL);
  }

  /* Montgomery's trick: a single fe_inv_var for the whole block. */
  secp256k1_ge_set_all_gej_var(w->abuf, w->jbuf, n);

  uint32_t out = 0;
  for (; out < n; out++) {
    if (secp256k1_ge_is_infinity(&w->abuf[out])) {
      /* Only reachable if the walk lands exactly on the group order. Stop
       * short and force the caller to re-seed rather than emit a bogus key. */
      w->ready = false;
      return out;
    }
    ser_point(&w->abuf[out], comp + (size_t)out * 33, uncomp ? uncomp + (size_t)out * 65 : NULL);
  }

  secp256k1_gej_add_ge_var(&w->cur, &w->jbuf[n - 1], &secp256k1_ge_const_g, NULL);
  return out;
}
