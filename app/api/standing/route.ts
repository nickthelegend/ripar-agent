import { NextResponse } from "next/server";
import { standing } from "@/lib/standing";

/** Free and unpaid: this is about the agent, not a skill it sells. */
export async function GET() {
  try {
    return NextResponse.json(await standing("all"), { headers: { "cache-control": "public, max-age=60" } });
  } catch (err) {
    // Say it is unknown. Repeating an old rank as current is how a dashboard lies.
    return NextResponse.json(
      { listed: null, error: `leaderboard unavailable: ${(err as Error).message}` },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}
