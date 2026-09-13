import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Eyebrow,
  IconCheck,
  Reveal,
  btnDark,
  btnGhost,
  btnLight,
} from "../components/chrome";

/* ------------------------------- hero visuals ------------------------------ */

/** Generative grain field — drifting pixel noise, greyscale with faint brand accents. */
function TextureField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 132;
    const H = 74;
    canvas.width = W;
    canvas.height = H;

    const hash = (x: number, y: number) => {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    const fade = (t: number) => t * t * (3 - 2 * t);
    const noise = (x: number, y: number) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = x - xi;
      const yf = y - yi;
      const a = hash(xi, yi);
      const b = hash(xi + 1, yi);
      const c = hash(xi, yi + 1);
      const dd = hash(xi + 1, yi + 1);
      const u = fade(xf);
      const v = fade(yf);
      return a + (b - a) * u + (c - a) * v + (a - b - c + dd) * u * v;
    };

    const img = ctx.createImageData(W, H);
    let raf = 0;
    let last = -1000;

    const paint = (ms: number) => {
      const t = ms / 9000;
      const data = img.data;
      let i = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let n =
            noise(x * 0.045 + t, y * 0.08 - t * 0.6) * 0.65 +
            noise(x * 0.14 - t * 0.5, y * 0.22 + t * 0.3) * 0.35;
          n += (hash(x * 7.7, y * 13.3) - 0.5) * 0.16;
          const yy = y / H;
          const band = Math.exp(-((yy - 0.36) * (yy - 0.36)) / 0.09);
          const lum = Math.min(255, 20 + n * 74 * (0.35 + band));
          let rr = lum;
          let gg = lum;
          let bb = lum;
          const acc = noise(x * 0.26 + 40 + t * 0.8, y * 0.26 + 13);
          if (acc > 0.76 && n > 0.5) {
            const k = ((acc - 0.76) / 0.24) * 0.55;
            rr += (124 - rr) * k;
            gg += (133 - gg) * k;
            bb += (219 - bb) * k;
          }
          data[i++] = rr;
          data[i++] = gg;
          data[i++] = bb;
          data[i++] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    const loop = (ms: number) => {
      if (ms - last > 140) {
        last = ms;
        paint(ms);
      }
      raf = requestAnimationFrame(loop);
    };

    paint(0);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      raf = requestAnimationFrame(loop);
    }
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-[#101014]">
      <canvas ref={ref} className="h-full w-full [image-rendering:pixelated]" aria-hidden="true" />
      <svg className="absolute inset-0 h-full w-full opacity-[0.08] mix-blend-overlay" aria-hidden="true">
        <filter id="film-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#film-grain)" />
      </svg>
      <div className="absolute left-1/2 top-[-25%] h-[60%] w-[80%] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.06),transparent)]" />
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_-10%,transparent_45%,rgba(0,0,0,0.5)_100%)]" />
    </div>
  );
}

type SignalRow = [
  publisher: string,
  time: string,
  title: string,
  entity: string,
  event: string,
  eventCls: string,
  score: string,
];

const SIGNALS: SignalRow[] = [
  [
    "TechCrunch",
    "09:41",
    "Acme Robotics raises $12M Series A led by Harbor VC to scale warehouse fleets",
    "Acme Robotics",
    "Series A",
    "border-brand-300 bg-brand-50 text-brand-800",
    "+0.62",
  ],
  [
    "Bloomberg",
    "08:17",
    "Nimbus Robotics acquires RouteSense in push into last-mile delivery",
    "Nimbus Robotics",
    "M&A",
    "border-violet-400/40 bg-violet-400/15 text-violet-600",
    "−0.18",
  ],
  [
    "Sifted",
    "Yesterday",
    "DataFlow opens Berlin office, hires 30 across go-to-market and infra",
    "DataFlow",
    "Expansion",
    "border-emerald-300 bg-emerald-50 text-emerald-800",
    "+0.34",
  ],
];

function HeroMock() {
  return (
    <div className="overflow-hidden rounded-xl border border-paper-900/[0.14] bg-white shadow-[0_1px_2px_rgba(23,22,19,0.06),0_32px_64px_-32px_rgba(23,22,19,0.35)]">
      <div className="flex items-center gap-3 border-b border-paper-900/[0.1] bg-paper-50 px-4 py-2.5">
        <span className="flex gap-1.5">
          <i className="h-2.5 w-2.5 rounded-full bg-paper-300" />
          <i className="h-2.5 w-2.5 rounded-full bg-paper-300" />
          <i className="h-2.5 w-2.5 rounded-full bg-paper-300" />
        </span>
        <span className="mx-auto hidden max-w-full truncate rounded-md border border-paper-900/[0.14] bg-white px-3 py-1 font-mono text-[11px] font-medium text-paper-600 sm:block">
          api.copyr.dev/v1/news?company=acme.ai&amp;unique_article=true
        </span>
        <span className="w-10 sm:hidden" />
      </div>

      <p className="flex items-center justify-between border-b border-paper-900/[0.1] bg-white px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-paper-600">
        Signals · last 24h
        <span className="num rounded-full bg-paper-100 px-1.5 text-[9px] text-paper-700 ring-1 ring-paper-900/[0.15]">3 new</span>
      </p>

      <div className="divide-y divide-paper-900/[0.09]">
        {SIGNALS.map(([pub, time, title, entity, event, eventCls, score]) => (
          <article key={title} className="px-4 py-3.5">
            <p className="num flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-paper-500">
              {pub} · {time}
              <span className="rounded-full border border-paper-900/[0.16] bg-paper-50 px-1.5 py-px tracking-normal text-paper-700">{entity}</span>
            </p>
            <p className="mt-1 text-sm font-semibold leading-snug text-paper-900">{title}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-paper-600">
              <span className={`rounded-full border px-2 py-0.5 ${eventCls}`}>{event}</span>
              <span className="num rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-800">
                sentiment {score}
              </span>
              <span className="rounded-full border border-paper-900/[0.16] bg-paper-100 px-2 py-0.5 text-paper-700">
                newsworthiness high
              </span>
            </p>
          </article>
        ))}
      </div>

      <div className="border-t border-paper-900/[0.1] bg-paper-50 px-4 py-2.5">
        <p className="font-serif text-[13px] italic leading-snug text-paper-700">
          <span className="mr-1.5 rounded border border-brand-300 bg-brand-50 px-1 py-px font-sans text-[9px] font-bold not-italic uppercase tracking-wide text-brand-700">
            AI summary
          </span>
          Acme's round is its first institutional raise; coverage spans four tier-1 outlets.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------- hero ---------------------------------- */

function Hero() {
  return (
    <section id="signals" className="relative -mt-16 overflow-hidden scroll-mt-20">
      <TextureField />
      <div className="relative mx-auto max-w-6xl px-4 pt-36 sm:px-6 md:pt-44">
        <Reveal className="text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] py-1.5 pl-3 pr-3.5 text-xs font-medium text-paper-300 backdrop-blur-sm">
            <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-paper-50">
              Sister service
            </span>
            Plugs straight into Copyr deal flow over REST &amp; webhooks
          </span>
          <h1 className="mx-auto mt-7 max-w-4xl font-serif text-[44px] leading-[1.04] tracking-tight text-paper-50 sm:text-6xl md:text-7xl">
            Every market move, <em className="italic text-brand-300">already resolved.</em>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-paper-400">
            Copyr Intelligence continuously reads the business news, resolves every story to the right
            company — namesake-safe — and serves enriched signals to your agents through one clean API.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a href="mailto:api@copyr.example" className={btnLight}>Get an API key</a>
            <Link
              to="/playground"
              className="inline-flex h-11 items-center justify-center rounded-lg border border-white/20 bg-white/[0.04] px-6 text-sm font-medium text-paper-100 transition hover:border-white/40 hover:bg-white/[0.09]"
            >
              Try the API live →
            </Link>
          </div>
          <p className="mt-4 text-xs text-paper-500">OpenAPI 3.1 spec generated from contracts · excerpt-only licensing by default</p>
        </Reveal>
        <Reveal delay={150} className="mt-14 md:mt-20">
          <HeroMock />
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------- chip marquee ----------------------------- */

function ChipMarquee() {
  const chips = [
    "Entity resolution", "80+ event types", "Sentiment scoring", "Newsworthiness tiers",
    "Story clustering", "ListGen queries", "GDELT recall", "Alias index matching",
    "Funding-stage facts", "Industry & geo tags", "AI summaries", "HMAC webhooks",
  ];
  const row = [...chips, ...chips];
  return (
    <div className="mt-16 border-y border-paper-900/[0.08] bg-white/40 py-4 md:mt-24">
      <div className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="animate-marquee flex w-max gap-3">
          {row.map((c, i) => (
            <span
              key={`${c}-${i}`}
              className="whitespace-nowrap rounded-full border border-paper-900/[0.09] bg-paper-50 px-4 py-1.5 text-sm text-paper-600"
            >
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- stats ---------------------------------- */

function StatsBand() {
  const stats: Array<[string, string]> = [
    ["15 min", "from publish to a searchable, enriched signal — p90"],
    ["80+",    "event types across funding, M&A, leadership and more"],
    ["$0.001", "blended LLM cost per enriched article, capped monthly"],
    ["133",    "companies scored every month on the open benchmark"],
  ];
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
      <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(([big, small], i) => (
          <Reveal key={big} delay={i * 80}>
            <p className="num border-t border-paper-900/15 pt-5 font-serif text-4xl tracking-tight text-paper-900 md:text-5xl">
              {big}
            </p>
            <p className="mt-2 max-w-[230px] text-sm leading-relaxed text-paper-600">{small}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------- how it works ----------------------------- */

function HowItWorks() {
  const steps: Array<[string, string]> = [
    ["Ingest", "Hundreds of curated RSS feeds plus GDELT, polled politely and deduped at the door."],
    ["Resolve", "Every article is tied to a company via alias indexes and domain evidence — LLM judges only the ties."],
    ["Enrich", "Event taxonomy, sentiment, newsworthiness, industry, geography and a neutral AI summary."],
    ["Serve", "Signals land on a clean REST API under /v1, ready for Copyr, agents or your own stack."],
  ];
  return (
    <section id="pipeline" className="scroll-mt-20 border-y border-paper-900/[0.08] bg-white/40">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
        <Reveal>
          <Eyebrow>The pipeline</Eyebrow>
          <h2 className="mt-3 max-w-2xl font-serif text-4xl leading-[1.08] tracking-tight text-paper-900 md:text-5xl">
            From raw feed to resolved signal, without the busywork
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map(([title, body], i) => (
            <Reveal key={title} delay={i * 90}>
              <p className="num border-t border-paper-900/15 pt-5 font-serif text-3xl italic text-paper-400">
                {String(i + 1).padStart(2, "0")}
              </p>
              <p className="mt-3 text-[15px] font-semibold text-paper-900">{title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-paper-600">{body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- api section ------------------------------ */

const ENDPOINTS = [
  "GET /v1/news",
  "GET /v1/companies/:id",
  "GET /v1/companies/search",
  "POST /v1/list/generate/companies",
  "GET /v1/feed",
];

function CurlMock() {
  return (
    <div className="flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/40">
      <p className="border-b border-white/10 px-4 py-2.5 font-mono text-[11px] text-paper-400">
        News by company · unique stories only
      </p>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-paper-200">
{`curl https://api.copyr.dev/v1/news \\
  -H "x-api-key: $INTELLIGENCE_KEY" \\
  --data-urlencode company=acme.ai \\
  --data-urlencode unique_article=true`}
      </pre>
    </div>
  );
}

function ApiSection() {
  return (
    <section id="api" className="scroll-mt-20 bg-paper-900">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <Eyebrow>Agent-first</Eyebrow>
            <h2 className="mt-3 max-w-xl font-serif text-4xl leading-[1.08] tracking-tight text-paper-50 md:text-5xl">
              Built for agents first, humans welcome.
            </h2>
            <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-paper-400">
              Like Copyr itself, the intelligence layer treats agents as first-class clients:
              a thin REST surface with predictable shapes, an OpenAPI spec generated from zod
              contracts, and an MCP server exposing the same core tools.
            </p>
            <ul className="mt-7 space-y-2.5 text-sm text-paper-300">
              {[
                "Auth via hashed x-api-key keys, rate-limited per key",
                "Pagination envelopes with total/count/offset on every list",
                "Excerpt + attribution by default; takedown endpoint honored",
                "Webhooks with signed payloads and backoff retries",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <IconCheck className="mt-0.5 text-emerald-400" />
                  {item}
                </li>
              ))}
            </ul>
            <Link
              to="/playground"
              className="mt-8 inline-flex h-11 items-center justify-center rounded-lg border border-white/20 bg-white/[0.06] px-6 text-sm font-medium text-paper-100 transition hover:border-white/40 hover:bg-white/[0.12]"
            >
              Query it yourself — open the playground →
            </Link>
          </Reveal>
          <Reveal delay={140}>
            <div className="flex h-full flex-col gap-5">
              <CurlMock />
              <div className="flex flex-wrap gap-2">
                {ENDPOINTS.map((ep) => (
                  <code
                    key={ep}
                    className="rounded-md border border-white/15 bg-white/[0.06] px-2.5 py-1 font-mono text-[11px] text-paper-300"
                  >
                    {ep}
                  </code>
                ))}
                <span className="rounded-md px-2 py-1 font-mono text-[11px] text-paper-500">+ MCP server</span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- final CTA -------------------------------- */

function FinalCta() {
  return (
    <section className="border-t border-paper-900/[0.08]">
      <div className="mx-auto max-w-4xl px-4 py-24 text-center sm:px-6 md:py-32">
        <Reveal>
          <h2 className="font-serif text-5xl leading-[1.05] tracking-tight text-paper-900 md:text-6xl">
            Bring <em className="italic text-brand-700">signal</em> to your deal flow.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-paper-600">
            Point a client at <span className="font-mono text-base">/v1</span> and pull your first
            resolved signals in minutes — no schema mapping, no scraping.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a href="mailto:api@copyr.example" className={btnDark}>Get an API key</a>
            <a href="/openapi.json" className={btnGhost}>Browse the OpenAPI spec →</a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ----------------------------------- page ----------------------------------- */

export default function Landing() {
  return (
    <main>
      <Hero />
      <ChipMarquee />
      <StatsBand />
      <HowItWorks />
      <ApiSection />
      <FinalCta />
    </main>
  );
}
