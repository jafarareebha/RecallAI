const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function open(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      category TEXT NOT NULL,              -- decision | debugging | incident | knowledge | general
      user_message TEXT NOT NULL,
      assistant_response TEXT NOT NULL,
      error_text TEXT DEFAULT '',          -- debugging memory fields
      exception_type TEXT DEFAULT '',
      technologies TEXT DEFAULT '[]',      -- JSON array
      context TEXT DEFAULT '',
      cause TEXT DEFAULT '',
      solution TEXT DEFAULT '',
      resolution TEXT DEFAULT '',
      status TEXT DEFAULT '',              -- '' | open | resolved
      msg_hash TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_hash ON memories(user_id, msg_hash);
    CREATE INDEX IF NOT EXISTS idx_mem_session ON memories(user_id, session_id, updated_at DESC);
  `);
  return db;
}
module.exports = { open };
