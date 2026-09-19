import Link from "next/link";

import { TopNav } from "@/components/common/TopNav";

/** The frame every content page shares: nav, width, type and colours. */
export function PageShell({
  title,
  subtitle,
  children,
  width = "max-w-[1180px]",
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <main
      className="min-h-screen bg-[#19191A] text-[#f5f5f5]"
      style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      <section className={`mx-auto flex w-full ${width} flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8`}>
        <div>
          <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[24px]">{title}</h1>
          {subtitle && <p className="mt-1 max-w-[760px] text-[13px] leading-6 text-[#a3a3a3]">{subtitle}</p>}
        </div>
        {children}
        <footer className="mt-6 flex flex-wrap gap-x-4 gap-y-1 border-t border-[#2A2A31] pt-4 text-[12px] text-[#737373]">
          {[
            ["/fees", "Fees"],
            ["/transparency", "Transparency"],
            ["/risk", "Risk disclosure"],
            ["/terms", "Terms"],
            ["/privacy", "Privacy"],
          ].map(([href, label]) => (
            <Link key={href} href={href} className="hover:text-[#f5f5f5]">
              {label}
            </Link>
          ))}
        </footer>
      </section>
    </main>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[10px] border border-[#2A2A31] bg-[#212128] p-4 sm:p-5 ${className}`}>
      {title && <h2 className="mb-3 text-[14px] font-semibold text-[#f5f5f5]">{title}</h2>}
      {children}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <span className="text-[11px] uppercase tracking-wider text-[#737373]">{label}</span>
      <span className="font-mono text-[16px] font-semibold text-[#f5f5f5]">{value}</span>
    </div>
  );
}
