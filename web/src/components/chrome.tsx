import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

/* --------------------------------- shared ---------------------------------- */

export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const [ref, setRef] = useState<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(ref);
    return () => io.disconnect();
  }, [ref]);
  return (
    <div
      ref={setRef}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-700 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-paper-500">
      {children}
    </p>
  );
}

export const btnDark =
  "inline-flex h-11 items-center justify-center rounded-lg bg-paper-900 px-6 text-sm font-medium text-paper-50 transition hover:bg-paper-800";
export const btnGhost =
  "inline-flex h-11 items-center justify-center rounded-lg border border-paper-900/15 bg-white/60 px-6 text-sm font-medium text-paper-900 transition hover:border-paper-900/30 hover:bg-white";
export const btnLight =
  "inline-flex h-11 items-center justify-center rounded-lg bg-paper-50 px-6 text-sm font-medium text-paper-900 transition hover:bg-white";

export function IconCheck({ className = "" }: { className?: string }) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Sister mark of the Copyr "C" tile — same tile, signal accent. */
export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className={`relative flex h-7 w-7 items-center justify-center rounded-md font-serif text-base font-semibold ${
          light ? "bg-paper-50 text-paper-900" : "bg-paper-900 text-paper-50"
        }`}
      >
        C
        <i className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ${light ? "bg-brand-400 ring-paper-900" : "bg-brand-500 ring-paper-100"}`} />
      </span>
      <span className={`font-serif text-xl tracking-tight ${light ? "text-paper-50" : "text-paper-900"}`}>
        Copyr{" "}
        <span className={`font-sans text-sm font-medium tracking-normal ${light ? "text-paper-400" : "text-paper-500"}`}>
          Intelligence
        </span>
      </span>
    </span>
  );
}

/* ----------------------------------- nav ----------------------------------- */

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const overDarkHero = pathname === "/";
  const solid = scrolled || !overDarkHero;
  const links = [
    ["Playground", "/playground"],
  ] as const;
  const adminLinks = [
    ["Updates", "/updates"],
    ["Analytics", "/analytics"],
    ["Waiting room", "/exoskeleton"],
  ] as const;
  const linkCls = solid
    ? "text-sm text-paper-600 transition hover:text-paper-900"
    : "text-sm text-paper-300 transition hover:text-white";
  const activeLinkCls =
    "text-sm font-medium text-brand-700 transition hover:text-brand-600";
  return (
    <header
      className={`sticky top-0 z-40 backdrop-blur-md transition-colors duration-300 ${
        solid ? "border-b border-paper-900/[0.08] bg-paper-100/85" : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link to="/" aria-label="Copyr Intelligence home">
          <Logo light={overDarkHero && !scrolled} />
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          {links.map(([label, href]) => (
            <Link key={href} to={href} className={pathname === href ? activeLinkCls : linkCls}>
              {label}
            </Link>
          ))}
          <span className={`hidden h-4 w-px md:block ${solid ? "bg-paper-900/15" : "bg-white/20"}`} aria-hidden="true" />
          <span className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${solid ? "text-paper-400" : "text-paper-500"}`}>
            Admin
          </span>
          {adminLinks.map(([label, href]) => (
            <Link
              key={href}
              to={href}
              className={
                pathname === href || (label === "Updates" && pathname === "/latest")
                  ? activeLinkCls
                  : linkCls
              }
            >
              {label}
            </Link>
          ))}
          <a href="/openapi.json" className={linkCls}>
            Docs
          </a>
        </nav>
        <a
          href="mailto:api@copyr.example"
          className={
            solid
              ? "inline-flex h-9 items-center rounded-lg bg-paper-900 px-4 text-sm font-medium text-paper-50 transition hover:bg-paper-800"
              : "inline-flex h-9 items-center rounded-lg bg-white/90 px-4 text-sm font-medium text-paper-900 transition hover:bg-white"
          }
        >
          Get an API key
        </a>
      </div>
    </header>
  );
}

/* ---------------------------------- footer ---------------------------------- */

export function Footer() {
  const cols: Array<[string, Array<[string, string]>]> = [
    ["Product", [["News & signals", "/#signals"], ["Pipeline", "/#pipeline"], ["ListGen", "/#api"]]],
    [
      "Developers",
      [
        ["API playground", "/playground"],
        ["Updates", "/updates"],
        ["Analytics", "/analytics"],
        ["Waiting room", "/exoskeleton"],
        ["OpenAPI spec", "/openapi.json"],
        ["API keys", "mailto:api@copyr.example"],
      ],
    ],
    ["Platform", [["Copyr CRM", "https://copyr.dev"], ["Contact", "mailto:api@copyr.example"]]],
  ];
  return (
    <footer className="border-t border-paper-900/[0.08] bg-white/40">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col justify-between gap-10 md:flex-row">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-paper-500">
              A news-intelligence API for VCs — company-resolved records, structured facts,
              and lists. Own product, own database.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10 text-sm sm:grid-cols-3">
            {cols.map(([heading, links]) => (
              <div key={heading}>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-500">{heading}</p>
                <ul className="space-y-2">
                  {links.map(([label, href]) => (
                    <li key={label}>
                      {href === "/playground" || href === "/updates" || href === "/analytics" || href === "/exoskeleton" ? (
                        <Link to={href} className="text-paper-600 transition hover:text-paper-900">{label}</Link>
                      ) : (
                        <a href={href} className="text-paper-600 transition hover:text-paper-900">{label}</a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-12 border-t border-paper-900/[0.08] pt-6 text-xs text-paper-400">
          © 2026 Copyr Intelligence.
        </p>
      </div>
    </footer>
  );
}
