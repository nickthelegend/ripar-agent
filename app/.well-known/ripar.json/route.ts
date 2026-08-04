import { NextResponse } from "next/server";
import { FACILITATOR_URL, PAY_TO, resolveNetwork, NETWORK, USDC_ASSET } from "@/lib/x402";

// Free, and deliberately so — discovery has to work before payment can.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  let network: string | null = null;
  try {
    network = await resolveNetwork();
  } catch {
    /* the manifest is still useful without it */
  }

  return NextResponse.json({
    name: "Ripar Text Tools",
    handle: "ripar-text-tools",
    description: `A real, payable x402 endpoint on Algorand ${NETWORK === "testnet" ? "TestNet" : "MainNet"}.`,
    version: "0.1.0",
    skills: ["text", "summarisation"],
    network: NETWORK,
    payTo: PAY_TO,
    endpoints: [
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
        tags: ["text", "summarisation"],
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
