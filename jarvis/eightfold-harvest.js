/*
 * jarvis/eightfold-harvest.js — read Eightfold posting bodies in HIS browser (F-428).
 *
 * Lam's and Eaton's Eightfold career sites render client-side, and their
 * description API answers a server "Not authorized for PCSX". The same API
 * answers the page's own browser session, so this runs ON the careers site
 * (careers.lamresearch.com, eaton.eightfold.ai, …) and asks it the way the page
 * does: GET /api/apply/v2/jobs/<id>?domain=<domain>, one posting at a time,
 * paced. The bodies then travel the assisted channel CLAUDE.md describes:
 * stashed in window.name, and the tab navigates itself to
 * http://localhost:4300/assist-bridge, which posts them to
 * /api/import-descriptions (triage, visa gate and fit rescore all run).
 * Nothing is created: a body with no posting behind it is reported, not added.
 *
 * Usage, in DevTools on the careers site (or injected by a session):
 *   jarvisEightfoldHarvest({ company: 'Lam Research', urls: [ '<stored url>', … ] })
 * Only URLs on the current host are read; the rest are skipped and counted.
 */
async function jarvisEightfoldHarvest({ company, urls, paceMs = 900, go = true }) {
  const here = location.host;
  const rows = [], skipped = [], failed = [];
  for (const u of urls) {
    let url;
    try { url = new URL(u); } catch { skipped.push(u); continue; }
    if (url.host !== here) { skipped.push(u); continue; }
    const id = (url.pathname.match(/\/job\/(\d+)/) || [])[1];
    const domain = url.searchParams.get('domain') || '';
    if (!id) { skipped.push(u); continue; }
    try {
      const r = await fetch(`/api/apply/v2/jobs/${id}?domain=${encodeURIComponent(domain)}`, { credentials: 'include' });
      if (!r.ok) { failed.push([u, r.status]); }
      else {
        const j = await r.json();
        const description = j.job_description || '';
        if (description.length > 200) rows.push({ url: u, description });
        else failed.push([u, 'empty']);
      }
    } catch (e) { failed.push([u, String(e).slice(0, 60)]); }
    await new Promise((res) => setTimeout(res, paceMs));
  }
  const summary = { company, host: here, read: rows.length, skipped: skipped.length, failed };
  console.log('[jarvis-harvest]', summary);
  if (go && rows.length) {
    window.name = JSON.stringify({ kind: 'jarvis-descriptions', company, rows });
    location.href = 'http://localhost:4300/assist-bridge';
  }
  return summary;
}
