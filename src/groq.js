/* Minimal Groq (OpenAI-compatible) client using built-in fetch. Runs on the backend only. */

class GroqError extends Error {
  constructor(message, { status = 0, code = "", retryable = false, modelProblem = false, retryAfterMs = 0 } = {}) {
    super(message);
    Object.assign(this, { status, code, retryable, modelProblem, retryAfterMs });
  }
  /* Safe text for end users: never contains keys, URLs or provider internals. */
  get userMessage() {
    if (this.name === "GroqTimeout") return "The assistant took too long to respond. Please try again.";
    if (this.status === 429) return "The assistant is busy right now. Please try again in a moment.";
    if (this.status === 400 && this.code === "context_length_exceeded") return "That conversation is too long for the assistant. Start a new chat and try again.";
    return "The assistant is temporarily unavailable. Please try again shortly.";
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const uniq = a => [...new Set(a.filter(Boolean))];
const isGptOss = m => /gpt-oss/i.test(m);

function linkAbort(parent, ms) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const onAbort = () => ctl.abort();
  if (parent) { if (parent.aborted) ctl.abort(); else parent.addEventListener("abort", onAbort, { once: true }); }
  return { signal: ctl.signal, wasTimeout: () => timedOut, done() { clearTimeout(timer); parent && parent.removeEventListener("abort", onAbort); } };
}

async function toError(res) {
  let body = null, text = "";
  try { text = await res.text(); body = JSON.parse(text); } catch { /* not json */ }
  const e = (body && body.error) || {};
  const msg = e.message || text.slice(0, 200) || `HTTP ${res.status}`;
  const code = e.code || e.type || "";
  const modelProblem = res.status === 404 || /model_not_found|model_decommissioned|model_terminated/i.test(code) ||
    (res.status === 400 && /decommission|no longer supported|has been deprecated|does not exist|model.*not found/i.test(msg));
  const ra = parseFloat(res.headers.get("retry-after"));
  return new GroqError(msg, { status: res.status, code, modelProblem, retryable: res.status === 429 || res.status >= 500, retryAfterMs: Number.isFinite(ra) ? Math.min(ra * 1000, 5000) : 0 });
}

class Groq {
  constructor(cfg, log = console) { this.cfg = cfg; this.log = log; this.activeModel = cfg.model; }
  get available() { return !!this.cfg.apiKey; }
  get model() { return this.activeModel; }

  async _request(body, signal, { attempts = 3, timeoutMs = this.cfg.timeoutMs } = {}) {
    if (!this.available) throw new GroqError("GROQ_API_KEY is not configured on the server", { status: 503 });
    const models = uniq([this.activeModel, this.cfg.model, this.cfg.fallbackModel]);
    let lastErr = null;
    for (const model of models) {
      let useOptional = true;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const link = linkAbort(signal, timeoutMs);
        try {
          const payload = { ...body, model };
          if (useOptional && isGptOss(model)) payload.reasoning_effort = "low";
          const res = await fetch(this.cfg.baseUrl + "/chat/completions", {
            method: "POST", signal: link.signal,
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.cfg.apiKey },
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            if (model !== this.activeModel) this.log.warn(`[groq] switched to model "${model}"`);
            this.activeModel = model;
            return { res, link };
          }
          link.done();
          const err = await toError(res);
          lastErr = err;
          if (err.modelProblem) { this.log.warn(`[groq] model "${model}" unavailable: ${err.message}`); break; }
          if (err.status === 400 && useOptional && isGptOss(model) && /reasoning|unsupported|unknown|not support/i.test(err.message)) { useOptional = false; attempt--; continue; }
          if (err.retryable && attempt < attempts - 1) { await sleep(err.retryAfterMs || 700 * (attempt + 1)); continue; }
          throw err;
        } catch (e) {
          link.done();
          if (e instanceof GroqError) throw e;
          if (e.name === "AbortError") {
            if (link.wasTimeout()) { const t = new GroqError("Groq request timed out"); t.name = "GroqTimeout"; throw t; }
            throw e; // client went away
          }
          lastErr = new GroqError("Network error contacting Groq: " + e.message, { retryable: true });
          if (attempt < attempts - 1) { await sleep(700 * (attempt + 1)); continue; }
          throw lastErr;
        }
      }
    }
    throw lastErr || new GroqError("No Groq model available");
  }

  /* Async generator of answer text chunks (reasoning tokens are never forwarded). */
  async *stream(messages, { signal, temperature = 0.5 } = {}) {
    const { res, link } = await this._request({ messages, stream: true, temperature, max_completion_tokens: 4096 }, signal);
    try {
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const ln of lines) {
          if (!ln.startsWith("data:")) continue;
          const p = ln.slice(5).trim();
          if (!p || p === "[DONE]") continue;
          let j; try { j = JSON.parse(p); } catch { continue; }
          if (j.error) throw new GroqError(j.error.message || "stream error", { status: 500 });
          const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (t) yield t;
        }
      }
    } catch (e) {
      if (e.name === "AbortError" && link.wasTimeout()) { const t = new GroqError("Groq stream timed out"); t.name = "GroqTimeout"; throw t; }
      throw e;
    } finally { link.done(); }
  }

  /* One-shot JSON completion (used for structured error-memory extraction). */
  async json(messages, { signal, attempts = 1, timeoutMs = 25000 } = {}) {
    let body = { messages, stream: false, temperature: 0, max_completion_tokens: 1200, response_format: { type: "json_object" } };
    let out;
    const opts = { attempts, timeoutMs };
    try { out = await this._request(body, signal, opts); }
    catch (e) {
      if (e instanceof GroqError && e.status === 400) { delete body.response_format; out = await this._request(body, signal, opts); }
      else throw e;
    }
    try {
      const data = await out.res.json();
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
      const m = text.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } finally { out.link.done(); }
  }
}

module.exports = { Groq, GroqError };
