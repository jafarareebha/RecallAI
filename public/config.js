// ---- Recall front-end configuration ----
// The Groq credential lives ONLY on the server (.env). Nothing secret belongs in this file.
// Leave API_BASE empty when the page is served by the Recall server (npm start).
// Set it (e.g. "http://localhost:3000") only if you host these files elsewhere, and set CORS_ORIGIN on the server.
window.RECALL_CONFIG = {
  API_BASE: ""
};
