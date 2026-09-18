export const dynamic = "force-dynamic";

/**
 * The root, content-negotiated.
 *
 * This domain is an API, so `/` used to 404 — which meant a facilitator
 * scraping it for merchant branding got nothing, and the dashboard showed the
 * agent nameless and logo-less no matter how many payments it settled.
 *
 * A browser or a crawler gets this HTML, and the metadata in layout.tsx rides
 * along in its head. An API client asking for JSON is answered by middleware.ts
 * before this ever renders — a page component cannot return a bare JSON body,
 * because the layout wraps whatever it returns in <html>.
 */
export default function Root() {
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
      <h1 style={{ fontSize: 28, margin: 0 }}>Ripar</h1>
      <p style={{ color: "#57534e" }}>
        Trust and verification for x402 on Algorand. Check an endpoint before you
        list it, check a payee before you pay it, prove a settlement after it
        lands. Every call is paid per request in USDC — no account, no card.
      </p>
      <p style={{ fontSize: 15 }}>
        <a href="/health" style={{ fontWeight: 600 }}>
          Bazaar health →
        </a>{" "}
        <span style={{ color: "#57534e" }}>
          every Algorand x402 listing, probed every six hours. Free.
        </span>
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
      >{`POST /api/x402-check        $0.02  {"url": "https://your.api/endpoint"}
POST /api/payee-check       $0.01  {"address": "<algorand address>"}
POST /api/verify-settlement $0.02  {"txid": "<52-char txid>"}`}</pre>
      <p style={{ color: "#57534e", fontSize: 14 }}>
        An unpaid call answers <strong>402</strong> with a machine-readable
        price. Pay it with any x402 client, e.g.{" "}
        <code>npx -p @ripar/sdk ripar call &lt;url&gt; --body &apos;…&apos;</code>
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
