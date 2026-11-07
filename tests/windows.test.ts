import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/store.ts'
import { Windows } from '../src/windows.ts'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture() {
  const store = new Store(':memory:'); stores.push(store)
  store.put('project', 'p', { id: 'p', name: 'Project' })
  store.put('component', 'c', { id: 'c', projectId: 'p' })
  store.put('location', 'l', { id: 'l', componentId: 'c', hostId: 'local', repository: '/repo' })
  store.put('core.ticket', 't', { id: 't', assignments: [], inputs: [], undelivered: [], origin: { triggerIds: [] } })
  store.put('ticket-target', 't', { ticketId: 't', projectId: 'p', componentId: 'c', locationId: 'l', hostId: 'local', repository: '/repo', kind: 'git', boundAt: 'now' })
  const run = vi.fn(async (args: string[]): Promise<any> => {
    if (args[0] === 'worktree') return { worktrees: [], truncated: false }
    if (args[1] === 'list') return { terminals: [{ handle: 'terminal-1', worktreeId: 'wt', title: 'Shell' }], truncated: false }
    if (args[1] === 'read') return { screen: 'Visible output' }
    if (args[1] === 'switch') return { navigated: true }
    throw new Error('unexpected CLI call')
  })
  const rpc = vi.fn(async (method: string, _params?: any): Promise<any> => method === 'session.tabs.list'
    ? { result: { worktree: 'wt', tabs: [{ type: 'agent-session', sessionId: 'session-1', title: 'Chat', chatStatus: { state: 'working' } }, { type: 'markdown', title: 'Document' }] } }
    : { result: { ok: true, page: { sessionId: 'session-1', items: [{ text: 'Latest message' }] } } })
  const windows = new Windows(store, '/fake/orca', rpc, run)
  return { store, windows, rpc, run }
}

it('lists only registered workspaces and links explicit windows without creating or messaging agents', async () => {
  const f = fixture(), result = await f.windows.list({ project: 'p' })
  expect(result.windows).toHaveLength(2)
  expect(f.run.mock.calls[0][0]).toEqual(['worktree', 'list', '--repo', 'path:/repo', '--limit', '100'])
  expect(f.run.mock.calls[1][0]).toEqual(['terminal', 'list', '--worktree', 'path:/repo', '--limit', '100'])
  const link = await f.windows.link({ ticket: 't', session: 'session-1' })
  expect(link).toMatchObject({ ticketId: 't', sessionId: 'session-1', worktreeId: 'wt' })
  expect(f.store.get('linked-window', 't:session-1')).toEqual(link)
  expect(f.run.mock.calls.every(([args]) => args[1] === 'list')).toBe(true)
  expect(f.store.tickets.get('t')!.inputs).toEqual([])
  await expect(f.windows.link({ ticket: 't', session: 'not-visible' })).rejects.toThrow('not uniquely visible')
  await expect(f.windows.link({ ticket: 't', session: 'session-1', terminal: 'terminal-1' })).rejects.toThrow('exactly one')
})

it('reads linked history on demand without saving it and reports unsupported chat navigation', async () => {
  const f = fixture()
  await f.windows.link({ ticket: 't', session: 'session-1' })
  const observed = await f.windows.observe({ ticket: 't', session: 'session-1' })
  expect(observed.source).toContain('not task or business status')
  expect(observed.observation.items[0].text).toBe('Latest message')
  expect(f.rpc.mock.calls.at(-1)).toEqual(['agentSession.history', { sessionId: 'session-1', direction: 'tail', limit: 20 }])
  expect(JSON.stringify(f.store.list('linked-window'))).not.toContain('Latest message')
  expect(await f.windows.open({ ticket: 't', session: 'session-1' })).toMatchObject({ navigated: false })
  expect(f.run.mock.calls.every(([args]) => args[1] === 'list')).toBe(true)
})

it('opens and observes only a linked terminal and preserves Orca navigation result', async () => {
  const f = fixture()
  await expect(f.windows.open({ ticket: 't', terminal: 'terminal-1' })).rejects.toThrow('not linked')
  await f.windows.link({ ticket: 't', terminal: 'terminal-1' })
  expect((await f.windows.observe({ ticket: 't', terminal: 'terminal-1' })).observation).toEqual({ screen: 'Visible output' })
  expect(await f.windows.open({ ticket: 't', terminal: 'terminal-1' })).toMatchObject({ navigated: true })
  expect(f.run.mock.calls.map(([args]) => args).filter(args => args[1] !== 'list')).toEqual([
    ['terminal', 'read', '--terminal', 'terminal-1', '--screen', '--limit', '1000'],
    ['terminal', 'switch', '--terminal', 'terminal-1'],
  ])
})

it('surfaces missing host observations and rejects cross-project or stale links', async () => {
  const f = fixture()
  f.store.put('project', 'other', { id: 'other', name: 'Other' })
  await expect(f.windows.list({ ticket: 't', project: 'other' })).rejects.toThrow('does not belong')
  await f.windows.link({ ticket: 't', session: 'session-1' })
  f.rpc.mockRejectedValue(new Error('host offline'))
  const result = await f.windows.list({ ticket: 't' })
  expect(result.errors[0].source).toBe('Orca session tabs')
  await expect(f.windows.observe({ ticket: 't', session: 'session-1' })).rejects.toThrow('no longer visible')
})


it('discovers and links existing Orca worktrees only for the registered project', async () => {
  const f = fixture()
  f.store.put('project', 'foreign', { id: 'foreign', name: 'Foreign' })
  f.store.put('component', 'other', { id: 'other', projectId: 'foreign' })
  f.store.put('location', 'other', { componentId: 'other', hostId: 'local', repository: '/foreign' })
  f.run.mockImplementation(async args => {
    if (args[0] === 'worktree') return { worktrees: [{ id: 'repo::/repo', path: '/repo' }, { id: 'repo::/existing', path: '/existing' }], truncated: true }
    if (args[0] === 'terminal') return { terminals: [], truncated: false }
    throw new Error('unexpected CLI call')
  })
  f.rpc.mockImplementation(async (method, params: any) => ({ result: { worktree: params.worktree.slice(3), tabs: params.worktree === 'id:repo::/existing'
    ? [{ type: 'agent-session', sessionId: 'existing', title: 'Existing agent' }] : [] } }))
  const listing = await f.windows.list({ ticket: 't' })
  expect(listing.truncated).toBe(true)
  expect(listing.windows).toMatchObject([{ sessionId: 'existing', worktreeId: 'repo::/existing' }])
  expect(f.run.mock.calls.map(([args]) => args)).toContainEqual(['worktree', 'list', '--repo', 'path:/repo', '--limit', '100'])
  expect(f.run.mock.calls.every(([args]) => !args.includes('path:/foreign'))).toBe(true)
  expect(await f.windows.link({ ticket: 't', session: 'existing' })).toMatchObject({ worktreeId: 'repo::/existing' })
})

it('reports worktree discovery errors while retaining direct workspace observations', async () => {
  const f = fixture()
  f.run.mockImplementation(async args => {
    if (args[0] === 'worktree') throw new Error('unavailable')
    return { terminals: [], truncated: false }
  })
  const listing = await f.windows.list({ ticket: 't' })
  expect(listing.errors).toMatchObject([{ workspace: 'path:/repo', source: 'Orca worktree list' }])
  expect(listing.windows).toMatchObject([{ sessionId: 'session-1' }])
})
