import type { RequestHandler } from './$types';
import { openDb } from '../../../../lib/server/db.js';
import { verifyAudit } from '../../../../lib/server/rescue/audit.js';

export const GET: RequestHandler = async ({ url }) => {
  const format = (url.searchParams.get('format') ?? 'json').toLowerCase();
  const eventFilter = url.searchParams.get('event') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim();

  const db = openDb();
  const verification = verifyAudit();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (eventFilter && eventFilter !== 'all') {
    conditions.push('event = ?');
    params.push(eventFilter);
  }

  if (q) {
    conditions.push('(event LIKE ? OR payload_json LIKE ? OR hash LIKE ?)');
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT seq, ts, event, payload_json, prev_hash, hash
    FROM audit
    ${whereClause}
    ORDER BY seq ASC
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    seq: number;
    ts: number;
    event: string;
    payload_json: string;
    prev_hash: string;
    hash: string;
  }>;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'csv') {
    const csvLines = [
      ['Seq', 'Timestamp', 'Date UTC', 'Event', 'Prev Hash', 'Hash', 'Payload JSON'].map(
        (field) => `"${field.replace(/"/g, '""')}"`
      ).join(',')
    ];

    for (const r of rows) {
      const isoDate = new Date(r.ts * 1000).toISOString();
      const line = [
        r.seq,
        r.ts,
        isoDate,
        r.event ?? '',
        r.prev_hash ?? '',
        r.hash ?? '',
        r.payload_json ?? ''
      ]
        .map((field) => `"${String(field).replace(/"/g, '""')}"`)
        .join(',');
      csvLines.push(line);
    }

    return new Response(csvLines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rescue-audit-${timestamp}.csv"`
      }
    });
  }

  // JSON export
  const exportData = {
    exportedAt: new Date().toISOString(),
    count: rows.length,
    verification,
    entries: rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      dateIso: new Date(r.ts * 1000).toISOString(),
      event: r.event,
      payload: JSON.parse(r.payload_json),
      prevHash: r.prev_hash,
      hash: r.hash
    }))
  };

  return new Response(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="rescue-audit-${timestamp}.json"`
    }
  });
};
