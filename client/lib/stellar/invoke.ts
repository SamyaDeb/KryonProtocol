"use client";

import {
  TransactionBuilder,
  Transaction,
  Contract,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { getRpcServer, NETWORK_PASSPHRASE } from "./client";
import { freighterSignTx } from "./freighter";

const FEE = "500000"; // 0.05 XLM — generous for Soroban ops
const TIMEOUT = 30;

export async function simulate(
  txXdr: string
): Promise<rpc.Api.SimulateTransactionResponse> {
  const server = getRpcServer();
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;
  return server.simulateTransaction(tx);
}

async function buildContractCall(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string
): Promise<string> {
  const server = getRpcServer();
  // For write calls, use the real on-chain account to get current sequence
  const account = await server.getAccount(sourcePublicKey);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TIMEOUT)
    .build();

  return tx.toXDR();
}

export async function invokeContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const server = getRpcServer();
  const rawXdr = await buildContractCall(contractId, method, args, sourcePublicKey);

  const simResult = await server.simulateTransaction(
    TransactionBuilder.fromXDR(rawXdr, NETWORK_PASSPHRASE) as Transaction
  );
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedXdr = rpc.assembleTransaction(
    TransactionBuilder.fromXDR(rawXdr, NETWORK_PASSPHRASE) as Transaction,
    simResult
  ).build().toXDR();

  const signedXdr = await freighterSignTx(preparedXdr);

  const sendResult = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as Transaction
  );
  if (sendResult.status === "ERROR") {
    throw new Error(`Submit failed: ${sendResult.errorResult?.toXDR("base64")}`);
  }

  let attempts = 0;
  while (attempts < 30) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await server.getTransaction(sendResult.hash);
    if (poll.status === "SUCCESS") return poll as rpc.Api.GetSuccessfulTransactionResponse;
    if (poll.status === "FAILED") throw new Error(`Transaction failed: ${poll.resultXdr}`);
    attempts++;
  }
  throw new Error("Transaction polling timeout");
}

// simulateRead lives in ./simulate (no browser-only imports) so keepers and
// scripts share one implementation. Re-exported here for existing callers.
export { simulateRead } from "./simulate";
