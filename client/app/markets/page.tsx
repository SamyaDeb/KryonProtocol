import { ACTIVE_MARKETS } from "@/config";
import { TopNav } from "@/components/common/TopNav";
import { MarketsTable } from "@/features/trade/components/MarketsTable";

export const metadata = {
  title: "Markets — Kryon",
  description: "Active perpetual markets available for trading on Kryon.",
};

export default function MarketsPage() {
  const markets = Object.values(ACTIVE_MARKETS);

  return (
    <main
      className="min-h-screen bg-[#19191A] text-[#f5f5f5]"
      style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      <section className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[.01em] sm:text-[24px]">Markets</h1>
            <p className="mt-1 text-[13px] text-[#a3a3a3]">Active perpetual markets available for trading.</p>
          </div>
          <div className="rounded-[6px] border border-[#2A2A31] bg-[#212128] px-3 py-2 text-[12px] text-[#a3a3a3]">
            {markets.length} active
          </div>
        </div>

        <MarketsTable markets={markets} />
      </section>
    </main>
  );
}
