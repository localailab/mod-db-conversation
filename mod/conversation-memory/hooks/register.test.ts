import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CLI = '/opt/memory/dist/cli.js'
const OPTIONS = { options: { cliPath: CLI, nodePath: 'node', autoContext: true } }

type Run = { argv: readonly string[]; stdin: any; env?: Record<string, string> }

// Stands in for the session and the memory core CLI; records each CLI run.
function host(on: On, reply: (command: string, stdin: any) => unknown) {
  const runs: Run[] = []
  on('session.root', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'current-session' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ? JSON.parse(e.init.stdin) : undefined
    runs.push({ argv: e.argv, stdin, env: e.init?.env })
    const out = JSON.stringify(reply(String(e.argv[2]), stdin))
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return runs
}

describe('saving', () => {
  test('Stop ingests the transcript through the CLI, then again for the final reply', OPTIONS, async ($, on) => {
    const runs = host(on, () => ({ inserted: 2 }))
    const delays: number[] = []
    on('classic.Stop', () => ({}))
    // answering the timer runs its callback at once
    on('clock.after', ($, e) => {
      delays.push((e as any).ms)
      return { value: undefined }
    })
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl', cwd: '/repo' } as any)
    expect(runs.length).toBe(2)
    for (const run of runs) {
      expect(run.argv).toEqual(['node', CLI, 'ingest'])
      expect(run.stdin).toEqual({ transcript_path: '/t/s.jsonl', cwd: '/repo', root: '/repo' })
    }
  })

  test('without Ollama the save still counts, and the status line says vectors wait', OPTIONS, async ($, on) => {
    const runs: Run[] = []
    const statuses: unknown[] = []
    on('session.root', () => ({ value: '/repo' }))
    on('ui.status', ($, e) => {
      statuses.push(e)
      return { value: undefined }
    })
    on('process.run', ($, e) => {
      runs.push({ argv: e.argv, stdin: undefined })
      const out = JSON.stringify({ inserted: 4, embedded: 0, pending: 4, embed_error: 'fetch failed' })
      return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('classic.Stop', () => ({}))
    on('clock.after', () => ({ value: undefined }))
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl', cwd: '/repo' } as any)
    const shown = JSON.stringify(statuses)
    expect(shown).toContain('wait for Ollama')
    expect(shown).not.toContain('save failed')
  })
})

describe('tools', () => {
  test('search runs the CLI scoped to the project, excluding this session', OPTIONS, async ($, on) => {
    const runs = host(on, () => ({ project: 'repo', results: [{ uuid: 'u1', snippet: 'JWT' }] }))
    const r: any = await $.tool.call({ tool: 'mcp__conversation-memory__search', query: '認証 JWT', limit: 5 } as any)
    expect(runs[0]!.argv).toEqual(['node', CLI, 'search'])
    expect(runs[0]!.stdin).toEqual({ cwd: '/repo', query: '認証 JWT', limit: 5, exclude_session_id: 'current-session' })
    expect(String(r.result)).toContain('"uuid": "u1"')
  })

  test('delete is refused when the question is dismissed', OPTIONS, async ($, on) => {
    const runs = host(on, () => ({ deleted_messages: 3 }))
    // $.ui.ask rides a tool.call of AskUserQuestion; refusing it is a dismissed dialog
    on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))
    const r: any = await $.tool.call({ tool: 'mcp__conversation-memory__delete_session', session_id: 's1' } as any)
    expect(runs.length).toBe(0)
    expect(String(r.deny ?? r.text)).toContain('did not confirm')
  })
})

describe('related context on prompts', () => {
  const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as any

  test('attaches related excerpts to a prompt', OPTIONS, async ($, on) => {
    const runs = host(on, () => ({
      project: 'repo',
      results: [{ timestamp: '2026-07-12T00:00:00Z', role: 'assistant', title: 'Auth', snippet: 'session方式を採用', session_id: 's1', uuid: 'u1' }],
    }))
    let context: readonly string[] | undefined
    on('prompt.submit', ($, e) => {
      context = e.context
      return { text: e.text, context: e.context }
    })
    await $.prompt.submit(prompt('前に決めた認証方式ってどうなってた？'))
    expect(runs[0]!.argv[2]).toBe('related')
    expect(runs[0]!.stdin.exclude_session_id).toBe('current-session')
    expect(context?.length).toBe(1)
    expect(context![0]).toContain('session方式を採用')
    expect(context![0]).toContain('session_id=s1, uuid=u1')
  })

  test('leaves short prompts and slash commands alone', OPTIONS, async ($, on) => {
    const runs = host(on, () => ({ results: [] }))
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.prompt.submit(prompt('ok'))
    await $.prompt.submit(prompt('/recall 認証方式について'))
    expect(runs.length).toBe(0)
  })
})

describe('finding the core', () => {
  test('uses the repository dist/cli.js when cliPath is empty', { options: { cliPath: '' } }, async ($, on) => {
    const runs = host(on, () => ({ project: 'repo', results: [] }))
    await $.tool.call({ tool: 'mcp__conversation-memory__search', query: 'x' } as any)
    expect(runs[0]!.argv[1]).toMatch(/\/mod\/conversation-memory\/\.\.\/\.\.\/dist\/cli\.js$|\/\.\.\/\.\.\/dist\/cli\.js$/)
  })
})

describe('outside a git repository', () => {
  test('the status line says nothing was saved', OPTIONS, async ($, on) => {
    const statuses: unknown[] = []
    on('session.root', () => ({ value: '/tmp' }))
    on('ui.status', ($, e) => {
      statuses.push(e)
      return { value: undefined }
    })
    on('process.run', () => {
      const out = JSON.stringify({ inserted: 0, skipped: 3, embedded: 0, pending: 0 })
      return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('clock.after', () => ({ value: undefined }))
    on('classic.Stop', () => ({}))
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl', cwd: '/tmp' } as any)
    expect(JSON.stringify(statuses)).toContain('not saved: works only in a git repository')
  })
})

describe('storage mode', () => {
  test('shared is the default and reaches the CLI', OPTIONS, async ($, on) => {
    const runs = host(on, () => ({ project: 'repo', results: [] }))
    await $.tool.call({ tool: 'mcp__conversation-memory__search', query: 'x' } as any)
    expect(runs[0]!.env).toEqual({ CONV_MEMORY_STORAGE: 'shared' })
  })

  test('repo mode reaches every CLI run, and saving names the session root', { options: { ...OPTIONS.options, storage: 'repo' } }, async ($, on) => {
    const runs = host(on, () => ({ inserted: 1, project: 'repo', results: [] }))
    on('classic.Stop', () => ({}))
    on('clock.after', () => ({ value: undefined }))
    // the hook's cwd may be a subfolder; the DB is picked by the session root
    await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl', cwd: '/repo/src' } as any)
    await $.tool.call({ tool: 'mcp__conversation-memory__search', query: 'x' } as any)
    expect(runs.length).toBeGreaterThan(1)
    for (const run of runs) expect(run.env).toEqual({ CONV_MEMORY_STORAGE: 'repo' })
    expect(runs[0]!.stdin).toEqual({ transcript_path: '/t/s.jsonl', cwd: '/repo/src', root: '/repo' })
  })
})
