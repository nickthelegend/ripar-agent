import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { publicOrigin } from "./origin";
import { SkillInputError } from "./skills";
import { listing, paymentOptions, resolveNetwork, x402Server } from "./x402";

/**
 * One paid route, built the same way every time.
 *
 * Written once because the routes that were built by hand drifted: /a2a and
 * /api/summarize sold the same skill and disagreed the moment one of them
 * learned something. Everything a route needs to be paid AND listed lives here:
 * the explicit public resource (behind a proxy the inferred one is localhost),
 * the Bazaar declaration, and the error mapping.
 *
 * A thrown error that is not a SkillInputError becomes a 5xx, and withX402
 * cancels settlement on any status >= 400 — so an upstream outage costs the
 * caller nothing rather than charging them for an answer they did not get.
 */
export function paidRoute<T>(opts: {
  path: string;
  price: string;
  description: string;
  listing: Parameters<typeof listing>[0];
  work: (body: T) => Promise<unknown> | unknown;
}) {
  async function handler(request: NextRequest): Promise<NextResponse> {
    let body: T;
    try {
      body = (await request.json()) as T;
    } catch {
      return NextResponse.json({ error: { code: "invalid_json", message: "Body must be JSON." } }, { status: 400 });
    }
    try {
      return NextResponse.json(await opts.work(body));
    } catch (err) {
      if (err instanceof SkillInputError) {
        return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: 400 });
      }
      return NextResponse.json(
        { error: { code: "upstream_unavailable", message: (err as Error).message, charged: false } },
        { status: 502 }
      );
    }
  }

  return async (request: NextRequest) => {
    const network = await resolveNetwork();
    const gated = withX402(
      handler,
      {
        accepts: paymentOptions(network, opts.price),
        resource: `${publicOrigin(request)}${opts.path}`,
        description: opts.description,
        mimeType: "application/json",
        ...listing(opts.listing),
      },
      x402Server
    );
    return gated(request);
  };
}
