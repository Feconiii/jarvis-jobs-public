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

import { classifyLocation, bucketDrifted } from './geo.mjs';

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
// …and without the notation Berlin is still unknown. "Marktoberdorf, DE" is
// Germany on its own since 2026-11-03: it is no Delaware place (see below).
eq2('Marktoberdorf, DE', 'Manufacturing Engineer', 'non-us');
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

console.log('🧪 geo: F-759 — US towns named after countries, "Town, ST" wins');
// CONVERGIX, LG Energy Solution and Yanfeng (Holland, MI), Lennox (Grenada,
// MS) and Amphenol (Macedonia, OH) were all filed non-us: the country NAME in
// the town outranked the state code after the comma.
for (const t of ['Holland, MI', 'Holland, MI 49423', 'South Holland, IL', 'Grenada, MS',
                 'Macedonia, OH', 'Canada, KY', 'Jamaica, NY', 'Angola, IN', 'Brazil, IN',
                 'North Wales, PA', 'Little Canada, MN', 'Lebanon, PA', 'Lebanon, OH',
                 'Lebanon, NH', 'Lebanon, TN', 'Mexico, MO', 'Peru, IN', 'Poland, OH',
                 'Jordan, MN', 'Cuba, MO', 'Denmark, WI', 'Norway, ME', 'Panama City, FL',
                 'Paris, TX', 'Athens, GA', 'Berlin, NH', 'Moscow, ID', 'Dublin, OH',
                 'Dublin, CA', 'Toronto, OH', 'London, KY', 'Nederland, TX', 'Amsterdam, NY',
                 'Dresden, TN', 'Ontario, CA', 'Glasgow, DE', 'Glasgow, KY', 'Cairo, IL',
                 'Leeds, AL', 'PA-Warrington', 'SC-Swansea']) {
  eq(t, 'us', 'a US town');
}
// A ZIP after the state code is still the canonical shape.
eq('Paris, TN 38242', 'us', 'was France: "TN 38242" was not exactly "TN"');
eq('Vincennes, IN 47591', 'us');
eq('New Orleans, LA 70123', 'us', 'was Laos, via the French Orleans');
eq('Saint John, IN 46373', 'us');
// The code the line ENDS on is the state, not the first capitalised pair.
eq('La Palma, CA', 'us', 'the "La" is not Louisiana/Laos');
eq('Little Italy SD, 2008 India St., San Diego, CA 92101', 'us', 'a street line is not a country');
eq2('', 'Sales Supervisor, Leeds, AL', 'us');
// …and the rule does not pull real foreign postings in.
for (const t of ['Germany, DE', 'India, IN', 'Canada, CA', 'Israel, IL', 'Germany-wide, DE',
                 'Panama City, PA', 'Panama City, 8, PA', 'Australia, WA',
                 'Perth, AU, Australia, WA', 'Bangalore, India, IN', 'India, India, IN',
                 'Toronto, Canada, CA', "Ra'anana, ISR, IL", 'Amsterdam, NH, Netherlands',
                 'Pithampur, MP, IN', 'Bogotá, DC, CO', 'Tunis, TN', 'Sfax, TN']) {
  eq(t, 'non-us', 'a country beside its own code, or a country later in the line');
}

console.log('🧪 geo: state codes that are also foreign region codes');
// Tamil Nadu (TN), Assam (AS), Odisha (OR), Madhya Pradesh (MP), Noord-Holland
// (NH): Indian and Dutch tenants write these exactly like US states. "Chennai,
// TN" was 76 rows in the US bucket.
for (const t of ['Chennai, TN', 'Coimbatore, TN', 'Guwahati, AS', 'Bhubaneswar, OR',
                 'Indore, MP', 'Amsterdam, NH', 'Hilversum, NH', 'Kiel, DE', 'Kempten, DE',
                 'Fellbach, BW, DE', 'Hude-Wüsting, NI, DE', 'Warstein, NRW,DE, DE',
                 'Bergkamen, Nordrhein-Westfalen, DE', 'Weimar, Thüringen, DE',
                 '_, TNG, MA, 94031', 'Al Matar, Cairo Governorate, Egypt']) {
  eq(t, 'non-us');
}
// "X, DE" IS DELAWARE ONLY WHEN IT IS IN DELAWARE (2026-11-03). "Stays
// shown" was the rule while nothing listed Delaware's places; now every one
// is listed, and its ZIPs all start 197-199.
for (const t of ['Marktoberdorf, DE', 'Neuenstein, DE', 'Lindenberg im Allgäu, DE', 'Bensheim, DE, 64625',
                 'Schwaikheim, DE, 71409', 'Wolfsburg, DE', 'Bonndorf/Schwarzwald, BW, DE, D-79848']) eq(t, 'non-us');
for (const t of ['Wilmington, DE', 'Newark, DE', 'Glasgow, DE', 'Rehoboth Beach, DE', 'RPSNA Middletown DE',
                 'Milford, DE, US, 19963', 'Some Plant, DE, 19706', 'US - Wilmington - DE',
                 'Washington, DC, Baltimore, MD, Sterling, VA, Georgetown, DE']) eq(t, 'us');
eq('DE005 Greentree - Clinic', 'us', 'a site code glued to digits keeps the older reading');
// "Remote, DE" names no place: Delaware or Germany, so remote, not abroad (review).
for (const t of ['Remote, DE', 'Remote - DE', 'Remote, Remote, DE']) eq(t, 'remote');
eq('Remote (DE), Germany', 'non-us');
// retriage --location picks rows by this (2026-11-03): stored vs current reading.
{
  const ok = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`✗ ${name}: got ${got}`); } };
  ok('a German "DE" row stored as us has drifted', bucketDrifted({ location: 'Neuenstein, DE', title: 'Engineer', url: '', location_bucket: 'us' }), true);
  ok('a row stored as the current reading has not', bucketDrifted({ location: 'Wilmington, DE', title: 'Engineer', url: '', location_bucket: 'us' }), false);
  ok('a row with no stored bucket has drifted', bucketDrifted({ location: 'Austin, TX', title: 'Engineer', url: '', location_bucket: null }), true);
}
// A state code before the end of the string counts only in capitals:
// "La Piedad" (Bosch, Mexico) is no Louisiana, "Mi Perú, Callao" no Michigan.
eq('La Piedad, Qro., Mexico', 'non-us');
eq('Mi Perú, Callao, Peru', 'non-us');
eq('La Piedad', 'unknown');
for (const t of ['LA - Baton Rouge', 'Baton Rouge, La', 'La Palma, CA']) eq(t, 'us');

console.log('🧪 geo: F-764 — foreign cities with no country');
// PwC "Cairo - ETIC", PwC "Warszawa", BlackRock "Edinburgh" sat in the deck
// among US postings because a city with no country read as unknown.
for (const t of ['Cairo - ETIC', 'Cairo', 'Warszawa', 'Edinburgh', 'Glasgow', 'Belfast',
                 'Leeds', 'Crawley', 'Rugby', 'Perth', 'Santiago', 'Juarez', 'Goettingen',
                 'Vélizy-Villacoublay', 'Gennevilliers', 'Bucuresti', 'Moskva', 'Sanchong',
                 'Kaiseraugst', 'Selangor', 'Kanagawa', 'Maharashtra', 'Queensland']) {
  eq(t, 'non-us', 'a foreign city standing alone');
}
// Gazetteer entries written with a hyphen never matched flattened input.
eq('Vitry-sur-Seine', 'non-us');
eq('Issy Les Moulineaux', 'non-us');
eq('Saint-Étienne', 'non-us');
eq('Wilkes-Barre', 'us', 'the US gazetteer had the same hole');
// "XX - City" with a country code, spaced.
eq('PL - Warszawa', 'non-us');
eq('CH - Visp', 'non-us');
eq('NL - Geleen', 'non-us');
eq('SA - San Antonio', 'us', 'a US city on the line wins');
eqT('IT — Service Desk Analyst', 'unknown', 'IT is a department here, not Italy');
eqT('GN - SONG - MT - Hyperpersonalization - Analyst', 'us', 'an Accenture unit code, not Guinea');
// Canadian province codes and names.
for (const t of ['Ottawa, ON', 'Mount Royal, QC', 'Saint-Bruno, QC, CA', 'CA - Woodbridge, ON',
                 'Cambridge, ON, CA', 'Iqaluit, NU, CA', 'Vancouver, British Columbia',
                 'Alliston, Ontario', 'Kirkland, Quebec', 'Moncton, New Brunswick',
                 'Reading, Berkshire', 'Chennai, Tamil Nadu', 'Rijssen, Overijssel, Nederland']) {
  eq(t, 'non-us');
}
eq('Ontario', 'unknown', 'Ontario, CA and Ontario, OR are cities: a leading region name proves nothing');
eq('Ontario, California', 'us');
eq('Renal Center of Nederland', 'unknown', 'Nederland, TX — the name counts only after a comma');
// Trailing foreign postcodes hid the country code before them.
for (const t of ['Leeds, GB, LS19 6JY', 'Swindon, Wiltshire, GB, SN5 6PB',
                 'Amsterdam, NH, NL, 1082 VA', 'Ballina, MY, IE, F26 F3X5',
                 'Coquitlam, British Columbia, CA, V3K 5X6']) {
  eq(t, 'non-us', 'the postcode is dropped before the country is read');
}
// Names with a US twin written bare stay unknown — unknown means shown.
for (const t of ['Liverpool', 'Rome', 'Parma', 'Lima', 'Valencia', 'Victoria', 'Warwick',
                 'Bristol', 'Derby', 'Reading', 'Cali', 'Baden', 'Birmingham', 'Cambridge',
                 'Manchester', 'Dublin', 'Athens', 'Perth Amboy', 'Sheffield Village']) {
  eq(t, 'unknown', 'US twin: shown, not hidden');
}
// F-1042. After a plain town name the comma part is its region, not a second
// city: "Thetford, Norfolk" (Multimatic, England, 37 rows) was Virginia.
eq('Thetford, Norfolk', 'unknown', 'Norfolk is the county here, not the Virginia city');
eq('Carrick-on-Shannon, Co. Leitrim', 'unknown');
eq('Norfolk', 'us', 'a US city standing alone still reads as one');
eq('Norfolk, VA', 'us');
eq('Chelmsford, Essex', 'us', 'Chelmsford is itself a US city: only the posting text can settle it');
// …and a non-town first part still lets a US city later in the line count.
for (const t of ['GLOBAL CUSTOM COMMERCE/BLINDS OFFICE, HOUSTON - 2140', '379 Interpace Pkwy, Parsippany, 07054',
                 'Seattle, San Francisco', 'Los Angeles, San Francisco', 'Pittsburgh, San Mateo',
                 'Chicago, Minneapolis, or Milwaukee', 'Seattle,Tacoma, Federal Way', 'Pittsburgh, San Mateo, Bengaluru',
                 'Silicon Valley, Cupertino, Palo Alto, San Jose, East Bay', 'Chicago, Toronto']) {
  eq(t, 'us', 'a US site on the line');
}
// A US metro after a town is its metro (review, 2026-11-12).
for (const t of ['Bothell, Seattle', 'Kent, Seattle area', 'Springfield, Chicago area', 'Lancaster, Los Angeles', 'Oakland, Chicago', 'Paris, TX', 'Ukiah, CA']) {
  eq(t, 'us', 'a US metro or state after the town');
}
eq('Durham, DUKE', 'unknown', '"UK" inside a word is no country');
// A province code followed by the site, the way Air Liquide Canada writes it.
for (const t of ['Bonnyville, AB - 50 Ave (Lakeland) - Respiratory therapy', 'Laval, QC - boul. Curé-Labelle (263) - Respiratory therapy',
                 'Maitland, ON (N2O) (I) - N2O primary production', 'Mississauga, ON - Creditview Rd (VA HO)', 'Gander, NL (540) - Respiratory therapy']) {
  eq(t, 'non-us', 'province code then the site');
}
eq('Mount Pleasant, PA', 'us');

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
