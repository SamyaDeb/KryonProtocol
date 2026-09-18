/**
 * The publisher's view of the chain, over viem. One multicall per tick reads
 * every feed's config, stored aggregate, reference reading and every
 * publisher's observation, all at the same block.
 */

import type { Address, Hex, PublicClient } from "viem";

import { oracleAdapterAbi } from "@/lib/chain/contracts";
import { readReferencePrice } from "@/lib/chain/refprice";

import type { FeedState, Observation } from "./guards";
import { symbolOf, type OracleChain, type OracleState } from "./publisher";

type Reader = Pick<PublicClient, "multicall" | "getBlock" | "call">;

export function viemOracleChain(o: {
  client: Reader;
  oracle: Address;
  self: Address;
  /** Chainlink USDC/USD on this network, if any. */
  usdcReference?: Address | null;
  usdcReferenceMaxAgeSecs?: number;
}): OracleChain {
  const { client, oracle } = o;
  const c = { address: oracle, abi: oracleAdapterAbi } as const;

  return {
    async readState(): Promise<OracleState> {
      const block = await client.getBlock({ blockTag: "latest" });
      const blockNumber = block.number;
      const [paused, publishers, feedIds] = await client.multicall({
        allowFailure: false,
        blockNumber,
        contracts: [
          { ...c, functionName: "paused" },
          { ...c, functionName: "publishers" },
          { ...c, functionName: "feedIds" },
        ],
      });
      const ids = feedIds as readonly Hex[];
      const pubs = publishers as readonly Address[];

      const perFeed = 4 + pubs.length;
      const calls = ids.flatMap((id) => [
        { ...c, functionName: "feed", args: [id] },
        { ...c, functionName: "latest", args: [id] },
        { ...c, functionName: "referenceFeed", args: [id] },
        { ...c, functionName: "referencePrice", args: [id] },
        ...pubs.map((p) => ({ ...c, functionName: "observation", args: [id, p] })),
      ]);
      const res = calls.length
        ? ((await client.multicall({ allowFailure: false, blockNumber, contracts: calls as never })) as unknown[])
        : [];

      const feeds: FeedState[] = ids.map((id, i) => {
        const at = (k: number) => res[i * perFeed + k] as Record<string, unknown> & unknown[];
        const cfg = at(0);
        const snap = at(1);
        const ref = at(2);
        const [refOk, refPrice] = at(3) as unknown as [boolean, bigint];
        const observations = new Map<string, Observation>();
        pubs.forEach((p, j) => {
          const ob = at(4 + j);
          observations.set(p.toLowerCase(), {
            price: ob.price as bigint,
            confidence: ob.confidence as bigint,
            publishTime: Number(ob.publishTime),
          });
        });
        return {
          id,
          symbol: symbolOf(id),
          cfg: {
            listed: Boolean(cfg.listed),
            active: Boolean(cfg.active),
            minPublishers: Number(cfg.minPublishers),
            maxSpreadBps: Number(cfg.maxSpreadBps),
            maxJumpBps: Number(cfg.maxJumpBps),
            maxConfidenceBps: Number(cfg.maxConfidenceBps),
            maxAge: Number(cfg.maxAge),
          },
          snapshot: {
            price: snap.price as bigint,
            confidence: snap.confidence as bigint,
            publishTime: Number(snap.publishTime),
            writeTime: Number(snap.writeTime),
            sourceCount: Number(snap.sourceCount),
          },
          observations,
          reference: {
            enabled: Boolean(ref.enabled),
            required: Boolean(ref.required),
            maxDivergenceBps: Number(ref.maxDivergenceBps),
            ok: refOk,
            price: refPrice,
          },
        };
      });

      return {
        paused: paused as boolean,
        publishers: [...pubs],
        feeds,
        chainNow: Number(block.timestamp),
      };
    },

    async readUsdcReference(chainNow) {
      if (!o.usdcReference) return null;
      const r = await readReferencePrice(client, o.usdcReference, o.usdcReferenceMaxAgeSecs ?? 90_000, chainNow);
      return r?.price ?? null;
    },

    async simulate(data) {
      try {
        await client.call({ account: o.self, to: oracle, data });
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },
  };
}
