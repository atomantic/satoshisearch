# Rescue policy

SatoshiSearch can recover private keys for provably-weak key classes and, under a strict policy,
move the funds to safety before an attacker does. Moving other people's coins — even to protect
them — is legally and ethically fraught. This document states the posture plainly.

## The default is safe

Out of the box:

- **`SWEEP_DRY_RUN=true`** — the app builds and signs a rescue transaction but **never broadcasts**.
- **`SWEEP_AUTO_BUCKETS=puzzle`** — only the puzzle addresses may be auto-swept. Every other class is
  held for a human decision.
- **`RESCUE_DEST_ADDRESS=`** (empty) — with no destination there is nowhere safe to send, so the app
  **holds and alerts** rather than sweeping. This is a fail-safe, not an oversight.
- Recovered keys are **encrypted at rest** (AES-256-GCM). If no `VAULT_KEY_HEX` is set, a hit is
  still recorded in the audit log but the key is **not** persisted in plaintext.

## Buckets and who they might belong to

| Bucket | Whose coins | Default |
|---|---|---|
| `puzzle` | Deliberately placed by the puzzle creator to be found. | **Auto-sweep eligible.** |
| `coinbase` / `dormant` | Early miners, possibly Satoshi. Almost certainly not yours. | Held. |
| `richlist` | Whoever controls a top-balance address. A living person. | Held. |
| `brainwallet` / `constants` / `lowentropy` | Whoever chose a weak key. Usually a real, findable victim. | Held. |
| `coldcard` | Victims of the 2026 ColdCard entropy flaw. | Held. |

Puzzle addresses are the **only** class explicitly designed to be swept. Everything else may hold a
living person's funds.

## Enabling a real rescue operation

Auto-sweeping any **non-puzzle** bucket requires two deliberate steps:

1. Add the bucket to `SWEEP_AUTO_BUCKETS` (e.g. `puzzle,coldcard`).
2. Set `RESCUE_WHITEHAT_ATTESTATION` to the exact attestation string, affirming that you are running
   an authorized search-and-rescue operation and will return funds to their rightful owners.

Without the attestation, non-puzzle buckets are held regardless of the bucket list. This is enforced
in code (`mayAutoSweep`), not just documented.

## Provenance for reimbursement

Every recovered key produces:

- a **hash-chained audit record** (`hit-found`, `sweep-decision`, …) that is tamper-evident — any
  edit or deletion of a past record is detected by the chain verifier; and
- a **claim record** preserving the original address, script, balance at discovery, and the discovery
  method — the evidence a rightful owner needs to prove ownership and be made whole.

The audit record and encrypted key are written **before** any broadcast, so provenance can never be
lost to a crash mid-sweep.

## P2PK is never auto-swept

The Satoshi-era coinbase coins are P2PK. The signing library refuses bare P2PK, and — more to the
point — these coins must never be moved automatically. P2PK hits are always held with the key in the
vault for manual review.

## A note on weak-key models

The definition of a weak-key class (for example the exact ColdCard PRNG state space) is a
dual-use artifact: it helps a rescuer and an attacker equally. Keep such models in local
configuration, not in a public repository.
