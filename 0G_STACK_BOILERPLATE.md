# 0G Stack Boilerplate
### Copy-paste ready template for any project using 0G Storage + DA + Compute

> Stack: Node.js + TypeScript + Express + MongoDB + ethers.js  
> Built from: 0G RoboWars (production reference implementation)

---

## ⚡ Quick Reality Check (Read This First)

| Layer | Mainnet? | Endpoint | Contract |
|-------|----------|----------|----------|
| **0G Storage** | ✅ Yes | `https://evmrpc.0g.ai` (chain 16661) | Flow: `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526` |
| **0G Compute** | ✅ Yes | `https://router-api.0g.ai/v1` | Payment: `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` |
| **0G DA** | ⚠️ Testnet only | `disperser-testnet.0g.ai:51001` | DAEntrance: `0xE75A073dA5bb7b0eC622170Fd268f35E675a957B` (Galileo, chain 16602) |

> DA mainnet endpoint not yet published in official docs (as of May 2026).  
> Track: https://docs.0g.ai/developer-hub/building-on-0g/da-integration  
> When mainnet DA drops — only change `ZG_DA_DISPERSER` env var. No code changes needed.

---

## 📦 Install

```bash
npm install @0gfoundation/0g-storage-ts-sdk ethers@^6 @grpc/grpc-js @grpc/proto-loader \
  express mongoose jsonwebtoken multer express-rate-limit helmet cors \
  compression dotenv uuid winston
npm install -D typescript @types/node @types/express @types/multer \
  @types/jsonwebtoken @types/cors @types/compression @types/uuid ts-node-dev
```

---

## 🔑 Environment Variables (copy this to `.env`)

```env
# ── 0G Storage (Mainnet) ────────────────────────────────────────────────────
ZG_RPC_URL=https://evmrpc.0g.ai
ZG_INDEXER_RPC=https://indexer-storage-turbo.0g.ai
ZG_PRIVATE_KEY=0x_your_wallet_private_key
ZG_EXPECTED_REPLICAS=3
ZG_FLOW_CONTRACT=0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526

# ── 0G DA (Testnet — update when mainnet launches) ──────────────────────────
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001
ZG_DA_TLS=false
ZG_DA_POLL_TIMEOUT_MS=120000
ZG_DA_POLL_INTERVAL_MS=5000
ZG_DA_ENTRANCE_CONTRACT=0xE75A073dA5bb7b0eC622170Fd268f35E675a957B

# ── 0G Compute (Mainnet) ────────────────────────────────────────────────────
# Get key: pc.0g.ai → Dashboard → API Keys
# Deposit: pc.0g.ai → Dashboard → Deposit
ZG_COMPUTE_API_KEY=sk-your_api_key
ZG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZG_COMPUTE_MODEL=zai-org/GLM-5-FP8
ZG_COMPUTE_VERIFY_TEE=true
ZG_COMPUTE_INDEPENDENT_VERIFY=true
ZG_COMPUTE_TIMEOUT_MS=30000
ZG_COMPUTE_MIN_CONFIDENCE=0.70
ZG_COMPUTE_ROUTING=latency

# ── Auth ────────────────────────────────────────────────────────────────────
JWT_SECRET=generate_with_node_crypto_randomBytes_64
JWT_EXPIRES_IN=24h
NONCE_EXPIRY_MS=300000

# ── App ─────────────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=production
MONGO_URI=mongodb://localhost:27017/yourapp
```

---

## 🗄️ MongoDB Schema Pattern

```typescript
// ── Reusable interfaces — drop into your models/ folder ──────────────────────

export interface ComputeValidation {
  valid: boolean;
  confidence: number;           // 0.0 – 1.0
  flags: string[];
  verdict: 'CLEAN' | 'SUSPICIOUS' | 'REJECTED';
  rootHash: string;             // echoed by model (binding proof)
  teeVerified: boolean;         // Router's synchronous check
  teeVerifiedIndependently: boolean;  // your own EIP-191 check
  providerAddress: string;      // on-chain provider address
  chatId: string;               // for independent sig retrieval
  requestId: string;
  billingCost: string;          // in neuron
  validatedAt: Date;
}

export interface DaCommitment {
  requestId: string;            // hex from DisperseBlob
  batchId: number;
  blobIndex: number;
  batchHeaderHash: string;
  referenceBlockNumber: number;
  finalizedAt: Date;
}

// Add these fields to ANY mongoose schema that needs 0G integration:
const YourSchema = new Schema({
  // ... your fields ...

  // Storage
  rootHash:   { type: String, required: true, unique: true },
  txHash:     { type: String, required: true },
  checksum:   { type: String, required: true },  // SHA-256 hex

  // DA
  daStatus:     { type: String, enum: ['pending','finalized','failed'], default: 'pending' },
  daCommitment: { type: DaCommitmentSubdoc, default: null },

  // Compute
  computeStatus:     { type: String, enum: ['skipped','pending','validated','rejected'], default: 'skipped' },
  computeValidation: { type: ComputeValidationSubdoc, default: null },
}, { timestamps: true });
```

---

## 📁 Service 1 — ZeroGStorage.ts

```typescript
import { ZgFile, Indexer } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';

export class ZeroGStorage {
  private indexer: Indexer;
  private signer: ethers.Wallet;

  constructor(rpcUrl: string, indexerRpc: string, privateKey: string) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer  = new ethers.Wallet(privateKey, provider);
    this.indexer = new Indexer(indexerRpc);
  }

  // Upload any binary file — returns rootHash (permanent content ID)
  async upload(filePath: string): Promise<{ rootHash: string; txHash: string }> {
    const file = await ZgFile.fromFilePath(filePath);
    try {
      const [, treeErr] = await file.merkleTree();
      if (treeErr) throw new Error(`Merkle tree: ${treeErr}`);

      const [tx, err] = await this.indexer.upload(file, this.rpcUrl, this.signer);
      if (err) throw new Error(`Upload: ${err}`);

      if ('rootHash' in tx) return { rootHash: tx.rootHash as string, txHash: tx.txHash as string };
      const roots = tx.rootHashes as string[];
      return { rootHash: roots[0], txHash: (tx.txHashes as string[])[0] };
    } finally {
      await file.close();
    }
  }

  // Download with Merkle proof verification (withProof=true always)
  async download(rootHash: string, outputPath: string): Promise<void> {
    const err = await this.indexer.download(rootHash, outputPath, true);
    if (err) throw new Error(`Download: ${err}`);
  }
}
```

**Key facts:**
- `rootHash` = Merkle root over 256-byte segments. Same file → same hash always.
- `withProof: true` on download = SDK verifies every segment before writing. Tampered data throws before hitting disk.
- Upload pays gas on the 0G chain (Flow contract). Fund `ZG_PRIVATE_KEY` wallet with 0G tokens.

---

## 📁 Service 2 — ZeroGDA.ts

```typescript
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

// Proto file: copy disperser.proto from this repo's src/proto/ folder
// It defines: DisperseBlob, GetBlobStatus, BlobStatus enum

export class ZeroGDA {
  private client: any;

  constructor(disperserEndpoint: string, useTls: boolean) {
    const packageDef = protoLoader.loadSync(
      path.resolve(__dirname, '../proto/disperser.proto'),
      { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
    );
    const proto = grpc.loadPackageDefinition(packageDef) as any;
    const creds = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.client = new proto.disperser.Disperser(disperserEndpoint, creds);
  }

  // Publish any payload to DA. Returns commitment once FINALIZED (BLS signed by >2/3 nodes).
  async publishCommitment(payload: object, accountAddress: string): Promise<DaCommitment> {
    const data  = Buffer.from(JSON.stringify(payload), 'utf-8');
    const reqId = await this.disperseBlob(data, accountAddress);
    return await this.pollFinality(reqId);
  }

  // Verify a stored commitment is still valid on DA
  async verifyCommitment(commitment: DaCommitment): Promise<boolean> {
    return new Promise(resolve => {
      this.client.GetBlobStatus(
        { request_id: Buffer.from(commitment.requestId, 'hex') },
        (err: any, reply: any) => {
          if (err) return resolve(false);
          resolve(
            reply.status === 3 &&  // FINALIZED
            reply.blob_verification_proof?.batch_id === commitment.batchId &&
            reply.blob_verification_proof?.blob_index === commitment.blobIndex
          );
        }
      );
    });
  }

  private disperseBlob(data: Buffer, account: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.DisperseBlob(
        { data, custom_quorum_numbers: [], account_id: { account_id: account.toLowerCase() } },
        (err: any, reply: any) => {
          if (err || reply.result === 2) return reject(err ?? new Error('DA blob FAILED'));
          resolve(reply.request_id.toString('hex'));
        }
      );
    });
  }

  private pollFinality(requestId: string): Promise<DaCommitment> {
    const deadline = Date.now() + 120_000;
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (Date.now() > deadline) return reject(new Error('DA finality timeout'));
        this.client.GetBlobStatus(
          { request_id: Buffer.from(requestId, 'hex') },
          (err: any, reply: any) => {
            if (err) return reject(err);
            if (reply.status === 3) {  // FINALIZED
              resolve({
                requestId,
                batchId: reply.blob_verification_proof.batch_id,
                blobIndex: reply.blob_verification_proof.blob_index,
                batchHeaderHash: reply.blob_verification_proof.batch_metadata?.batch_header_hash.toString('hex') ?? '',
                referenceBlockNumber: reply.signed_batch?.header?.reference_block_number ?? 0,
                finalizedAt: new Date(),
              });
            } else if (reply.status === 2 || reply.status === 4) {
              reject(new Error(`DA failed: status ${reply.status}`));
            } else {
              setTimeout(poll, 5000);
            }
          }
        );
      };
      poll();
    });
  }
}
```

**DA BlobStatus enum:**
```
0 = UNKNOWN   1 = PROCESSING   2 = FAILED   3 = FINALIZED   4 = INSUFFICIENT_SIGNATURES
```

**What DA actually proves:** rootHash existed + was available at `referenceBlockNumber`. BLS signatures from >2/3 nodes mean retroactive forgery is impossible.

---

## 📁 Service 3 — ComputeService.ts

```typescript
// 0G Compute Router — OpenAI-compatible API with TEE attestation

interface ComputeInput {
  [key: string]: unknown;   // whatever metadata you want validated
}

export class ComputeService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl;
    this.apiKey  = apiKey;
    this.model   = model;
  }

  async validate(
    systemPrompt: string,
    input: ComputeInput,
    bindingKey: string,       // field name the model MUST echo back (anti-replay)
    bindingValue: string      // expected value of that field
  ): Promise<ComputeValidation> {

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: JSON.stringify(input) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 300,
        verify_tee: true,                          // TEE attestation
        provider: { sort: 'latency' },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`Compute HTTP ${res.status}`);

    const data = await res.json() as any;
    const trace = data.x_0g_trace;
    const chatId = res.headers.get('ZG-Res-Key') ?? data.id;
    const content = data.choices[0]?.message?.content ?? '';

    let parsed: any;
    try { parsed = JSON.parse(content); }
    catch { throw new Error(`Non-JSON from model: ${content.slice(0, 200)}`); }

    // ── BINDING CHECK — prevents replaying results from other inputs ──────────
    if (parsed[bindingKey] !== bindingValue) {
      throw new Error(
        `Compute binding violation: ${bindingKey} mismatch. ` +
        `Expected ${bindingValue}, got ${parsed[bindingKey]}`
      );
    }

    return {
      valid: parsed.valid === true && parsed.confidence >= 0.7,
      confidence: parsed.confidence,
      flags: parsed.flags ?? [],
      verdict: parsed.verdict,
      rootHash: parsed[bindingKey],
      teeVerified: trace.tee_verified === true,
      teeVerifiedIndependently: false,   // wire up ComputeVerifier if needed
      providerAddress: trace.provider,
      chatId,
      requestId: trace.request_id,
      billingCost: trace.billing.total_cost,
      validatedAt: new Date(),
    };
  }
}
```

**System prompt pattern (copy and adapt):**
```typescript
const MY_SYSTEM_PROMPT = `
You are a validator for <YOUR DOMAIN>.
Respond ONLY with valid JSON matching this schema:
{
  "<bindingKey>": "<echo exactly as provided>",
  "valid": <boolean>,
  "confidence": <float 0.0-1.0>,
  "flags": [<anomaly codes>],
  "verdict": "<CLEAN | SUSPICIOUS | REJECTED>",
  "reasoning": "<one sentence>"
}
Rules:
  - confidence < 0.4 → REJECTED
  - confidence 0.4-0.7 → SUSPICIOUS  
  - confidence > 0.7 + no critical flags → CLEAN
  - No text outside the JSON.
`;
```

---

## 🔐 Auth Pattern (Wallet + JWT)

```typescript
// Step 1 — generate nonce
const nonce   = uuidv4();
const message = `<YourApp> — Sign to authenticate.\nWallet: ${wallet}\nNonce: ${nonce}`;
// Store nonce in DB with { used: false, expiresAt: Date.now() + 5min }
// MongoDB TTL index on expiresAt deletes it automatically

// Step 2 — verify signature
const recovered = ethers.verifyMessage(message, signature).toLowerCase();
if (recovered !== wallet.toLowerCase()) throw new Error('Bad signature');
// Mark nonce used=true (anti-replay)
// Issue JWT: jwt.sign({ walletAddress }, secret, { expiresIn: '24h' })

// Middleware
const payload = jwt.verify(token, secret) as { walletAddress: string };
req.walletAddress = payload.walletAddress;
```

---

## 🔄 The Upload Flow (Wire These Together)

```typescript
// This is the core pattern — adapt for your domain

async function handleUpload(filePath: string, walletAddress: string, triggerCompute: boolean) {

  // 1. Upload to 0G Storage → rootHash
  const { rootHash, txHash } = await zgStorage.upload(filePath);

  // 2. Compute gate (conditional — not every upload)
  let computeResult = null;
  if (triggerCompute || autoShouldTrigger(metadata)) {
    computeResult = await computeService.validate(
      SYSTEM_PROMPT,
      { rootHash, ...metadata },
      'rootHash',   // binding key
      rootHash      // binding value
    );
    if (computeResult.verdict === 'REJECTED') {
      // Hard stop — never reaches DB or DA
      throw new Error('Rejected by compute validation');
    }
  }

  // 3. Save to MongoDB
  const doc = await YourModel.create({
    walletAddress,
    rootHash, txHash,
    checksum: sha256(fileBytes),
    daStatus: 'pending',
    computeStatus: computeResult ? 'validated' : 'skipped',
    computeValidation: computeResult,
  });

  // 4. Async DA commitment (don't block response)
  setImmediate(async () => {
    try {
      const commitment = await zgDA.publishCommitment({ rootHash, wallet: walletAddress, ts: Date.now() }, walletAddress);
      await YourModel.findByIdAndUpdate(doc._id, { daStatus: 'finalized', daCommitment: commitment });
    } catch {
      await YourModel.findByIdAndUpdate(doc._id, { daStatus: 'failed' });
    }
  });

  return { rootHash, computeResult };
}

// Heuristics — when to auto-trigger compute (saves API cost)
function autoShouldTrigger(meta: any): boolean {
  return (
    meta.isFirstItem ||                             // establish baseline
    meta.timeSincePrevious < 30_000 ||              // suspiciously rapid
    meta.size === 0 ||                              // empty
    (meta.prevSize && meta.size > meta.prevSize * 4)  // size jumped 4x
  );
}
```

---

## ✅ 4-Layer Verification Pattern

```typescript
async function verifyItem(walletAddress: string, rootHash: string): Promise<{
  verdict: 'CLEAN' | 'TAMPERED' | 'UNVERIFIED' | 'DA_PENDING' | 'COMPUTE_PENDING';
  checks: Record<string, boolean>;
}> {
  const doc = await YourModel.findOne({ walletAddress, rootHash }).lean();
  if (!doc) return { verdict: 'TAMPERED', checks: {} };           // L1 fail

  if (doc.daStatus !== 'finalized') return { verdict: 'DA_PENDING', checks: {} }; // L2 pending

  const daOk = await zgDA.verifyCommitment(doc.daCommitment);     // L2 verify
  
  // L3 — re-download and checksum
  await zgStorage.download(rootHash, '/tmp/verify.bin');
  const actual = sha256(fs.readFileSync('/tmp/verify.bin'));
  const checksumOk = actual === doc.checksum;

  // L4 — compute (re-run if missing or stale)
  let computeOk = false;
  if (doc.computeValidation?.teeVerified) {
    computeOk = doc.computeValidation.valid;
  } else {
    const result = await computeService.validate(SYSTEM_PROMPT, { rootHash }, 'rootHash', rootHash);
    computeOk = result.valid;
  }

  const allPassed = daOk && checksumOk && computeOk;
  return {
    verdict: allPassed ? 'CLEAN' : 'TAMPERED',
    checks: { daOk, checksumOk, computeOk },
  };
}
```

---

## 🚫 Gotchas (Learn From Mistakes)

| Gotcha | What Happens | Fix |
|--------|-------------|-----|
| DA mainnet not live | `disperser.0g.ai:51001` doesn't exist | Use testnet, watch docs |
| `ZG_DA_PAYMENT_CONTRACT` confusion | That address is for **Compute**, not DA | DA uses `ZG_DA_ENTRANCE_CONTRACT` |
| Compute binding skip | Model returns result for different input | Always check `response[bindingKey] === expected` |
| DA running sync | Response blocked for 2+ min | Always `setImmediate` — never await DA in request handler |
| Compute every upload | Expensive + slow | Only on high-stakes events or suspicious heuristics |
| `withProof: false` on download | Tampered file accepted silently | Always `withProof: true` |
| TLS on testnet DA | Connection refused | `ZG_DA_TLS=false` for testnet, `true` for mainnet (when available) |
| `replicas=1` on mainnet | Data may be lost | `ZG_EXPECTED_REPLICAS=3` minimum on mainnet |
| Not marking nonce `used=true` | Same signature accepted twice | Always flip `used` flag atomically before issuing JWT |

---

## 📋 Checklist For New Project

```
[ ] npm install packages above
[ ] Copy disperser.proto → src/proto/disperser.proto
[ ] Copy ZeroGStorage.ts, ZeroGDA.ts, ComputeService.ts → src/services/
[ ] Add ComputeValidation + DaCommitment interfaces to your model
[ ] Add env vars from template above to .env
[ ] Fund ZG_PRIVATE_KEY on 0G mainnet (for Storage)
[ ] Deposit 0G tokens at pc.0g.ai (for Compute)
[ ] Wire upload flow: Storage → Compute gate → MongoDB → async DA
[ ] Write system prompt for your domain
[ ] Choose your binding key (unique ID of the item being validated)
[ ] Set auto-trigger heuristics for your use case
[ ] Test: upload → check daStatus polling → verify endpoint
[ ] DA: confirm testnet working; swap env var when mainnet launches
```

---

## 🔗 Official Links

| Resource | URL |
|----------|-----|
| Storage SDK docs | https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk |
| DA integration | https://docs.0g.ai/developer-hub/building-on-0g/da-integration |
| Compute quickstart | https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart |
| Verifiable execution | https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution |
| Mainnet overview | https://docs.0g.ai/developer-hub/mainnet/mainnet-overview |
| Compute dashboard | https://pc.0g.ai |
| Mainnet explorer | https://chainscan.0g.ai |
| Discord (for DA mainnet ETA) | https://discord.gg/0glabs |

---

*Reference implementation: 0G RoboWars — C:\Users\RENTKAR\Desktop\0g-ai\0g-Robowars*
