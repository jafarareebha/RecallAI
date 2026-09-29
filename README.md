# Recall — Groq + Hindsight memory

Your existing Recall chatbot (same UI, styling, login and chat history), now backed by a small
Node/Express server that talks to **Groq** and keeps a **Hindsight** memory of useful past interactions,
especially errors, causes and fixes.

```
Browser (chat.html) → Recall server → Hindsight retrieval → Groq → answer → store useful memory
```

## Run

```bash
npm install
# edit .env  →  GROQ_API_KEY=<your key from console.groq.com/keys>   (server side, one time)
npm start
# open http://localhost:3000  (create an account, then chat)
```

`npm test` runs the backend + UI tests (they use a local mock of Groq, no key needed).

Visitors never see or enter a key: it is read from `.env` on the server only. `.env` is git-ignored;
`.env.example` documents every setting.

> Your `index.html` home page wasn't in the zip. Drop it in `public/` and `/` will serve it.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | – | Server-side Groq key |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | `llama-3.3-70b-versatile` was retired by Groq on 2026‑08‑16 |
| `GROQ_FALLBACK_MODEL` | `openai/gpt-oss-20b` | Used automatically if the main model is unavailable |
| `MEMORY_SIMILARITY_THRESHOLD` | `0.65` | Minimum relevance (0–1) for a memory to be used |
| `MEMORY_DUPLICATE_THRESHOLD` | `0.88` | Above this, a question is merged into the existing memory |
| `MEMORY_LLM_EXTRACTION` | `true` | Let Groq extract error/cause/fix (heuristics are the fallback) |
| `MEMORY_DB_PATH` | `./data/hindsight.db` | SQLite file |

## How Hindsight works

* **Skip** retrieval for greetings/thanks/acks, so they behave like a normal chatbot.
* **Retrieve**: TF‑IDF cosine + query coverage over each user's memories, boosted by shared error type
  (`ModuleNotFoundError`, "address already in use", "connection refused", …), shared technology and shared
  failure context. Errors prefer debugging/incident memories. Only matches ≥ threshold are used.
* **Top 1 only**: every memory is scored, those below `MEMORY_SIMILARITY_THRESHOLD` are dropped, the rest are ranked and
  **only the single highest-scoring memory** is used. Several memories are never sent to Groq or shown to the user.
* **Label** the match `same_error`, `similar_error`, `similar_issue`, `related_issue` or `related_context`;
  the prompt tells Groq how much to trust it (a related-but-different error must *not* reuse the old fix).
* **Answer** with Groq. When a memory is used, the reply has this exact shape (the header lines are built by the server
  from the real retrieval score and the stored memory; Groq writes the last two sections):

  ```text
  RELATED MEMORY · 91% RELEVANCE

  <title of previous incident> — <date>

  Connection: <fixed wording, see below>

  Previous solution: <brief: what happened, the cause, how it was fixed>

  Current solution: <solves the CURRENT problem; reuses the old fix only if it is technically applicable>
  ```

  Connection wording: `same_error` → “You encountered this issue previously.”; `similar_error` / `similar_issue` → “This looks
  similar to an issue you encountered previously.”; `related_issue` → “This is related to a previous issue involving the same
  system.” (for non-debugging memories: “…related to something you discussed previously.”).
  If nothing is above the threshold (or the message is a greeting) there is no `RELATED MEMORY` section, no “no memory found”
  text, and Groq simply answers.
* **Store** after the reply: category (`decision`, `debugging`, `incident`, `knowledge`, `general`); debugging
  memories also keep error, exception type, context, cause, solution, technologies and status. A follow-up
  such as "I used port 8001 and it works" marks the earlier memory resolved. Repeats update the existing
  memory instead of adding rows. Only Groq's *current* solution is stored; the `RELATED MEMORY` header and the
  “Previous solution” framing are never written back into memory.

Files: `server.js` (API), `src/hindsight.js` (pipeline), `src/memory.js` (SQLite + retrieval),
`src/text.js` / `src/classify.js` (error/tech detection), `src/groq.js`, `src/prompt.js`, `public/` (frontend).

## Notes

* Memories are scoped by the account email the browser sends. The existing login is browser-only (localStorage),
  so this is not tamper-proof; when you move auth to the server, derive the user id from the server session.
* Settings (⚙) now controls memory: on/off and “Clear memories”.
