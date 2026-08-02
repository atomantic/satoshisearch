/**
 * Best-effort hit notifications for realtime rescue ops.
 *
 * Channels (all optional, fire-and-forget, never throw into the grind loop):
 *   RESCUE_WEBHOOK_URL  — POST JSON payload
 *   RESCUE_NOTIFY_FILE  — append one JSON line per event
 *   RESCUE_NOTIFY_CMD   — shell out with $RESCUE_NOTIFY_JSON env (advanced)
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { audit } from './audit';

export interface HitNotifyPayload {
  event: 'hit-found' | 'sweep-decision' | 'rescue-runner';
  ts: number;
  source?: string;
  bucket?: string;
  origin?: string;
  address?: string | null;
  balanceSats?: number | null;
  matchKind?: string;
  status?: string;
  action?: string;
  reason?: string;
  txid?: string | null;
  message?: string;
}

export async function notifyRescue(payload: HitNotifyPayload): Promise<void> {
  const body = { ...payload, ts: payload.ts || Math.floor(Date.now() / 1000) };
  const json = JSON.stringify(body);

  const file = process.env.RESCUE_NOTIFY_FILE?.trim();
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, json + '\n', 'utf8');
    } catch (e) {
      audit('notify-error', { channel: 'file', error: String(e) });
    }
  }

  const url = process.env.RESCUE_WEBHOOK_URL?.trim();
  if (url) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json,
        signal: AbortSignal.timeout(8_000)
      });
      if (!res.ok) {
        audit('notify-error', { channel: 'webhook', status: res.status, url: url.slice(0, 80) });
      }
    } catch (e) {
      audit('notify-error', { channel: 'webhook', error: String(e) });
    }
  }

  const cmd = process.env.RESCUE_NOTIFY_CMD?.trim();
  if (cmd) {
    try {
      spawn(cmd, {
        shell: true,
        env: { ...process.env, RESCUE_NOTIFY_JSON: json },
        stdio: 'ignore',
        detached: true
      }).unref();
    } catch (e) {
      audit('notify-error', { channel: 'cmd', error: String(e) });
    }
  }
}
