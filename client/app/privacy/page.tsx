import { LegalPage } from "@/components/common/LegalPage";

export const metadata = { title: "Privacy — Kryon", description: "What Kryon records." };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      draft
      sections={[
        { heading: "Public by design", body: "Your wallet address, deposits, withdrawals, positions and settled trades are recorded on the Arc blockchain and are public. Kryon's indexer and leaderboard derive their data from that public record." },
        { heading: "Orders", body: "Signed orders you submit are stored by Kryon's order service, including resting orders that never trade, so the matcher can execute them and the API can show your order history." },
        { heading: "Request data", body: "Kryon's servers process your IP address to rate-limit requests and, where required, to restrict access by jurisdiction. Kryon does not ask for your name, email or identity documents." },
        { heading: "Your browser", body: "The app stores your network choice and display settings in cookies and local storage on your device." },
      ]}
    />
  );
}
