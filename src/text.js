/* Lightweight NLP helpers for Hindsight: tokenizing, stemming, tech-term and
   error-concept detection. No external services, no embeddings. */

const STOP = new Set(("a an the and or but if then else of to in on at by for with from as is are was were be been being am do does did done " +
  "have has had having i me my mine we our you your it its this that these those there here they them their he she his her " +
  "what which who whom whose when where why how can could should would will shall may might must not no nor so too very just also " +
  "please help want need get got gets getting give show tell say let lets like into out up down over about again still now " +
  "any some all each more most other such only own same than then s t ll re ve d m explain describe make makes made using use used " +
  "am im ive dont doesnt didnt cant cannot wont isnt wasnt arent werent thats theres hows whats yes yeah thing things way ways " +
  "really actually maybe something anything everything because say says said").split(/\s+/));

const IRREGULAR = { failure: "fail", failures: "fail", configuration: "configur", configurations: "configur",
  deployment: "deploy", deployments: "deploy", environment: "environment", environments: "environment",
  connection: "connect", connections: "connect", refused: "refus", refusing: "refus", refuse: "refus",
  databases: "databas", dependencies: "dependency", libraries: "library", ran: "run", running: "run", runs: "run",
  built: "build", building: "build", builds: "build", searching: "search", searches: "search", searched: "search" };

function stem(w) {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (/^\d+$/.test(w) || w.length <= 3 || w.includes("_")) return w;
  let s = w;
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2);
  else if (/(ss|us|is)$/.test(s)) { /* keep */ }
  else if (/(ches|shes|xes|sses)$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith("ment") && s.length > 6) s = s.slice(0, -4);
  if (s.endsWith("e") && s.length > 4) s = s.slice(0, -1);
  if (/([^aeioul])\1$/.test(s) && s.length > 4) s = s.slice(0, -1);
  return s;
}

/* Technology vocabulary (canonical names). */
const TECH = new Set(("django flask fastapi python pip venv node npm yarn pnpm react nextjs vue angular svelte express vercel render heroku netlify " +
  "railway aws gcp azure docker kubernetes nginx apache postgres mysql sqlite mongodb redis java spring kotlin go golang rust ruby rails php laravel " +
  "typescript javascript dotnet csharp swift git github gitlab linux ubuntu windows macos jenkins terraform ansible graphql kafka rabbitmq celery gunicorn uvicorn " +
  "webpack vite babel tailwind groq openai firebase supabase prisma sqlalchemy hibernate maven gradle cargo jest pytest selenium").split(/\s+/));

const TECH_ALIASES = [
  [/\bpostgre(?:s|sql)\b/g, "postgres"], [/\bnode\.?js\b/g, "node"], [/\bnext\.?js\b/g, "nextjs"], [/\bjs\b/g, "javascript"],
  [/\bts\b/g, "typescript"], [/\bpy\b/g, "python"], [/\bk8s\b/g, "kubernetes"], [/\bmongo\b/g, "mongodb"],
  [/\bc#\b/g, "csharp"], [/\.net\b/g, "dotnet"], [/\bvirtual ?env(?:ironment)?\b/g, "venv"], [/(?:^|\s)\.venv\b/g, " venv"],
  [/\bfast api\b/g, "fastapi"], [/\bnpm run\b/g, "npm run"], [/\bexpress\.?js\b/g, "express"]
];

/* Error "families" (specific problem types) and context concepts (generic failure settings). */
const ANY_MISSING = "(?:missing|not (?:set|configured|defined|found|provided)|(?:wasnt|isnt|werent|arent|hasnt been) (?:set|configured|defined|found|provided)|unset|undefined|forgot(?:ten)? to (?:set|configure|add|define|export)|never (?:set|configured))";
const CONCEPTS = {
  module_not_found: /modulenotfounderror|importerror|no module named|cant find (?:the )?[\w.\-]+ module|cannot find (?:the )?(?:module|package)|module not found|could not import|unable to import|cant import|cannot import/,
  port_in_use: /address already in use|eaddrinuse|port (?:\d+ )?(?:is )?(?:already )?(?:in use|taken|occupied|busy)|already in use|already being used|already allocated/,
  conn_refused: /connection (?:is |was )?(?:being )?(?:refused|denied|failed)|econnrefused|refused (?:the |my )?connection|(?:cant|cannot|unable to|couldnt|could not) connect|being refused/,
  config_missing: new RegExp("\\b" + ANY_MISSING + "\\b[^.\\n]*\\b(?:env(?:ironment)?(?: ?var\\w*)?|[a-z]+_[a-z_]+|config\\w*|settings?|secrets?|api key)\\b|\\b[a-z]+_[a-z_]+\\b[^.\\n]*\\b" + ANY_MISSING + "\\b|improperlyconfigured|environment variable"),
  permission_denied: /permission denied|eacces|eperm|access denied|forbidden|\b403\b/,
  file_not_found: /enoent|no such file|file not found|\b404\b/,
  timeout: /timed? ?out|etimedout|timeout/,
  auth_error: /unauthori[sz]ed|\b401\b|invalid (?:api )?(?:key|token|credentials|password)|authentication (?:failed|error)|login failed|password authentication failed/,
  null_reference: /nullpointerexception|null pointer|nonetype|cannot read propert(?:y|ies) of (?:undefined|null)|undefined is not|is not defined|\bnpe\b/,
  syntax_error: /syntaxerror|syntax error|unexpected token|parse error|indentationerror/,
  out_of_memory: /out of memory|outofmemory|memoryerror|\boom\b|heap out/,
  cors: /\bcors\b|cross-origin|access-control-allow/,
  command_not_found: /command not found|is not recognized as|(?:cant|cannot|unable to|couldnt) find (?:the )?(?:npm|node|yarn|pip|python|docker)\b|(?:npm|node|yarn|pip|python|docker|git)(?::| is)? not found/,
  dependency_error: /dependency (?:conflict|error|issue|problem)|peer dep|version conflict|could not find a version|no matching distribution|npm err|eresolve/,
  ssl_error: /\bssl\b|\btls\b|certificate (?:verify|expired|invalid|error)|self.signed/,
  server_error: /\b500\b|internal server error|\b502\b|\b503\b|bad gateway|service unavailable/,
  disk_full: /no space left|disk (?:is )?full|enospc/,
  db_error: /operationalerror|database (?:error|is locked)|relation .* does not exist|deadlock|integrityerror|too many connections/
};
const CONTEXT_CONCEPTS = {
  deploy_failed: /deploy(?:ment|ing|ed|s)?\w* (?:is |was |has |keeps |kept |are )?(?:\w+ )?(?:fail|error|crash|broke|broken|not work|stuck)\w*|(?:fail\w*|cant|cannot|unable) (?:to )?deploy|deploy(?:ment)? (?:issue|problem|error)|failing (?:to )?deploy/,
  build_failed: /build (?:fail|error)|failed to build|compilation (?:error|failed)|failed to compile|build command|build (?:is )?fail/
};
const FAMILY_NAMES = Object.keys(CONCEPTS);

const FAIL_RE = /\b(error|errors|exception|traceback|stack ?trace|bug|bugs|crash\w*|fail\w*|broken|not working|doesnt work|wont (?:start|run|build|load|work)|cant|cannot|unable|refused|denied|timeout|segfault|panic|stuck|hangs?|deprecated)\b/;
const CODE_RE = /(?:^|\n)\s*(?:traceback|at [\w.$<>]+\(|file ".+", line \d+|[\w.]+(?:error|exception)\b)|\b[A-Z][a-zA-Z]+(?:Error|Exception)\b|^\s*error:/im;

function norm(text) {
  return String(text || "").toLowerCase().replace(/[\u2018\u2019`]/g, "'").replace(/'/g, "");
}

function applyAliases(s) { for (const [re, to] of TECH_ALIASES) s = s.replace(re, to); return s; }

function detectConcepts(text) {
  const s = norm(text);
  const family = FAMILY_NAMES.filter(k => CONCEPTS[k].test(s));
  const context = Object.keys(CONTEXT_CONCEPTS).filter(k => CONTEXT_CONCEPTS[k].test(s));
  // "cannot find npm" is a command problem, not a generic file problem, etc.
  const fam = family.filter(f => !(f === "file_not_found" && (family.includes("module_not_found") || family.includes("command_not_found"))));
  return { family: fam, context };
}

function detectTech(text) {
  const s = applyAliases(norm(text));
  const out = new Set();
  for (const w of s.match(/[a-z0-9#]+/g) || []) if (TECH.has(w)) out.add(w);
  return [...out];
}

/* Returns tokens; "t:" = technology, "c:" = error/context concept. */
function tokenize(text, { withMeta = true } = {}) {
  const s = applyAliases(norm(text));
  const raw = s.match(/[a-z0-9_]+/g) || [];
  const out = [];
  for (const w of raw) {
    if (w.includes("_")) {
      const parts = w.split("_").filter(p => p.length > 1 && !STOP.has(p));
      out.push(w, ...parts.map(stem));
      continue;
    }
    if (STOP.has(w) || w.length < 2) continue;
    out.push(stem(w));
  }
  if (withMeta) {
    for (const t of detectTech(text)) out.push("t:" + t);
    const c = detectConcepts(text);
    for (const f of c.family) out.push("c:" + f);
    for (const f of c.context) out.push("c:" + f);
  }
  return out;
}

function contentTokens(text) { return tokenize(text, { withMeta: false }); }

function looksLikeError(text) {
  const t = String(text || "");
  const s = norm(t);
  const c = detectConcepts(t);
  if (c.family.length || c.context.length) return true;
  if (CODE_RE.test(t)) return true;
  return FAIL_RE.test(s) && (detectTech(t).length > 0 || /[a-z]+_[a-z_]+|\b\d{3,5}\b/.test(s));
}

/* Pick the line/sentence that best represents the error itself. */
function extractErrorLine(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const excRe = /\b\w*(?:Error|Exception|Warning)\b\s*:?.*|^\s*error:.*|.*(?:address already in use|connection refused|permission denied|command not found|no such file|cannot find module|not found).*/i;
  const trim = x => x.replace(/\s+(?:when|while|after|during|whenever|but|and then|which|so)\s+.*$/i, "").trim();
  for (const l of lines) { const m = l.match(excRe); if (m) return trim(m[0]).slice(0, 240); }
  const sentences = String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const hit = sentences.find(s => looksLikeError(s));
  return (hit || sentences[0] || "").trim().slice(0, 240);
}

function extractExceptionType(text) {
  const m = String(text || "").match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b/) || String(text || "").match(/\b(E[A-Z]{3,}[A-Z]*)\b/);
  return m ? m[1] : "";
}

module.exports = { STOP, TECH, CONCEPTS, CONTEXT_CONCEPTS, FAMILY_NAMES, norm, stem, tokenize, contentTokens, detectConcepts, detectTech,
  looksLikeError, extractErrorLine, extractExceptionType };
