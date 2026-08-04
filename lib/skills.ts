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
