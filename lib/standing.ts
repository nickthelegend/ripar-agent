import { PAY_TO } from "./x402";

/**
 * Where this agent stands on the GoPlausible leaderboard, read live.
 *
 * Nothing here is stored or typed in. The number is fetched from the
 * facilitator's own data endpoint on request (cached for a minute), so it can
 * never drift from what the dashboard shows, and a failure says "unknown"
 * rather than repeating the last good answer as if it were current.
 *
 * Two rankings, because they answer different questions and the dashboard
 * mixes them: `overall` includes every merchant the facilitator has ever seen,
 * on any network — Ripar's own TestNet history sits in there as a separate,
 * untagged entry. `challenge` is only entries tagged x402-global-challenge,
 * which is the field the Global x402 Challenge is judged on.
 */
const DATA = "https://facilitator.goplausible.xyz/data/leaderboards";
const PAGE = 50; // the endpoint caps pages here regardless of `limit`

export type Row = {
  rank: number; label: string; sub: string; address: string;
  volume: number; settles: number; challenge: boolean; bazaar: boolean;
};

async function all(range: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < 5000; offset += PAGE) {
    const res = await fetch(`${DATA}?cat=merchants&range=${range}&limit=${PAGE}&offset=${offset}`, {
      headers: { accept: "application/json", "user-agent": "ripar-agent/standing" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`leaderboard ${res.status}`);
    const page = (await res.json()) as { items?: Row[] };
    const items = page.items ?? [];
    rows.push(...items);
    if (items.length < PAGE) break;
  }
  return rows;
}

let cached: { at: number; body: unknown } | null = null;

export async function standing(range = "all") {
  if (cached && Date.now() - cached.at < 60_000) return cached.body;
  const rows = await all(range);
  const mine = (r: Row) => r.address === PAY_TO;
  const challenge = rows.filter((r) => r.challenge);
  const entry = rows.find((r) => mine(r) && r.challenge) ?? rows.find(mine) ?? null;
  const body = {
    source: DATA,
    range,
    fetchedAt: new Date().toISOString(),
    payTo: PAY_TO,
    listed: entry != null,
    challenge: entry && entry.challenge
      ? { rank: challenge.indexOf(entry) + 1, of: challenge.length, volumeUsd: entry.volume, settles: entry.settles }
      : null,
    overall: entry ? { rank: entry.rank, of: rows.length } : null,
    leader: challenge[0] ? { name: challenge[0].sub, volumeUsd: challenge[0].volume, settles: challenge[0].settles } : null,
  };
  cached = { at: Date.now(), body };
  return body;
}
