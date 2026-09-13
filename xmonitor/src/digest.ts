import type { LaunchRow } from "./store.js";

export type DigestFormat = "md" | "text";

/**
 * Render recent launches, best first. Markdown is Slack/Obsidian-friendly.
 */
export function formatDigest(
  launches: LaunchRow[],
  opts: { minViews: number; format: DigestFormat },
): string {
  if (launches.length === 0) {
    return "No new launches in the window.";
  }

  const lines = [`# X launch digest — ${launches.length} candidates`, ""];

  for (const [i, l] of launches.entries()) {
    const rank = `${i + 1}.`;
    const handle = `@${l.authorHandle}`;
    const metaBits = [
      l.linkedDomain ? `\`${l.linkedDomain}\`` : null,
      `score ${l.score.toFixed(2)}`,
      l.videoCount > 0 ? `${l.videoCount} video` : null,
      `👁 ${formatCount(l.views)}`,
      `❤ ${formatCount(l.likes)}`,
      postedLabel(l),
    ].filter((v): v is string => v !== null);

    const excerpt = oneLine(l.text).slice(0, 220);
    lines.push(`${opts.format === "md" ? "**" : ""}${rank} ${handle}${opts.format === "md" ? "**" : ""} — ${metaBits.join(" · ")}`);
    lines.push(`   ${excerpt}`);
    lines.push(`   ${l.url ?? ""}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function postedLabel(l: LaunchRow): string {
  const sec = l.postedAtSec ?? l.firstSeenAtSec;
  const ageMin = Math.max(0, Math.floor((Date.now() / 1000 - sec) / 60));
  if (ageMin < 90) return `${ageMin}m ago`;
  const ageH = Math.floor(ageMin / 60);
  if (ageH < 48) return `${ageH}h ago`;
  return `${Math.floor(ageH / 24)}d ago`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
