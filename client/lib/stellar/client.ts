import { rpc } from "@stellar/stellar-sdk";
import { NETWORK } from "@/config";

let _server: rpc.Server | null = null;

export function getRpcServer(): rpc.Server {
  if (!_server) {
    _server = new rpc.Server(NETWORK.rpcUrl, { allowHttp: false });
  }
  return _server;
}

export const NETWORK_PASSPHRASE = NETWORK.passphrase;
