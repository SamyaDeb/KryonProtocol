// Read-only contract simulation. Deliberately free of any browser-only import
// (no Freighter, no "use client") so node-side keepers and scripts can reuse
// the exact same RPC client and call path as the browser — see
// getRpcServer()'s single cached rpc.Server.

import {
  Account,
  Contract,
  Keypair,
  TimeoutInfinite,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { getRpcServer, NETWORK_PASSPHRASE } from "./client";

const FEE = "500000"; // 0.05 XLM — generous for Soroban ops

// Synthetic keypair for read simulation — Soroban RPC validates tx structure
// but does NOT require the source account to exist on-chain for simulation.
// Generate once per session so sequence numbers stay consistent.
let _simKp: InstanceType<typeof Keypair> | null = null;
let _simSeq = 100;

function getSimAccount(): InstanceType<typeof Account> {
  if (!_simKp) _simKp = Keypair.random();
  return new Account(_simKp.publicKey(), (_simSeq++).toString());
}

export async function simulateRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  dummySource?: string
): Promise<xdr.ScVal | null> {
  void dummySource;
  const server = getRpcServer();
  const account = getSimAccount();
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TimeoutInfinite)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return null;
  const success = sim as rpc.Api.SimulateTransactionSuccessResponse;
  return success.result?.retval ?? null;
}
