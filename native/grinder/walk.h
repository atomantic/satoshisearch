/*
 * Sequential curve walk: P, P+G, P+2G, ... with batched affine conversion.
 *
 * The public libsecp256k1 API has no cheap "advance by one" primitive —
 * secp256k1_ec_pubkey_tweak_add() runs a full generic secp256k1_ecmult() plus
 * a modular inversion per call, which made the walk ~200x more expensive than
 * the single point addition it should be. This wraps the library's internal
 * field/group ops instead: one gej_add_ge_var per key, and a single
 * fe_inv_var amortized across a whole block (Montgomery's trick).
 *
 * Opaque so callers never see secp256k1 internal types; walk.c is the only
 * translation unit that includes the vendored headers.
 */
#ifndef SATOSHI_GRIND_WALK_H
#define SATOSHI_GRIND_WALK_H

#include <secp256k1.h>

#include <stdbool.h>
#include <stdint.h>

/* Points converted to affine per inversion. The buffers cost ~216 bytes per
 * point (heap, inside walk_ctx), so a block is ~216 KiB. Measured best of
 * 64/256/1024/4096 on both 1 and 17 threads. */
#define WALK_BLOCK 1024

typedef struct walk_ctx walk_ctx;

/**
 * Allocate a walk. Returns NULL on OOM. `ctx` is only used to seed the walk
 * (walk_start) and is borrowed, not owned — it must outlive the walk. All the
 * uses are const operations, so callers can share one context across threads.
 */
walk_ctx *walk_create(const secp256k1_context *ctx);
void walk_destroy(walk_ctx *w);

/**
 * Point the walk at `priv` (32-byte big-endian scalar). Must be called before
 * walk_next(). Returns false if `priv` is not a valid secret key, leaving the
 * walk unusable until a later successful walk_start().
 */
bool walk_start(walk_ctx *w, const uint8_t priv[32]);

/**
 * Serialize the next `n` points (n <= WALK_BLOCK) and advance past them.
 *
 * `comp` receives n*33 bytes, `uncomp` n*65. Pass NULL for `uncomp` to skip
 * uncompressed serialization. Returns the number of points written, which is
 * less than n only if the walk hits the point at infinity — in practice
 * unreachable, since it needs the walk to land exactly on the group order.
 */
uint32_t walk_next(walk_ctx *w, uint32_t n, uint8_t *comp, uint8_t *uncomp);

#endif
