// Message vectors in LanceDB. SQLite stays the source of truth: a vector row carries
// only the message id and the fields searches filter on, and is rebuilt from SQLite.
import * as lancedb from "@lancedb/lancedb";
import type { DB } from "./db.js";
import { EMBED_MODEL, embed } from "./embed.js";

// Set once per CLI run from the resolved storage (see storage.ts).
let vectorsPath = "";
export function useVectors(dir: string) {
  vectorsPath = dir;
}

// One table per model, so switching models never mixes vector spaces or dimensions.
const TABLE = `messages_${EMBED_MODEL.replace(/[^A-Za-z0-9_]/g, "_")}`;

const BATCH = 32;

type VectorRow = { id: number; project_id: string; session_id: string; vector: number[] };
export type VectorHit = { id: number; distance: number };

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function openTable(): Promise<lancedb.Table | null> {
  const conn = await lancedb.connect(vectorsPath);
  return (await conn.tableNames()).includes(TABLE) ? conn.openTable(TABLE) : null;
}

async function upsert(rows: VectorRow[]) {
  const conn = await lancedb.connect(vectorsPath);
  if (!(await conn.tableNames()).includes(TABLE)) {
    await conn.createTable(TABLE, rows);
    return;
  }
  const table = await conn.openTable(TABLE);
  await table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
}

/**
 * Embed text messages that have no vector for the current model yet.
 * Stops at the first failure (e.g. Ollama not running); the rest is picked up next time.
 */
export async function embedPending(
  db: DB,
  o: { limit?: number; timeBudgetMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ embedded: number; pending: number; error?: string }> {
  const pendingSql = "FROM messages WHERE kind = 'text' AND (embedded_model IS NULL OR embedded_model != ?)";
  const countPending = () =>
    (db.prepare(`SELECT COUNT(*) AS n ${pendingSql}`).get(EMBED_MODEL) as { n: number }).n;
  const next = db.prepare(`SELECT id, project_id, session_id, content ${pendingSql} ORDER BY id LIMIT ?`);
  const mark = db.prepare("UPDATE messages SET embedded_model = ? WHERE id = ?");

  const total = Math.min(countPending(), o.limit ?? Infinity);
  const deadline = Date.now() + (o.timeBudgetMs ?? Infinity);
  let embedded = 0;
  try {
    while (embedded < total && Date.now() < deadline) {
      const batch = next.all(EMBED_MODEL, Math.min(BATCH, total - embedded)) as {
        id: number;
        project_id: string;
        session_id: string;
        content: string;
      }[];
      if (!batch.length) break;
      const vectors = await embed(batch.map((m) => m.content), 120_000);
      await upsert(batch.map((m, i) => ({ id: m.id, project_id: m.project_id, session_id: m.session_id, vector: vectors[i]! })));
      db.transaction(() => batch.forEach((m) => mark.run(EMBED_MODEL, m.id)))();
      embedded += batch.length;
      o.onProgress?.(embedded, total);
    }
    return { embedded, pending: countPending() };
  } catch (e) {
    return { embedded, pending: countPending(), error: (e as Error).message };
  }
}

/** Nearest messages to the text, by cosine distance (0 = same direction). Empty if no vectors or no Ollama. */
export async function searchVectors(
  text: string,
  o: { projectId: string; excludeSessionId?: string; limit: number; timeoutMs: number },
): Promise<VectorHit[]> {
  const table = await openTable();
  if (!table) return [];
  const [vector] = await embed([text], o.timeoutMs);
  const where = [
    `project_id = ${quote(o.projectId)}`,
    o.excludeSessionId && `session_id != ${quote(o.excludeSessionId)}`,
  ].filter(Boolean);
  const q = table.vectorSearch(vector!).distanceType("cosine").limit(o.limit).where(where.join(" AND "));
  const rows = (await q.select(["id"]).toArray()) as { id: number; _distance: number }[];
  return rows.map((r) => ({ id: Number(r.id), distance: r._distance }));
}

export async function moveSessionVectors(sessionId: string, projectId: string) {
  const table = await openTable();
  if (table) await table.update({ where: `session_id = ${quote(sessionId)}`, values: { project_id: projectId } });
}

export async function deleteSessionVectors(sessionId: string) {
  const table = await openTable();
  if (table) await table.delete(`session_id = ${quote(sessionId)}`);
}

/** Load the model into Ollama ahead of the first prompt. */
export async function warm() {
  await embed(["warm"], 60_000);
}
