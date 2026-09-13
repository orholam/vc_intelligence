import type { ProfileSectionId } from "../../config-files.js";
import { minimalSectionPayload } from "../../api/contracts-enrichment.js";

/**
 * Deterministic offline company-profile generator (MockProvider stage
 * "company_profile"). Parses the rendered prompt and returns the minimal valid
 * payload per requested section — the profile engine merges this over its
 * deterministic DB-derived floor, so offline runs exercise the same merge,
 * sanitize and completeness paths as real LLM calls.
 */
export function mockCompanyProfile(user: string): { sections: Record<string, unknown> } {
  const name = /^COMPANY:\s*(.+?)\s*\(/m.exec(user)?.[1]?.trim() ?? null;
  const domainRaw = /^COMPANY:.*\(([^)]*)\)/m.exec(user)?.[1]?.trim() ?? "";
  const website = domainRaw && domainRaw !== "unknown" ? domainRaw : null;

  const sectionLine = /Build ONLY these sections:\s*(.+)/.exec(user)?.[1] ?? "";
  const requested = sectionLine
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const sections: Record<string, unknown> = {};
  for (const section of requested) {
    sections[section] = minimalSectionPayload(section as ProfileSectionId, { name, website });
  }
  return { sections };
}
