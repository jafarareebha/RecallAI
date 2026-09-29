require("dotenv").config();

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === "" ? d : !/^(0|false|no|off)$/i.test(String(v)));

const rawKey = (process.env.GROQ_API_KEY || "").trim();
const placeholder = !rawKey || /^your_groq_api_key$/i.test(rawKey);

module.exports = {
  port: num(process.env.PORT, 3000),
  corsOrigin: (process.env.CORS_ORIGIN || "").trim(),
  rateLimitPerMin: num(process.env.RATE_LIMIT_PER_MIN, 30),
  groq: {
    apiKey: placeholder ? "" : rawKey,
    model: (process.env.GROQ_MODEL || "openai/gpt-oss-120b").trim(),
    fallbackModel: (process.env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-20b").trim(),
    baseUrl: (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    timeoutMs: num(process.env.GROQ_TIMEOUT_MS, 90000)
  },
  memory: {
    enabled: bool(process.env.MEMORY_ENABLED, true),
    threshold: num(process.env.MEMORY_SIMILARITY_THRESHOLD, 0.65),
    topK: 1,   // Hindsight always uses exactly ONE memory (the single most relevant); not configurable
    dupThreshold: num(process.env.MEMORY_DUPLICATE_THRESHOLD, 0.88),
    llmExtraction: bool(process.env.MEMORY_LLM_EXTRACTION, true),
    dbPath: process.env.MEMORY_DB_PATH || "./data/hindsight.db"
  }
};
