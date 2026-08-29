import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/**
 * The root, content-negotiated.
 *
 * This domain is an API, so `/` used to 404 — which meant a facilitator
 * scraping it for merchant branding got nothing, and the dashboard showed the
 * agent nameless and logo-less no matter how many payments it settled.
 *
 * An API client asking for JSON still gets JSON, so nothing that already works
 * changes. A browser or a crawler gets HTML, and the metadata in layout.tsx
 * rides along in its head. Same URL, two audiences, neither one compromised.
 */
export default async function Root() {
  const accept = (await headers()).get("accept") ?? "";

  // Anything that asked for JSON and did NOT ask for HTML is an API client.
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    const body = {
      name: "Ripar Text Tools",
      description:
        "A real, payable x402 endpoint on Algorand. Ask it to summarise text and it answers 402 with a price in USDC.",
      manifest: "/.well-known/ripar.json",
      agentCard: "/.well-known/agent.json",
      health: "/api/health",
      endpoints: [{ name: "summarize", url: "/api/summarize", price: "$0.01" }],
    };
    return (
      <pre suppressHydrationWarning>{JSON.stringify(body, null, 2)}</pre>
    );
  }

  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        maxWidth: 640,
        margin: "12vh auto",
        padding: "0 24px",
        lineHeight: 1.6,
        color: "#1c1917",
      }}
    >
      <h1 style={{ fontSize: 28, margin: 0 }}>Ripar Text Tools</h1>
      <p style={{ color: "#57534e" }}>
        A real, payable x402 endpoint on Algorand. Ask it to summarise text and
        it answers <strong>402</strong> with a price in USDC — no account, no
        card, no invoice.
      </p>
      <pre
        style={{
          background: "#0c0a09",
          color: "#fafaf9",
          padding: 16,
          borderRadius: 10,
          overflowX: "auto",
          fontSize: 13,
        }}
      >{`curl -i -X POST https://api.ripar.io/api/summarize \\
  -H 'content-type: application/json' \\
  -d '{"text":"a long piece of text you want shortened"}'`}</pre>
      <p style={{ color: "#57534e", fontSize: 14 }}>
        That returns a real 402 carrying a machine-readable price. Attach{" "}
        <code>X-PAYMENT</code> with a signed USDC transfer and the same request
        returns the summary.
      </p>
      <ul style={{ color: "#57534e", fontSize: 14, paddingLeft: 18 }}>
        <li>
          <a href="/.well-known/ripar.json">Manifest</a> — endpoints, prices,
          payout address
        </li>
        <li>
          <a href="/.well-known/agent.json">A2A agent card</a>
        </li>
        <li>
          <a href="/api/health">Health</a>
        </li>
        <li>
          <a href="https://docs.ripar.io">Docs</a> ·{" "}
          <a href="https://explorer.ripar.io">Explorer</a>
        </li>
      </ul>
    </main>
  );
}
