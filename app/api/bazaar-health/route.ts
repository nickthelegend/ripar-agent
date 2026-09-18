import { NextResponse, type NextRequest } from "next/server";
import { board, startScan, summarize } from "@/lib/health";

// Free: the diagnosis is the advertisement. The paid part is /api/x402-check,
// which re-runs the same checks on demand instead of waiting for the next scan.
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const { scan, running } = board();
  if (!scan) {
    void startScan();
    return NextResponse.json({ status: "scanning", message: "The first scan since boot is running; try again in a few minutes." }, { status: 503, headers: { "retry-after": "120" } });
  }
  const net = q.get("network");
  const network = net === "testnet" || net === "all" ? net : "mainnet";

  const url = q.get("url");
  if (url) {
    const hit = scan.listings.find((l) => l.url === url);
    return hit
      ? NextResponse.json({ checkedAt: scan.finishedAt ?? scan.startedAt, listing: hit })
      : NextResponse.json({ error: { code: "not_listed", message: "That URL is not in the Bazaar catalog as of the last scan." } }, { status: 404 });
  }

  const s = summarize(scan, network);
  const host = q.get("host");
  return NextResponse.json(
    {
      ...s,
      complete: !!scan.finishedAt,
      rescanning: running ? { done: running.done, total: running.total } : null,
      hosts: host ? s.hosts.filter((h) => h.host === host) : s.hosts,
      recheck: { url: "/api/x402-check", price: "$0.02", body: { url: "<your endpoint>" } },
    },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}
