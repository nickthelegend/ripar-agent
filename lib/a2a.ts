/**
 * The A2A objects this agent emits, with no transport around them.
 *
 * Same reason `lib/skills.ts` exists: `message/send` and `message/stream` must
 * describe the SAME piece of work, and the surest way to make them disagree is
 * to build the Task twice. The route decides how to deliver these; this file
 * decides what they are.
 */

import type { SummarizeResult } from "./skills";

export const PROTOCOL_VERSION = "1.0";

export type TaskStatus = { state: string; timestamp: string };

export type A2ATask = {
  id: string;
  contextId: string;
  kind: "task";
  status: TaskStatus;
  artifacts?: unknown[];
  history?: unknown[];
  metadata?: Record<string, unknown>;
};

export type StatusUpdateEvent = {
  taskId: string;
  contextId: string;
  kind: "status-update";
  status: TaskStatus;
  /** True on the last event of the stream. A client stops reading on this. */
  final: boolean;
};

export type ArtifactUpdateEvent = {
  taskId: string;
  contextId: string;
  kind: "artifact-update";
  artifact: { artifactId: string; name: string; parts: unknown[] };
  lastChunk: boolean;
};

export type StreamEvent = A2ATask | StatusUpdateEvent | ArtifactUpdateEvent;

/** The artifact both delivery paths carry: the text, and the numbers behind it. */
export function summaryArtifact(taskId: string, result: SummarizeResult) {
  return {
    artifactId: `${taskId}-summary`,
    name: "summary",
    parts: [
      { kind: "text", text: result.summary },
      { kind: "data", data: result },
    ],
  };
}

/**
 * A finished Task.
 *
 * `completed` immediately, because the work is synchronous and already done by
 * the time this is built. Reporting `submitted` would make every client poll
 * `tasks/get` for a state that will never change.
 */
export function completedTask(input: {
  taskId: string;
  contextId: string;
  result: SummarizeResult;
  timestamp?: string;
}): A2ATask {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    id: input.taskId,
    contextId: input.contextId,
    kind: "task",
    status: { state: "completed", timestamp },
    artifacts: [summaryArtifact(input.taskId, input.result)],
  };
}

/**
 * The event sequence `message/stream` writes, in order.
 *
 * This is a real SSE stream of the real A2A lifecycle — an initial Task, then
 * the status and artifact updates, then a final event a client can stop on. It
 * is deliberately NOT padded with invented progress: the summariser is a pure
 * function that returns in microseconds, so every event here is produced at
 * once and the client receives them together. Slicing the summary into fake
 * chunks would look more like streaming and mean less, because there is no
 * intermediate state to report — the honest claim is "this endpoint speaks
 * SSE and emits the whole lifecycle", not "this model generates gradually".
 *
 * `working` is included rather than skipped: a client that switches on state
 * expects to see the task enter it, and leaving it out would make this stream
 * a shape no A2A client has a code path for.
 */
export function streamEvents(task: A2ATask): StreamEvent[] {
  const { id: taskId, contextId } = task;
  const at = task.status.timestamp;
  return [
    { ...task, status: { state: "submitted", timestamp: at } },
    { taskId, contextId, kind: "status-update", status: { state: "working", timestamp: at }, final: false },
    {
      taskId,
      contextId,
      kind: "artifact-update",
      artifact: (task.artifacts?.[0] ?? {}) as ArtifactUpdateEvent["artifact"],
      lastChunk: true,
    },
    { taskId, contextId, kind: "status-update", status: task.status, final: true },
  ];
}

/**
 * One SSE frame per event, each carrying a whole JSON-RPC response.
 *
 * A2A streams JSON-RPC over SSE: every `data:` line is a complete response with
 * the request's id, not a bare event object — a client correlates the stream to
 * its call by that id, and one without it is unroutable.
 */
export function sseFrames(id: string | number | null, events: StreamEvent[]): string {
  return events
    .map((result) => `data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`)
    .join("");
}
