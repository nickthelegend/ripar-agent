import type { Metadata } from "next";
import { board, startScan, summarize, type HostSummary, type Status } from "@/lib/health";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Bazaar Health — Ripar",
  description:
    "Every Algorand x402 endpoint on the GoPlausible Bazaar, probed every six hours: which ones buyers can actually pay, which are broken, and exactly what to fix.",
  alternates: { canonical: "/health" },
};

const STATUS: Record<Status, { label: string; tone: string }> = {
  broken: { label: "Broken", tone: "bad" },
  not_challenge_ready: { label: "Not challenge-ready", tone: "warn" },
  unchecked: { label: "Not judged", tone: "mute" },
  ok: { label: "Healthy", tone: "good" },
};
const ORDER: Status[] = ["broken", "not_challenge_ready", "unchecked", "ok"];

type Search = Promise<{ network?: string; status?: string; q?: string }>;

export default async function Health({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const network = sp.network === "testnet" || sp.network === "all" ? sp.network : "mainnet";
  const status = ORDER.includes(sp.status as Status) ? (sp.status as Status) : null;
  const q = (sp.q ?? "").trim().toLowerCase();

  const { scan, running } = board();
  if (!scan || (!scan.finishedAt && scan.done < scan.total * 0.25)) {
    if (!scan) void startScan();
    return (
      <Shell>
        <h1>Bazaar health</h1>
        <p className="lede">
          The first scan since this server started is running
          {scan ? ` — ${scan.done} of ${scan.total} listings probed` : ""}. It takes about three minutes; reload shortly.
        </p>
      </Shell>
    );
  }

  const s = summarize(scan, network);
  let hosts: HostSummary[] = s.hosts;
  if (q) hosts = hosts.filter((h) => h.host.includes(q) || h.payTo.some((p) => p.toLowerCase() === q));
  if (status) hosts = hosts.filter((h) => h.byStatus[status] > 0);
  const top = Math.max(1, ...s.issues.map((i) => i.count));
  const link = (o: { network?: string; status?: string | null }) => {
    const p = new URLSearchParams();
    const n = o.network ?? network;
    if (n !== "mainnet") p.set("network", n);
    const st = o.status === undefined ? status : o.status;
    if (st) p.set("status", st);
    if (q) p.set("q", q);
    const str = p.toString();
    return `/health${str ? `?${str}` : ""}`;
  };

  return (
    <Shell>
      <h1>Bazaar health</h1>
      <p className="lede">
        Every Algorand x402 endpoint listed on the GoPlausible Bazaar, probed with one unpaid request every six hours.
        Which ones a buyer can actually pay, which are broken, and exactly what to fix. Free to read.
      </p>
      <p className="meta">
        {scan.finishedAt ? <>Last scan {ago(scan.finishedAt)}</> : <>Scan in progress: {scan.done} of {scan.total}</>}
        {running && scan.finishedAt ? <> · rescanning now ({running.done}/{running.total})</> : null} ·{" "}
        {s.listings.toLocaleString()} listings · {s.merchants} merchants
      </p>

      <nav className="tabs" aria-label="Network">
        {(["mainnet", "testnet", "all"] as const).map((n) => (
          <a key={n} href={link({ network: n })} aria-current={n === network ? "page" : undefined}>
            {n === "mainnet" ? "MainNet" : n === "testnet" ? "TestNet" : "All"}
          </a>
        ))}
      </nav>

      <section className="tiles">
        {ORDER.map((k) => (
          <a key={k} href={link({ status: status === k ? null : k })} className={`tile ${STATUS[k].tone}`} aria-current={status === k ? "true" : undefined}>
            <span className="n">{s.totals[k].toLocaleString()}</span>
            <span className="l">{STATUS[k].label}</span>
          </a>
        ))}
      </section>

      {s.issues.length > 0 && (
        <section>
          <h2>What breaks most</h2>
          <ul className="issues">
            {s.issues.map((i) => (
              <li key={i.id}>
                <span className="bar" style={{ width: `${(i.count / top) * 100}%` }} />
                <span className="il">{i.label}</span>
                <span className="ic">{i.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="cta">
        <h2>Fixed it? Prove it now.</h2>
        <p>
          This board refreshes every six hours. To re-check one endpoint immediately, pay <strong>$0.02</strong> for{" "}
          <code>x402-check</code>: the same twelve checks, answered in seconds, settled in USDC on Algorand.
        </p>
        <pre>{`npx -p @ripar/sdk ripar call https://api.ripar.io/api/x402-check \\
  --network mainnet --body '{"url":"https://your.api/endpoint"}'`}</pre>
        <p className="small">
          Paying someone you have not paid before? <code>/api/payee-check</code> ($0.01) tells you whether the address exists, can
          receive USDC, and what it has really been paid. The raw data behind this page is free at{" "}
          <a href="/api/bazaar-health">/api/bazaar-health</a>.
        </p>
      </section>

      <section>
        <div className="listhead">
          <h2>
            By host{status ? ` · ${STATUS[status].label.toLowerCase()}` : ""}{" "}
            <span className="count">{hosts.length}</span>
          </h2>
          <form method="get" action="/health" className="search">
            {network !== "mainnet" && <input type="hidden" name="network" value={network} />}
            {status && <input type="hidden" name="status" value={status} />}
            <input name="q" defaultValue={q} placeholder="Find a host or payTo address" aria-label="Find a host or payTo address" />
          </form>
        </div>
        {hosts.length === 0 && <p className="meta">Nothing matches.</p>}
        <div className="hosts">
          {hosts.map((h) => (
            <details key={h.host} id={h.host} open={hosts.length <= 3}>
              <summary>
                <span className="host">{h.host}</span>
                <span className="chips">
                  {ORDER.filter((k) => h.byStatus[k] > 0).map((k) => (
                    <span key={k} className={`chip ${STATUS[k].tone}`} title={STATUS[k].label}>
                      {h.byStatus[k]} {STATUS[k].label.toLowerCase()}
                    </span>
                  ))}
                </span>
                <span className="settles">{h.settles.toLocaleString()} settles</span>
              </summary>
              <div className="groups">
                {h.groups
                  .filter((g) => !status || g.status === status)
                  .map((g, i) => (
                    <div key={i} className={`group ${STATUS[g.status].tone}`}>
                      <div className="gh">
                        <strong>{g.status === "ok" ? "All checks pass" : g.label}</strong>
                        <span className="count">{g.count}</span>
                      </div>
                      {g.status !== "ok" && g.fix && <p className="fix">{g.fix}</p>}
                      <ul className="ex">
                        {g.examples.map((e, j) => (
                          <li key={`${j}:${e.method}:${e.url}`}>
                            <span className="m">{e.method}</span> <span className="u">{e.url}</span>
                          </li>
                        ))}
                        {g.count > g.examples.length && <li className="more">+{g.count - g.examples.length} more like this</li>}
                      </ul>
                    </div>
                  ))}
                {h.payTo.length > 0 && (
                  <p className="payto">
                    Pays {h.payTo.map((p) => `${p.slice(0, 6)}…${p.slice(-4)}`).join(", ")}
                  </p>
                )}
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="method">
        <h2>How this is checked</h2>
        <p>
          Each listing gets one unpaid request, with the method and sample body from its own Bazaar entry and the user agent{" "}
          <code>ripar-trust/1</code>, at most two at a time per host. Nothing is ever paid or signed. The response is judged by the
          same code as the paid <code>x402-check</code>, so this page and a paid re-check cannot disagree.
        </p>
        <p>
          <strong>Broken</strong> means a standard buyer cannot pay it or would not find it: no 402, no readable quote, not USDC, a
          payTo that cannot receive, plain http, a dead domain. <strong>Not challenge-ready</strong> means it works but will not
          count for the x402 Global Challenge (TestNet, or not tagged). <strong>Not judged</strong> means our probe could not get a
          fair answer, such as a 400 on sample input or a rate limit, so we do not guess. A sleeping free-tier host gets a second,
          45-second try before it is called down.
        </p>
        <p>
          Think a result is wrong? <a href="https://github.com/nickthelegend/ripar-agent/issues">Open an issue</a> and it gets
          fixed in the checker, for everyone.
        </p>
      </section>
    </Shell>
  );
}

function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{CSS}</style>
      <div className="wrap">
        <header className="top">
          <a href="/" className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" width={26} height={26} alt="" />
            Ripar
          </a>
          <nav>
            <a href="/health" aria-current="page">Health</a>
            <a href="/.well-known/ripar.json">Manifest</a>
            <a href="https://docs.ripar.io">Docs</a>
          </nav>
        </header>
        <main>{children}</main>
      </div>
    </>
  );
}

const CSS = `
:root{--bg:#faf8f6;--fg:#1c1714;--mute:#6f655d;--line:#e7e0d9;--card:#fff;--accent:#e2561b;
--good:#1f8a4c;--good-bg:#e6f4ec;--warn:#9a6700;--warn-bg:#fbf1d9;--bad:#c2261d;--bad-bg:#fbe7e5;--mute-bg:#efebe7;
--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0b0908;--fg:#f5efe9;--mute:#9a9089;--line:#2a2420;--card:#141110;--accent:#ff6a2a;
--good:#5fd08e;--good-bg:#12291c;--warn:#f0b64a;--warn-bg:#2d2310;--bad:#ff7a70;--bad-bg:#331613;--mute-bg:#221d1a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
a{color:inherit}
.wrap{max-width:960px;margin:0 auto;padding:0 16px 80px}
.top{display:flex;align-items:center;justify-content:space-between;padding:20px 0;border-bottom:1px solid var(--line);margin-bottom:40px}
.brand{display:flex;gap:10px;align-items:center;font-weight:700;font-size:18px;text-decoration:none}
.top nav{display:flex;gap:18px;font-size:14px}.top nav a{text-decoration:none;color:var(--mute)}.top nav a[aria-current]{color:var(--fg)}
h1{font-size:clamp(30px,5vw,44px);letter-spacing:-.02em;margin:0 0 12px;line-height:1.1}
h2{font-size:18px;margin:0 0 14px;letter-spacing:-.01em}
.lede{font-size:17px;color:var(--mute);max-width:640px;margin:0 0 10px}
.meta{color:var(--mute);font-size:13px;font-family:var(--mono);margin:0 0 24px}
section{margin:36px 0}
.tabs{display:inline-flex;border:1px solid var(--line);border-radius:10px;padding:3px;gap:2px;background:var(--card)}
.tabs a{text-decoration:none;padding:6px 14px;border-radius:7px;font-size:14px;color:var(--mute)}
.tabs a[aria-current]{background:var(--fg);color:var(--bg)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:20px}
@media (max-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{display:flex;flex-direction:column;gap:2px;padding:16px;border-radius:12px;border:1px solid var(--line);background:var(--card);text-decoration:none}
.tile .n{font-size:30px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tile .l{font-size:13px;color:var(--mute)}
.tile[aria-current]{outline:2px solid var(--fg);outline-offset:-2px}
.tile.good .n{color:var(--good)}.tile.bad .n{color:var(--bad)}.tile.warn .n{color:var(--warn)}.tile.mute .n{color:var(--mute)}
.issues{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.issues li{position:relative;display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-radius:8px;overflow:hidden;font-size:14px}
.issues .bar{position:absolute;inset:0 auto 0 0;background:var(--bad-bg);z-index:0}
.issues .il,.issues .ic{position:relative}.issues .ic{font-family:var(--mono);font-variant-numeric:tabular-nums}
.cta{border:1px solid var(--line);background:var(--card);border-radius:14px;padding:22px}
.cta h2{font-size:20px}.cta p{margin:0 0 12px;max-width:680px}
.small{font-size:13px;color:var(--mute)}
pre{background:#0b0908;color:#f5efe9;border-radius:10px;padding:14px 16px;overflow-x:auto;font:13px/1.5 var(--mono);margin:0 0 12px}
@media (prefers-color-scheme:dark){pre{background:#000;border:1px solid var(--line)}}
code{font-family:var(--mono);font-size:.9em}
.listhead{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;margin-bottom:12px}
.listhead h2{margin:0}
.count{font-family:var(--mono);font-size:12px;color:var(--mute);font-weight:400}
.search input{font:inherit;font-size:14px;padding:8px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:min(320px,100%)}
.hosts{display:grid;gap:8px}
details{border:1px solid var(--line);border-radius:12px;background:var(--card);min-width:0;overflow:hidden}
.hosts>*,.groups>*,.group{min-width:0}
summary{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 14px;cursor:pointer;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"›";color:var(--mute);transition:transform .15s;display:inline-block}
details[open] summary::before{transform:rotate(90deg)}
.host{font-weight:600;font-family:var(--mono);font-size:14px;word-break:break-all}
.chips{display:flex;flex-wrap:wrap;gap:6px;flex:1}
.chip{font-size:12px;padding:2px 8px;border-radius:99px;white-space:nowrap}
.chip.good{background:var(--good-bg);color:var(--good)}.chip.bad{background:var(--bad-bg);color:var(--bad)}
.chip.warn{background:var(--warn-bg);color:var(--warn)}.chip.mute{background:var(--mute-bg);color:var(--mute)}
.settles{font-size:12px;color:var(--mute);font-family:var(--mono)}
.groups{padding:0 14px 14px;display:grid;gap:10px}
.group{border-left:3px solid var(--line);padding:4px 0 4px 12px}
.group.bad{border-color:var(--bad)}.group.warn{border-color:var(--warn)}.group.good{border-color:var(--good)}
.gh{display:flex;gap:10px;align-items:baseline;font-size:14px}
.fix{margin:4px 0 6px;color:var(--mute);font-size:13px;max-width:720px}
.ex{list-style:none;margin:0;padding:0;font:12px/1.7 var(--mono);color:var(--mute)}
.ex li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ex .m{display:inline-block;min-width:36px;color:var(--fg)}
.more{font-style:italic}
.payto{font:12px var(--mono);color:var(--mute);margin:0}
.method p{color:var(--mute);max-width:720px;font-size:14px}
`;
