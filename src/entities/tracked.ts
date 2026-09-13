import { sql } from "drizzle-orm";

/**
 * Operating companies we treat as "tracked" on discovery surfaces
 * (search, ListGen, corpus stats). Publics remain in the KB as
 * counterparties on news; they are not the product directory.
 */
export const TRACKED_COMPANY_SQL = sql`
  merged_into IS NULL
  AND needs_backfill = false
  AND type NOT IN ('fund', 'person-org', 'public')
`;
