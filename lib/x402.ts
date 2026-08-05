import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";

/**
 * The payment side of this agent, in one place.
 *
 * NETWORK is resolved from the facilitator rather than from a constant: CAIP-2
 * caps a network reference at 32 characters, so @x402/avm exports a truncated
 * genesis hash while the facilitator advertises the full one. Registering a
 * route with the constant fails at boot with "Facilitator does not support
 * scheme exact on network …", which reads like an outage rather than a string
 * mismatch. See ripar-sdk/src/network.ts for the same fix.
 */
export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";

/** Settlement lands here directly — this app never holds a balance. */
export const PAY_TO = process.env.PAY_TO ?? "";

/** Which chain this deployment settles on. TestNet while the endpoint is
 *  being proven; flip the env var to promote it, no code change. */
export type Network = "mainnet" | "testnet";
export const NETWORK: Network = process.env.RIPAR_NETWORK === "testnet" ? "testnet" : "mainnet";

// CAIP-2 truncates the genesis hash to 32 characters, so these are prefixes of
// what a facilitator publishes — matched both ways below.
const PREFIX: Record<Network, string> = {
  mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
  testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
};

/** USDC is a different asset on each network. Quoting the wrong id produces a
 *  payment nobody can make. */
export const USDC_ASSET: Record<Network, number> = {
  mainnet: 31_566_704,
  testnet: 10_458_941,
};

/**
 * The asset the on-chain registries settle in, where there is one.
 *
 * ReputationRegistry pins its settlement asset at bootstrap and never lets it
 * change — `accept_feedback` asserts `payment.xfer_asset.id == self.usdc_asset`
 * — so a payment in any other asset settles perfectly over HTTP and then cannot
 * credit reputation. The two halves work and do not compose.
 *
 * On TestNet that asset is Ripar Test USDC, because real TestNet USDC is
 * faucet-gated and an agent that cannot obtain it cannot be paid at all. So the
 * endpoint quotes BOTH: real USDC first for anyone who has it, and this second
 * for a caller who wants the payment to reach their score. x402 `accepts` is an
 * array precisely so a resource can offer more than one way to pay.
 *
 * Null on mainnet: nothing is deployed there, and inventing an id would quote a
 * payment nobody can make.
 */
export const REGISTRY_ASSET: Record<Network, { id: number; decimals: number; symbol: string } | null> = {
  mainnet: null,
  testnet: { id: 768_547_363, decimals: 6, symbol: "rUSDC" },
};

type Caip2 = `${string}:${string}`;

let cached: Caip2 | null = null;

export async function resolveNetwork(): Promise<Caip2> {
  if (cached) return cached;
  const res = await fetch(`${FACILITATOR_URL}/supported`, { cache: "no-store" });
  if (!res.ok) throw new Error(`facilitator ${res.status}`);
  const body = (await res.json()) as { kinds?: { scheme?: string; network?: string }[] };
  const match = (body.kinds ?? []).find(
    (k) =>
      k.scheme === "exact" &&
      typeof k.network === "string" &&
      (k.network.startsWith(PREFIX[NETWORK]) || PREFIX[NETWORK].startsWith(k.network))
  );
  if (!match?.network) {
    throw new Error(`facilitator does not support Algorand ${NETWORK}`);
  }
  cached = match.network as Caip2;
  return cached;
}

export const x402Server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL })
).register("algorand:*", new ExactAvmScheme());
