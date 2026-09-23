// HTTP client for a System One endpoint (local autonoxis server or TypeSafe Jev). No SDK, no key handling here.
export const DEFAULT_URL = "http://127.0.0.1:8765";

// AUTONOXIS_URL wins; NIMBLE_URL is kept as a legacy alias.

export function resolveUrl(override) {
  return (override ?? process.env.AUTONOXIS_URL ?? process.env.NIMBLE_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

export function choiceConfidence(probabilities) {
  const p = Object.values(probabilities);
  const k = p.length;
  if (k < 2) return 1;
  return Math.max(0, Math.min(1, (k * Math.max(...p) - 1) / (k - 1)));
}

export class AutonoxisClient {
  constructor(url, fetchImpl = globalThis.fetch) {
    this.url = resolveUrl(url);
    this.fetch = fetchImpl;
    this.stats = { requests: 0, inputTokens: 0, lastMs: null, lastError: null };
  }

  async request(method, path, body, signal) {
    const res = await this.fetch(this.url + path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`${method} ${path}: non-JSON response (${res.status})`); }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? text}`);
    return json;
  }

  health(signal) { return this.request("GET", "/health", undefined, signal); }
  models(signal) { return this.request("GET", "/v1/models", undefined, signal); }

  /** Jev-shaped request: {state, questions:{id:{type,instructions,criteria}}} -> {model, answers, usage, elapsedMs}. */
  async evaluate({ state, questions, model }, signal) {
    if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) {
      throw new Error("questions must be a non-empty object");
    }
    const t0 = Date.now();
    try {
      const out = await this.request("POST", "/v1/systemone", { state, questions, model }, signal);
      this.stats.requests += 1;
      this.stats.inputTokens += out.usage?.input_tokens ?? 0;
      this.stats.lastMs = Date.now() - t0;
      this.stats.lastError = null;
      return { ...out, elapsedMs: this.stats.lastMs };
    } catch (err) {
      this.stats.lastError = err?.message ?? String(err);
      throw err;
    }
  }
}
