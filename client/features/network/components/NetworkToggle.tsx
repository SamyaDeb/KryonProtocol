"use client";

import type { ArcNetworkId } from "@/lib/network";
import { networkView, useNetwork } from "@/features/network/NetworkContext";

/**
 * Navbar segmented control for switching venue.
 *
 * Colour carries the safety signal: mainnet green (real funds), testnet and
 * local amber (play money) — matching the long/warning hues already used on
 * the order ticket, so the cue is one the user has already learned elsewhere.
 *
 * Renders nothing when the deployment offers a single venue: a production build
 * sets `NEXT_PUBLIC_KRYON_NETWORKS=arc-mainnet`, and a one-button "toggle"
 * invites a click that does nothing.
 */

const ACCENT: Record<ArcNetworkId, { dot: string; text: string; bg: string; ring: string }> = {
  "arc-mainnet": { dot: "#46d985", text: "#46d985", bg: "rgba(70,217,133,0.12)", ring: "rgba(70,217,133,0.35)" },
  "arc-testnet": { dot: "#ff9440", text: "#ff9440", bg: "rgba(255,148,64,0.12)", ring: "rgba(255,148,64,0.35)" },
  "arc-local": { dot: "#ff9440", text: "#ff9440", bg: "rgba(255,148,64,0.12)", ring: "rgba(255,148,64,0.35)" },
};

export function NetworkToggle({ className = "" }: { className?: string }) {
  const { network, available, switching, switchNetwork } = useNetwork();

  if (available.length < 2) return null;

  return (
    <div
      role="group"
      aria-label="Network"
      className={`flex items-center gap-[2px] rounded-[7px] border border-[#2A2A31] bg-[#19191A] p-[2px] ${className}`}
    >
      {available.map((id) => {
        const active = id === network;
        const accent = ACCENT[id];
        const cfg = networkView(id);
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={cfg.label}
            // Disabling only the inactive buttons keeps the active one focusable
            // while a switch is in flight, so focus is never dropped to <body>.
            disabled={switching && !active}
            onClick={() => switchNetwork(id)}
            title={active ? `Connected to ${cfg.label}` : `Switch to ${cfg.label}`}
            className={`flex items-center gap-[6px] rounded-[5px] px-[9px] py-[5px] text-[12px] font-medium transition-colors disabled:cursor-wait ${
              active ? "" : "text-[#a3a3a3] hover:bg-[#212128] hover:text-[#f5f5f5]"
            }`}
            style={
              active
                ? { color: accent.text, background: accent.bg, boxShadow: `inset 0 0 0 1px ${accent.ring}` }
                : undefined
            }
          >
            <span
              aria-hidden="true"
              className="h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: active ? accent.dot : "#4b4b52" }}
            />
            {cfg.shortLabel}
          </button>
        );
      })}
    </div>
  );
}
