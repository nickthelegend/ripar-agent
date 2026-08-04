import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "@x402/next";
import { PAY_TO, resolveNetwork, x402Server } from "@/lib/x402";
import { SkillInputError, summarize } from "@/lib/skills";
import { PROTOCOL_VERSION, completedTask, sseFrames, streamEvents } from "@/lib/a2a";
import {
  TASK_STORE_CAVEAT,
  cancelTask,
  getTask,
  putTask,
  taskIdFor,
} from "@/lib/tasks";

/**
 * The A2A endpoint the agent card names.
 *
 * A card that advertises `supportedInterfaces: [{ url: …/a2a }]` and serves
 * nothing there is worse than publishing no card: a peer discovers the agent,
 * tries to talk to it, and gets a 404 with no explanation. This is that
 * endpoint — JSON-RPC 2.0, the methods a client actually reaches for.
 *
 * The interesting part is where A2A meets x402. A2A has no notion of paying
 * for a call, so an unpaid `message/send` is answered with a JSON-RPC error
 * carrying the x402 challenge in `data`. A caller that understands x402 signs
 * it and retries with the same header the REST endpoint takes; a caller that
 * does not at least learns why it was refused and what it would cost, rather
 * than being told "unauthorized".
 *
 * Work here is synchronous, so `message/send` returns a completed Task rather
 * than a pending one, and `message/stream` emits the whole lifecycle at once
 * over real SSE. Completed tasks are kept in a bounded per-process map so
 * `tasks/get` can genuinely fetch one back — see lib/tasks.ts for exactly how
 * little that promises.
 */
export const dynamic = "force-dynamic";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

/* JSON-RPC 2.0 reserves -32768..-32000, and A2A has claimed -32001..-32006
   inside it. Payment-required is not an A2A error, so it takes a code outside
   that block and inside JSON-RPC's implementation-defined server-error range
   (-32099..-32000).

   It used to be -32002, which A2A defines as TaskNotCancelable — a collision
   that did not matter while tasks/cancel was a stub answering the same code for
   a different reason, and became a real ambiguity the moment cancel got real
   semantics. One number cannot mean both "pay me" and "too late to cancel". */
const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  paymentRequired: -32010,
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

function contextOf(params: unknown, fallback: string): string {
  return String((params as { message?: { contextId?: string } })?.message?.contextId ?? fallback);
}

/**
 * Do the work and store the result, or return the JSON-RPC error that stops it.
 *
 * Shared by both delivery paths so a summary cannot differ between them, and so
 * a task is stored exactly once whichever way it was asked for.
 */
function runSkill(rpc: JsonRpcRequest) {
  const { text, max } = textOf(rpc.params);
  if (!text) {
    return {
      error: rpcError(rpc.id, ERR.invalidParams, "message.parts must contain a non-empty text part."),
    };
  }

  let result;
  try {
    result = summarize({ text, max });
  } catch (err) {
    if (err instanceof SkillInputError) {
      return { error: rpcError(rpc.id, ERR.invalidParams, err.message, { code: err.code }) };
    }
    return { error: rpcError(rpc.id, ERR.internal, "The skill failed.", undefined, 500) };
  }

  // Derived from the request id AND the input, so retrying the same call is
  // idempotent while two callers who both used id 1 do not overwrite each
  // other — which they would with an id built from the request id alone.
  const taskId = taskIdFor(rpc.id, { text, max });
  const task = completedTask({ taskId, contextId: contextOf(rpc.params, taskId), result });
  putTask(task);
  return { task };
}

/** The paid path for message/send. Reached only once x402 has settled. */
async function paidSend(request: NextRequest): Promise<NextResponse> {
  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json();
  } catch {
    return rpcError(null, ERR.parse, "Body must be JSON-RPC 2.0.");
  }

  const outcome = runSkill(rpc);
  if (outcome.error) return outcome.error;

  return rpcResult(rpc.id, { ...outcome.task, metadata: { taskStore: TASK_STORE_CAVEAT } });
}

/**
 * The paid path for message/stream: a real `text/event-stream`.
 *
 * Worth being precise about what does and does not stream here. The events are
 * genuine A2A lifecycle events on a genuine SSE response, which is what
 * `capabilities.streaming` claims and all it claims. They are not spread out
 * over time, because the work finishes in microseconds and there is no
 * intermediate state to report — and, separately, `withX402` buffers a response
 * body in order to settle payment against it, so even a slow handler would not
 * reach the client incrementally through the paywall. That is a property of
 * settling before delivery, and it is stated here rather than discovered later.
 */
async function paidStream(request: NextRequest): Promise<NextResponse> {
  let rpc: JsonRpcRequest;
  try {
    rpc = await request.json();
  } catch {
    return rpcError(null, ERR.parse, "Body must be JSON-RPC 2.0.");
  }

  const outcome = runSkill(rpc);
  // An error before the stream opens is a plain JSON-RPC error, not an SSE
  // frame: nothing has been streamed yet, and a client that asked for a stream
  // and got a failure should not have to parse SSE to read it.
  if (outcome.error) return outcome.error;

  const body = sseFrames(rpc.id ?? null, streamEvents(outcome.task!));

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform matters as much as no-store: a proxy that helpfully
      // compresses or rewrites an event stream breaks frame boundaries.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and several CDNs buffer proxied responses by default, which turns
      // an event stream into one delivery at the end.
      "x-accel-buffering": "no",
    },
  });
}

/** Both paid methods cost the same, so they are gated the same way. Resolved
 *  per cold start because the CAIP-2 id comes from the facilitator rather than
 *  a constant. */
async function gated(request: NextRequest, handler: (r: NextRequest) => Promise<NextResponse>, what: string) {
  const network = await resolveNetwork();
  const wrapped = withX402(
    handler,
    {
      accepts: { scheme: "exact", network, payTo: PAY_TO, price: "$0.01" },
      description: `A2A ${what} against the summarize skill.`,
    },
    x402Server
  );

  const res = await wrapped(request);

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
    // Cloned, because the gated handlers re-read the body.
    rpc = await request.clone().json();
  } catch {
    return rpcError(null, ERR.parse, "Body must be JSON-RPC 2.0.");
  }

  if (rpc.jsonrpc !== "2.0") {
    return rpcError(rpc.id, ERR.invalidRequest, 'Expected "jsonrpc": "2.0".');
  }

  switch (rpc.method) {
    case "message/send":
      return gated(request, paidSend, "message/send");

    case "message/stream":
      return gated(request, paidStream, "message/stream");

    case "tasks/get": {
      const id = (rpc.params as { id?: string })?.id;
      if (!id) {
        return rpcError(rpc.id, ERR.invalidParams, "tasks/get needs params.id.");
      }
      const task = getTask(id);
      if (!task) {
        // Deliberately not "no such task": this process not having it is a
        // weaker claim than it never existing, and the difference is the whole
        // reason the caveat is attached.
        return rpcError(
          rpc.id,
          ERR.taskNotFound,
          `This server process is not holding task ${id}.`,
          { taskStore: TASK_STORE_CAVEAT }
        );
      }
      return rpcResult(rpc.id, { ...task, metadata: { taskStore: TASK_STORE_CAVEAT } });
    }

    case "tasks/cancel": {
      const id = (rpc.params as { id?: string })?.id;
      if (!id) {
        return rpcError(rpc.id, ERR.invalidParams, "tasks/cancel needs params.id.");
      }
      const outcome = cancelTask(id);
      if (outcome.ok) {
        // Unreachable today and left as the honest branch rather than removed:
        // a task only enters the store once it is finished, so there is never
        // anything in flight to interrupt. If work ever becomes asynchronous
        // this is where a cancellation would land.
        return rpcResult(rpc.id, {
          ...outcome.task,
          status: { state: "canceled", timestamp: new Date().toISOString() },
        });
      }
      if (outcome.reason === "not_found") {
        return rpcError(
          rpc.id,
          ERR.taskNotFound,
          `This server process is not holding task ${id}, so there is nothing here to cancel.`,
          { taskStore: TASK_STORE_CAVEAT }
        );
      }
      return rpcError(
        rpc.id,
        ERR.taskNotCancelable,
        `Task ${id} has already completed and cannot be cancelled.`,
        {
          state: outcome.task?.status.state,
          why: "This agent's skill is synchronous: a task exists only once the work is finished, so every task this server holds is already past the point of cancelling.",
        }
      );
    }

    case "agent/getAuthenticatedExtendedCard":
      // No authenticated view exists, so the public card IS the whole card.
      return NextResponse.redirect(new URL("/.well-known/agent.json", request.url), 307);

    default:
      return rpcError(
        rpc.id,
        ERR.methodNotFound,
        `Unknown method "${rpc.method ?? ""}". This agent implements message/send, message/stream, tasks/get and tasks/cancel.`
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
    methods: ["message/send", "message/stream", "tasks/get", "tasks/cancel"],
    card: new URL("/.well-known/agent.json", request.url).toString(),
    note:
      `POST JSON-RPC 2.0 here. message/send and message/stream are paid over x402; an unpaid call ` +
      `returns error ${ERR.paymentRequired} carrying the challenge. message/stream answers with ` +
      `text/event-stream — real SSE carrying the A2A lifecycle, though the work is synchronous so ` +
      `every event is produced at once rather than spread over time.`,
    tasks: TASK_STORE_CAVEAT,
  });
}
