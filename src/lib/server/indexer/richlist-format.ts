/**
 * The normalized richlist TSV interchange format.
 *
 * Two producers write it — the loyce bootstrap fetcher and the Core UTXO
 * aggregator — and `parseRichlistLine` reads it. Keeping the header and the
 * row layout here means the three cannot drift apart independently.
 *
 *   address \t script_type \t match_kind \t match_hex \t balance_sats \t script_hex
 */
import { p2pkhScript, p2wpkhScript } from '../script';

export const RICHLIST_TSV_HEADER =
  '# address\tscript_type\tmatch_kind\tmatch_hex\tbalance_sats\tscript_hex\n';

export interface RichlistTsvRow {
  address: string;
  scriptType: string;
  matchKind: 'hash160' | 'pubkey';
  matchHex: string;
  balanceSats: number;
  scriptHex: string;
}

/** Write one data line. */
export function formatRichlistRow(row: RichlistTsvRow): string {
  return `${row.address}\t${row.scriptType}\t${row.matchKind}\t${row.matchHex}\t${row.balanceSats}\t${row.scriptHex}\n`;
}

/** Write one hash160 row, deriving the scriptPubKey from the script type. */
export function formatNormalizedRow(
  address: string,
  scriptType: 'p2pkh' | 'p2wpkh',
  hash160: string,
  balanceSats: number
): string {
  return formatRichlistRow({
    address,
    scriptType,
    matchKind: 'hash160',
    matchHex: hash160,
    balanceSats,
    scriptHex: scriptType === 'p2wpkh' ? p2wpkhScript(hash160) : p2pkhScript(hash160)
  });
}
