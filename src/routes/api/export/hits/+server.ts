import type { RequestHandler } from './$types';
import { openDb } from '../../../../lib/server/db.js';
import { addressLink, txLink } from '../../../../lib/server/links.js';

export const GET: RequestHandler = async ({ url }) => {
  const format = (url.searchParams.get('format') ?? 'json').toLowerCase();
  const status = url.searchParams.get('status') ?? '';
  const bucket = url.searchParams.get('bucket') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim();

  const db = openDb();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status && status !== 'all') {
    conditions.push('h.status = ?');
    params.push(status);
  }

  if (bucket && bucket !== 'all') {
    conditions.push('h.bucket = ?');
    params.push(bucket);
  }

  if (q) {
    conditions.push('(h.address LIKE ? OR h.source_name LIKE ? OR c.sweep_txid LIKE ?)');
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT h.id, h.bucket, h.source_name, h.found_at, h.address, h.balance_at_find bal, h.status,
           c.sweep_txid txid, c.dest_address dest, c.created_at claimed_at
    FROM hit h LEFT JOIN claim c ON c.hit_id = h.id
    ${whereClause}
    ORDER BY h.found_at DESC
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    bucket: string;
    source_name: string;
    found_at: number;
    address: string | null;
    bal: number;
    status: string;
    txid: string | null;
    dest: string | null;
    claimed_at: number | null;
  }>;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'csv') {
    const csvLines = [
      ['ID', 'Found At', 'Date UTC', 'Bucket', 'Source', 'Address', 'Balance (Sats)', 'Balance (BTC)', 'Status', 'Sweep TxID', 'Destination'].map(
        (field) => `"${field.replace(/"/g, '""')}"`
      ).join(',')
    ];

    for (const r of rows) {
      const btc = (r.bal / 1e8).toFixed(8);
      const isoDate = new Date(r.found_at * 1000).toISOString();
      const line = [
        r.id,
        r.found_at,
        isoDate,
        r.bucket ?? '',
        r.source_name ?? '',
        r.address ?? '',
        r.bal,
        btc,
        r.status ?? '',
        r.txid ?? '',
        r.dest ?? ''
      ]
        .map((field) => `"${String(field).replace(/"/g, '""')}"`)
        .join(',');
      csvLines.push(line);
    }

    return new Response(csvLines.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rescue-hits-${timestamp}.csv"`
      }
    });
  }

  // JSON export
  const exportData = {
    exportedAt: new Date().toISOString(),
    count: rows.length,
    filters: { status: status || 'all', bucket: bucket || 'all', query: q || null },
    hits: rows.map((r) => ({
      id: r.id,
      bucket: r.bucket,
      source: r.source_name,
      foundAt: r.found_at,
      foundAtIso: new Date(r.found_at * 1000).toISOString(),
      address: r.address,
      balanceSats: r.bal,
      balanceBtc: (r.bal / 1e8).toFixed(8),
      status: r.status,
      sweepTxid: r.txid,
      destAddress: r.dest,
      links: {
        address: r.address ? addressLink(r.address) : null,
        tx: r.txid ? txLink(r.txid) : null
      }
    }))
  };

  return new Response(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="rescue-hits-${timestamp}.json"`
    }
  });
};
