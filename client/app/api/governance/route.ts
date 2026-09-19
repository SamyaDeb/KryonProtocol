import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { networkAwareCacheControl, networkFromRequest } from "@/lib/network-server";
import { listGovernanceOperations } from "@/lib/queries/governance";
import { parseLimit } from "@/lib/queries/scalars";

/**
 * GET /api/governance?limit=50 — the timelock queue: operations still waiting
 * to become executable (soonest first), then recent executed and cancelled
 * ones. Public: every scheduled change is on chain already.
 */
export async function GET(req: NextRequest) {
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"), 50, 200);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });

  const network = networkFromRequest(req);
  try {
    const ops = await listGovernanceOperations(db(network), network, limit);
    const now = Date.now();
    return NextResponse.json(
      {
        network,
        operations: ops.map((o) => ({
          operation_id: o.operationId,
          status: o.status,
          ready: o.status === "SCHEDULED" && o.readyAt.getTime() <= now,
          ready_at: o.readyAt.getTime(),
          delay_seconds: Number(o.delaySeconds),
          calls: o.calls,
          description: o.description,
          scheduled_tx: o.scheduledTxHash,
          executed_tx: o.executedTxHash,
          cancelled_tx: o.cancelledTxHash,
          created_at: o.createdAt.getTime(),
        })),
      },
      { headers: { "Cache-Control": networkAwareCacheControl(req, "public, max-age=15, s-maxage=30") } }
    );
  } catch (e) {
    console.error("governance error:", e);
    return NextResponse.json({ error: "governance_unavailable" }, { status: 500 });
  }
}
