/**
 * Boot hook. Starts the Bazaar health scan on the server only — never during
 * `next build`, which does not run this, and never on the edge runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.RIPAR_HEALTH_SCAN === "off") return;
  const { scheduleScans } = await import("./lib/health");
  scheduleScans();
}
