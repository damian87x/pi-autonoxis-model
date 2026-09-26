# pi-autonoxis-model

A [Pi](https://github.com/earendil-works/pi) extension that gets conductor decisions for autonomous coding
lanes from a local model. The recommended model is [Polaris 3](https://huggingface.co/damianborek/polaris-3) (`polaris-3`,
HF `damianborek/polaris-3`), the autonoxis decision model (a LoRA adapter on Bespoke-Nimble-9B, itself built on
Qwen3.5-9B). It runs on your own GPU and costs nothing per call. [Polaris 2](https://huggingface.co/damianborek/polaris-2)
(`polaris-2`) still works with this version (same questions). [Polaris 1](https://huggingface.co/damianborek/polaris-1)
(`polaris-1`) still works with older versions of this extension (0.3.x).

The model does not generate text. It picks one label from a fixed set and returns a probability for each label.

## Links

- Polaris 3 model (recommended): https://huggingface.co/damianborek/polaris-3
- Polaris 2 model (previous): https://huggingface.co/damianborek/polaris-2
- Polaris 1 model (older): https://huggingface.co/damianborek/polaris-1
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
Polaris 3 (like Polaris 2) was trained with these exact questions for both tracks. Use the question file that ships with the
extension version matching your model.

## Configuration

| env | default | meaning |
|---|---|---|
| `AUTONOXIS_URL` | `http://127.0.0.1:8765` | server endpoint |
| `NIMBLE_URL` | | older alias, read only when `AUTONOXIS_URL` is unset |

There is no API key. The server has no authentication and binds to loopback only.

## Accuracy

Polaris 3 on real orchestrator packets (v9): 79.8% (75/94; Polaris 2: 77.7%, Polaris 1: 64.9%); v5–v8 all correct.

From the [Polaris 3 model card](https://huggingface.co/damianborek/polaris-3):

- v9 is 96 real orchestrator packets. Its labels are model labels, not human labels: the majority of three
  frontier models (Opus 5.5, Grok 4.7, Astra gpt-6-astra) labelling blind. The 2 packets with no majority
  are left out, so scores are over 94.
- Polaris 3 scores 75/94, Polaris 2 73/94, Polaris 1 61/94. The untrained Jev contract prompt scores
  about 74.5%.
- The 0.8 gate is only marginally better than Polaris 2: it keeps 91 of 94 v9 packets at 81.3%
  (Polaris 2: 91 at 80.2%).
- Confidence is not a guarantee: three v9 misses are unsafe (two `VERIFY` packets answered `ACCEPT`,
  one `ASK` answered `DISPATCH`), all at confidence >= 0.96, so the 0.8 gate does not catch them.
  Treat `ACCEPT` as "verify first".
- Prompts are limited to 2048 tokens, English only, and the labels follow one decision contract.

## Tests

```bash
npm test    # offline, against a fake server
```

## License

MIT for this code. The model adapter is Apache-2.0; see its model card.
