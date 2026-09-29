/* Hindsight pipeline: decide -> retrieve -> build context -> Groq -> store. */
const T = require("./text");
const C = require("./classify");
const { buildSystemPrompt, memoryHeader, EXTRACT_PROMPT } = require("./prompt");

const MAX_HISTORY = 12, MAX_MSG = 6000;

function buildMessages(systemPrompt, history, message) {
  const hist = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.text === "string" && m.text.trim() && !m.error)
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text.slice(0, MAX_MSG) }));
  return [{ role: "system", content: systemPrompt }, ...hist, { role: "user", content: message }];
}

/* Steps 1-3: analyse the message and (only when useful) retrieve the single most relevant memory. Never throws.
   `retrieved` is either [] (nothing above the threshold, or a greeting) or exactly one ranked memory. */
function prepare({ memory, cfg, log }, { userId, message, useMemory = true }) {
  const q = C.analyze(message);
  let retrieved = [];
  if (useMemory && cfg.enabled && !q.trivial) {
    try {
      if (memory.count(userId) > 0) retrieved = memory.search(userId, q).slice(0, 1);
    } catch (e) { log.error("[hindsight] retrieval failed, continuing without memory:", e.message); retrieved = []; }
  }
  return { q, retrieved };
}

/* When a memory was used, the reply is "Previous solution: ... Current solution: ...". Only the current
   solution is worth remembering, so drop the framing (the header is added by the server and never stored). */
function stripMemoryFraming(answer) {
  const text = String(answer || "");
  const m = text.match(/(?:^|\n)[ \t]*(?:\*\*)?Current solution(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*/i);
  return m ? text.slice(m.index + m[0].length).trim() : text;
}

function isMeaningful(q, message, answer) {
  if (q.trivial || !answer || answer.length < 20) return false;
  if (q.problem || q.category === "decision") return true;
  return (T.contentTokens(message).length >= 2 || q.tech.length > 0) && answer.length >= 40;
}

async function extractStructured({ groq, cfg, log }, message, answer, q) {
  const h = C.heuristicExtract(message, answer);
  const rec = {
    error: q.errorLine, exceptionType: q.exceptionType, context: h.context, cause: h.cause, solution: h.solution,
    technologies: q.tech
  };
  if (cfg.llmExtraction && groq.available) {
    try {
      const j = await groq.json([
        { role: "system", content: EXTRACT_PROMPT },
        { role: "user", content: JSON.stringify({ user_message: message.slice(0, 3000), assistant_response: answer.slice(0, 3500) }) }
      ]);
      if (j && typeof j === "object") {
        const s = (v, n) => (typeof v === "string" ? C.clip(v, n) : "");
        rec.error = s(j.error, 220) || rec.error;
        rec.exceptionType = s(j.exception_type, 60) || rec.exceptionType;
        rec.context = s(j.context, 220) || rec.context;
        rec.cause = s(j.cause, 240) || rec.cause;
        rec.solution = s(j.solution, 320) || rec.solution;
        if (Array.isArray(j.technologies)) rec.technologies = [...new Set([...q.tech, ...j.technologies.filter(x => typeof x === "string").map(x => x.toLowerCase().slice(0, 30))])].slice(0, 8);
      }
    } catch (e) { log.warn("[hindsight] LLM extraction failed, using heuristics:", e.message); }
  }
  return rec;
}

/* Step 8: after answering, store what is worth remembering. Never throws. */
async function store({ memory, groq, cfg, log }, { userId, sessionId, message, answer, q, retrieved }) {
  try {
    if (!cfg.enabled) return { action: "disabled" };
    if (retrieved && retrieved.length) answer = stripMemoryFraming(answer);
    if (!isMeaningful(q, message, answer)) return { action: "skipped" };

    // "that fixed it" style follow-up: complete the earlier debugging memory instead of adding a new one
    if (C.isResolutionMessage(message)) {
      const prev = memory.lastDebugInSession(userId, sessionId);
      if (prev) { memory.markResolved(prev.id, C.cleanResolution(message)); return { action: "resolved", id: prev.id }; }
    }

    const debug = q.category === "debugging" || q.category === "incident";
    const rec = debug ? await extractStructured({ groq, cfg, log }, message, answer, q)
                      : { error: "", exceptionType: "", context: "", cause: "", solution: "", technologies: q.tech };
    Object.assign(rec, { category: q.category, userMessage: message.slice(0, 4000), assistantResponse: answer.slice(0, 6000), status: debug ? "open" : "" });

    // the same error again (or the same kind of failure with no new details): record a recurrence
    // on the existing memory instead of creating another one
    const top = retrieved && retrieved[0];
    if (debug && top && (top.relation === "same_error" || top.relation === "similar_issue")) { memory.touch(top.row.id, rec); return { action: "recurrence", id: top.row.id }; }

    const dup = memory.findDuplicate(userId, message);
    if (dup) { memory.touch(dup.row.id, rec); return { action: "duplicate", id: dup.row.id }; }

    return { action: "stored", id: memory.insert(userId, sessionId, rec) };
  } catch (e) {
    log.error("[hindsight] store failed:", e.message);
    return { action: "error" };
  }
}

module.exports = { prepare, buildMessages, store, buildSystemPrompt, memoryHeader, stripMemoryFraming };
