/**
 * The guard that should have existed before `--help` opened four applications.
 *
 * F-162: `node jarvis/apply.mjs --help` fell through an argument parser that
 * only ever looked FOR the flags it knew, took its default limit, launched a
 * browser and started opening live postings. Asking the script what it does made
 * it do it — and a survey afterwards found that NOT ONE command in this project
 * handled `--help`. Every one of them ran instead, including the ones that write
 * to the job store or VACUUM it.
 *
 * The rule this file enforces is the same in both directions:
 *
 *   - `--help` / `-h` prints and exits. Always. Before anything happens.
 *   - An unrecognised flag STOPS the run. A typo is not an instruction, and the
 *     default for "I did not understand that" must never be "proceed anyway".
 *
 * It is deliberately tiny and dependency-free so that adding it to a script is
 * two lines and carries no risk of changing what that script does.
 */

/**
 * @param {object} o
 * @param {string} o.usage      what to print for --help
 * @param {string[]} o.flags    every flag this script accepts, e.g. ['--limit']
 * @param {string[]} o.valued   the subset that take a following VALUE
 * @param {string[]} [o.argv]   defaults to process.argv.slice(2)
 * @param {(code:number)=>void} [o.exit]  injectable, so tests need no subprocess
 * @param {{log:Function,error:Function}} [o.out]
 * @returns {string[]} the arguments, once they are known to be safe
 */
export function guardArgs({ usage, flags, valued = [], argv = process.argv.slice(2), exit = process.exit, out = console }) {
  const known = new Set([...flags, '--help', '-h']);
  const takesValue = new Set(valued);

  if (argv.includes('--help') || argv.includes('-h')) {
    out.log(usage);
    exit(0);
    return argv;
  }

  const unknown = argv.filter((tok, i) => {
    if (!tok.startsWith('-')) return false;
    if (known.has(tok)) return false;
    // The VALUE of a valued flag is a value even when it looks like a flag:
    // `--company --weird-name` is a company called "--weird-name".
    const prev = argv[i - 1];
    if (prev && takesValue.has(prev)) return false;
    return true;
  });

  if (unknown.length) {
    out.error(`\n  Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    out.error('  Nothing was run. Use --help to see what this takes.\n');
    exit(2);
  }
  return argv;
}
