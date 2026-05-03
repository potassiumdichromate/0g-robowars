import mongoose, { Document, Schema } from 'mongoose';

// ── Compute validation snapshot from 0G Compute Network ───────────────────────
export interface ComputeValidation {
  valid: boolean;
  confidence: number;        // 0.0–1.0 — model's self-reported certainty
  flags: string[];           // e.g. ["file_size_anomaly", "rapid_version_increment"]
  verdict: string;           // "CLEAN" | "SUSPICIOUS" | "REJECTED"
  rootHash: string;          // echoed by model — proves result is bound to this save
  teeVerified: boolean;      // Router's synchronous TEE attestation result
  teeVerifiedIndependently: boolean; // our own EIP-191 sig check result
  providerAddress: string;   // on-chain address of the TEE provider
  chatId: string;            // used for independent signature retrieval
  requestId: string;         // 0G trace request ID
  billingCost: string;       // total neuron cost (informational)
  validatedAt: Date;
}

// ── DA commitment snapshot stored after FINALIZED ──────────────────────────────
export interface DaCommitment {
  requestId: string;       // hex-encoded bytes returned by DisperseBlob
  batchId: number;         // assigned by DA contract after BLS aggregation
  blobIndex: number;       // position within the batch
  batchHeaderHash: string; // keccak256 of BatchHeader — used for retrieval
  referenceBlockNumber: number;
  finalizedAt: Date;
}

// ── Per-save record ─────────────────────────────────────────────────────────────
export interface ISave extends Document {
  walletAddress: string;   // checksummed EIP-55 address
  version: number;         // monotonically increasing per wallet
  rootHash: string;        // 0G Storage Merkle root (hex, 0x-prefixed)
  txHash: string;          // EVM tx hash anchoring the storage submission
  checksum: string;        // SHA-256 of the raw .sav bytes (hex)
  fileSize: number;        // bytes
  daCommitment: DaCommitment | null;
  daStatus: 'pending' | 'finalized' | 'failed';
  computeValidation: ComputeValidation | null;
  computeStatus: 'skipped' | 'pending' | 'validated' | 'rejected';
  createdAt: Date;
  updatedAt: Date;
}

const ComputeValidationSchema = new Schema<ComputeValidation>(
  {
    valid: { type: Boolean, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    flags: { type: [String], default: [] },
    verdict: { type: String, required: true },
    rootHash: { type: String, required: true },
    teeVerified: { type: Boolean, required: true },
    teeVerifiedIndependently: { type: Boolean, required: true },
    providerAddress: { type: String, required: true },
    chatId: { type: String, required: true },
    requestId: { type: String, required: true },
    billingCost: { type: String, default: '0' },
    validatedAt: { type: Date, required: true },
  },
  { _id: false }
);

const DaCommitmentSchema = new Schema<DaCommitment>(
  {
    requestId: { type: String, required: true },
    batchId: { type: Number, required: true },
    blobIndex: { type: Number, required: true },
    batchHeaderHash: { type: String, required: true },
    referenceBlockNumber: { type: Number, required: true },
    finalizedAt: { type: Date, required: true },
  },
  { _id: false }
);

const SaveSchema = new Schema<ISave>(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
      validate: {
        validator: (v: string) => /^0x[0-9a-f]{40}$/i.test(v),
        message: 'Invalid Ethereum address',
      },
    },
    version: {
      type: Number,
      required: true,
      min: 1,
    },
    rootHash: {
      type: String,
      required: true,
      unique: true,
      validate: {
        validator: (v: string) => /^0x[0-9a-f]{64}$/i.test(v),
        message: 'rootHash must be a 32-byte hex string',
      },
    },
    txHash: {
      type: String,
      required: true,
    },
    checksum: {
      type: String,
      required: true,
      validate: {
        validator: (v: string) => /^[0-9a-f]{64}$/i.test(v),
        message: 'checksum must be a SHA-256 hex digest',
      },
    },
    fileSize: {
      type: Number,
      required: true,
      min: 1,
    },
    daCommitment: {
      type: DaCommitmentSchema,
      default: null,
    },
    daStatus: {
      type: String,
      enum: ['pending', 'finalized', 'failed'],
      default: 'pending',
      index: true,
    },
    computeValidation: {
      type: ComputeValidationSchema,
      default: null,
    },
    computeStatus: {
      type: String,
      enum: ['skipped', 'pending', 'validated', 'rejected'],
      default: 'skipped',
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'saves',
  }
);

// Compound index: fast lookup of latest save per wallet
SaveSchema.index({ walletAddress: 1, version: -1 });

// Uniqueness guarantee: one rootHash per (wallet, version) pair
SaveSchema.index({ walletAddress: 1, version: 1 }, { unique: true });

export const Save = mongoose.model<ISave>('Save', SaveSchema);
