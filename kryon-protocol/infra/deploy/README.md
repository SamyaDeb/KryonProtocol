# Deployment

Deployment is not a shell script problem. Mainnet deployment requires:

1. deterministic wasm builds
2. published wasm hashes
3. governance approval
4. timelocked upgrade schedule
5. post-deploy invariant simulation
6. capped market activation
7. live monitoring before liquidity is enabled

Implemented artifacts:

- `environments/testnet.toml`
- `environments/mainnet.toml`
- `manifest.example.toml`
- `runbooks/mainnet-readiness.md`

The manifests intentionally leave contract IDs and signer addresses blank.
Those values must come from the deployment environment, not source control.
