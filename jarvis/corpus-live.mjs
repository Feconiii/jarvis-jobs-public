#!/usr/bin/env node
// jarvis/corpus-live.mjs — run the WRITER on the questions he has already
// judged, and score what comes back.
//
// `corpus-score.mjs` validates the metric against his labelled pairs. This is
// the other half and the one he actually asked for: put the live writer in
// front of the same questions, score its answers on the same scale, and say
// where it lands between the version he kept and the version he threw away.
//
// It costs model calls — the judgement ladder (Opus, then Sonnet), which is
// what `essay.mjs` uses for these questions anyway. Run it deliberately:
//
//   node jarvis/corpus-live.mjs --n 3          # three questions
//   node jarvis/corpus-live.mjs --all
//   node jarvis/corpus-live.mjs --n 3 --json
import { loadCorpus } from './apply/corpus.mjs';
import { scoreAnswer } from './corpus-score.mjs';
import { writeAnswer } from './apply/essay.mjs';

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const N = process.argv.includes('--all') ? 99 : Number(arg('--n', 3));
const JSON_OUT = process.argv.includes('--json');

const corpus = loadCorpus().filter((e) => e.accepted && e.rejected);
const picked = corpus.slice(0, N);

const rows = [];
for (const e of picked) {
  const job = { company: e.company || 'the company', title: 'Engineer', description: '' };
  let text = '', meta = null, err = '';
  const started = Date.now();
  try {
    const out = await writeAnswer(e.fullQuestion || e.question, {
      job,
      field: { label: e.question, type: 'textarea', multiline: true },
      holdOut: e.n,
    });
    text = String(out?.text || '');
    meta = out?.meta || null;
  } catch (ex) { err = String(ex?.message || ex).split('\n')[0]; }
  const secs = Math.round((Date.now() - started) / 100) / 10;

  const a = scoreAnswer(e.accepted, { kind: e.kind });
  const r = scoreAnswer(e.rejected, { kind: e.kind });
  const live = text ? scoreAnswer(text, { kind: e.kind }) : null;
  rows.push({ n: e.n, company: e.company, kind: e.kind, secs, err, model: meta?.model || '', accepted: a, rejected: r, live, text });

  if (!JSON_OUT) {
    console.log(`\n#${e.n} ${e.company} — ${e.kind}  (${secs}s${meta?.model ? `, ${meta.model}` : ''})`);
    if (err) { console.log(`  FAILED: ${err}`); continue; }
    console.log(`  score   he kept ${a.score}   LIVE ${live.score}   he rejected ${r.score}`);
    console.log(`  words   ${a.words} / ${live.words} / ${r.words}`
      + `   inventory ${a.inventory}/${live.inventory}/${r.inventory}`
      + `   jd-voice ${a.jdVoice}/${live.jdVoice}/${r.jdVoice}`
      + `   selling ${a.selling}/${live.selling}/${r.selling}`);
    console.log(`  ${live.score <= a.score ? '✓ at or better than the one he kept'
      : live.score < r.score ? '~ between the two' : '✗ no better than the one he rejected'}`);
  }
}

if (JSON_OUT) { console.log(JSON.stringify(rows, null, 2)); } else {
  const ok = rows.filter((x) => x.live);
  if (ok.length) {
    const m = (f) => (ok.reduce((n, x) => n + f(x), 0) / ok.length).toFixed(2);
    console.log(`\n── ${ok.length} answered ──`);
    console.log(`  mean score   he kept ${m((x) => x.accepted.score)}   LIVE ${m((x) => x.live.score)}   he rejected ${m((x) => x.rejected.score)}`);
    console.log(`  at or better than the version he kept: ${ok.filter((x) => x.live.score <= x.accepted.score).length}/${ok.length}`);
    console.log(`  better than the version he rejected:   ${ok.filter((x) => x.live.score < x.rejected.score).length}/${ok.length}\n`);
  }
  const failed = rows.filter((x) => x.err);
  if (failed.length) console.log(`  ${failed.length} did not answer: ${failed.map((f) => `#${f.n} ${f.err}`).join('; ')}\n`);
}
