import { LegalPage } from "@/components/common/LegalPage";

export const metadata = { title: "Terms — Kryon", description: "Terms of use for Kryon." };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Use"
      draft
      sections={[
        { heading: "Testnet only", body: "This deployment runs on Arc testnet. Testnet USDC has no monetary value, and balances, positions and history may be reset at any time without notice." },
        { heading: "Unaudited software", body: "The smart contracts and services have not completed an external security audit. They may contain defects that cause loss of testnet funds or incorrect results." },
        { heading: "Self-custody", body: "You sign every order and transaction in your own wallet. Kryon cannot recover lost keys, reverse transactions, or move funds on your behalf." },
        { heading: "No advice", body: "Nothing on this site is investment, legal or tax advice." },
        { heading: "Availability", body: "The service may be unavailable, paused by the guardian, or restricted in some jurisdictions." },
      ]}
    />
  );
}
