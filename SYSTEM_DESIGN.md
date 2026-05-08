# 0G RoboWars — Decentralized Save System Architecture

## Network Configuration

| Component | Network | Endpoint | Chain ID |
|-----------|---------|----------|----------|
| 0G EVM RPC | **Mainnet** | `https://evmrpc.0g.ai` | 16661 |
| 0G Storage Indexer (Turbo) | **Mainnet** | `https://indexer-storage-turbo.0g.ai` | — |
| 0G Compute Router | **Mainnet** | `https://router-api.0g.ai/v1` | — |
| Compute Payment Contract | **Mainnet** | `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` | 16661 |
| Flow Contract (Storage) | **Mainnet** | `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526` | 16661 |
| Block Explorer | **Mainnet** | `https://chainscan.0g.ai` | — |
| 0G DA Disperser | ⚠️ **Testnet only** | `disperser-testnet.0g.ai:51001` | — |
| DA Entrance Contract | ⚠️ **Testnet only** | `0xE75A073dA5bb7b0eC622170Fd268f35E675a957B` | 16602 |


## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         UNREAL ENGINE CLIENT                                │
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  UZeroGSaveSystem (ActorComponent)                                   │  │
│   │                                                                      │  │
│   │  GameStart:  RequestNonce → VerifySignature → JWT                    │  │
│   │  OnLoad:     DownloadAndApplySave → verify checksum → LoadGame       │  │
│   │  OnSave:     UploadSave(bool) → multipart POST → rootHash            │  │
│   │  AntiCheat:  TriggerComputeValidation → CLEAN / TAMPERED             │  │
│   └─────────────────────────┬────────────────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────────────────┘
                              │  HTTPS (JWT Bearer)
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     LAYER 3 — NODE.JS BACKEND (Express)                     │
│                                                                             │
│  POST /auth/nonce      — UUID nonce, MongoDB TTL                            │
│  POST /auth/verify     — ethers.verifyMessage → JWT                         │
│  POST /save/upload     — GVAS magic → SHA-256 → Storage → Compute gate →   │
│                          MongoDB → async DA                                 │
│  GET  /save/latest     — MongoDB (wallet, version DESC)                     │
│  GET  /save/history    — all versions, newest first                         │
│  GET  /save/download   — Storage download → checksum verify → stream        │
│  POST /save/verify     — 4-layer: DB + DA + Storage + Compute              │
│  POST /leaderboard/submit — AntiCheatService 4-layer → score accepted      │
│  GET  /leaderboard/top — score DESC, computeProvider exposed                │
│                                                                             │
│  Middleware: helmet → cors → compression → globalRateLimiter →             │
│             authMiddleware (JWT) → uploadRateLimiter → fileValidator        │
└──────┬──────────────────────┬──────────────────────┬────────────────────────┘
       │                      │                      │
       ▼                      ▼                      ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────────────────────┐
│  LAYER 1     │   │  LAYER 2 — 0G DA │   │  LAYER 4 — 0G COMPUTE NETWORK   │
│  0G STORAGE  │   │                  │   │                                  │
│              │   │  gRPC TLS        │   │  POST router-api.0g.ai/v1/       │
│  SDK upload: │   │  disperser-testnet│   │       chat/completions           │
│  ZgFile →    │   │  :51001          │   │  model: zai-org/GLM-5-FP8        │
│  merkleTree()│   │                  │   │  verify_tee: true                │
│  → indexer   │   │  Blob pipeline:  │   │                                  │
│    .upload() │   │  Pad → 1024×1024 │   │  TEE pipeline:                   │
│  → Flow tx   │   │  matrix → KZG    │   │  Request → isolated inference    │
│    mainnet   │   │  commit → rows   │   │  → EIP-191 sig by TEE key        │
│              │   │  to DA nodes →   │   │  → Router verifies sig           │
│  Returns:    │   │  BLS (>2/3) →    │   │  → tee_verified: true            │
│  rootHash    │   │  on-chain finalize│  │                                  │
│  (Merkle     │   │                  │   │  ComputeVerifier:                │
│  root, 32B)  │   │  Returns:        │   │  GET provider/sig/{chatId}       │
│              │   │  batchId +       │   │  ethers.verifyMessage(text, sig) │
│  Download:   │   │  blobIndex +     │   │  === on-chain teeSignerAddress   │
│  Merkle proof│   │  blockNumber     │   │                                  │
│  per segment │   │  (DA commitment) │   │  rootHash echo binding check     │
└──────────────┘   └──────────────────┘   └──────────────────────────────────┘
       │                      │                      │
       └──────────────────────┴──────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MONGODB (saves + nonces + leaderboard)                   │
│                                                                             │
│  saves: { walletAddress, version, rootHash, txHash, checksum, fileSize,    │
│    daStatus, daCommitment: { requestId, batchId, blobIndex,                │
│    batchHeaderHash, referenceBlockNumber, finalizedAt },                   │
│    computeStatus, computeValidation: { valid, confidence, flags, verdict,  │
│    teeVerified, teeVerifiedIndependently, providerAddress, chatId,         │
│    requestId, billingCost, validatedAt }, timestamps }                     │
│                                                                             │
│  Indexes:                                                                  │
│  • (walletAddress, version DESC) — latest save lookup                      │
│  • (walletAddress, version) UNIQUE — no duplicate versions                 │
│  • rootHash UNIQUE — no hash collisions                                    │
│  • daStatus — filter finalized                                             │
│  • computeStatus — filter validated/rejected                               │
│  • nonces.expiresAt TTL — auto-delete expired nonces                      │
└─────────────────────────────────────────────────────────────────────────────┘

```

> **Layer 5 (Rollup Integration)** is a future design only — OP Stack and Arbitrum Nitro paths are documented in [`docs/future-scaling.md`](docs/future-scaling.md).

---

## Why 0G Storage (not IPFS, not S3)

| Dimension | 0G Storage | IPFS | S3 |
|---|---|---|---|
| **Persistence guarantee** | Economic — on-chain payment to Flow contract funds replication | Voluntary pinning — data disappears if no node pins it | SLA-backed but centralized |
| **Content addressing** | Merkle rootHash (deterministic, collision-resistant) | CID (SHA2-256 of content) | Key-based (not content-addressed) |
| **Censorship resistance** | Permissionless — no single authority can remove data | Semi-decentralized | AWS can terminate account |
| **Retrieval proof** | Merkle proof per segment (SDK verifies locally) | No built-in proof | None |
| **Write authorization** | EVM wallet private key | Anyone can pin anything | IAM credentials |
| **Integration with DA** | Native — rootHash flows directly into DA commitment | No DA layer | No DA layer |

---

## Why 0G DA (not posting rootHash to Ethereum L1 directly)

| Dimension | 0G DA (mainnet) | Ethereum Calldata | Ethereum EIP-4844 Blob |
|---|---|---|---|
| **Cost** | Minimal — BLOB_PRICE on testnet; mainnet pricing TBD by 0G Labs | ~$0.50–$5 per save | ~$0.01–$0.10 per blob |
| **Throughput** | 32 MB blob, high TPS | 128 KB calldata | 128 KB blob, 6 per block |
| **Availability guarantee** | BLS aggregation from >2/3 of DA nodes | Ethereum node consensus | Same as Ethereum |
| **Sampling** | PoDA every 30 blocks (~1.5 min on mainnet) | N/A | DAS (future) |
| **Game saves per day** | Thousands | ~5–10 (gas cost) | ~50–100 |

---

## Why 0G Compute (not backend-only heuristics)

| Dimension | 0G Compute (TEE) | Backend Heuristics |
|---|---|---|
| **Trust** | Cryptographic — TEE hardware attests execution | Operational — trust the server operator |
| **Proof** | EIP-191 sig by on-chain registered TEE key | None |
| **Forgery** | Computationally infeasible (hardware root of trust) | Trivially bypassed with source access |
| **Audit** | chatId → providerAddress → on-chain key lookup | No audit trail |
| **Logic update** | Prompt update only | Code deploy required |

---

## Versioning Strategy

```
wallet: 0xabc...   (0G Mainnet, chain 16661)
saves:
  v1 → rootHash_A (DA: batchId=100, blobIndex=3, block=8200100)  ← compute: CLEAN
  v2 → rootHash_B (DA: batchId=204, blobIndex=7, block=8201840)  ← compute: CLEAN
  v3 → rootHash_C (DA: batchId=389, blobIndex=1, block=8204512)  ← compute: CLEAN  ← latest
```

**Rollback**: `GET /save/download?version=2` → fetch rootHash_B from 0G Storage → Merkle proof verify → checksum match → return file.

**Multi-device conflict**: backend rejects if version ≤ latest. Client receives current version metadata and prompts user (last-write-wins or explicit choose).

**Audit trail**: every version independently retrievable from 0G Storage by rootHash. DA commitments form an immutable timeline anchored to 0G mainnet block numbers.

---

## Security Threat Model

| Threat | Mitigation |
|---|---|
| Replay nonce | `used=true` on first verification; MongoDB TTL auto-expires |
| JWT theft | 24h expiry; no refresh tokens; re-auth on next session |
| Modified .sav with same rootHash | Impossible — rootHash is Merkle root of content |
| Inject rootHash into DB | DA commitment BLS-signed by >2/3 nodes at specific mainnet block |
| Corrupt file after upload | Storage Merkle proof per segment + SHA-256 checksum |
| Plausible fraudulent save | Compute TEE analysis — model flags anomalies inside tamper-proof hardware |
| Replay compute result | rootHash echo binding — result is cryptographically tied to specific save |
| Forge TEE attestation | Requires breaking TEE hardware root of trust |
| Router lies about tee_verified | Independent EIP-191 sig check against on-chain teeSignerAddress |
| DDoS upload endpoint | 5/min per wallet + 300/15min global rate limiter |
| Path traversal via filename | multer sanitises; temp files use `Date.now()_wallet.sav` |

---

## Performance & Scalability

**Stateless backend**: JWT carries walletAddress — any replica serves any request. Deploy N replicas behind a load balancer.

**High-frequency saves**: upload rate limiter (5/min). Client-side debounce: compare local SHA-256 to `CachedMetadata.Checksum` before uploading.

**DA async path**: finalization (~2–5 min on mainnet) is handled by the durable `DAQueue` (MongoDB-backed). The queue survives server restarts — jobs left in `pending` are recovered on next boot. Client polls `daStatus` before leaderboard submission.

**Compute cost**: GLM-5-FP8 at 100B neuron/prompt token. A typical validation call (350 prompt tokens + 80 completion tokens) ≈ **$0.00006**. At 10,000 validations/day ≈ **$0.60/day**.

**Replicas**: `ZG_EXPECTED_REPLICAS=3` on mainnet. The SDK selects nodes via the turbo indexer. Segment-level retries are handled internally.

---

## Deployment Checklist

```bash
# 1. Copy and fill in environment variables
cp backend/.env.example backend/.env

# 2. Generate JWT_SECRET
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 3. Fund ZG_PRIVATE_KEY wallet on 0G Mainnet (chain ID 16661)
#    Bridge or acquire 0G tokens: https://chainscan.0g.ai

# 4. Deposit 0G tokens to DA Payment Contract for blob submission
#    Contract: 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32
#    https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/account/deposits

# 5. Fund Compute Router account
#    pc.0g.ai → Dashboard → Deposit

# 6. Run a 0G DA client node (currently testnet only)
#    Disperser: disperser-testnet.0g.ai:51001
#    DA entrance contract (Galileo testnet): 0xE75A073dA5bb7b0eC622170Fd268f35E675a957B
#    Mainnet DA: check https://docs.0g.ai/developer-hub/building-on-0g/da-integration
#                or ask in https://discord.gg/0glabs for mainnet timeline

# 7. Start all services
docker compose up -d

# 8. Verify health
curl https://api.robowars.xyz/health

# Production hardening:
# - nginx TLS termination in front
# - CORS_ORIGIN set to your game domain
# - MongoDB Atlas M10+ (replica set, not standalone)
# - Secrets manager (Vault / AWS Secrets Manager) for ZG_PRIVATE_KEY
# - ZG_EXPECTED_REPLICAS=3 for mainnet durability
# - Monitor DA finalization lag via daStatus=pending count in MongoDB
```
