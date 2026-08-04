import type { NextConfig } from "next";

/**
 * CORS, so a browser can actually read the payment handshake.
 *
 * This agent is public by design — discovery has to work before payment can —
 * but a browser could not use it. Without these headers, `fetch` from a page
 * gets a network error on the manifest and, worse, a 402 whose quote it cannot
 * see: `PAYMENT-REQUIRED` is not one of the handful of response headers a page
 * may read by default, so the request "works" and the price silently vanishes.
 *
 * app.ripar.io hit exactly this in production — its Endpoints view was
 * permanently empty for real visitors while working perfectly on localhost,
 * where same-origin hides the problem. It had to proxy through its own server
 * to get the manifest at all.
 *
 * `Access-Control-Expose-Headers` is the line that matters. Allowing the origin
 * without it produces a response the page can see the status of and nothing
 * else, which is the failure that looks like success.
 */

/** What a caller must be able to SEND for the handshake to complete. */
const ALLOW = [
  "content-type",
  // The x402 v2 name. X-PAYMENT is the v1 spelling; @x402/next still accepts
  // it, so a preflight that refused it would break older clients.
  "payment-signature",
  "x-payment",
  "idempotency-key",
  "x-ripar-subscription",
].join(", ");

/** What a caller must be able to READ, or the handshake is invisible to it. */
const EXPOSE = [
  "payment-required",
  "payment-response",
  "x-payment-required",
  "x-payment-response",
  "x-ripar-subscription",
  "x-ripar-subscription-expires",
  "x-ripar-subscription-status",
  "retry-after",
].join(", ");

const cors = [
  // `*` rather than a list. The endpoints are public, the payment gate is what
  // protects them, and an allowlist here would quietly break every third-party
  // dashboard that wants to read a price — which is the whole point of a
  // discovery manifest.
  { key: "Access-Control-Allow-Origin", value: "*" },
  { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
  { key: "Access-Control-Allow-Headers", value: ALLOW },
  { key: "Access-Control-Expose-Headers", value: EXPOSE },
  { key: "Access-Control-Max-Age", value: "86400" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/.well-known/:path*", headers: cors },
      { source: "/api/:path*", headers: cors },
      { source: "/a2a", headers: cors },
    ];
  },
};

export default nextConfig;
