import Link from "next/link";

import { LegalPage } from "@/components/common/LegalPage";

export const metadata = { title: "Risk Disclosure — Kryon", description: "The risks of trading perpetual futures on Kryon." };

export default function RiskPage() {
  return (
    <LegalPage
      title="Risk Disclosure"
      draft={false}
      sections={[
        { heading: "Leverage and liquidation", body: "Perpetual futures are leveraged. When your equity falls below the maintenance margin of your open positions, a keeper can liquidate part or all of them at the index price and charge a liquidation fee. You can lose all the collateral you deposit." },
        { heading: "Cross margin", body: "All of an account's positions share one collateral balance. A loss in one market reduces the margin behind every other position." },
        { heading: "Funding", body: "Positions pay or receive funding every hour, depending on the gap between the market's trade price and the oracle index. Funding can be a large cost over time." },
        { heading: "Prices and oracles", body: "Margin and liquidation use an oracle index built from outside venues. If the feed goes stale, trading, liquidations and withdrawals for affected accounts pause until it updates." },
        { heading: "Execution", body: "Orders are matched off-chain and settle on chain afterwards. A matched fill can still be rejected at settlement, for example if your margin changed in between. A market order fills at the resting prices available, up to its slippage limit." },
        { heading: "Auto-deleveraging", body: "If a liquidation leaves losses the insurance fund cannot cover, profitable opposing positions can be reduced to close the gap." },
        {
          heading: "Software and governance",
          body: (
            <>
              The contracts are unaudited and upgradeable through a 48-hour timelock; scheduled changes are listed on the{" "}
              <Link href="/transparency" className="underline decoration-dotted underline-offset-4">
                transparency page
              </Link>
              . A guardian can pause trading for a bounded time.
            </>
          ),
        },
      ]}
    />
  );
}
