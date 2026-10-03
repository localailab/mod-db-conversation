// Read/delete operations on the memory DB, always scoped to one project.
// Called through the CLI, which the Claude Code mod runs.
//
// Retrieval is hybrid: keyword (SQLite FTS5 trigram) and semantic (LanceDB vectors),
// fused by reciprocal rank. Without Ollama the semantic half is skipped and keywords still work.
import type { DB } from "./db.js";
import { searchVectors } from "./vectors.js";

const likeEscape = (s: string) => s.replace(/[\\%_]/g, "\\$&");
const ftsPhrase = (s: string) => `"${s.replace(/"/g, '""')}"`;
const chars = (s: string) => [...s].length;

// Measured with bge-m3 on real transcripts: related messages sit at cosine distance
// ~0.24-0.40, while short chit-chat ("お願いします") lands near anything short.
const SEMANTIC_MIN_CHARS = 20;
const SEARCH_MAX_DISTANCE = 0.45;
const RELATED_MAX_DISTANCE = 0.33;
const RRF_K = 60;

export type SearchOptions = {
  query: string;
  include_tools?: boolean;
  exclude_session_id?: string;
  all_projects?: boolean;
  limit?: number;
};

type Hit = Record<string, unknown> & { id: number; snippet: string };
type Fused = Hit & { match: string[]; distance?: number; coverage?: number };

/** Keyword + semantic search for an explicit query. */
export async function search(db: DB, projectId: string, o: SearchOptions) {
  const limit = o.limit ?? 10;
  const keyword = keywordSearch(db, projectId, { ...o, limit });
  const semantic = await semanticSearch(db, projectId, o.query, {
    ...o,
    maxDistance: SEARCH_MAX_DISTANCE,
    limit,
    timeoutMs: 5_000,
  });
  return { results: fuse({ keyword, semantic: semantic.hits }, limit), semantic: semantic.status };
}

/**
 * Past messages closely related to a natural-language text (the prompt being sent):
 * keyword hits must cover `min_coverage` of the text's trigrams, semantic hits must be
 * within RELATED_MAX_DISTANCE. Strict on purpose: these are attached unasked.
 */
export async function related(
  db: DB,
  projectId: string,
  o: Omit<SearchOptions, "query"> & { text: string; min_coverage?: number },
) {
  const limit = o.limit ?? 3;
  const keyword = coverageSearch(db, projectId, o);
  const semantic = await semanticSearch(db, projectId, o.text, {
    ...o,
    maxDistance: RELATED_MAX_DISTANCE,
    limit,
    timeoutMs: 2_000,
  });
  return { results: fuse({ keyword, semantic: semantic.hits }, limit), semantic: semantic.status };
}

/** Space-separated terms, all must match as substrings. */
function keywordSearch(db: DB, projectId: string, o: SearchOptions & { limit: number }): Hit[] {
  const terms = o.query.split(/\s+/).filter(Boolean);
  // trigram FTS needs >= 3 chars per term; shorter terms fall back to LIKE
  const ftsTerms = terms.filter((t) => chars(t) >= 3);
  const likeTerms = terms.filter((t) => chars(t) < 3);

  const where: string[] = [];
  const params: unknown[] = [];
  if (ftsTerms.length) {
    where.push("messages_fts MATCH ?");
    params.push(ftsTerms.map(ftsPhrase).join(" AND "));
  }
  for (const t of likeTerms) {
    where.push("m.content LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(t)}%`);
  }
  if (!where.length) return [];
  addFilters(where, params, projectId, o);

  const sql = ftsTerms.length
    ? `SELECT ${RESULT_COLS}, snippet(messages_fts, 0, '«', '»', '…', 48) AS snippet
       FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid ${RESULT_JOINS}
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(messages_fts) LIMIT ?`
    : `SELECT ${RESULT_COLS}, substr(m.content, 1, 300) AS snippet
       FROM messages m ${RESULT_JOINS}
       WHERE ${where.join(" AND ")}
       ORDER BY m.timestamp DESC LIMIT ?`;
  return db.prepare(sql).all(...params, o.limit) as Hit[];
}

/** Any of the text's trigrams, ranked by bm25, kept when covering enough of them. */
function coverageSearch(
  db: DB,
  projectId: string,
  o: Omit<SearchOptions, "query"> & { text: string; min_coverage?: number },
): Hit[] {
  const grams = trigrams(o.text);
  if (grams.length === 0) return [];
  const where = ["messages_fts MATCH ?"];
  const params: unknown[] = [grams.map(ftsPhrase).join(" OR ")];
  addFilters(where, params, projectId, o);

  const rows = db
    .prepare(
      `SELECT ${RESULT_COLS}, m.content
       FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid ${RESULT_JOINS}
       WHERE ${where.join(" AND ")}
       ORDER BY bm25(messages_fts) LIMIT 50`,
    )
    .all(...params) as ({ id: number; content: string } & Record<string, unknown>)[];

  const minCoverage = o.min_coverage ?? 0.25;
  return rows
    .map(({ content, ...r }) => {
      const lower = content.toLowerCase();
      const coverage = grams.filter((g) => lower.includes(g)).length / grams.length;
      return { ...r, coverage: Math.round(coverage * 100) / 100, snippet: excerpt(content, grams) };
    })
    .filter((r) => r.coverage >= minCoverage)
    .sort((a, b) => b.coverage - a.coverage);
}

/** Nearest text messages by meaning; status says why there are none when vectors are unavailable. */
async function semanticSearch(
  db: DB,
  projectId: string,
  text: string,
  o: { all_projects?: boolean; exclude_session_id?: string; maxDistance: number; limit: number; timeoutMs: number },
): Promise<{ hits: Hit[]; status: string }> {
  let vectorHits;
  try {
    vectorHits = await searchVectors(text, {
      projectId: o.all_projects ? undefined : projectId,
      excludeSessionId: o.exclude_session_id,
      limit: o.limit * 3, // room for the length filter below
      timeoutMs: o.timeoutMs,
    });
  } catch (e) {
    return { hits: [], status: `unavailable: ${(e as Error).message.slice(0, 120)}` };
  }
  const close = vectorHits.filter((h) => h.distance <= o.maxDistance);
  if (!close.length) return { hits: [], status: "ok" };

  const rows = db
    .prepare(
      `SELECT ${RESULT_COLS}, m.content FROM messages m ${RESULT_JOINS}
       WHERE m.id IN (${close.map(() => "?").join(",")}) AND m.kind = 'text' AND length(m.content) >= ?`,
    )
    .all(...close.map((h) => h.id), SEMANTIC_MIN_CHARS) as ({ id: number; content: string } & Record<string, unknown>)[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const hits = close.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    const { content, ...r } = row;
    const snippet = content.slice(0, 300).replace(/\s+/g, " ") + (content.length > 300 ? "…" : "");
    return [{ ...r, snippet, distance: Math.round(h.distance * 1000) / 1000 }];
  });
  return { hits: hits.slice(0, o.limit), status: "ok" };
}

/** Reciprocal rank fusion of ranked lists, keyed by message id. */
function fuse(lists: Record<string, Hit[]>, limit: number): Fused[] {
  const merged = new Map<number, { hit: Fused; score: number }>();
  for (const [name, hits] of Object.entries(lists)) {
    hits.forEach((hit, rank) => {
      const seen = merged.get(hit.id);
      if (seen) {
        seen.score += 1 / (RRF_K + rank + 1);
        seen.hit = { ...hit, ...seen.hit, match: [...seen.hit.match, name] };
      } else {
        merged.set(hit.id, { hit: { ...hit, match: [name] }, score: 1 / (RRF_K + rank + 1) });
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit: { id: _id, ...rest } }) => rest as Fused);
}

export function getSession(
  db: DB,
  projectId: string,
  o: {
    session_id: string;
    around_uuid?: string;
    window?: number;
    offset?: number;
    limit?: number;
    include_tools?: boolean;
    all_projects?: boolean;
  },
) {
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(o.session_id) as
    | { project_id: string }
    | undefined;
  if (!session || (!o.all_projects && session.project_id !== projectId)) {
    return { error: `session not found in this project: ${o.session_id}` };
  }

  const kindFilter = o.include_tools ? "" : "AND kind = 'text'";
  const cols = "uuid, role, kind, timestamp, substr(git_commit, 1, 12) AS git_commit, content";
  if (o.around_uuid) {
    const anchor = db
      .prepare("SELECT id FROM messages WHERE uuid = ? AND session_id = ?")
      .get(o.around_uuid, o.session_id) as { id: number } | undefined;
    if (!anchor) return { error: `message not found: ${o.around_uuid}` };
    const window = o.window ?? 10;
    const before = db
      .prepare(`SELECT ${cols} FROM messages WHERE session_id = ? AND id < ? ${kindFilter} ORDER BY id DESC LIMIT ?`)
      .all(o.session_id, anchor.id, window)
      .reverse();
    const rest = db
      .prepare(`SELECT ${cols} FROM messages WHERE session_id = ? AND id >= ? ${kindFilter} ORDER BY id LIMIT ?`)
      .all(o.session_id, anchor.id, window + 1);
    return { session, messages: [...before, ...rest] };
  }
  const messages = db
    .prepare(`SELECT ${cols} FROM messages WHERE session_id = ? ${kindFilter} ORDER BY id LIMIT ? OFFSET ?`)
    .all(o.session_id, o.limit ?? 50, o.offset ?? 0);
  return { session, messages };
}

export function listSessions(
  db: DB,
  projectId: string,
  o: { title_contains?: string; all_projects?: boolean; limit?: number },
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!o.all_projects) {
    where.push("s.project_id = ?");
    params.push(projectId);
  }
  if (o.title_contains) {
    where.push("s.title LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(o.title_contains)}%`);
  }
  return db
    .prepare(
      `SELECT s.session_id, s.title, p.name AS project, s.cwd, s.git_branch, s.started_at, s.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id) AS message_count,
              (SELECT substr(m.git_commit, 1, 12) FROM messages m WHERE m.session_id = s.session_id
               ORDER BY m.id LIMIT 1) AS first_commit,
              (SELECT substr(m.git_commit, 1, 12) FROM messages m WHERE m.session_id = s.session_id
               ORDER BY m.id DESC LIMIT 1) AS last_commit
       FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(...params, o.limit ?? 20);
}

/** Deletes a session only if it belongs to the project. */
export function deleteSession(db: DB, projectId: string, sessionId: string) {
  return db.transaction(() => {
    const owned = db
      .prepare("SELECT 1 FROM sessions WHERE session_id = ? AND project_id = ?")
      .get(sessionId, projectId);
    if (!owned) return { error: `session not found in this project: ${sessionId}` };
    const deleted = db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId).changes;
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    return { session_id: sessionId, deleted_messages: deleted };
  })();
}

const RESULT_COLS = `m.id, m.uuid, m.session_id, s.title, p.name AS project, m.role, m.timestamp, m.git_branch,
  substr(m.git_commit, 1, 12) AS git_commit`;
const RESULT_JOINS = `LEFT JOIN sessions s ON s.session_id = m.session_id
                      LEFT JOIN projects p ON p.id = m.project_id`;

function addFilters(
  where: string[],
  params: unknown[],
  projectId: string,
  o: { include_tools?: boolean; all_projects?: boolean; exclude_session_id?: string },
) {
  if (!o.include_tools) where.push("m.kind = 'text'");
  if (!o.all_projects) {
    where.push("m.project_id = ?");
    params.push(projectId);
  }
  if (o.exclude_session_id) {
    where.push("m.session_id != ?");
    params.push(o.exclude_session_id);
  }
}

/**
 * Distinct trigrams of the text's word-ish runs (whitespace/punctuation split), lowercased.
 * All-hiragana trigrams are mostly Japanese function words (「ってどう」「たっけ」), so they are skipped.
 */
function trigrams(text: string, max = 64): string[] {
  const set = new Set<string>();
  for (const run of text.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    const cs = [...run];
    for (let i = 0; i + 3 <= cs.length; i++) {
      const g = cs.slice(i, i + 3).join("");
      if (!/^\p{Script=Hiragana}+$/u.test(g)) set.add(g);
    }
  }
  return [...set].slice(0, max);
}

/** ~300 chars of content around the densest trigram hit. */
function excerpt(content: string, grams: string[], width = 300) {
  const lower = content.toLowerCase();
  const first = Math.min(...grams.map((g) => lower.indexOf(g)).filter((i) => i >= 0));
  const start = Math.max(0, (Number.isFinite(first) ? first : 0) - 60);
  const s = content.slice(start, start + width).replace(/\s+/g, " ");
  return (start > 0 ? "…" : "") + s + (start + width < content.length ? "…" : "");
}
