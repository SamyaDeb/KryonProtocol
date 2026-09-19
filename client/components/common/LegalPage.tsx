import { PageShell } from "@/components/common/PageShell";

/**
 * A legal page. `draft` marks text counsel has not approved: it states what
 * is true of the service today and is replaced, not edited, before mainnet.
 */
export function LegalPage({
  title,
  draft,
  sections,
}: {
  title: string;
  draft: boolean;
  sections: { heading: string; body: React.ReactNode }[];
}) {
  return (
    <PageShell title={title} width="max-w-[760px]">
      {draft && (
        <p className="rounded-[8px] border border-[#7c2d12] bg-[#2a1a12] px-3 py-2 text-[12.5px] text-[#fdba74]">
          Draft for the testnet. Final terms will be supplied by counsel before any mainnet launch.
        </p>
      )}
      <div className="flex flex-col gap-5">
        {sections.map((s) => (
          <section key={s.heading}>
            <h2 className="mb-1 text-[15px] font-semibold text-[#f5f5f5]">{s.heading}</h2>
            <div className="text-[13.5px] leading-6 text-[#a3a3a3]">{s.body}</div>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
