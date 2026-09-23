// Conductor helper: the exact convention autonoxis-conductor-9b was trained on — one `label` choice over state {packet}.
import { readFileSync } from "node:fs";

export const QUESTIONS = JSON.parse(readFileSync(new URL("./conductor-questions.json", import.meta.url), "utf8"));
export const ACT_THRESHOLD = 0.8;

export async function conductor(client, { track, packet }, signal) {
  const q = QUESTIONS[track];
  if (!q) throw new Error(`track must be one of ${Object.keys(QUESTIONS).join(", ")}`);
  const res = await client.evaluate({ state: { packet }, questions: { label: q } }, signal);
  const a = res.answers.label;
  if (typeof a?.choice !== "string" || !Object.hasOwn(q.criteria, a.choice)) throw new Error(`choice ${JSON.stringify(a?.choice)} is not a ${track} label (${Object.keys(q.criteria).join(", ")})`);
  return { label: a.choice, confidence: a.confidence, probabilities: a.probabilities, act: a.confidence >= ACT_THRESHOLD ? true : "escalate", model: res.model, elapsedMs: res.elapsedMs };
}
