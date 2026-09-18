/**
 * The origin this agent is reachable at from the outside.
 *
 * `new URL(request.url).origin` is the address the SERVER sees, which is only
 * the public one when the platform rewrites it. Vercel does; Railway does not —
 * behind its proxy Next.js reports its own listener, so after the move every
 * absolute URL this agent published became `https://localhost:8080/...`: the
 * endpoints in /.well-known/ripar.json, the A2A url in the agent card, and the
 * `resource` in every 402.
 *
 * That last one is what the GoPlausible facilitator catalogues. A real MainNet
 * payment settled, and the Bazaar had nothing reachable to list.
 *
 * So the order is: an explicit PUBLIC_ORIGIN, then the forwarded headers the
 * proxy does set, and the request URL only when it is not a local address.
 */
const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

export function publicOrigin(request: Request): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = request.headers;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  if (host && !LOCAL.test(host)) {
    const proto = (h.get("x-forwarded-proto") ?? "https").split(",")[0].trim();
    return `${proto}://${host}`;
  }
  return new URL(request.url).origin;
}
