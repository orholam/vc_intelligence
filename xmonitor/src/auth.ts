import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ErrorRateLimitStrategy, Scraper, SearchMode } from "@the-convocation/twitter-scraper";
import type { XMonitorConfig } from "./config.js";
import type { Logger } from "./log.js";
import { cookiesFromJsonFile, parseCookieHeader, SessionError } from "./session.js";

export interface AuthOptions {
  file?: string;
  paste?: boolean;
  browser?: boolean;
  /** Read cookies from an installed Chrome/Chromium profile (boolean = auto-detect). */
  profile?: boolean | string;
  /** Read cookies from a Firefox-family profile (boolean = auto-detect newest). */
  firefox?: boolean | string;
  /** Persist even when live validation fails (e.g. blocked network). */
  force?: boolean;
  /** Seconds to wait for an interactive browser login. */
  timeoutSec?: number;
}

export interface AuthResult {
  cookieCount: number;
  validated: boolean;
  sessionFile: string;
}

/** Read a cookie payload from stdin (paste + Ctrl+D, or piped). */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function cookieStringsFromContent(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return cookiesFromJsonFile(JSON.parse(trimmed));
  }
  return parseCookieHeader(trimmed);
}

function requireEssentialCookies(cookies: string[]): void {
  const names = new Set(cookies.map((c) => c.split("=")[0]?.trim()));
  const missing = ["auth_token", "ct0"].filter((n) => !names.has(n));
  if (missing.length) {
    throw new SessionError(`Cookie payload is missing required cookies: ${missing.join(", ")}`);
  }
}

export type ValidationResult =
  | { ok: true; note?: string }
  | { ok: false; reason: "rejected" | "network"; detail: string };

/**
 * LIVE validation: the library's isLoggedIn() only checks cookie presence,
 * so we fire one minimal authenticated search instead. 401/403/404 = cookies
 * rejected; network errors are reported separately; 429 counts as valid
 * (cookies accepted, just throttled).
 */
export async function validateLive(cookieStrings: string[], disableTxHeaders = false): Promise<ValidationResult> {
  const scraper = new Scraper({
    rateLimitStrategy: new ErrorRateLimitStrategy(),
    experimental: { xClientTransactionId: !disableTxHeaders, xpff: !disableTxHeaders },
  });
  try {
    await scraper.setCookies(cookieStrings);
    for await (const _tweet of scraper.searchTweets("xmonitor session validation", 1, SearchMode.Latest)) {
      void _tweet;
      break; // one successful round-trip is enough
    }
    return { ok: true };
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 429) return { ok: true, note: "rate-limited by X, but cookies accepted" };
    if (status !== undefined && [401, 403, 404].includes(status)) {
      return { ok: false, reason: "rejected", detail: `HTTP ${status}` };
    }
    return { ok: false, reason: "network", detail: (err as Error).message };
  }
}

/** Minimal structural type for the parts of Playwright we use. */
interface PlaywrightChromium {
  launch: (opts: { headless: boolean }) => Promise<{
    newContext: () => Promise<{
      newPage: () => Promise<{ goto: (url: string) => Promise<unknown> }>;
      cookies: (url: string) => Promise<Array<Record<string, unknown>>>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  }>;
  launchPersistentContext: (
    userDataDir: string,
    opts: { headless: boolean },
  ) => Promise<{
    cookies: (url: string) => Promise<Array<Record<string, unknown>>>;
    close: () => Promise<void>;
  }>;
}

/** Common desktop Chrome/Chromium profile locations, best first. */
export function detectProfileDir(): string | null {
  const candidates = [
    join(homedir(), ".config", "google-chrome"),
    join(homedir(), ".config", "chromium"),
    join(homedir(), ".config", "google-chrome-beta"),
    join(homedir(), "snap", "chromium", "common", "chromium"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Firefox-family profiles (Firefox, Zen, Floorp): find the base dir whose
 * subdirectory was used most recently.
 */
export function detectFirefoxBaseDir(): string | null {
  const bases = [
    join(homedir(), ".var", "app", "app.zen_browser.zen", ".zen"),
    join(homedir(), ".zen"),
    join(homedir(), ".mozilla", "firefox"),
  ].filter((b) => existsSync(b));
  let best: { dir: string; mtime: number } | null = null;
  for (const base of bases) {
    try {
      for (const entry of readdirSync(base)) {
        const db = join(base, entry, "cookies.sqlite");
        if (!existsSync(db)) continue;
        const mtime = statSync(db).mtimeMs;
        if (!best || mtime > best.mtime) best = { dir: join(base, entry), mtime };
      }
    } catch {
      // unreadable base — skip
    }
  }
  return best?.dir ?? null;
}

/**
 * Read cookies from a Firefox-family profile. Values are stored unencrypted
 * in cookies.sqlite; we work on a copy so a running browser never blocks us.
 */
export function firefoxCookieStrings(profileDir: string, hostSuffix = "x.com"): string[] {
  const dbPath = join(profileDir, "cookies.sqlite");
  if (!existsSync(dbPath)) {
    throw new SessionError(`No cookies.sqlite in ${profileDir}`);
  }
  const tmp = join(tmpdir(), `xm-cookies-${process.pid}-${Date.now()}.sqlite`);
  copyFileSync(dbPath, tmp);
  let tmpDb: DatabaseSync | null = null;
  try {
    tmpDb = new DatabaseSync(tmp);
    const rows = tmpDb
      .prepare(
        `SELECT name, value, host, path, isSecure FROM moz_cookies
         WHERE host LIKE ? AND value != '' ORDER BY name`,
      )
      .all(`%${hostSuffix}`) as Array<{ name: string; value: string; host: string; path: string; isSecure: number }>;
    return rows.map((r) => {
      const attrs = [`Path=${r.path || "/"}`];
      if (r.host.startsWith(".")) attrs.push(`Domain=${r.host}`);
      if (r.isSecure) attrs.push("Secure");
      return `${r.name}=${r.value}; ${attrs.join("; ")}`;
    });
  } finally {
    tmpDb?.close();
    rmSync(tmp, { force: true });
  }
}

/**
 * Read x.com cookies straight out of an installed browser profile.
 * The browser must NOT be running (profile lock). Nothing is displayed;
 * the profile is opened headlessly and closed again.
 */
async function harvestViaProfile(
  pw: PlaywrightChromium,
  profileDir: string,
): Promise<string[]> {
  const lock = join(profileDir, "SingletonLock");
  if (existsSync(lock)) {
    throw new SessionError(
      `Profile is locked (${lock}) — fully quit your browser first, then rerun.`,
    );
  }
  console.error(`[auth] reading cookies from ${profileDir} …`);
  const context = await pw.launchPersistentContext(profileDir, { headless: true });
  try {
    const cookies = await context.cookies("https://x.com");
    const usable = cookies.filter(
      (c) => typeof c["name"] === "string" && c["name"] !== "" && typeof c["value"] === "string" && c["value"] !== "",
    );
    if (!usable.length) {
      throw new SessionError("No x.com cookies found in this profile — log in to x.com in that browser first.");
    }
    return usable.map((c) => {
      const attrs = [`Path=${c["path"] ?? "/"}`];
      if (typeof c["domain"] === "string" && c["domain"]) attrs.push(`Domain=${c["domain"]}`);
      attrs.push("Secure");
      return `${String(c["name"])}=${String(c["value"])}; ${attrs.join("; ")}`;
    });
  } finally {
    await context.close();
  }
}

async function loadPlaywright(): Promise<PlaywrightChromium> {
  try {
    // Optional peer: only needed for --browser/--profile. Keep the specifier
    // dynamic so the package works without Playwright installed.
    const moduleName = "playwright";
    const mod = (await import(moduleName)) as unknown as { chromium: PlaywrightChromium };
    return mod.chromium;
  } catch {
    throw new SessionError(
      'Playwright is not installed. Run:\n  pnpm --filter @copyr/xmonitor add -D playwright\n  pnpm --filter @copyr/xmonitor exec playwright install chromium',
    );
  }
}

async function harvestViaBrowser(timeoutSec: number): Promise<string[]> {
  const pw = await loadPlaywright();

  console.error("[auth] opening x.com login — log in in the opened window (2FA supported)…");
  const browser = await pw.launch({ headless: false });
  try {
    const context = await browser.newContext();
    await (await context.newPage()).goto("https://x.com/login");

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const cookies = await context.cookies("https://x.com");
      if (cookies.some((c) => c["name"] === "auth_token")) {
        console.error("[auth] login detected, capturing cookies…");
        return cookies.map((c) => {
          const attrs = [`Path=${c["path"] ?? "/"}`];
          if (typeof c["domain"] === "string" && c["domain"]) attrs.push(`Domain=${c["domain"]}`);
          attrs.push("Secure");
          return `${String(c["name"])}=${String(c["value"])}; ${attrs.join("; ")}`;
        });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new SessionError(`Timed out after ${timeoutSec}s waiting for login.`);
  } finally {
    await browser.close();
  }
}

/**
 * Interactive auth flow: obtain cookies (--file | --paste | --browser),
 * validate them against x.com live, then persist the refreshed session.
 */
export async function runAuth(opts: AuthOptions, cfg: XMonitorConfig, log: Logger): Promise<AuthResult> {
  let raw: string[];
  if (opts.browser) {
    raw = await harvestViaBrowser(opts.timeoutSec ?? 300);
  } else if (opts.firefox !== undefined && opts.firefox !== false) {
    const dir = typeof opts.firefox === "string" ? opts.firefox : detectFirefoxBaseDir();
    if (!dir) throw new SessionError("No Firefox-family profile found (looked at Zen, .zen, .mozilla/firefox)");
    console.error(`[auth] reading Firefox-family cookies from ${dir} …`);
    raw = firefoxCookieStrings(dir);
  } else if (opts.profile !== undefined && opts.profile !== false) {
    const pw = await loadPlaywright();
    const dir = typeof opts.profile === "string" ? opts.profile : detectProfileDir();
    if (!dir) throw new SessionError("No Chrome/Chromium profile found — pass a path: --profile ~/.config/google-chrome");
    raw = await harvestViaProfile(pw, dir);
  } else if (opts.file) {
    raw = cookieStringsFromContent(readFileSync(opts.file, "utf8"));
  } else if (opts.paste) {
    if (process.stdin.isTTY) console.error("[auth] paste your cookie header, then press Ctrl+D:");
    raw = cookieStringsFromContent(await readStdin());
  } else {
    throw new SessionError("Choose one: --paste, --file <path>, or --browser");
  }

  requireEssentialCookies(raw);

  // Validate against x.com before saving anything.
  const verdict = await validateLive(raw, cfg.disableTxHeaders);
  let validated = false;
  if (verdict.ok) {
    validated = true;
    if (verdict.note) log.warn(verdict.note);
  } else {
    const why =
      verdict.reason === "rejected"
        ? `x.com rejected these cookies (${verdict.detail})`
        : `could not reach x.com to validate (${verdict.detail})`;
    if (!opts.force) {
      throw new SessionError(`${why}. Re-run with --force to save anyway.`);
    }
    log.warn({ why }, "saving unvalidated cookies (--force)");
  }

  mkdirSync(dirname(cfg.sessionFile), { recursive: true });
  writeFileSync(cfg.sessionFile, JSON.stringify(raw, null, 2), "utf8");
  chmodSync(cfg.sessionFile, 0o600);

  return { cookieCount: raw.length, validated, sessionFile: cfg.sessionFile };
}
