#!/usr/bin/env node
// jarvis/setup-check.mjs — what is set up, what is missing, what still holds
// the example's values. The assistant runs this first on a new clone (see
// AGENTS.md and .claude/skills/jarvis-setup/SKILL.md) and asks only about what is left.
//
// Usage: node jarvis/setup-check.mjs [--json]
// Built-ins only, so it runs before `npm install`.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const at = (p) => path.join(ROOT, p);
const read = (p) => { try { return fs.readFileSync(at(p), 'utf8'); } catch { return null; } };

/** Values that only the shipped examples carry. Still present = not yet made yours. */
const EXAMPLE_MARKS = /Alex Rivera|alex@example\.com|yourportfolio\.example|your-handle|Example Manufacturing Co\.|Example Robotics|examplesemi|Jane Smith|jane@example\.com/;

function check() {
  const items = [];
  const add = (key, ok, what, fix) => items.push({ key, ok, what, fix });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 24, `Node.js ${process.versions.node}`, 'install Node.js 24 or newer');
  add('deps', fs.existsSync(at('node_modules/js-yaml')), 'npm packages', 'npm install');
  // The writers run on whichever assistant setup recorded (targeting.llm).
  const llm = /^\s*llm:\s*["']?codex/m.test(read('config/profile.yml') || '') ? 'codex' : 'claude';
  let cli = false;
  try { execSync(process.platform === 'win32' ? `where ${llm}` : `command -v ${llm}`, { stdio: 'ignore' }); cli = true; } catch { /* not on PATH */ }
  add('assistant', cli, llm === 'codex' ? 'Codex CLI (`codex`) for the writers and daily curation' : 'Claude Code CLI (`claude`) for the writers and daily curation',
    llm === 'codex' ? 'install the Codex CLI, then `codex login` once' : 'install Claude Code and sign in once');

  const file = (key, p, what, fix, { minBytes = 1, check = null } = {}) => {
    const t = read(p);
    if (t == null || t.length < minBytes) return add(key, false, `${p} — ${what}`, fix);
    if (EXAMPLE_MARKS.test(t)) return add(key, false, `${p} — still holds the example's values`, `replace them with yours (${what})`);
    const extra = check ? check(t) : null;
    return add(key, !extra, `${p} — ${what}${extra ? ` (${extra})` : ''}`, extra ? fix : '');
  };

  file('cv', 'cv.md', 'your CV, the source of truth for everything written', 'convert their resume faithfully (AGENTS.md, first-run step 3)', { minBytes: 400 });
  file('apply-profile', 'data/jarvis/apply-profile.yml', 'what forms are filled with', 'npm run jarvis:setup writes it; fill the rest with the user (examples/apply-profile.example.yml shows every key)', {
    check: (t) => (/^\s*email:\s*"?\s*"?\s*$/m.test(t) ? 'email is empty' : null),
  });
  file('portals', 'portals.yml', 'the companies you track', 'npm run jarvis:setup -- --find-boards, then npm run jarvis:discover -- --names "A,B" --write', {
    check: (t) => ((t.match(/^\s*-\s*name:/gm) || []).length < 5 ? 'fewer than 5 companies tracked' : null),
  });
  file('preferences', 'jarvis/preferences.md', 'your plain-English rules', 'npm run jarvis:setup writes starter rules; go through them with the user');
  file('profile', 'config/profile.yml', 'who you are, your field, target roles and pay floor', 'npm run jarvis:setup (or the assistant-led setup in AGENTS.md)', {
    // A profile from before the plan and goals questions: re-run the interview's new parts with --update.
    check: (t) => (!/^\s*plan:/m.test(t) ? 'no AI plan recorded' : !/^goals:/m.test(t) ? 'no job goals recorded' : null),
  });
  file('resume-pool', 'jarvis/resume-pool.json', 'the resume bullet pool (verbatim from cv.md)', 'build it from cv.md by following jarvis/RESUME-POOL.md');

  const db = fs.existsSync(at('data/jarvis/jobs.db'));
  add('store', db, 'a job store with at least one scan', 'npm run jarvis:scan');
  return items;
}

// --hook: Claude Code's SessionStart hook (.claude/settings.json). What it
// prints goes into the assistant's context at the start of every session, so
// a folder with no profile starts the interview without anyone asking.
if (process.argv.includes('--hook')) {
  if (!fs.existsSync(at('config/profile.yml'))) {
    console.log('JARVIS FIRST RUN: config/profile.yml does not exist, so the person in this session has not been set up. '
      + 'Before anything else, greet them, say in two sentences what Jarvis Jobs does, and start the setup interview: '
      + 'follow .claude/skills/jarvis-setup/SKILL.md (the /jarvis-setup skill) from its first section. Ask one topic at a time.');
  } else {
    const left = check().filter((i) => !i.ok);
    if (left.length) console.log(`Jarvis setup check: ${left.length} thing(s) left: ${left.map((i) => i.what).join('; ')}. Offer to finish them (/jarvis-setup picks up where it stopped).`);
  }
  process.exit(0);
}

const items = check();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ready: items.every((i) => i.ok), items }, null, 2));
} else {
  for (const i of items) console.log(`${i.ok ? '✔' : '✖'} ${i.what}${i.ok ? '' : `\n    → ${i.fix}`}`);
  const left = items.filter((i) => !i.ok).length;
  console.log(left ? `\n${left} thing(s) left to set up.` : '\nEverything is set up. npm run jarvis:serve');
}
