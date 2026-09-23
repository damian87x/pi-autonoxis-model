import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { AutonoxisClient, choiceConfidence, resolveUrl } from "../src/client.mjs";
import { parseArgs, runGate } from "../src/gate.mjs";

/** Fake System One server: echoes a fixed answer, records the request. `reject(body)` -> error string makes it answer `status` (400). */
function fakeServer(answerFor, reject = () => null, status = 400) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
      const parsed = JSON.parse(body);
      seen.push(parsed);
      const err = reject(parsed);
      if (err) { res.statusCode = status; return res.end(JSON.stringify({ error: err })); }
      const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, q]) => [id, answerFor(id, q)]));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "fake", answers, usage: { input_tokens: 42, output_tokens: 0 } }));
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

test("resolveUrl strips trailing slash and honours NIMBLE_URL", () => {
  process.env.NIMBLE_URL = "http://x:1/";
  assert.equal(resolveUrl(), "http://x:1");
  delete process.env.NIMBLE_URL;
  assert.equal(resolveUrl("http://y:2//"), "http://y:2");
  assert.equal(resolveUrl(), "http://127.0.0.1:8765");
});

test("choiceConfidence matches Jev's documented formula", () => {
  assert.equal(choiceConfidence({ a: 1, b: 0, c: 0 }), 1);
  assert.equal(choiceConfidence({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }).toFixed(6), "0.000000");
  assert.equal(choiceConfidence({ a: 0.9, b: 0.06, c: 0.04 }).toFixed(2), "0.85");
});

test("evaluate sends Jev-shaped body and accounts usage", async () => {
  const { srv, seen, url } = await fakeServer((id) => ({ type: "choice", choice: "billing", confidence: 0.97, probabilities: { billing: 0.98, other: 0.02 } }));
  const c = new AutonoxisClient(url);
  const res = await c.evaluate({ state: { m: "x" }, questions: { team: { type: "choice", instructions: "q", criteria: { billing: null, other: null } } } });
  assert.equal(res.answers.team.choice, "billing");
  assert.deepEqual(seen[0].state, { m: "x" });
  assert.equal(c.stats.requests, 1);
  assert.equal(c.stats.inputTokens, 42);
  await assert.rejects(c.evaluate({ state: "s", questions: {} }), /non-empty/);
  srv.close();
});

test("gate: threshold decides pass/fail; arg parsing rejects bad input", async () => {
  const { srv, url } = await fakeServer((id, q) => ({ type: "noul", noul: q.instructions.includes("passes") ? 0.95 : 0.1 }));
  const pass = await runGate(parseArgs(["-c", "it passes", "--url", url]), "diff text");
  const fail = await runGate(parseArgs(["-c", "it fails", "--url", url, "-p", "0.5"]), "diff text");
  assert.equal(pass.passed, true); assert.equal(fail.passed, false); assert.equal(fail.threshold, 0.5);
  await assert.rejects(runGate(parseArgs(["-c", "x", "--url", url]), "   "), /empty state/);
  assert.throws(() => parseArgs([]), /criteria required/);
  assert.throws(() => parseArgs(["-c", "x", "-p", "7"]), /threshold/);
  srv.close();
});

test("gate: oversized state is truncated to the model limit and flagged", async () => {
  const { runGate, MAX_STATE_CHARS } = await import("../src/gate.mjs");
  let sent;
  const client = { evaluate: async (req) => { sent = req; return { model: "m", answers: { gate: { type: "noul", noul: 0.9 } }, elapsedMs: 1 }; } };
  const r = await runGate({ criteria: "c", threshold: 0.7 }, "x".repeat(MAX_STATE_CHARS + 500), client);
  assert.equal(sent.state.content.length, MAX_STATE_CHARS);
  assert.equal(sent.state.truncated, true);
  assert.equal(r.truncated, true);
  assert.equal(r.passed, true);
});

test("gate: server token-limit 400 shrinks content and retries; other errors propagate", async (t) => {
  // ~2 chars per token + 200 tokens of schema; mirrors parallel_schema.py's message.
  const tooLong = (b) => { const n = Math.ceil(b.state.content.length / 2) + 200; return n > 2048 ? `Longest prompt has ${n} tokens; limit is 2048. Nothing was truncated.` : null; };
  const { srv, seen, url } = await fakeServer(() => ({ type: "noul", noul: 0.9 }), tooLong);
  t.after(() => srv.close());
  const r = await runGate(parseArgs(["-c", "c", "--url", url]), "x".repeat(5000));
  assert.equal(r.passed, true);
  assert.equal(r.truncated, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].state.truncated, true);
  assert.ok(seen[1].state.content.length < 5000);

  const always = await fakeServer(() => ({ type: "noul", noul: 0.9 }), () => "Longest prompt has 9999 tokens; limit is 2048. Nothing was truncated.");
  t.after(() => always.srv.close());
  await assert.rejects(runGate(parseArgs(["-c", "c", "--url", always.url]), "x".repeat(5000)), /limit is 2048/);
  assert.equal(always.seen.length, 3);

  const other = await fakeServer(() => ({ type: "noul", noul: 0.9 }), () => "gate: unknown type 'x'");
  t.after(() => other.srv.close());
  await assert.rejects(runGate(parseArgs(["-c", "c", "--url", other.url]), "x".repeat(5000)), /unknown type/);
  assert.equal(other.seen.length, 1);
});

test("gate: limit phrase on a non-400 status propagates after one call", async (t) => {
  const msg = "Longest prompt has 9999 tokens; limit is 2048. Nothing was truncated.";
  const s500 = await fakeServer(() => ({ type: "noul", noul: 0.9 }), () => msg, 500);
  t.after(() => s500.srv.close());
  await assert.rejects(runGate(parseArgs(["-c", "c", "--url", s500.url]), "x".repeat(5000)), / 500 Longest prompt/);
  assert.equal(s500.seen.length, 1);

  const partial = await fakeServer(() => ({ type: "noul", noul: 0.9 }), () => "Longest prompt has 9999 tokens; limit is 2048");
  t.after(() => partial.srv.close());
  await assert.rejects(runGate(parseArgs(["-c", "c", "--url", partial.url]), "x".repeat(5000)), /limit is 2048/);
  assert.equal(partial.seen.length, 1);
});

test("gate: huge reported token count never sends a zero-length retry", async (t) => {
  const huge = await fakeServer(() => ({ type: "noul", noul: 0.9 }), () => "Longest prompt has 99999999 tokens; limit is 2048. Nothing was truncated.");
  t.after(() => huge.srv.close());
  await assert.rejects(runGate(parseArgs(["-c", "c", "--url", huge.url]), "x".repeat(5000)), /99999999 tokens/);
  assert.equal(huge.seen.length, 1);
  for (const b of huge.seen) assert.ok(b.state.content.length >= 1);

  const sent = [];
  const client = { evaluate: async (req) => { sent.push(req.state.content.length); throw new Error("POST /v1/evaluate: 400 Longest prompt has 30000 tokens; limit is 2048. Nothing was truncated."); } };
  await assert.rejects(runGate({ criteria: "c", threshold: 0.7 }, "abc", client), /30000 tokens/);
  assert.deepEqual(sent, [3]);
});

test("resolveUrl: AUTONOXIS_URL takes precedence over the NIMBLE_URL alias", () => {
  process.env.NIMBLE_URL = "http://nimble:1";
  process.env.AUTONOXIS_URL = "http://autonoxis:2/";
  assert.equal(resolveUrl(), "http://autonoxis:2");
  delete process.env.AUTONOXIS_URL;
  assert.equal(resolveUrl(), "http://nimble:1");
  delete process.env.NIMBLE_URL;
  assert.equal(resolveUrl(), "http://127.0.0.1:8765");
});

test("conductor: sends exactly one `label` question with state {packet} and the trained criteria", async (t) => {
  const { conductor } = await import("../src/conductor.mjs");
  const trained = JSON.parse(readFileSync(new URL("../src/conductor-questions.json", import.meta.url), "utf8"));
  const { srv, seen, url } = await fakeServer((_id, q) => ({ type: "choice", choice: Object.keys(q.criteria).at(-1), confidence: 0.9, probabilities: {} }));
  t.after(() => srv.close());
  for (const track of ["decision", "manager"]) {
    await conductor(new AutonoxisClient(url), { track, packet: "lane L1: tests red" });
    const body = seen.at(-1);
    assert.deepEqual(Object.keys(body.questions), ["label"]);
    assert.deepEqual(body.state, { packet: "lane L1: tests red" });
    assert.deepEqual(body.questions.label, trained[track]);
  }
  await assert.rejects(conductor(new AutonoxisClient(url), { track: "nope", packet: "p" }), /track/);
});

test("conductor: act only when confidence >= 0.8, else escalate", async (t) => {
  const { conductor } = await import("../src/conductor.mjs");
  let conf = 0.8;
  const { srv, url } = await fakeServer(() => ({ type: "choice", choice: "ACCEPT", confidence: conf, probabilities: { ACCEPT: 0.9, VERIFY: 0.1 } }));
  t.after(() => srv.close());
  const c = new AutonoxisClient(url);
  const hi = await conductor(c, { track: "manager", packet: "p" });
  assert.equal(hi.label, "ACCEPT"); assert.equal(hi.confidence, 0.8); assert.equal(hi.act, true);
  assert.deepEqual(hi.probabilities, { ACCEPT: 0.9, VERIFY: 0.1 });
  conf = 0.79;
  const lo = await conductor(c, { track: "manager", packet: "p" });
  assert.equal(lo.act, "escalate");
});

test("conductor: choice outside the track's criteria throws; valid choice unchanged", async (t) => {
  const { conductor } = await import("../src/conductor.mjs");
  let choice = "ACCEPT";
  const { srv, url } = await fakeServer(() => ({ type: "choice", choice, confidence: 0.99, probabilities: { ACCEPT: 0.99 } }));
  t.after(() => srv.close());
  const c = new AutonoxisClient(url);
  await assert.rejects(conductor(c, { track: "decision", packet: "p" }), /ACCEPT.*decision/);
  for (const bad of ["MAYBE", "toString", 1, undefined]) {
    choice = bad;
    await assert.rejects(conductor(c, { track: "decision", packet: "p" }), /choice/);
  }
  choice = "ACCEPT";
  const ok = await conductor(c, { track: "manager", packet: "p" });
  assert.equal(ok.label, "ACCEPT"); assert.equal(ok.act, true);
});
