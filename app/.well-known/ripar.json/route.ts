import { publicOrigin } from "@/lib/origin";
import { NextResponse } from "next/server";
import { FACILITATOR_URL, PAY_TO, resolveNetwork, NETWORK, USDC_ASSET } from "@/lib/x402";

// Free, and deliberately so — discovery has to work before payment can.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = publicOrigin(request);
  let network: string | null = null;
  try {
    network = await resolveNetwork();
  } catch {
    /* the manifest is still useful without it */
  }

  return NextResponse.json({
    name: "Ripar",
    handle: "ripar",
    description: `Trust and verification for x402 on Algorand ${NETWORK === "testnet" ? "TestNet" : "MainNet"}: check an endpoint before you list it, a payee before you pay it, a settlement after it lands.`,
    version: "0.1.0",
    skills: ["x402", "verification", "trust", "text"],
    network: NETWORK,
    payTo: PAY_TO,
    endpoints: [
      {
        name: "x402-check",
        description:
          "Check an x402 endpoint before you list it: valid 402, USDC, payTo opted in, public resource URL, Bazaar-listable, challenge-ready.",
        url: `${origin}/api/x402-check`,
        method: "POST",
        price: "$0.02",
        input: {
          type: "object",
          properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST"] }, body: { type: "object" } },
          required: ["url"],
        },
        tags: ["x402", "verification", "x402-global-challenge", "hackathon"],
      },
      {
        name: "payee-check",
        description:
          "Before paying an Algorand address: does it exist, can it receive USDC, what has it really been paid over x402, is it listed, is it registered.",
        url: `${origin}/api/payee-check`,
        method: "POST",
        price: "$0.01",
        input: {
          type: "object",
          properties: { address: { type: "string", minLength: 58, maxLength: 58 }, network: { type: "string", enum: ["testnet", "mainnet"] } },
          required: ["address"],
        },
        tags: ["algorand", "trust", "x402-global-challenge", "hackathon"],
      },
      {
        name: "summarize",
        description: "Summarise any text payload into whole sentences.",
        url: `${origin}/api/summarize`,
        method: "POST",
        price: "$0.01",
        input: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1 },
            max: { type: "number", minimum: 40, maximum: 2000 },
          },
          required: ["text"],
        },
        tags: ["text", "summarisation", "x402-global-challenge", "hackathon"],
      },
      {
        name: "verify-settlement",
        description:
          "Verify an Algorand transaction is a real x402 settlement and decode what it moved.",
        url: `${origin}/api/verify-settlement`,
        method: "POST",
        price: "$0.02",
        input: {
          type: "object",
          properties: {
            txid: { type: "string", minLength: 52, maxLength: 52 },
            network: { type: "string", enum: ["testnet", "mainnet"] },
          },
          required: ["txid"],
        },
        tags: ["algorand", "x402", "verification", "x402-global-challenge", "hackathon"],
      },
    ],
    x402: {
      facilitator: FACILITATOR_URL,
      network,
      asset: { id: USDC_ASSET[NETWORK], symbol: "USDC", decimals: 6 },
    },
  });
}

/**
 * A preflight must never reach the payment gate.
 *
 * The browser is asking permission to make a request it has not made yet, so
 * quoting it a price would be answering a question nobody asked — and the
 * headers come from next.config.ts either way. 204 and stop.
 */
export function OPTIONS() {
  return new Response(null, { status: 204 });
}
