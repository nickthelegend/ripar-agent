import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { PAY_TO, resolveNetwork, x402Server } from "@/lib/x402";

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

  const text = String(body.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return NextResponse.json(
      { error: { code: "missing_text", message: "`text` is required and must be non-empty." } },
      { status: 400 }
    );
  }

  const max = Math.min(Math.max(Number(body.max) || 280, 40), 2000);
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);

  // Take whole sentences while they fit, so the summary ends cleanly rather
  // than mid-word.
  let summary = "";
  for (const s of sentences) {
    if ((summary + " " + s).trim().length > max) break;
    summary = (summary + " " + s).trim();
  }
  if (!summary) summary = text.length <= max ? text : `${text.slice(0, max - 1)}…`;

  return NextResponse.json({
    summary,
    chars: text.length,
    summaryChars: summary.length,
    sentences: sentences.length,
    compression: Number((summary.length / text.length).toFixed(3)),
  });
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
