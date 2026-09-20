import { PageShell } from "@/components/common/PageShell";
import { FeesView } from "@/features/fees/FeesView";

export const metadata = {
  title: "Fees — Kryon",
  description: "Kryon's maker and taker fees per market, and your account's rates.",
};

export default function FeesPage() {
  return (
    <PageShell
      title="Fees"
      subtitle="Fees are a share of each fill's notional, set on chain by the FeeRouter and changed only through the timelock. A maker order rests on the book; a taker order trades against it."
      width="max-w-[900px]"
    >
      <FeesView />
    </PageShell>
  );
}
