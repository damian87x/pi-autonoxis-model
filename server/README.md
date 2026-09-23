# autonoxis server

A small HTTP server that loads [Bespoke-Nimble-9B](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B)
with the [Polaris 1](https://huggingface.co/damianborek/polaris-1) (`polaris-1`) LoRA adapter
(unmerged) and answers typed questions in the Jev wire format (`POST /v1/systemone`). The Pi extension in
this repo is its client.

## Requirements

- An NVIDIA GPU with CUDA and room for a 9B model in bf16 (about 20 GB). `--device cpu` works for a slow smoke test.
- Python 3.12 with `torch` (CUDA build), `transformers` (a version with Qwen3.5 support, tested with 5.17),
  `peft` (tested with 0.21) and `huggingface_hub`.
- A clone of [github.com/bespokelabsai/nimble](https://github.com/bespokelabsai/nimble). The server imports
  its prompt builder and scorer. Point `NIMBLE_DIR` at the clone, or put it at `server/nimble`.

```bash
git clone https://github.com/bespokelabsai/nimble server/nimble   # or: export NIMBLE_DIR=/path/to/nimble
pip install torch transformers peft huggingface_hub
```

## Model config

`--model-config` is a JSON file with the base model location and the prompt limit:

```json
{"model_path": "bespokelabs/Bespoke-Nimble-9B", "max_input_tokens": 2048}
```

`model_path` is either the Hugging Face id (downloaded on first start) or a local directory with the
downloaded model. The adapter was trained on revision `594dfdcfb6f94e3d0c0db7535180d3c71689169a`; to pin it,
download that revision and use the local directory:

```bash
hf download bespokelabs/Bespoke-Nimble-9B --revision 594dfdcfb6f94e3d0c0db7535180d3c71689169a --local-dir base
```

## Adapter

```bash
hf download damianborek/polaris-1 --local-dir adapter
```

## Run

```bash
echo '{"model_path": "base", "max_input_tokens": 2048}' > nimble-model.json
python server/server.py --model-config nimble-model.json --adapter adapter --port 8765
```

It prints `listening on http://127.0.0.1:8765` once the model is loaded. Omit `--adapter` to serve stock Nimble.

Endpoints: `GET /health`, `GET /v1/models`, `POST /v1/systemone` with `{"state": ..., "questions": {...}}`.
The reported model name comes from the adapter's `autonoxis.json` `name`, else `--name`, else `unknown`.

## Security

The server binds to `127.0.0.1` only and has **no authentication**. Do not expose it on a network interface
or put it behind a public proxy.
