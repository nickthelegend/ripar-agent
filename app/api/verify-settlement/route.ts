import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { paymentOptions, resolveNetwork, x402Server } from "@/lib/x402";
import { SkillInputError, verifySettlement } from "@/lib/skills";

export const dynamic = "force-dynamic";

/** The work. No payment code here — withX402 gates it. */
async function handler(request: NextRequest): Promise<NextResponse> {
  let body: { txid?: unknown; network?: unknown };
  try {
    body = await request.json();
  } catch {
    // 4xx, so the caller is not charged for a malformed request.
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Body must be JSON." } },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await verifySettlement(body));
  } catch (err) {
    if (err instanceof SkillInputError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: 400 });
    }
    // An indexer outage is a 502, not a 500 and not a verdict: the caller
    // should retry, and must not read it as "that payment did not happen".
    return NextResponse.json(
      { error: { code: "upstream_unavailable", message: "Could not reach the Algorand indexer." } },
      { status: 502 }
    );
  }
}

const wrapped = (async (request: NextRequest) => {
  const network = await resolveNetwork();

  // $0.02 — twice `summarize`, because this one does real network work against
  // the indexer rather than pure string handling, and a wrong answer here is
  // costlier to the caller than a bad summary.
  const accepts = paymentOptions(network, "$0.02");

  const gated = withX402(
    handler,
    {
      accepts,
      description:
        "Verify an Algorand transaction is a real x402 settlement and decode what it moved.",
    },
    x402Server
  );
  return gated(request);
}) satisfies (r: NextRequest) => Promise<Response>;

export const POST = wrapped;

/** A preflight must never reach the payment gate. */
export function OPTIONS() {
  return new Response(null, { status: 204 });
}
