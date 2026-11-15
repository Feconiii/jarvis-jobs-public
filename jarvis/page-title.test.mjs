// F-1012: a site's header is never a job title, and Tesla's LinkedIn link is
// its stored posting. node --test jarvis/page-title.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { unreadableTitle, teslaBareReq } from './page-title.mjs';
import { reqIdOf, tenantOf } from './dedupe.mjs';

test('the site header Tesla served as its first <h1> is not a job title', () => {
  assert.equal(unreadableTitle('Tesla homepageCareersSkip to main content'), true);
  for (const t of ['Skip navigation', 'Toggle navigation', 'Main menu', 'Accept all cookies', 'Cookie settings', '', '   ', 'Careers', 'My Information', 'Careers at Tesla']) {
    assert.equal(unreadableTitle(t), true, t);
  }
});

test('real titles stay readable, including ones that mention a homepage or navigation work', () => {
  for (const t of ['Manufacturing Engineer, Process & Equipment Development', 'Software Development Engineer II, Homepage',
    'Navigation Systems Engineer', 'GNC Engineer - Guidance, Navigation and Control', 'Menu Planning Analyst', 'Process Engineer',
    'Main Navigation Systems Engineer', 'Site Navigation Lead', 'Primary Menu Engineer']) {
    assert.equal(unreadableTitle(t), false, t);
  }
});

test('Tesla: the bare /job/<n> link and the apply form give the req; the slug link is left to the URL match', () => {
  assert.equal(teslaBareReq('https://www.tesla.com/careers/search/job/271234?source=LinkedIn&source=LinkedIn'), '271234');
  assert.equal(teslaBareReq('https://www.tesla.com/careers/search/job/apply/271234'), '271234');
  assert.equal(teslaBareReq('https://www.tesla.com/careers/search/job/apply/271234?source=LinkedIn'), '271234');
  assert.equal(teslaBareReq('https://www.tesla.com/en_US/careers/search/job/271234/'), '271234');
  assert.equal(teslaBareReq('https://www.tesla.com/careers/search/job/manufacturing-engineer-process-equipment-development-271234'), '');
  assert.equal(teslaBareReq('https://www.tesla.com/careers/search/?query=engineer'), '');
  assert.equal(teslaBareReq('https://example.com/careers/search/job/271234'), '');
});

test('"already applied" by requisition: all three Tesla links are one req on one board', () => {
  const slug = 'https://www.tesla.com/careers/search/job/manufacturing-engineer-process-equipment-development-271234';
  const linkedin = 'https://www.tesla.com/careers/search/job/271234?source=LinkedIn&source=LinkedIn';
  const form = 'https://www.tesla.com/careers/search/job/apply/271234';
  assert.equal(reqIdOf(slug), '271234');
  assert.equal(reqIdOf(linkedin), '271234');
  assert.equal(reqIdOf(form), '271234');
  assert.equal(tenantOf(slug), tenantOf(linkedin));
  assert.notEqual(reqIdOf('https://www.tesla.com/careers/search/job/manufacturing-engineer-tabless-270010'), '271234');
});
