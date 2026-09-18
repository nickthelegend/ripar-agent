import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { publicOrigin } from "@/lib/origin";
import { listing, paymentOptions, resolveNetwork, x402Server } from "@/lib/x402";
import { SkillInputError, summarize } from "@/lib/skills";
import { readKey, recall, remember } from "@/lib/idempotency";

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
  // BEFORE the payment gate, deliberately. The SDK sends Idempotency-Key on
  // every paid call so a retry after a dropped connection replays the answer
  // instead of paying again — and this agent used to ignore it, so the same
  // key charged twice. Once withX402 settles a transfer the money has moved;
  // the only place this check helps is in front of it.
  const key = readKey(request);
  const raw = key ? await request.clone().text() : "";
  if (key) {
    const replay = recall(key, raw);
    if (replay) return replay;
  }

  const network = await resolveNetwork();

  const accepts = paymentOptions(network);

  const gated = withX402(
    handler,
    {
      accepts,
      // Named, not inferred: behind a proxy the inferred one is localhost.
      resource: `${publicOrigin(request)}/api/summarize`,
      description: "Summarise any text payload into whole sentences.",
      mimeType: "application/json",
      ...listing({
        input: { text: "Algorand finalises blocks in under three seconds. It has no forks. Fees are a fraction of a cent." },
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text to summarise." },
            max: { type: "integer", description: "Maximum sentences to keep." },
          },
          required: ["text"],
        },
        output: { summary: "Algorand finalises blocks in under three seconds.", chars: 94, summaryChars: 49, sentences: 3, compression: 0.52 },
      }),
    },
    x402Server
  );
  const res = await gated(request);

  if (key) {
    // Read through a clone: the caller still needs the original body.
    const copy = res.clone();
    remember(key, raw, copy.status, await copy.text(), copy.headers.get("content-type") ?? "application/json");
  }
  return res;
}) satisfies (r: NextRequest) => Promise<Response>;

export const POST = wrapped;

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
