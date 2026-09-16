"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { WalletConnect } from "@/features/wallet/components/WalletConnect";
import { NotificationBell } from "@/features/navbar/components/NotificationBell";
import { SettingsMenu } from "@/features/navbar/components/SettingsMenu";
import { DEFAULT_MARKET_SYMBOL } from "@/config";
import { NetworkToggle } from "@/features/network/components/NetworkToggle";
import { NetworkBanner } from "@/features/network/components/NetworkBanner";

const TABS = [
  { label: "Trade", href: `/trade/${DEFAULT_MARKET_SYMBOL}`, match: "/trade" },
  { label: "Markets", href: "/markets", match: "/markets" },
  { label: "Portfolio", href: "/portfolio", match: "/portfolio" },
  { label: "Leaderboard", href: "/leaderboard", match: "/leaderboard" },
  { label: "Activity", href: "/dashboard", match: "/dashboard" },
];

export function TopNav() {
  const pathname = usePathname() ?? "";
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      className="relative shrink-0 border-b border-[#2A2A31] bg-[#212128]"
      style={{ paddingTop: "max(6px, env(safe-area-inset-top))" }}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-[6px] sm:px-[14px]">
        <div className="flex min-w-0 items-center gap-2 sm:gap-[12px]">
          {/* Hamburger — mobile only */}
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[7px] text-[#a3a3a3] hover:bg-[#19191A] hover:text-[#f5f5f5] transition-colors md:hidden"
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>

          <Link href="/" className="flex shrink-0 items-center gap-[8px] select-none">
            <Image src="/logo.png" alt="Kryon" width={36} height={11} priority className="object-contain" />
            <span
              className="text-[18px] font-bold text-[#f5f5f5]"
              style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
            >
              KRYON
            </span>
          </Link>

          {/* Desktop / tablet inline nav */}
          <nav className="hidden gap-[6px] md:flex">
            {TABS.map((t) => {
              const active = pathname.startsWith(t.match);
              return (
                <Link
                  key={t.label}
                  href={t.href}
                  className={`px-[12px] py-[6px] rounded-[6px] text-[13px] font-medium transition-colors ${
                    active ? "text-[#f5f5f5]" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-[12px]">
          {/* Hidden on mobile, where it moves into the drawer — the segmented
              control plus the wallet button does not fit a phone-width bar. */}
          <NetworkToggle className="hidden sm:flex" />
          <WalletConnect />
          <NotificationBell />
          <SettingsMenu />
        </div>
      </div>

      {/* Mobile drawer */}
      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setMenuOpen(false)}
          />
          <nav className="absolute inset-x-0 top-full z-50 border-b border-[#2A2A31] bg-[#212128] p-2 shadow-[0_20px_40px_rgba(0,0,0,.5)] md:hidden">
            <div className="mb-2 flex items-center justify-between gap-2 border-b border-[#2A2A31] px-2 pb-3 sm:hidden">
              <span className="text-[13px] font-medium text-[#a3a3a3]">Network</span>
              <NetworkToggle />
            </div>
            {TABS.map((t) => {
              const active = pathname.startsWith(t.match);
              return (
                <Link
                  key={t.label}
                  href={t.href}
                  onClick={() => setMenuOpen(false)}
                  className={`block rounded-[8px] px-4 py-3 text-[15px] font-medium transition-colors ${
                    active ? "bg-[#19191A] text-[#f5f5f5]" : "text-[#a3a3a3] hover:bg-[#19191A] hover:text-[#f5f5f5]"
                  }`}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </>
      )}

      <NetworkBanner />
    </header>
  );
}
