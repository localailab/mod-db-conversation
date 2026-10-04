import fs from "node:fs";
import type { DB } from "./db.js";
import { commitAt } from "./commits.js";
import { type Project, resolveProject } from "./project.js";

const TOOL_TEXT_LIMIT = 2000;

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown };

type Row = {
  uuid: string;
  project_id?: string;
  git_commit?: string | null;
  session_id: string;
  role: string;
  kind: string;
  content: string;
  timestamp: string | null;
  cwd: string | null;
  git_branch: string | null;
  is_sidechain: number;
  model: string | null;
};

function truncate(s: string, n = TOOL_TEXT_LIMIT) {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s;
}

// Harness-injected context is noise for recall; drop it.
function stripInjected(s: string) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(local-command-[a-z]+|command-[a-z]+)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Block) => (b.type === "text" ? b.text ?? "" : `[${b.type}]`))
      .join("\n");
  }
  return "";
}

/** Convert one transcript JSONL entry into zero or more message rows. */
export function parseEntry(entry: any): Row[] {
  if (entry.type !== "user" && entry.type !== "assistant") return [];
  if (entry.isMeta || !entry.uuid || !entry.sessionId) return [];
  const msg = entry.message;
  if (!msg) return [];

  const base = {
    session_id: entry.sessionId as string,
    role: msg.role ?? entry.type,
    timestamp: entry.timestamp ?? null,
    cwd: entry.cwd ?? null,
    git_branch: entry.gitBranch ?? null,
    is_sidechain: entry.isSidechain ? 1 : 0,
    // as the API reported it; "<synthetic>" marks messages Claude Code wrote itself
    model: entry.type === "assistant" && typeof msg.model === "string" ? msg.model : null,
  };

  const blocks: Block[] =
    typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];

  const rows: Row[] = [];
  blocks.forEach((b, i) => {
    let kind: string;
    let content: string;
    if (b.type === "text") {
      kind = "text";
      content = stripInjected(b.text ?? "");
    } else if (b.type === "tool_use") {
      kind = "tool_use";
      content = `[tool_use ${b.name}] ${truncate(JSON.stringify(b.input ?? {}))}`;
    } else if (b.type === "tool_result") {
      kind = "tool_result";
      content = `[tool_result] ${truncate(stripInjected(toolResultText(b.content)))}`;
    } else {
      return; // thinking, images, etc.
    }
    if (!content) return;
    rows.push({ ...base, uuid: blocks.length > 1 ? `${entry.uuid}#${i}` : entry.uuid, kind, content });
  });
  return rows;
}

export function saveProject(db: DB, project: Project) {
  db.prepare(
    `INSERT INTO projects (id, name, root_path, git_remote) VALUES (@id, @name, @root_path, @git_remote)
     ON CONFLICT(id) DO UPDATE SET
       root_path = excluded.root_path, name = excluded.name, git_remote = excluded.git_remote`,
  ).run(project);
}

/**
 * Move a session to the project of `targetDir`: its messages so far are reassigned (with their
 * commits recomputed against that repository), and its later messages follow. Remembered in
 * session_moves, which `rebuild` carries over.
 */
export function moveSession(db: DB, sessionId: string, project: Project, targetDir: string) {
  const messages = db
    .prepare("SELECT id, git_branch, timestamp FROM messages WHERE session_id = ?")
    .all(sessionId) as { id: number; git_branch: string | null; timestamp: string | null }[];
  const setMessage = db.prepare("UPDATE messages SET project_id = ?, git_commit = ? WHERE id = ?");
  db.transaction(() => {
    saveProject(db, project);
    db.prepare(
      `INSERT INTO session_moves (session_id, target_path) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET target_path = excluded.target_path`,
    ).run(sessionId, targetDir);
    db.prepare("UPDATE sessions SET project_id = ? WHERE session_id = ?").run(project.id, sessionId);
    for (const m of messages) {
      setMessage.run(project.id, commitAt(project.root_path, m.git_branch, m.timestamp), m.id);
    }
  })();
  return messages.length;
}

/**
 * Fill messages.model for messages saved before the column existed, from the part of each
 * transcript already ingested. Only updates existing rows, so deleted sessions stay deleted.
 */
export function fillModels(db: DB): number {
  const transcripts = db.prepare("SELECT transcript_path, byte_offset FROM ingest_state").all() as {
    transcript_path: string;
    byte_offset: number;
  }[];
  const setModel = db.prepare("UPDATE messages SET model = ? WHERE uuid = ? AND model IS NULL");
  let updated = 0;
  db.transaction(() => {
    for (const t of transcripts) {
      if (!fs.existsSync(t.transcript_path)) continue;
      const fd = fs.openSync(t.transcript_path, "r");
      const buf = Buffer.alloc(Math.min(t.byte_offset, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.includes('"model"')) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        for (const row of parseEntry(entry)) {
          if (row.model) updated += setModel.run(row.model, row.uuid).changes;
        }
      }
    }
  })();
  return updated;
}

/**
 * Ingest new lines of a Claude Code transcript (~/.claude/projects/<proj>/<session>.jsonl).
 * Incremental: resumes from the byte offset recorded last time.
 * Each message is assigned to the project of its cwd (fallbackCwd when the entry has none)
 * and to the commit it was based on. Messages outside a git repository with commits are
 * skipped (counted in `skipped`), and are not picked up later.
 */
export function ingestTranscript(
  db: DB,
  transcriptPath: string,
  fallbackCwd?: string,
): { inserted: number; skipped: number } {
  const none = { inserted: 0, skipped: 0 };
  if (!fs.existsSync(transcriptPath)) return none;

  const state = db
    .prepare("SELECT byte_offset FROM ingest_state WHERE transcript_path = ?")
    .get(transcriptPath) as { byte_offset: number } | undefined;
  let offset = state?.byte_offset ?? 0;
  const size = fs.statSync(transcriptPath).size;
  if (size < offset) offset = 0; // file was rewritten
  if (size === offset) return none;

  const fd = fs.openSync(transcriptPath, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);

  // Only consume complete lines; a partially written last line is picked up next time.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return none;
  const lines = buf.subarray(0, lastNl).toString("utf8").split("\n");

  const moves = new Map(
    (db.prepare("SELECT session_id, target_path FROM session_moves").all() as { session_id: string; target_path: string }[]).map(
      (m) => [m.session_id, m.target_path],
    ),
  );
  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, project_id, cwd, git_branch, started_at, updated_at)
    VALUES (@session_id, @project_id, @cwd, @git_branch, @timestamp, @timestamp)
    ON CONFLICT(session_id) DO UPDATE SET
      updated_at = MAX(COALESCE(updated_at, ''), COALESCE(excluded.updated_at, '')),
      git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
      project_id = COALESCE(sessions.project_id, excluded.project_id),
      cwd        = COALESCE(sessions.cwd, excluded.cwd)
  `);
  const setTitle = db.prepare(`
    INSERT INTO sessions (session_id, title) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET title = excluded.title
  `);
  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
      (uuid, project_id, session_id, role, kind, content, timestamp, cwd, git_branch, git_commit, is_sidechain, model)
    VALUES (@uuid, @project_id, @session_id, @role, @kind, @content, @timestamp, @cwd, @git_branch, @git_commit, @is_sidechain, @model)
  `);
  const saveOffset = db.prepare(`
    INSERT INTO ingest_state (transcript_path, byte_offset) VALUES (?, ?)
    ON CONFLICT(transcript_path) DO UPDATE SET byte_offset = excluded.byte_offset
  `);

  let inserted = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "ai-title" && entry.sessionId && entry.aiTitle) {
        setTitle.run(entry.sessionId, entry.aiTitle);
        continue;
      }
      for (const row of parseEntry(entry)) {
        row.cwd ??= fallbackCwd ?? null;
        const dir = moves.get(row.session_id) ?? row.cwd;
        const project = dir ? resolveProject(dir) : null;
        if (!project) {
          skipped++; // not in a git repository with commits
          continue;
        }
        saveProject(db, project);
        row.project_id = project.id;
        row.git_commit = commitAt(project.root_path, row.git_branch, row.timestamp);
        upsertSession.run(row);
        inserted += insertMsg.run(row).changes;
      }
    }
    saveOffset.run(transcriptPath, offset + lastNl + 1);
  })();
  return { inserted, skipped };
}
