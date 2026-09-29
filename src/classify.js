/* Message analysis: is retrieval worthwhile, what kind of memory is this,
   and heuristic extraction of error / cause / solution. */
const T = require("./text");

const SMALLTALK = new RegExp("^(?:" + [
  "hi+", "hello+", "hey+", "heya", "hiya", "yo", "sup", "howdy", "greetings", "hola",
  "good (?:morning|afternoon|evening|night|day)", "gm", "gn",
  "thanks?(?: a lot| so much| you)?(?: (?:very much|again|man|mate|buddy))?", "thank you(?: (?:so|very) much)?", "thx", "ty", "cheers", "much appreciated",
  "ok(?:ay)?", "k", "kk", "cool", "great", "nice", "awesome", "perfect", "sounds good", "got it", "understood", "sure", "alright", "fine", "yes", "yeah", "yep", "no", "nope", "nah",
  "bye+", "goodbye", "see (?:you|ya)(?: later| soon)?", "cya", "later", "take care", "good night",
  "how are (?:you|u)(?: doing| today)?", "how(?:s| is) it going", "how do you do", "what(?:s| is) up", "who are you", "what can you do", "help", "test", "testing"
].join("|") + ")(?:\\s+(?:there|claude|recall|bot|buddy|friend|man))?$", "i");

function stripPunct(s) { return String(s || "").trim().replace(/[\s.!?,;:~*_"']+$/g, "").replace(/^[\s.!?,;:~*_"']+/g, "").replace(/\s+/g, " "); }

function isTrivial(text) {
  const s = stripPunct(text).toLowerCase().replace(/^(?:(?:hi|hello|hey)[\s,!.]+)+(?=\w)/, m => m); // keep
  if (!s) return true;
  // "hi, thanks!" style compound smalltalk
  const parts = s.split(/\s*[,!.]+\s*/).filter(Boolean);
  if (parts.length && parts.every(p => SMALLTALK.test(p))) return true;
  if (SMALLTALK.test(s)) return true;
  const ct = T.contentTokens(text);
  if (ct.length < 2 && !T.detectTech(text).length && !T.looksLikeError(text)) return true;
  return false;
}

const INCIDENT_RE = /\b(outage|incident|sev-?\s?\d|post-?mortem|production (?:is )?(?:down|broken)|prod (?:is )?down|downtime|rollback|rolled back|site is down|deploy(?:ment|ing|ed)?\w* (?:is |was |has |keeps )?fail\w*|(?:failed|failing) (?:to )?deploy\w*|deployment (?:issue|problem|error))/i;
const DECISION_RE = /\b(?:we|i|team|they)\s+(?:have\s+|had\s+)?(?:decided|chose|agreed|settled|opted|picked|went with|are going to (?:use|go with)|will (?:use|go with)|are switching|switched|migrated)\b|\bdecision\s*:|\blet'?s (?:use|go with|switch to|adopt)\b|\bwe(?:'ll| will) (?:use|adopt|switch)\b|\badr\b/i;
const QUESTION_RE = /^\s*(?:what|why|how|when|where|which|who|explain|define|describe|compare|difference|tell me|can you explain|could you explain|is|are|does|do)\b|\?\s*$/i;

function classify(text) {
  const c = T.detectConcepts(text);
  const problem = T.looksLikeError(text);
  let category = "general";
  if (problem) category = (c.context.includes("deploy_failed") || INCIDENT_RE.test(text)) ? "incident" : "debugging";
  else if (DECISION_RE.test(text)) category = "decision";
  else if (QUESTION_RE.test(text)) category = "knowledge";
  return { category, problem, family: c.family, context: c.context };
}

function analyze(text) {
  const cls = classify(text);
  return {
    text,
    ...cls,
    tokens: T.tokenize(text),
    tech: T.detectTech(text),
    errorLine: cls.problem ? T.extractErrorLine(text) : "",
    exceptionType: T.extractExceptionType(text),
    trivial: isTrivial(text)
  };
}

/* ---------- heuristic structured extraction ---------- */
const clip = (s, n = 300) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const sentences = t => String(t || "").replace(/```[\s\S]*?```/g, " ").replace(/[*#>`]/g, "").replace(/\s+/g, " ").split(/(?<=[.!?:])\s+/).map(s => s.trim()).filter(s => s.length > 12);

function heuristicExtract(userMsg, answer) {
  let cause = "";
  const um = String(userMsg || "").replace(/\s+/g, " ");
  const bm = um.match(/\b(?:because|caused by|due to|since|turns out|turned out|the (?:issue|problem|reason) (?:was|is))\s+(.{5,200}?)(?:[.!?]|$)/i);
  if (bm) cause = clip(bm[0].replace(/^(since)\s+/i, ""), 220);
  const sents = sentences(answer);
  if (!cause) {
    const cs = sents.find(s => /\b(because|caused by|due to|root cause|the (?:issue|problem|reason)|is missing|isn't set|not set|not configured|means that|likely)\b/i.test(s));
    if (cs) cause = clip(cs, 240);
  }
  const ss = sents.filter(s => /\b(fix|solution|resolve|solve|you (?:can|should|need to|could)|try|make sure|ensure|activate|install|add|set|check|change|switch|use|run|restart|update|configure|stop|kill)\b/i.test(s) && s !== cause);
  const solution = ss.slice(0, 2).map(s => clip(s, 240)).join(" ");
  const ctx = clip(um.replace(/^(?:hi|hello|hey)[,!. ]+/i, ""), 200);
  return { cause, solution, context: ctx };
}

/* ---------- resolution follow-ups ("that fixed it", "I used port 8001 and it works") ---------- */
const RESOLVED_RE = /\b(?:that|this|it)\s+(?:worked|works|fixed(?: it)?|did (?:it|the trick)|solved(?: it)?|resolved(?: it)?)\b|\b(?:it(?:'s| is)?|everything(?:'s| is)?|now)\s+(?:working|fixed|resolved|running|works|fine)\b|\b(?:works|working) now\b|\bfixed (?:it|the (?:issue|problem|error|bug))\b|\b(?:issue|problem|error|bug) (?:is |was |has been )?(?:fixed|solved|resolved|gone)\b|\band it (?:works|worked|runs|started)\b|\bthat did it\b|\bsolved\b/i;
const NEG_RE = /\b(?:not|never|still|isn'?t|doesn'?t|didn'?t|wasn'?t|won'?t|no longer)\b[^.!?]{0,20}\b(?:work|fix|solv|resolv|running)|\bstill (?:fail|broken|happen|get|see)|\bagain\b|\bnew error\b/i;

function isResolutionMessage(text) {
  const t = String(text || "");
  if (t.split(/\s+/).length > 45) return false;
  if (NEG_RE.test(t)) return false;
  return RESOLVED_RE.test(t);
}

function cleanResolution(text) {
  return clip(String(text || "").replace(/^(?:ok(?:ay)?|great|thanks?|thank you|yes|yep)[,!. ]+/i, ""), 300);
}

module.exports = { isTrivial, classify, analyze, heuristicExtract, isResolutionMessage, cleanResolution, clip };
