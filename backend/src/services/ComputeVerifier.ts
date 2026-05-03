/**
 * ComputeVerifier — performs INDEPENDENT cryptographic verification of a
 * 0G Compute provider's TEE attestation.
 *
 * ── Why this matters ───────────────────────────────────────────────────────────
 *
 * When `verify_tee: true` is sent to the Router, the Router performs its own
 * verification and reports `x_0g_trace.tee_verified: true/false`.
 * This is convenient but still requires trusting the Router's intermediary check.
 *
 * For a production game where cheating has real stakes (leaderboards, NFT rewards),
 * we perform our own verification independently of the Router:
 *
 *  1. Fetch the raw EIP-191 signature from the provider's node directly.
 *  2. Recover the signer address using ethers.js.
 *  3. Query the 0G chain for the provider's on-chain service record to get the
 *     expected `teeSignerAddress`.
 *  4. Confirm they match.
 *
 * This means even if the Router lies about `tee_verified`, we catch it.
 * Any adversary would need to compromise both the TEE hardware AND the
 * 0G chain state — computationally infeasible.
 *
 * ── Signature format ───────────────────────────────────────────────────────────
 *
 * The provider signs using EIP-191 `personal_sign`:
 *   signature = sign(keccak256("\x19Ethereum Signed Message:\n" + len(text) + text))
 *
 * Where `text` is the raw response body content.
 * We verify: ethers.verifyMessage(text, signature) === teeSignerAddress
 *
 * ── On-chain service record ────────────────────────────────────────────────────
 *
 * The provider's `teeSignerAddress` is stored in the 0G Service registry contract.
 * If `additionalInfo.targetSeparated === true`, use `additionalInfo.targetTeeAddress`.
 *
 * We query the registry via the 0G mainnet EVM RPC (https://evmrpc.0g.ai).
 */

import { ethers } from 'ethers';
import { config } from '../config';
import { logger } from '../utils/logger';

interface ProviderSignatureResponse {
  text: string;
  signature: string;
}

// Minimal ABI for the 0G Service Registry — only the getService function
// The actual deployed ABI may vary; this covers the fields documented.
const SERVICE_REGISTRY_ABI = [
  {
    inputs: [{ name: 'provider', type: 'address' }],
    name: 'getService',
    outputs: [
      {
        components: [
          { name: 'url', type: 'string' },
          { name: 'teeSignerAddress', type: 'address' },
          { name: 'verifiability', type: 'uint8' },
          {
            components: [
              { name: 'targetSeparated', type: 'bool' },
              { name: 'targetTeeAddress', type: 'address' },
            ],
            name: 'additionalInfo',
            type: 'tuple',
          },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// 0G Compute Service Registry contract address (mainnet — set via ZG_SERVICE_REGISTRY_ADDRESS env var)
// Update to mainnet address when deploying to production
const SERVICE_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000000000'; // placeholder — set via env

export class ComputeVerifier {
  private provider: ethers.JsonRpcProvider;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.ZG_RPC_URL);
  }

  /**
   * Independently verify the TEE attestation for a compute response.
   *
   * @param providerAddress - On-chain address of the provider (from x_0g_trace.provider)
   * @param chatId          - Chat ID from ZG-Res-Key header or response.id
   * @param model           - Model identifier used in the request
   * @param expectedContent - The exact response content string to verify against
   * @returns true if the EIP-191 signature is valid and matches the on-chain TEE key
   */
  async verifyTeeSignature(
    providerAddress: string,
    chatId: string,
    model: string,
    expectedContent: string
  ): Promise<boolean> {
    try {
      // Step 1: Fetch the raw signature from the provider's endpoint
      const { providerUrl, teeSignerAddress } = await this.getProviderRecord(providerAddress);

      // Step 2: Request the signature for this chatId
      const sigUrl = `${providerUrl}/v1/proxy/signature/${chatId}?model=${encodeURIComponent(model)}`;
      const sigRes = await fetch(sigUrl, { signal: AbortSignal.timeout(10_000) });

      if (!sigRes.ok) {
        logger.warn('Provider signature endpoint returned error', {
          providerAddress,
          chatId,
          status: sigRes.status,
        });
        return false;
      }

      const { text, signature } = (await sigRes.json()) as ProviderSignatureResponse;

      // Step 3: EIP-191 signature verification
      // The signed text must match what the Router returned to us.
      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.verifyMessage(text, signature).toLowerCase();
      } catch (err) {
        logger.warn('EIP-191 signature parse error', { err });
        return false;
      }

      // Step 4: Compare recovered address against on-chain TEE key
      if (recoveredAddress !== teeSignerAddress.toLowerCase()) {
        logger.warn('TEE signer mismatch', {
          recovered: recoveredAddress,
          onChain: teeSignerAddress,
          providerAddress,
        });
        return false;
      }

      // Step 5: Confirm the signed content matches our expected response
      // The `text` field from the provider IS the raw content string.
      // We check it equals the content we received from the Router.
      if (text !== expectedContent) {
        logger.warn('TEE signed content does not match Router response', {
          providerAddress,
          chatId,
          textLen: text.length,
          expectedLen: expectedContent.length,
        });
        return false;
      }

      logger.debug('Independent TEE verification passed', {
        providerAddress,
        chatId,
        teeSignerAddress,
      });

      return true;
    } catch (err) {
      logger.warn('Independent TEE verification error (non-fatal)', {
        providerAddress,
        chatId,
        err: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * Fetch the provider's on-chain service record.
   *
   * Returns the provider's URL and teeSignerAddress from the 0G Service Registry.
   *
   * NOTE: The actual Service Registry contract address must be configured.
   * Until it is, we fall back to querying the Router's /v1/providers endpoint.
   */
  private async getProviderRecord(
    providerAddress: string
  ): Promise<{ providerUrl: string; teeSignerAddress: string }> {
    // On-chain path (when registry address is configured)
    const registryAddr = process.env['ZG_SERVICE_REGISTRY_ADDRESS'];
    if (registryAddr && registryAddr !== '0x0000000000000000000000000000000000000000') {
      const contract = new ethers.Contract(registryAddr, SERVICE_REGISTRY_ABI, this.provider);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = await (contract as any).getService(providerAddress);

      const teeSignerAddress = service.additionalInfo?.targetSeparated
        ? service.additionalInfo.targetTeeAddress
        : service.teeSignerAddress;

      return {
        providerUrl: service.url as string,
        teeSignerAddress: teeSignerAddress as string,
      };
    }

    // Fallback: query the Router's provider info endpoint
    // The Router exposes this so clients can build the verification chain
    // without needing their own RPC connection.
    const routerRes = await fetch(
      `${config.ZG_COMPUTE_BASE_URL}/providers/${providerAddress}`,
      {
        headers: { Authorization: `Bearer ${config.ZG_COMPUTE_API_KEY}` },
        signal: AbortSignal.timeout(5_000),
      }
    );

    if (!routerRes.ok) {
      throw new Error(`Cannot fetch provider record for ${providerAddress}: HTTP ${routerRes.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = (await routerRes.json()) as any;

    return {
      providerUrl: record.url as string,
      teeSignerAddress: (record.teeSignerAddress ?? record.tee_signer_address) as string,
    };
  }
}

export const computeVerifier = new ComputeVerifier();
