import { NextResponse, type NextRequest } from "next/server";

/**
 * Content-negotiate the root.
 *
 * The HTML at `/` exists so a facilitator scraping this domain can read the
 * merchant's name, blurb and logo out of the head. But `/` should still answer
 * an API client in JSON, and a page component cannot do that: whatever it
 * returns gets wrapped in the layout's <html><body>, so a JSON body comes back
 * inside an HTML document — neither valid JSON nor clean HTML.
 *
 * Middleware runs before rendering and can return a real Response, so the
 * negotiation belongs here.
 *
 * The test is `application/json` ranked ahead of `text/html`, not merely
 * present: browsers send Accept headers that list both, and a browser must get
 * the page.
 */
const BODY = {
  name: "Ripar Text Tools",
  description:
    "A real, payable x402 endpoint on Algorand. Ask it to summarise text and it answers 402 with a price in USDC.",
  manifest: "/.well-known/ripar.json",
  agentCard: "/.well-known/agent.json",
  health: "/api/health",
  endpoints: [{ name: "summarize", url: "/api/summarize", price: "$0.01" }],
};

export function middleware(req: NextRequest) {
  const accept = req.headers.get("accept") ?? "";
  const json = accept.indexOf("application/json");
  const html = accept.indexOf("text/html");
  const prefersJson = json !== -1 && (html === -1 || json < html);

  if (prefersJson) {
    return NextResponse.json(BODY, {
      headers: { "cache-control": "public, max-age=60" },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: "/" };
