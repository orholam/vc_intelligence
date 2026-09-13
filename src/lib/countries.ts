/**
 * Country label/code utilities shared by imports (FR-7), geography tagging
 * (FR-15) and the offline mock provider.
 */
export const COUNTRY_TO_ISO2: Record<string, string> = {
  "united states": "US", usa: "US", "u.s.": "US", "united states of america": "US",
  "united kingdom": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB",
  canada: "CA", germany: "DE", france: "FR", spain: "ES", italy: "IT", netherlands: "NL",
  belgium: "BE", switzerland: "CH", austria: "AT", sweden: "SE", norway: "NO",
  denmark: "DK", finland: "FI", ireland: "IE", portugal: "PT", poland: "PL",
  "czech republic": "CZ", czechia: "CZ", romania: "RO", ukraine: "UA", estonia: "EE",
  latvia: "LV", lithuania: "LT", india: "IN", singapore: "SG", japan: "JP",
  china: "CN", "people's republic of china": "CN", "south korea": "KR", korea: "KR",
  australia: "AU", "new zealand": "NZ", brazil: "BR", mexico: "MX", argentina: "AR",
  chile: "CL", colombia: "CO", nigeria: "NG", kenya: "KE", "south africa": "ZA",
  egypt: "EG", israel: "IL", "saudi arabia": "SA", "united arab emirates": "AE",
  qatar: "QA", turkey: "TR", indonesia: "ID", vietnam: "VN", thailand: "TH",
  malaysia: "MY", philippines: "PH", pakistan: "PK", bangladesh: "BD", hong_kong: "HK",
  iceland: "IS", luxembourg: "LU", greece: "GR", hungary: "HU", slovakia: "SK",
  slovenia: "SI", croatia: "HR", bulgaria: "BG", serbia: "RS",
};

export const CITY_COUNTRY: Record<string, string> = {
  "san francisco": "US", "new york": "US", boston: "US", seattle: "US", austin: "US",
  chicago: "US", "los angeles": "US", miami: "US", denver: "US", atlanta: "US",
  london: "GB", manchester: "GB", edinburgh: "GB", dublin: "IE", paris: "FR",
  berlin: "DE", munich: "DE", amsterdam: "NL", stockholm: "SE", copenhagen: "DK",
  helsinki: "FI", oslo: "NO", zurich: "CH", geneva: "CH", vienna: "AT",
  barcelona: "ES", madrid: "ES", milan: "IT", rome: "IT", warsaw: "PL",
  "tel aviv": "IL", dubai: "AE", toronto: "CA", vancouver: "CA", montreal: "CA",
  sydney: "AU", melbourne: "AU", auckland: "NZ", tokyo: "JP", seoul: "KR",
  beijing: "CN", shanghai: "CN", shenzhen: "CN", bangalore: "IN", bengaluru: "IN",
  mumbai: "IN", delhi: "IN", gurgaon: "IN", "sao paulo": "BR", "mexico city": "MX",
  lagos: "NG", nairobi: "KE", singapore: "SG", hong_kong: "HK", cambridge: "GB",
};

/**
 * Extract referenced/affected ISO-3166 alpha-2 codes from free text (FR-15).
 * Deliberately matches full country names and major cities ONLY — a previous
 * standalone-ISO-token scan ("US", "IN"…) fired on random capitalized tokens
 * and appended phantom countries to nearly every article.
 */
export function extractCountries(text: string, max = 3): string[] {
  const lower = ` ${text.toLowerCase()} `;
  const found = new Set<string>();
  for (const [name, iso] of Object.entries(COUNTRY_TO_ISO2)) {
    if (
      lower.includes(` ${name} `) ||
      lower.includes(` ${name},`) ||
      lower.includes(` ${name}.`) ||
      lower.includes(`${name}'s`)
    ) {
      found.add(iso);
      if (found.size >= max) return [...found];
    }
  }
  for (const [city, iso] of Object.entries(CITY_COUNTRY)) {
    if (found.size >= max) break;
    if (
      lower.includes(` ${city} `) ||
      lower.includes(` ${city},`) ||
      lower.includes(` ${city}.`) ||
      lower.includes(`${city}'s`)
    ) {
      found.add(iso);
    }
  }
  // NOTE: deliberately NO standalone-ISO-token scan ("US", "IN", "KR"…) —
  // it matched random capitalized tokens and appended phantom countries to
  // nearly every article (quality round 2026-08-22).
  return [...found].slice(0, max);
}

export function countryLabelToIso2(label?: string | null): string | null {
  if (!label) return null;
  const key = label.trim().toLowerCase();
  return COUNTRY_TO_ISO2[key] ?? null;
}
