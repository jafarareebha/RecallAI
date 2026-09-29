/* End-to-end tests: real Express app + real SQLite + mock Groq. Run with `npm test`. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const mock = require("./mock-groq");
const { createApp } = require("../server");
const { open } = require("../src/db");
const C = require("../src/classify");
const H = require("../src/hindsight");

const FAKE_KEY = "gsk_TESTKEY_1234567890abcdef";
const silent = { log() {}, warn() {}, error() {} };
let passed = 0, failed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed++; results.push("  ✓ " + name); }
  catch (e) { failed++; results.push("  ✗ " + name + "\n      " + (e.message || e).split("\n").join("\n      ")); }
}

async function boot(over = {}) {
  const m = await mock.start();
  const config = {
    port: 0, corsOrigin: "", rateLimitPerMin: 1000,
    groq: { apiKey: FAKE_KEY, model: "openai/gpt-oss-120b", fallbackModel: "openai/gpt-oss-20b", baseUrl: m.url, timeoutMs: 10000, ...(over.groq || {}) },
    memory: { enabled: true, threshold: 0.65, dupThreshold: 0.88, llmExtraction: false, dbPath: ":memory:", ...(over.memory || {}) }
  };
  const app = createApp({ config, log: silent, db: open(":memory:") });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const stored = [];
  app.on("memory-stored", r => stored.push(r));

  async function chat(message, { user = "test@example.com", session = "s1", stream = false, history = [], use_memory } = {}) {
    const before = stored.length;
    const res = await fetch(base + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", "x-recall-user": user },
      body: JSON.stringify({ message, session_id: session, stream, history, use_memory })
    });
    let out;
    if (stream && res.ok) {
      out = { status: res.status, events: [], text: "", raw: "" };
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
      out.raw = buf;
      for (const ln of buf.split("\n")) if (ln.startsWith("data:")) { const e = JSON.parse(ln.slice(5)); out.events.push(e); if (e.type === "delta") out.text += e.text; }
    } else { const j = await res.json(); out = { status: res.status, ...j, api: JSON.stringify(j) }; }
    if (stream) out.api = out.raw || "";
    // wait for the after-reply memory step
    if (res.ok && !(out.events || []).some(e => e.type === "error")) for (let i = 0; i < 500 && stored.length === before; i++) await new Promise(r => setTimeout(r, 10));
    out.store = stored[stored.length - 1];
    out.lastReq = m.state.requests.filter(r => !r.isExtract).slice(-1)[0];
    return out;
  }
  const rows = (user = "test@example.com") => app.locals.memory.rows(user);
  return { m, app, srv, base, chat, rows, stored, close: () => { srv.close(); m.server.close(); } };
}

(async () => {
  /* =============== Main scenarios A–F =============== */
  const S = await boot();
  const memCount = () => S.rows().length;

  await t("A  greeting: normal reply, no memory retrieval, nothing stored", async () => {
    const r = await S.chat("Hi");
    assert.strictEqual(r.status, 200);
    assert.ok(r.answer.length > 0);
    assert.strictEqual(r.memory_used, false);
    assert.strictEqual(r.memories_retrieved, 0);
    assert.ok(!/Relevant memory:/.test(r.lastReq.sys));
    assert.ok(!/RELATED MEMORY|Previous solution/.test(r.answer), "no memory section for a greeting");
    assert.strictEqual(memCount(), 0);
    for (const g of ["Hello!", "Thanks", "okay", "Good morning", "How are you?"]) { const x = await S.chat(g); assert.strictEqual(x.memory_used, false, g); }
    assert.strictEqual(memCount(), 0);
  });

  await t("B  new question with empty memory: answered normally by Groq, then stored as knowledge", async () => {
    const r = await S.chat("What is Docker?");
    assert.strictEqual(r.status, 200);
    assert.match(r.answer, /Docker is a platform/);
    assert.strictEqual(r.memory_used, false);
    assert.strictEqual(memCount(), 1);
    assert.strictEqual(S.rows()[0].category, "knowledge");
  });

  await t("C  debugging statement creates a structured incident memory", async () => {
    const r = await S.chat("My Django deployment failed because I forgot to configure DATABASE_URL.");
    assert.strictEqual(r.store.action, "stored");
    const m = S.rows().find(x => /DATABASE_URL/.test(x.user_message));
    assert.strictEqual(m.category, "incident");
    assert.match(m.cause, /forgot to configure DATABASE_URL/i);
    assert.match(m.solution, /Add DATABASE_URL/);
    assert.ok(JSON.parse(m.technologies).includes("django"));
    assert.strictEqual(m.status, "open");
  });

  await t("D  similar question retrieves the deployment memory and injects it into the Groq prompt", async () => {
    const r = await S.chat("Why is my Django deployment failing again?");
    assert.strictEqual(r.memory_used, true);
    assert.ok(r.memories_retrieved >= 1);
    assert.strictEqual(r.memories_retrieved, 1, "exactly one memory");
    assert.match(r.lastReq.sys, /Relevant memory:/);
    assert.match(r.lastReq.sys, /DATABASE_URL/);
    assert.match(r.lastReq.sys, /relation=similar_issue/);
    assert.match(r.lastReq.sys, /never invent history/i);
    assert.strictEqual(r.lastReq.body.messages.at(-1).content, "Why is my Django deployment failing again?");
    assert.deepStrictEqual(Object.keys(JSON.parse(r.api)).sort(), ["answer", "memories_retrieved", "memory_relation", "memory_relevance", "memory_used"], "response exposes only answer + memory indicator");
  });

  await t("E  unrelated question ignores Django memory", async () => {
    const r = await S.chat("Explain binary search.");
    assert.strictEqual(r.memory_used, false);
    assert.ok(!/Relevant memory:/.test(r.lastReq.sys));
    assert.ok(!/Django|DATABASE_URL/.test(r.lastReq.sys));
    assert.match(r.answer, /Binary search/);
    assert.ok(!/RELATED MEMORY|Connection:|Previous solution|No relevant memory/i.test(r.answer), "no memory section, no 'no memory found'");
  });

  await t("8  paraphrased deploy question retrieves the earlier deploy memory", async () => {
    await S.chat("How do I deploy Django on Render?");
    const r = await S.chat("I want to deploy my Django project on Render.");
    assert.strictEqual(r.memory_used, true);
    assert.match(r.lastReq.sys, /How do I deploy Django on Render\?/);
  });

  await t("F  repeated identical question does not create duplicate memories", async () => {
    const before = memCount();
    for (let i = 0; i < 5; i++) await S.chat("What is Docker?");
    assert.strictEqual(memCount(), before);
    const d = S.rows().find(x => x.user_message === "What is Docker?");
    assert.ok(d.occurrences >= 6, "occurrences=" + d.occurrences);
    // near-duplicate wording
    await S.chat("what is docker");
    assert.strictEqual(memCount(), before);
  });

  await t("F2 the same incident again is recorded as a recurrence, not a new row", async () => {
    const before = memCount();
    await S.chat("Why is my Django deployment failing again?");
    assert.strictEqual(memCount(), before);
  });

  await t("threshold is configurable (0.9 hides a 0.72 match, 0.5 shows it)", async () => {
    const q = "My Django deployment is failing because the database connection is being refused.";
    const strict = await boot({ memory: { threshold: 0.9 } });
    await strict.chat("My Django deployment failed because I forgot to configure DATABASE_URL.");
    const below = await strict.chat(q);
    assert.strictEqual(below.memory_used, false);
    assert.ok(!/RELATED MEMORY|Previous solution|Connection:|no relevant memory/i.test(below.answer), "below threshold => plain answer");
    assert.ok(!/Relevant memory:/.test(below.lastReq.sys));
    strict.close();
    const lax = await boot({ memory: { threshold: 0.5 } });
    await lax.chat("My Django deployment failed because I forgot to configure DATABASE_URL.");
    assert.strictEqual((await lax.chat(q)).memory_used, true);
    lax.close();
  });

  await t("use_memory=false disables retrieval", async () => {
    const r = await S.chat("Why is my Django deployment failing again?", { use_memory: false });
    assert.strictEqual(r.memory_used, false);
  });

  await t("memories are private per user", async () => {
    const r = await S.chat("Why is my Django deployment failing again?", { user: "someone.else@example.com", session: "x" });
    assert.strictEqual(r.memory_used, false);
  });

  /* =============== Top-1 memory + response structure =============== */
  const U = "test@example.com";
  await t("TOP1  several memories qualify, only the single highest-scoring one is used", async () => {
    const mem = S.app.locals.memory;
    const msg = "Why is my Django deployment failing on Render?";
    const best = mem.search(U, C.analyze(msg), { threshold: 0 });
    assert.strictEqual(best.length, 1, "search never returns more than one memory");
    const second = mem.search(U, C.analyze(msg), { threshold: 0, excludeIds: [best[0].row.id] });
    assert.ok(second.length === 1 && second[0].score <= best[0].score, "the returned one really is the best-scoring");
    const r = await S.chat(msg);
    assert.strictEqual(r.memory_used, true);
    assert.strictEqual(r.memories_retrieved, 1);
    assert.strictEqual((r.lastReq.sys.match(/\[Memory\]/g) || []).length, 1, "exactly one memory in the Groq prompt");
    assert.strictEqual((r.answer.match(/RELATED MEMORY/g) || []).length, 1, "exactly one memory section in the reply");
    assert.ok(!/relevant responses|Relevant memories|Related incidents|Memory 2|Incident [AB]/i.test(r.answer), "no lists of memories/incidents");
    assert.ok(!/Memory 2|\[Memory 1\]/.test(r.lastReq.sys));
  });

  await t("PCT   displayed relevance is the real retrieval score, and the reply has the exact structure", async () => {
    const msg = "Why is my Django deployment failing again?";
    const expected = S.app.locals.memory.search(U, C.analyze(msg))[0];
    const pct = Math.round(expected.score * 100);
    const r = await S.chat(msg);
    assert.strictEqual(r.memory_relevance, pct);
    assert.ok(r.answer.startsWith(`RELATED MEMORY · ${pct}% RELEVANCE\n\n`), r.answer.slice(0, 60));
    assert.match(r.answer, /^RELATED MEMORY · \d+% RELEVANCE\n\n[^\n]+ — [A-Z][a-z]{2} \d{1,2}, \d{4}\n\nConnection: [^\n]+\n\nPrevious solution: [^\n]+\n\nCurrent solution: /);
    assert.ok(r.answer.startsWith(H.memoryHeader(expected)), "header is built from the top-ranked memory (title, date, connection)");
    assert.strictEqual(r.answer.split("\n\n")[1].split(" — ")[0], require("../src/prompt").titleOf(expected.row));
    assert.match(r.answer, /\nConnection: (?:You encountered this issue previously|This looks similar to an issue you encountered previously)\.\n/);
    // brief summary of the old case, not a dump of the old conversation
    const prev = r.answer.split("Previous solution:")[1].split("Current solution:")[0];
    assert.ok(prev.length < 400, "previous solution is brief (" + prev.length + ")");
    assert.ok(!/Explain|Here is a helpful answer/.test(prev));
  });

  await t("PROMPT solving the current problem comes first; old fix only when applicable", async () => {
    const r = await S.chat("Why is my Django deployment failing again?");
    const sys = r.lastReq.sys;
    assert.match(sys, /Solve the current problem independently/);
    assert.match(sys, /NOT applicable, do not force it/);
    assert.match(sys, /Never list several memories/);
    assert.match(sys, /exactly this structure/);
    assert.strictEqual(H.buildSystemPrompt([]), require("../src/prompt").BASE_PROMPT, "no memory => no memory instructions at all");
  });

  await t("STORE the RELATED MEMORY header and Previous/Current solution framing are never stored", async () => {
    assert.ok(S.rows().length > 0);
    for (const row of S.rows()) assert.ok(!/RELATED MEMORY|Previous solution:|Current solution:/.test(row.assistant_response), row.assistant_response.slice(0, 80));
    assert.strictEqual(H.stripMemoryFraming("Previous solution: a\n\nCurrent solution: do b"), "do b");
    assert.strictEqual(H.stripMemoryFraming("plain answer"), "plain answer");
  });

  await t("STREAM the header arrives as the first text, then the sections", async () => {
    const st = await S.chat("Why is my Django deployment failing again?", { stream: true });
    assert.strictEqual(st.events[0].type, "meta");
    assert.strictEqual(st.events[0].memories_retrieved, 1);
    assert.ok(Number.isInteger(st.events[0].memory_relevance));
    assert.match(st.text, /^RELATED MEMORY · \d+% RELEVANCE\n\n/);
    assert.match(st.text, /Previous solution:[\s\S]*Current solution:/);
    const plain = await S.chat("Tell me about Terraform modules", { stream: true });
    assert.strictEqual(plain.events[0].memory_used, false);
    assert.ok(!/RELATED MEMORY|Previous solution/.test(plain.text));
  });

  await t("NONE  unrelated 'What is Vercel?' style question: normal answer, no memory section", async () => {
    const r = await S.chat("What is Vercel?");
    assert.strictEqual(r.memory_used, false);
    assert.ok(!/RELATED MEMORY|Connection:|Previous solution|Current solution|no relevant memory/i.test(r.answer));
  });

  S.close();

  /* =============== Error / debugging memory =============== */
  const E = await boot();
  await t("ERR same error: identical error text -> same_error, prior cause/solution supplied", async () => {
    const first = await E.chat("I get ModuleNotFoundError: No module named 'django' when running my Django project locally", { session: "d1" });
    assert.strictEqual(first.store.action, "stored");
    const m = E.rows()[0];
    assert.strictEqual(m.category, "debugging");
    assert.strictEqual(m.exception_type, "ModuleNotFoundError");
    assert.match(m.error_text, /^ModuleNotFoundError: No module named 'django'$/);
    assert.match(m.cause, /virtual environment was not activated/i);
    assert.match(m.solution, /Activate your virtual environment/i);
    const r = await E.chat("ModuleNotFoundError: No module named 'django'", { session: "d2" });
    assert.strictEqual(r.memory_used, true);
    assert.match(r.lastReq.sys, /relation=same_error/);
    assert.match(r.lastReq.sys, /virtual environment was not activated/i);
    assert.match(r.answer, /^RELATED MEMORY · \d+% RELEVANCE\n\n.+ — [A-Z][a-z]{2} \d{1,2}, \d{4}\n\nConnection: You encountered this issue previously\.\n\nPrevious solution:/);
    assert.strictEqual(E.rows().length, 1, "recurrence should not add a row");
    assert.strictEqual(E.rows()[0].occurrences, 2);
  });

  await t("ERR similar error: differently worded -> similar_error", async () => {
    const r = await E.chat("Python can't find the Django module in my environment.", { session: "d3" });
    assert.strictEqual(r.memory_used, true);
    assert.match(r.lastReq.sys, /relation=similar_error/);
    assert.match(r.lastReq.sys, /Cause: .*virtual environment/i);
    assert.match(r.answer, /\nConnection: This looks similar to an issue you encountered previously\.\n/);
    const r2 = await E.chat("I'm getting ModuleNotFoundError for Django again.", { session: "d4" });
    assert.match(r2.lastReq.sys, /relation=(similar|same)_error/);
  });

  await t("ERR related-but-different: DB connection refused vs earlier DATABASE_URL incident -> related_issue", async () => {
    await E.chat("My Django deployment failed because I forgot to configure DATABASE_URL.", { session: "d5" });
    const r = await E.chat("My Django deployment is failing because the database connection is being refused.", { session: "d6" });
    assert.strictEqual(r.memory_used, true);
    assert.match(r.lastReq.sys, /relation=related_issue/);
    assert.match(r.lastReq.sys, /DATABASE_URL/);
    assert.match(r.lastReq.sys, /do NOT assume the old root cause/i);
    assert.match(r.answer, /\nConnection: This is related to a previous issue involving the same system\.\n/);
    assert.ok(!/identical|You encountered this issue previously/.test(r.answer.split("Previous solution:")[0]), "a related-but-different error is not called identical");
    assert.ok(!/relation=(same|similar)_error/.test(r.lastReq.sys));
  });

  await t("ERR unrelated: Java NPE ignores Django memories entirely", async () => {
    const r = await E.chat("Java NullPointerException in my billing application.", { session: "d7" });
    assert.strictEqual(r.memory_used, false);
    assert.ok(!/Django|DATABASE_URL|Relevant memory:/.test(r.lastReq.sys));
    assert.match(r.answer, /NullPointerException/);
    assert.ok(!/RELATED MEMORY|Previous solution/.test(r.answer));
  });

  await t("ERR resolution follow-up completes the earlier memory (port in use example)", async () => {
    await E.chat("My FastAPI server says `Address already in use` on port 8000.", { session: "p1" });
    const n = E.rows().length;
    const fix = await E.chat("I used port 8001 and it works", { session: "p1", history: [] });
    assert.strictEqual(fix.store.action, "resolved");
    assert.strictEqual(E.rows().length, n, "resolution must not add a row");
    const m = E.rows().find(x => /FastAPI/.test(x.user_message));
    assert.strictEqual(m.status, "resolved");
    assert.match(m.resolution, /8001/);
    const later = await E.chat("Why won't my FastAPI server start? It says address already in use again.", { session: "p2" });
    assert.strictEqual(later.memory_used, true);
    assert.match(later.lastReq.sys, /Resolution the user confirmed: .*8001/);
    assert.match(later.lastReq.sys, /relation=(same|similar)_error/);
  });

  await t("ERR 'still not working' is not treated as a resolution", async () => {
    const before = E.rows().filter(r => r.status === "resolved").length;
    await E.chat("I switched ports but it is still not working, same error", { session: "p1" });
    assert.strictEqual(E.rows().filter(r => r.status === "resolved").length, before);
  });
  E.close();

  /* =============== LLM structured extraction =============== */
  const L = await boot({ memory: { llmExtraction: true } });
  await t("LLM extraction fills structured fields (and heuristics take over when it fails)", async () => {
    await L.chat("I get ModuleNotFoundError: No module named 'django' when running my Django project locally");
    let m = L.rows()[0];
    assert.strictEqual(m.context, "Django project running locally");
    assert.strictEqual(m.cause, "Virtual environment was not activated");
    L.m.state.extractMode = "fail";
    await L.chat("My Django deployment failed because I forgot to configure DATABASE_URL.");
    m = L.rows().find(x => /DATABASE_URL/.test(x.user_message));
    assert.match(m.cause, /forgot to configure DATABASE_URL/i);
  });
  L.close();

  /* =============== Resilience & errors =============== */
  const R = await boot();
  await t("memory retrieval failure does not break the chat", async () => {
    R.app.locals.memory.search = () => { throw new Error("boom"); };
    await R.chat("What is Docker?");
    const r = await R.chat("Explain Docker containers to me");
    assert.strictEqual(r.status, 200); assert.ok(r.answer); assert.strictEqual(r.memory_used, false);
  });
  await t("memory storage failure does not break the chat", async () => {
    R.app.locals.memory.insert = () => { throw new Error("disk full"); };
    const r = await R.chat("Explain Kubernetes pods please");
    assert.strictEqual(r.status, 200); assert.ok(r.answer);
  });
  await t("Groq failure returns a clean message, no stack/key/upstream details", async () => {
    R.m.state.mode = "fail500";
    const r = await R.chat("What is Redis?");
    assert.ok(r.status >= 500);
    const s = r.api;
    assert.ok(!s.includes(FAKE_KEY) && !/secret|stack|exploded|at \//i.test(s), s);
    assert.match(r.error, /temporarily unavailable/);
    const st = await R.chat("What is Redis?", { stream: true });
    assert.ok(st.events.some(e => e.type === "error" && /temporarily unavailable/.test(e.message)));
    assert.ok(!st.raw.includes(FAKE_KEY));
    R.m.state.mode = "ok";
  });
  await t("decommissioned model falls back automatically", async () => {
    R.m.state.mode = "model404"; R.m.state.deadModel = "openai/gpt-oss-120b";
    const r = await R.chat("Explain binary search please");
    assert.strictEqual(r.status, 200);
    const used = R.m.state.requests.filter(x => !x.isExtract).slice(-1)[0].body.model;
    assert.strictEqual(used, "openai/gpt-oss-20b");
    R.m.state.mode = "ok";
  });
  await t("streaming: meta first, deltas, done; model reasoning tokens never forwarded", async () => {
    const r = await R.chat("Explain binary search again", { stream: true });
    assert.strictEqual(r.events[0].type, "meta");
    assert.strictEqual(r.events.at(-1).type, "done");
    assert.ok(r.text.length > 10);
    assert.ok(!/SECRET-REASONING/.test(r.raw));
  });
  await t("input validation + no stack traces on bad input", async () => {
    let res = await fetch(R.base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.strictEqual(res.status, 400); assert.ok(!/at .*\.js/.test(await res.text()));
    res = await fetch(R.base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "  " }) });
    assert.strictEqual(res.status, 400);
    res = await fetch(R.base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "x".repeat(9000) }) });
    assert.strictEqual(res.status, 413);
  });
  await t("memory can be cleared by the user", async () => {
    const r1 = await fetch(R.base + "/api/memory/stats", { headers: { "x-recall-user": "test@example.com" } });
    assert.ok((await r1.json()).count >= 0);
    const del = await fetch(R.base + "/api/memory", { method: "DELETE", headers: { "x-recall-user": "test@example.com" } });
    assert.strictEqual((await del.json()).deleted >= 0, true);
  });

  /* =============== G: Security =============== */
  await t("G  API key never appears in any response, static file, or frontend source", async () => {
    R.m.state.requests.length = 0;
    const bodies = [];
    for (const p of ["/api/health", "/chat.html", "/login.html", "/config.js", "/auth.js", "/theme.js"]) {
      const res = await fetch(R.base + p); bodies.push(p + ":" + (await res.text()));
    }
    const ok = await R.chat("Explain binary search once more", { stream: true });
    bodies.push(ok.raw);
    for (const b of bodies) assert.ok(!b.includes(FAKE_KEY), "key leaked in " + b.slice(0, 40));
    // the backend (not the browser) sends the key to Groq
    assert.ok(R.m.state.requests.every(x => x.auth === "Bearer " + FAKE_KEY));
  });
  await t("G  server files, .env and DB are not served over HTTP", async () => {
    for (const p of ["/.env", "/server.js", "/package.json", "/src/config.js", "/data/hindsight.db", "/.gitignore"]) {
      const res = await fetch(R.base + p);
      assert.strictEqual(res.status, 404, p + " -> " + res.status);
    }
  });
  await t("G  frontend has no key field, no Gemini, no direct provider calls", async () => {
    const pub = path.join(__dirname, "..", "public");
    for (const f of fs.readdirSync(pub)) {
      const s = fs.readFileSync(path.join(pub, f), "utf8");
      assert.ok(!/GROQ_API_KEY|gsk_[A-Za-z0-9]{10,}/.test(s), f + " mentions the key");
      assert.ok(!/gemini|generativelanguage|api\.groq\.com|x-goog-api-key|id=\"api-key\"|API key/i.test(s), f + " still has provider/key UI");
    }
  });
  await t("G  .env is git-ignored and .env.example holds only a placeholder", async () => {
    const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8").split("\n").map(s => s.trim());
    assert.ok(gi.includes(".env"));
    const ex = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
    assert.match(ex, /^GROQ_API_KEY=your_groq_api_key$/m);
    assert.match(ex, /^MEMORY_SIMILARITY_THRESHOLD=0\.65$/m);
  });
  R.close();

  console.log("\n" + results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
