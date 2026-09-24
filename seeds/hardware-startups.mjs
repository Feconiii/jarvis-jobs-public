// @ts-check
/**
 * seeds/hardware-startups.mjs — the names no portfolio API will hand you.
 *
 * WHY THIS FILE IS A LIST AND NOT A SCRAPER (F-416).
 *
 * `vc-portfolios.mjs` fetches YC and a16z because both publish a machine-
 * readable portfolio. The venture firms that actually fund the companies Alex
 * wants — Eclipse, Lux, Founders Fund, DCVC, Root, Construct, Playground,
 * Prime Movers, Seraphim, 8VC — do not. Probed on 2026-09-08, six of ten
 * portfolio pages answered with a redirect, a 404 or a connection failure, and
 * the two that returned HTML render their company list from JavaScript. Ten
 * bespoke HTML parsers, each breaking on its own schedule, to produce a list of
 * names is a worse trade than writing the names down.
 *
 * A NAME HERE IS A CANDIDATE, NEVER A FACT. `jarvis/discover-ats.mjs` resolves
 * each one against a live ATS API and writes nothing to portals.yml that did
 * not just return real postings, so a misspelled, merged, renamed or dead
 * company costs one failed lookup and nothing else. That is what makes a
 * hand-written list safe to keep: the list proposes, the network disposes.
 *
 * WHAT IS DELIBERATELY ABSENT. Defence-first employers. His F-1/OPT status
 * makes a clearance or US-person requirement a wall, not a hurdle, and
 * `discover-ats.mjs` keeps its own CLEARANCE_GATED list for the ones that slip
 * in by name. Commercial space and nuclear ARE here on purpose: their
 * ITAR-gated postings get hard-blocked one at a time, with the quote, so the
 * applyable minority still reaches him.
 *
 * MAINTENANCE. Add names; do not prune them for going quiet. A company with no
 * open reqs today resolves to a board that will have some in March, and the
 * scan costs one API call. Remove a name only when it is acquired, dead, or
 * turns out to be defence-first.
 *
 * Usage:
 *   node jarvis/discover-ats.mjs --seeds hardware
 *   node jarvis/discover-ats.mjs --seeds hardware,yc --write
 */

/**
 * @typedef {object} HardwareSeed
 * @property {string} name    Company name, as its careers page spells it.
 * @property {string} domain  Which slice of his target this sits in.
 */

/**
 * Semiconductor devices, fabs, capital equipment, metrology and photonics —
 * the sector he is aiming at, and the one where "process engineer" and
 * "equipment engineer" are the standard entry titles.
 */
const SEMICONDUCTOR = [
  'PsiQuantum', 'Atomic Semi', 'Substrate', 'SiTime', 'Navitas Semiconductor',
  'Transphorm', 'SkyWater Technology', 'Tower Semiconductor', 'Onto Innovation',
  'Veeco Instruments', 'Axcelis Technologies', 'FormFactor',
  'Advanced Energy Industries', 'Ultra Clean Holdings', 'Entegris',
  'MKS Instruments', 'Photronics', 'Amkor Technology', 'Kulicke and Soffa',
  'Cohu', 'Aehr Test Systems', 'ACM Research', 'Ichor Holdings',
  'Brooks Automation', 'Azenta Life Sciences', 'Coherent Corp',
  'Lumentum', 'IPG Photonics', 'nLIGHT', 'Novanta', 'Rogue Valley Microdevices',
  'Lightmatter', 'Ayar Labs', 'Celestial AI', 'Astera Labs', 'Xscape Photonics',
  'Cerebras Systems', 'Groq', 'SambaNova Systems', 'Tenstorrent', 'Etched',
  'EnCharge AI', 'Mythic', 'Axelera AI', 'd-Matrix', 'SiMa.ai', 'Hailo',
  'Ambiq Micro', 'Silicon Labs', 'Lattice Semiconductor', 'Wolfspeed',
  'Atom Computing', 'IonQ', 'Rigetti Computing', 'Infleqtion', 'QuEra Computing',
  'Quantinuum', 'Xanadu Quantum Technologies',
];

/**
 * Robotics, industrial automation and the autonomy companies whose hardware is
 * a vehicle. The single largest source of mechanical, mechatronics and
 * integration reqs outside semiconductors.
 */
const ROBOTICS = [
  'Chef Robotics', 'Cobot', 'Skild AI', 'Dyna Robotics', 'Generalist AI',
  'The Bot Company', 'Standard Bots', 'Rapid Robotics', 'Viam',
  'Ambi Robotics', 'Osaro', 'Plus One Robotics', 'RightHand Robotics',
  'Berkshire Grey', 'Locus Robotics', 'Vecna Robotics', 'Nimble Robotics',
  'Pickle Robot', 'Dexory', 'Attabotics', 'Exotec', 'AutoStore', 'Symbotic',
  'Third Wave Automation', 'Realtime Robotics', 'Sarcos Technology',
  'Boston Dynamics', 'Sanctuary AI', 'Diligent Robotics', 'Bear Robotics',
  'Serve Robotics', 'Starship Technologies', 'Coco Robotics',
  'Carbon Robotics', 'Monarch Tractor', 'Verdant Robotics', 'Burro',
  'Tortuga AgTech', 'Bluewhite', 'FarmWise',
  'Gatik', 'Kodiak Robotics', 'Torc Robotics', 'Aurora Innovation',
  'Plus AI', 'Einride', 'May Mobility', 'Motional', 'Waabi', 'Cyngn',
  'Outrider', 'ISEE', 'Cruise',
  'Wing Aviation', 'Matternet', 'Flytrex', 'Percepto', 'Zipline International',
  'Instrumental', 'Tulip Interfaces', 'Sight Machine', 'Augury',
  'MachineMetrics', 'Oden Technologies', 'Guidewheel',
];

/**
 * Fusion, fission, storage, electrochemistry and industrial decarbonisation.
 * Physical plants, test rigs and pilot lines — mechanical work throughout, and
 * the sector hiring hardest for new grads right now.
 */
const ENERGY = [
  'Commonwealth Fusion Systems', 'Helion Energy', 'TAE Technologies',
  'Zap Energy', 'Type One Energy', 'Pacific Fusion', 'Xcimer Energy',
  'Thea Energy', 'Realta Fusion', 'Focused Energy', 'Marathon Fusion',
  'TerraPower', 'Kairos Power', 'Oklo', 'Radiant Industries', 'Aalo Atomics',
  'Deep Fission', 'Last Energy', 'NANO Nuclear Energy', 'Terrestrial Energy',
  'Valar Atomics', 'Standard Nuclear',
  'ESS Tech', 'Li-Cycle', 'Ascend Elements', 'Group14 Technologies',
  'Amprius Technologies', 'Enovix', 'Solid Power', 'QuantumScape', 'SES AI',
  'Factorial Energy', 'Lyten', '24M Technologies', 'Natron Energy',
  'Peak Energy', 'Base Power', 'EnerVenue', 'Eos Energy Enterprises',
  'Our Next Energy', 'American Battery Technology Company', 'Nth Cycle',
  'Cyclic Materials', 'Mitra Chem', 'Coreshell', 'Zeta Energy',
  'Boston Metal', 'Electra', 'Sublime Systems', 'Brimstone', 'Fortera',
  'Terra CO2', 'Heirloom Carbon', 'CarbonCapture Inc', 'Charm Industrial',
  'Twelve', 'LanzaTech', 'Solugen', 'Antora Energy', 'Rondo Energy',
  'Fourth Power', 'Malta Inc', 'Alsym Energy', 'Verdagy',
  'Electric Hydrogen', 'Ohmium', 'Plug Power', 'Bloom Energy',
  'Fervo Energy', 'Quaise Energy', 'Sage Geosystems', 'Dandelion Energy',
  'Exowatt', 'Terabase Energy', 'GAF Energy', 'Swift Solar', 'Caelux',
  'Tandem PV', 'CubicPV', 'Koloma', 'Span.IO', 'Lunar Energy',
];

/**
 * Commercial space and next-generation aviation. Kept in full knowledge that
 * much of it is ITAR-gated: triage blocks those postings individually, and the
 * remainder (ground support, manufacturing, test at the non-gated end) is real.
 */
const AEROSPACE = [
  'Stoke Space', 'Firefly Aerospace', 'ABL Space Systems', 'Astra Space',
  'Impulse Space', 'K2 Space', 'Apex Space', 'Vast Space', 'Axiom Space',
  'Sierra Space', 'Momentus', 'Muon Space', 'Planet Labs', 'Capella Space',
  'ICEYE', 'Umbra', 'AST SpaceMobile', 'Terran Orbital', 'Redwire Space',
  'Voyager Technologies', 'Slingshot Aerospace', 'Turion Space',
  'Starfish Space', 'Orbit Fab', 'Benchmark Space Systems', 'Phase Four',
  'Agile Space Industries', 'Interlune', 'Venturi Astrolab',
  'Venus Aerospace', 'Boom Supersonic', 'JetZero', 'Natilus', 'Elroy Air',
  'BETA Technologies', 'Wisk Aero', 'Overair', 'Electra Aero', 'Ampaire',
  'ZeroAvia', 'Universal Hydrogen', 'Heart Aerospace', 'Eviation',
  'Reliable Robotics', 'Xwing', 'Merlin Labs', 'Whisper Aero', 'REGENT Craft',
];

/**
 * Medical devices, surgical robotics, neurotech and lab automation — an FDA
 * design-control culture that hires mechanical engineers for exactly the
 * drawing, tolerance and fixture work on his CV.
 */
const MEDICAL = [
  'Neuralink', 'Precision Neuroscience', 'Paradromics', 'Synchron',
  'Motif Neurotech', 'Vicarious Surgical', 'PROCEPT BioRobotics',
  'Noah Medical', 'Moon Surgical', 'Distalmotion', 'CMR Surgical',
  'Asensus Surgical', 'Monogram Technologies', 'Neuros Medical',
  'Inari Medical', 'Silk Road Medical', 'iRhythm Technologies',
  'Butterfly Network', 'Exo Imaging', 'Hyperfine', 'Cala Health',
  'Tandem Diabetes Care', 'Insulet', 'Beta Bionics', 'Ceribell',
  'Element Science', 'Sight Sciences',
  'Ginkgo Bioworks', 'Opentrons', 'Culture Biosciences', '908 Devices',
  'Standard BioTools',
];

/**
 * Vehicles, additive manufacturing, contract manufacturing and the
 * software-defined factory companies. Where "manufacturing engineer" and "NPI"
 * are the job title rather than a responsibility inside another one.
 */
const INDUSTRIAL = [
  'Rivian', 'Scout Motors', 'Slate Auto', 'Bollinger Motors',
  'Harbinger Motors', 'Xos Trucks', 'Aptera Motors', 'Canoo',
  'VulcanForms', 'Seurat Technologies', 'Velo3D', 'Desktop Metal',
  'Markforged', 'Formlabs', 'Carbon', 'Freeform', 'Nikon SLM Solutions',
  'Xometry', 'Protolabs', 'Fictiv', 'Hubs',
  'Framework Computer', 'Oura', 'WHOOP', 'Eight Sleep', 'Sonos',
  'Anker Innovations', 'Peloton Interactive',
];

/**
 * Company websites, for the names whose board slug cannot be reached from the
 * name. Commonwealth Fusion Systems is the case that proved the need: its
 * 95-posting Lever board is at `cfsenergy`, which no amount of name-mangling
 * produces. `discover-ats.mjs` falls back to fetching the careers page here and
 * reading the board link out of it — so one line of data replaces an
 * unguessable slug, and the board it finds is still verified against the
 * company name before anything is written.
 *
 * Only add an entry when the name-based probe has actually failed. A site here
 * costs an HTML fetch on every run that reaches the fallback.
 *
 * @type {Record<string, string>}
 */
const SITES = {
  'Commonwealth Fusion Systems': 'https://cfs.energy',
  'Boston Dynamics': 'https://bostondynamics.com',
  'Rivian': 'https://rivian.com',
  'TerraPower': 'https://terrapower.com',
  'Helion Energy': 'https://helionenergy.com',
  'Stoke Space': 'https://stokespace.com',
  'Firefly Aerospace': 'https://fireflyspace.com',
  'Impulse Space': 'https://impulsespace.com',
  'K2 Space': 'https://k2space.com',
  'Vast Space': 'https://vastspace.com',
  'BETA Technologies': 'https://beta.team',
  'Chef Robotics': 'https://chefrobotics.ai',
  'Symbotic': 'https://symbotic.com',
  'Cruise': 'https://getcruise.com',
  'Gatik': 'https://gatik.ai',
  'Kodiak Robotics': 'https://kodiak.ai',
  'Aurora Innovation': 'https://aurora.tech',
  'May Mobility': 'https://maymobility.com',
  'Motional': 'https://motional.com',
  'Zap Energy': 'https://zapenergy.com',
  'TAE Technologies': 'https://tae.com',
  'QuantumScape': 'https://quantumscape.com',
  'Natron Energy': 'https://natron.energy',
  'Fervo Energy': 'https://fervoenergy.com',
  'Electric Hydrogen': 'https://eh2.com',
  'Boston Metal': 'https://bostonmetal.com',
  'Sublime Systems': 'https://sublime-systems.com',
  'LanzaTech': 'https://lanzatech.com',
  'Group14 Technologies': 'https://group14.technology',
  'Amprius Technologies': 'https://amprius.com',
  'Eos Energy Enterprises': 'https://eose.com',
  'Wisk Aero': 'https://wisk.aero',
  'ZeroAvia': 'https://zeroavia.com',
  'Terran Orbital': 'https://terranorbital.com',
  'Redwire Space': 'https://redwirespace.com',
  'Capella Space': 'https://capellaspace.com',
  'Precision Neuroscience': 'https://precisionneuro.io',
  'Paradromics': 'https://paradromics.com',
  'Synchron': 'https://synchron.com',
  'PROCEPT BioRobotics': 'https://procept-biorobotics.com',
  'Vicarious Surgical': 'https://vicarioussurgical.com',
  'Tandem Diabetes Care': 'https://tandemdiabetes.com',
  'Desktop Metal': 'https://desktopmetal.com',
  'Framework Computer': 'https://frame.work',
  'Viam': 'https://viam.com',
  'Standard Bots': 'https://standardbots.com',
  'Skild AI': 'https://skild.ai',
  'Wolfspeed': 'https://wolfspeed.com',
  'Entegris': 'https://entegris.com',
  'MKS Instruments': 'https://mks.com',
  'Groq': 'https://groq.com',
  'Ayar Labs': 'https://ayarlabs.com',
  'Celestial AI': 'https://celestial.ai',
  'SiTime': 'https://sitime.com',
  'Quantinuum': 'https://quantinuum.com',
};

/** @type {Record<string, string[]>} */
const DOMAINS = {
  semiconductor: SEMICONDUCTOR,
  robotics: ROBOTICS,
  energy: ENERGY,
  aerospace: AEROSPACE,
  medical: MEDICAL,
  industrial: INDUSTRIAL,
};

/**
 * Domain key → the tag `HARDWARE_TAGS` in discover-ats.mjs actually looks for.
 * Five of the six keys are already tags verbatim; "medical" is not — that list
 * carries "medical device" deliberately, to keep telehealth SaaS out. Without
 * this mapping the entire medical-device domain would be filtered out of a
 * list curated for it.
 */
const DOMAIN_TAG = {
  semiconductor: 'semiconductor',
  robotics: 'robotics',
  energy: 'energy',
  aerospace: 'aerospace',
  medical: 'medical device',
  industrial: 'industrial',
};

/**
 * Every curated name, de-duplicated case-insensitively, tagged with its domain
 * so `looksHardware()` in discover-ats.mjs passes it without a network call.
 *
 * Shaped like a `SeedCompany` from vc-portfolios.mjs on purpose: `loadSeeds()`
 * reads `tags`, `industries`, `oneLiner` and `status` off whatever a source
 * returns, and treating this list differently would mean a second code path
 * through the same filter.
 *
 * @param {{ domains?: string[] }} [opts]  Restrict to named domains.
 * @returns {Array<{name: string, slug: string, url: string, source: string, tags: string[], industries: string[], status: string}>}
 */
export function listHardwareStartups({ domains } = {}) {
  const wanted = Array.isArray(domains) && domains.length
    ? domains.map(d => String(d).toLowerCase())
    : Object.keys(DOMAINS);

  const seen = new Set();
  const out = [];
  for (const domain of wanted) {
    const names = DOMAINS[domain];
    if (!names) continue;
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        slug: key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        url: SITES[name] || '',
        source: 'hardware',
        // discover-ats.mjs filters seeds on HARDWARE_TAGS before spending a
        // request. DOMAIN_TAG maps each key to the tag that list actually
        // holds, so a curated name is never filtered out of the list it was
        // curated for.
        tags: [DOMAIN_TAG[domain] || domain],
        industries: [domain],
        status: 'Active',
      });
    }
  }
  return out;
}

/** Domain keys, for callers that want to offer them as a choice. */
export const HARDWARE_DOMAINS = Object.keys(DOMAINS);

/** Matches the `SEED_SOURCES` fetcher contract in vc-portfolios.mjs. */
export async function fetchHardwareStartups(opts = {}) {
  return listHardwareStartups(opts);
}

export default { listHardwareStartups, fetchHardwareStartups, HARDWARE_DOMAINS };
