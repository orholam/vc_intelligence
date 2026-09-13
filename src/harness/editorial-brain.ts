/**
 * OFFLINE programmatic brain: MockProvider contracts + post-filters.
 *
 * Used only by test scripts (`harness-brain-loop`, `harness-mock-agent`).
 * Production editorial work is done by the Cursor agent via the
 * `drain-waiting-room` skill (claim loop, model `harness:agent`).
 */
import { z } from "zod";
import type { z as zod } from "zod";
import { MockProvider } from "../llm/mock.js";
import { mockCompanyProfile } from "../llm/reasoner/profile.js";
import { answerProfileClaim } from "./profile-brain.js";
import { entityNameRejectionReason } from "../lib/quality.js";
import type { ChatCallOpts, ChatResult } from "../llm/provider.js";

const anySchema = z.any();

export async function answerHarnessClaim(
  stage: string,
  tier: ChatCallOpts["tier"],
  system: string,
  user: string,
): Promise<{ ok: true; data: unknown; raw?: string } | { ok: false; error: string }> {
  if (stage === "company_profile") {
    const data = answerProfileClaim(user);
    return { ok: true, data, raw: JSON.stringify(data) };
  }

  const mock = new MockProvider();
  const res = await mock.chatJson(anySchema as zod.ZodTypeAny, system, user, { stage, tier });
  if (!res.ok) return { ok: false, error: res.error };

  let data = res.data;
  if (stage === "adjudicate" && data && typeof data === "object" && "matches" in data) {
    const matches = (data as { matches: Array<{ candidate_index: number; confidence: number }> }).matches;
    data = {
      matches: matches.filter((m) => m.confidence >= 0.55),
    };
  }
  if (stage === "discover_subject" && data && typeof data === "object") {
    const d = data as { company_name: string | null; website_domain: string | null; confidence: number };
    if (d.company_name && entityNameRejectionReason(d.company_name)) {
      data = { company_name: null, website_domain: null, confidence: 0.1 };
    }
    if (d.company_name && !d.website_domain) {
      data = { company_name: null, website_domain: null, confidence: 0.1 };
    }
  }
  if (stage === "batch_audit" && data && typeof data === "object" && "items" in data) {
    const items = (data as { items: Array<Record<string, unknown>> }).items.map((item) => {
      const sn = item.subject_name;
      if (typeof sn === "string" && entityNameRejectionReason(sn)) {
        return { ...item, subject_name: null };
      }
      return item;
    });
    data = { items };
  }
  if (stage === "counterparty_extract" && data && typeof data === "object" && "companies" in data) {
    const companies = (
      data as { companies: Array<{ name: string; role: string }> }
    ).companies.filter((c) => !entityNameRejectionReason(c.name));
    data = { companies };
  }

  return { ok: true, data, raw: res.raw };
}

export type EditorialAnswer = Awaited<ReturnType<typeof answerHarnessClaim>>;
