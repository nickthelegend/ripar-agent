import { SkillInputError } from "./skills";
import { bazaarCatalog, networkOf, x402Check } from "./trust";
import type { Network } from "./x402";

/**
 * The Bazaar health board: every x402 resource GoPlausible lists, probed.
 *
 * Each listing gets exactly what a paid x402-check would give it — the same
 * function, the same twelve checks — so the free board and the $0.02 re-check
 * a merchant buys after fixing something can never disagree. The board is the
 * diagnosis; the paid call is how a merchant proves the fix without waiting
 * for the next scan.
 *
 * Probes are unpaid requests that read the 402 and nothing else, identified by
 * the ripar-trust user agent, at most two at a time per host.
 *
 * State lives in memory. A redeploy starts a fresh scan; the page says so
 * rather than showing nothing.
 */

export type Status = "ok" | "not_challenge_ready" | "broken" | "unchecked";

export type ListingHealth = {
  url: string;
  host: string;
  method: string;
  network: Network | null;
  payTo: string | null;
  priceUsd: number | null;
  settleCount: number;
  lastSeen: string | null;
  status: Status;
  /** Ids of the checks that failed, in the order x402-check ran them. */
  failing: string[];
  /** What to change, straight from x402-check's own fix list. */
  fix: string[];
  passed: number;
  of: number;
};

export type Scan = {
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  listings: ListingHealth[];
};

const SCAN_EVERY_MS = 6 * 60 * 60_000;
const PER_HOST = 2;
export const NOT_JUDGED = new Set(["rate_limited", "rejected_sample", "private_host"]);
const HOSTS_AT_ONCE = 24;

/**
 * On globalThis, not in module variables. Next bundles instrumentation, each
 * page and each route handler separately, so a module-level `let` exists once
 * per bundle: the page, the JSON route and the boot hook each saw no scan and
 * each started their own — three sets of probes against every merchant.
 */
type State = { current: Scan | null; last: Scan | null; running: Promise<void> | null; scheduled: boolean };
const g = globalThis as typeof globalThis & { __riparHealth?: State };
const state: State = (g.__riparHealth ??= { current: null, last: null, running: null, scheduled: false });

/** The newest complete scan, or the one in progress if none has finished. */
export function board(): { scan: Scan | null; running: Scan | null } {
  return { scan: state.last ?? state.current, running: state.running ? state.current : null };
}

export function startScan(): Promise<void> {
  if (!state.running) {
    state.running = scan()
      .catch((e) => console.error("[health] scan failed:", (e as Error).message))
      .finally(() => {
        state.running = null;
      });
  }
  return state.running;
}

/** Called once at boot from instrumentation.ts. */
export function scheduleScans(): void {
  if (state.scheduled) return;
  state.scheduled = true;
  setTimeout(() => void startScan(), 15_000);
  setInterval(() => void startScan(), SCAN_EVERY_MS).unref?.();
}

async function scan(): Promise<void> {
  const all = await bazaarCatalog();
  if (!all) throw new Error("Bazaar catalog unreachable");
  // GoPlausible lists other chains too. This board is about Algorand.
  const items = all.filter((it) => Array.isArray(it.accepts) && it.accepts.some((a: any) => typeof a?.network === "string" && networkOf(a.network)));

  const next: Scan = { startedAt: new Date().toISOString(), finishedAt: null, total: items.length, done: 0, listings: [] };
  state.current = next;

  const byHost = new Map<string, Record<string, any>[]>();
  for (const it of items) {
    const host = hostOf(it.resourceUrl);
    byHost.set(host, [...(byHost.get(host) ?? []), it]);
  }

  const optIn = new Map<string, Promise<boolean | null>>();
  await pool([...byHost.values()], HOSTS_AT_ONCE, (hostItems) =>
    pool(hostItems, PER_HOST, async (it) => {
      next.listings.push(await probe(it, optIn));
      next.done++;
    })
  );

  next.finishedAt = new Date().toISOString();
  state.last = next;
  console.log(`[health] scanned ${next.total} listings in ${Math.round((Date.parse(next.finishedAt) - Date.parse(next.startedAt)) / 1000)}s`);
}

async function probe(it: Record<string, any>, optIn: Map<string, Promise<boolean | null>>): Promise<ListingHealth> {
  const accept = (Array.isArray(it.accepts) ? it.accepts : []).find((a: any) => typeof a?.network === "string" && networkOf(a.network));
  const base = {
    url: String(it.resourceUrl ?? ""),
    host: hostOf(it.resourceUrl),
    method: String(it.method ?? "POST").toUpperCase(),
    network: accept ? networkOf(accept.network) : null,
    payTo: accept?.payTo ?? null,
    priceUsd: accept?.amount != null ? Number(accept.amount) / 1e6 : null,
    settleCount: Number(it.settleCount ?? 0),
    lastSeen: it.lastSeen ?? null,
  };
  const input = { url: base.url, method: base.method === "GET" ? "GET" : "POST", body: it.discoveryInfo?.input?.body };

  const is = (r: Awaited<ReturnType<typeof x402Check>>, id: string, re: RegExp) => r.checks.some((c) => c.id === id && re.test(c.detail));
  try {
    let r = await x402Check(input, { optIn });
    // Free-tier hosts (Render, mostly) sleep and take 30s+ to wake. A cold
    // start is not an outage; give it one patient retry.
    if (is(r, "reachable", /timeout|aborted/i)) r = await x402Check(input, { optIn, timeoutMs: 45_000 });
    // A 429 is our own probing, not the merchant's fault. Back off once; if it
    // is still limited, say we could not check rather than call it broken.
    if (r.checks.some((c) => c.id === "status_402" && /returned 429/.test(c.detail))) {
      await new Promise((ok) => setTimeout(ok, 5_000));
      r = await x402Check(input, { optIn });
      if (r.checks.some((c) => c.id === "status_402" && /returned 429/.test(c.detail))) {
        return { ...base, status: "unchecked", failing: ["rate_limited"], fix: ["Rate-limited our probe; not judged."], passed: r.passed, of: r.of };
      }
    }
    // 400/422 before any quote means it validated our sample input first. The
    // listing may be fine with real input; do not call it broken.
    if (is(r, "status_402", /returned (400|422),/)) {
      return { ...base, status: "unchecked", failing: ["rejected_sample"], fix: ["Rejected our sample input before quoting a price; not judged."], passed: r.passed, of: r.of };
    }
    const failing = r.checks.filter((c) => c.blocks !== "nothing" && c.ok !== true);
    return {
      ...base,
      status: r.listable ? (r.challengeReady ? "ok" : "not_challenge_ready") : "broken",
      failing: failing.map((c) => c.id),
      fix: r.fix,
      passed: r.passed,
      of: r.of,
    };
  } catch (e) {
    // x402Check refuses before probing: plain http, a private host, a host that
    // does not resolve. The first and last are real defects in the listing; a
    // private host is one we will not touch, so it stays unjudged.
    const code = e instanceof SkillInputError ? e.code : "error";
    const status: Status = code === "not_https" || code === "unresolvable_host" || code === "malformed_url" ? "broken" : "unchecked";
    const fix =
      code === "not_https" ? "The listed URL is plain http. Buyers' payment headers travel unencrypted; serve and list it over https."
      : code === "unresolvable_host" ? `${base.host} does not resolve: the listing points at a domain that no longer exists.`
      : (e as Error).message;
    return { ...base, status, failing: [code], fix: [fix], passed: 0, of: 0 };
  }
}

function hostOf(u: unknown): string {
  try {
    return new URL(String(u)).hostname;
  } catch {
    return "(invalid url)";
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

// ── labels shared by the page and the JSON ───────────────────────────────────

export const CHECK_LABEL: Record<string, string> = {
  reachable: "Endpoint does not answer",
  status_402: "Unpaid call does not return 402 (often: 404, gone)",
  payment_required_header: "Quote not in the PAYMENT-REQUIRED header",
  algorand_exact: "No Algorand 'exact' payment option",
  mainnet: "TestNet only (challenge counts MainNet)",
  usdc: "Asset is not USDC",
  payto_valid: "payTo is not a valid address",
  payto_opted_in: "payTo cannot receive USDC — every payment fails",
  resource_public: "resource.url does not match the public URL",
  bazaar_extension: "Missing or invalid bazaar extension",
  challenge_tag: "Not tagged x402-global-challenge",
  not_https: "Listed over plain http",
  unresolvable_host: "Domain does not resolve",
  malformed_url: "Listed URL is malformed",
  private_host: "Private address (not probed)",
  rate_limited: "Rate-limited our probe (not judged)",
  rejected_sample: "Rejected sample input before quoting (not judged)",
};

// ── the shape the page and the JSON both render ──────────────────────────────

export type HostGroup = { status: Status; failing: string[]; label: string; fix: string; count: number; examples: { url: string; method: string; settleCount: number }[] };
export type HostSummary = {
  host: string;
  listings: number;
  byStatus: Record<Status, number>;
  settles: number;
  payTo: string[];
  groups: HostGroup[];
};

const RANK: Record<Status, number> = { broken: 0, not_challenge_ready: 1, unchecked: 2, ok: 3 };

export function summarize(scan: Scan, network: Network | "all") {
  const L = scan.listings.filter((l) => network === "all" || l.network === network);
  const zero = (): Record<Status, number> => ({ ok: 0, not_challenge_ready: 0, broken: 0, unchecked: 0 });
  const totals = zero();
  const issues: Record<string, number> = {};
  const hosts = new Map<string, ListingHealth[]>();
  for (const l of L) {
    totals[l.status]++;
    // "Not judged" is not a problem with the listing, so it is not counted as one.
    if ((l.status === "broken" || l.status === "not_challenge_ready") && l.failing[0]) issues[l.failing[0]] = (issues[l.failing[0]] ?? 0) + 1;
    hosts.set(l.host, [...(hosts.get(l.host) ?? []), l]);
  }

  const out: HostSummary[] = [...hosts].map(([host, ls]) => {
    const byStatus = zero();
    const groups = new Map<string, HostGroup>();
    for (const l of ls) {
      byStatus[l.status]++;
      // Group by root cause: a 404 also fails every check after it, and
      // listing those would bury the one thing to fix.
      const key = `${l.status}|${l.failing[0] ?? ""}`;
      const g = groups.get(key) ?? {
        status: l.status,
        failing: l.failing,
        label: l.failing[0] ? CHECK_LABEL[l.failing[0]] ?? l.failing[0] : "All checks pass",
        fix: l.fix[0] ?? "",
        count: 0,
        examples: [],
      };
      g.count++;
      if (g.examples.length < 5) g.examples.push({ url: l.url, method: l.method, settleCount: l.settleCount });
      groups.set(key, g);
    }
    return {
      host,
      listings: ls.length,
      byStatus,
      settles: ls.reduce((n, l) => n + l.settleCount, 0),
      payTo: [...new Set(ls.map((l) => l.payTo).filter((p): p is string => !!p))],
      groups: [...groups.values()].sort((a, b) => RANK[a.status] - RANK[b.status] || b.count - a.count),
    };
  });
  out.sort((a, b) => b.byStatus.broken - a.byStatus.broken || b.byStatus.not_challenge_ready - a.byStatus.not_challenge_ready || b.listings - a.listings);

  return {
    network,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
    listings: L.length,
    merchants: new Set(L.map((l) => l.payTo).filter(Boolean)).size,
    totals,
    issues: Object.entries(issues)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: CHECK_LABEL[id] ?? id, count })),
    hosts: out,
  };
}
