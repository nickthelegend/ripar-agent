import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { PAY_TO, resolveNetwork, x402Server } from "@/lib/x402";
import { SkillInputError, summarize } from "@/lib/skills";

/**
 * The A2A endpoint the agent card names.
 *
 * A card that advertises `supportedInterfaces: [{ url: …/a2a }]` and serves
 * nothing there is worse than publishing no card: a peer discovers the agent,
 * tries to talk to it, and gets a 404 with no explanation. This is that
 * endpoint — JSON-RPC 2.0, the methods a client actually reaches for.
 *
 * The interesting part is where A2A meets x402. A2A has no notion of paying
 * for a call, so an unpaid `message/send` is answered with JSON-RPC error
 * -32002 carrying the x402 challenge in `data`. A caller that understands x402
 * signs it and retries with the same header the REST endpoint takes; a caller
 * that does not at least learns why it was refused and what it would cost,
 * rather than being told "unauthorized".
 *
 * Work here is synchronous, so `message/send` returns a completed Task rather
 * than a pending one. Tasks are not persisted — `tasks/get` says so plainly
 * instead of inventing a status for an id it has never seen.
 */
export const dynamic = "force-dynamic";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

const PROTOCOL_VERSION = "1.0";

/* JSON-RPC 2.0 reserves -32768..-32000. -32002 is the A2A convention for
   "the call is understood but cannot proceed as sent". */
const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  paymentRequired: -32002,
  taskNotFound: -32001,
} as const;

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } },
    { status }
  );
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

/** Pull the caller's text out of an A2A message: the parts array, in order. */
function textOf(params: unknown): { text: string; max?: number } {
  const message = (params as { message?: unknown })?.message as
    | { parts?: Array<{ kind?: string; type?: string; text?: string; data?: unknown }> }
    | undefined;

  const parts = message?.parts ?? [];
  const text = parts
    .filter((p) => (p.kind ?? p.type) === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();

  // A data part may carry options the text cannot express.
  const dataPart = parts.find((p) => (p.kind ?? p.type) === "data")?.data as
    | { max?: unknown }
    | undefined;
  const max = Number(dataPart?.max);

  return { text, max: Number.isFinite(max) ? max : undefined };
}

/** Deterministic id from the request id, so a retry does not mint a new task. */
function taskIdFor(id: JsonRpcRequest["id"]) {
  return `task-${String(id ?? "anon")}`;
}

/** The paid path. Reached only once x402 has settled, exactly like the REST
 *  endpoint — withX402 replays the request into this handler after settling. */
async function paidHandler(request: NextRequest): Promise<NextResponse> {
  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json();
  } catch {
    return rpcError(null, ERR.parse, "Body must be JSON-RPC 2.0.");
  }

  const { text, max } = textOf(rpc.params);
  if (!text) {
    return rpcError(rpc.id, ERR.invalidParams, "message.parts must contain a non-empty text part.");
  }

  let result;
  try {
    result = summarize({ text, max });
  } catch (err) {
    if (err instanceof SkillInputError) {
      return rpcError(rpc.id, ERR.invalidParams, err.message, { code: err.code });
    }
    return rpcError(rpc.id, ERR.internal, "The skill failed.", undefined, 500);
  }

  const taskId = taskIdFor(rpc.id);
  const contextId = String((rpc.params as { message?: { contextId?: string } })?.message?.contextId ?? taskId);

  return rpcResult(rpc.id, {
    id: taskId,
    contextId,
    kind: "task",
    // Synchronous work, so it is already done. Reporting "submitted" here would
    // make every client poll tasks/get for something that will never change.
    status: { state: "completed", timestamp: new Date().toISOString() },
    artifacts: [
      {
        artifactId: `${taskId}-summary`,
        name: "summary",
        parts: [
          { kind: "text", text: result.summary },
          { kind: "data", data: result },
        ],
      },
    ],
  });
}

/** message/send is the only method that costs money, so it is the only one
 *  wrapped. Resolved per cold start because the CAIP-2 id comes from the
 *  facilitator rather than a constant. */
async function gatedSend(request: NextRequest) {
  const network = await resolveNetwork();
  const gated = withX402(
    paidHandler,
    {
      accepts: { scheme: "exact", network, payTo: PAY_TO, price: "$0.01" },
      description: "A2A message/send against the summarize skill.",
    },
    x402Server
  );

  const res = await gated(request);

  // withX402 answers an unpaid call with a bare HTTP 402. A JSON-RPC client
  // cannot read that, so translate: same challenge, in the envelope the caller
  // is already parsing.
  if (res.status === 402) {
    const challenge = res.headers.get("payment-required");
    let requirements: unknown = null;
    if (challenge) {
      try {
        requirements = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
      } catch {
        /* pass the raw header through instead, below */
      }
    }
    const body = await request.clone().json().catch(() => ({}) as JsonRpcRequest);
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: (body as JsonRpcRequest).id ?? null,
        error: {
          code: ERR.paymentRequired,
          message:
            "This skill is paid. Settle the attached x402 challenge and retry with a PAYMENT-SIGNATURE header.",
          data: {
            protocol: "x402",
            requirements: requirements ?? challenge,
            // PAYMENT-SIGNATURE is the x402 v2 name and the only one @x402/core
            // reads. This route also accepts the older X-PAYMENT because
            // @x402/next falls back to it, but a caller told to send X-PAYMENT
            // would fail against any server built on @x402/express.
            retryWith: "PAYMENT-SIGNATURE",
            alsoAccepted: ["X-PAYMENT"],
            restEquivalent: "/api/summarize",
          },
        },
      },
      { status: 402, headers: challenge ? { "payment-required": challenge } : undefined }
    );
  }

  return res;
}

export async function POST(request: NextRequest) {
  let rpc: JsonRpcRequest;
  try {
    // Cloned, because gatedSend re-reads the body when payment is needed.
    rpc = await request.clone().json();
  } catch {
    return rpcError(null, ERR.parse, "Body must be JSON-RPC 2.0.");
  }

  if (rpc.jsonrpc !== "2.0") {
    return rpcError(rpc.id, ERR.invalidRequest, 'Expected "jsonrpc": "2.0".');
  }

  switch (rpc.method) {
    case "message/send":
      return gatedSend(request);

    case "message/stream":
      // The card says streaming: false. Saying so here too is better than a
      // silent hang while a client waits for events that never come.
      return rpcError(
        rpc.id,
        ERR.methodNotFound,
        "This agent does not stream; its capabilities.streaming is false. Use message/send."
      );

    case "tasks/get": {
      // Work completes inside message/send and nothing is stored, so any id is
      // one we have never seen. Admitting that beats fabricating a status.
      const id = (rpc.params as { id?: string })?.id;
      return rpcError(
        rpc.id,
        ERR.taskNotFound,
        `No task ${id ?? "(none given)"}. This agent completes work synchronously in message/send and does not retain tasks.`
      );
    }

    case "tasks/cancel":
      return rpcError(
        rpc.id,
        ERR.taskNotFound,
        "Nothing to cancel: work completes synchronously within message/send."
      );

    case "agent/getAuthenticatedExtendedCard":
      // No authenticated view exists, so the public card IS the whole card.
      return NextResponse.redirect(new URL("/.well-known/agent.json", request.url), 307);

    default:
      return rpcError(
        rpc.id,
        ERR.methodNotFound,
        `Unknown method "${rpc.method ?? ""}". This agent implements message/send.`
      );
  }
}

/** A GET here is a peer looking for the card at the wrong path. Point at it
 *  rather than 405-ing, and say which protocol version this speaks. */
export function GET(request: NextRequest) {
  return NextResponse.json({
    protocol: "A2A",
    protocolVersion: PROTOCOL_VERSION,
    transport: "JSONRPC",
    methods: ["message/send"],
    card: new URL("/.well-known/agent.json", request.url).toString(),
    note: "POST JSON-RPC 2.0 here. message/send is paid over x402; an unpaid call returns error -32002 carrying the challenge.",
  });
}
