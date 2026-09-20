import Link from "next/link";

import { PageShell } from "@/components/common/PageShell";

export const metadata = { title: "Not available — Kryon", description: "Kryon is not available in your jurisdiction." };

export default function RestrictedPage() {
  return (
    <PageShell title="Not available in your jurisdiction" width="max-w-[640px]">
      <p className="text-[13.5px] leading-6 text-[#a3a3a3]">
        Kryon is not offered where you are connecting from. If you believe this is a mistake, you may be connecting
        through a network that reports a different location.
      </p>
      <p className="text-[13px] text-[#a3a3a3]">
        <Link href="/terms" className="underline decoration-dotted underline-offset-4">Terms</Link>
        {" · "}
        <Link href="/privacy" className="underline decoration-dotted underline-offset-4">Privacy</Link>
        {" · "}
        <Link href="/risk" className="underline decoration-dotted underline-offset-4">Risk disclosure</Link>
      </p>
    </PageShell>
  );
}
