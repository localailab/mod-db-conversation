#!/usr/bin/env node
// Command-line entry to the memory core. The Claude Code mod calls this via $.process.run.
//
//   conv-memory ingest            stdin: hook JSON ({ transcript_path, cwd }); then embeds what is new
//   conv-memory backfill [dir]    import every transcript under ~/.claude/projects, then embed all
//   conv-memory embed             embed every message that has no vector yet (needs Ollama)
//   conv-memory warm              load the embedding model into Ollama
//   conv-memory rebuild           move the DBs aside (backup) and rebuild them from all transcripts
//   conv-memory move-session <session_id> <dir>
//                                 move a session (and its later messages) to the project of <dir>
//   conv-memory search            stdin: { cwd, query, ... }        → JSON
//   conv-memory related           stdin: { cwd, text, ... }         → JSON
//   conv-memory get               stdin: { cwd, session_id, ... }   → JSON
//   conv-memory list              stdin: { cwd, ... }               → JSON
//   conv-memory delete            stdin: { cwd, session_id }        → JSON
//
// `cwd` picks the project: the git repository it is in, identified by its root commit.
// Outside a git repository with commits, these commands fail. PROJECT_ID overrides the id.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DB_PATH, openDb } from "./db.js";
import { ingestTranscript, moveSession } from "./ingest.js";
import { NO_PROJECT, resolveProject } from "./project.js";
import { deleteSession, getSession, listSessions, related, search } from "./search.js";
import { VECTORS_PATH, deleteSessionVectors, embedPending, moveSessionVectors, warm } from "./vectors.js";

function readStdin(): any {
  const text = fs.readFileSync(0, "utf8").trim();
  return text ? JSON.parse(text) : {};
}

function* walk(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.name.endsWith(".jsonl")) yield p;
  }
}

/** Moves the DB and the vectors into <DB dir>/backup-<time>/ so the next open starts empty. */
function moveAside(): string {
  const backup = path.join(path.dirname(DB_PATH), `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, VECTORS_PATH]) {
    if (fs.existsSync(p)) fs.renameSync(p, path.join(backup, path.basename(p)));
  }
  return backup;
}

/** session_moves of the current DB, read without migrating it (it may be an older version). */
function readMoves(): { session_id: string; target_path: string }[] {
  if (!fs.existsSync(DB_PATH)) return [];
  const old = new Database(DB_PATH, { readonly: true });
  try {
    const has = old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_moves'").get();
    return has ? (old.prepare("SELECT session_id, target_path FROM session_moves").all() as any[]) : [];
  } finally {
    old.close();
  }
}

async function backfill(db: ReturnType<typeof openDb>, root: string) {
  let files = 0;
  let inserted = 0;
  let skipped = 0;
  for (const file of walk(root)) {
    const r = ingestTranscript(db, file);
    inserted += r.inserted;
    skipped += r.skipped;
    files++;
  }
  const progress = (done: number, total: number) => process.stderr.write(`\rembedding ${done}/${total}`);
  const { error: embed_error, ...embedding } = await embedPending(db, { onProgress: progress });
  process.stderr.write("\n");
  return { db: DB_PATH, vectors: VECTORS_PATH, files, inserted, skipped, ...embedding, embed_error };
}

async function run(command: string | undefined, args: string[]): Promise<unknown> {
  const projectsDir = args[0] ?? path.join(os.homedir(), ".claude", "projects");
  if (command === "rebuild") {
    const moves = readMoves();
    const backup = moveAside();
    const db = openDb();
    try {
      // session moves are the person's decisions, not derived from transcripts: carry them over
      const keep = db.prepare("INSERT INTO session_moves (session_id, target_path) VALUES (?, ?)");
      for (const m of moves) keep.run(m.session_id, m.target_path);
      return { backup, moves: moves.length, ...(await backfill(db, projectsDir)) };
    } finally {
      db.close();
    }
  }
  const db = openDb();
  try {
    switch (command) {
      case "ingest": {
        const { transcript_path, cwd } = readStdin();
        if (!transcript_path) return { error: "transcript_path is required" };
        const saved = ingestTranscript(db, transcript_path, cwd);
        // a hook waits for this, so embedding gets a short budget; leftovers go next time
        // an embedding failure (Ollama not running) is not a failed save, so it is not `error`
        const { error: embed_error, ...embedding } = await embedPending(db, { limit: 200, timeBudgetMs: 8_000 });
        return { ...saved, ...embedding, embed_error };
      }
      case "backfill":
        return await backfill(db, projectsDir);
      case "move-session": {
        const [sessionId, dir] = args;
        if (!sessionId || !dir) return { error: "usage: move-session <session_id> <dir>" };
        const target = path.resolve(dir);
        const project = resolveProject(target);
        if (!project) return { error: `${target}: ${NO_PROJECT}` };
        if (!db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId)) {
          return { error: `session not found: ${sessionId}` };
        }
        const moved = moveSession(db, sessionId, project, target);
        await moveSessionVectors(sessionId, project.id);
        return { session_id: sessionId, project: project.name, project_id: project.id, messages: moved };
      }
      case "embed":
        return await embedPending(db, { onProgress: (d, n) => process.stderr.write(`\rembedding ${d}/${n}`) });
      case "warm":
        await warm();
        return { ok: true };
      case "search":
      case "related":
      case "get":
      case "list":
      case "delete": {
        const input = readStdin();
        const project = resolveProject(input.cwd ?? process.cwd());
        if (!project) return { error: NO_PROJECT };
        const projectId = process.env.PROJECT_ID ?? project.id;
        if (command === "search") return { project: project.name, ...(await search(db, projectId, input)) };
        if (command === "related") return { project: project.name, ...(await related(db, projectId, input)) };
        if (command === "get") return getSession(db, projectId, input);
        if (command === "list") return { project: { ...project, id: projectId }, sessions: listSessions(db, projectId, input) };
        const deleted = deleteSession(db, projectId, input.session_id);
        if (!("error" in deleted)) await deleteSessionVectors(input.session_id);
        return deleted;
      }
      default:
        return { error: `unknown command: ${command ?? "(none)"}` };
    }
  } finally {
    db.close();
  }
}

try {
  const out = await run(process.argv[2], process.argv.slice(3));
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(out && typeof out === "object" && "error" in out ? 1 : 0);
} catch (e) {
  process.stdout.write(JSON.stringify({ error: (e as Error).message }) + "\n");
  process.exit(1);
}
