import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.VAULT_KEY_HEX = 'a'.repeat(64);
process.env.DATA_DIR = '/tmp/ss-rescue-test-' + Math.floor(Math.random()*1e9);
const { audit, verifyAudit } = await import('../src/lib/server/rescue/audit.ts');
const { encryptKey, decryptKey, isVaultConfigured } = await import('../src/lib/server/rescue/vault.ts');
const { openDb } = await import('../src/lib/server/db.ts');

test('vault round-trips a key and is configured', () => {
  assert.ok(isVaultConfigured());
  const k = '0000000000000000000000000000000000000000000000000000000000000539';
  const blob = encryptKey(k);
  assert.notEqual(blob, k);
  assert.equal(decryptKey(blob), k);
});

test('audit chain appends and verifies', () => {
  audit('test-a', { x: 1 });
  audit('test-b', { y: 2 });
  const v = verifyAudit();
  assert.ok(v.ok, v.reason ?? '');
  assert.ok(v.count >= 2);
});

test('audit chain detects tampering', () => {
  audit('test-c', { z: 3 });
  const db = openDb();
  db.prepare(`UPDATE audit SET payload_json='{"z":999}' WHERE event='test-c'`).run();
  const v = verifyAudit();
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /altered/);
});
