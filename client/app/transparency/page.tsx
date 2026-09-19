import { TransparencyView } from "@/features/transparency/TransparencyView";
import { PageShell } from "@/components/common/PageShell";

export const metadata = {
  title: "Transparency — Kryon",
  description: "Kryon's contracts, vault solvency, deposit caps and the governance timelock queue, read live from the chain.",
};

export default function TransparencyPage() {
  return (
    <PageShell
      title="Transparency"
      subtitle="Everything here is read from the chain or its index: the contracts, whether the vault can cover every balance, and every scheduled parameter change. Changes pass a 48-hour timelock before they take effect."
    >
      <TransparencyView />
    </PageShell>
  );
}
