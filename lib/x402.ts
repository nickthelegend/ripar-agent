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
 *  being proven; set RIPAR_NETWORK=mainnet to promote it, no code change.
 *
 *  The comparison is deliberately `=== "mainnet"` rather than `=== "testnet"`.
 *  Written the other way the default was MainNet, so losing the env var — a
 *  preview deploy, a new environment, a project re-link — would silently start
 *  quoting real USDC (31566704) while REGISTRIES in this same repo still names
 *  the TestNet app ids. An unset variable should cost nothing, not real money. */
export type Network = "mainnet" | "testnet";
export const NETWORK: Network = process.env.RIPAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

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
 * Every way this agent will accept a cent, for any gated route.
 *
 * One option, and that is the point. The ReputationRegistry pins its settlement
 * asset at bootstrap and asserts it on every credit — `accept_feedback` checks
 * `payment.xfer_asset.id == self.usdc_asset` — so a payment in any other asset
 * settles perfectly over HTTP and can never reach the payee's score.
 *
 * The registries are bootstrapped to USDC_ASSET, so quoting `$0.01` here names
 * exactly the asset they credit: settling and being credited are the same
 * event. An earlier deployment pinned them to a token minted for the purpose,
 * which forced this route to quote two assets so a caller could choose between
 * being paid-for and being credited. That split is gone.
 *
 * Built here rather than inline per route because /api/summarize and /a2a sell
 * the same skill, and they drifted the moment one learned something the other
 * did not.
 */
export function paymentOptions(network: `${string}:${string}`) {
  return [{ scheme: "exact" as const, network, payTo: PAY_TO, price: "$0.01" }];
}

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
