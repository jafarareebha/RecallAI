const path = require("path");
const fs = require("fs");
const express = require("express");
const cfg = require("./src/config");
const { open } = require("./src/db");
const { Memory } = require("./src/memory");
const { Groq, GroqError } = require("./src/groq");
const H = require("./src/hindsight");

const MAX_MESSAGE = 8000;

function createApp({ config = cfg, log = console, db } = {}) {
  const database = db || open(config.memory.dbPath);
  const memory = new Memory(database, config.memory);
  const groq = new Groq(config.groq, log);
  const deps = { memory, groq, cfg: config.memory, log };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (config.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Recall-User");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: "200kb" }));

  // tiny in-memory rate limiter (per IP)
  const hits = new Map();
  const limiter = (req, res, next) => {
    const now = Date.now(), k = req.ip, arr = (hits.get(k) || []).filter(t => now - t < 60000);
    if (arr.length >= config.rateLimitPerMin) return res.status(429).json({ error: "You're sending messages too quickly. Please wait a moment." });
    arr.push(now); hits.set(k, arr);
    if (hits.size > 5000) for (const [key, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(key);
    next();
  };

  const userOf = req => String(req.get("x-recall-user") || "anonymous").trim().toLowerCase().slice(0, 200) || "anonymous";

  app.get("/api/health", (req, res) => res.json({ ok: true }));   // deliberately exposes no config

  app.get("/api/memory/stats", (req, res) => {
    try { res.json({ enabled: config.memory.enabled, count: memory.count(userOf(req)) }); }
    catch (e) { log.error("[api] stats failed:", e.message); res.status(500).json({ error: "Something went wrong." }); }
  });
  app.delete("/api/memory", (req, res) => {
    try { res.json({ deleted: memory.clear(userOf(req)) }); }
    catch (e) { log.error("[api] clear failed:", e.message); res.status(500).json({ error: "Something went wrong." }); }
  });

  app.post("/api/chat", limiter, async (req, res) => {
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "Please type a message." });
    if (message.length > MAX_MESSAGE) return res.status(413).json({ error: "That message is too long. Please shorten it." });
    if (!groq.available) {
      log.error("[chat] GROQ_API_KEY is not configured on the server (set it in .env).");
      return res.status(503).json({ error: "The assistant is temporarily unavailable. Please try again later." });
    }

    const userId = userOf(req);
    const sessionId = typeof body.session_id === "string" ? body.session_id.slice(0, 80) : "";
    const wantStream = body.stream === true;

    const ctl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctl.abort(); });

    // 1-4: analyse, (maybe) retrieve the single most relevant memory, build context
    const { q, retrieved } = H.prepare(deps, { userId, message, useMemory: body.use_memory !== false });
    const top = retrieved[0] || null;
    const meta = { memory_used: !!top, memories_retrieved: top ? 1 : 0 };
    if (top) { meta.memory_relation = top.relation; meta.memory_relevance = top.pct; }
    // "RELATED MEMORY · NN% RELEVANCE / title — date / Connection" is built here from the real score, then Groq
    // continues with "Previous solution:" and "Current solution:". Empty when no memory is relevant.
    const header = top ? H.memoryHeader(top) : "";
    const messages = H.buildMessages(H.buildSystemPrompt(retrieved), body.history, message);

    let answer = "";
    try {
      if (wantStream) {
        res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        const send = o => res.write("data: " + JSON.stringify(o) + "\n\n");
        send({ type: "meta", ...meta });
        try {
          let headerSent = !header;
          for await (const chunk of groq.stream(messages, { signal: ctl.signal })) {
            if (!headerSent) { send({ type: "delta", text: header }); headerSent = true; }   // only once Groq has started answering
            answer += chunk; send({ type: "delta", text: chunk });
          }
          if (!answer.trim()) throw new GroqError("empty completion");
          send({ type: "done" });
        } catch (e) {
          if (ctl.signal.aborted) return;
          log.error("[chat] Groq failed:", e.message);
          send({ type: "error", message: e instanceof GroqError ? e.userMessage : "The assistant ran into a problem. Please try again." });
          answer = "";
        }
        res.end();
      } else {
        for await (const chunk of groq.stream(messages, { signal: ctl.signal })) answer += chunk;
        if (!answer.trim()) throw new GroqError("empty completion");
        res.json({ answer: header + answer, ...meta });
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      log.error("[chat] Groq failed:", e.message);
      if (!res.headersSent) res.status(e instanceof GroqError && e.status === 429 ? 429 : 502).json({ error: e instanceof GroqError ? e.userMessage : "The assistant ran into a problem. Please try again." });
      return;
    }

    // 8: store the interaction after the reply has been delivered (`answer` is Groq's text only, never the header)
    if (answer.trim()) {
      const result = await H.store(deps, { userId, sessionId, message, answer, q, retrieved });
      app.emit("memory-stored", result);
    }
  });

  const pub = path.join(__dirname, "public");
  app.use(express.static(pub, { dotfiles: "ignore" }));
  app.get("/", (req, res) => res.redirect(fs.existsSync(path.join(pub, "index.html")) ? "/index.html" : "/chat.html"));

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
  app.use((err, req, res, next) => {   // never leak stack traces
    log.error("[server] error:", err && err.message);
    if (res.headersSent) return res.end();
    res.status(err && err.type === "entity.parse.failed" ? 400 : 500).json({ error: err && err.type === "entity.parse.failed" ? "Invalid request." : "Something went wrong." });
  });

  app.locals.memory = memory; app.locals.groq = groq;
  return app;
}

if (require.main === module) {
  const app = createApp();
  if (!cfg.groq.apiKey) console.warn("\n[startup] GROQ_API_KEY is not set. Add it to .env (server side) and restart — chat requests will fail until then.\n");
  app.listen(cfg.port, () => console.log(`Recall running at http://localhost:${cfg.port}  (model: ${cfg.groq.model}, memory: ${cfg.memory.enabled ? "on" : "off"})`));
}
module.exports = { createApp };
