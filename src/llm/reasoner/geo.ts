/**
 * Geography inference for the offline reasoning engine: country-name/city
 * matching over title-first zoned text with a conservative ISO-alias scan.
 * Output: up to 4 ISO-3166 alpha-2 codes, title evidence first.
 */

const COUNTRIES: Record<string, string> = {
  "united states": "US", usa: "US", "u.s.": "US", america: "US",
  "united kingdom": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB",
  canada: "CA", germany: "DE", france: "FR", spain: "ES", italy: "IT",
  netherlands: "NL", belgium: "BE", switzerland: "CH", austria: "AT", sweden: "SE",
  norway: "NO", denmark: "DK", finland: "FI", ireland: "IE", portugal: "PT",
  poland: "PL", czech: "CZ", romania: "RO", ukraine: "UA", estonia: "EE",
  latvia: "LV", lithuania: "LT", india: "IN", singapore: "SG", japan: "JP",
  china: "CN", "south korea": "KR", australia: "AU", "new zealand": "NZ",
  brazil: "BR", mexico: "MX", argentina: "AR", chile: "CL", colombia: "CO",
  nigeria: "NG", kenya: "KE", ghana: "GH", "south africa": "ZA", egypt: "EG",
  israel: "IL", "saudi arabia": "SA", "united arab emirates": "AE", uae: "AE",
  qatar: "QA", turkey: "TR", indonesia: "ID", vietnam: "VN", thailand: "TH",
  malaysia: "MY", philippines: "PH", pakistan: "PK", bangladesh: "BD",
};

const CITY_COUNTRY: Record<string, string> = {
  "san francisco": "US", "new york": "US", boston: "US", seattle: "US", austin: "US",
  chicago: "US", "los angeles": "US", miami: "US", denver: "US", atlanta: "US",
  "palo alto": "US", "mountain view": "US", detroit: "US", dallas: "US", houston: "US",
  london: "GB", manchester: "GB", edinburgh: "GB", dublin: "IE", paris: "FR",
  berlin: "DE", munich: "DE", amsterdam: "NL", stockholm: "SE", copenhagen: "DK",
  helsinki: "FI", oslo: "NO", zurich: "CH", geneva: "CH", vienna: "AT",
  barcelona: "ES", madrid: "ES", milan: "IT", rome: "IT", warsaw: "PL",
  lisbon: "PT", brussels: "BE", prague: "CZ", bucharest: "RO", tallinn: "EE",
  riga: "LV", vilnius: "LT", "tel aviv": "IL", dubai: "AE", riyadh: "SA",
  toronto: "CA", vancouver: "CA", montreal: "CA", "waterloo": "CA",
  sydney: "AU", melbourne: "AU", auckland: "NZ", tokyo: "JP", seoul: "KR",
  beijing: "CN", shanghai: "CN", shenzhen: "CN", hangzhou: "CN",
  bangalore: "IN", bengaluru: "IN", mumbai: "IN", delhi: "IN", gurgaon: "IN", hyderabad: "IN",
  "sao paulo": "BR", "mexico city": "MX", lagos: "NG", nairobi: "KE",
  jakarta: "ID", singapore_: "SG",
};

/** Word-bounded ISO-2 tokens that unambiguously denote countries ("UK-based"). */
const SAFE_ISO = /\b(uk|usa)\b/g;

export function detectCountries(title: string, body: string): string[] {
  const found: Array<{ iso: string; rank: number }> = [];
  const push = (iso: string, rank: number): void => {
    if (!found.some((f) => f.iso === iso)) found.push({ iso, rank });
  };
  const zones: Array<[string, number]> = [
    [title.toLowerCase(), 0],
    [body.slice(0, 400).toLowerCase(), 1],
    [body.slice(400, 2000).toLowerCase(), 2],
  ];
  for (const [zone, rank] of zones) {
    if (found.length >= 4) break;
    const padded = ` ${zone.replaceAll(/[.,;:!?)("']/g, " ").replaceAll(/\s+/g, " ")} `;
    for (const [name, iso] of Object.entries(COUNTRIES)) {
      if (padded.includes(` ${name} `)) push(iso, rank);
    }
    for (const [city, iso] of Object.entries(CITY_COUNTRY)) {
      if (padded.includes(` ${city} `)) push(iso, rank);
    }
    if (rank === 0) {
      for (const m of padded.matchAll(SAFE_ISO)) push(m[1] === "usa" ? "US" : "GB", 1);
    }
  }
  return [...new Set(found.sort((a, b) => a.rank - b.rank).map((f) => f.iso))].slice(0, 4);
}

/** ListGen queries are explicit filter language: ISO-2 tokens are allowed. */
export function detectQueryCountries(query: string): string[] {
  const q = ` ${query.toLowerCase().replaceAll(/[^a-z0-9\s]/g, " ").replaceAll(/\s+/g, " ")} `;
  const out = new Set(detectCountries(query, ""));
  const ISO_NAMES: Record<string, string> = { us: "US", uk: "GB", gb: "GB", de: "DE", fr: "FR", nl: "NL", se: "SE", es: "ES", it: "IT", ie: "IE", ca: "CA", au: "AU", in: "IN", sg: "SG", jp: "JP", kr: "KR", br: "BR", mx: "MX", ng: "NG", ke: "KE", za: "ZA", il: "IL", ae: "AE", ch: "CH", at: "AT", pl: "PL", pt: "PT", ee: "EE" };
  for (const m of q.matchAll(/\b(us|uk|gb|de|fr|nl|se|es|it|ie|ca|au|in|sg|jp|kr|br|mx|ng|ke|za|il|ae|ch|at|pl|pt|ee)\b/g)) {
    const iso = ISO_NAMES[m[1] ?? ""];
    if (iso) out.add(iso);
  }
  return [...out].slice(0, 10);
}

/** ListGen geo synonyms: plain-language regions -> ISO-2 lists. */
export const GEO_SYNONYMS: Record<string, string[]> = {
  europe: ["GB", "DE", "FR", "NL", "SE", "ES", "IT", "CH", "IE", "DK", "FI", "NO", "BE", "AT", "PL", "PT", "EE"],
  nordics: ["SE", "DK", "FI", "NO"],
  benelux: ["NL", "BE"],
  latam: ["BR", "MX", "AR", "CL", "CO"],
  "latin america": ["BR", "MX", "AR", "CL", "CO"],
  africa: ["NG", "KE", "ZA", "EG", "GH"],
  apac: ["SG", "JP", "AU", "IN", "ID", "VN", "TH", "MY", "PH", "KR", "NZ"],
  "asia pacific": ["SG", "JP", "AU", "IN", "ID", "VN", "TH", "MY", "PH", "KR"],
  mena: ["AE", "SA", "EG", "IL", "QA"],
  north_america: ["US", "CA"],
  scandinavia: ["SE", "DK", "FI", "NO"],
};
