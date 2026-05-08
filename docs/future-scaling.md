# 0G RoboWars — Future Scaling & Rollup Roadmap

> **Status: Design only — nothing in this document is built or wired.**
> The current system (v1) works without any of this. These are paths to adopt
> when volume or economic stakes justify the engineering investment.

---

## When to read this

| Trigger | Recommended action |
|---|---|
| Daily saves > 5K | Implement DA compression + batch commits (Strategy 1 & 2) |
| Daily saves > 50K | Consider rollup-first (Strategy 3) |
| Game ships in-game NFTs or an L2 token | Rollup-first becomes natural infra |
| Leaderboard has real economic rewards | Full Layer 5 for fraud-proof finality |

---

## Gas & DA Cost Scaling

The current architecture posts one DA blob per save. At low volume this is fine,
but at scale (>10K saves/day) the unoptimized cost profile becomes significant:

| Volume | Raw DA blobs/day | Status |
|--------|-----------------|--------|
| 1K saves/day | 1K blobs | Fine — trivial cost |
| 10K saves/day | 10K blobs | DA submission queue starts to back-pressure |
| 100K saves/day | 100K blobs | Unsustainable without batching |

---

### Strategy 1 — Compression (Quick Win, ~30–60% blob size reduction)

Gzip the rootHash + wallet + timestamp payload before dispersing to 0G DA:

```typescript
// In ZeroGDA.publishCommitment():
import { gzipSync } from 'zlib';
const blobData = gzipSync(Buffer.from(payload, 'utf-8'));
```

Each blob is already tiny (JSON metadata, <200 bytes), but at scale many blobs
hit the same DA batch window — smaller blobs reduce overall DA throughput pressure.

**Effort:** ~1 hour. **Impact:** 30–60% per-blob size reduction.

---

### Strategy 2 — Batch DA Commits (Medium complexity, ~100x cost reduction)

Instead of one blob per save, accumulate multiple rootHashes in `DAQueue` over
a time window, then submit one blob for the whole batch:

```
DABatch blob = {
  gameId: "robowars",
  blockHeight: 8204512,
  commitments: [
    { wallet: "0xabc...", rootHash: "0x9f86...", version: 3, ts: 1746700000 },
    { wallet: "0xdef...", rootHash: "0x1a2b...", version: 7, ts: 1746700001 },
    ...up to ~1000 entries per blob
  ]
}
```

**Changes required:**
- `DAQueue` accumulates jobs for up to N seconds (batch window: 30s) or M jobs (batch size: 100), whichever comes first
- Single `DisperseBlob` call for the entire window instead of one per save
- `daCommitment` in MongoDB gains a `commitmentIndex` field — the position of this wallet's entry within the batched blob
- Verification: re-fetch the blob from 0G Storage by `batchRootHash`, parse the JSON array, find entry by `wallet + rootHash`, confirm `commitmentIndex` matches

**Cost impact:** 100 saves per blob → 100× cheaper per save.
**Effort:** 1 sprint.

---

### Strategy 3 — Rollup-First (High complexity, maximum scalability)

Instead of posting DA blobs separately, embed rootHashes in an L2 batch:

```
OP Stack sequencer batch (already posted to 0G DA) contains:
  → All L2 transactions for the block window
  → Game actions that emit SaveCommitted events

L2 smart contract:
  event SaveCommitted(address indexed wallet, bytes32 rootHash, uint32 version);

Full flow:
  Player action (L2 tx)
    → SaveCommitted event emitted
    → L2 block sealed
    → Sequencer batch posted to 0G DA
    → DA finalized (BLS >2/3)
    → rootHash is immutably timestamped on-chain
```

**Why this beats individual DA blobs at scale:**
- Zero marginal per-save DA cost — rootHashes piggyback on existing L2 batch data that would be posted regardless
- DA finalization latency is identical for all saves in the same L2 block
- Leaderboard verification becomes a simple L2 event query (`SaveCommitted` by wallet)
- Full rollup fraud-proof guarantees apply — disputed scores can replay the DA-stored `.sav` file against the L2 event log

**When to adopt:**
- Daily saves exceed 50K
- Game already has an L2 deployment (in-game assets, tokens, NFTs)
- Leaderboard has real economic stakes requiring fraud-proof finality

**Effort:** 2–3 sprints + L2 deployment.

---

## Comparison Table

| Dimension | Current (v1) | Batch DA (S2) | Rollup-First (S3) |
|---|---|---|---|
| DA blobs per 1K saves | 1,000 | ~10 | 0 (bundled in L2 batch) |
| Per-save DA cost | $X | $X / 100 | ~$0 marginal |
| Verification complexity | Medium | Medium | Low (L2 event query) |
| Implementation effort | Done ✓ | 1 sprint | 2–3 sprints |
| Required additional infra | None | None | L2 deployment |
| Fraud-proof finality | No | No | Yes |

---

## Layer 5 — Rollup Integration Architecture

This is the design for how the current 0G Storage + DA system would connect to
an OP Stack or Arbitrum Nitro L2 rollup. **Nothing below is implemented.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│          LAYER 5 — ROLLUP INTEGRATION POINTS (Design Only)                  │
│                                                                             │
│  OP Stack on 0G DA:                                                         │
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

### OP Stack integration notes

- `op-node` config: set `--l1-beacon` to the 0G DA disperser endpoint
- `op-batcher` posts channel frames as 0G DA blobs instead of Ethereum calldata
- `alt_da.da_commitment_type = "GenericCommitment"` in the rollup config
- The L2 `SaveCommitted` event carries `rootHash` as `bytes32` — matches the 0G Storage Merkle root directly
- No format conversion needed between the two layers

### Arbitrum Nitro integration notes

- Replace the AnyTrust DAC with 0G DA as the data availability backend
- The sequencer inbox batch poster writes to 0G DA instead of Ethereum
- Dispute resolution: the WASM fraud prover replays the disputed L2 block using the DA-stored batch data
- `.sav` files are retrievable by `rootHash` from 0G Storage for any disputed save during a fraud window

### DA mainnet dependency

Both rollup paths require 0G DA mainnet endpoints, which are not yet published
as of May 2026. Track the mainnet DA release:

- Docs: https://docs.0g.ai/developer-hub/building-on-0g/da-integration
- Discord: https://discord.gg/0glabs (ask in #developer)

Once mainnet DA ships, only `ZG_DA_DISPERSER` and `ZG_DA_ENTRANCE_CONTRACT` env
vars need updating in the current system — no code changes. The same applies to
any rollup integration.
