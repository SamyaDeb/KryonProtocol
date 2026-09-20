import { PageShell } from "@/components/common/PageShell";
import { InsuranceView } from "@/features/insurance/InsuranceView";

export const metadata = {
  title: "Insurance Fund — Kryon",
  description: "The Kryon insurance fund: its size, share price, and staking.",
};

export default function InsurancePage() {
  return (
    <PageShell
      title="Insurance Fund"
      subtitle="The insurance fund takes over positions liquidations cannot close in the market and covers bad debt. Stakers provide its redeemable capital and carry its losses pro rata; unstaking waits a 7-day cooldown."
      width="max-w-[960px]"
    >
      <InsuranceView />
    </PageShell>
  );
}
