#!/usr/bin/env node
// PreToolUse hook for the LinkedIn MCP server (mcp__linkedin__*).
//
// He allowed the signed-in LinkedIn MCP on 2026-10-23 on two conditions:
// read-only, and slow enough to look like a person job hunting. The server has
// no read-only mode, so this hook is the guard:
//   - tools that write to LinkedIn or sweep it in bulk are refused outright;
//   - every page-loading call is logged (no daily cap since 2026-10-26);
//   - calls are spaced 20-30 s apart (the hook waits before allowing one).
// Log: data/jarvis/linkedin-mcp-usage.jsonl (one line per allowed call).

import { readFileSync, appendFileSync, existsSync, mkdirSync, openSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOG = join(ROOT, 'data', 'jarvis', 'linkedin-mcp-usage.jsonl');

// Never allowed: sending, connecting, bulk employee lists, feed/sidebar crawling.
export const REFUSED = {
  send_message: 'Sending is his: he presses Send in his own browser (OUTREACH.md §2a).',
  connect_with_person: 'Connecting is his, never automated (OUTREACH.md §2a).',
  get_company_employees: 'Bulk employee lists page through many results at once; use search_people with a title and location instead.',
  get_sidebar_profiles: 'Crawling "people also viewed" is not needed for outreach.',
  get_feed: 'His home feed is not needed for outreach.',
};

// Calls that load no LinkedIn page.
const FREE = new Set(['close_session']);

// THE READ-ONLY LIST (F-951). Refusing a few known write tools let anything new
// through: the server is fetched by uvx, and an upgrade that adds
// send_invitation or comment_on_post would have been allowed. Only these run;
// any other tool is refused until it is read and added here.
export const READ_ONLY = new Set([
  'get_person_profile', 'search_people', 'search_posts', 'get_company_profile', 'get_company_posts',
  'search_companies', 'get_job_details', 'search_jobs', 'get_saved_jobs', 'get_my_profile',
  'get_inbox', 'get_conversation', 'search_conversations', 'close_session',
]);
// The longest one call may wait for its turn. Past it the hook would outlive
// its own timeout, and a timed-out hook lets the call through unspaced.
export const MAX_WAIT_MS = 240_000;

// No daily cap since 2026-10-26 (his call: "remove message cap im not scared").
// It was 40 page loads a day (10 people searches, 30 profiles). The spacing
// below stays: it is what keeps the session looking like a person. A cap can
// come back here as { total, <tool>: n }.
export const CAPS = {};
export const MIN_GAP_MS = 20_000;
export const JITTER_MS = 10_000;

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * history: [{ at: ms, tool }] of allowed calls. Returns
 * { allow: false, reason } or { allow: true, waitMs }.
 */
export function decide(history, tool, now, rand = Math.random) {
  if (REFUSED[tool]) return { allow: false, reason: `Refused: ${tool}. ${REFUSED[tool]}` };
  if (!READ_ONLY.has(tool)) return { allow: false, reason: `Refused: ${tool} is not on the LinkedIn guard's read-only list (jarvis/linkedin-mcp-guard.mjs READ_ONLY). Read what it does before adding it.` };
  if (FREE.has(tool)) return { allow: true, waitMs: 0, free: true };

  const today = history.filter((h) => localDay(h.at) === localDay(now));
  if (CAPS.total && today.length >= CAPS.total) {
    return { allow: false, reason: `LinkedIn MCP daily cap reached (${CAPS.total} page loads today). Do not stop: carry on with the usual pipeline (WebSearch discovery, profile-posts.mjs, post-leads.mjs, a few searches in his Opera), per the /outreach skill.` };
  }
  const cap = CAPS[tool];
  if (cap && today.filter((h) => h.tool === tool).length >= cap) {
    return { allow: false, reason: `LinkedIn MCP daily cap for ${tool} reached (${cap} today). Use the other LinkedIn MCP tools, or carry on with the usual pipeline per the /outreach skill.` };
  }
  // `at` may be in the future: a call that took its turn and is still waiting.
  const last = history.length ? Math.max(...history.map((h) => h.at)) : 0;
  const gap = MIN_GAP_MS + Math.floor(rand() * JITTER_MS);
  const waitMs = Math.max(0, last + gap - now);
  if (waitMs > MAX_WAIT_MS) return { allow: false, reason: `Too many LinkedIn calls queued at once (this one would wait ${Math.round(waitMs / 1000)} s). Send LinkedIn calls one at a time, not in parallel.` };
  return { allow: true, waitMs };
}

/**
 * Take a turn under a lock (F-951): read the log, decide, and write this call's
 * planned time BEFORE waiting. Parallel calls each read the log before any had
 * written, computed the same short wait, and hit LinkedIn within a second.
 */
export async function reserve(tool, input = {}, { file = LOG, now = () => Date.now(), rand = Math.random, lockMs = 15_000 } = {}) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const start = now();
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock left by a crashed hook is broken after `lockMs`.
      try { if (now() - statSync(lock).mtimeMs > lockMs) { unlinkSync(lock); continue; } } catch { continue; }
      if (now() - start > lockMs * 2) throw new Error('the LinkedIn guard lock is stuck');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const t = now();
    const verdict = decide(readHistory(file), tool, t, rand);
    if (verdict.allow && !verdict.free) {
      appendFileSync(file, JSON.stringify({ at: new Date(t + verdict.waitMs).toISOString(), tool, args: summarise(input) }) + '\n');
    }
    return verdict;
  } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

export function readHistory(file = LOG) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { const o = JSON.parse(l); return [{ at: Date.parse(o.at), tool: o.tool }]; } catch { return []; }
  });
}

function summarise(input = {}) {
  const keep = ['keywords', 'query', 'company', 'location', 'linkedin_username', 'username', 'url', 'thread_id', 'date_posted'];
  const out = {};
  for (const k of keep) if (input[k] != null) out[k] = String(input[k]).slice(0, 120);
  return out;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const evt = JSON.parse(raw || '{}');
  const tool = String(evt.tool_name || '').replace(/^mcp__linkedin__/, '');

  const verdict = await reserve(tool, evt.tool_input);
  if (!verdict.allow) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason },
    }));
    return;
  }
  // The turn is already written down; this only waits for it.
  if (verdict.waitMs > 0) await new Promise((r) => setTimeout(r, verdict.waitMs));
  // No output: the normal permission flow continues.
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    // A guard that crashes must fail closed.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `LinkedIn guard error: ${e.message}` },
    }));
  });
}
