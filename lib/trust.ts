import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { ALGOD, INDEXER, REGISTRIES, addressToPublicKey } from "./chain";
import { CHALLENGE_TAG, NETWORK, USDC_ASSET, type Network } from "./x402";
import { SkillInputError } from "./skills";

/**
 * Trust checks for x402 on Algorand — the questions a merchant should ask
 * before listing an endpoint, and a buyer before paying one.
 *
 * Every answer here is read from the thing it describes at request time: the
 * endpoint's own 402, the chain, the facilitator's own catalog. Nothing is a
 * score this file made up. Where a fact cannot be read, the result says it is
 * unknown instead of guessing in either direction.
 */

const MAINNET_PREFIX = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k";
const TESTNET_PREFIX = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe";
const CATALOG = "https://facilitator.goplausible.xyz/discovery/resources";
const UA = "ripar-trust/1 (+https://api.ripar.io)";

// ── SSRF guard ───────────────────────────────────────────────────────────────
// x402-check fetches a URL the CALLER chose, from inside Railway's network.
// Without this it is a paid proxy into private address space.
function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

async function assertPublicHost(host: string): Promise<void> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(bare) || bare.endsWith(".internal") || bare.endsWith(".local")) {
    throw new SkillInputError(`${host} is not a public host.`, "private_host");
  }
  const addrs = isIP(bare) ? [{ address: bare }] : await lookup(bare, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new SkillInputError(`${host} does not resolve.`, "unresolvable_host");
  if (addrs.some((a) => isPrivate(a.address))) {
    throw new SkillInputError(`${host} resolves to a private address.`, "private_host");
  }
}

export const networkOf = (caip2: string): Network | null =>
  caip2 === "algorand-mainnet" || caip2 === "algorand" ? "mainnet" : caip2 === "algorand-testnet" ? "testnet" :
  caip2.startsWith(MAINNET_PREFIX) || MAINNET_PREFIX.startsWith(caip2) ? "mainnet"
  : caip2.startsWith(TESTNET_PREFIX) || TESTNET_PREFIX.startsWith(caip2) ? "testnet"
  : null;

async function optedIn(net: Network, address: string, asset: number): Promise<boolean | null> {
  const r = await fetch(`${ALGOD[net]}/v2/accounts/${address}/assets/${asset}`, { cache: "no-store" }).catch(() => null);
  if (!r) return null;
  if (r.status === 404) return false;
  return r.ok ? true : null;
}

// ── x402-check ───────────────────────────────────────────────────────────────

type Check = { id: string; ok: boolean | null; detail: string; blocks: "listing" | "challenge" | "nothing" };

/**
 * `optIn` lets a caller checking many endpoints share opt-in lookups: the
 * health board probes ~2,000 listings paid to ~100 addresses. A single paid
 * check never passes it, so a merchant re-checking right after opting in is
 * never answered from a stale cache.
 */
export async function x402Check(
  body: { url?: unknown; method?: unknown; body?: unknown },
  opts: { optIn?: Map<string, Promise<boolean | null>>; timeoutMs?: number } = {}
) {
  if (typeof body.url !== "string" || !body.url.trim()) {
    throw new SkillInputError("`url` is required: the x402 endpoint to check.", "missing_url");
  }
  let target: URL;
  try {
    target = new URL(body.url.trim());
  } catch {
    throw new SkillInputError("`url` is not a valid URL.", "malformed_url");
  }
  if (target.protocol !== "https:") {
    throw new SkillInputError("Only https:// endpoints can be checked.", "not_https");
  }
  await assertPublicHost(target.hostname);
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
  if (!["GET", "POST"].includes(method)) throw new SkillInputError("`method` must be GET or POST.", "bad_method");

  const checks: Check[] = [];
  const add = (id: string, ok: boolean | null, detail: string, blocks: Check["blocks"]) => checks.push({ id, ok, detail, blocks });

  let res: Response;
  try {
    res = await fetch(target, {
      method,
      redirect: "manual", // a redirect could point anywhere, including inside
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
      body: method === "POST" ? JSON.stringify(body.body ?? {}) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      cache: "no-store",
    });
  } catch (e) {
    add("reachable", false, `No response: ${(e as Error).message}`, "listing");
    return verdict(target.href, checks);
  }
  add("reachable", true, `Answered HTTP ${res.status}.`, "listing");
  add("status_402", res.status === 402, res.status === 402 ? "Unpaid call is refused with 402." : `Unpaid call returned ${res.status}, not 402.`, "listing");

  const header = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  let pr: Record<string, any> | null = null;
  if (header) {
    try {
      pr = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      pr = null;
    }
  }
  if (pr) {
    add("payment_required_header", true, `PAYMENT-REQUIRED decodes, x402Version ${pr.x402Version}.`, "listing");
  } else {
    // No header. x402 v1 put the quote in the body, and clients still accept
    // that. A v2 quote in the body alone is what @x402's client rejects — it
    // reads v2 from the header only — so say precisely that, and keep going on
    // the body so the rest of the diagnosis is still useful.
    const body = res.status === 402 ? ((await res.json().catch(() => null)) as Record<string, any> | null) : null;
    if (body && Array.isArray(body.accepts)) {
      pr = body;
      const v1 = body.x402Version === 1;
      add(
        "payment_required_header",
        v1,
        v1 ? "x402 v1: the quote is in the body, which clients accept."
          : `x402Version ${body.x402Version} quote is only in the body. The standard @x402 client reads v2 quotes from the PAYMENT-REQUIRED header only, so it cannot pay this; only a custom client can. Send the same object base64-encoded in that header too.`,
        "listing"
      );
    } else {
      add("payment_required_header", false, "No decodable PAYMENT-REQUIRED header, and no quote in the body.", "listing");
    }
  }
  if (!pr) return verdict(target.href, checks);

  const accepts: Record<string, any>[] = Array.isArray(pr.accepts) ? pr.accepts : [];
  const algo = accepts.find((a) => a?.scheme === "exact" && typeof a?.network === "string" && networkOf(a.network));
  add("algorand_exact", !!algo, algo ? `Offers exact on ${networkOf(algo.network)}.` : "No 'exact' payment option on Algorand.", "listing");

  if (algo) {
    const net = networkOf(algo.network)!;
    add("mainnet", net === "mainnet", net === "mainnet" ? "Settles on Algorand MainNet." : "Settles on TestNet — the challenge counts MainNet only.", "challenge");
    const asset = Number(algo.asset);
    add("usdc", asset === USDC_ASSET[net], asset === USDC_ASSET[net] ? `Asset ${asset} is USDC on ${net}.` : `Asset ${asset} is not USDC on ${net} (${USDC_ASSET[net]}).`, "listing");

    const payTo = String(algo.payTo ?? "");
    if (!addressToPublicKey(payTo)) {
      add("payto_valid", false, `payTo ${payTo || "(empty)"} is not a valid Algorand address.`, "listing");
    } else {
      const key = `${net}:${payTo}:${asset}`;
      let lookup = opts.optIn?.get(key);
      if (!lookup) {
        lookup = optedIn(net, payTo, asset);
        opts.optIn?.set(key, lookup);
      }
      const inn = await lookup;
      add("payto_opted_in", inn, inn === null ? "Could not read payTo from the chain." : inn ? `payTo is opted into asset ${asset}.` : `payTo is NOT opted into asset ${asset}: every payment to it fails.`, "listing");
    }
    const feePayer = algo.extra?.feePayer;
    add("fees_sponsored", !!feePayer, feePayer ? "A facilitator sponsors network fees; buyers need no ALGO." : "No feePayer: buyers must hold ALGO for fees.", "nothing");
  }

  const resUrl: string | undefined = pr.resource?.url;
  let resOk = false;
  let resDetail = "No resource.url in the 402.";
  if (resUrl) {
    try {
      const u = new URL(resUrl);
      const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u.hostname);
      resOk = u.protocol === "https:" && !local && u.hostname === target.hostname;
      resDetail = local
        ? `resource.url is ${resUrl} — a local address. The facilitator catalogues this URL, so the listing would point nowhere. Behind a proxy, name the resource explicitly.`
        : u.hostname !== target.hostname
          ? `resource.url host ${u.hostname} differs from the endpoint host ${target.hostname}.`
          : u.protocol !== "https:" ? `resource.url is not https.` : `resource.url is ${resUrl}.`;
    } catch {
      resDetail = `resource.url ${resUrl} is not a URL.`;
    }
  }
  add("resource_public", resOk, resDetail, "listing");

  const bazaar = pr.extensions?.bazaar;
  if (!bazaar) {
    add("bazaar_extension", false, "No bazaar extension: the endpoint gets paid but is never listed.", "listing");
  } else {
    const v = validateDiscoveryExtension(bazaar) as { valid: boolean; errors?: string[] };
    add("bazaar_extension", v.valid, v.valid ? "bazaar extension present and valid." : `bazaar extension invalid: ${(v.errors ?? []).join("; ")}`, "listing");
  }

  const tags: string[] = Array.isArray(pr.resource?.tags) ? pr.resource.tags : [];
  const tagged = tags.includes(CHALLENGE_TAG) || accepts.some((a) => a?.extra?.tag === CHALLENGE_TAG);
  add("challenge_tag", tagged, tagged ? `Tagged ${CHALLENGE_TAG}.` : `Not tagged ${CHALLENGE_TAG}.`, "challenge");

  const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  add("cors_expose", expose.includes("payment-required"), expose.includes("payment-required") ? "Browsers can read the price." : "PAYMENT-REQUIRED is not exposed to browsers (CORS).", "nothing");

  return verdict(target.href, checks);
}

function verdict(url: string, checks: Check[]) {
  const failing = (b: Check["blocks"]) => checks.filter((c) => c.blocks === b && c.ok !== true);
  const listing = failing("listing");
  const challenge = [...listing, ...failing("challenge")];
  return {
    url,
    checkedAt: new Date().toISOString(),
    listable: listing.length === 0,
    challengeReady: challenge.length === 0,
    passed: checks.filter((c) => c.ok === true).length,
    of: checks.length,
    checks,
    fix: challenge.map((c) => c.detail),
  };
}

// ── payee-check ──────────────────────────────────────────────────────────────

let catalog: { at: number; items: Record<string, any>[] } | null = null;
export async function bazaarCatalog(): Promise<Record<string, any>[] | null> {
  if (catalog && Date.now() - catalog.at < 10 * 60_000) return catalog.items;
  const items: Record<string, any>[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const r = await fetch(`${CATALOG}?limit=1000&offset=${offset}`, { headers: { "user-agent": UA, accept: "application/json" }, cache: "no-store" }).catch(() => null);
    if (!r?.ok) return catalog?.items ?? null;
    const page = (await r.json()) as { items?: Record<string, any>[]; pagination?: { total?: number } };
    items.push(...(page.items ?? []));
    if (!page.items?.length || items.length >= (page.pagination?.total ?? 0)) break;
  }
  catalog = { at: Date.now(), items };
  return items;
}

export async function payeeCheck(body: { address?: unknown; network?: unknown }) {
  const address = typeof body.address === "string" ? body.address.trim().toUpperCase() : "";
  const pk = addressToPublicKey(address);
  if (!pk) throw new SkillInputError("`address` must be a valid 58-character Algorand address.", "malformed_address");
  const net: Network = body.network === "mainnet" || body.network === "testnet" ? body.network : NETWORK;
  const usdc = USDC_ASSET[net];

  const acct = await fetch(`${ALGOD[net]}/v2/accounts/${address}`, { cache: "no-store" });
  if (!acct.ok) throw new Error(`algod ${acct.status}`);
  const a = (await acct.json()) as { amount: number; "min-balance"?: number; assets?: { "asset-id": number; amount: number }[] };
  const exists = a.amount > 0;
  const holding = a.assets?.find((x) => x["asset-id"] === usdc);

  // Age, from the indexer's record of when the account was first funded.
  let createdAt: string | null = null;
  const ia = await fetch(`${INDEXER[net]}/v2/accounts/${address}?exclude=all`, { cache: "no-store" }).catch(() => null);
  if (ia?.ok) {
    const round = ((await ia.json()) as { account?: { "created-at-round"?: number } }).account?.["created-at-round"];
    if (round) {
      const blk = await fetch(`${INDEXER[net]}/v2/blocks/${round}?header-only=true`, { cache: "no-store" }).catch(() => null);
      const ts = blk?.ok ? ((await blk.json()) as { timestamp?: number }).timestamp : undefined;
      if (ts) createdAt = new Date(ts * 1000).toISOString();
    }
  }

  // What it has actually been paid in USDC, and how much of that was x402.
  let received = { transfers: 0, x402: 0, usdc: 0, sampled: 0, capped: false };
  const tx = await fetch(`${INDEXER[net]}/v2/accounts/${address}/transactions?asset-id=${usdc}&tx-type=axfer&limit=1000`, { cache: "no-store" }).catch(() => null);
  if (tx?.ok) {
    const t = (await tx.json()) as { transactions?: Record<string, any>[]; "next-token"?: string };
    const list = t.transactions ?? [];
    for (const x of list) {
      const at = x["asset-transfer-transaction"];
      if (at?.receiver !== address || !at.amount) continue;
      received.transfers++;
      received.usdc += at.amount / 1e6;
      const note = x.note ? Buffer.from(x.note, "base64").toString("utf8") : "";
      if (note.startsWith("x402-payment-v2-")) received.x402++;
    }
    received = { ...received, sampled: list.length, capped: !!t["next-token"] };
  }

  // Registered in Ripar's IdentityRegistry on this network? The reverse index
  // box `ad_<pubkey>` holds the agent id; registration is signed by the account
  // itself, so this half cannot be self-asserted in a card.
  let rip: { agentId: number; registry: number } | null = null;
  const boxName = Buffer.concat([Buffer.from("ad_"), pk]).toString("base64");
  const bx = await fetch(`${ALGOD[net]}/v2/applications/${REGISTRIES.identityApp}/box?name=b64:${encodeURIComponent(boxName)}`, { cache: "no-store" }).catch(() => null);
  if (bx?.ok) {
    const v = Buffer.from(((await bx.json()) as { value: string }).value, "base64");
    if (v.length >= 8) rip = { agentId: Number(v.readBigUInt64BE(v.length - 8)), registry: REGISTRIES.identityApp };
  }

  const items = await bazaarCatalog();
  // Same network only: a TestNet check must not report MainNet listings as
  // this address's, and vice versa.
  const listed =
    items?.filter(
      (i) => Array.isArray(i.accepts) && i.accepts.some((x: any) => x?.payTo === address && typeof x?.network === "string" && networkOf(x.network) === net)
    ) ?? null;

  const facts: string[] = [];
  facts.push(exists ? "Account exists." : "Account holds no ALGO — it does not exist on chain.");
  facts.push(holding ? `Opted into USDC (${usdc}); can receive payment.` : `NOT opted into USDC (${usdc}); a payment to it will fail.`);
  if (createdAt) facts.push(`First funded ${createdAt.slice(0, 10)}.`);
  facts.push(`${received.transfers} inbound USDC transfer(s)${received.capped ? " in the latest 1000" : ""}, ${received.x402} of them x402 settlements.`);
  facts.push(listed == null ? "Bazaar catalog unreachable — listing unknown." : listed.length ? `Receives payment for ${listed.length} Bazaar-listed resource(s).` : "No Bazaar-listed resource pays this address.");
  facts.push(rip ? `Registered as agent ${rip.agentId} in Ripar IdentityRegistry ${rip.registry}.` : "Not registered in Ripar's IdentityRegistry.");

  return {
    address,
    network: net,
    checkedAt: new Date().toISOString(),
    exists,
    canReceiveUsdc: !!holding,
    usdcBalance: holding ? holding.amount / 1e6 : 0,
    firstFunded: createdAt,
    received,
    bazaar: listed == null ? null : { resources: listed.length, urls: listed.slice(0, 10).map((i) => i.resourceUrl ?? i.resource) },
    ripar: rip,
    facts,
  };
}
