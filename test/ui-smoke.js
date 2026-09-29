/* Loads the real public/chat.html in jsdom against the real server (+ mock Groq) and clicks through it. */
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const mock = require("./mock-groq");
const { createApp } = require("../server");
const { open } = require("../src/db");

(async () => {
  const m = await mock.start();
  const config = { port: 0, corsOrigin: "", rateLimitPerMin: 1000,
    groq: { apiKey: "gsk_UI_TEST_KEY_123456", model: "openai/gpt-oss-120b", fallbackModel: "openai/gpt-oss-20b", baseUrl: m.url, timeoutMs: 10000 },
    memory: { enabled: true, threshold: 0.65, dupThreshold: 0.88, llmExtraction: false, dbPath: ":memory:" } };
  const app = createApp({ config, log: { log() {}, warn() {}, error() {} }, db: open(":memory:") });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;

  const errors = [];
  const vc = new VirtualConsole(); vc.on("jsdomError", e => { if (!/Could not load|Not implemented|cdn\.tailwindcss|fonts\.g/.test(e.message)) errors.push(e.message); });
  const dom = await JSDOM.fromURL(base + "/chat.html", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.tailwind = {}; w.fetch = (u, o) => fetch(new URL(u, base), o); w.AbortController = AbortController;
      w.HTMLElement.prototype.scrollTo = () => {}; w.confirm = () => true;
      w.localStorage.setItem("recall_session", JSON.stringify({ email: "ui@test.com", name: "UI Tester" }));
    }
  });
  const d = dom.window.document;
  await new Promise(r => dom.window.addEventListener("load", r));
  const wait = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = fn(); if (v) return v; } catch {} await new Promise(r => setTimeout(r, 25)); } throw new Error("timeout waiting for UI"); };
  const say = async (text) => {
    const n = d.querySelectorAll("[data-bot]").length;
    d.getElementById("input").value = text; d.getElementById("send").click();
    await wait(() => d.querySelectorAll("[data-bot]").length > n && d.getElementById("send-icon").textContent === "arrow_upward");
    return [...d.querySelectorAll("[data-bot]")].at(-1);
  };
  const stored = () => new Promise(r => setTimeout(r, 150));

  // no key UI anywhere
  assert.ok(!d.getElementById("api-key") && !d.getElementById("key-banner"), "API key UI removed");
  assert.ok(!/api key|gemini/i.test(d.body.textContent), "no key/Gemini text on the page");

  let bot = await say("Hi");
  assert.match(bot.textContent, /Hey! How can I help you\?/);
  assert.ok(!/Used \d+ relevant/.test(d.body.textContent), "no memory indicator for greeting");

  bot = await say("My Django deployment failed because I forgot to configure DATABASE_URL."); await stored();
  assert.match(bot.textContent, /DATABASE_URL/);

  bot = await say("Why is my Django deployment failing again?");
  assert.match(bot.textContent, /context: 1 memories/);
  const note = bot.parentElement.textContent;
  assert.match(note, /Used 1 relevant memory/, "memory indicator shown: " + note);

  bot = await say("Explain binary search."); await stored();
  assert.ok(!/Used \d+ relevant/.test(bot.parentElement.textContent), "no indicator for unrelated question");

  // settings: memory controls, counts, clear
  d.getElementById("open-settings").click();
  await wait(() => /memories stored/.test(d.getElementById("mem-count").textContent));
  assert.match(d.getElementById("mem-count").textContent, /^\d+ memories stored$/);
  d.getElementById("mem-toggle").checked = false; d.getElementById("save-settings").click();
  bot = await say("Why is my Django deployment failing again?");
  assert.ok(!/Used \d+ relevant/.test(bot.parentElement.textContent), "memory toggle off => no memory used");
  d.getElementById("open-settings").click(); d.getElementById("clear-memory").click();
  await wait(() => /^0 memories stored$/.test(d.getElementById("mem-count").textContent));

  // server error -> friendly message
  m.state.mode = "fail500";
  bot = await say("What is Redis?");
  assert.match(bot.textContent, /temporarily unavailable/);
  assert.ok(!/gsk_|upstream|exploded/i.test(d.body.innerHTML));

  assert.deepStrictEqual(errors, [], "no script errors: " + errors.join("; "));
  console.log("UI smoke test passed");
  process.exit(0);
})().catch(e => { console.error("UI smoke test FAILED:", e.message); process.exit(1); });
