# pi-autonoxis-model

A [Pi](https://github.com/earendil-works/pi) extension that gets conductor decisions for autonomous coding
lanes from a local model, [Polaris 1](https://huggingface.co/damianborek/polaris-1) (`polaris-1`), the autonoxis decision model
(a LoRA adapter on Bespoke-Nimble-9B, itself built on Qwen3.5-9B). It runs on your own GPU and costs nothing per call.

The model does not generate text. It picks one label from a fixed set and returns a probability for each label.

## Links

- Polaris 1 model: https://huggingface.co/damianborek/polaris-1
- Vega 1 model (earlier, generative): https://huggingface.co/damianborek/vega-1
- Claude Code plugin: https://github.com/damian87x/autonoxis-model

## How it works

1. Pi (or the gate CLI) sends a lane packet, the text describing the lane's current state, to the local server.
2. The server asks the model one question for the chosen track and scores every allowed label:
   - `decision`: `STOP | ASK | DISPATCH`
   - `manager`: `ACCEPT | VERIFY | REJECT | REOPEN | ESCALATE`
3. The extension returns the top `label`, its `confidence` and all `probabilities`.
4. It acts only when `confidence >= 0.8` (`act: true`). Below that, `act` is `"escalate"` and a human
   or a stronger model decides.

Confidence is `(n * max_prob - 1) / (n - 1)` for `n` labels.

The request shape is the same as TypeSafe Jev's `/v1/systemone`, so the server also answers general
`choice` / `noul` / `score` questions.

## Install

```bash
pi install git:github.com/damian87x/pi-autonoxis-model        # for your user
pi install git:github.com/damian87x/pi-autonoxis-model -l     # for this project only (.pi/settings.json)
```

The extension is a client only. It needs the model server running locally; see
[server/README.md](server/README.md) for requirements, the adapter download and the run command.

## Usage

- Tool `autonoxis_conductor`: `{track: "decision" | "manager", packet: string}` returns `label`,
  `confidence`, `probabilities` and `act`.
- Tool `autonoxis_evaluate`: `{state, questions}` in Jev's shape returns `choice` / `noul` / `score`
  answers with probabilities and confidence.
- Command `/autonoxis-model status | test | url <endpoint>`: health check, session counters, endpoint override.
- CLI `bin/autonoxis-gate.js -c "<criterion>" [--diff | -f file | stdin] [-p 0.7] [--json]`: exits 0 on
  pass, 1 on fail, 2 on error. Works as a `pi-subagents` gate. The state is cut to 6000 characters; if the
  server still rejects the prompt as too long, the gate shrinks it and retries up to 3 times and reports
  `truncated: true`.

The model was trained on one call shape only, and `autonoxis_conductor` sends exactly that: one question
with id `label`, state `{"packet": <packet>}`, and the question text from
[src/conductor-questions.json](src/conductor-questions.json).
The decision track uses the conductor contract prompt; on real-world orchestrator packets (v9) accuracy rises from 59% to 67% with no change on v5–v8.

## Configuration

| env | default | meaning |
|---|---|---|
| `AUTONOXIS_URL` | `http://127.0.0.1:8765` | server endpoint |
| `NIMBLE_URL` | | older alias, read only when `AUTONOXIS_URL` is unset |

There is no API key. The server has no authentication and binds to loopback only.

## Accuracy

From the [model card](https://huggingface.co/damianborek/polaris-1). Gold labels are from a
frontier model (Fable 5).

- v8, 60 packets never used for training or selection: 10 seeds score **59.2 ± 0.9 / 60**, with 0 unsafe
  answers (a wrong `DISPATCH` or `ACCEPT`) in every seed. The released adapter (seed 1) scores 58/60.
- v8 is **in-distribution**: it shares scenario families and the drafting pipeline with the training
  data. It is not an out-of-distribution test.
- One of the adapter's two v8 misses is confident: `ACCEPT` predicted as `VERIFY` at confidence 0.998,
  so the 0.8 gate does not catch it. The other miss (confidence 0.66) is escalated.
- Untrained Jev (TypeSafe) also scores 60/60 on v8. This model does not beat Jev. Its advantage is that it
  runs locally at no per-call cost (about 100 ms per request on one GPU after warm-up).
- Prompts are limited to 2048 tokens, English only, and the labels follow one decision contract.

## Tests

```bash
npm test    # offline, against a fake server
```

## License

MIT for this code. The model adapter is Apache-2.0; see its model card.
