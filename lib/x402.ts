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

const MAINNET_PREFIX = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k";

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
      (k.network.startsWith(MAINNET_PREFIX) || MAINNET_PREFIX.startsWith(k.network))
  );
  if (!match?.network) throw new Error("facilitator does not support Algorand MainNet");
  cached = match.network as Caip2;
  return cached;
}

export const x402Server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL })
).register("algorand:*", new ExactAvmScheme());
