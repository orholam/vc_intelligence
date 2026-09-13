import type { OkaraLaunch } from "./store.js";
import { hostToDomain, type JsonValue } from "./lib.js";

export interface EntityPlan {
  canonicalName: string;
  website: string | null;
  industryTags: string[];
  aliases: string[];
  confidence: number;
}

export interface ArticlePlan {
  url: string;
  urlHashable: string;
  title: string;
  byline: string | null;
  publishedAt: Date;
  excerptText: string;
  primaryTag: string;
  secondaryTags: string[];
  allTags: string[];
  industryPrimary: string | null;
  platformMeta: Record<string, JsonValue | undefined>;
}

export interface LaunchPlan {
  entity: EntityPlan;
  article: ArticlePlan;
}

const SURFACE = "okara-launch-library";

/** Launch-category labels → intelligence taxonomy sector ids (E1 validity). */
const CATEGORY_SECTOR: Record<string, string> = {
  "ai & ml": "ai_ml",
  "climate & energy": "energy_transition",
  "consumer apps": "consumer_internet",
  "creator economy": "media_entertainment",
  "crypto & web3": "crypto_web3",
  "defense & space tech": "govtech_defense",
  "developer tools": "devtools",
  "enterprise infrastructure": "saas_enterprise",
  "hardware & devices": "consumer_electronics",
  "health & bio": "healthtech",
  "saas & productivity": "saas_enterprise",
  fintech: "fintech",
  "fintech & payments": "fintech",
  education: "edtech",
  gaming: "gaming",
};

function sectorFor(category: string | null): string | null {
  if (!category) return null;
  return CATEGORY_SECTOR[category.toLowerCase()] ?? null;
}

export function categoryOf(l: OkaraLaunch): string | null {
  const c = l.category;
  if (typeof c === "string") return c || null;
  if (c && typeof c === "object" && typeof c.name === "string") return c.name || null;
  return null;
}

/** Skip launches with nothing to build an entity or article from. */
export function isSyncable(l: OkaraLaunch): boolean {
  return Boolean(l.launch_url && (l.company_name || l.slug));
}

export function planLaunch(l: OkaraLaunch): LaunchPlan {
  const name = (l.company_name ?? l.slug).trim();
  const tagline = (l.tagline ?? "").trim();
  const website = l.company_website
    ? hostToDomain(l.company_website)
    : null;
  const category = categoryOf(l);
  const sectorId = sectorFor(category);

  const entity: EntityPlan = {
    canonicalName: name,
    website,
    industryTags: sectorId ? [sectorId] : [],
    // The launch handle (without @) is useful resolution evidence when no domain exists.
    aliases: l.handle ? [l.handle.replace(/^@/, "")] : [],
    confidence: website ? 0.7 : 0.55,
  };

  const title = tagline ? `${name}: ${tagline}` : `${name} product launch`;
  const publishedAt = l.launched_at ? new Date(`${l.launched_at}T12:00:00Z`) : new Date();

  const article: ArticlePlan = {
    url: l.launch_url!,
    urlHashable: l.launch_url!,
    title: title.slice(0, 300),
    byline: l.handle ?? null,
    publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
    excerptText: tagline || title,
    // Taxonomy ids only (E1): space-form tags were enum drift.
    primaryTag: "product.launch",
    secondaryTags: [],
    allTags: ["product.launch"],
    industryPrimary: sectorId,
    platformMeta: {
      surface: SURFACE,
      views: l.views ?? undefined,
      likes: l.likes ?? undefined,
      reposts: l.reposts ?? undefined,
      replies: l.comments ?? undefined,
      saves: l.saves ?? undefined,
      author_followers: l.author_followers ?? undefined,
      yc_launch: l.is_yc_launch ?? undefined,
      source: SURFACE,
      slug: l.slug,
    },
  };

  return { entity, article };
}
