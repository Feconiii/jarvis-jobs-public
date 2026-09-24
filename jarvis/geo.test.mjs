#!/usr/bin/env node
// jarvis/geo.test.mjs — golden tests for the location classifier.
//
// Every string below is a REAL `location` value out of the store. The Costa
// Rica block exists because four different shapes of it were all being shown as
// browsable US jobs at once — that was the bug that got this module written.
//
// Two properties are being defended here, and they pull in opposite directions:
//   · a foreign posting must not reach the deck  (the complaint)
//   · a US posting must never be hidden          (the unacceptable failure)
// So the ambiguous names — Vancouver, Waterloo, Berlin, Hamburg, Cambridge —
// are asserted to be `unknown`, not `non-us`. Unknown means shown.
//
// Run: `node jarvis/geo.test.mjs` (exit 1 on any failure).

import { classifyLocation } from './geo.mjs';

let pass = 0, fail = 0;
function eq(input, want, note = '') {
  const got = classifyLocation(input);
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${JSON.stringify(input)}${note ? ` (${note})` : ''}\n    got:  ${got}\n    want: ${want}`); }
}

console.log('🧪 geo: Costa Rica, all four shapes that leaked into the deck');
eq('Costa Rica, San Jose', 'non-us', 'country name must beat the US city "San Jose"');
eq('CR - Alajuela, Coyol', 'non-us', 'alpha-2 prefix');
eq('CRI - Alajuela - El Coyol', 'non-us', 'alpha-3 prefix, absent from the old set');
eq('Cartago, Cartago', 'non-us', 'city only');
eq('San José, San José Province,CR, CR', 'non-us', 'trailing alpha-2, accented');
eq('Grecia, Costa Rica', 'non-us');
eq('Alajuela Coyol, Alajuela, Costa Rica', 'non-us');
eq('San Antonio de Belen, Costa Rica', 'non-us');

console.log('🧪 geo: US wins over every colliding country code');
eq('San Jose, CA', 'us', 'CA is California here, not Canada');
eq('CA - San Jose', 'us');
eq('Indianapolis, IN', 'us', 'IN is Indiana, not India');
eq('Wilmington, DE', 'us', 'DE is Delaware, not Germany');
eq('Atlanta, GA', 'us', 'GA is Georgia the state');
eq('Baton Rouge, LA', 'us', 'LA is Louisiana, not Laos');
eq('USA - Turkey Creek, NC', 'us', 'an explicit USA outranks the country name "Turkey"');
eq('New Mexico', 'us', 'must not match Mexico');
eq('Paris, Texas', 'us');
eq('London, OH', 'us');
eq('Milan, MI', 'us');
eq('Dublin, CA', 'us');

console.log('🧪 geo: the US shapes that used to fall through to unknown');
eq('Burlington NC', 'us', 'state code with no comma');
eq('Seattle WA', 'us');
eq('US-CO-Frederick', 'us');
eq('US-Nationwide-FIELD', 'us');
eq('Summit West - NJ - US', 'us');
eq('Devens - MA - US', 'us');
eq('USA-California-San Jose-1320 Ridder Park Drive', 'us');
eq('San Francisco', 'us', 'bare US city');
eq('Santa Clara', 'us');
eq('Hillsboro, Oregon', 'us');

console.log('🧪 geo: countries by name, alpha-2 and alpha-3');
eq('Riyadh, Saudi Arabia', 'non-us');
eq('Buenos Aires, Argentina', 'non-us');
eq('Lisbon, Portugal', 'non-us');
eq('Portugal - Lisbon', 'non-us');
eq('Vilnius, Lithuania', 'non-us');
eq('Dubai, United Arab Emirates', 'non-us');
eq('San Isidro, Santo Domingo, Dominican Republic', 'non-us');
eq('Barcelona, ESP', 'non-us');
eq('Navi Mumbai (IND)', 'non-us');
eq('CHN Yancheng - MFG 1 (KUM)', 'non-us');
eq('SGP - Woodlands', 'non-us');
eq('POL - Wroclaw', 'non-us');
eq('CZ-DOUDLEVCE-PILSEN-EDVARDA BENESE 564/39', 'non-us');
eq('IT-FI-FLORENCE-VIA FELICE MATTEUCCI 2', 'non-us');
eq('Taoyuan City,TW, TW', 'non-us');
eq('Kiryat Gat, Israel', 'non-us');

console.log('🧪 geo: bare foreign cities');
eq('Sao Paulo', 'non-us');
eq('São Paulo', 'non-us', 'diacritics folded');
eq('Chihuahua', 'non-us');
eq('Sydney', 'non-us');
eq('Nhon Trach', 'non-us');
eq('Xi An', 'non-us');
eq('Stockholm HQ', 'non-us');
eq('Ottawa, Ontario', 'non-us', 'separator flattened so the two words match as one name');

console.log('🧪 geo: ambiguous names stay visible');
for (const amb of ['Vancouver', 'Waterloo', 'Cambridge', 'Manchester', 'Birmingham', 'Ottawa', 'Berlin', 'Hamburg', 'Gloucester', 'Baja']) {
  eq(amb, 'unknown', 'US twin is written bare too often to risk hiding it');
}
eq('2 Locations', 'unknown', 'Workday multi-site placeholder');
eq('Multiple Locations', 'unknown');
eq('', 'unknown');

console.log('🧪 geo: multi-site postings — any US site wins');
eq('Boise, ID,US, US | San Jose, CA,US, US', 'us');
eq('Austin, TX | Bangalore, India', 'us');
eq('Bangalore, India | Shanghai, China', 'non-us');

// Bullet separators, which Ashby and several custom career sites use. Without
// them the whole string read as one place: an OpenAI req listing three US
// sites classified as Singapore and got hard-blocked.
eq('Singapore · Seattle · United States · San Francisco', 'us');
eq('Singapore · Tokyo, Japan', 'non-us');
eq('Munich, Germany • Austin, TX', 'us');

console.log('🧪 geo: German-law titles are European postings');

/** location + title together, for signals that live in the title. */
function eq2(loc, title, want) {
  const got = classifyLocation(loc, title);
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${JSON.stringify(loc)} + ${JSON.stringify(title)}\n    got:  ${got}\n    want: ${want}`); }
}

// "(f/m/d)", "(m/w/d)", "(f/m/x)" are a legal requirement in German-speaking
// jurisdictions and never appear on a US posting. It matters because these
// arrive with a location of "2 Locations" — a placeholder — so they bucketed
// as 'unknown', and 'unknown' is admitted to the deck on purpose so a missing
// location never hides a US job. 217 European reqs were in the deck on that.
eq2('2 Locations', 'Junior Manufacturing Engineer (f/m/x)', 'non-us');
eq2('5 Locations', 'Software Optimization Engineer (m/w/d)', 'non-us');
eq2('Multiple Locations', 'Robotics Product Specialist (w/m/x) Orthopädie', 'non-us');
// A real US location still wins — the notation is a hint, not an override.
eq2('Austin, TX', 'Manufacturing Engineer (f/m/d)', 'us');
// And a placeholder without the notation stays honestly unknown.
eq2('2 Locations', 'Manufacturing Engineer', 'unknown');

// The notation settles the ambiguous locations too, which is where most of
// them actually were: "Marktoberdorf, DE" reads as Delaware because DE is a
// state code, and Berlin/Hamburg are deliberately `unknown` because their US
// twins get written bare. 126 European reqs reached the deck by those routes.
eq2('Marktoberdorf, DE', 'Manufacturing Engineer (m/w/d)', 'non-us');
eq2('Berlin', 'Junior Engineer (f/m/x)', 'non-us');
eq2('Hamburg', 'Engineer (m/w/d)', 'non-us');
// But it only breaks TIES. Unambiguous US evidence still wins, so a US
// employer using the notation is not mislabelled — TX is not a country code.
eq2('Austin, TX', 'Manufacturing Engineer (f/m/d)', 'us');
eq2('USA - Texas - Austin', 'Engineer (m/w/d)', 'us');
// …and without the notation nothing changes about any of them.
eq2('Marktoberdorf, DE', 'Manufacturing Engineer', 'us');
eq2('Berlin', 'Manufacturing Engineer', 'unknown');

console.log('🧪 geo: foreign towns that were actually sitting in the deck');

// Found by listing every distinct unknown-bucket location in the visible deck,
// not by guessing at name patterns. GE Vernova's "Automation & Robotics
// Engineer" in Noventa di Piave, Italy was at fit 98.
for (const t of ['Noventa di Piave', 'Cassina de Pecchi', 'Taubate', 'Itajuba', 'Tres Rios',
                 'Dzierzoniow', 'Kwidzyn', 'Elblag', 'Bromont', 'Westmount, Quebec',
                 'Aix-les-Bains', 'Belfort', 'Veresegyhaz', 'Pallavaram',
                 'Villeneuve-sur-Lot', 'Boulogne-Billancourt']) {
  eq(t, 'non-us');
}

// Ninth pass, same method: every one of these was in the VISIBLE deck with a
// location that did not parse. Applied Materials' "Test Engineer" in
// Kirkkonummi, Finland was at fit 83; four Japanese sites sat at fit 75.
for (const t of ['Kirkkonummi', 'Feldkirchen Westerham', 'Agrate Brianza', 'Bernin',
                 'Roznov', 'Tiszaujvaros', 'Ashalim', 'Castlebar, Mayo',
                 'The Harley Street Clinic', 'Marsa, Malta', 'Pattaya', 'Chuping',
                 'Pasir Gudang, Johor', 'Taicang, Jiangsu', 'Wujiang, Jiangsu',
                 'Zhongshan, Guangdong', 'Chitose', 'Shonai', 'Yamanashi',
                 'Hitachi Naka', 'Central Luzon', 'King Abdullah Economic City, 02',
                 'Tyne-and-Wear']) {
  eq(t, 'non-us');
}

// The towns F-41 deliberately LEFT alone because they have US twins must stay
// shown. Hiding a US job is the error that costs an opportunity.
for (const t of ['Gloucester', 'Greenville', 'Stafford', 'Bangor', 'Dublin',
                 'Albany', 'Ottawa', 'Baja']) {
  eq(t, 'unknown', 'has a US twin — shown, not hidden');
}

// The reason this is a list and not a rule about connective particles: "du",
// "de" and "di" appear in US place names too, and hiding a US job is the
// error that costs him an opportunity.
eq('Fond du Lac, WI', 'us', 'not French');
eq('Prairie du Chien', 'unknown', 'ambiguous, so shown');
eq('Big Sur, CA', 'us', '"sur" is not the French preposition here');
eq('Des Moines', 'unknown', 'shown rather than guessed at');
// And "Hampshire" is deliberately absent from the list, because New Hampshire.
eq('Manchester, NH', 'us');

function eqv(name, actual, want) {
  if (actual === want) pass++;
  else { fail++; console.error(`✗ ${name}
    got:  ${actual}
    want: ${want}`); }
}

console.log('🧪 geo: "N Locations" resolved from the ATS URL');

// 185 deck postings carried a placeholder location; the ATS had written the
// primary site into its own job URL all along. Verified against the Workday
// API before shipping: 10 reachable foreign-primary reqs, all 10 listing only
// foreign sites — so the primary settles a multi-site req.
const byUrl = (loc, url) => classifyLocation(loc, '', url);
eqv('"2 Locations" + Hsinchu URL', byUrl('2 Locations', 'https://kla.wd1.myworkdayjobs.com/Search/job/Hsinchu-Taiwan/Dev_1'), 'non-us');
eqv('"2 Locations" + Dubai URL', byUrl('2 Locations', 'https://cisco.wd1.myworkdayjobs.com/x/job/Dubai-United-Arab-Emirates/L_1'), 'non-us');
// Jabil's "8 Locations" really are eight US sites — this must stay US.
eqv('"8 Locations" + Tampa URL stays US', byUrl('8 Locations', 'https://jabil.wd5.myworkdayjobs.com/Jabil_Careers/job/St-PetersburgTampa-FL/Rot_1'), 'us');
eqv('placeholder with no URL is still unknown', byUrl('2 Locations', ''), 'unknown');
// A REAL location string is never overridden by the URL: the multi-site rule
// ("any US site wins") owns that case, and F-14 is what happens if it doesn't.
eqv('a real location beats the URL', byUrl('Austin, TX', 'https://x.wd1.myworkdayjobs.com/y/job/Hsinchu-Taiwan/z_1'), 'us');
eqv('non-Workday URLs are ignored', byUrl('2 Locations', 'https://boards.greenhouse.io/x/jobs/12345'), 'unknown');

console.log('🧪 geo: a title-cased country code, because our own cleanup lowercased it');

// Eaton posts "Manufacturing Engineer South Molton Gbr Ex36 3dw" with an EMPTY
// location field — a UK req that sat at fit 83. The only country signal is
// "Gbr", and the detector looked for a literal all-caps "GBR", so it never
// fired. The title-casing is ours: fix-titles.mjs preserves roman numerals and
// a known acronym list, and turns everything else into Title Case.
eq2('', 'Manufacturing Engineer South Molton Gbr Ex36 3dw', 'non-us');
eq2('', 'Mechanical Designer Nottingham Gbr Ng17 5fb', 'non-us');
eq2('', 'Ups Field Service Engineer Slough Gbr Sl14dx', 'non-us');
// All-caps mid-string still works (FedEx's European site slugs).
eq2('', 'FXE-EU/PRT/OPOSSC', 'non-us');

// Title case is allowed ONLY for codes that are not English words. "Ind" is
// India's alpha-3 AND the traditional abbreviation for Indiana, and it lands in
// trailing position — which would satisfy the ambiguous test on its own.
eq2('', 'Manufacturing Engineer Indianapolis Ind', 'unknown');
eq2('', 'Engineer Del Mar CA', 'us');
eq2('', 'Engineer Cape Cod MA', 'us');
eq2('', 'Engineer Peru Indiana', 'us');
eq2('', 'Manufacturing Engineer Canton Ohio', 'us');
eq2('', 'Engineer Lebanon Tennessee', 'us');

console.log('🧪 geo: a remote role that names a foreign country is FOREIGN');

// The location-field path already knew this; the title path checked "remote"
// first and returned it, and  is admitted to the deck. Teradyne posts
// "Remote Service Engineer (GCS Hsinchu, Taiwan)" with no location field.
eq2('', 'Remote Service Engineer (GCS Hsinchu, Taiwan)', 'non-us');
eq2('', 'Remote Engineer Bangalore India', 'non-us');
eq2('', 'Remote Engineer Shanghai China', 'non-us');
// A remote role naming a US site, or naming nowhere, is still remote.
eq2('', 'Remote Manufacturing Engineer Austin Texas', 'us');
eq2('', 'Remote Engineer - USA', 'us');
eq2('', 'Remote Mechanical Engineer', 'remote');

eq('Sungai Petani', 'non-us', 'Malaysia - Jabil ME Engineer II sat at fit 58');
eq('Southampton, Hampshire', 'non-us', 'UK - the PAIR is unambiguous');
eq('Southampton, NY', 'us', 'the US twin must survive it');
eq('Hampshire, IL', 'us', 'and so must Hampshire, Illinois');

console.log('🧪 geo: remote');
eq('Remote', 'remote');
eq('Remote - USA', 'remote');
eq('Remote, Germany', 'non-us');
eq('Work from home', 'remote');

// ── the two-argument form: no location field, classify from the TITLE ──
//
// Nothing here was covered before, and that is exactly where the worst bug in
// this module lived. Sitemap- and Eightfold-discovered jobs arrive with an
// EMPTY location, so every one of them takes this path — and a position-free
// scan for three-letter country codes read the word "and" as Andorra. Any
// engineering title containing "and", which is a large share of them, was
// bucketed non-us and filtered out of the default deck.
console.log('🧪 geo: titles classified when the location field is empty');
const eqT = (title, want, note) => {
  const got = classifyLocation('', title);
  if (got === want) pass++;
  else { fail++; console.error(`✗ title ${JSON.stringify(title)}${note ? ` (${note})` : ''}\n    got:  ${got}\n    want: ${want}`); }
};
eqT('Research and Development Engineer', 'unknown', '"and" is not Andorra');
eqT('Test and Evaluation Engineer', 'unknown');
eqT('Manufacturing Engineer, Fremont CA', 'us');
eqT('Process Engineer - Hsinchu', 'non-us', 'fab town concatenated in a slug');
eqT('Equipment Engineer, Munich, Germany', 'non-us');
eqT('Remote Design Engineer', 'remote');
// The gender notation works on the empty-location path too. Accenture's
// "CONSEILLER COMMERCIAL (F/H) MARCQ EN BAROEUL" was the last European req
// left standing in the deck.
eqT('CONSEILLER COMMERCIAL (F/H)  MARCQ EN BAROEUL', 'non-us');
eqT('Manufacturing Engineer (f/m/d), Austin TX', 'us', 'a real US city still wins');

console.log('🧪 geo: three-letter English words that are also ISO-3 codes');
// AND Andorra · MAR Morocco · COD DR Congo · CAN Canada · ARE UAE · PAN Panama
eq('Cambridge and Boston, MA', 'us');
eq('Del Mar, CA', 'us', 'MAR is Morocco');
eq('Cape Cod, MA', 'us', 'COD is the DR Congo');
eq('Panama City, FL', 'us', 'PAN is Panama');
eq('Research and Development, Chandler AZ', 'us');
// …while a real alpha-3, in the position a tenant writes one, still counts.
eq('San Jose, CRI', 'non-us', 'trailing alpha-3');
eq('CRI - Alajuela', 'non-us', 'leading alpha-3');
eq('Bangalore, IND', 'non-us');
eq('IND-Hyderabad', 'non-us');

console.log('🧪 geo: codes that are both a US state and a country');
// Decided by whether the city is actually IN that country — structure alone
// cannot separate "Bangalore, IN" from "Dresden, TN", because they are the
// same shape.
eq('Bangalore, IN', 'non-us', 'Bangalore is an Indian city');
eq('Bangalore, KA, IN', 'non-us', 'the JSON-LD three-part form');
eq('Hyderabad, TS, IN', 'non-us');
eq('Toronto, ON, CA', 'non-us');
eq('Munich, DE', 'non-us');
eq('Yokneam, IL', 'non-us');
eq('Dresden, TN', 'us', 'Dresden is German, and Tunisia has no Dresden — so TN is Tennessee');
eq('Delhi, CA', 'us', 'Delhi, California — CA here is not India-adjacent');
eq('Ottawa, IL', 'us', 'IL is Illinois; Ottawa is not an Israeli city');
eq('Cambridge, MA', 'us', 'MA is Massachusetts, not Morocco');
eq('Milan, GA', 'us');
eq('Berlin, MD', 'us');
// A foreign city whose own country is NOT the colliding code still reads as
// foreign, as long as the string is not the canonical "City, ST" shape. Salzburg
// is Austrian and IN is India's code, so the city test above cannot resolve it —
// but "IN Salzburg At Salzburg" is plainly not an American address.
eq('IN Salzburg At Salzburg', 'non-us', 'real Workday location string');
eq('DE Munich Bavaria', 'non-us');
eq('Dublin OH', 'us', 'no comma, and Dublin is deliberately not in the foreign gazetteer');

console.log('🧪 geo: three-letter codes that are mechanical vocabulary first');
// ARM, FIN, TON, VAT and LUX are a robot joint, a heat-exchanger fin, a unit of
// weight, a process tank and a unit of illuminance long before they are Armenia,
// Finland, Tonga, the Vatican and Luxembourg. These titles arrive with an empty
// location field, so the title path is what decides them.
eqT('Robotic Arm Integration Engineer', 'unknown');
eqT('Fin and Tube Heat Exchanger Engineer', 'unknown');
eq('Robotic Arm Integration Engineer, Fremont CA', 'us');
eq('RESEARCH AND DEVELOPMENT CENTER, AUSTIN TX', 'us', 'an all-caps US address must not match AND');
eq('Cape Cod', 'unknown', 'not in the US gazetteer, so it stays visible — but never the Congo');

console.log('🧪 geo: unambiguous alpha-3 codes work anywhere in the string');
// A code that cannot be confused with prose does not have to sit in a
// country-code position. FedEx buries them mid-path; some tenants title-case
// them. Requiring position as well lost both.
eq('FXE-EU/PRT/OPOSSC/OPOSSC/R.LIONESA', 'non-us', 'mid-string alpha-3');
eq('FXE-EU/DEU/GTIA/GTIA/Road Transit', 'non-us');
eq('FXE-EU/POL/KCWA/KCWA/Chorzow', 'non-us');
eq('DE Arteaga Mex', 'non-us', 'a title-cased trailing code is the only foreign signal here');
eq('PAN - Panama City', 'non-us', 'an ambiguous code still counts when positioned AND capitalised');

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
