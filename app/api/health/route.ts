import { NextResponse } from "next/server";
import { PAY_TO, FACILITATOR_URL, resolveNetwork } from "@/lib/x402";

// Deliberately unpaid. A paid health check makes a healthy agent look down the
// moment a platform probes it.
export const dynamic = "force-dynamic";

export async function GET() {
  let network: string | null = null;
  let facilitatorOk = false;
  try {
    network = await resolveNetwork();
    facilitatorOk = true;
  } catch {
    /* reported below rather than thrown — health should still answer */
  }
  return NextResponse.json({
    ok: Boolean(PAY_TO) && facilitatorOk,
    agent: "ripar-text-tools",
    payTo: PAY_TO || null,
    facilitator: FACILITATOR_URL,
    network,
  });
}
