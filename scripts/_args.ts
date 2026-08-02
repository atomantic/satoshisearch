/**
 * Tiny shared CLI argument parser for the `scripts/` entry points.
 *
 * Deliberately minimal: every script here takes `--flag value` pairs, boolean
 * flags, and at most one positional path. Callers pass `process.argv.slice(2)`.
 *
 *   const argv = process.argv.slice(2);
 *   const out = arg(argv, '--out');
 *   const doImport = has(argv, '--import');
 *   const [path] = positionals(argv, ['--out', '--min-sats']);
 */

/** Value of `--name <value>`, or undefined when the flag is absent. */
export function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** True when the boolean flag `--name` is present. */
export function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * Non-flag arguments, skipping both value-taking flags and the token that
 * follows them. `valueFlags` lists the flags that consume a value, so a
 * positional after a boolean flag (`--replace datasets/x.tsv.gz`) survives.
 */
export function positionals(argv: string[], valueFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('-')) {
      if (valueFlags.includes(tok)) i++; // consume this flag's value
      continue;
    }
    out.push(tok);
  }
  return out;
}
