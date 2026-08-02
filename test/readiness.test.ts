import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRescueReadiness, formatReadiness } from '../src/lib/server/rescue/readiness.ts';

test('assessRescueReadiness returns structured gates', () => {
  const r = assessRescueReadiness({ primaryBucket: 'coldcard' });
  assert.equal(typeof r.canGrind, 'boolean');
  assert.equal(typeof r.canLiveSweep, 'boolean');
  assert.equal(typeof r.canDryRunSweep, 'boolean');
  assert.ok(Array.isArray(r.checks));
  assert.ok(r.checks.length >= 5);
  assert.ok(r.checks.every((c) => ['ok', 'warn', 'fail'].includes(c.level)));
  assert.ok(r.checks.some((c) => c.id === 'vault'));
  assert.ok(r.checks.some((c) => c.id === 'match-set'));
  assert.ok(r.checks.some((c) => c.id === 'bucket'));
  // Live sweep must imply dry-run path is also ready (stricter).
  if (r.canLiveSweep) assert.equal(r.canDryRunSweep, true);
  const text = formatReadiness(r);
  assert.match(text, /Rescue readiness/);
  assert.match(text, /coldcard/);
});
