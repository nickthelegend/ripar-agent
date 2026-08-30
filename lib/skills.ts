/**
 * The work itself, with no transport around it.
 *
 * Two routes call this: `/api/summarize`, which is the Ripar-native paid
 * endpoint, and `/a2a`, which is the same skill reachable by any A2A client.
 * Keeping the logic here is what stops the two drifting into giving different
 * answers to the same question — a real risk once the A2A card starts telling
 * strangers what this agent does.
 */

export type SummarizeInput = { text?: unknown; max?: unknown };

export type SummarizeResult = {
  summary: string;
  chars: number;
  summaryChars: number;
  sentences: number;
  compression: number;
};

export class SkillInputError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "SkillInputError";
  }
}

export function summarize(body: SummarizeInput): SummarizeResult {
  const text = String(body.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    throw new SkillInputError("`text` is required and must be non-empty.", "missing_text");
  }

  const max = Math.min(Math.max(Number(body.max) || 280, 40), 2000);
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);

  // Take whole sentences while they fit, so the summary ends cleanly rather
  // than mid-word.
  let summary = "";
  for (const s of sentences) {
    if ((summary + " " + s).trim().length > max) break;
    summary = (summary + " " + s).trim();
  }
  if (!summary) summary = text.length <= max ? text : `${text.slice(0, max - 1)}…`;

  return {
    summary,
    chars: text.length,
    summaryChars: summary.length,
    sentences: sentences.length,
    compression: Number((summary.length / text.length).toFixed(3)),
  };
}

/* ------------------------- verify a settlement --------------------------- */

export type VerifyInput = { txid?: unknown; network?: unknown };

export type VerifyResult = {
  txid: string;
  settled: boolean;
  /** Present only when settled — every field read off the chain, none inferred. */
  payment?: {
    round: number;
    amount: string;
    amountUsdc: number;
    assetId: number;
    from: string;
    to: string;
    /** The network fee the SENDER paid. 0 means a facilitator sponsored it. */
    feeMicroAlgos: number;
    sponsored: boolean;
    /** The x402 protocol note, decoded. Absent on a bare transfer. */
    note: string | null;
    isX402: boolean;
  };
  /** Why it is not a settlement, when it is not. Never a bare false. */
  reason?: string;
};

const INDEXER: Record<string, string> = {
  testnet: "https://testnet-idx.algonode.cloud",
  mainnet: "https://mainnet-idx.algonode.cloud",
};

/**
 * Confirm a transaction really is an x402 settlement, and say what it moved.
 *
 * The distinction this draws is the whole point. A caller who has a txid can
 * already look it up; what they cannot cheaply tell is whether it is a
 * *payment for an x402 call* rather than any other asset transfer that happens
 * to have landed. That turns on three things read together — it is an `axfer`,
 * it carries a `x402-payment-v2-` note, and the sender paid no fee because a
 * facilitator sponsored it — and none of the three is conclusive alone.
 *
 * `settled: false` always carries a `reason`. A bare false would be
 * indistinguishable from "the indexer was unreachable", which is a different
 * problem and a different fix.
 */
export async function verifySettlement(body: VerifyInput): Promise<VerifyResult> {
  const txid = typeof body.txid === "string" ? body.txid.trim().toUpperCase() : "";
  if (!txid) {
    throw new SkillInputError("`txid` is required and must be non-empty.", "missing_txid");
  }
  if (!/^[A-Z2-7]{52}$/.test(txid)) {
    throw new SkillInputError(
      "`txid` must be a 52-character base32 Algorand transaction id.",
      "malformed_txid"
    );
  }
  const net = body.network === "mainnet" ? "mainnet" : "testnet";

  const res = await fetch(`${INDEXER[net]}/v2/transactions/${txid}`, { cache: "no-store" });
  if (res.status === 404) {
    return { txid, settled: false, reason: `No transaction with that id on ${net}.` };
  }
  if (!res.ok) {
    // Not "unsettled" — unknown. Saying otherwise would turn an outage into a
    // verdict about somebody's payment.
    throw new Error(`indexer ${res.status}`);
  }

  const t = ((await res.json()) as { transaction?: Record<string, unknown> }).transaction;
  if (!t) return { txid, settled: false, reason: "Indexer returned no transaction body." };

  const x = t["asset-transfer-transaction"] as
    | { amount?: number; "asset-id"?: number; receiver?: string }
    | undefined;
  if (!x) {
    return {
      txid,
      settled: false,
      reason: `Transaction is a ${String(t["tx-type"] ?? "unknown")}, not an asset transfer.`,
    };
  }

  let note: string | null = null;
  try {
    const raw = t.note as string | undefined;
    if (raw) note = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    note = null;
  }
  const isX402 = note?.startsWith("x402-payment-v2-") ?? false;
  const fee = Number(t.fee ?? 0);
  const amount = Number(x.amount ?? 0);

  return {
    txid,
    settled: true,
    payment: {
      round: Number(t["confirmed-round"] ?? 0),
      amount: String(amount),
      amountUsdc: amount / 1e6,
      assetId: Number(x["asset-id"] ?? 0),
      from: String(t.sender ?? ""),
      to: String(x.receiver ?? ""),
      feeMicroAlgos: fee,
      sponsored: fee === 0,
      note,
      isX402,
    },
    ...(isX402 ? {} : { reason: "Settled, but carries no x402-payment-v2 note." }),
  };
}
