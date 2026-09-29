/* Hindsight memory store: SQLite storage + TF-IDF / concept-aware retrieval. */
const crypto = require("crypto");
const T = require("./text");
const C = require("./classify");

const DEBUG_CATS = new Set(["debugging", "incident"]);
const MAX_CORPUS = 2000;

const weightOf = t => (t.startsWith("c:") ? 2 : t.startsWith("t:") ? 1.5 : 1);

function matchText(r) {
  const tech = safeJSON(r.technologies, []);
  return [r.user_message, r.error_text, r.exception_type, r.context, r.cause, r.solution, r.resolution, tech.join(" ")].filter(Boolean).join("\n");
}
function safeJSON(s, d) { try { return JSON.parse(s); } catch { return d; } }
const hashOf = text => crypto.createHash("sha1").update([...new Set(T.contentTokens(text))].sort().join(" ")).digest("hex");

function counts(tokens) { const m = new Map(); for (const t of tokens) m.set(t, (m.get(t) || 0) + 1); return m; }

function buildIdf(docTokenLists) {
  const df = new Map(); const N = docTokenLists.length;
  for (const toks of docTokenLists) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  return t => Math.log(1 + (N + 1) / ((df.get(t) || 0) + 1));
}
function vec(tokens, idf) {
  const v = new Map();
  for (const [t, c] of counts(tokens)) v.set(t, (1 + Math.log(c)) * idf(t) * weightOf(t));
  return v;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  for (const [t, x] of a) { const y = b.get(t); if (y) dot += x * y; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
function coverage(q, d) { // share of the query's weight that the memory explains
  let hit = 0, tot = 0;
  for (const [t, x] of q) { tot += x; if (d.has(t)) hit += x; }
  return tot ? hit / tot : 0;
}
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };
const inter = (a, b) => a.filter(x => b.includes(x));

class Memory {
  constructor(db, cfg) { this.db = db; this.cfg = cfg; }

  rows(userId) {
    return this.db.prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?").all(userId, MAX_CORPUS);
  }
  count(userId) { return this.db.prepare("SELECT COUNT(*) n FROM memories WHERE user_id = ?").get(userId).n; }
  clear(userId) { return this.db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId).changes; }
  get(id) { return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id); }

  /* Relevance search. `q` comes from classify.analyze().
     Scores every memory, drops those below the threshold, ranks the rest and returns ONLY the single
     highest-scoring one (an array of length 0 or 1). Nothing below the threshold is ever returned. */
  search(userId, q, { threshold = this.cfg.threshold, excludeIds = [] } = {}) {
    const rows = this.rows(userId).filter(r => !excludeIds.includes(r.id));
    if (!rows.length) return [];
    const docs = rows.map(r => ({ r, tokens: T.tokenize(matchText(r)) }));
    const idf = buildIdf(docs.map(d => d.tokens));
    const qv = vec(q.tokens, idf);
    const qErr = q.errorLine ? T.contentTokens(q.errorLine) : [];
    const out = [];
    for (const d of docs) {
      const r = d.r, dv = vec(d.tokens, idf);
      const base = 0.4 * cosine(qv, dv) + 0.6 * coverage(qv, dv);
      if (base < 0.15) continue;
      const mTech = safeJSON(r.technologies, []);
      const mCon = T.detectConcepts([r.user_message, r.error_text, r.cause].join("\n"));
      const sharedFamily = inter(q.family, mCon.family);
      const sharedContext = inter(q.context, mCon.context);
      const sharedTech = inter(q.tech, mTech.concat(T.detectTech(matchText(r))));
      const memIsDebug = DEBUG_CATS.has(r.category);

      let score = base;
      if (q.problem && memIsDebug) {
        if (sharedFamily.length) score += 0.20;
        if (sharedContext.length) score += 0.15;
        if (sharedTech.length) score += 0.10;
        // same technology named on both sides but nothing else in common -> not the same problem
        if (!sharedFamily.length && !sharedContext.length && !sharedTech.length) score *= 0.8;
      } else {
        if (sharedTech.length) score += 0.10;
        if (q.problem && !memIsDebug) score *= 0.85; // errors prefer debugging memories
      }
      // both sides mention (different) technologies and share none -> unlikely to be relevant
      // (skipped when the error family matches: "address already in use" is not language specific)
      if (q.tech.length && mTech.length && !sharedTech.length && !sharedFamily.length) score *= 0.75;
      // overlap made only of technology names ("django") is not evidence of relevance
      const dset = new Set(d.tokens);
      const sharedSubstance = q.tokens.filter(t => !t.startsWith("t:") && !T.TECH.has(t) && dset.has(t));
      const qSubstance = q.tokens.filter(t => !t.startsWith("t:") && !T.TECH.has(t));
      if (qSubstance.length && !sharedSubstance.length) score *= 0.7;
      score = Math.min(1, score);
      if (score < threshold) continue;

      let relation = "related_context";
      if (q.problem && memIsDebug) {
        const mErr = T.contentTokens(r.error_text || r.user_message);
        if (sharedFamily.length) relation = jaccard(qErr, mErr) >= 0.75 || d.r.msg_hash === hashOf(q.text) ? "same_error" : "similar_error";
        else if (!q.family.length && sharedContext.length) relation = "similar_issue";
        else relation = "related_issue";
      }
      // `score` is the real retrieval score (0-1); `pct` is what the user sees as "NN% RELEVANCE"
      out.push({ row: r, score, pct: Math.round(score * 100), relation, sharedFamily, sharedTech });
    }
    const rankedMemories = out.sort((a, b) => b.score - a.score);
    const topMemory = rankedMemories.slice(0, 1);
    return topMemory;
  }

  /* Near-duplicate check on the user's message text alone. */
  findDuplicate(userId, message) {
    const h = hashOf(message);
    const exact = this.db.prepare("SELECT * FROM memories WHERE user_id = ? AND msg_hash = ? LIMIT 1").get(userId, h);
    if (exact) return { row: exact, similarity: 1 };
    const rows = this.rows(userId);
    if (!rows.length) return null;
    const docs = rows.map(r => T.tokenize(r.user_message));
    const idf = buildIdf(docs);
    const qv = vec(T.tokenize(message), idf);
    let best = null;
    rows.forEach((r, i) => { const s = cosine(qv, vec(docs[i], idf)); if (!best || s > best.similarity) best = { row: r, similarity: s }; });
    return best && best.similarity >= this.cfg.dupThreshold ? best : null;
  }

  insert(userId, sessionId, rec) {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db.prepare(`INSERT INTO memories (id,user_id,session_id,category,user_message,assistant_response,error_text,exception_type,technologies,context,cause,solution,resolution,status,msg_hash,occurrences,created_at,updated_at)
      VALUES (@id,@user_id,@session_id,@category,@user_message,@assistant_response,@error_text,@exception_type,@technologies,@context,@cause,@solution,@resolution,@status,@msg_hash,1,@now,@now)`).run({
      id, user_id: userId, session_id: sessionId || "", category: rec.category,
      user_message: rec.userMessage, assistant_response: rec.assistantResponse,
      error_text: rec.error || "", exception_type: rec.exceptionType || "", technologies: JSON.stringify(rec.technologies || []),
      context: rec.context || "", cause: rec.cause || "", solution: rec.solution || "", resolution: rec.resolution || "",
      status: rec.status || "", msg_hash: hashOf(rec.userMessage), now
    });
    return id;
  }

  /* Refresh an existing memory: bump the counter and fill in anything that was missing. */
  touch(id, patch = {}) {
    const r = this.get(id); if (!r) return;
    const merged = {
      assistant_response: patch.assistantResponse || r.assistant_response,
      cause: r.cause || patch.cause || "", solution: r.solution || patch.solution || "",
      context: r.context || patch.context || "", error_text: r.error_text || patch.error || ""
    };
    this.db.prepare("UPDATE memories SET occurrences = occurrences + 1, updated_at = ?, assistant_response = ?, cause = ?, solution = ?, context = ?, error_text = ? WHERE id = ?")
      .run(Date.now(), merged.assistant_response, merged.cause, merged.solution, merged.context, merged.error_text, id);
  }

  markResolved(id, resolution) {
    const r = this.get(id); if (!r) return;
    this.db.prepare("UPDATE memories SET resolution = ?, status = 'resolved', solution = CASE WHEN solution = '' THEN ? ELSE solution END, updated_at = ? WHERE id = ?")
      .run(resolution, resolution, Date.now(), id);
  }

  lastDebugInSession(userId, sessionId, maxAgeMs = 12 * 3600 * 1000) {
    if (!sessionId) return null;
    return this.db.prepare("SELECT * FROM memories WHERE user_id = ? AND session_id = ? AND category IN ('debugging','incident') AND updated_at > ? ORDER BY updated_at DESC LIMIT 1")
      .get(userId, sessionId, Date.now() - maxAgeMs) || null;
  }
}

module.exports = { Memory, matchText, hashOf, DEBUG_CATS, safeJSON };
