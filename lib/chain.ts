import { createHash } from "node:crypto";
import { NETWORK, type Network } from "./x402";

/** Public AlgoNode endpoints — no key, so no secret to leak or rotate. */
export const ALGOD: Record<Network, string> = {
  mainnet: "https://mainnet-api.algonode.cloud",
  testnet: "https://testnet-api.algonode.cloud",
};
export const INDEXER: Record<Network, string> = {
  mainnet: "https://mainnet-idx.algonode.cloud",
  testnet: "https://testnet-idx.algonode.cloud",
};

/**
 * The registries for the chain this deployment settles on.
 *
 * Keyed by network, not written as literals. The card used to hard-code the
 * TestNet generation 769444119/120/121 — superseded twice over — and kept
 * advertising it after the agent moved to MainNet, so a caller checking this
 * agent's identity was sent to a registry on the wrong chain that no longer
 * described it. Env overrides remain for a redeploy that mints new ids.
 */
const DEFAULTS: Record<Network, { identityApp: number; reputationApp: number; validationApp: number }> = {
  mainnet: { identityApp: 3711339965, reputationApp: 3711339999, validationApp: 3711340075 },
  testnet: { identityApp: 770382913, reputationApp: 770382914, validationApp: 770382915 },
};
const pick = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
export const REGISTRIES = {
  identityApp: pick(process.env.RIPAR_IDENTITY_APP, DEFAULTS[NETWORK].identityApp),
  reputationApp: pick(process.env.RIPAR_REPUTATION_APP, DEFAULTS[NETWORK].reputationApp),
  validationApp: pick(process.env.RIPAR_VALIDATION_APP, DEFAULTS[NETWORK].validationApp),
};

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an Algorand address to its 32-byte public key, or null if it is not
 *  one. The last four bytes are a SHA-512/256 checksum of the key, so a single
 *  transposed character is caught here rather than by the chain. */
export function addressToPublicKey(address: string): Buffer | null {
  if (typeof address !== "string" || !/^[A-Z2-7]{58}$/.test(address)) return null;
  let bits = "";
  for (const c of address) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.alloc(36);
  for (let i = 0; i < 36; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const pk = bytes.subarray(0, 32);
  const sum = createHash("sha512-256").update(pk).digest().subarray(28, 32);
  return sum.equals(bytes.subarray(32, 36)) ? Buffer.from(pk) : null;
}

export const isAlgorandAddress = (a: string) => addressToPublicKey(a) != null;
