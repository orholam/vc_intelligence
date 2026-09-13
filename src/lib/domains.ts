/**
 * Non-company utility domains that appear in every article's share/footer
 * links. Never valid entity-website evidence (FR-8/FR-10 hygiene).
 */
export const UTILITY_DOMAINS = new Set([
  "facebook.com", "twitter.com", "x.com", "linkedin.com", "youtube.com",
  "instagram.com", "tiktok.com", "reddit.com", "pinterest.com", "threads.net",
  "whatsapp.com", "t.me", "t.co", "goo.gl", "bit.ly", "ow.ly", "tinyurl.com",
  "apple.news", "news.google.com", "google.com", "google.co.uk", "gstatic.com",
  "gravatar.com", "wp.com", "wordpress.com", "medium.com", "substack.com",
  "bsky.app", "mastodon.social", "mastodon.online", "mailchimp.com", "hubspot.com", "hsforms.com", "cloudflare.com", "akamai.com",
  "doubleclick.net", "googletagmanager.com", "googlesyndication.com",
  // Code-hosting & free-site platforms: per-project subdomains collapse to one
  // domain under hostToDomain(), so they can never identify a single entity
  // (FR-8/FR-10). A repo homepage pointing back at the platform carries no
  // product-domain evidence either.
  "github.com", "github.io", "gitlab.com", "gitlab.io", "bitbucket.org",
  "vercel.app", "netlify.app", "pages.dev", "herokuapp.com",
  "firebaseapp.com", "web.app", "notion.site", "linktr.ee", "carrd.co",
]);

export function isUtilityDomain(domain: string | null | undefined): boolean {
  if (!domain) return true;
  const d = domain.toLowerCase().replace(/^www\./, "");
  return UTILITY_DOMAINS.has(d);
}
