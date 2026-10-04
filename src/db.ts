import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fillModels } from "./ingest.js";
import type { Storage } from "./storage.js";

export type DB = Database.Database;

// 2: project id = root commit hash, messages.git_commit
// 3: messages.model (migrated in place from 2)
const SCHEMA_VERSION = 3;

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const version = db.pragma("user_version", { simple: true }) as number;
  const hasData = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages'").get();
  if (hasData && version < 2) {
    throw new Error(
      "the memory DB was made by an older version (projects were identified differently); " +
        "run `node dist/cli.js rebuild` to rebuild it from Claude Code's transcripts",
    );
  }

  // the column check makes a rerun safe if a previous migration stopped before user_version
  const columns = db.pragma("table_info(messages)") as { name: string }[];
  if (hasData && version === 2 && !columns.some((c) => c.name === "model")) {
    db.exec("ALTER TABLE messages ADD COLUMN model TEXT");
  }

  db.exec(`
    -- id = hash of the repository's root commit; name follows the repository's current name
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      root_path   TEXT NOT NULL,     -- last seen checkout location
      git_remote  TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id  TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id),
      cwd         TEXT,              -- cwd at session start
      git_branch  TEXT,
      title       TEXT,
      started_at  TEXT,
      updated_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY,
      uuid        TEXT UNIQUE NOT NULL,
      project_id  TEXT NOT NULL REFERENCES projects(id),
      session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      role        TEXT NOT NULL,     -- user | assistant
      kind        TEXT NOT NULL,     -- text | tool_use | tool_result
      content     TEXT NOT NULL,
      timestamp   TEXT,
      cwd         TEXT,
      git_branch  TEXT,
      git_commit  TEXT,              -- newest commit of the branch at the message's time
      is_sidechain INTEGER NOT NULL DEFAULT 0,
      embedded_model TEXT,           -- model of the message's vector in LanceDB; NULL = not embedded yet
      model       TEXT               -- model that wrote an assistant message, as the API reported it; NULL for user
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_messages_commit ON messages(git_commit);

    -- trigram tokenizer: substring search that works for Japanese (no word boundaries)
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, content='messages', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;

    -- sessions moved to another project (cli move-session): their messages, now and later,
    -- belong to the project of target_path instead of the project of their own cwd
    CREATE TABLE IF NOT EXISTS session_moves (
      session_id  TEXT PRIMARY KEY,
      target_path TEXT NOT NULL
    );

    -- facts about the DB itself; owner_project_id: the repository a repo-mode DB belongs to
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- how far each transcript file has been ingested (byte offset), for incremental hook runs
    CREATE TABLE IF NOT EXISTS ingest_state (
      transcript_path TEXT PRIMARY KEY,
      byte_offset     INTEGER NOT NULL
    );
  `);
  // messages saved before version 3 get their model from the transcripts already read
  if (hasData && version === 2) fillModels(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Repo mode: record the owning repository on first use, and refuse a DB that belongs to
 * another repository (e.g. a copied folder). Shared mode has no owner.
 */
export function checkOwner(db: DB, storage: Storage) {
  if (!storage.owner) return;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'owner_project_id'").get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('owner_project_id', ?)").run(storage.owner.id);
  } else if (row.value !== storage.owner.id) {
    throw new Error(`DB belongs to another repository (project ${row.value}), refusing to use it: ${storage.db}`);
  }
}
