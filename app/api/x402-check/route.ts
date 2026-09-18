import { paidRoute } from "@/lib/paid";
import { x402Check } from "@/lib/trust";

export const dynamic = "force-dynamic";

export const POST = paidRoute<{ url?: unknown; method?: unknown; body?: unknown }>({
  path: "/api/x402-check",
  price: "$0.02",
  description:
    "Check an x402 endpoint on Algorand before you list it: valid 402, USDC, payTo opted in, public resource URL (no localhost), Bazaar-listable, challenge-ready.",
  listing: {
    input: { url: "https://api.ripar.io/api/summarize" },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The https x402 endpoint to check." },
        method: { type: "string", enum: ["GET", "POST"], description: "HTTP method the endpoint expects. Default POST." },
        body: { type: "object", description: "Optional JSON body sent with the unpaid probe." },
      },
      required: ["url"],
    },
    output: { url: "https://api.ripar.io/api/summarize", listable: true, challengeReady: true, passed: 12, of: 12, fix: [] },
  },
  work: x402Check,
});

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
