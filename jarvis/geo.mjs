// jarvis/geo.mjs — decide whether a location string is somewhere Alex can work.
//
// WHY THIS IS ITS OWN MODULE NOW: the previous version of this lived inside
// triage.mjs as a hand-written lexicon of about 150 foreign city names. Every
// country the scanner reached for the first time was a fresh leak, and the leaks
// were found one screenshot at a time — Costa Rica arrived through FOUR separate
// holes at once ("CR - Alajuela", "CRI - Alajuela - El Coyol", "Cartago,
// Cartago", "San José, San José Province,CR, CR"), none of which the lexicon had
// any way to catch. A list of cities cannot be finished. A list of countries can.
//
// So the decision is made from closed sets: every ISO 3166 country name, alpha-2
// and alpha-3 code, every US state name and postal abbreviation. Cities are used
// only as a last resort, and only cities with no US homonym.
//
// TWO RULES GOVERN EVERYTHING BELOW, in this order:
//
//   1. US SIGNALS WIN. A state, "USA", or a US city decides `us` before any
//      country code is considered. This matters because half the alpha-2 codes
//      collide with state abbreviations — CA is California and Canada, IN is
//      Indiana and India, DE is Delaware and Germany, GA is Georgia twice over.
//      Reading "San Jose, CA" as Canada is the failure this ordering prevents.
//
//   2. WHEN IN DOUBT, `unknown` — WHICH MEANS SHOWN. Hiding a job Alex would
//      have applied to is the one unacceptable failure. "Waterloo" is Iowa as
//      often as Ontario, "Vancouver" is Washington, "Berlin" is New Hampshire.
//      Those stay unknown and stay on screen. Only unambiguous evidence moves a
//      posting to `non-us`.

// ── countries ───────────────────────────────────────────────────────
//
// alpha-2, alpha-3, then the name and any alias that actually appears in job
// postings. Names that are ALSO US places are deliberately absent from the name
// column (Georgia, Jordan, Lebanon, Chile, Panama, Cuba, Peru, Denmark, Norway,
// Poland, China as in China, Maine) — those countries are still caught by their
// codes, which are unambiguous in the positions we accept them.

const COUNTRIES = [
  ['AF', 'AFG', 'afghanistan'], ['AL', 'ALB', 'albania'], ['DZ', 'DZA', 'algeria'],
  ['AD', 'AND', 'andorra'], ['AO', 'AGO', 'angola'], ['AG', 'ATG', 'antigua'],
  ['AR', 'ARG', 'argentina'], ['AM', 'ARM', 'armenia'], ['AU', 'AUS', 'australia'],
  ['AT', 'AUT', 'austria', 'osterreich'], ['AZ', 'AZE', 'azerbaijan'], ['BS', 'BHS', 'bahamas'],
  ['BH', 'BHR', 'bahrain'], ['BD', 'BGD', 'bangladesh'], ['BB', 'BRB', 'barbados'],
  ['BY', 'BLR', 'belarus'], ['BE', 'BEL', 'belgium', 'belgique', 'belgie'], ['BZ', 'BLZ', 'belize'],
  ['BJ', 'BEN', 'benin'], ['BT', 'BTN', 'bhutan'], ['BO', 'BOL', 'bolivia'],
  ['BA', 'BIH', 'bosnia', 'bosnia and herzegovina', 'herzegovina'],
  ['BW', 'BWA', 'botswana'], ['BR', 'BRA', 'brazil', 'brasil'],
  ['BN', 'BRN', 'brunei'], ['BG', 'BGR', 'bulgaria'], ['BF', 'BFA', 'burkina faso'],
  ['BI', 'BDI', 'burundi'], ['KH', 'KHM', 'cambodia'], ['CM', 'CMR', 'cameroon'],
  ['CA', 'CAN', 'canada'], ['CV', 'CPV', 'cape verde'],
  ['CF', 'CAF', 'central african republic'], ['TD', 'TCD', 'chad'],
  ['CL', 'CHL', 'chile'], // weak: Chile, NM.
  ['CN', 'CHN', 'china', 'mainland china', "people's republic of china", 'prc'],
  ['CO', 'COL', 'colombia'], ['KM', 'COM', 'comoros'],
  ['CG', 'COG', 'republic of the congo'], ['CD', 'COD', 'democratic republic of the congo'],
  ['CR', 'CRI', 'costa rica'], ['CI', 'CIV', "cote d'ivoire", 'ivory coast'],
  ['HR', 'HRV', 'croatia', 'hrvatska'], ['CY', 'CYP', 'cyprus'],
  ['CU', 'CUB', 'cuba'], // weak: Cuba, NY/MO.
  ['CZ', 'CZE', 'czech republic', 'czechia', 'cesko', 'ceska republika'],
  ['DK', 'DNK', 'denmark', 'danmark'], // weak: Denmark, SC.
  ['DJ', 'DJI', 'djibouti'], ['DM', 'DMA', 'dominica'],
  ['DO', 'DOM', 'dominican republic'], ['EC', 'ECU', 'ecuador'],
  ['EG', 'EGY', 'egypt'], // weak: Egypt, TX.
  ['SV', 'SLV', 'el salvador'], ['GQ', 'GNQ', 'equatorial guinea'],
  ['ER', 'ERI', 'eritrea'], ['EE', 'EST', 'estonia'], ['SZ', 'SWZ', 'eswatini'],
  ['ET', 'ETH', 'ethiopia'], ['FJ', 'FJI', 'fiji'], ['FI', 'FIN', 'finland', 'suomi'],
  ['FR', 'FRA', 'france'], ['GA', 'GAB', 'gabon'], ['GM', 'GMB', 'gambia'],
  ['GE', 'GEO', null], // Georgia the country vs. Georgia the state.
  ['DE', 'DEU', 'germany', 'deutschland'],
  ['GH', 'GHA', 'ghana'], ['GR', 'GRC', 'greece'], ['GD', 'GRD', 'grenada'],
  ['GT', 'GTM', 'guatemala'], ['GN', 'GIN', 'guinea'], ['GW', 'GNB', 'guinea-bissau'],
  ['GY', 'GUY', 'guyana'], ['HT', 'HTI', 'haiti'], ['HN', 'HND', 'honduras'],
  ['HK', 'HKG', 'hong kong'], ['HU', 'HUN', 'hungary', 'magyarorszag'], ['IS', 'ISL', 'iceland'],
  ['IN', 'IND', 'india'], ['ID', 'IDN', 'indonesia'], ['IR', 'IRN', 'iran'],
  ['IQ', 'IRQ', 'iraq'], ['IE', 'IRL', 'ireland'], ['IL', 'ISR', 'israel'],
  ['IT', 'ITA', 'italy', 'italia'], ['JM', 'JAM', 'jamaica'], ['JP', 'JPN', 'japan'],
  ['JO', 'JOR', 'jordan'], // weak: Jordan, MN.
  ['KZ', 'KAZ', 'kazakhstan'], ['KE', 'KEN', 'kenya'], ['KW', 'KWT', 'kuwait'],
  ['KG', 'KGZ', 'kyrgyzstan'], ['LA', 'LAO', null], // LA = Louisiana.
  ['LV', 'LVA', 'latvia'],
  ['LB', 'LBN', 'lebanon'], // weak: Lebanon, PA/OH/TN.
  ['LS', 'LSO', 'lesotho'], ['LR', 'LBR', 'liberia'], ['LY', 'LBY', 'libya'],
  ['LI', 'LIE', 'liechtenstein'], ['LT', 'LTU', 'lithuania'],
  ['LU', 'LUX', 'luxembourg'], ['MG', 'MDG', 'madagascar'], ['MW', 'MWI', 'malawi'],
  ['MY', 'MYS', 'malaysia'], ['MV', 'MDV', 'maldives'], ['ML', 'MLI', 'mali'],
  ['MR', 'MRT', 'mauritania'], ['MU', 'MUS', 'mauritius'],
  ['MT', 'MLT', null], // GlobalFoundries' fab is Malta, NY — the code only.
  ['MX', 'MEX', 'mexico'], // weak: Mexico, MO and Mexico, NY are real.
  ['MD', 'MDA', 'moldova'], ['MC', 'MCO', 'monaco'], ['MN', 'MNG', 'mongolia'],
  ['ME', 'MNE', 'montenegro'], ['MA', 'MAR', 'morocco'], ['MZ', 'MOZ', 'mozambique'],
  ['MM', 'MMR', 'myanmar'], ['NA', 'NAM', 'namibia'], ['NP', 'NPL', 'nepal'],
  // "Nederland" is NOT an alias here: Nederland, TX is real ("Renal Center of
  // Nederland"). It counts after a comma, in FOREIGN_TRAILING_REGION_RE.
  ['NL', 'NLD', 'netherlands', 'holland'], ['NZ', 'NZL', 'new zealand'],
  ['NI', 'NIC', 'nicaragua'], ['NE', 'NER', 'niger'], ['NG', 'NGA', 'nigeria'],
  ['KP', 'PRK', 'north korea'], ['MK', 'MKD', 'north macedonia', 'macedonia'],
  ['NO', 'NOR', 'norway', 'norge'], // weak: Norway, MI.
  ['OM', 'OMN', 'oman'], ['PK', 'PAK', 'pakistan'],
  ['PA', 'PAN', 'panama'], // weak: Panama City, FL.
  ['PG', 'PNG', 'papua new guinea'], ['PY', 'PRY', 'paraguay'],
  ['PE', 'PER', 'peru'], // weak: Peru, IN.
  ['PH', 'PHL', 'philippines'],
  ['PL', 'POL', 'poland', 'polska'], // weak: Poland, OH.
  ['PT', 'PRT', 'portugal'], ['QA', 'QAT', 'qatar'], ['RO', 'ROU', 'romania'],
  ['RU', 'RUS', 'russia', 'russian federation'], ['RW', 'RWA', 'rwanda'],
  ['SA', 'SAU', 'saudi arabia'], ['SN', 'SEN', 'senegal'], ['RS', 'SRB', 'serbia', 'srbija'],
  ['SC', 'SYC', 'seychelles'], ['SL', 'SLE', 'sierra leone'],
  ['SG', 'SGP', 'singapore'], ['SK', 'SVK', 'slovakia'], ['SI', 'SVN', 'slovenia'],
  ['SO', 'SOM', 'somalia'], ['ZA', 'ZAF', 'south africa'],
  ['KR', 'KOR', 'korea', 'south korea', 'republic of korea'], ['SS', 'SSD', 'south sudan'],
  ['ES', 'ESP', 'spain', 'espana'], ['LK', 'LKA', 'sri lanka'],
  ['SD', 'SDN', null], // SD = South Dakota.
  ['SR', 'SUR', 'suriname'],
  ['SE', 'SWE', 'sweden', 'sverige'], // weak: Sweden, ME/NY.
  ['CH', 'CHE', 'switzerland', 'schweiz', 'suisse', 'svizzera'], ['SY', 'SYR', 'syria'],
  ['TW', 'TWN', 'taiwan'], ['TJ', 'TJK', 'tajikistan'], ['TZ', 'TZA', 'tanzania'],
  ['TH', 'THA', 'thailand'], ['TG', 'TGO', 'togo'],
  ['TT', 'TTO', 'trinidad', 'trinidad and tobago'], ['TN', 'TUN', 'tunisia'],
  ['TR', 'TUR', 'turkey', 'turkiye', 'türkiye'], ['TM', 'TKM', 'turkmenistan'],
  ['UG', 'UGA', 'uganda'], ['UA', 'UKR', 'ukraine'],
  ['AE', 'ARE', 'united arab emirates', 'uae'],
  ['GB', 'GBR', 'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'],
  ['UY', 'URY', 'uruguay'], ['UZ', 'UZB', 'uzbekistan'], ['VE', 'VEN', 'venezuela'],
  ['VN', 'VNM', 'vietnam', 'viet nam'], ['YE', 'YEM', 'yemen'],
  ['ZM', 'ZMB', 'zambia'], ['ZW', 'ZWE', 'zimbabwe'],
];

const ISO2_NONUS = new Set(COUNTRIES.map(c => c[0]));
const ISO3_NONUS = new Set(COUNTRIES.map(c => c[1]));

// Country names that ALSO name a US town. They are still worth matching — most
// "China" and "Norway" strings in the store really are the country — but they
// must lose to a state code, so they are tested after it rather than before.
// "Norway, MI" is Michigan; a bare "Lysaker, Norway" is not.
const WEAK_NAMES = new Set([
  'china', 'egypt', 'korea', 'norway', 'denmark', 'sweden', 'poland', 'chile',
  'panama', 'cuba', 'peru', 'jordan', 'lebanon', 'turkey', 'mexico', 'italy',
]);

const buildNameRe = (names) => new RegExp(
  // "New Mexico" is the one name that is a strict superset of a country's, and
  // it is a US state — the negative lookbehind is not optional.
  `(?<!new\\s)\\b(${names
    .sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'i',
);

const allNames = COUNTRIES.flatMap(c => c.slice(2).filter(Boolean));
// Longest first, so "united arab emirates" is tested before any shorter
// substring of it can claim the match.
const STRONG_NAME_RE = buildNameRe(allNames.filter(n => !WEAK_NAMES.has(n)));
const WEAK_NAME_RE = buildNameRe([...WEAK_NAMES]);

// Every country name and alias, mapped to its alpha-2 code. Used by the
// "City, ST" rule below (F-759) to tell "Holland, MI" (a Michigan town that
// shares the Netherlands' nickname) from "Germany, DE" (a country beside its
// own code, which happens to be Delaware's too).
const NAME_TO_ISO2 = new Map(COUNTRIES.flatMap(c => c.slice(2).filter(Boolean).map(n => [n, c[0]])));
const ANY_NAME_RE_G = new RegExp(buildNameRe(allNames).source, 'gi');
// Country names that are ALSO the whole name of a US town, so "<name>, ST" is
// the town: Holland MI/OH, Grenada MS, Macedonia OH, Canada KY, Jamaica NY
// (Queens), Angola IN, Brazil IN, Mexico MO/NY, Peru IN/IL, Poland OH/ME,
// Lebanon PA/OH/NH/TN/IN/MO, Jordan MN, Cuba MO/NY, Denmark WI/SC, Norway ME/MI,
// China ME/TX, Chile NM, Panama OK/IA, Sweden ME, Egypt TX, Turkey NC/TX,
// Italy TX, Wales WI, Scotland CT/SD, England AR, Guinea VA, Togo MN.
const US_TOWN_COUNTRY_NAMES = new Set([
  'holland', 'grenada', 'macedonia', 'canada', 'jamaica', 'angola', 'brazil',
  'mexico', 'peru', 'poland', 'lebanon', 'jordan', 'cuba', 'denmark', 'norway',
  'china', 'chile', 'panama', 'sweden', 'egypt', 'turkey', 'italy', 'wales',
  'scotland', 'england', 'guinea', 'togo',
]);

// ── United States ───────────────────────────────────────────────────

// Postal abbreviations, plus DC and the territories whose residents and
// worksites are inside US work authorisation (a job in San Juan is a US job).
const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', 'GU', 'MP', 'AS',
]);

// "Baja California" is Mexico, and matching the "California" inside it put
// Tijuana, Mexicali and Tecate in the deck as American jobs — the same shape of
// bug as "New Mexico", so it gets the same lookbehind.
const US_STATE_NAMES_RE = /\b(alabama|alaska|arizona|arkansas|(?<!baja )california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|puerto rico)\b/i;

// The "s" is not optional — a lone "U" is not a country, and a pattern that
// allowed one would read any location starting with the letter U as American.
const US_COUNTRY_RE = /\b(u\.?\s?s\.?a?|usa|united states(\s+of\s+america)?|stateside)\b/i;

// US cities that show up in these tenants' location fields with no state
// attached. Every entry here is a place whose name is not also a major foreign
// city — "Cambridge", "Manchester", "Birmingham", "Vancouver" and "Waterloo"
// are deliberately absent and stay `unknown`, which means they stay on screen.
const US_CITY_RE = /\b(seattle|los angeles|pittsburgh|chicago|milwaukee|silicon valley|santa clara|san jose|sunnyvale|milpitas|fremont|folsom|livermore|benicia|pleasanton|santa cruz|san francisco|palo alto|mountain view|menlo park|redwood city|cupertino|hayward|san mateo|emeryville|el segundo|torrance|irvine|carlsbad|oceanside|chula vista|escondido|thousand oaks|simi valley|santa monica|pasadena|burbank|glendale|long beach|anaheim|riverside|bakersfield|sacramento|roseville|rocklin|hillsboro|beaverton|tualatin|wilsonville|gresham|chandler|tempe|mesa|gilbert|glendale az|scottsdale|goodyear|peoria az|phoenix|tucson|boise|meridian|nampa|austin|round rock|pflugerville|georgetown tx|richardson|sherman|plano|allen|frisco|mckinney|garland|irving|carrollton|arlington tx|fort worth|lubbock|amarillo|el paso|corpus christi|san antonio|dallas|houston|katy|sugar land|the woodlands|spring tx|conroe|temple tx|waco|killeen|san diego|poway|vista ca|albuquerque|rio rancho|lehi|orem|provo|sandy ut|draper|ogden|logan ut|salt lake|manassas|chantilly|herndon|reston|ashburn|sterling va|leesburg|fairfax|arlington va|alexandria va|richmond va|virginia beach|newport news|chesapeake|norfolk|essex junction|hopewell junction|fishkill|poughkeepsie|malta ny|kalispell|bozeman|missoula|billings|springfield|everett|redmond|kirkland|bellevue|renton|kent wa|tukwila|olympia|tacoma|bloomington|eden prairie|maple grove|plymouth mn|brooklyn park|shakopee|chaska|rochester mn|st\.? paul|saint paul|minneapolis|memphis|nashville|knoxville|chattanooga|murfreesboro|smyrna|franklin tn|mahwah|parsippany|bridgewater|somerset nj|piscataway|edison nj|princeton|rahway|raritan|branchburg|whippany|andover|billerica|chelmsford|marlborough|hudson ma|wilmington ma|westford|littleton ma|north reading|bedford ma|burlington ma|woburn|lexington ma|waltham|needham|newton ma|framingham|natick|devens|lowell|lawrence ma|haverhill|beverly ma|peabody|danvers|wakefield ma|stoneham|canton ma|norwood|foxborough|attleboro|taunton|fall river|new bedford|plymouth ma|quincy|braintree|weymouth|dedham|watertown ma|somerville|medford ma|malden|revere|chelsea ma|everett ma|charlestown|allston|brighton ma|roxbury|dorchester|jamaica plain|hyde park ma|west roxbury|roslindale|mattapan|brookline|allentown|bethlehem pa|easton pa|reading pa|lancaster pa|harrisburg|york pa|scranton|wilkes-barre|erie pa|altoona|johnstown|state college|malvern|wayne pa|king of prussia|conshohocken|plymouth meeting|blue bell|fort washington|horsham|warminster|doylestown|newtown pa|langhorne|levittown|bensalem|bristol pa|morrisville|yardley|exton|downingtown|west chester pa|kennett square|coatesville|phoenixville|pottstown|collegeville|limerick pa|royersford|spring city|norristown|bridgeport pa|chadds ford|garnet valley|glen mills|media pa|springfield pa|drexel hill|upper darby|havertown|broomall|newtown square|villanova|bryn mawr|ardmore|narberth|merion|gladwyne|villanova pa|radnor|paoli|berwyn|frazer|immokalee|melbourne fl|palm bay|titusville|cocoa|rockledge|merritt island|cape canaveral|kennedy space center|orlando|kissimmee|sanford fl|altamonte springs|winter park|maitland|apopka|ocoee|winter garden|clermont|leesburg fl|tavares|eustis|mount dora|deland|daytona|ormond beach|palm coast|st\.? augustine|jacksonville|gainesville fl|ocala|the villages|tampa|st\.? petersburg|clearwater|largo fl|pinellas park|brandon fl|riverview|lakeland|winter haven|sarasota|bradenton|venice fl|port charlotte|fort myers|naples fl|bonita springs|estero|boca raton|delray beach|boynton beach|west palm beach|jupiter fl|stuart fl|port st\.? lucie|vero beach|fort pierce|okeechobee|belle glade|pahokee|clewiston|labelle|arcadia fl|wauchula|sebring|avon park|lake placid fl|frostproof|bartow|mulberry|plant city|zephyrhills|dade city|wesley chapel|lutz|odessa fl|land o lakes|new port richey|hudson fl|spring hill|brooksville|homosassa|crystal river|inverness|beverly hills fl|dunnellon|williston|chiefland|cedar key|trenton fl|lake city|live oak|jasper fl|madison fl|monticello fl|tallahassee|quincy fl|marianna|chipley|bonifay|defuniak springs|crestview|niceville|fort walton beach|destin|panama city beach|pensacola|milton fl|pace fl|gulf breeze|navarre|santa rosa beach|freeport fl|bloomington il|schaumburg|naperville|aurora il|elgin|joliet|rockford|peoria il|springfield il|champaign|urbana|decatur il|normal il|warsaw indiana|fort wayne|kokomo|lafayette in|west lafayette|elkhart|goshen in|south bend|mishawaka|valparaiso|merrillville|hammond in|gary in|columbus in|greenwood in|carmel in|fishers|noblesville|westfield in|zionsville|avon in|plainfield in|brownsburg|danville in|mooresville in|martinsville in|bloomington in|terre haute|evansville|jeffersonville|new albany|clarksville in|sellersburg|charlestown in)\b/i;

// Foreign cities, for the postings that give a city and nothing else.
//
// A name only belongs here when the foreign reading dominates a BARE mention.
// That bar is lower than it looks, because the explicit-US tier runs first:
// "Paris, TX" and "London, KY" are decided by their state before this list is
// ever consulted, so the big world cities are safe to include. What stays OUT
// is the handful whose US twin is routinely written with no state at all —
// Vancouver (WA), Waterloo (IA), Dublin (CA and OH), Cambridge (MA), Birmingham
// (AL), Ottawa (IL), Berlin (NH), Hamburg (NY), Gloucester (MA). Those stay
// `unknown`, which means they stay on screen.
const FOREIGN_CITY_RE = /\b((?<!new )london|cork|dresden|paris|milan|munich|lisbon|madrid|barcelona|amsterdam|rotterdam|brussels|copenhagen|stockholm|oslo|helsinki|zurich|geneva|vienna|prague|warsaw|budapest|bucharest|istanbul|moscow|kyiv|tokyo|osaka|kyoto|seoul|beijing|shanghai|shenzhen|taipei|bangkok|jakarta|manila|hanoi|mumbai|delhi|new delhi|bengaluru|bangalore|hyderabad|chennai|toronto|montreal|calgary|sydney|melbourne|auckland|singapore|dubai|riyadh|doha|tel aviv|johannesburg|cape town|sao paulo|são paulo|rio de janeiro|manaus|belo horizonte|curitiba|porto alegre|campinas|petropolis|petrópolis|recife|fortaleza|brasilia|brasília|salvador da bahia|guadalajara|monterrey|queretaro|querétaro|tijuana|chihuahua|ciudad juarez|ciudad juárez|mexicali|hermosillo|aguascalientes|san luis potosi|san luis potosí|puebla|toluca|leon guanajuato|nuevo laredo|reynosa|matamoros|ensenada|culiacan|culiacán|merida|mérida|cancun|cancún|bogota|bogotá|medellin|medellín|cali colombia|barranquilla|cartagena|buenos aires|cordoba argentina|córdoba argentina|rosario|mendoza|santiago de chile|valparaiso chile|concepcion chile|lima peru|arequipa|quito|guayaquil|caracas|maracaibo|montevideo|asuncion|asunción|la paz bolivia|santa cruz de la sierra|san salvador|tegucigalpa|managua|ciudad de panama|santo domingo|santiago de los caballeros|alajuela|cartago|heredia|puntarenas|guanacaste|escazu|escazú|belen costa rica|coyol|grecia costa rica|curridabat|riyadh|jeddah|dammam|dhahran|jubail|yanbu|mecca|medina saudi|dubai|abu dhabi|sharjah|ajman|doha|manama|kuwait city|muscat|amman|beirut|baghdad|erbil|tehran|isfahan|karachi|lahore|islamabad|rawalpindi|faisalabad|dhaka|chittagong|colombo|kathmandu|thimphu|bengaluru|bangalore|mumbai|navi mumbai|thane|pune|hyderabad|chennai|kolkata|ahmedabad|surat|jaipur|lucknow|kanpur|nagpur|indore|bhopal|visakhapatnam|vadodara|coimbatore|kochi|thiruvananthapuram|mysuru|mysore|gurgaon|gurugram|noida|greater noida|faridabad|ghaziabad|chandigarh|mohali|ludhiana|amritsar|dehradun|bhubaneswar|ranchi|guwahati|ranjangaon|chakan|talegaon|hinjewadi|whitefield|electronic city|sriperumbudur|oragadam|manesar|neemrana|sanand|halol|pithampur|jamshedpur|hosur|beijing|shanghai|shenzhen|guangzhou|chengdu|chongqing|tianjin|wuhan|hangzhou|nanjing|suzhou|wuxi|xiamen|qingdao|dalian|shenyang|harbin|jinan|zhengzhou|changsha|hefei|kunming|nanchang|fuzhou|ningbo|dongguan|foshan|zhuhai|yantai|weihai|kunshan|yancheng|xi an|xi'an|xian china|taiyuan|shijiazhuang|urumqi|lanzhou|guiyang|nanning|haikou|sanya|langfang|baoding|tangshan|zibo|linyi|luoyang|xuzhou|changzhou|nantong|yangzhou|taizhou|shaoxing|jiaxing|huzhou|jinhua|wenzhou|quanzhou|zhangzhou|putian|ganzhou|jiujiang|yichang|xiangyang|zhuzhou|xiangtan|hengyang|mianyang|deyang|luzhou|nanchong|yibin|zunyi|dali china|lijiang|taipei|new taipei|taoyuan|hsinchu|taichung|tainan|kaohsiung|chiayi|keelung|zhubei|linkou|longtan|zhongli|yangmei|hukou|miaoli|douliu|pingtung|hualien|taitung|yilan|nantou|changhua|yunlin|penghu|kinmen|seoul|busan|incheon|daegu|daejeon|gwangju|ulsan|suwon|seongnam|goyang|yongin|bucheon|ansan|anyang|namyangju|hwaseong|pyeongtaek|siheung|paju|gimpo|gwangmyeong|gunpo|osan|icheon|yangju|cheonan|asan|cheongju|chungju|jeonju|gunsan|iksan|mokpo|yeosu|suncheon|gumi|gyeongju|pohang|changwon|jinju|tongyeong|sacheon|gimhae|yangsan|jeju|tokyo|yokohama|osaka|nagoya|sapporo|fukuoka|kobe|kyoto|kawasaki|saitama|hiroshima|sendai|chiba|kitakyushu|sakai|niigata|hamamatsu|shizuoka|sagamihara|okayama|kumamoto|kagoshima|matsuyama|kanazawa|utsunomiya|matsudo|kawaguchi|ichikawa|toyota city|takatsuki|nara|toyonaka|gifu|hirakata|fujisawa|kashiwa|toyohashi|nagasaki|machida|miyazaki|iwaki|yokkaichi|kitakami|tsukuba|atsugi|isehara|ome|hachioji|kofu|nagano|matsumoto|toyama|fukui|tottori|matsue|yamaguchi|tokushima|takamatsu|kochi japan|saga|oita|singapore city|woodlands singapore|jurong|tuas|changi|kuala lumpur|petaling jaya|shah alam|subang jaya|klang|penang|george town malaysia|bayan lepas|kulim|ipoh|johor bahru|iskandar puteri|melaka|seremban|kuantan|kuching|kota kinabalu|senai|batu kawan|bangkok|chonburi|rayong|ayutthaya|pathum thani|samut prakan|nonthaburi|chiang mai|khon kaen|hat yai|laem chabang|hanoi|ho chi minh|da nang|hai phong|can tho|bien hoa|binh duong|dong nai|bac ninh|thai nguyen|hai duong|vinh phuc|long an|nhon trach|vung tau|nha trang|hue vietnam|jakarta|surabaya|bandung|medan|semarang|makassar|batam|bekasi|tangerang|depok|bogor|cikarang|karawang|cilegon|manila|quezon city|makati|taguig|pasig|cebu|davao|cavite|laguna philippines|batangas|pampanga|clark philippines|baguio|iloilo|cagayan de oro|phnom penh|vientiane|yangon|naypyidaw|dhaka bangladesh|tel aviv|jerusalem|haifa|yokneam|rehovot|petah tikva|herzliya|netanya|beer sheva|kiryat gat|migdal haemek|ramat gan|holon|ashdod|ashkelon|raanana|kfar saba|nazareth|istanbul|ankara|izmir|bursa|antalya|adana|konya|gaziantep|kocaeli|gebze|manisa|kayseri|eskisehir|denizli|samsun|trabzon|sakarya|tekirdag|corlu|cerkezkoy|athens greece|thessaloniki|patras|makerspacelion|nicosia|limassol|sofia|plovdiv|varna|burgas|bucharest|cluj|cluj-napoca|timisoara|timișoara|iasi|iași|brasov|constanta|craiova|oradea|sibiu|arad romania|pitesti|ploiesti|galati|budapest|debrecen|szeged|miskolc|gyor|győr|pecs|kecskemet|szekesfehervar|tatabanya|esztergom|warsaw|krakow|kraków|wroclaw|wrocław|poznan|poznań|gdansk|gdańsk|lodz|łódź|katowice|gliwice|szczecin|bydgoszcz|lublin|bialystok|rzeszow|rzeszów|torun|toruń|kielce|olsztyn|zielona gora|opole|gorzow|plock|walbrzych|legnica|prague|praha|brno|ostrava|plzen|plzeň|pilsen|olomouc|liberec|hradec kralove|ceske budejovice|zlin|pardubice|doudlevce|bratislava|kosice|zilina|nitra|trnava|banska bystrica|ljubljana|maribor|zagreb|split|rijeka|osijek|belgrade|beograd|novi sad|nis|sarajevo|banja luka|skopje|podgorica|tirana|pristina|kyiv|kiev|kharkiv|odesa|dnipro|lviv|zaporizhzhia|vinnytsia|uzhhorod|uzhgorod|ivano-frankivsk|ternopil|chernivtsi|minsk|gomel|vilnius|kaunas|klaipeda|riga|daugavpils|tallinn|tartu|helsinki|espoo|tampere|vantaa|oulu|turku|jyvaskyla|lahti|kuopio|vaasa|salo finland|stockholm|gothenburg|goteborg|göteborg|malmo|malmö|uppsala|linkoping|linköping|vasteras|västerås|orebro|örebro|norrkoping|helsingborg|jonkoping|lund sweden|umea|umeå|gavle|sundsvall|kista|solna|sollentuna|sodertalje|södertälje|oslo|bergen norway|trondheim|stavanger|drammen|kongsberg|horten|copenhagen|kobenhavn|københavn|aarhus|odense|aalborg|esbjerg|roskilde|kolding|horsens|vejle|silkeborg|herning|hillerod|lyngby|ballerup|glostrup|hvidovre|amsterdam|rotterdam|the hague|den haag|utrecht|eindhoven|veldhoven|tilburg|groningen|almere|breda|nijmegen|enschede|apeldoorn|haarlem|arnhem|zaanstad|amersfoort|hertogenbosch|zwolle|leiden|maastricht|dordrecht|ede|leeuwarden|alkmaar|delft|deventer|helmond|oss|hengelo|hilversum|heerlen|venlo|purmerend|roosendaal|schiedam|spijkenisse|vlaardingen|almelo|gouda|zoetermeer|brussels|bruxelles|antwerp|antwerpen|ghent|gent|charleroi|liege|liège|bruges|brugge|namur|leuven|louvain|mons|aalst|mechelen|kortrijk|hasselt|ostend|genk|seraing|roeselare|verviers|mouscron|beveren|dendermonde|sint-niklaas|turnhout|vilvoorde|luxembourg city|esch-sur-alzette|zurich|zürich|geneva|basel|bern|lausanne|winterthur|lucerne|luzern|st gallen|lugano|biel|thun|koniz|la chaux-de-fonds|schaffhausen|fribourg|chur|neuchatel|neuchâtel|uster|sion|emmen|zug|yverdon|dubendorf|dübendorf|vienna|wien|graz|linz|salzburg|innsbruck|klagenfurt|villach|wels|st polten|dornbirn|steyr|wiener neustadt|feldkirch|bregenz|leonding|klosterneuburg|baden austria|wolfsberg|gratkorn|kapfenberg|traun|amstetten|kufstein|schwaz|hallein|braunau|spittal|ternitz|berlin germany|hamburg germany|munich|munchen|münchen|cologne|koln|köln|frankfurt|stuttgart|dusseldorf|düsseldorf|dortmund|essen germany|leipzig|bremen germany|dresden germany|hannover|nuremberg|nurnberg|nürnberg|duisburg|bochum|wuppertal|bielefeld|bonn|munster|münster|karlsruhe|mannheim|augsburg|wiesbaden|gelsenkirchen|monchengladbach|mönchengladbach|braunschweig|chemnitz|kiel germany|aachen|halle saale|magdeburg|freiburg|krefeld|lubeck|lübeck|oberhausen|erfurt|mainz|rostock|kassel|hagen|hamm|saarbrucken|saarbrücken|mulheim|mülheim|potsdam|ludwigshafen|oldenburg|leverkusen|osnabruck|osnabrück|solingen|heidelberg|herne|neuss|darmstadt|paderborn|regensburg|ingolstadt|wurzburg|würzburg|furth|fürth|wolfsburg|offenbach|ulm|heilbronn|pforzheim|gottingen|göttingen|bottrop|trier|recklinghausen|reutlingen|bremerhaven|koblenz|bergisch gladbach|jena|remscheid|erlangen|moers|siegen|hildesheim|salzgitter|itzehoe|freiberg|jettingen|scheppach|heimstetten|garching|unterschleissheim|ismaning|taufkirchen|neubiberg|holzkirchen|penzberg|rosenheim|landshut|passau|bayreuth|bamberg|schweinfurt|aschaffenburg|kempten|memmingen|neu-ulm|friedrichshafen|ravensburg|konstanz|villingen|tuttlingen|sindelfingen|boblingen|böblingen|esslingen|ludwigsburg|waiblingen|schorndorf|goppingen|göppingen|aalen|schwabisch gmund|nagold|calw|bruchsal|bretten|rastatt|baden-baden|offenburg|lahr|emmendingen|lorrach|lörrach|weil am rhein|paris france|marseille|lyon|toulouse|nice france|nantes|montpellier|strasbourg|bordeaux|lille|rennes|reims|le havre|saint-etienne|toulon|grenoble|dijon|angers|nimes|nîmes|villeurbanne|clermont-ferrand|le mans|aix-en-provence|brest france|tours france|amiens|limoges|annecy|perpignan|besancon|besançon|metz|orleans|orléans|rouen|mulhouse|caen|nancy|argenteuil|montreuil|saint-denis|roubaix|tourcoing|avignon|nanterre|poitiers|creteil|créteil|versailles|courbevoie|colombes|asnieres|rueil-malmaison|antibes|la rochelle|calais|cannes|beziers|béziers|bourges|colmar|valence france|quimper|merignac|mérignac|antony|troyes|neuilly|sarcelles|issy-les-moulineaux|le blanc-mesnil|pessac|ivry-sur-seine|cergy|clichy|levallois|noisy-le-grand|villejuif|epinay|saint-maur|sartrouville|maisons-alfort|evry|évry|meaux|chelles|corbeil|bobigny|fontenay-sous-bois|vincennes|clamart|massy|palaiseau|orsay|saclay|guyancourt|montigny-le-bretonneux|elancourt|trappes|plaisir|mantes-la-jolie|poissy|conflans|herblay|franconville|ermont|eaubonne|gonesse|garges|stains|aubervilliers|pantin|bagnolet|romainville|drancy|dugny|tremblay|villepinte|aulnay-sous-bois|sevran|livry-gargan|clichy-sous-bois|montfermeil|gagny|rosny-sous-bois|neuilly-plaisance|nogent-sur-marne|joinville|charenton|alfortville|vitry-sur-seine|choisy-le-roi|orly|thiais|rungis|chevilly|fresnes|antony france|bourg-la-reine|sceaux|chatenay-malabry|robinson|milan italy|milano|rome italy|roma|naples italy|napoli|turin|torino|palermo|genoa|genova|bologna|florence italy|firenze|bari|catania|venice italy|venezia|verona|messina|padua|padova|trieste|brescia|prato|taranto|modena|reggio emilia|reggio calabria|perugia|ravenna|livorno|cagliari|foggia|rimini|salerno|ferrara|sassari|latina|giugliano|monza|siracusa|pescara|bergamo|forli|forlì|trento|vicenza|terni|bolzano|novara|piacenza|ancona|andria|arezzo|udine|cesena|lecce|pesaro|barletta|alessandria|la spezia|pisa|catanzaro|pistoia|guidonia|lucca|brindisi|torre del greco|treviso|busto arsizio|como|marsala|grosseto|varese|sesto san giovanni|casoria|asti|cinisello balsamo|caserta|gela|aprilia|ragusa|pavia|cremona|carpi|quartu|lamezia|altamura|imola|massa|trapani|viterbo|cosenza|potenza|castellammare|afragola|vittoria|crotone|pomezia|aversa|matera|molfetta|savona|benevento|gallarate|olbia|agrigento|madrid spain|barcelona|valencia spain|seville|sevilla|zaragoza|malaga|málaga|murcia|palma|las palmas|bilbao|alicante|cordoba spain|córdoba spain|valladolid|vigo|gijon|gijón|hospitalet|vitoria|granada|elche|oviedo|badalona|cartagena spain|terrassa|jerez|sabadell|santa coloma|pamplona|almeria|almería|san sebastian|donostia|leganes|leganés|burgos|santander|castellon|castellón|getafe|albacete|alcorcon|alcorcón|logrono|logroño|badajoz|salamanca|huelva|marbella|lleida|tarragona|leon spain|cadiz|cádiz|dos hermanas|mataro|mataró|torrejon|parla|alcala de henares|fuenlabrada|mostoles|móstoles|reus|girona|manresa|rubi|rubí|viladecans|sant cugat|el prat|lisbon|lisboa|porto|braga|coimbra|funchal|setubal|setúbal|almada|agualva|queluz|guimaraes|guimarães|aveiro|leiria|matosinhos|maia portugal|amadora|odivelas|barreiro|evora|évora|faro portugal|viseu|povoa|santarem|santarém|torres vedras|caldas da rainha|vila nova de gaia|dublin ireland|cork ireland|limerick|galway|waterford ireland|drogheda|dundalk|swords|bray|navan|kilkenny|leixlip|shannon ireland|athlone|maynooth|carlow|tralee|clonmel|wexford|sligo|ennis|cavan|mullingar|tullamore|killarney|toronto|montreal|montréal|vancouver bc|calgary|edmonton|ottawa ontario|winnipeg|quebec city|québec|hamilton ontario|kitchener|waterloo ontario|london ontario|victoria bc|halifax|oshawa|windsor ontario|saskatoon|regina saskatchewan|st catharines|sherbrooke|kelowna|barrie|guelph|kanata|abbotsford|trois-rivieres|kingston ontario|milton ontario|moncton|nanaimo|brantford|saguenay|peterborough ontario|chilliwack|red deer|lethbridge|kamloops|prince george|medicine hat|drummondville|saint john|fredericton|granby|belleville ontario|north bay|cornwall ontario|joliette|victoriaville|shawinigan|rimouski|sorel|thunder bay|woodstock ontario|brandon manitoba|mississauga|brampton|markham|vaughan|richmond hill|oakville|burlington ontario|scarborough|etobicoke|north york|laval|longueuil|gatineau|levis|lévis|terrebonne|brossard|repentigny|saint-jerome|blainville|mirabel|dollard|pointe-claire|dorval|kirkland quebec|beaconsfield|la prairie|boucherville|saint-bruno|varennes|candiac|chambly|mascouche|vaudreuil|salaberry|granby quebec|magog|sydney|sydney australia|melbourne australia|brisbane|perth australia|adelaide|gold coast|newcastle australia|canberra|wollongong|geelong|hobart|townsville|cairns|toowoomba|darwin|ballarat|bendigo|launceston|mackay|rockhampton|bunbury|bundaberg|wagga wagga|auckland|wellington nz|christchurch|hamilton nz|tauranga|dunedin|palmerston north|napier|nelson nz|rotorua|whangarei|invercargill|johannesburg|cape town|durban|pretoria|port elizabeth|bloemfontein|east london south africa|nairobi|mombasa|lagos|abuja|accra|kumasi|dakar|abidjan|casablanca|rabat|marrakech|tangier|tunis|algiers|oran|cairo egypt|alexandria egypt|giza|luxor|aswan|khartoum|addis ababa|kampala|dar es salaam|kigali|lusaka|harare|gaborone|windhoek|maputo|luanda)\b/i;

// Twenty-one US postal abbreviations are ALSO ISO-3166 alpha-2 country codes,
// and that overlap is the single hardest thing in this file: "Bangalore, IN" is
// India, "Dresden, TN" is Tennessee, and nothing about their SHAPE tells them
// apart — both are "City, XX".
//
// What tells them apart is whether the city is actually IN that country.
// Dresden is a German city, not a Tunisian one, so "Dresden, TN" cannot be
// Tunisia and TN is read as Tennessee. Bangalore is an Indian city, so
// "Bangalore, IN" is India and not Indiana.
//
// This replaces an earlier rule that tried to read the answer off the
// punctuation — the canonical American "City, ST" form outranks the country —
// which necessarily got "Bangalore, IN" wrong, and got "Bangalore, KA, IN"
// wrong too because a trailing ", IN" looks canonical whatever precedes it.
// Structure could never answer this question; geography can.
//
// Only the colliding codes need an entry, and only with cities big enough to
// appear in a location field. Anything not listed falls through to the US
// reading, which is the safe direction: a US job is never hidden.
const COLLIDING_COUNTRY_CITIES = {
  IN: /\b(mumbai|navi mumbai|thane|new delhi|delhi|bengaluru|bangalore|hyderabad|chennai|kolkata|ahmedabad|surat|jaipur|lucknow|kanpur|nagpur|indore|bhopal|visakhapatnam|vadodara|coimbatore|kochi|thiruvananthapuram|trivandrum|mysuru|mysore|gurgaon|gurugram|noida|greater noida|faridabad|ghaziabad|chandigarh|mohali|ludhiana|amritsar|dehradun|bhubaneswar|ranchi|guwahati|pune|hosur|manesar|sanand|halol|pithampur|jamshedpur|sriperumbudur|oragadam|whitefield|electronic city|hinjewadi|chakan|talegaon|ranjangaon|neemrana)\b/,
  CA: /\b(toronto|montreal|vancouver|calgary|edmonton|ottawa|winnipeg|quebec|kitchener|halifax|mississauga|brampton|markham|vaughan|richmond hill|oakville|scarborough|etobicoke|north york|laval|longueuil|gatineau|saskatoon|regina|kelowna|barrie|guelph|kanata|abbotsford|moncton|nanaimo|brantford|thunder bay|sherbrooke|trois rivieres)\b/,
  DE: /\b(berlin|hamburg|munich|munchen|cologne|koln|frankfurt|stuttgart|dusseldorf|dortmund|essen|leipzig|bremen|dresden|hannover|nuremberg|nurnberg|duisburg|bochum|wuppertal|bielefeld|bonn|munster|karlsruhe|mannheim|augsburg|wiesbaden|braunschweig|chemnitz|aachen|magdeburg|freiburg|krefeld|lubeck|erfurt|mainz|rostock|kassel|potsdam|heidelberg|darmstadt|regensburg|ingolstadt|ulm|erlangen|jena|garching|sindelfingen|boblingen|esslingen|ludwigsburg|kiel|kempten|nuernberg|muenchen|koeln|lindau|weimar|bergkamen|dormagen|monheim|eschweiler|unna|fellbach|ennepetal|glinde|warstein)\b/,
  IL: /\b(tel aviv|jerusalem|haifa|yokneam|rehovot|petah tikva|herzliya|netanya|beer sheva|kiryat gat|migdal haemek|ramat gan|holon|ashdod|ashkelon|raanana|kfar saba|nazareth)\b/,
  ID: /\b(jakarta|surabaya|bandung|medan|semarang|makassar|batam|bekasi|tangerang|depok|bogor|cikarang|karawang|cilegon)\b/,
  AR: /\b(buenos aires|cordoba argentina|rosario|mendoza)\b/,
  CO: /\b(bogota|medellin|cali colombia|barranquilla|cartagena)\b/,
  MA: /\b(casablanca|rabat|marrakech|tangier)\b/,
  PA: /\b(ciudad de panama|panama city)\b/,
  // TN is also Tamil Nadu, which Indian tenants write exactly like a state:
  // "Chennai, TN" was 76 rows in the US bucket. Dresden, TN and Paris, TN are
  // not on this list and stay in Tennessee.
  TN: /\b(tunis|sfax|chennai|coimbatore|hosur|sriperumbudur|oragadam|madurai|tiruchirappalli|trichy|tirupur|vellore|padappai|ambattur|guindy|siruseri|kanchipuram)\b/,
  // More Indian state codes that are US ones too: Assam, Odisha (formerly
  // Orissa, OR), Madhya Pradesh, Goa. And NH is Noord-Holland: "Amsterdam, NH"
  // and "Hilversum, NH" are Dutch, while Amsterdam, NY stays American.
  AS: /\b(guwahati|dibrugarh|silchar)\b/,
  OR: /\b(bhubaneswar|cuttack|rourkela)\b/,
  MP: /\b(indore|bhopal|pithampur|jabalpur|gwalior)\b/,
  NH: /\b(amsterdam|hilversum|haarlem|alkmaar|zaandam|hoofddorp|schiphol|amstelveen|purmerend|den helder|velsen|ijmuiden)\b/,
  SD: /\b(khartoum)\b/,
  ME: /\b(podgorica)\b/,
  AL: /\b(tirana)\b/,
  MD: /\b(chisinau)\b/,
  MT: /\b(valletta)\b/,
  MN: /\b(ulaanbaatar)\b/,
  NE: /\b(niamey)\b/,
  GA: /\b(libreville|port gentil|panaji|panjim|margao|vasco da gama)\b/,
  SC: /\b(victoria seychelles)\b/,
  VA: /\b(vatican)\b/,
  NC: /\b(noumea)\b/,
};

// Placeholder location fields — a Workday tenant that lists a req at several
// sites writes "3 Locations" and nothing else. That is genuinely unknown, and
// unknown means shown.
const PLACEHOLDER_RE = /^\s*(\d+\s+locations?|multiple\s+locations?|various(\s+locations?)?|several\s+locations?|see\s+(job\s+)?description|n\/?a|tbd|-|—)\s*$/i;

/**
 * German-, Austrian- and Swiss-law gender notation in a job title —
 * "(f/m/d)", "(m/w/d)", "(f/m/x)" — plus the French "(h/f)".
 *
 * This is a legal requirement in those jurisdictions and is never used on a US
 * posting, which makes it one of the most reliable location signals available.
 * It matters because these postings arrive with a location of "2 Locations",
 * which is a placeholder, so they bucketed as `unknown` — and `unknown` is
 * admitted to the deck on purpose, so a missing location never hides a US job.
 * 217 European reqs were sitting in the deck on the strength of that.
 */
const EURO_TITLE_RE = /\((?:[fmwdxh]\s*\/\s*){1,2}[fmwdxh]\)|\bm\s*\/\s*w\s*\/\s*d\b|\(all\s+genders?\)/i;

/**
 * Foreign towns that were actually sitting in his deck, bucketed `unknown`.
 *
 * Found by listing every distinct unknown-bucket location in the visible deck
 * rather than by guessing at name patterns — a heuristic on connective
 * particles ("di", "de", "du") reads Fond du Lac and Prairie du Chien as
 * French, and hiding a US job is the expensive error.
 *
 * Deliberately NOT here: Gloucester, Greenville, Stafford, Bangor, Dublin,
 * Albany, Ottawa and Baja, which all have US twins and stay `unknown`; and
 * "Hampshire", because New Hampshire.
 */
const FOREIGN_TOWN_RE = /\b(noventa di piave|cassina de pecchi|taubate|taubaté|itajuba|itajubá|tres rios|três rios|dzierzoniow|dzierżoniów|kwidzyn|elblag|elbląg|bromont|westmount|aix[ -]les[ -]bains|belfort|veresegyhaz|veresegyház|pallavaram|haina|san cristobal|san cristóbal|villeneuve[ -]sur[ -]lot|boulogne[ -]billancourt|quebec|québec|kirkkonummi|feldkirchen|agrate brianza|bernin|roznov|tiszaujvaros|ashalim|castlebar|harley street|marsa malta|pattaya|chuping|pasir gudang|taicang|wujiang|zhongshan|chitose|shonai|yamanashi|hitachi naka|hitachinaka|central luzon|king abdullah economic city|tyne[ -]and[ -]wear|pengerang|sungai petani|southampton hampshire)\b/i;

/**
 * Foreign cities that arrive with no country and were bucketed `unknown`, which
 * kept them in the deck among US postings (F-764: PwC "Cairo - ETIC", PwC
 * "Warszawa", BlackRock "Edinburgh"). Taken from the distinct unknown-bucket
 * locations in the store on 2026-10-18 plus the native spellings tenants use.
 *
 * Written in FLATTENED form (lowercase, no accents, hyphen and apostrophe as a
 * space) because that is what it is tested against.
 *
 * The same bar as FOREIGN_CITY_RE: the foreign reading has to dominate a BARE
 * mention, and a stated US state is decided before this list is read ("Cairo,
 * GA", "Glasgow, KY", "Leeds, AL" stay American). Deliberately NOT here, because
 * a US twin is written bare often enough to hide a real job: Liverpool (NY),
 * Rome (NY/GA), Parma (OH/MI), Lima (OH), Valencia (CA), Victoria (TX), Warwick
 * (RI), Warrington (PA), Swansea (SC/MA), Bristol, Derby, Durham, Reading,
 * Norwich, Portsmouth, Waterford, Cheltenham, Coventry, Baden, Cali, Guadalupe,
 * Rio Bravo, Sussex, Aberdeen.
 *
 * This list decides BARE mentions only. It is not consulted beside a state
 * code: "Sales Supervisor, Leeds, AL" is Alabama, whatever Leeds is on its own.
 */
const FOREIGN_CITY_EXTRA_RE = /\b(cairo|new cairo|el tagamoa|warszawa|bucuresti|geneve|genf|athina|moskva|edinburgh|glasgow|belfast|leeds|crawley|rugby|nottingham|cardiff(?! by)|solihull|sheffield(?! village| lake)|leicester|stevenage|swindon|farnborough|basingstoke|guildford|bracknell|slough|milton keynes|luton|wolverhampton|stoke on trent|newcastle upon tyne|sunderland|middlesbrough|dundee|wrexham|welwyn|filton|cheadle|loughborough|eastleigh|havant|burgess hill|heanor|templecombe|farringdon|uxbridge|heathrow|hemel hempstead|harlow|droitwich|tewkesbury|surrey|perth(?! amboy)|goettingen|muenchen|koeln|duesseldorf|nuernberg|zuerich|den bosch|s hertogenbosch|rijswijk|veghel|geleen|boxmeer|roermond|lichtenvoorde|rijssen|kaiseraugst|visp|rotkreuz|zofingen|evionnaz|schaftenau|kundl|velizy|villacoublay|limours|gennevilliers|cholet|meudon|marcy l etoile|colomiers|tarbes|cornebarrieu|marignane|suresnes|sophia antipolis|montbonnot|gemenos|douvrin|chatellerault|huningue|val de reuil|brive la gaillarde|cahors|bourogne|etaples|le haillan|montoir de bretagne|noisy le sec|ambares|etrelles|alcobendas|zamudio|martos|el masnou|monselice|montecchio maggiore|herstal|puurs|kontich|geel|wommelgem|tubize|grace hollogne|bornem|skawina|zielonka|czechowice|chrzanow|zabki|rakovnik|usti nad labem|potvorice|veszprem|mateszalka|nyiregyhaza|menges|voluntari|targu mures|bagsvaerd|horsholm|molndal|segeltorp|upplands vasby|guxhagen|nordenham|weinheim|kharkov|sanchong|xinzhuang|yixing|jiangyin|nansha|huiyang|qingzhou|changzhi|nanxun|toranomon|chiyoda|kwun tong|taikoo|cyberjaya|putrajaya|batu caves|nilai|gelang patah|subang|cabuyao|sikhiu|toa payoh|bulim|songdo|almaty|trivandrum|chhatrapati sambhaji nagar|padappai|savli|morinda|gandhinagar|taleigao|turbhe|santiago|juarez|cajamar|jundiai|barueri|varginha|sorocaba|valinhos|guarulhos|londrina|betim|sao bernardo do campo|araucaria|insurgentes|miguel hidalgo|apodaca|piedras negras|cuautitlan|huixquilucan|ocoyoacac|matehuala|torreon|sandton|richards bay|conakry|rydalmere|parramatta|benalla|mulwala|fortitude valley|boisbriand|lachine|saint eustache|baie d urfe|labrador city|la pocatiere)\b/;

/**
 * Provinces, states and regions of other countries. None is a US place name,
 * and each is decisive wherever it appears: "Chennai, Tamil Nadu", "Red Hill,
 * Queensland", "Cali, Valle del Cauca".
 */
const FOREIGN_REGION_RE = /\b(cairo governorate|giza governorate|al qahirah|british columbia|maharashtra|karnataka|telangana|tamil nadu|gujarat|uttar pradesh|haryana|kerala|andhra pradesh|west bengal|madhya pradesh|rajasthan|punjab|odisha|uttarakhand|queensland|new south wales|nsw|qld|western australia|tasmania|nuevo leon|coahuila|jalisco|guanajuato|tamaulipas|estado de mexico|edomex|cdmx|valle del cauca|selangor|johor|kanagawa|aichi|hokkaido|guangdong|jiangsu|zhejiang|shandong|shaanxi|sichuan|hubei|henan|anhui|fujian|liaoning|shanxi|hebei|gyeonggi|bavaria|bayern|baden wurttemberg|nordrhein westfalen|north rhine westphalia|niedersachsen|hessen|thuringen|lombardia|lombardy|piemonte|veneto|emilia romagna|catalonia|cataluna|andalucia|ile de france|occitanie|normandie|bretagne|overijssel|noord brabant|gelderland|zuid holland|noord holland)\b/;

/**
 * Regions whose name is ALSO a US place when it leads the string — Ontario, CA
 * and Ontario, OR are real cities, New Brunswick is in New Jersey, Berkshire is
 * a Massachusetts county — so these count only AFTER the first comma, where
 * they are the region of the city before them: "Alliston, Ontario", "Reading,
 * Berkshire", "Moncton, New Brunswick".
 */
const FOREIGN_TRAILING_REGION_RE = /\b(nederland|ontario|quebec|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|berkshire|wiltshire|lancashire|worcestershire|hertfordshire|oxfordshire|gloucestershire|west yorkshire|greater manchester|west midlands|merseyside|derbyshire|nottinghamshire|leicestershire|warwickshire|staffordshire|cambridgeshire|buckinghamshire|county antrim|county cork|county dublin|county galway)\b/;

// Canadian province and territory postal codes. None is a US state code, so a
// comma part that is exactly one of them is Canada: "Ottawa, ON", "Mount
// Royal, QC", "Saint-Bruno, QC, CA" (182 rows read as California before F-764),
// "CA - Woodbridge, ON".
const CA_PROVINCE_CODES = new Set(['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'NT', 'YT', 'NU']);

// Country codes seen leading a location as "XX - City". None is a US state code.
// Left out on purpose, because the same two capitals lead US sites or job
// titles: PH ("PH - Philadelphia"), LV ("LV - Henderson"), IT ("IT — Service
// Desk Analyst"), HR, SE (Sales Engineer), EE, PT, AT, SA, GN.
const SPACED_LEAD_CODES = new Set([
  'CH', 'NL', 'FR', 'CN', 'PL', 'BE', 'ES', 'GB', 'UK', 'IE', 'CZ', 'HU', 'SK',
  'DK', 'FI', 'NO', 'RO', 'BG', 'SI', 'RS', 'GR', 'TR', 'JP', 'KR', 'TW', 'SG',
  'MY', 'TH', 'VN', 'MX', 'BR', 'CL', 'LT', 'LU', 'ZA', 'AU', 'NZ',
]);

/**
 * The gazetteers above are tested against FLATTENED text (hyphens and
 * apostrophes become spaces, accents are folded), but many of their entries were
 * written hyphenated or accented — "vitry-sur-seine", "issy-les-moulineaux",
 * "saint-etienne", "wilkes-barre" — and so could never match anything. This
 * rewrites a pattern into the same flattened alphabet as its input.
 */
function flatRe(re) {
  const src = re.source.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[-']/g, ' ');
  return new RegExp(src, re.flags);
}
const US_CITY_FLAT_RE = flatRe(US_CITY_RE);
const FOREIGN_CITY_FLAT_RE = flatRe(FOREIGN_CITY_RE);
const FOREIGN_TOWN_FLAT_RE = flatRe(FOREIGN_TOWN_RE);

const REMOTE_RE = /\b(remote|work\s+from\s+home|wfh|virtual|telecommute|distributed|anywhere)\b/i;
const US_REMOTE_RE = /\b(us|usa|u\.s\.|united states|domestic|nationwide|national)\b/i;

/** Fold diacritics so "São Paulo" and "Sao Paulo" are the same string. */
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Punctuation-free lowercase form, for matching multi-word place names.
 *
 * Tenants write the same place a dozen ways — "Ottawa, Ontario", "Ottawa -
 * Ontario", "Ottawa/Ontario". Flattening every separator to a single space is
 * what lets one entry in the gazetteer cover all of them, and it is why bare
 * "Ottawa" (which is also Illinois, Kansas and Ohio) can stay out of the
 * gazetteer while "Ottawa Ontario" is caught.
 */
function flatten(s) {
  return fold(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokensOf(seg) {
  return fold(seg).toUpperCase().split(/[^A-Z]+/).filter(Boolean);
}

/**
 * An EXPLICIT US marker: the country itself, or a state by name or postal code.
 *
 * This is the strongest signal there is and it is tested before anything else,
 * because most alpha-2 country codes collide with state abbreviations — CA is
 * California and Canada, IN is Indiana and India, DE is Delaware and Germany.
 * Reading "San Jose, CA" as Canada is the failure this ordering exists to stop.
 */
function explicitUs(seg) {
  const flat = flatten(seg);
  if (US_COUNTRY_RE.test(flat)) return true;
  if (US_STATE_NAMES_RE.test(flat)) return true;
  for (const t of tokensOf(seg)) if (t === 'USA') return true;
  return false;
}

/**
 * A two-letter state code, but only where a location string actually puts one.
 *
 * Accepting the bare token anywhere is not safe: "San Antonio de Belen, Costa
 * Rica" contains "de", and reading that as Delaware put a Costa Rican posting
 * in the deck — the same failure this module was written to end, arriving from
 * the opposite direction. A state code has to be trailing ("Austin TX"), joined
 * to the country ("Boise, ID,US"), delimited ("US-CO-Frederick", "CA - San
 * Jose"), or followed by a ZIP ("Billerica MA 01821").
 */
// Returns the matched state code, or null — the caller needs to know WHICH,
// because a code that doubles as a country code ("IN", "DE") is treated with
// more suspicion than one that does not ("OH", "WI").
function stateCodeSignal(seg) {
  const src = fold(seg);
  const tokens = tokensOf(seg);
  // CASE MATTERS. Location fields capitalise state codes; a lowercase "de"
  // is the French preposition. Without this, "Le Pont-de-Claix, Auvergne-
  // Rhône-Alpes, France" read as Delaware and 454 French postings landed in
  // the deck as American ones.
  const cased = (t) => new RegExp(`(^|[^A-Za-z])${t[0]}${t[1]}(?![a-z])`).test(src)
    || new RegExp(`(^|[^A-Za-z])${t[0]}${t[1].toLowerCase()}(?![a-z])`).test(src);
  // The TRAILING code first. Read left to right, "La Palma, CA" found the
  // title-cased "La" (Louisiana, and Laos) before the CA at the end, and the
  // Laos reading then sent a California job abroad; "Pithampur, MP, IN" found
  // MP (Madhya Pradesh, read as the Northern Mariana Islands) before the IN
  // that the India city table resolves. The code a string ENDS on is the one
  // its writer meant as the state or country.
  const last = tokens[tokens.length - 1];
  if (last && last.length === 2 && US_STATE_CODES.has(last) && cased(last)) return last;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length !== 2 || !US_STATE_CODES.has(t)) continue;
    if (!cased(t)) continue;
    if (i === tokens.length - 1) return t;
    // Before the end, only in capitals: "La Piedad" (Bosch, Mexico) is a
    // Spanish article, not Louisiana; "LA - Baton Rouge" is the state.
    if (!new RegExp(`(^|[^A-Za-z])${t}(?![A-Za-z])`).test(src)) continue;
    const next = tokens[i + 1];
    if (next === 'US' || next === 'USA') return t;
    if (new RegExp(`(^|[,\\-–—/(])\\s*${t}\\s*($|[^A-Za-z])`).test(src.toUpperCase())) return t;
  }
  return null;
}

/**
 * An EXPLICIT foreign country: a country name, an alpha-3 code, or an alpha-2
 * code in one of the two positions where tenants use it as a country.
 *
 * Ranked below explicitUs and above the city gazetteers, which is what makes
 * "Costa Rica, San Jose" read as Costa Rica while "USA - Turkey Creek, NC"
 * stays American.
 */
function explicitForeign(seg) {
  if (STRONG_NAME_RE.test(flatten(seg))) return true;
  return positionalIso3(seg) || positionalIso2(seg) || provinceCode(seg);
}

/**
 * A comma part after the first that is a Canadian province code: exactly
 * ("Ottawa, ON"), or followed by a site name the way Air Liquide writes it
 * ("Bonnyville, AB - 50 Ave (Lakeland)", "Maitland, ON (N2O) (I)") (F-1042).
 */
function provinceCode(seg) {
  return commaParts(seg).slice(1).some(p => {
    const m = /^([A-Z]{2})(?:\s*[-–—(]|$)/.exec(p);
    return !!m && CA_PROVINCE_CODES.has(m[1]);
  });
}

function commaParts(seg) {
  return fold(seg).split(',').map(p => p.trim()).filter(Boolean);
}

/**
 * Trailing postal codes that are not American: UK ("LS19 6JY"), Canadian
 * ("K2K 3G4"), Dutch ("1082 VA") and Irish Eircodes ("F26 F3X5"). They sit
 * after the country code and hide it — "Leeds, GB, LS19 6JY" ended on the token
 * "JY", so its GB was never in the trailing position the country test reads,
 * and "Amsterdam, NH, NL, 1082 VA" ended on VA, which is Virginia. A US
 * "TX 78701" matches none of these shapes.
 */
const FOREIGN_POSTCODE_RE = /^(?:[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{4}\s?[A-Z]{2}|[A-Z]\d{2}\s?[A-Z\d]{4})$/i;
function stripPostcode(seg) {
  const parts = String(seg).split(',');
  while (parts.length > 1 && FOREIGN_POSTCODE_RE.test(parts[parts.length - 1].trim())) parts.pop();
  return parts.join(',');
}

/**
 * The canonical American address — "Holland, MI", "Grenada, MS 38901" — whose
 * only foreign evidence is a country NAME inside the city part (F-759).
 *
 * Holland (MI, OH), Grenada (MS), Macedonia (OH), Canada (KY), Jamaica (NY),
 * Mexico (MO), South Holland (IL): a trailing state code after a comma says
 * where the town is, and the country tier used to outrank it, so CONVERGIX,
 * LG Energy Solution, Yanfeng, Lennox and Amphenol were filed as foreign and no
 * screen, view or curation pass served them.
 *
 * The state wins only when nothing else on the line is foreign: every middle
 * part must be free of a country ("Perth, AU, Australia, WA", "Bangalore,
 * India, IN" stay abroad; a street line like "2008 India St." is skipped), and
 * the country named in the city part must not be the one whose own code ends
 * the line — "Germany, DE", "India, IN", "Panama City, PA" name a country and
 * then its code, which happens to be a state's as well.
 */
function usStateAddress(seg) {
  const parts = commaParts(seg);
  if (parts.length < 2) return false;
  const m = /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(parts[parts.length - 1]);
  if (!m || !US_STATE_CODES.has(m[1])) return false;
  const code = m[1];
  const middle = parts.slice(1, -1).filter(p => !/^\d+\s/.test(p));
  if (middle.some(p => CA_PROVINCE_CODES.has(p) || explicitForeign(p))) return false;
  if (positionalIso3(parts[0])) return false;
  // A city part that is NOTHING but a country name is that country unless the
  // name is also a real US town: "Holland, MI" and "Angola, IN" are towns,
  // "Australia, WA" is Western Australia.
  const city = flatten(parts[0]);
  if (NAME_TO_ISO2.has(city) && !US_TOWN_COUNTRY_NAMES.has(city)) return false;
  for (const hit of city.matchAll(ANY_NAME_RE_G)) {
    if (NAME_TO_ISO2.get(hit[1].toLowerCase()) === code) return false;
  }
  return true;
}

/**
 * The ISO-3 codes that are also ordinary English words.
 *
 * This set is the whole problem. "No US state abbreviation is three letters"
 * was true and beside the point: scanning every three-letter token for a
 * country code read "Research and Development Engineer" as Andorra, "Del Mar,
 * CA" as Morocco and "Cape Cod, MA" as the Congo. A job with no location field
 * is classified from its TITLE, and "and" appears in a large share of
 * engineering titles, so that quietly filtered a whole category out of the deck.
 *
 * The words listed are the ones that plausibly appear in an English job title
 * or a US address — including the ones this domain is full of: ARM and FIN and
 * TON and VAT and LUX are mechanical vocabulary before they are Armenia,
 * Finland, Tonga, the Vatican and Luxembourg.
 */
const AMBIGUOUS_ISO3 = new Set([
  'AND', 'ARE', 'CAN', 'COD', 'COM', 'PAN', 'PER', 'MAR', 'TON', 'ARM', 'FIN',
  'JAM', 'MAC', 'GUY', 'KEN', 'BEN', 'CUB', 'NAM', 'SUR', 'VAT', 'DOM', 'GIN',
  'LAO', 'SOM', 'AGO', 'ALB', 'BRA', 'VEN', 'ISL', 'HUN', 'NIC', 'TUN', 'TUR',
  'COL', 'LUX', 'EST',
  // "Ind" is India's alpha-3 and the traditional abbreviation for Indiana,
  // which is a real US state with real manufacturing jobs. Added when
  // title-case codes started being accepted below.
  'IND',
]);

/**
 * An alpha-3 country code, guarded by how much the code itself can be trusted.
 *
 *   an English word (AND, MAR, COD…) — must be BOTH in a country-code position
 *     (leading or trailing) AND written in capitals. Both, because "Cape Cod"
 *     puts one at the end of the string and "Del Mar" does too.
 *   anything else (PRT, DEU, MEX, CRI…) — either is enough. These cannot be
 *     confused with prose, and demanding position as well was too strict: it
 *     lost FedEx's European sites, which bury the code mid-string
 *     ("FXE-EU/PRT/OPOSSC/…"), and "DE Arteaga Mex", where the only foreign
 *     signal is a title-cased trailing code.
 */
function positionalIso3(seg) {
  const raw = fold(seg);
  // The code is uppercase; the SOURCE may not be. Eaton posts "Manufacturing
  // Engineer South Molton Gbr Ex36 3dw" — a UK req at fit 83 with an empty
  // location field, where the only country signal is that "Gbr" — and this
  // test looked for a literal "GBR", so it never fired.
  //
  // The title-casing is OURS: fix-titles.mjs normalises titles and preserves
  // only roman numerals and a known acronym list, so an all-caps "GBR" from
  // the ATS reaches this function as "Gbr". Our own cleanup destroyed the
  // signal the detector depends on.
  //
  // Title-case counts only for codes that are NOT English words; the
  // AMBIGUOUS set still demands capitals AND a country-code position, which
  // is what keeps "Del Mar" and "Cape Cod" American.
  //
  // Title-case is allowed ONLY for unambiguous codes. "Manufacturing Engineer
  // Indianapolis Ind" puts a title-cased IND in trailing position — both of
  // the ambiguous test's conditions — so allowing it there would move Indiana
  // to Asia. An ambiguous code still has to be shouted: literal capitals.
  const titled = (code) => code.charAt(0) + code.slice(1).toLowerCase();
  const upperInSource = (code, allowTitleCase) =>
    new RegExp(`(^|[^A-Za-z])(${code}${allowTitleCase ? '|' + titled(code) : ''})(?![A-Za-z])`).test(raw);
  const positioned = (code) => {
    const lead = raw.toUpperCase().match(/^([A-Z]{3})[\s\-–—:,/]/);
    if (lead && lead[1] === code) return true;
    const tokens = tokensOf(seg);
    return tokens[tokens.length - 1] === code;
  };

  for (const t of tokensOf(seg)) {
    if (t.length !== 3 || !ISO3_NONUS.has(t)) continue;
    if (AMBIGUOUS_ISO3.has(t)
      ? (positioned(t) && upperInSource(t, false))
      : (positioned(t) || upperInSource(t, true))) return true;
  }
  return false;
}

/**
 * An alpha-2 code in one of the two places tenants actually use one as a
 * country: leading the string ("CR - Alajuela", "CZ-DOUDLEVCE-PILSEN", "GB
 * Bedford"), or trailing it the way JSON-LD addressCountry emits ("Taoyuan
 * City,TW, TW"). Codes that are also state abbreviations never qualify.
 */
function positionalIso2(seg) {
  const upper = fold(seg).toUpperCase();
  const lead = upper.match(/^([A-Z]{2})[\-–—:,/]/);
  if (lead && ISO2_NONUS.has(lead[1]) && !US_STATE_CODES.has(lead[1])) return true;
  // "CH - Visp", "NL - Geleen", "PL - Warszawa", "FR - Huningue": the same
  // prefix with spaces round the dash (F-764). Only for the codes tenants
  // actually write this way: "GN - SONG - MT - …" is an Accenture unit code,
  // not Guinea, and "SA - San Antonio" is a site code, not Saudi Arabia.
  const spaced = fold(seg).match(/^([A-Z]{2})\s+[\-–—]\s+\S/);
  if (spaced && SPACED_LEAD_CODES.has(spaced[1]) && !usCity(seg)) return true;
  const tokens = tokensOf(seg);
  const last = tokens[tokens.length - 1];
  if (last && last.length === 2 && ISO2_NONUS.has(last) && !US_STATE_CODES.has(last)) return true;
  return false;
}

/**
 * The same idea, but SPACE-separated — "GB Bedford - Franklin Court".
 *
 * Weaker than the delimited form and ranked below state codes, because a
 * leading two-letter token separated by a space is very often not a country at
 * all: "AF New London WI" is an Air Force site in Wisconsin, and reading its
 * "AF" as Afghanistan hid a US job.
 */
function spaceLeadIso2(seg) {
  const lead = fold(seg).toUpperCase().match(/^([A-Z]{2})\s+[A-Z]/);
  return !!(lead && ISO2_NONUS.has(lead[1]) && !US_STATE_CODES.has(lead[1]));
}

/** Weakest tier: a city with no country attached. */
function usCity(seg) { return US_CITY_FLAT_RE.test(flatten(seg)); }

/**
 * The same tier for a whole segment, read the way an address is written
 * (F-1042). A US address puts the state AFTER the town; what follows a plain
 * town name after a comma is its region. "Thetford, Norfolk" is Multimatic's
 * English site, and Norfolk being a Virginia city put it in the US deck. So a
 * US city counts only in the first part, or when the first part is not a
 * plain town name (a street, an office label, a site code: "GLOBAL CUSTOM
 * COMMERCE/BLINDS OFFICE, HOUSTON - 2140").
 */
//
// A big US metro after the town is the town's metro, not its region, and
// stays American: "Bothell, Seattle", "Kent, Seattle area", "Lancaster, Los
// Angeles", "Oakland, Chicago" (review, 2026-11-12). So does any US city
// written as an area ("…, Norfolk area"). Norfolk alone is a county as often
// as a city, and is not a metro.
const US_METRO_RE = /\b(seattle|los angeles|chicago|pittsburgh|milwaukee|silicon valley|san francisco|san jose|san diego|sacramento|houston|dallas|fort worth|austin|san antonio|el paso|phoenix|tucson|minneapolis|st paul|saint paul|salt lake|orlando|tampa|jacksonville|nashville|memphis|albuquerque|boise|springfield|tacoma)\b/;
const AREA_RE = /\b(area|metro|metropolitan|greater|region)\b/;
function usCityEvidence(seg) {
  const parts = commaParts(seg);
  if (parts.length < 2) return usCity(seg);
  if (usCity(parts[0])) return true;
  const plainTown = /^[A-Za-z][A-Za-z.' -]*$/.test(parts[0]) && parts[0].split(/\s+/).length <= 3
    && parts[0] !== parts[0].toUpperCase();
  if (!plainTown) return usCity(seg);
  const rest = flatten(parts.slice(1).join(' '));
  return usCity(rest) && (US_METRO_RE.test(rest) || AREA_RE.test(rest));
}
// `bare` admits FOREIGN_CITY_EXTRA_RE, which is only for a city standing alone.
function foreignCity(seg, bare = false) {
  const flat = flatten(seg);
  return FOREIGN_CITY_FLAT_RE.test(flat) || FOREIGN_TOWN_FLAT_RE.test(flat) || (bare && FOREIGN_CITY_EXTRA_RE.test(flat));
}
/** A foreign province or region: anywhere, or after the first comma for the ones with US twins. */
function foreignRegion(seg) {
  if (FOREIGN_REGION_RE.test(flatten(seg))) return true;
  const rest = commaParts(seg).slice(1).join(' ');
  return !!rest && FOREIGN_TRAILING_REGION_RE.test(flatten(rest));
}

/**
 * One segment's verdict: 'us' | 'non-us' | null.
 *
 * The tiers, in the order that survives real location strings:
 *   1. an explicit US country or spelled-out state   "Austin, Texas" · "USA-…"
 *   2. an unambiguous foreign country                "Costa Rica, San Jose"
 *   3. a state postal code                           "Austin, TX" · "Dublin OH"
 *   4. a country whose name is also a US town        "Lysaker, Norway"
 *      or a foreign province/region                  "Alliston, Ontario"
 *   5. a US city on its own                          "San Francisco"
 *   6. a foreign city on its own                     "Sao Paulo" · "Edinburgh"
 *
 * Tier 2 does not apply to a canonical "Town, ST" whose only foreign evidence
 * is a country name inside the town ("Holland, MI", "Canada, KY") — see
 * usStateAddress. A trailing UK/Canadian/Dutch/Irish postcode is dropped first.
 *
 * Tier 3 sitting between the two country tiers is the whole trick. Above the
 * weak names it keeps "Norway, MI" in Michigan and "Poland, OH" in Ohio; below
 * the strong ones it keeps "Amsterdam, NH, Netherlands" out of New Hampshire.
 */
/**
 * "X, DE": DELAWARE ONLY WHEN IT IS IN DELAWARE (2026-11-03). DE is Delaware
 * and Germany, and the state reading won on shape alone: "Lindenberg im
 * Allgäu, DE" (185 rows), "Neuenstein, DE", "Bensheim, DE, 64625" and
 * "Schwaikheim, DE, 71409" were all American. Delaware is small: its places
 * fit in one list and its ZIP codes all start 197-199. So, with no "US" or
 * state name beside it (explicitUs runs first): a ZIP decides, then a
 * Delaware place, and anything else is Germany. A bare "DE" is unknown.
 */
const DELAWARE_PLACE_RE = /\b(wilmington|newark|dover|middletown|smyrna|milford|seaford|georgetown|elsmere|new castle|millsboro|laurel|harrington|camden|clayton|lewes|milton|selbyville|townsend|bridgeville|delmar|delaware city|ocean view|rehoboth(?: beach)?|bethany beach|south bethany|fenwick island|frederica|greenwood|felton|cheswold|wyoming|dagsboro|frankford|millville|blades|newport|bellefonte|arden|ardentown|ardencroft|bear|glasgow|hockessin|pike creek|claymont|brookside|edgemoor|talleyville|north star|greenville|christiana|yorklyn|montchanin|winterthur|rockland|kirkwood|port penn|st\.? georges|odessa|magnolia|little creek|leipsic|kenton|hartly|houston|ellendale|lincoln|slaughter beach|long neck|wilmington manor|minquadale|stanton|marshallton|red lion|summit bridge|delaware)\b/;
function delawareOrGermany(rawSeg, seg) {
  // Only a "DE" standing on its own: "DE005 Greentree - Clinic" is a Fresenius
  // North America site code and keeps the older reading.
  if (!/(?:^|[^A-Za-z0-9])DE(?:[^A-Za-z0-9]|$)/.test(String(rawSeg))) return null;
  const zip = /(?:^|[^\d])(?:D-)?(\d{5})(?:-\d{4})?(?:[^\d]|$)/.exec(String(rawSeg));
  if (zip) return /^19[7-9]/.test(zip[1]) ? 'us' : 'non-us';
  const rest = flatten(seg).replace(/\bde\b/g, ' ').trim();
  if (!rest) return null;
  // "Remote, DE" names no place: it may be Delaware or Germany, so it is not
  // read as either (review, 2026-11-03). The remote bucket keeps it; the body decides.
  if (!rest.replace(new RegExp(REMOTE_RE.source, 'gi'), ' ').replace(/[^a-z]+/g, '')) return 'unknown';
  return DELAWARE_PLACE_RE.test(rest) ? 'us' : 'non-us';
}

function segmentVerdict(rawSeg) {
  const seg = stripPostcode(rawSeg);
  if (explicitUs(seg)) return 'us';
  // Tier 2 is skipped for the canonical "Holland, MI" shape, whose only
  // foreign evidence is a country name inside the town name (F-759).
  if (!usStateAddress(seg) && explicitForeign(seg)) return 'non-us';

  const state = stateCodeSignal(seg);
  if (state === 'DE') {
    const de = delawareOrGermany(rawSeg, seg);
    if (de) return de;
  }
  if (state) {
    // One exception, in two tiers: a code that is ALSO a country code can be
    // the country rather than the state.
    //
    // Tier one is decisive — the city beside it belongs to THAT country, so the
    // code names that country. "Hyderabad - TS - IN" and "Bangalore, KA, IN"
    // are India; "Dresden, TN" is not Tunisia, because Tunisia has no Dresden.
    const countryCities = COLLIDING_COUNTRY_CITIES[state];
    if (countryCities && countryCities.test(flatten(seg))) return 'non-us';

    // Tier two is the weaker, older rule: SOME foreign city sits beside a code
    // that some country uses. That is enough everywhere except the canonical
    // American "City, ST" — the one form where the state reading is so
    // overwhelmingly the common case that it wins on shape alone. Restricting
    // this to the non-canonical forms is what lets "Dresden, TN" stay in
    // Tennessee while "IN Salzburg At Salzburg" stays in Austria; without it,
    // tier one alone would put every foreign city whose country is not in the
    // table above into the US deck.
    //
    // A ZIP after the code is still the canonical shape: "Paris, TN 38242",
    // "Vincennes, IN 47591" and "New Orleans, LA 70123" were read as France
    // and Laos because "TN 38242" was not exactly "TN".
    const parts = fold(seg).split(/\s*,\s*/).filter(Boolean);
    const canonicalCityState = parts.length === 2 && new RegExp(`^${state}(\\s+\\d{5}(-\\d{4})?)?$`, 'i').test(parts[1]);
    if (!canonicalCityState && ISO2_NONUS.has(state) && (foreignCity(seg) || foreignRegion(seg))) return 'non-us';
    // "Fellbach, BW, DE", "Hude-Wüsting, NI, DE", "Warstein, NRW,DE, DE": a
    // region code that no US state uses, between the city and a code that a
    // country uses. A US address has no such middle part.
    const tokens = tokensOf(seg);
    if (ISO2_NONUS.has(state) && tokens[tokens.length - 1] === state
      && commaParts(seg).slice(1, -1).some(p => /^[A-Z]{2,3}$/.test(p) && !US_STATE_CODES.has(p) && p !== 'US' && p !== 'USA')) return 'non-us';
    return 'us';
  }
  if (WEAK_NAME_RE.test(flatten(seg))) return 'non-us';
  if (foreignRegion(seg)) return 'non-us';
  if (spaceLeadIso2(seg)) return 'non-us';
  if (usCityEvidence(seg)) return 'us';
  if (foreignCity(seg, true)) return 'non-us';
  return null;
}

/**
 * Bucket one location string into us | remote | non-us | unknown.
 *
 * Multi-site postings ("Boise, ID,US | Bangalore, India") are split first and
 * ANY US site wins — a req that can be filled in Boise is a req Alex can take,
 * whatever else is listed alongside it.
 *
 * When the location field is empty the TITLE is inspected instead: sitemap- and
 * Eightfold-discovered jobs carry the site in the slug and nothing anywhere else.
 */
// Separators an ATS uses between sites of one multi-site req. The bullet forms
// (· • ●) come from Ashby and custom career sites, which render the list as
// "Singapore · Seattle · United States · San Francisco". Missing them read the
// whole string as one place, so a req with three US sites classified as
// Singapore and got hard-blocked. Shared with prefs.mjs so one posting cannot
// be split two different ways by two different callers.
export const SEGMENT_SPLIT_RE = /\s*[|;·•●]\s*|\s+\/\s+/;

/**
 * The site name an ATS puts in its own job URL.
 *
 * Workday writes the PRIMARY location into the path:
 *   .../job/Hsinchu-Taiwan/Regional-Development-Applications-Engineer_2637301
 *
 * This is the only evidence available when the location field is the
 * placeholder "2 Locations", which 185 deck postings carried.
 */
function siteFromUrl(url) {
  const u = String(url || '');
  if (!/myworkdayjobs\.com/i.test(u)) return null;
  const m = /\/job\/([^/?#]+)\//.exec(u);
  if (!m) return null;
  const site = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').trim();
  return site.length >= 3 ? site : null;
}

export function classifyLocation(location, title = '', url = '') {
  const raw = String(location || '').trim();

  if (raw) {
    // A German-law title settles every ambiguous location on the posting.
    //
    // These arrive as "Marktoberdorf, DE" (read as Delaware, since DE is a
    // state code), "Berlin" and "Hamburg" (deliberately `unknown`, because the
    // US twins are written bare too often to risk hiding them), and
    // "2 Locations" (a placeholder). All three routes put a European req in
    // the deck. "(f/m/d)" in the title is never written on a US posting, so it
    // is allowed to break exactly those ties — and only those: an explicit
    // "USA", "United States" or a spelled-out state still wins, so a US
    // employer using the notation is not mislabelled.
    if (EURO_TITLE_RE.test(String(title || ''))) {
      const segs = raw.split(SEGMENT_SPLIT_RE).map(s => s.trim()).filter(Boolean);
      // US evidence that a country code cannot fake. "Austin, TX" is
      // unambiguous — TX is not an ISO-2 country — while "Marktoberdorf, DE"
      // is exactly the collision this is here to resolve.
      const solidlyUs = (seg) => explicitUs(seg)
        || tokensOf(seg).some(t => US_STATE_CODES.has(t) && !ISO2_NONUS.has(t));
      if (!segs.some(solidlyUs)) return 'non-us';
    }

    if (PLACEHOLDER_RE.test(raw)) {
      // "2 Locations" tells us nothing, but the ATS put the primary site in
      // its own URL. 82 of 185 placeholder postings in the deck resolved to an
      // unambiguously foreign site this way — Singapore, Tel Aviv, Hsinchu,
      // Pallavaram — several of them countries in his `never in location`
      // list, sitting at fit 88.
      //
      // The danger was F-14's: a multi-site req that also has a US site must
      // NOT be hidden. Checked against the Workday API rather than assumed —
      // 14 foreign-primary placeholder reqs probed, 10 reachable, and all 10
      // listed only foreign sites (NXP: Tianjin/Tianjin, Cisco: Dubai/Abu
      // Dhabi, Broadcom: Singapore/Singapore). Workday groups a req's sites by
      // region, so the primary settles it. A US primary (Jabil's "8 Locations"
      // = St. Petersburg + 7 more US sites) still reads as US.
      const site = siteFromUrl(url);
      if (site) {
        const v = classifyLocation(site);
        if (v !== 'unknown') return v;
      }
      return 'unknown';
    }

    // Multi-site postings are split first, and ANY US site wins: a req that can
    // be filled in Boise is a req Alex can take, whatever is listed beside it.
    const segments = raw.split(SEGMENT_SPLIT_RE).map(s => s.trim()).filter(Boolean);
    let sawUs = false, sawForeign = false;
    for (const seg of segments) {
      const v = segmentVerdict(seg);
      if (v === 'us') sawUs = true;
      else if (v === 'non-us') sawForeign = true;
    }
    // "Remote" is its own bucket and outranks the country reading, because the
    // dashboard shows remote separately and "Remote - USA" is a remote job, not
    // a Utah one. Only a remote role that names a foreign country and no US
    // site is genuinely out of reach.
    if (REMOTE_RE.test(flatten(raw))) {
      return (sawForeign && !sawUs && !US_REMOTE_RE.test(flatten(raw))) ? 'non-us' : 'remote';
    }
    if (sawUs) return 'us';
    if (sawForeign) return 'non-us';
    return 'unknown';
  }

  const t = String(title || '');
  const v = segmentVerdict(t);
  if (v === 'us') return 'us';
  if (REMOTE_RE.test(flatten(t))) {
    // The location-field path above already knows that a remote role naming a
    // foreign country and no US site is a FOREIGN role, not a remote one. This
    // path did not, and checked "remote" first — so Teradyne's "Remote Service
    // Engineer (GCS Hsinchu, Taiwan)" and "Remote Engineer Bangalore India"
    // came out as `remote`, which is admitted to the deck.
    //
    // Same rule, same order, in both places now.
    return (v === 'non-us' && !US_REMOTE_RE.test(flatten(t))) ? 'non-us' : 'remote';
  }
  if (v === 'non-us') return 'non-us';
  // The German/French gender notation again, for postings that arrive with no
  // location field at all — Accenture's "CONSEILLER COMMERCIAL (F/H) MARCQ EN
  // BAROEUL" was the last European req standing in the deck.
  if (EURO_TITLE_RE.test(t)) return 'non-us';
  // Sitemap slugs concatenate multi-site locations ("Linkoutaichung"), which
  // defeats the word boundaries every check above depends on. These are the fab
  // towns that actually appear that way.
  if (/(linkou|hsinchu|taichung|tainan|kaohsiung|veldhoven|yokneam|pyeongtaek|penang|kulim|batam|cikarang)/i.test(t)) return 'non-us';
  return 'unknown';
}

// Exported for the tests, which assert on the tables rather than on a handful
// of hand-picked strings.
export const _internals = { ISO2_NONUS, ISO3_NONUS, US_STATE_CODES, explicitUs, explicitForeign, segmentVerdict };

/**
 * Does a stored row's location bucket disagree with the current reading?
 * After a geo.mjs change this selects the rows to re-triage
 * (`node jarvis/retriage.mjs --location`), instead of a one-off script.
 * @param row { location, title, url, location_bucket }
 */
export function bucketDrifted(row) {
  return classifyLocation(row?.location, row?.title, row?.url) !== (row?.location_bucket ?? null);
}
