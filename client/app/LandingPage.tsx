"use client";

import './shift5.css';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useWalletStore } from '@/stores/wallet';
import { freighterIsInstalled } from '@/lib/stellar/freighter';
import { useEffect, useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { ACTIVE_MARKET_SYMBOLS, DEFAULT_MARKET_SYMBOL, NETWORK_LABEL } from '@/config';
import { useNetwork } from '@/features/network/NetworkContext';

const LANDING_NAV = [
  { to: `/trade/${DEFAULT_MARKET_SYMBOL}`, label: 'Trade' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/leaderboard', label: 'Leaderboard' },
  // Docs is a static Docusaurus build served from this same deployment at /docs.
  // Use a plain anchor (hardNav) so it does a real navigation to the static site
  // instead of client-side routing — there is no /docs route in the Next app.
  { to: '/docs', label: 'Docs', hardNav: true },
];

const SYSTEM_STATUS = [
  '01. Oracle Feed', '02. CLOB Matcher', '03. Margin Engine', '04. Vault', '05. Order Gateway',
  '06. Liquidation', '07. Insurance Fund', '08. Risk Engine',
  '09. Funding', '10. State Indexer',
];

// A function, not a const: the first headline names the selected network, which
// is only known per-render. Building it at module scope would bake in the
// deployment's own network and hydrate-mismatch for anyone on the other venue.
const buildHeadlines = (networkLabel: string) => [
  { title: `${ACTIVE_MARKET_SYMBOLS.length} Perpetual Markets Live on ${networkLabel}`, desc: `${ACTIVE_MARKET_SYMBOLS.map((s) => s.replace('-PERP', '')).join(' · ')} — USDC-settled perpetual futures with on-chain margin and settlement, traded self-custodial straight from your Freighter wallet.` },
  { title: 'Kryon Brings Perpetuals to Stellar', desc: 'A decentralized exchange pairing an off-chain central-limit order book with a fully on-chain margin and settlement engine on Soroban.' },
  { title: 'Sub-Second Fills, On-Chain Truth', desc: 'Price-time matching off-chain for a familiar low-latency perp experience, with custody, margin, and settlement enforced on-chain.' },
];

const SOLUTIONS = [
  { title: 'Perpetuals', desc: 'Trade perpetual futures on tokenized real-world assets and crypto, USDC-settled, with leverage and transparent funding.' },
  { title: 'On-Chain Settlement', desc: 'Collateral, margin, and settlement live on Soroban. You keep your keys — every fill settles to a contract you control.' },
  { title: 'CLOB Matching', desc: 'An off-chain central-limit order book matches orders price-time for low-latency fills, while on-chain state stays the source of truth.', accent: true },
  { title: 'Risk & Liquidation', desc: 'A transparent margin engine, funding mechanism, and insurance-backed liquidation keep markets solvent and fair.' },
];

const INSIGHTS = [
  { title: 'XLM-PERP Goes Live — USDC-Settled Perpetuals on Stellar', date: 'May 28, 2026', desc: 'Protocol Launch', featured: true },
  { title: 'On-Chain Margin & Settlement, Off-Chain Speed', date: 'May 20, 2026', desc: 'How Kryon pairs a price-time CLOB matcher with a Soroban settlement engine.' },
  { title: 'Self-Custodial Trading with Freighter', date: 'May 6, 2026', desc: 'Sign orders from your own wallet — your keys, your collateral, every fill.' },
  { title: 'Understanding Funding & Mark Price on Kryon', date: 'April 24, 2026', desc: 'How the funding mechanism anchors perp prices to the oracle.' },
  { title: 'Inside the Liquidation & Insurance Engine', date: 'April 11, 2026', desc: 'Transparent margin checks and an insurance fund that keeps markets solvent.' },
  { title: 'The Road to Perpetuals', date: 'March 30, 2026', desc: 'Bringing tokenized real-world assets to perpetual futures on Stellar.' },
  { title: 'Oracle Design: Pricing Perps on Soroban', date: 'March 18, 2026', desc: 'How the oracle adapter publishes the prices the engine settles against.' },
  { title: 'Leaderboard & Portfolio Analytics', date: 'March 5, 2026', desc: 'Track PnL, open interest, and ranking across every market in real time.' },
  { title: 'Kryon Stress-Test Report: Production Hardening', date: 'February 20, 2026', desc: 'Findings and fixes from load-testing the matcher, indexer, and settlement path.' },
];

function LoadingOverlay() {
  const [exit, setExit] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const start = Date.now();
    const minDelay = 2400;
    function dismiss() {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, minDelay - elapsed);
      setTimeout(() => {
        setExit(true);
        setTimeout(() => setGone(true), 1500);
      }, remaining);
    }
    if (document.readyState === 'complete') {
      dismiss();
    } else {
      window.addEventListener('load', dismiss, { once: true });
      return () => window.removeEventListener('load', dismiss);
    }
  }, []);

  if (gone) return null;

  return (
    <div id="s5-loader" className={exit ? 's5-loader--exit' : ''}>
      <div id="s5-loader-content">
        <div id="s5-loader-seq">
          <svg viewBox="0 0 480 360" fill="inherit" stroke="inherit">
            <path fill="none" strokeLinecap="round" strokeLinejoin="round" d="M352 180c0 61.909-50.091 112-112 112s-112-50.091-112-112S178.091 68 240 68s112 50.091 112 112Z"/>
            <path fill="none" strokeLinecap="round" strokeLinejoin="round" d="M240 90.397c-49.529 0-89.604 40.074-89.604 89.603 0 49.529 40.075 89.603 89.604 89.603 49.528 0 89.603-40.074 89.603-89.603 0-49.529-40.075-89.603-89.603-89.603Z"/>
            <path fill="none" strokeLinecap="round" strokeLinejoin="round" d="M307.198 180c0 37.14-30.057 67.198-67.198 67.198-37.14 0-67.198-30.058-67.198-67.198 0-37.14 30.058-67.198 67.198-67.198 37.141 0 67.198 30.058 67.198 67.198Z"/>
            <path fill="none" strokeLinecap="round" strokeLinejoin="round" d="M239.999 135.198c-24.76 0-44.802 20.042-44.802 44.802 0 24.76 20.042 44.802 44.802 44.802 24.76 0 44.801-20.042 44.801-44.802 0-24.76-20.041-44.802-44.801-44.802ZM240 180V68m-56 112h112m-56 0v112m112-112H128.065M240 180l93.474-93.475"/>
            <circle cx="173" cy="139" r="4" stroke="none" fill="inherit"/>
          </svg>
          <svg viewBox="0 0 480 360" fill="none" stroke="inherit">
            <path strokeLinecap="round" strokeLinejoin="round" d="M240.004 275.192c52.571 0 95.188-42.617 95.188-95.188 0-52.57-42.617-95.187-95.188-95.187-52.571 0-95.188 42.617-95.188 95.187 0 52.571 42.617 95.188 95.188 95.188Zm0-89.585v-11.205M136.501 76.561l22.538 22.547m-11.205 0h11.206m-.001-11.214v11.214m184.468-22.547L320.96 99.108m11.214 0H320.96m0-11.214v11.214m22.547 184.34-22.547-22.547m-184.459 22.547 22.538-22.547m-11.205 0h11.206m-.001 11.214v-11.214"/>
            <path strokeMiterlimit="10" d="M302.084 242.092 256.55 196.55m41.457 49.619 8.162-8.162M177.916 117.916l45.543 45.543m-41.466-49.62-8.154 8.154m4.077 120.099 45.543-45.542m-49.62 41.457 8.154 8.162m120.091-128.253-45.534 45.543m49.619-41.466-8.162-8.154"/>
            <path strokeMiterlimit="10" d="M136.137 184.06H128m8.281 7.765H128m8.281-23.293H128m8.281 7.764H128m8.281-23.294H128m8.281 7.756H128m8.281-23.284H128m8.281 7.764H128m8.281-23.293H128m8.281 7.764H128m8.281 7.764H128"/>
            <path strokeMiterlimit="10" d="M344.135 184.06H352m-8.281 7.765H352m-8.281-23.293H352m-8.281 7.764H352m-8.281-23.294H352m-8.281 7.756H352m-8.281-23.284H352m-8.281 7.764H352m-8.281-23.293H352m-8.281 7.764H352m-8.281 7.764H352"/>
            <path strokeMiterlimit="10" d="M240 76.281V68m-7.765 8.281V68m7.765 16.562V68m-23.293 24.843V68m7.764 16.562V68m-23.294 24.843V68m7.756 16.562V68m-23.284 24.843V68m7.764 16.562V68m-23.293 24.843V68m7.764 16.562V68"/>
            <path strokeMiterlimit="10" d="M240 283.719V292m-7.765-8.281V292m7.765-16.562V292m-23.293-24.843V292m7.764-16.562V292m-23.294-24.843V292m7.756-16.562V292m-23.284-24.843V292m7.764-16.562V292m-23.293-24.843V292m7.764-16.562V292"/>
            <path strokeMiterlimit="10" d="M244.141 93.659h-8.282m8.282 8.619h-8.282m8.282 8.629h-8.282m8.282 8.62h-8.282m8.282 8.629h-8.282m8.282 8.621h-8.282m8.282 17.249h-8.282m8.282 8.628h-8.282m8.282 8.621h-8.282m8.282 8.628h-8.282m8.282 8.629h-8.282"/>
            <line x1="157.293" y1="180.43" x2="144.809" y2="180.43"/>
          </svg>
          <svg viewBox="0 0 480 360" fill="none" stroke="inherit">
            <path d="M239.992 90v180M408 179.993H72"/>
            <circle cx="241.492" cy="181.5" r="59.5"/>
            <path d="M241.492 122c33.076 0 62.996 6.704 84.629 17.521 21.663 10.831 34.871 25.702 34.871 41.979 0 16.277-13.208 31.148-34.871 41.98-21.633 10.816-51.553 17.52-84.629 17.52-33.076 0-62.996-6.704-84.629-17.52-21.662-10.832-34.871-25.703-34.871-41.98 0-16.277 13.209-31.148 34.871-41.979C178.496 128.704 208.416 122 241.492 122Z"/>
            <path d="M239.99 121.569c24.768 0 47.169 6.693 63.363 17.489 16.197 10.798 26.137 25.661 26.137 42.011 0 16.349-9.94 31.212-26.137 42.011-16.194 10.795-38.595 17.489-63.363 17.489s-47.168-6.694-63.362-17.489c-16.197-10.799-26.138-25.662-26.138-42.011 0-16.35 9.941-31.213 26.138-42.011 16.194-10.796 38.594-17.489 63.362-17.489Z"/>
          </svg>
          <svg viewBox="0 0 480 360" fill="none" stroke="inherit">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="m312.724 110.01-24.292-13.95-48.504 27.98-48.504-27.98-24.212 13.95 72.716 42.01 72.796-42.01ZM143 180.08v27.98l24.212 13.95v27.98l24.212 14.03v-55.96L143 180.08Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="m336.936 124.04-24.212-14.03-72.796 42.01-72.716-42.01L143 124.04 239.928 180l97.008-55.96ZM143 208.06v27.98l24.212 13.95v-27.98L143 208.06Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="M288.432 96.06 264.22 82.03l-24.292 14.03-24.212-14.03-24.292 14.03 48.504 27.98 48.504-27.98ZM143 152.02v28.06l48.424 27.98v55.96l24.292 14.03v-84.02L143 152.02Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="M264.22 82.03 239.928 68l-24.212 14.03 24.212 14.03 24.292-14.03Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="m288.432 96.06 24.292 14.03 24.212-14.03-72.796-42.01-24.212 14.03 24.292 13.95 24.212 14.03ZM336.936 124.04l-24.212-14-24.292 14.03 24.212 13.95 24.292-13.98Zm0 0 24.064 13.95v27.98L337 152.1v-27.98-.08Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="m337 152.1 23.98 13.95v27.98L337 180.08V152.1Zm0 27.98 23.98 13.97v27.98L337 208.06V180.08Zm0 27.98 23.98 13.95v27.98l-24.211 13.95v-27.98l.231-.08 24.06-13.95v-.08L337 236.04v-27.98Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="M337 236.04 312.724 250l-24.292 14.02v-55.96l24.292-13.95-.08 84.02 24.356-14.03v-27.98-.08Zm-48.568 27.98L264.22 278l-24.292-14.03v-84.02l24.292 14.02V278l24.212-13.95-.08-84.02 72.796-42.01v-27.98L239.927 180Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="M239.928 180 143 124.04v27.98l72.716 42.01v84.02L239.928 292V180Zm-.001 0v112-112Zm72.797 69.99 24.211-13.95v-27.98l-24.211 13.95v27.98Z"/>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" d="m288.512 264.02 24.212-14.03v-27.98l24.212-13.95v-27.98l-48.504 27.98.08 55.96Z"/>
          </svg>
        </div>
        <div id="s5-loader-text">Loading...</div>
      </div>
    </div>
  );
}

function genBinaryBlock(): string {
  const g = () => Array.from({ length: 8 }, () => Math.round(Math.random())).join('');
  return `${g()}  ${g()}  ${g()}`;
}

// Deterministic seeds for SSR — random values are filled in on mount so the
// server-rendered HTML matches the client's first render (no hydration mismatch).
const b8 = (n: number) => (n & 0xff).toString(2).padStart(8, '0');
const INITIAL_BINARY: string[] = Array.from({ length: 9 }, (_, i) =>
  `${b8(i * 53 + 11)}  ${b8(i * 97 + 7)}  ${b8(i * 29 + 131)}`,
);
const INITIAL_GRAPH_H = 0.5;

function SplitChars({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  return (
    <span className={className} aria-label={text}>
      {Array.from(text).map((char, i) => (
        <span
          key={i}
          className="s5-chr"
          style={{ animationDelay: `${(delay + i * 0.028).toFixed(3)}s` }}
          aria-hidden="true"
        >
          {char === ' ' ? ' ' : char}
        </span>
      ))}
    </span>
  );
}

function useRevealRef<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e?.isIntersecting) { el.classList.add('s5-visible'); io.unobserve(el); } },
      { threshold: 0.08 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

const CAROUSEL_CLONES = 2;

const DOT_POSITIONS = (() => {
  const pts: { x: number; y: number; r: number }[] = [];
  const N = 260, R = 108, cx = 240, cy = 180;
  for (let i = 0; i < N; i++) {
    const phi = Math.acos(1 - 2 * (i + 0.5) / N);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const x = cx + R * Math.sin(phi) * Math.cos(theta);
    const y = cy + R * 0.62 * Math.cos(phi);
    const r = 1.2 + Math.sin(phi) * 3;
    pts.push({ x, y, r });
  }
  return pts;
})();

function SolSvg({ idx }: { idx: number; active: boolean }) {
  if (idx === 0) return (
    <svg viewBox="0 0 480 360" fill="none" stroke="currentColor" strokeWidth="1" className="s5-sol-icon">
      <circle cx="240" cy="180" r="112"/><ellipse cx="240" cy="180" rx="89" ry="112"/>
      <ellipse cx="240" cy="180" rx="59" ry="112"/><ellipse cx="240" cy="180" rx="26" ry="112"/>
      <ellipse cx="240" cy="148" rx="107" ry="21"/><ellipse cx="240" cy="212" rx="107" ry="21"/>
      <ellipse cx="240" cy="116" rx="84" ry="14"/><ellipse cx="240" cy="244" rx="84" ry="14"/>
      <ellipse cx="240" cy="91" rx="48" ry="7"/><ellipse cx="240" cy="269" rx="48" ry="7"/>
      <line x1="240" y1="68" x2="240" y2="292"/><line x1="128" y1="180" x2="352" y2="180"/>
      <line x1="240" y1="180" x2="333" y2="87"/>
      <circle cx="173" cy="139" r="4" fill="currentColor" stroke="none"/>
    </svg>
  );
  if (idx === 1) return (
    <svg viewBox="0 0 480 360" fill="currentColor" className="s5-sol-icon">
      {DOT_POSITIONS.map((p, i) => (
        <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={p.r.toFixed(1)} />
      ))}
    </svg>
  );
  if (idx === 2) return (
    <svg viewBox="0 0 480 360" fill="currentColor" className="s5-sol-icon">
      <path d="m240.498 176.175 28.005-104.489.483.13.483.13-28.005 104.513 54.102-93.704.866.5-54.104 93.705 76.514-76.509.707.707-76.511 76.507 93.707-54.097.5.866-93.709 54.097 104.519-28.001.129.484.129.483-104.519 28.001H352v1H243.798l104.515 28.005-.129.483-.129.483-104.518-28.005 93.708 54.102-.5.866-93.71-54.104 76.514 76.514-.707.707-76.514-76.514 54.104 93.71-.866.5-54.102-93.708 28.005 104.518-.483.129-.483.129-28.005-104.515V292h-1V183.794l-28.005 104.519-.483-.129-.484-.129 28.005-104.518-54.101 93.708-.866-.5 54.101-93.708-76.507 76.512-.707-.707 76.507-76.512-93.703 54.102-.5-.866 93.703-54.102-104.512 28.005-.13-.483-.129-.483 104.507-28.005H128v-1h108.201l-104.514-28.001.259-.967 104.51 28-93.701-54.096.5-.866 93.701 54.095-76.505-76.505.707-.707 76.508 76.508-54.102-93.704.866-.5 54.102 93.706-28.006-104.515.967-.26 28.005 104.518V68h1v108.175Z"/>
    </svg>
  );
  return (
    <svg viewBox="0 0 480 360" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="s5-sol-icon">
      <path d="m240.088 214.66-60.044 34.67 60.044 34.661 60.044-34.661-60.044-34.67Zm.001 0 60.045 34.67V180l-60.045-34.67v69.33Z"/>
      <path d="M240.089 145.33 300.134 180v-.009L240.089 76v69.33ZM300.132 180v69.33l60.045 34.669L300.132 180Z"/>
      <path d="m300.134 249.33-60.045 34.661h120.08l-60.044-34.669Zm-120.09 0V180l-60.035 103.99 60.035-34.66Zm-60.045-34.669 60.044-34.67v-69.33L180.044 180v69.33Zm60.044-104V76l-60.044 104 60.044-34.67Z"/>
      <path d="m180.044 249.33-60.035 34.661h120.089l-60.045-34.661Z"/>
    </svg>
  );
}

export function LandingPage() {
  const router = useRouter();
  const { connected, connecting, setConnecting, setAddress, setConnected, setWrongNetwork } = useWalletStore();
  // Server-seeded, so the network-named headline matches on hydration.
  const { config: networkConfig } = useNetwork();
  const headlines = buildHeadlines(networkConfig.label);

  const [activeStatus, setActiveStatus] = useState(0);
  const [binaryRows, setBinaryRows] = useState<string[]>(INITIAL_BINARY);
  const [menuOpen, setMenuOpen] = useState(false);
  const [graphH, setGraphH] = useState(INITIAL_GRAPH_H);
  const [cardIdx, setCardIdx] = useState(CAROUSEL_CLONES);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [ftEmail, setFtEmail] = useState('');
  const [ftSubscribed, setFtSubscribed] = useState(false);
  const dragStartX = useRef<number | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [scrollY, setScrollY] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const scrolled = el.scrollTop || document.body.scrollTop;
      const total = el.scrollHeight - el.clientHeight;
      setScrollProgress(total > 0 ? scrolled / total : 0);
      setScrollY(scrolled);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const logoOpacity = Math.max(0, 1 - scrollY / 160);

  const solHeaderRef = useRevealRef();
  const cardsRef = useRevealRef();
  const insightsRef = useRevealRef<HTMLElement>();
  const insightsGridRef = useRef<HTMLDivElement>(null);
  const footerPanelRef = useRef<HTMLDivElement>(null);

  const activeRealIdx = ((cardIdx - CAROUSEL_CLONES) % SOLUTIONS.length + SOLUTIONS.length) % SOLUTIONS.length;

  useEffect(() => {
    const t = setInterval(() => setActiveStatus(p => (p + 1) % SYSTEM_STATUS.length), 1800);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const randomize = () => {
      setBinaryRows(Array.from({ length: 9 }, genBinaryBlock));
      setGraphH(0.25 + Math.random() * 0.65);
    };
    randomize(); // fill in random values after mount (client-only)
    const t = setInterval(randomize, 2200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const section = insightsRef.current;
    const grid = insightsGridRef.current;
    if (!section || !grid) return;
    const updateSectionHeight = () => {
      const overflow = grid.scrollHeight - grid.clientHeight;
      section.style.height = overflow > 0 ? `calc(100vh + ${overflow}px)` : '';
    };
    updateSectionHeight();
    window.addEventListener('resize', updateSectionHeight);
    const onScroll = () => {
      const top = section.getBoundingClientRect().top;
      if (top <= 0) {
        grid.scrollTop = Math.min(-top, grid.scrollHeight - grid.clientHeight);
      } else {
        grid.scrollTop = 0;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', updateSectionHeight);
    };
  }, [insightsRef]);

  useEffect(() => {
    const panel = footerPanelRef.current;
    if (!panel) return;
    const check = () => {
      if (panel.getBoundingClientRect().top < window.innerHeight * 0.88) {
        panel.classList.add('s5-footer-panel--visible');
        window.removeEventListener('scroll', check);
      }
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, []);

  function handleFtSubscribe() {
    if (!ftEmail) return;
    setFtSubscribed(true);
    setFtEmail('');
    setTimeout(() => setFtSubscribed(false), 2400);
  }

  async function handleConnect() {
    if (connected) { router.push(`/trade/${DEFAULT_MARKET_SYMBOL}`); return; }
    const installed = await freighterIsInstalled();
    if (!installed) {
      toast.error('Freighter not found — install from freighter.app then refresh.');
      return;
    }
    setConnecting(true);
    try {
      const { freighterConnect, isOnExpectedNetwork } = await import('@/lib/stellar/freighter');
      const addr = await freighterConnect();
      setAddress(addr);
      setConnected(true);
      const ok = await isOnExpectedNetwork();
      setWrongNetwork(!ok);
      if (!ok) toast.warning(`Switch Freighter to ${NETWORK_LABEL}.`);
      else toast.success('Wallet connected');
      router.push(`/trade/${DEFAULT_MARKET_SYMBOL}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setConnecting(false);
    }
  }

  const allCards = [
    ...SOLUTIONS.slice(-CAROUSEL_CLONES),
    ...SOLUTIONS,
    ...SOLUTIONS.slice(0, CAROUSEL_CLONES),
  ];

  const goNext = () => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    setCardIdx(i => i + 1);
  };
  const goPrev = () => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    setCardIdx(i => i - 1);
  };

  const handleCarouselTransitionEnd = useCallback(() => {
    setIsTransitioning(false);
    if (cardIdx >= SOLUTIONS.length + CAROUSEL_CLONES) setCardIdx(CAROUSEL_CLONES);
    else if (cardIdx < CAROUSEL_CLONES) setCardIdx(SOLUTIONS.length + CAROUSEL_CLONES - 1);
  }, [cardIdx]);

  const handlePointerDown = (e: React.PointerEvent) => { dragStartX.current = e.clientX; };
  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragStartX.current === null) return;
    const delta = e.clientX - dragStartX.current;
    dragStartX.current = null;
    if (delta < -60) goNext();
    else if (delta > 60) goPrev();
  };

  const featured = INSIGHTS[0]!;
  const gridInsights = INSIGHTS.slice(1);

  return (
    <>
      <LoadingOverlay />

      <div id="s5-page-root" className="s5-page">

        <div className="s5-scrollbar-track">
          <div className="s5-scrollbar-thumb" style={{ height: `${scrollProgress * 100}%` }} />
        </div>

        <header className="s5-fixed-nav">
          <Link
            href="/"
            className="s5-nav-logo-link"
            style={{
              opacity: logoOpacity,
              pointerEvents: logoOpacity < 0.05 ? 'none' : 'auto',
              transition: 'opacity 0.1s linear',
            }}
          >
            <img src="/logo.png" alt="Kryon" className="s5-nav-logo-img" />
            <span className="s5-nav-logo-text">KRYON</span>
          </Link>
          <button className="s5-menu-pill" onClick={() => setMenuOpen(m => !m)}>
            <svg viewBox="0 0 20 10" fill="none" width="20" height="10" aria-hidden="true">
              <line x1="0" y1="1.5" x2="20" y2="1.5" stroke="currentColor" strokeWidth="1.5" />
              <line x1="0" y1="8.5" x2="20" y2="8.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>MENU</span>
          </button>

          {menuOpen && (
            <div className="s5-menu-overlay" onClick={() => setMenuOpen(false)}>
              <div className="s5-menu-panel" onClick={e => e.stopPropagation()}>
                <button className="s5-menu-close" onClick={() => setMenuOpen(false)}>✕</button>
                {LANDING_NAV.map(n => (
                  n.hardNav ? (
                    <a key={n.to} href={n.to} className="s5-menu-nav-link" onClick={() => setMenuOpen(false)}>
                      {n.label}
                    </a>
                  ) : (
                    <Link key={n.to} href={n.to} className="s5-menu-nav-link" onClick={() => setMenuOpen(false)}>
                      {n.label}
                    </Link>
                  )
                ))}
                <button
                  onClick={() => { void handleConnect(); setMenuOpen(false); }}
                  disabled={connecting}
                  className="s5-menu-connect-btn"
                >
                  {connecting ? 'Connecting…' : connected ? 'Open App' : 'Connect Wallet'}
                </button>
              </div>
            </div>
          )}
        </header>

        <div className="s5-main-grid">
          <div className="s5-left-col">
            <div className="s5-hero-left">
              <div className="s5-hero-title-wrap">
                <div className="s5-op-row">
                  <div className="s5-op-slash-group">
                    <div className="s5-hero-intel"><SplitChars text="Perps" delay={0.05} /></div>
                    <img src="/images/dd.png" alt="" className="s5-hero-slash-img" />
                  </div>
                </div>
                <div className="s5-hero-intel s5-hero-intel--btm">
                  <SplitChars text="Reimagined." delay={0.18} />
                </div>
              </div>
            </div>

            <div className="s5-video-block">
              <video className="s5-video-el" autoPlay muted loop playsInline preload="metadata">
                <source src="/videos/hero-demo.mp4" type="video/mp4" />
              </video>
              <div className="s5-video-overlay" />
            </div>

            <div className="s5-cards-block s5-reveal" ref={cardsRef}>
              {headlines.map((h, i) => (
                <a key={i} className="s5-headline-card" href="#" style={{ transitionDelay: `${i * 0.12}s` }}>
                  <h3 className="s5-headline-title">{h.title}</h3>
                  <p className="s5-headline-desc">{h.desc}</p>
                </a>
              ))}
            </div>
          </div>

          <div className="s5-right-col">
            <div className="s5-hero-right">
              <p className="s5-hero-right-desc s5-fade-up" style={{ animationDelay: '0.4s' }}>
                Trade Perpetuals<br />
                on Stellar with superfast<br />
                Decentralized Execution.
              </p>
            </div>

            <div className="s5-right-mid">
              <p className="s5-stats-title">System Status</p>
              <ul className="s5-stats-list">
                {SYSTEM_STATUS.map((s, i) => (
                  <li key={s} className={`s5-stats-item${i === activeStatus ? ' s5-stats-item--active' : ''}`}>
                    {s}
                    <div className={`s5-stats-dot${i === activeStatus ? ' s5-stats-dot--active' : ''}`} />
                  </li>
                ))}
              </ul>
              <div className="s5-stats-block">
                <div className="s5-graph-asset">
                  <div className="s5-binary-content">
                    <svg className="s5-binary-side" fill="none" viewBox="0 0 8 187">
                      <path
                        className="s5-graph-bar"
                        fill="#8B8B8B"
                        d="M0 6h5v120H0z"
                        style={{
                          mixBlendMode: 'difference',
                          transformOrigin: '0px 6px',
                          transform: `scaleY(${graphH})`,
                          transition: 'transform 1s ease',
                        }}
                      />
                      <path stroke="#8B8B8B" strokeMiterlimit="10" d="M7.5 3.116v182.891" />
                      <path fill="#8B8B8B" d="M8 184H0v3h8v-3ZM8 0H0v3h8V0Z" />
                    </svg>
                    <div className="s5-asset-binary">
                      {binaryRows.map((line, i) => (
                        <div key={i} className="s5-binary-item" style={{ animationDelay: `${i * 0.28}s` }}>
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <Link href={`/trade/${DEFAULT_MARKET_SYMBOL}`} className="s5-right-cta">
              <img src="/images/arrow.png" alt="" className="s5-cta-arrow-img" />
              <p className="s5-explore-text">Explore the platform.</p>
            </Link>
          </div>
        </div>

        <section className="s5-solutions">
          <div className="s5-solutions-header s5-reveal" ref={solHeaderRef}>
            <div>
              <h2 className="s5-solutions-title">Engineered</h2>
              <h2 className="s5-solutions-title">for Perps</h2>
            </div>
            <div className="s5-solutions-arrows">
              <button className="s5-arrow-btn" onClick={goPrev} aria-label="Previous">
                <svg viewBox="0 0 24 24" fill="none" className="s5-arr-svg" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M5 12l7-7M5 12l7 7" />
                </svg>
              </button>
              <button className="s5-arrow-btn" onClick={goNext} aria-label="Next">
                <svg viewBox="0 0 24 24" fill="none" className="s5-arr-svg" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M19 12l-7-7M19 12l-7 7" />
                </svg>
              </button>
            </div>
          </div>

          <div className="s5-solutions-viewport" onPointerDown={handlePointerDown} onPointerUp={handlePointerUp}>
            <div
              className="s5-solutions-track"
              style={{
                transform: `translateX(calc(-${cardIdx} * var(--s5-card-step, 33.333vw)))`,
                transition: isTransitioning ? 'transform 0.55s cubic-bezier(0.22,1,0.36,1)' : 'none',
              }}
              onTransitionEnd={handleCarouselTransitionEnd}
            >
              {allCards.map((s, i) => {
                const realIdx = ((i - CAROUSEL_CLONES) % SOLUTIONS.length + SOLUTIONS.length) % SOLUTIONS.length;
                const isActive = realIdx === activeRealIdx;
                return (
                  <div key={i} className={`s5-solution-card${isActive ? ' s5-solution-card--active' : ''}`}>
                    <div className="s5-solution-illustration">
                      <SolSvg idx={realIdx} active={isActive} />
                    </div>
                    <div className="s5-solution-content">
                      <h3 className="s5-solution-name">{s.title}</h3>
                      <p className="s5-solution-desc">{s.desc}</p>
                      <button className="s5-explore-btn">Explore</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="s5-insights s5-reveal" ref={insightsRef}>
          <div className="s5-insights-featured">
            <div className="s5-insights-featured-art">
              <div className="s5-insights-featured-art-img">
                <svg viewBox="0 0 800 400" fill="none" stroke="rgba(181,153,229,0.75)" strokeWidth="1">
                  <rect x="100" y="180" width="600" height="120" rx="8"/>
                  <path d="M160 180 L220 100 L580 100 L640 180"/>
                  <ellipse cx="220" cy="310" rx="55" ry="55"/><ellipse cx="220" cy="310" rx="30" ry="30"/>
                  <ellipse cx="580" cy="310" rx="55" ry="55"/><ellipse cx="580" cy="310" rx="30" ry="30"/>
                  <path d="M280 100 L300 180 M520 100 L500 180"/>
                  <rect x="230" y="110" width="340" height="65" rx="4"/>
                  <line x1="100" y1="220" x2="700" y2="220"/>
                  <rect x="140" y="240" width="80" height="40" rx="3"/>
                  <rect x="580" y="240" width="80" height="40" rx="3"/>
                  <path d="M700 220 L720 200 L720 270 L700 270"/>
                  <path d="M100 220 L80 200 L80 270 L100 270"/>
                </svg>
              </div>
            </div>
            <div className="s5-insights-featured-content">
              <p className="s5-insights-featured-date">{featured.date}</p>
              <p className="s5-insights-featured-cat">{featured.desc}</p>
              <h2 className="s5-insights-featured-title">{featured.title}</h2>
              <button className="s5-readmore-btn">Read More</button>
            </div>
          </div>

          <div className="s5-insights-grid" ref={insightsGridRef}>
            {gridInsights.map((item, i) => (
              <a key={i} className="s5-insight-card" href="#">
                <h4 className="s5-insight-title">{item.title}</h4>
                <p className="s5-insight-date">{item.date}</p>
                <p className="s5-insight-desc">{item.desc}</p>
              </a>
            ))}
          </div>
        </section>

        <footer className="s5-footer">
          <div className="s5-footer-grain" />
          <div className="s5-footer-signup">
            <div>
              <p className="s5-footer-signup-label">Sign up for updates</p>
              <input
                className="s5-footer-signup-field"
                type="email"
                placeholder={ftSubscribed ? "You're on the list." : 'Enter your email address'}
                value={ftEmail}
                onChange={e => setFtEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleFtSubscribe()}
              />
            </div>
            <button className="s5-footer-subscribe-btn" onClick={handleFtSubscribe} disabled={ftSubscribed}>
              {ftSubscribed ? 'Subscribed' : 'Subscribe'}
            </button>
          </div>

          <div className="s5-footer-panel" ref={footerPanelRef}>
            <div className="s5-footer-panel-grain" />
            <div className="s5-footer-panel-grid">
              <div>
                <svg className="s5-footer-logo" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                  <path d="M6 12 L26 32 L6 52 L18 52 L38 32 L18 12 Z" fill="currentColor"/>
                  <path d="M30 12 L50 32 L30 52 L42 52 L62 32 L42 12 Z" fill="currentColor"/>
                </svg>
              </div>
              <div>
                <h3 className="s5-footer-col-h">Platform</h3>
                <ul className="s5-footer-col-list">
                  <li><span className="s5-footer-col-arrow">↳</span><Link href={`/trade/${DEFAULT_MARKET_SYMBOL}`} className="text-inherit">Trade</Link></li>
                  <li><span className="s5-footer-col-arrow">↳</span><Link href="/portfolio" className="text-inherit">Portfolio</Link></li>
                  <li><span className="s5-footer-col-arrow">↳</span><Link href="/leaderboard" className="text-inherit">Leaderboard</Link></li>
                </ul>
              </div>
              <div>
                <h3 className="s5-footer-col-h">Features<sup>4</sup></h3>
                <ul className="s5-footer-col-list">
                  <li><span className="s5-footer-col-arrow">↳</span><a href="#">Perpetuals</a></li>
                  <li><span className="s5-footer-col-arrow">↳</span><a href="#">On-Chain Settlement</a></li>
                  <li><span className="s5-footer-col-arrow">↳</span><a href="#">CLOB Matching</a></li>
                  <li><span className="s5-footer-col-arrow">↳</span><a href="#">Risk & Liquidation</a></li>
                </ul>
              </div>
              <div>
                <h3 className="s5-footer-col-h">About<sup>2</sup></h3>
                <ul className="s5-footer-col-list">
                  <li><span className="s5-footer-col-arrow">↳</span><a href="#">Company</a></li>
                  <li><span className="s5-footer-col-arrow">↳</span><a href="#">Careers</a></li>
                  <li style={{ marginTop: '8px' }}><a href="#">Insights</a></li>
                  <li><a href="#">Contact</a></li>
                </ul>
              </div>
            </div>
            <svg className="s5-footer-wordmark" viewBox="0 0 1000 280" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <text x="500" y="279" textAnchor="middle" fontSize="290" fontFamily="Archivo, sans-serif" fontWeight="600" fill="#b599e5" letterSpacing="-15">KRYON</text>
            </svg>
          </div>
        </footer>

      </div>
    </>
  );
}
