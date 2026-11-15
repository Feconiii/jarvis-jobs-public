// Tests for discover-radar.mjs. Fixtures are trimmed from the LinkedIn post
// searches of 2026-10-31 (search_posts text, exactly as the MCP returned it).

import { splitPosts, parseLists, radarCompanies, hiringPosts, linksFor, searchResults, isUs } from './discover-radar.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const HEAD = 'Grace Gong\n\n \n • Following\n\nFounder @Smart Venture Media | Host @Smart Venture Pod | LinkedIn Top Voices\n\nView my services\n\n4d\n\n';
const INDUSTRIAL = `Feed post\n\n${HEAD}AI INDUSTRIAL COMPANIES (HIRING LIST)\n\nHere are 35 AI industrial companies that are actively hiring right now, ranked by percentage headcount growth in the past 90 days. This is Week 159 of On My Radar, my weekly list of the companies I can't stop watching:\n\nmicroagi - adapts general AI models to industrial tasks (Munich)\nMind Robotics - robots for industrial environments (Sunnyvale)\nGritt AI - AI and robotics for construction (Belmont)\nMytra - AI and robotic material storage and flow (Brisbane, CA)\nCarbonSix - AI robotic hands and teaching kits (Seoul)\nBedrock Robotics - makes heavy equipment autonomous (San Francisco)\n\nCareer page links are in the comments\n\n🔔 follow me for a new list every week: Grace Gong\n\n🙏Special thanks to Harmonic (the ultimate startup database) for helping me source the list\n… more\n\n63\n5\n14\n`;
const MEDTECH = `Feed post\n\n${HEAD}AI MEDTECH COMPANIES (HIRING LIST)\n\nHere are 33 AI medtech companies. This is Week 97 of On My Radar:\n\nCleerly - AI coronary artery disease analysis (Denver)\nOpenwater - semiconductor-based medical imaging (San Francisco)\nQure.ai - AI radiology (New York)\nEko Health - AI digital stethoscope (Emeryville)\nExo - AI handheld ultrasound (Santa Clara)\nCoMind - non-invasive brain monitoring (London)\n\nCareer page links are in the comments\n… more\n\n1\n`;
const NOT_A_LIST = `Feed post\n\nAlex Moreno\n\n • 3rd+\n\nTechnical Program Manager\n\n2w\n\nFollow\n\nI’m looking for my next role! If your team is hiring, my DMs are open!\n… more\n\n7\n`;

console.log('\n🧪 discover-radar: posts and lists');
{
  const posts = splitPosts(INDUSTRIAL + NOT_A_LIST);
  check('two posts', posts.length, 2);
  check('author', posts[0].author, 'Grace Gong');
  check('headline skips the degree and Following lines', posts[1].headline, 'Technical Program Manager');
  const lists = parseLists(INDUSTRIAL + MEDTECH + NOT_A_LIST);
  check('two lists, the job-seeker post is not one', lists.map((l) => l.title), ['AI INDUSTRIAL COMPANIES', 'AI MEDTECH COMPANIES']);
  check('week number', lists[0].week, '159');
  check('company lines', lists[0].companies.map((c) => c.name), ['microagi', 'Mind Robotics', 'Gritt AI', 'Mytra', 'CarbonSix', 'Bedrock Robotics']);
  check('description and city', [lists[0].companies[1].what, lists[0].companies[1].hq], ['robots for industrial environments', 'Sunnyvale']);
}

console.log('\n🧪 discover-radar: which companies go to the resolver');
{
  const cities = new Set(['sunnyvale', 'belmont', 'san francisco', 'denver', 'santa clara', 'emeryville', 'new york', 'reno', 'oxnard', 'lisbon']);
  check('Brisbane, CA is the US; Munich and Seoul are not', [isUs('Brisbane, CA', cities), isUs('Munich', cities), isUs('Seoul', cities), isUs('', cities), isUs('Cambridge, MA', cities)], [true, false, false, true, true]);
  check('a city the store has seen on a US posting is the US; an unknown one is not', [isUs('Oxnard', cities), isUs('Gilching', cities), isUs('HQ undisclosed', cities)], [true, false, true]);
  check('a foreign capital that shares a US town name stays foreign', isUs('Lisbon', cities), false);
  const names = radarCompanies(parseLists(INDUSTRIAL + MEDTECH), { cities }).map((c) => c.name);
  check('a hardware list keeps every US company', ['Mind Robotics', 'Gritt AI', 'Mytra', 'Bedrock Robotics'].every((n) => names.includes(n)), true);
  check('…and drops the foreign ones', names.includes('microagi') || names.includes('CarbonSix'), false);
  check('a medtech list counts too (surgical/medtech is a hardware list title)', names.includes('Openwater'), true);
  const mixed = radarCompanies([{ title: 'AI INFRASTRUCTURE COMPANIES', week: '83', companies: [
    { name: 'Positron AI', what: 'inference hardware', hq: 'Reno' }, { name: 'Runpod', what: 'AI developer cloud', hq: 'San Francisco' }] }], { cities }).map((c) => c.name);
  check('a mixed list keeps only hardware-sounding companies', mixed, ['Positron AI']);
}

console.log('\n🧪 discover-radar: in-house hiring posts');
{
  const FORMLABS = `Feed post\n\nSam Okafor\n\n \n • 3rd+\n\nEngineering Lead - Hardware Reliability at Formlabs\n\n1w\n\nFollow\n\nI’m hiring a Hardware Reliability Engineer to join my team at Formlabs.\n\nMost of our job is breaking printers on purpose.\n… more\n\n35\nFeed post\n\nDana R.\n\n \n • 3rd+\n\nTalent Acquisition & Executive Search Leader\n\n3d\n\nFollow\n\nWE'RE HIRING – LAB TECHNICIAN | Formlabs printers a plus. Send me a DM! My client is Meta.\n… more\n\n5\nFeed post\n\nSam Okafor\n\n \n • 3rd+\n\nR&D Lead at Formlabs\n\n2w\n\nFollow\n\nToday I am proud to announce the Formlabs Studio 1.\n… more\n\n410\n`;
  const hits = hiringPosts(FORMLABS, 'Formlabs');
  check('only the in-house hiring post', hits.map((p) => p.author), ['Sam Okafor']);
  const refs = [{ kind: 'person', url: '/in/samokafor/', text: 'Sam Okafor' },
    { kind: 'feed_post', url: '/posts/samokafor_hiring-reliabilityengineering-share-7518332381000000104-Qr7s' }];
  check('profile and post links', linksFor(refs, 'Sam Okafor'), {
    profile: 'https://www.linkedin.com/in/samokafor/',
    post: 'https://www.linkedin.com/posts/samokafor_hiring-reliabilityengineering-share-7518332381000000104-Qr7s' });
  check('a company name of two letters is not searched', hiringPosts(FORMLABS, 'GE'), []);
  const NV = `Feed post\n\nAri Data\n\n • 3rd+\n\nData Engineering Lead @ NVIDIA | Python, PySpark, SQL\n\n1w\n\nFollow\n\nMy team is hiring a data engineer. DM me!\n… more\n\n3\nFeed post\n\nLee Thermal\n\n • 3rd+\n\nThermal Engineering Manager at NVIDIA\n\n1w\n\nFollow\n\nWe're hiring a mechanical thermal engineer for GPU cooling hardware. Send me a DM.\n… more\n\n9\n`;
  check('a software writer at the right employer is not a lead; the hardware one is', hiringPosts(NV, 'NVIDIA').map((p) => p.author), ['Lee Thermal']);
}

console.log('\n🧪 discover-radar: reading the CLI transcript');
{
  const result = JSON.stringify({ url: 'u', sections: { search_results: INDUSTRIAL }, references: { search_results: [] } });
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__linkedin__search_posts' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: result }] }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Refused: get_feed.' }] } }),
    'not json',
  ].join('\n');
  const r = searchResults(stream);
  check('one search result out of the stream; refusals and noise skipped', r.length, 1);
  check('its text parses as the list', parseLists(r[0].text).map((l) => l.week), ['159']);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
