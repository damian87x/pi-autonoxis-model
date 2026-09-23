#!/usr/bin/env python3
"""autonoxis-server: Jev wire format (/v1/systemone) over a fine-tuned Nimble.

Run in a Python env with torch, transformers and peft; NIMBLE_DIR points at a clone of
github.com/bespokelabsai/nimble (default: ./nimble next to this file):
  python server/server.py --model-config nimble-model.json --adapter <dir> [--port 8765]
Any pi-jev / jev-skill client works by pointing TYPESAFE_BASE_URL at it. No auth: binds 127.0.0.1 only.
"""
import argparse, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

NIMBLE = Path(os.environ.get("NIMBLE_DIR", Path(__file__).resolve().parent / "nimble"))
sys.path.insert(0, str(NIMBLE))
import torch  # noqa: E402
from transformers import AutoTokenizer, Qwen3_5ForConditionalGeneration  # noqa: E402
from nimble.scoring.parallel_schema import prepare_prompts  # noqa: E402
from nimble.training.schema_train import candidate_logits  # noqa: E402

MODEL_NAME = "nimble-conductor"


def ser(v):
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def to_schema(qid, q):
    """Same mapping as nimble/serving/compiler.py: Jev question -> flat Nimble field."""
    t, crit = q.get("type"), q.get("criteria")
    field = {"description": ser(q.get("instructions") or qid)}
    if t == "noul":
        crit = crit or {}
        field.update(type="boolean", choices=[False, True], choice_descriptions={
            "false": ser(crit.get("false")) if crit.get("false") not in (None, "") else "no, the statement does not hold",
            "true": ser(crit.get("true")) if crit.get("true") not in (None, "") else "yes, the statement holds"})
    elif t == "choice":
        if not isinstance(crit, dict) or not 1 <= len(crit) <= 26:
            raise ValueError(f"{qid}: choice needs 1-26 criteria")
        field.update(type="enum", choices=list(crit), choice_descriptions={k: (ser(d) if d not in (None, "") else k) for k, d in crit.items()})
    elif t == "score":
        if not isinstance(crit, list) or len(crit) < 2:
            raise ValueError(f"{qid}: score needs a list of 2+ levels")
        field.update(type="enum", choices=[str(i) for i in range(len(crit))], choice_descriptions={str(i): ser(c) for i, c in enumerate(crit)})
    else:
        raise ValueError(f"{qid}: unknown type {t!r}")
    return field


def confidence(p):
    k = len(p)
    return 1.0 if k < 2 else max(0.0, min(1.0, (k * max(p) - 1) / (k - 1)))


class Engine:
    def __init__(self, model_path, adapter, max_tokens, device="cuda"):
        self.device = device
        self.lock = threading.Lock()
        self.max_tokens = max_tokens
        self.tok = AutoTokenizer.from_pretrained(adapter or model_path)
        self.tok.padding_side = "left"
        model = Qwen3_5ForConditionalGeneration.from_pretrained(model_path, dtype=torch.bfloat16, attn_implementation="sdpa").to(device)
        if adapter:
            from peft import PeftModel
            model = PeftModel.from_pretrained(model, adapter)  # unmerged, as score_adapter.py evaluates it
        model.config.use_cache = False
        self.model = model.eval()
        self.revision = json.loads(Path(adapter, "schema_config.json").read_text())["revision"] if adapter and Path(adapter, "schema_config.json").exists() else "merged"

    @torch.inference_mode()
    def answer(self, state, questions):
        schema = {qid: to_schema(qid, q) for qid, q in questions.items()}
        prepared = prepare_prompts(self.tok, ser(state), schema, self.max_tokens)
        answers, tokens = {}, 0
        with self.lock:
            for qid, choices, ids, cands in zip(prepared.names, prepared.choices, prepared.full_ids, prepared.candidate_ids):
                tokens += len(ids)
                batch = {"input_ids": torch.tensor([ids], device=self.device), "attention_mask": torch.ones(1, len(ids), dtype=torch.long, device=self.device),
                         "candidate_ids": torch.tensor([cands], device=self.device), "candidate_mask": torch.ones(1, len(cands), dtype=torch.bool, device=self.device)}
                with torch.autocast(self.device, dtype=torch.bfloat16):
                    p = candidate_logits(self.model, batch)[0].double().softmax(-1).tolist()
                q = questions[qid]
                if q["type"] == "noul":
                    answers[qid] = {"type": "noul", "noul": round(p[1], 4)}
                elif q["type"] == "choice":
                    best = max(range(len(p)), key=p.__getitem__)
                    answers[qid] = {"type": "choice", "choice": choices[best], "confidence": round(confidence(p), 4),
                                    "probabilities": {c: round(v, 4) for c, v in zip(choices, p)}}
                else:
                    answers[qid] = {"type": "score", "score": round(sum(i * v for i, v in enumerate(p)), 4), "confidence": round(confidence(p), 4),
                                    "legend": {str(i): c for i, c in enumerate(q["criteria"])}, "probabilities": {str(i): round(v, 4) for i, v in enumerate(p)}}
        return answers, tokens


def make_handler(engine):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"status": "ok", "model": MODEL_NAME})
            if self.path == "/v1/models":
                return self._send(200, {"models": [{"name": MODEL_NAME, "description": "Fine-tuned Bespoke-Nimble-9B conductor, local", "release_date": engine.revision}]})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/v1/systemone":
                return self._send(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
                qs = body.get("questions")
                if not isinstance(qs, dict) or not qs:
                    return self._send(400, {"error": "questions must be a non-empty object"})
                t0 = time.perf_counter()
                answers, tokens = engine.answer(body.get("state"), qs)
                self._send(200, {"model": MODEL_NAME, "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 0},
                                 "server_ms": round((time.perf_counter() - t0) * 1000, 1)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"error": f"{type(e).__name__}: {e}"})
    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--adapter", help="LoRA adapter dir (conductor fine-tune); omit for stock Nimble")
    ap.add_argument("--model-config", default=str(NIMBLE / ".cache" / "nimble-model.json"))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", default="cuda", help="cuda (default) or cpu for a slow smoke test")
    a = ap.parse_args()
    cfg = json.loads(Path(a.model_config).read_text())
    t0 = time.time()
    engine = Engine(cfg["model_path"], a.adapter, cfg.get("max_input_tokens", 2048), a.device)
    print(f"loaded in {time.time() - t0:.1f}s; adapter={a.adapter or 'none'}", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(engine))
    print(f"listening on http://127.0.0.1:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
