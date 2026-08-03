/**
 * Pre-flight checklist for a realtime rescue operation.
 *
 * Separates "can we grind?" from "can we auto-sweep on a hit?" so operators
 * can dry-run grind with a full match-set while keeping broadcast off until
 * the legal/ethical gates are deliberate.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isVaultConfigured } from './vault';
import { verifyAudit } from './audit';
import { effectiveRescue, effectiveRuntime, effectiveMatchSet } from '../settings';
import { loadMatchSet, latestRichlistSnapshot } from '../grinder/loadset';
import { nativeGrindAvailable } from '../grinder/native';
import type { Bucket } from '../config';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface ReadinessCheck {
  id: string;
  level: CheckLevel;
  label: string;
  detail: string;
}

export interface RescueReadiness {
  /** True if grinding + recording hits is safe (vault optional but warned). */
  canGrind: boolean;
  /** True if a hit in `primaryBucket` could auto-broadcast (policy + dest + !dryRun). */
  canLiveSweep: boolean;
  /** True if dry-run sign path would run for that bucket. */
  canDryRunSweep: boolean;
  checks: ReadinessCheck[];
  matchSetSize: number;
  matchProfile: string;
  matchLabel: string;
  richlistAgeHours: number | null;
  nativeGrind: boolean;
  primaryBucket: Bucket | string;
}

export interface ReadinessOptions {
  /** Bucket you intend to race (default coldcard). */
  primaryBucket?: Bucket | string;
  /** Soft max age for richlist snapshot before WARN (hours). */
  maxRichlistAgeHours?: number;
}

export function assessRescueReadiness(opts: ReadinessOptions = {}): RescueReadiness {
  const primaryBucket = opts.primaryBucket ?? 'coldcard';
  const maxAge = opts.maxRichlistAgeHours ?? 36;
  const checks: ReadinessCheck[] = [];

  const rescue = effectiveRescue();
  const runtime = effectiveRuntime();
  const matchCfg = effectiveMatchSet();
  const vault = isVaultConfigured();
  const audit = verifyAudit();
  const set = loadMatchSet(matchCfg.filter);
  const snap = latestRichlistSnapshot();
  const native = nativeGrindAvailable();

  // --- vault ---
  checks.push(
    vault
      ? {
          id: 'vault',
          level: 'ok',
          label: 'Vault key',
          detail: 'VAULT_KEY_HEX / settings vault configured — hits encrypt at rest'
        }
      : {
          id: 'vault',
          level: 'warn',
          label: 'Vault key',
          detail: 'Unset — hits are audited but private keys are NOT stored. Set in Settings before a real race.'
        }
  );

  // --- destination ---
  checks.push(
    rescue.destAddress
      ? {
          id: 'dest',
          level: 'ok',
          label: 'Rescue destination',
          detail: `Configured (${rescue.destAddress.slice(0, 8)}…)`
        }
      : {
          id: 'dest',
          level: 'fail',
          label: 'Rescue destination',
          detail: 'Empty — auto-sweep will always hold. Generate/set address in Settings.'
        }
  );

  // --- dry-run ---
  checks.push(
    rescue.dryRun
      ? {
          id: 'dry-run',
          level: 'warn',
          label: 'Broadcast mode',
          detail: 'DRY-RUN on — will sign but never broadcast. Flip off only for a live race.'
        }
      : {
          id: 'dry-run',
          level: 'ok',
          label: 'Broadcast mode',
          detail: 'LIVE — signed rescue txs will be broadcast'
        }
  );

  // --- bucket policy ---
  const bucketEnabled = rescue.autoBuckets.has(primaryBucket);
  const whitehatOk = primaryBucket === 'puzzle' || rescue.whitehatAttested;
  if (!bucketEnabled) {
    checks.push({
      id: 'bucket',
      level: 'warn',
      label: `Auto-sweep bucket "${primaryBucket}"`,
      detail: `Not in SWEEP_AUTO_BUCKETS (${[...rescue.autoBuckets].join(', ') || 'none'}). Hits will be held.`
    });
  } else if (!whitehatOk) {
    checks.push({
      id: 'bucket',
      level: 'warn',
      label: `Auto-sweep bucket "${primaryBucket}"`,
      detail: 'Bucket listed but white-hat attestation missing — non-puzzle sweeps held.'
    });
  } else {
    checks.push({
      id: 'bucket',
      level: 'ok',
      label: `Auto-sweep bucket "${primaryBucket}"`,
      detail: 'Enabled and attested (or puzzle)'
    });
  }

  // --- match-set ---
  if (set.size === 0) {
    checks.push({
      id: 'match-set',
      level: 'fail',
      label: 'Match-set',
      detail: `Empty for profile "${matchCfg.profile}" (${matchCfg.label}). Index targets or broaden the match profile in Settings.`
    });
  } else {
    checks.push({
      id: 'match-set',
      level: 'ok',
      label: 'Match-set',
      detail: `${set.size.toLocaleString()} targets · ${matchCfg.label} (${set.hash160s.size} hash160 · ${set.pubkeys.size} pubkeys)`
    });
  }

  // --- richlist freshness ---
  // Only warn about staleness when the active match profile actually includes richlist.
  const matchIncludesRichlist = matchCfg.filter.datasets.includes('richlist');
  let richlistAgeHours: number | null = null;
  if (!matchIncludesRichlist) {
    checks.push({
      id: 'richlist-age',
      level: 'ok',
      label: 'Richlist snapshot',
      detail: `Not in match profile (${matchCfg.label}) — snapshot age not required for this grind`
    });
  } else if (!snap) {
    checks.push({
      id: 'richlist-age',
      level: 'warn',
      label: 'Richlist snapshot',
      detail: 'No snapshot metadata — match-set may be stale or empty of richlist rows'
    });
  } else {
    richlistAgeHours = (Date.now() / 1000 - snap.created_at) / 3600;
    checks.push(
      richlistAgeHours > maxAge
        ? {
            id: 'richlist-age',
            level: 'warn',
            label: 'Richlist snapshot',
            detail: `Age ${richlistAgeHours.toFixed(1)}h (source ${snap.source}) — refresh before a race (threshold ${maxAge}h)`
          }
        : {
            id: 'richlist-age',
            level: 'ok',
            label: 'Richlist snapshot',
            detail: `Age ${richlistAgeHours.toFixed(1)}h · ${snap.row_count ?? '?'} rows · ${snap.source}`
          }
    );
  }

  // --- node ---
  checks.push({
    id: 'mempool',
    level: runtime.mempoolApiUrl ? 'ok' : 'fail',
    label: 'Mempool / Esplora API',
    detail: runtime.mempoolApiUrl || 'Unset — live balance + broadcast need a node'
  });

  // --- audit ---
  checks.push(
    audit.ok
      ? {
          id: 'audit',
          level: 'ok',
          label: 'Audit chain',
          detail: `Intact (${audit.count} records)`
        }
      : {
          id: 'audit',
          level: 'fail',
          label: 'Audit chain',
          detail: `BROKEN at seq ${audit.brokenAtSeq} — investigate before a live race`
        }
  );

  // --- grind backend ---
  const grindBin = native
    ? 'native satoshi-grind present (RANGE/BATCH); coldcard expand still uses JS workers'
    : 'JS-only grind — run npm run grind:build for faster sequential sources';
  checks.push({
    id: 'grind-backend',
    level: native ? 'ok' : 'warn',
    label: 'Grind backend',
    detail: grindBin
  });

  // --- notify ---
  const webhook = process.env.RESCUE_WEBHOOK_URL?.trim();
  const notifyFile = process.env.RESCUE_NOTIFY_FILE?.trim();
  if (webhook || notifyFile) {
    checks.push({
      id: 'notify',
      level: 'ok',
      label: 'Hit notifications',
      detail: [webhook && 'webhook', notifyFile && `file:${notifyFile}`].filter(Boolean).join(' · ')
    });
  } else {
    checks.push({
      id: 'notify',
      level: 'warn',
      label: 'Hit notifications',
      detail: 'No RESCUE_WEBHOOK_URL / RESCUE_NOTIFY_FILE — hits only appear in UI/audit'
    });
  }

  // --- runner lock path writable ---
  const dataDir = process.env.DATA_DIR || './data';
  checks.push(
    existsSync(dataDir)
      ? {
          id: 'data-dir',
          level: 'ok',
          label: 'DATA_DIR',
          detail: join(dataDir)
        }
      : {
          id: 'data-dir',
          level: 'warn',
          label: 'DATA_DIR',
          detail: `${dataDir} missing — will be created on first write`
        }
  );

  const canGrind = !checks.some((c) => c.id === 'match-set' && c.level === 'fail') && audit.ok;
  const canDryRunSweep =
    !!rescue.destAddress && bucketEnabled && whitehatOk && set.size > 0 && audit.ok;
  const canLiveSweep = canDryRunSweep && !rescue.dryRun && vault;

  return {
    canGrind,
    canLiveSweep,
    canDryRunSweep,
    checks,
    matchSetSize: set.size,
    matchProfile: matchCfg.profile,
    matchLabel: matchCfg.label,
    richlistAgeHours,
    nativeGrind: native,
    primaryBucket
  };
}

/** Pretty-print for CLI. */
export function formatReadiness(r: RescueReadiness): string {
  const lines: string[] = [];
  lines.push(`Rescue readiness (primary bucket: ${r.primaryBucket})`);
  lines.push(
    `  grind=${r.canGrind ? 'OK' : 'NO'}  dry-run-sweep=${r.canDryRunSweep ? 'OK' : 'NO'}  live-sweep=${r.canLiveSweep ? 'OK' : 'NO'}`
  );
  lines.push(
    `  match-set=${r.matchSetSize.toLocaleString()} (${r.matchProfile}: ${r.matchLabel})  native=${r.nativeGrind}`
  );
  for (const c of r.checks) {
    const tag = c.level === 'ok' ? 'OK  ' : c.level === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`  [${tag}] ${c.label}: ${c.detail}`);
  }
  return lines.join('\n');
}
