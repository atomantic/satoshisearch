import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VAULT_KEY_HEX = 'b'.repeat(64);
process.env.DATA_DIR = '/tmp/ss-rescue-export-test-' + Math.floor(Math.random() * 1e9);

const { openDb } = await import('../src/lib/server/db.ts');
const { audit } = await import('../src/lib/server/rescue/audit.ts');

test('hits and audit export endpoints return expected formats and filter data', async () => {
  const db = openDb();

  // Populate test hits
  db.prepare(`
    INSERT INTO hit (id, target_id, source_name, bucket, found_at, address, privkey_enc, balance_at_find, status)
    VALUES 
    (101, NULL, 'coldcard', 'coldcard', 1700000000, 'bc1qtest1111111111111111111111111111111111', 'enc1', 5000000, 'held'),
    (102, NULL, 'puzzle-71', 'puzzle', 1700001000, '1PuzzleAddress111111111111111111111', 'enc2', 100000000, 'swept')
  `).run();

  db.prepare(`
    INSERT INTO claim (id, hit_id, original_address, balance, sweep_txid, dest_address, created_at)
    VALUES (1, 102, '1PuzzleAddress111111111111111111111', 100000000, 'txid_puzzle_sweep_12345', 'bc1qdest2222222222222222222222222222222222', 1700001010)
  `).run();

  // Add audit records
  audit('hit_recorded', { hit_id: 101, bucket: 'coldcard', address: 'bc1qtest1111111111111111111111111111111111' });
  audit('sweep_broadcast', { hit_id: 102, txid: 'txid_puzzle_sweep_12345' });

  // Import the GET handlers from the API endpoints
  const { GET: getHits } = await import('../src/routes/api/export/hits/+server.ts');
  const { GET: getAudit } = await import('../src/routes/api/export/audit/+server.ts');

  // Test 1: JSON Hits export (all)
  const reqHitsJson = new Request('http://localhost/api/export/hits?format=json');
  const resHitsJson = await getHits({ url: new URL(reqHitsJson.url) } as any);
  assert.equal(resHitsJson.status, 200);
  assert.match(resHitsJson.headers.get('Content-Type') ?? '', /application\/json/);
  assert.match(resHitsJson.headers.get('Content-Disposition') ?? '', /attachment; filename="rescue-hits-.*\.json"/);

  const jsonHitsData = await resHitsJson.json();
  assert.equal(jsonHitsData.count, 2);
  assert.equal(jsonHitsData.hits[0].id, 102); // Order by found_at DESC
  assert.equal(jsonHitsData.hits[0].status, 'swept');
  assert.equal(jsonHitsData.hits[0].sweepTxid, 'txid_puzzle_sweep_12345');
  assert.equal(jsonHitsData.hits[1].id, 101);

  // Test 2: CSV Hits export with filtering by status='swept'
  const reqHitsCsv = new Request('http://localhost/api/export/hits?format=csv&status=swept');
  const resHitsCsv = await getHits({ url: new URL(reqHitsCsv.url) } as any);
  assert.equal(resHitsCsv.status, 200);
  assert.match(resHitsCsv.headers.get('Content-Type') ?? '', /text\/csv/);

  const csvHitsText = await resHitsCsv.text();
  assert.match(csvHitsText, /"ID","Found At","Date UTC"/);
  assert.match(csvHitsText, /"102"/);
  assert.match(csvHitsText, /"txid_puzzle_sweep_12345"/);
  assert.doesNotMatch(csvHitsText, /"101"/); // Filtered out

  // Test 3: Search filtering by address
  const reqHitsSearch = new Request('http://localhost/api/export/hits?format=json&q=bc1qtest');
  const resHitsSearch = await getHits({ url: new URL(reqHitsSearch.url) } as any);
  const jsonHitsSearchData = await resHitsSearch.json();
  assert.equal(jsonHitsSearchData.count, 1);
  assert.equal(jsonHitsSearchData.hits[0].id, 101);

  // Test 4: JSON Audit export
  const reqAuditJson = new Request('http://localhost/api/export/audit?format=json');
  const resAuditJson = await getAudit({ url: new URL(reqAuditJson.url) } as any);
  assert.equal(resAuditJson.status, 200);
  const jsonAuditData = await resAuditJson.json();
  assert.equal(jsonAuditData.verification.ok, true);
  assert.ok(jsonAuditData.entries.length >= 2);
  assert.equal(jsonAuditData.entries[0].event, 'hit_recorded');

  // Test 5: CSV Audit export
  const reqAuditCsv = new Request('http://localhost/api/export/audit?format=csv');
  const resAuditCsv = await getAudit({ url: new URL(reqAuditCsv.url) } as any);
  assert.equal(resAuditCsv.status, 200);
  const csvAuditText = await resAuditCsv.text();
  assert.match(csvAuditText, /"Seq","Timestamp","Date UTC","Event","Prev Hash","Hash","Payload JSON"/);
  assert.match(csvAuditText, /"hit_recorded"/);
  assert.match(csvAuditText, /"sweep_broadcast"/);
});
