# 0G RoboWars — API Reference

Base URL: `http://localhost:3000` (dev) / `https://api.robowars.xyz` (prod)

All authenticated endpoints require `Authorization: Bearer <JWT>` header.
All request/response bodies are `application/json` unless noted.

---

## Authentication

### POST /auth/nonce

Generate a single-use nonce for wallet authentication. The returned `message` must be signed by the player's wallet using `personal_sign` (EIP-191).

**Rate limit:** 10 requests / 5 min per wallet

**Request**
```json
{ "walletAddress": "0xabc...123" }
```

**Response 200**
```json
{
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "message": "0G RoboWars — Sign to authenticate.\nWallet: 0xabc...123\nNonce: 550e8400-...\nThis request will not trigger a blockchain transaction or cost any gas.",
  "expiresInMs": 300000
}
```

**Errors**

| Code | Body | Cause |
|------|------|-------|
| 400 | `{"error":"walletAddress is required"}` | Missing field |
| 400 | `{"error":"Invalid Ethereum address"}` | Malformed address |
| 429 | `{"error":"Too many auth attempts..."}` | Rate limit hit |

---

### POST /auth/verify

Submit the wallet signature to obtain a JWT session token.

**Rate limit:** 10 requests / 5 min per wallet

**Request**
```json
{
  "walletAddress": "0xabc...123",
  "signature": "0xdeadbeef..."
}
```

**Response 200**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "walletAddress": "0xabc...123",
  "expiresIn": "24h"
}
```

**Errors**

| Code | Body | Cause |
|------|------|-------|
| 400 | `{"error":"walletAddress and signature are required"}` | Missing fields |
| 401 | `{"error":"Nonce not found, expired, or already used"}` | Stale/used nonce |
| 401 | `{"error":"Signature does not match wallet address"}` | Wrong signer |

---

## Save Management

All `/save/*` routes require `Authorization: Bearer <JWT>`.

---

### POST /save/upload

Upload a `.sav` file to 0G Storage. Optionally triggers 0G Compute validation.

**Rate limit:** 5 requests / 1 min per wallet  
**Content-Type:** `multipart/form-data`  
**Field name:** `savefile`  
**Max size:** 50 MB

**Headers (optional)**

| Header | Value | Effect |
|--------|-------|--------|
| `X-Compute-Trigger` | `true` | Explicitly request 0G Compute validation for this upload |

> Compute also auto-triggers on suspicious saves (first save, rapid re-upload < 30s, file size jump > 300%, version gap > 1).

**Upload pipeline**
```
multipart .sav → GVAS magic check → SHA-256 → 0G Storage → (Compute gate) → MongoDB → async DA
```

**Response 201** — save accepted
```json
{
  "message": "Save uploaded successfully",
  "version": 3,
  "rootHash": "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "txHash": "0xabc123...",
  "checksum": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "daStatus": "pending",
  "computeStatus": "validated",
  "computeVerdict": "CLEAN",
  "computeConfidence": 0.97,
  "teeVerified": true,
  "saveId": "664f1a2b3c4d5e6f7a8b9c0d"
}
```

**Response 400** — compute rejected the save
```json
{
  "error": "Save rejected by 0G Compute validation",
  "verdict": "REJECTED",
  "confidence": 0.95,
  "flags": ["extreme_size_jump", "rapid_save_spam"],
  "teeVerified": true,
  "providerAddress": "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C"
}
```

**`computeStatus` values**

| Value | Meaning |
|-------|---------|
| `skipped` | Not triggered for this upload |
| `pending` | Triggered but Compute network error — will retry |
| `validated` | Passed (CLEAN or SUSPICIOUS) |
| `rejected` | Failed (REJECTED) — save discarded |

**`computeVerdict` values**

| Value | Meaning |
|-------|---------|
| `CLEAN` | No anomalies, confidence ≥ 0.70 |
| `SUSPICIOUS` | Minor flags or low confidence; save accepted but flagged |
| `REJECTED` | Critical flags detected; save rejected |
| `null` | Compute not triggered (`computeStatus: "skipped"`) |

**Errors**

| Code | Body | Cause |
|------|------|-------|
| 400 | `{"error":"No file attached..."}` | Missing `savefile` field |
| 400 | `{"error":"Only .sav files are accepted"}` | Wrong extension |
| 400 | `{"error":"Invalid .sav file: missing Unreal GVAS header."}` | Magic byte check failed |
| 400 | `{"error":"Save rejected by 0G Compute validation", ...}` | Compute REJECTED verdict |
| 413 | `{"error":"File too large..."}` | Exceeds 50 MB |
| 429 | `{"error":"Upload rate limit exceeded..."}` | Rate limit hit |
| 500 | `{"error":"Upload failed. Please try again."}` | Storage or internal error |

---

### GET /save/latest

Return metadata for the authenticated wallet's most recent save. Does **not** return file bytes.

**Response 200**
```json
{
  "version": 3,
  "rootHash": "0x9f86d081...",
  "txHash": "0xabc123...",
  "checksum": "9f86d081...",
  "fileSize": 524288,
  "daStatus": "finalized",
  "daCommitment": {
    "requestId": "a3f4...",
    "batchId": 204,
    "blobIndex": 7,
    "batchHeaderHash": "0xdeadbeef...",
    "referenceBlockNumber": 18450200,
    "finalizedAt": "2026-05-03T12:00:00.000Z"
  },
  "computeStatus": "validated",
  "computeValidation": {
    "valid": true,
    "confidence": 0.97,
    "flags": [],
    "verdict": "CLEAN",
    "teeVerified": true,
    "teeVerifiedIndependently": true,
    "providerAddress": "0xd9966e...",
    "chatId": "chatcmpl-abc123",
    "requestId": "0852f405-6c56-40c2-a800-e6fd70785065",
    "billingCost": "1200000000000",
    "validatedAt": "2026-05-03T11:59:55.000Z"
  },
  "createdAt": "2026-05-03T12:00:00.000Z"
}
```

**Errors**

| Code | Body | Cause |
|------|------|-------|
| 404 | `{"error":"No saves found for this wallet"}` | First-time player |

---

### GET /save/history

Return all save versions for the authenticated wallet, newest first. Max 50 entries.

**Response 200**
```json
{
  "saves": [
    {
      "version": 3,
      "rootHash": "0x9f86d081...",
      "checksum": "9f86d081...",
      "fileSize": 524288,
      "daStatus": "finalized",
      "computeStatus": "validated",
      "createdAt": "2026-05-03T12:00:00.000Z"
    }
  ],
  "count": 3
}
```

---

### GET /save/download

Download the binary `.sav` file from 0G Storage with Merkle proof verification and SHA-256 integrity check.

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | integer | latest | Specific version to download |

**Response 200** — `application/octet-stream`

Response headers:

| Header | Example | Description |
|--------|---------|-------------|
| `Content-Disposition` | `attachment; filename="robowars_v3.sav"` | |
| `X-RootHash` | `0x9f86d081...` | Content identifier |
| `X-Checksum` | `9f86d081...` | SHA-256 for client-side verify |
| `X-Version` | `3` | Version number |
| `X-DA-Status` | `finalized` | DA commitment status |

**Errors**

| Code | Body | Cause |
|------|------|-------|
| 403 | `{"error":"Access denied: not the resource owner"}` | JWT wallet ≠ save owner |
| 404 | `{"error":"Save not found"}` | Version does not exist |
| 500 | `{"error":"Integrity check failed..."}` | SHA-256 mismatch post-download |
| 500 | `{"error":"Failed to retrieve save from 0G Storage"}` | Storage node error |

---

### POST /save/verify

Run the full four-layer anti-cheat check on a specific rootHash.

**Request**
```json
{ "rootHash": "0x9f86d081..." }
```

**Response 200**
```json
{
  "rootHash": "0x9f86d081...",
  "version": 3,
  "checksumMatch": true,
  "daCommitmentValid": true,
  "verdict": "CLEAN",
  "checks": {
    "rootHashKnown": true,
    "daCommitmentPresent": true,
    "daCommitmentValid": true,
    "storageChecksumMatch": true,
    "computeValidationPresent": true,
    "computeValidationPassed": true,
    "computeTeeVerified": true,
    "computeIndependentlyVerified": true
  },
  "computeValidation": {
    "valid": true,
    "confidence": 0.97,
    "verdict": "CLEAN",
    "teeVerified": true,
    "providerAddress": "0xd9966e...",
    "validatedAt": "2026-05-03T11:59:55.000Z"
  }
}
```

**`verdict` values**

| Value | All layers | Description |
|-------|------------|-------------|
| `CLEAN` | All pass | Save is authentic and compute-verified |
| `TAMPERED` | Any fail | Integrity violation detected |
| `DA_PENDING` | DA not finalized | DA commitment not yet on-chain |
| `COMPUTE_PENDING` | Compute missing | No TEE result yet |
| `UNVERIFIED` | rootHash unknown | Not in DB for this wallet |

**Errors**

| Code | Body | Cause |
|------|------|-------|
| 400 | `{"error":"rootHash is required"}` | Missing field |
| 404 | `{"error":"Save not found for this wallet + rootHash"}` | Unknown rootHash |

---

## Leaderboard

### POST /leaderboard/submit

Submit a score. Requires `Authorization: Bearer <JWT>`. Runs full four-layer verification before accepting.

**Request**
```json
{ "score": 98450 }
```

**Response 200** — score accepted
```json
{
  "message": "Score submitted",
  "score": 98450,
  "verdict": "CLEAN"
}
```

**Response 200** — score not updated (existing is higher)
```json
{
  "message": "Score not updated (existing score is higher)",
  "currentBest": 102000
}
```

**Response 403** — verification failed
```json
{
  "error": "Save verification failed: TAMPERED",
  "report": {
    "verdict": "TAMPERED",
    "checks": { ... }
  }
}
```

**Errors**

| Code | Body | Cause |
|------|------|-------|
| 400 | `{"error":"score must be a non-negative number"}` | Invalid score |
| 403 | `{"error":"Save verification failed: <verdict>", "report": {...}}` | Any verification layer failed |

---

### GET /leaderboard/top

Fetch top scores. Public endpoint — no auth required.

**Query parameters**

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `limit` | integer | 100 | 100 | Number of entries to return |

**Response 200**
```json
{
  "entries": [
    {
      "walletAddress": "0xabc...123",
      "score": 102000,
      "saveVersion": 5,
      "computeVerdict": "CLEAN",
      "computeProvider": "0xd9966e...",
      "verifiedAt": "2026-05-03T12:00:00.000Z"
    }
  ],
  "count": 1
}
```

> `computeProvider` is the on-chain address of the TEE provider that validated the save backing this score. Anyone can independently verify the attestation using the 0G chain.

---

## Health

### GET /health

Unauthenticated liveness check.

**Response 200**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "network": {
    "storage": "https://indexer-storage-turbo.0g.ai",
    "da": "disperser-testnet.0g.ai:51001"
  },
  "uptime": 3842.1
}
```

---

## Error format

All error responses follow the same shape:

```json
{ "error": "<human-readable message>" }
```

For validation rejections, additional fields are included:

```json
{
  "error": "Save rejected by 0G Compute validation",
  "verdict": "REJECTED",
  "confidence": 0.95,
  "flags": ["extreme_size_jump"],
  "teeVerified": true,
  "providerAddress": "0xd9966e..."
}
```

---

## Rate limits

| Endpoint group | Window | Max requests | Key |
|----------------|--------|-------------|-----|
| Global (all routes) | 15 min | 300 | IP |
| POST /auth/nonce | 5 min | 10 | wallet address |
| POST /auth/verify | 5 min | 10 | wallet address |
| POST /save/upload | 1 min | 5 | wallet address (from JWT) |

Rate-limited responses return HTTP 429 with:
```json
{ "error": "Too many requests, please try again later." }
```

Standard headers are included on every response:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

---

## DA status lifecycle

```
pending ──► finalized   (success — BLS aggregated, on-chain)
        └─► failed      (DA network error — save still accessible via Storage)
```

DA finalization is asynchronous (~2 min). Poll `GET /save/latest` and check `daStatus`.
Leaderboard submission requires `daStatus === "finalized"`.

---

## Compute status lifecycle

```
skipped ──────────────────────────────────────────── (not triggered)
pending ──► validated   (CLEAN or SUSPICIOUS verdict)
        └─► rejected    (REJECTED verdict — save discarded, never in DB)
```

`pending` after a Compute network error means the upload succeeded in Storage but the validation is outstanding. Re-trigger via `POST /save/verify`.

---

## Unreal Engine quick-reference

```cpp
// Auth
SaveSystem->RequestNonce(WalletAddress);
// → sign returned message with wallet
SaveSystem->VerifySignature(WalletAddress, Signature);

// Save on level complete (with compute)
SaveSystem->UploadSave(true);

// Routine autosave (heuristics decide compute)
SaveSystem->UploadSave(false);

// Load on game start
SaveSystem->DownloadAndApplySave();

// Pre-leaderboard check
SaveSystem->TriggerComputeValidation(CachedMetadata.RootHash);

// Delegates
OnAuthComplete(bool bSuccess, FString ErrorOrMessage)
OnSaveUploadComplete(bool bSuccess, FString RootHash, int32 Version, FString Error)
OnSaveDownloadComplete(bool bSuccess, int32 Version, FString Error)
OnComputeValidationComplete(bool bAccepted, FString Verdict, float Confidence, bool bTeeVerified, FString Error)
OnVerifyComplete(bool bSuccess, FString Verdict, FString Error)
```
