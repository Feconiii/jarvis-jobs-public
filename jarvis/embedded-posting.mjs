// jarvis/embedded-posting.mjs — the posting a careers page carries in its own
// page data, for sites that publish no schema.org JobPosting.
//
// enrich.mjs reads a posting page's JSON-LD, which most careers sites emit for
// search engines. Apple and Google do not. Both were added on 2026-09-20 through
// their public sitemaps, which give a URL and a title slug and nothing else —
// 8,061 rows with no description, no location and an approximate title. The
// first enrichment pass over them failed every row: "page had no JobPosting
// data". The data is there; it is just not in that format.
//
//   Apple   window.__staticRouterHydrationData = JSON.parse("…")  — a named
//           record: postingTitle, jobSummary, description, minimumQualifications,
//           preferredQualifications, locations[], teamNames[], postDateInGMT.
//   Google  AF_initDataCallback({key: 'ds:0', … data: [[ … ]]})   — a POSITIONAL
//           array: [0] id, [1] title, [3] responsibilities, [4] qualifications,
//           [7] organisation, [9] locations, [10] about the job.
//
// Each returns a schema.org-shaped object so enrich.mjs treats it exactly like
// JSON-LD. A positional format can move under us without notice, so Google's is
// checked for shape before anything is believed, and a record that does not
// look right returns null. A missing description is reported by the caller as a
// failure; it is never filled in.

const asAddress = (city, region, country) => ({
  '@type': 'Place',
  address: { '@type': 'PostalAddress', addressLocality: city || '', addressRegion: region || '', addressCountry: country || '' },
});

const section = (heading, html) => (html && String(html).trim() && !/^n\/?a$/i.test(String(html).trim())
  ? `<h3>${heading}</h3>${/<\w+/.test(html) ? html : `<p>${html}</p>`}` : '');

/** Depth-limited search for the first object carrying `key`. */
function findWith(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return null;
  if (!Array.isArray(node) && key in node) return node;
  for (const v of Object.values(node)) {
    const hit = findWith(v, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function applePosting(html) {
  const m = String(html || '').match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\)/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(JSON.parse(`"${m[1]}"`)); } catch { return null; }
  const job = findWith(data, 'postingTitle');
  if (!job || typeof job.postingTitle !== 'string') return null;
  const description = [
    section('Summary', job.jobSummary),
    section('Description', job.description),
    section('Minimum Qualifications', job.minimumQualifications),
    section('Preferred Qualifications', job.preferredQualifications),
  ].join('');
  if (!description) return null;
  const locs = Array.isArray(job.locations) ? job.locations : [];
  return {
    '@type': 'JobPosting',
    title: job.postingTitle.trim(),
    description,
    datePosted: typeof job.postDateInGMT === 'string' ? job.postDateInGMT : undefined,
    occupationalCategory: Array.isArray(job.teamNames) && job.teamNames[0] ? String(job.teamNames[0]) : undefined,
    jobLocation: locs.map(l => asAddress(l.city || l.name, l.stateProvince, l.countryName)),
  };
}

const htmlAt = (row, i) => (Array.isArray(row[i]) && typeof row[i][1] === 'string' ? row[i][1] : '');

export function googlePosting(html) {
  const src = String(html || '');
  const re = /AF_initDataCallback\(\{key: '[^']+', hash: '[^']*', data:([\s\S]*?), sideChannel: \{\}\}\);/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const row = Array.isArray(data) ? data[0] : null;
    // The detail record, not the "similar jobs" list beside it: a digit-string
    // id, a string title, and at least one of the three HTML bodies.
    if (!Array.isArray(row) || !/^\d{6,}$/.test(String(row[0])) || typeof row[1] !== 'string') continue;
    const description = [
      section('About the job', htmlAt(row, 10)),
      section('Responsibilities', htmlAt(row, 3)),
      htmlAt(row, 4),                       // carries its own "Minimum qualifications" headings
    ].join('');
    if (!description) continue;
    const locs = Array.isArray(row[9]) ? row[9].filter(l => Array.isArray(l)) : [];
    return {
      '@type': 'JobPosting',
      title: row[1].trim(),
      description,
      occupationalCategory: typeof row[7] === 'string' && row[7] ? row[7] : undefined,
      jobLocation: locs.map(l => asAddress(l[2], l[4], l[5])),
    };
  }
  return null;
}

/** Whichever site-specific reader recognises the page, or null. */
export function embeddedPosting(html) {
  return applePosting(html) || googlePosting(html);
}
