import type { EngineInterface, Register } from 'claude-code'

// The memory itself (SQLite, transcript ingest, project-scoped search) lives in the
// mod-db-conversation core; this mod wires it into Claude Code by running its CLI.
//   save:    classic Stop / PreCompact / SessionEnd  → cli ingest
//   search:  tools for Claude, /recall for the person, related excerpts on each prompt

const TOOL = (name: string) => `mcp__conversation-memory__${name}`
const PROMPT_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

type Json = Record<string, any>

// Set from the plugin's options each time the module loads.
let node = 'node'
let cli = ''
let autoContext = true

// Without a configured cliPath, the core is found relative to this mod: <repo>/mod/conversation-memory → <repo>/dist/cli.js
function cliPath($: EngineInterface) {
  return cli || `${$.plugin.root}/../../dist/cli.js`
}

async function core($: EngineInterface, command: string, input: Json, timeoutMs = 15_000): Promise<Json> {
  const r = await $.process.run([node, cliPath($), command], { stdin: JSON.stringify(input), timeoutMs })
  try {
    return JSON.parse(r.stdout)
  } catch {
    return { error: (r.stderr || r.stdout).trim().slice(0, 500) || `exit ${r.exitCode}` }
  }
}

const shortCommit = (c: string | null) => (c ? c.slice(0, 7) : 'before first commit')
const commitRange = (first: string | null, last: string | null) =>
  first === last ? `at ${shortCommit(first)}` : `${shortCommit(first)}..${shortCommit(last)}`

// Every call is scoped to the session's project; the core derives the project id from this path.
async function where($: EngineInterface) {
  return { cwd: await $.session.root() }
}

async function ingest($: EngineInterface, e: { transcript_path: string; cwd: string }) {
  try {
    const r = await core($, 'ingest', { transcript_path: e.transcript_path, cwd: e.cwd })
    // Saving works without Ollama; only the vectors for meaning-based search wait for it.
    $.ui.status(
      r.error
        ? `save failed: ${r.error.slice(0, 80)}`
        : r.skipped && !r.inserted
          ? 'not saved: works only in a git repository with at least one commit'
          : r.embed_error
          ? `saved; ${r.pending} message(s) wait for Ollama (semantic search): ${r.embed_error.slice(0, 60)}`
          : undefined,
    )
  } catch (err) {
    $.ui.status(`save failed: ${String(err).slice(0, 80)}`)
  }
}

export const register: Register = (on, options) => {
  node = String(options.nodePath ?? 'node')
  cli = String(options.cliPath ?? '')
  autoContext = options.autoContext !== false

  on('classic.Stop', async ($, e, next) => {
    await ingest($, e)
    // Stop fires just before the turn's final reply reaches the transcript file,
    // so look again shortly after to save that reply in this turn, not the next.
    $.clock.after(3_000, () => ingest($, e))
    return next(e)
  })
  on('classic.PreCompact', async ($, e, next) => {
    await ingest($, e)
    return next(e)
  })
  on('classic.SessionEnd', async ($, e, next) => {
    await ingest($, e)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    // Load the embedding model in Ollama now, so the first prompt's search is not the slow one.
    void core($, 'warm', {}, 60_000).catch(() => {})
    await $.tool.register({
      name: 'search',
      description:
        "Search past Claude Code conversations of this project (saved automatically). Use when the user refers to " +
        'something discussed before, or when earlier decisions would help. Hybrid: keyword substring match ' +
        '(space-separated terms ANDed, works for Japanese) plus meaning-based match, so 1-3 keywords or a short ' +
        'phrase both work. Each result says how it matched; semantic hits carry a cosine distance (lower is closer). ' +
        'git_commit is the commit the conversation was based on (null: before the first commit); ' +
        'inspect it with git show or git diff when the code of that time matters. ' +
        'Returns snippets with session_id and uuid; ' +
        `read the surrounding conversation with ${TOOL('get_session')}.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords (space-separated) or a short phrase' },
          include_tools: { type: 'boolean', description: 'Also search tool calls/results (default false)' },
          all_projects: { type: 'boolean', description: 'Search every project, only when the user asks (default false)' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10' },
        },
        required: ['query'],
      },
    })
    await $.tool.register({
      name: 'get_session',
      description:
        'Read a saved conversation in order, each message with the git_commit it was based on ' +
        'and, for assistant messages, the model that wrote it. ' +
        'Pass around_uuid from a search result to get the messages around it.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          around_uuid: { type: 'string' },
          window: { type: 'integer', minimum: 1, maximum: 100, description: 'Messages before/after around_uuid (default 10)' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
          include_tools: { type: 'boolean' },
          all_projects: { type: 'boolean' },
        },
        required: ['session_id'],
      },
    })
    await $.tool.register({
      name: 'list_sessions',
      description:
        'List saved conversations of this project, newest first, with titles and the commits they spanned ' +
        '(first_commit, last_commit).',
      inputSchema: {
        type: 'object',
        properties: {
          title_contains: { type: 'string' },
          all_projects: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20' },
        },
      },
    })
    await $.tool.register({
      name: 'delete_session',
      description: 'Permanently delete a saved conversation of this project. Only when the user asks for it.',
      inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
    })
    await $.command.register({
      name: 'recall',
      description: 'Search past conversations of this project (no keywords: list recent ones)',
      argumentHint: '[keywords]',
    })
    return next(e)
  })

  // Tool arguments arrive as fields of e, beside the envelope's own (tool, tool_use_id, ...).
  const pick = (e: Json, keys: string[]) =>
    Object.fromEntries(keys.filter(k => e[k] !== undefined).map(k => [k, e[k]]))
  const answer = (r: Json) => ({ result: JSON.stringify(r, null, 2) })

  on('tool.call', { tool: 'mcp__conversation-memory__search' }, async ($, e) => {
    const input = pick(e, ['query', 'include_tools', 'all_projects', 'limit'])
    return answer(await core($, 'search', { ...(await where($)), ...input, exclude_session_id: await $.session.id() }))
  })
  on('tool.call', { tool: 'mcp__conversation-memory__get_session' }, async ($, e) => {
    const input = pick(e, ['session_id', 'around_uuid', 'window', 'offset', 'limit', 'include_tools', 'all_projects'])
    return answer(await core($, 'get', { ...(await where($)), ...input }))
  })
  on('tool.call', { tool: 'mcp__conversation-memory__list_sessions' }, async ($, e) => {
    const input = pick(e, ['title_contains', 'all_projects', 'limit'])
    return answer(await core($, 'list', { ...(await where($)), ...input }))
  })
  on('tool.call', { tool: 'mcp__conversation-memory__delete_session' }, async ($, e) => {
    // A plugin's own tool skips the permission prompt, so the person confirms here.
    let choice = 'Keep'
    try {
      choice = await $.ui.ask(`Delete saved conversation ${e.session_id} from memory?`, ['Delete', 'Keep'])
    } catch {
      // dismissed, or nobody to ask (claude -p)
    }
    if (choice !== 'Delete') return { deny: 'The user did not confirm deleting this conversation.' }
    return answer(await core($, 'delete', { ...(await where($)), session_id: e.session_id }))
  })

  on('command.run', { command: 'recall' }, async ($, e) => {
    const query = e.args.trim()
    if (!query) {
      const r = await core($, 'list', { ...(await where($)), limit: 15 })
      if (r.error) return { text: `recall: ${r.error}` }
      const lines = r.sessions.map(
        (s: Json) =>
          `- ${String(s.updated_at ?? '').slice(0, 10)}  ${s.title ?? '(untitled)'}  ` +
          `(${s.message_count} msgs, ${commitRange(s.first_commit, s.last_commit)}, ${s.session_id})`,
      )
      return { text: `${r.project.name}: ${r.sessions.length} saved conversations\n${lines.join('\n')}` }
    }
    const r = await core($, 'search', { ...(await where($)), query, limit: 10 })
    if (r.error) return { text: `recall: ${r.error}` }
    if (!r.results.length) return { text: `${r.project}: nothing found for "${query}"` }
    const lines = r.results.map(
      (m: Json) =>
        `- ${String(m.timestamp ?? '').slice(0, 10)} [${m.role}] ${m.title ?? ''} (${m.match.join('+')})\n` +
        `  ${String(m.snippet).replace(/\s+/g, ' ')}\n` +
        `  (commit ${shortCommit(m.git_commit)}, session ${m.session_id}, uuid ${m.uuid})`,
    )
    const semanticNote = r.semantic === 'ok' ? '' : `\n(semantic search ${r.semantic}; keyword matches only)`
    return { text: `${r.project}: ${r.results.length} hits for "${query}"\n${lines.join('\n')}${semanticNote}` }
  })

  // Attach closely related excerpts from earlier conversations to the person's prompts.
  on('prompt.submit', async ($, e, next) => {
    if (!autoContext || !PROMPT_ORIGINS.has(e.origin.kind)) return next(e)
    const text = e.text.trim()
    if (text.startsWith('/') || [...text].length < 8) return next(e)
    try {
      const r = await core(
        $,
        'related',
        { ...(await where($)), text: text.slice(0, 2000), exclude_session_id: await $.session.id(), limit: 3 },
        5_000,
      )
      if (!r.results?.length) return next(e)
      const lines = r.results.map(
        (m: Json) =>
          `- ${String(m.timestamp ?? '').slice(0, 10)} ${m.role} in "${m.title ?? 'untitled'}": ${m.snippet} ` +
          `(session_id=${m.session_id}, uuid=${m.uuid})`,
      )
      const note =
        'Possibly related excerpts from earlier conversations in this project, found automatically by ' +
        'conversation-memory. They may be outdated or irrelevant; ignore them unless they help. ' +
        `Use ${TOOL('get_session')} with session_id and around_uuid to read more.\n` +
        lines.join('\n')
      $.ui.log(`attached ${r.results.length} related past message(s)`)
      return next({ ...e, context: [...(e.context ?? []), note] })
    } catch {
      return next(e)
    }
  })
}
