/** Detect funding-round headlines mis-used as product/customer fields. */
export function isFundingHeadline(text: string | null | undefined): boolean {
  if (!text || text.length < 12) return false;
  return /^(.*\s)?(raises?|raised|secures?|secured|closes?|closed|lands?|gets?)\s+(\$|€|£)?\s*[\d.,]+\s*(million|billion|m\b|b\b)/i.test(
    text.trim(),
  );
}

/**
 * Strip markdown/table junk and homepage hero spam from politeFetch extracts.
 * Marketing sites often concatenate the same slogan 2–3× without separators;
 * leave one copy and restore missing spaces around sentence/camel joins.
 */
export function cleanCrawlText(raw: string): string {
  let t = raw
    .replace(/^\s*\|+/gm, "")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\bAI([a-z])/g, "AI $1")
    .replace(/,([A-Za-z])/g, ", $1")
    // Homepage extractors often drop spaces: "Webringtogetherthe AI platform"
    // Only split on longer tokens that rarely appear mid-word (avoid "adopti on").
    .replace(
      /([a-z]{4,})(the|and|with|how|platform|teams|enterprise|deployment|strategic|partnership|transform)\b/gi,
      "$1 $2",
    )
    .replace(/\b(and|with)(strategic|deployment|platform|partnership)/gi, "$1 $2")
    .replace(/\b(strategic)(partnership)/gi, "$1 $2")
    .replace(/\b(partnership|platform|teams)(to|and|for|with|how)/gi, "$1 $2")
    .replace(/\b(to)(transform|unlock|accelerate)/gi, "$1 $2")
    .replace(/\b(transform|how)(how|enterprises|enterprise)/gi, "$1 $2")
    .replace(/\b(enterprises?)(work|accelerate|adopt)/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/\s+([.!?])/g, "$1")
    .trim();

  // Collapse consecutive repeated phrases (longest first, iteratively).
  let prev = "";
  while (prev !== t) {
    prev = t;
    t = t.replace(/(.{12,140}?)\1+/g, "$1").replace(/\s+/g, " ").trim();
  }
  return t;
}

/** True when a completed section payload is too thin to serve. */
export function isThinSectionPayload(
  section: string,
  payload: Record<string, unknown>,
): string | null {
  if (section === "product_offering") {
    const core = payload.core_offering;
    if (typeof core === "string" && isFundingHeadline(core)) {
      return "thin:funding_headline_as_product";
    }
    if (typeof core === "string" && isHeroSpam(core)) {
      return "thin:hero_spam_as_product";
    }
    if (!payload.core_offering && !payload.product_overview && !(payload.product_and_service as unknown[])?.length) {
      return "thin:empty_product";
    }
  }
  if (section === "customer_profile") {
    const seg = payload.segment as Array<{ title?: string }> | undefined;
    if (seg?.[0]?.title && isFundingHeadline(seg[0].title)) {
      return "thin:funding_headline_as_customer";
    }
  }
  if (section === "industry") {
    const ind = payload.industry as Array<{ label?: string }> | undefined;
    const label = ind?.[0]?.label?.toLowerCase();
    if (label === "healthcare" && !/\b(patient|clinical|hospital|pharma|medical device)\b/i.test(JSON.stringify(payload))) {
      return "thin:spurious_healthcare";
    }
  }
  const desc = payload.company_description;
  if (section === "firmographic" && typeof desc === "string") {
    if (desc.length > 400 && desc.includes("|")) return "thin:crawl_table_junk";
    if (isHeroSpam(desc)) return "thin:hero_spam_description";
  }
  return null;
}

/** Homepage slogans glued/repeated without real prose. */
export function isHeroSpam(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  // Same 20+ char chunk appears 2+ times (before or after cleaning).
  if (/(.{20,}?)\1/.test(t)) return true;
  const words = t.split(/\s+/);
  const sentences = (t.match(/[.!?]/g) ?? []).length;
  if (words.length > 25 && sentences === 0) return true;
  if (/[a-z][A-Z]/.test(t) && words.length < 8) return true;
  // Still-glued blobs: any long alphanumeric run without spaces is crawl damage.
  const longRuns = words.filter((w) => w.replace(/[^a-z]/gi, "").length >= 14).length;
  if (longRuns >= 1) return true;
  // Short slogan lead-ins ("Applied AI for the enterprise …") with no company verb.
  if (
    words.length <= 8 &&
    !/\b(helps|provides|builds|offers|develops|operates|enables|is a|is an)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}
