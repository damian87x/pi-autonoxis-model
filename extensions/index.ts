import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutonoxisClient } from "../src/client.mjs";
import { conductor } from "../src/conductor.mjs";

const QUESTION_TYPES = ["choice", "noul", "score"] as const;

export default function (pi: ExtensionAPI) {
  const client = new AutonoxisClient();

  pi.registerTool({
    name: "autonoxis_evaluate",
    label: "Autonoxis Evaluate",
    description:
      "Fast typed System One decision from the local autonoxis server (Polaris 1 / polaris-1, Jev-compatible): choice, noul (P(true)), or score over a state. No text generation; returns probabilities and confidence.",
    promptSnippet: "Typed local decision: classify, gate, route, or score a state",
    promptGuidelines: [
      "Use autonoxis_evaluate for one-second judgments code will branch on (routing, pass/fail, risk), not for reasoning or explanations.",
      "Put the content in `state` as an object and refer to its fields in instructions with backticks.",
      "Act on choice/score answers only when confidence is high enough for the stakes; otherwise escalate.",
      "For conductor decisions use autonoxis_conductor with track decision (STOP/ASK/DISPATCH) or manager (ACCEPT/VERIFY/REJECT/REOPEN/ESCALATE) and the lane packet as text; act only when act is true, else escalate to the human.",
    ],
    parameters: Type.Object({
      state: Type.Unknown({ description: "Text, JSON object, or array to evaluate." }),
      questions: Type.Record(
        Type.String(),
        Type.Object({
          type: Type.Union(QUESTION_TYPES.map((t) => Type.Literal(t))),
          instructions: Type.String(),
          criteria: Type.Optional(Type.Unknown({ description: "choice: {label: description}; score: [level0, level1, ...]; noul: optional {true, false}" })),
        }),
        { description: "Questions keyed by id; each is evaluated independently against the same state." }
      ),
    }),
    async execute(_id, params: any, signal) {
      const res = await client.evaluate(params, signal);
      const lines = Object.entries(res.answers).map(([id, a]: [string, any]) =>
        a.type === "noul" ? `${id}: P(true)=${a.noul}` :
        a.type === "choice" ? `${id}: ${a.choice} (confidence ${a.confidence})` :
        `${id}: score ${a.score} (confidence ${a.confidence})`);
      return { content: [{ type: "text", text: `${lines.join("\n")}\n[${res.model}, ${res.elapsedMs} ms]` }], details: res };
    },
  });

  pi.registerTool({
    name: "autonoxis_conductor",
    label: "Autonoxis Conductor",
    description:
      "Next conductor action for a lane from Polaris 1 (polaris-1), using its trained convention (one `label` question over state {packet}). act is true when confidence >= 0.8, else \"escalate\".",
    promptSnippet: "Conductor decision (decision or manager track) for a lane packet",
    parameters: Type.Object({
      track: Type.Union([Type.Literal("decision"), Type.Literal("manager")]),
      packet: Type.String({ description: "Text describing the lane state and its evidence." }),
    }),
    async execute(_id, params: any, signal) {
      const r = await conductor(client, params, signal);
      return { content: [{ type: "text", text: `${r.label} (confidence ${r.confidence}) act=${r.act}\n[${r.model}, ${r.elapsedMs} ms]` }], details: r };
    },
  });

  pi.registerCommand("autonoxis-model", {
    description: "Local autonoxis model (/autonoxis-model): status | test | url <endpoint>",
    handler: async (args: string, ctx: any) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "url" && rest[0]) {
        client.url = rest[0].replace(/\/+$/, "");
        ctx.ui.notify(`Autonoxis endpoint set to ${client.url}`, "info");
        return;
      }
      if (sub === "test") {
        try {
          const res = await client.evaluate({
            state: { message: "My payouts have failed for three days; fix it today or I cancel." },
            questions: {
              urgent: { type: "noul", instructions: "Does `message` convey urgency?" },
              team: { type: "choice", instructions: "Which team should handle `message`?", criteria: { billing: "payments, refunds", technical: "bugs, outages", other: null } },
            },
          });
          const t: any = res.answers.team;
          ctx.ui.notify(`Autonoxis test ok (${res.elapsedMs} ms): urgent=${(res.answers.urgent as any).noul}, team=${t.choice} (${t.confidence})`, "info");
        } catch (e: any) {
          ctx.ui.notify(`Autonoxis test failed: ${e?.message ?? e}`, "error");
        }
        return;
      }
      let health = "unreachable";
      try { health = (await client.health()).status; } catch { /* keep unreachable */ }
      const s = client.stats;
      ctx.ui.notify(`Autonoxis ${client.url}: ${health}\nrequests ${s.requests}, input tokens ${s.inputTokens}, last ${s.lastMs ?? "-"} ms${s.lastError ? `\nlast error: ${s.lastError}` : ""}`, "info");
    },
  });

  pi.on("session_start", async (_e, ctx) => {
    try { await client.health(); ctx.ui.setStatus("autonoxis", "autonoxis: ready"); }
    catch { ctx.ui.setStatus("autonoxis", "autonoxis: offline"); }
  });
}
