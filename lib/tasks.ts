/**
 * Task storage, and the honest limits of it.
 *
 * A2A lets a client come back later with `tasks/get`. Until now this agent
 * answered every such call with "no such task", which was true — work finished
 * inside `message/send` and nothing was kept — but useless: a client could not
 * fetch back a result it had just been handed an id for.
 *
 * So results are kept. What must not happen is the store quietly implying more
 * than it is:
 *
 *   - **It is per process.** This runs on Vercel, so there are several
 *     processes, each with its own Map, and a `tasks/get` may land on a
 *     different one from the `message/send` that created the task. A miss is
 *     therefore genuinely ambiguous, and the not-found response says so rather
 *     than asserting the task never existed.
 *   - **It is lost on restart.** A cold start begins empty. Nothing here is
 *     durable and nothing pretends to be.
 *   - **It is bounded.** `MAX_TASKS` entries, oldest evicted first. Without a
 *     bound a long-lived instance turns every request into permanent heap.
 *
 * The alternative — a database — would make `tasks/get` reliable, and is the
 * right answer for an agent doing long work. This one finishes in microseconds,
 * so the store exists to make the protocol honest, not to make work durable.
 */

import { createHash } from "node:crypto";

/** Small enough to be a rounding error in memory, large enough for a session. */
export const MAX_TASKS = 100;

/**
 * What the store needs of a task, which is deliberately less than an A2A Task
 * is. Declared structurally rather than imported from `lib/a2a.ts` so the two
 * modules do not depend on each other in a circle — an `A2ATask` satisfies this
 * as it stands, and the state lives in exactly one place, `status.state`,
 * rather than being copied to a second field that can drift from the first.
 */
export type StoredTask = {
  id: string;
  status: { state: string; timestamp: string };
};

const tasks = new Map<string, StoredTask & Record<string, unknown>>();

/**
 * A task id that is stable for the same request and different for a different
 * one.
 *
 * This used to be `task-${rpcId}` alone, which was fine while nothing was
 * stored: a retry reused the id and no one could look either up. With a store
 * that collides — two callers both using JSON-RPC id 1, as clients do, would
 * share `task-1`, and the second would silently overwrite the first's result.
 * The digest covers the request id AND the input, so a retry of the same call
 * is still idempotent and two different calls are two different tasks.
 */
export function taskIdFor(rpcId: unknown, input: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ rpcId: rpcId ?? null, input }))
    .digest("hex");
  return `task-${digest.slice(0, 24)}`;
}

export function putTask<T extends StoredTask>(task: T): T {
  // Re-inserting moves it to the end, so a task that is still being used is not
  // the next one evicted.
  tasks.delete(task.id);
  tasks.set(task.id, task as StoredTask & Record<string, unknown>);
  while (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next();
    if (oldest.done) break;
    tasks.delete(oldest.value);
  }
  return task;
}

export function getTask(id: string): (StoredTask & Record<string, unknown>) | undefined {
  return tasks.get(id);
}

/**
 * Mark a stored task cancelled.
 *
 * Returns why it could not be, rather than a bare false, because A2A
 * distinguishes the two cases with different error codes and the caller here
 * has to pick one:
 *
 *   `not_found`      — no such task in THIS process (see the caveat above)
 *   `not_cancelable` — it exists and has already finished
 *
 * Nothing is ever in flight to interrupt: the skill is synchronous, so a task
 * exists only once it is done. Which means `not_cancelable` is the answer for
 * every task that is actually here — and that is a real answer, not a stub.
 */
export function cancelTask(
  id: string
):
  | { ok: true; task: StoredTask }
  | { ok: false; reason: "not_found" | "not_cancelable"; task?: StoredTask } {
  const task = tasks.get(id);
  if (!task) return { ok: false, reason: "not_found" };
  if (task.status.state === "completed") return { ok: false, reason: "not_cancelable", task };
  return { ok: true, task };
}

/** Only for tests and diagnostics — never called by a request handler. */
export function clearTasks(): void {
  tasks.clear();
}

export function taskCount(): number {
  return tasks.size;
}

/** The caveat, in one string, so every response that needs it says the same thing. */
export const TASK_STORE_CAVEAT =
  "Tasks are held in memory in a single server process, capped at " +
  `${MAX_TASKS} and evicted oldest-first. They are lost on restart, and this deployment runs ` +
  "more than one instance, so a tasks/get may reach an instance that never saw the message/send. " +
  "A miss means this process does not have it — not that it never existed.";
