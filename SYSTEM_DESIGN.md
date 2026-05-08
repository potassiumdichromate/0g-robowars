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

> **DA Mainnet Status:** As of May 2026, 0G DA does not have published mainnet endpoints or contract addresses in official documentation. All DA integration guide examples reference testnet. The DA layer is in active development. Once 0G Labs publishes mainnet DA, only `ZG_DA_DISPERSER` and `ZG_DA_ENTRANCE_CONTRACT` env vars need updating — no code changes required.

---

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

┌─────────────────────────────────────────────────────────────────────────────┐
│          LAYER 5 — ROLLUP INTEGRATION POINTS (Design Only)                  │
│                                                                             │
│  OP Stack on 0G DA (mainnet):                                               │
│  • op-batcher → 0G DA (testnet: disperser-testnet.0g.ai:51001;             │
│    mainnet endpoint TBD by 0G Labs)                                         │
│  • alt_da.da_commitment_type = "GenericCommitment"                          │
│  • Game state rootHashes embedded in L2 batch data                         │
│  • L2 contract: SaveCommitted(wallet, rootHash, version) event             │
│                                                                             │
│  Arbitrum Nitro on 0G DA:                                                   │
│  • Sequencer inbox batches → 0G DA (replaces AnyTrust DAC)                 │
│  • Disputed scores trigger fraud proofs replaying DA-stored .sav files     │
└─────────────────────────────────────────────────────────────────────────────┘
```

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

## Gas & DA Cost Scaling

The current architecture posts one DA blob per save. At low volume this is fine, but at scale (>10K saves/day) the unoptimized cost profile looks like:

| Volume | Raw DA blobs/day | Problem |
|--------|-----------------|---------|
| 1K saves/day | 1K blobs | Fine — trivial cost |
| 10K saves/day | 10K blobs | DA submission queue starts to back-pressure |
| 100K saves/day | 100K blobs | Unsustainable without batching |

Three scaling strategies, in order of implementation difficulty:

### Strategy 1 — Compression (Quick Win, ~30–60% size reduction)

Gzip the rootHash+wallet+ts payload before dispersing:

```typescript
// In ZeroGDA.publishCommitment():
import { gzipSync } from 'zlib';
const blobData = gzipSync(Buffer.from(payload, 'utf-8'));
```

Smaller blobs → cheaper DA costs. Each blob is already tiny (JSON metadata, <200 bytes), but this matters at scale when many blobs hit the same batch.

### Strategy 2 — Batch Commitment (Medium complexity, ~100x cost reduction)

Instead of one blob per save, aggregate multiple rootHashes into a single DA blob:

```
DABatch blob = {
  gameId: "robowars",
  blockHeight: 8204512,
  commitments: [
    { wallet: "0xabc...", rootHash: "0x9f86...", version: 3, ts: 1746700000 },
    { wallet: "0xdef...", rootHash: "0x1a2b...", version: 7, ts: 1746700001 },
    ... up to ~1000 entries per blob
  ]
}
```

**Implementation changes:**
- `DAQueue` accumulates jobs for up to N seconds (batch window: 30s) or until M jobs are queued (batch size: 100)
- Single `DisperseBlob` call for the whole window
- `daCommitment` in MongoDB stores `{ batchId, blobIndex, commitmentIndex }` — the position of this wallet's entry within the batched blob
- Verification: re-fetch the blob, parse the JSON array, find the entry by wallet+rootHash

**Cost impact:** 100 saves per blob → 100× cheaper per save.

### Strategy 3 — Rollup-First Strategy (High complexity, maximum scalability)

Instead of individual DA blobs, embed rootHashes in L2 batch data:

```
OP Stack sequencer batch (posted to 0G DA) already contains:
  → All L2 transactions for that block window
  → Game actions that reference rootHashes

L2 smart contract:
  event SaveCommitted(address indexed wallet, bytes32 rootHash, uint32 version);

Flow:
  Player action (L2 tx) → SaveCommitted event → batch → 0G DA → finalized
```

**Why this is better at scale:**
- Zero per-save DA cost — rootHashes piggyback on existing L2 batch data
- DA finalization is the same for all saves in the same L2 block (~same latency)
- Leaderboard verification becomes an L2 event query instead of a DA blob parse
- Full rollup fraud-proof guarantees apply

**When to adopt this:**
- When save volume exceeds 50K/day
- When the game already has an L2 deployment for in-game assets or NFTs
- When you want on-chain leaderboard finality without per-entry gas costs

### Current system vs scaled system

| Dimension | Current (v1) | Batch DA | Rollup-First |
|---|---|---|---|
| DA blobs per 1K saves | 1,000 | ~10 | 0 (bundled in L2) |
| Per-save DA cost | $X | $X / 100 | ~$0 marginal |
| Verification complexity | Medium | Medium | Low (event query) |
| Implementation effort | Done ✓ | 1 sprint | 2–3 sprints |
| Required infra | Current | Current | L2 deployment |

**Recommended path:** ship v1 (current), add compression immediately (1 hour of work), add batch commitment when daily saves exceed 5K, consider rollup-first when L2 is on the roadmap.

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
