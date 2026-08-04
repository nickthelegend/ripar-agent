import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { PAY_TO, resolveNetwork, x402Server } from "@/lib/x402";
import { SkillInputError, summarize } from "@/lib/skills";

export const dynamic = "force-dynamic";

/** The work. No payment code here — withX402 gates it. */
// Annotated, or TS narrows the union to whichever branch it saw first and
// withX402 then rejects the handler.
async function handler(request: NextRequest): Promise<NextResponse> {
  let body: { text?: string; max?: number };
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
    return NextResponse.json(summarize(body));
  } catch (err) {
    if (err instanceof SkillInputError) {
      // 4xx, so the caller is not charged for a malformed request.
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: 400 });
    }
    throw err;
  }
}

/** Resolve the network once per cold start, then wrap. */
const wrapped = (async (request: NextRequest) => {
  const network = await resolveNetwork();
  const gated = withX402(
    handler,
    {
      accepts: { scheme: "exact", network, payTo: PAY_TO, price: "$0.01" },
      description: "Summarise any text payload into whole sentences.",
    },
    x402Server
  );
  return gated(request);
}) satisfies (r: NextRequest) => Promise<Response>;

export const POST = wrapped;
