// Post-run gate: one noul question over a diff, a file, or stdin. Exit 0 pass / 1 fail / 2 error.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AutonoxisClient } from "./client.mjs";

export function parseArgs(argv) {
  const o = { criteria: "", threshold: 0.7, json: false, failOpen: false, diff: false, file: null, url: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--criteria") o.criteria = argv[++i] ?? "";
    else if (a === "-p" || a === "--threshold") o.threshold = Number(argv[++i]);
    else if (a === "-d" || a === "--diff") o.diff = true;
    else if (a === "-f" || a === "--file") o.file = argv[++i];
    else if (a === "--url") o.url = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--fail-open") o.failOpen = true;
    else if (!a.startsWith("-") && !o.criteria) o.criteria = a;
  }
  if (!o.criteria) throw new Error("criteria required (-c)");
  if (!(o.threshold >= 0 && o.threshold <= 1)) throw new Error("threshold must be 0..1");
  return o;
}

export function readState(o, stdin = () => readFileSync(0, "utf8")) {
  if (o.diff) return execSync("git diff HEAD", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (o.file) return readFileSync(o.file, "utf8");
  return stdin();
}

// The model's prompt limit is 2048 tokens including the schema; ~6000 chars of diff leaves room.
export const MAX_STATE_CHARS = 6000;

// Chars are only a proxy for tokens: on the server's limit error, shrink by the reported ratio (10% margin) and retry.
// client.mjs throws `${method} ${path}: ${status} ${error}`; only an HTTP 400 carrying the full limit message qualifies.
const LIMIT_RE = /: 400 .*Longest prompt has (\d+) tokens; limit is (\d+)\. Nothing was truncated\./;

export async function runGate(o, state, client = new AutonoxisClient(o.url)) {
  if (!state.trim()) throw new Error("empty state");
  let len = Math.min(state.length, MAX_STATE_CHARS), truncated = state.length > len, res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await client.evaluate({
        state: { content: state.slice(0, len), truncated },
        questions: { gate: { type: "noul", instructions: "Does `content` satisfy this acceptance criterion: " + o.criteria } },
      });
      break;
    } catch (err) {
      const m = LIMIT_RE.exec(err?.message ?? "");
      if (!m || attempt >= 3) throw err;
      const next = Math.floor(len * (Number(m[2]) / Number(m[1])) * 0.9);
      if (!(next >= 1 && next < len)) throw err; // never send an empty slice or retry without shrinking
      len = next;
      truncated = true;
    }
  }
  const probability = res.answers.gate.noul;
  return { passed: probability >= o.threshold, probability, threshold: o.threshold, criteria: o.criteria, truncated, model: res.model, elapsedMs: res.elapsedMs };
}
