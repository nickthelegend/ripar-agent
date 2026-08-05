import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { NETWORK, PAY_TO, REGISTRY_ASSET, resolveNetwork, x402Server } from "@/lib/x402";
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

/** One cent, in the base units of a six-decimal asset. */
const PRICE_MICRO = "10000";

/** Resolve the network once per cold start, then wrap. */
const wrapped = (async (request: NextRequest) => {
  const network = await resolveNetwork();

  // Two ways to pay the same price, because they are not interchangeable.
  //
  // USDC is what a stranger has and what the challenge is denominated in, so it
  // goes first — a client that takes accepts[0] gets the obvious one.
  //
  // The second exists because settling is not the whole transaction. The
  // ReputationRegistry pins its settlement asset at bootstrap and asserts it on
  // every credit, so a payment in anything else lands in the payee's account
  // and can never reach their score. Quoting only USDC would mean the payment
  // rail and the reputation rail could not compose — which was true here until
  // this route offered both.
  const registryAsset = REGISTRY_ASSET[NETWORK];
  const accepts = [
    { scheme: "exact" as const, network, payTo: PAY_TO, price: "$0.01" },
    ...(registryAsset
      ? [
          {
            scheme: "exact" as const,
            network,
            payTo: PAY_TO,
            price: {
              asset: String(registryAsset.id),
              amount: PRICE_MICRO,
              // `usd: false` is not decoration. Without it a client converts
              // these base units as though they were USDC and misreports the
              // price of any asset whose decimals differ.
              extra: { decimals: registryAsset.decimals, usd: false, symbol: registryAsset.symbol },
            },
          },
        ]
      : []),
  ];

  const gated = withX402(
    handler,
    {
      accepts,
      description: "Summarise any text payload into whole sentences.",
    },
    x402Server
  );
  return gated(request);
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
