import { paidRoute } from "@/lib/paid";
import { payeeCheck } from "@/lib/trust";

export const dynamic = "force-dynamic";

export const POST = paidRoute<{ address?: unknown; network?: unknown }>({
  path: "/api/payee-check",
  price: "$0.01",
  description:
    "Before an agent pays an Algorand address: does it exist, can it receive USDC, how much has it really been paid over x402, is it Bazaar-listed, is it registered. Facts from chain, no invented score.",
  listing: {
    input: { address: "3QAJXJVG2Z4IPEKC53SYVHL7P5ILE3CT2T3BW6VPJ5WCOY7M7QDJHELWNY" },
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The Algorand address you are about to pay." },
        network: { type: "string", enum: ["mainnet", "testnet"], description: "Defaults to mainnet." },
      },
      required: ["address"],
    },
    output: { address: "3QAJXJ…", exists: true, canReceiveUsdc: true, received: { transfers: 3, x402: 2 }, facts: ["Account exists."] },
  },
  work: payeeCheck,
});

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
