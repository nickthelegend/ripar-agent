import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * The card GoPlausible shows on the merchant page, and every link preview.
 *
 * Rendered from code rather than kept as a PNG. The PNG it replaces still said
 * "Ship production AI agents that run your business" long after this agent
 * became an x402 trust service — directly under a description that said
 * something else. An image that is a file drifts from the copy; one generated
 * from the same words cannot.
 */
export const alt = "Ripar — trust and verification for x402 on Algorand";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ROWS: [string, string, string][] = [
  ["x402-check", "Is this endpoint listable before you ship it?", "$0.02"],
  ["payee-check", "Can this address be trusted before you pay it?", "$0.01"],
  ["verify-settlement", "Did this x402 payment really settle?", "$0.02"],
];

export default async function Image() {
  const svg = await readFile(join(process.cwd(), "app", "icon.svg"));
  const logo = `data:image/svg+xml;base64,${svg.toString("base64")}`;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0b0908", padding: "64px 72px", color: "#f5efe9", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <img src={logo} width={72} height={72} alt="" />
          <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: -2 }}>Ripar</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 36, fontSize: 46, fontWeight: 700, lineHeight: 1.15, letterSpacing: -1 }}>
          <span>Trust and verification</span>
          <span style={{ color: "#ff6a2a" }}>for x402 on Algorand.</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 40, gap: 14 }}>
          {ROWS.map(([name, what, price]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", fontSize: 26 }}>
              <span style={{ width: 290, color: "#ffb37d", fontFamily: "monospace" }}>{name}</span>
              <span style={{ flex: 1, color: "#cfc6be" }}>{what}</span>
              <span style={{ color: "#f5efe9", fontFamily: "monospace" }}>{price}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: "auto", fontSize: 22, color: "#8c827a", fontFamily: "monospace" }}>
          api.ripar.io · Algorand MainNet · USDC · GoPlausible facilitator
        </div>
      </div>
    ),
    size
  );
}
