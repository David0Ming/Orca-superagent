import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterWake } from '../src/router.ts'
import { Store } from '../src/store.ts'

const cleanups: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup() })
function fixture() {
  let now = Date.now()
  vi.spyOn(Date,'now').mockImplementation(()=>now)
  const dir = mkdtempSync(join(tmpdir(), 'router-wake-')), path = join(dir, 'fake.json'), cli = join(dir, 'orca')
  const store = new Store(join(dir, 'state.db'))
  const update = (value: object) => writeFileSync(path, JSON.stringify(value))
  const state = () => JSON.parse(readFileSync(path, 'utf8'))
  update({ calls: [], terminal: { handle: 'term_router', ptyId: 'pty', incarnationId: 'incarnation', worktreeId: 'worktree', worktreePath: dir, executionHostId: 'local', agentIdentity: 'codex', connected: true }, runtimeId: 'runtime' })
  writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs'), path=${JSON.stringify(path)};
const s=JSON.parse(fs.readFileSync(path)), args=process.argv.slice(2); s.calls.push(args);
let result;
if(args[0]==='terminal' && args[1]==='show') result={terminal:s.terminal};
else if(args[1]==='request-show') result=s.receipt?{state:'completed',receipt:s.receipt}:{state:s.pending?'pending':'absent'};
else if(args[1]==='send') { s.sends=(s.sends||0)+1; s.receipt={message:{id:'message'},mutation:{requestId:args[args.indexOf('--retry-request')+1]}}; result=s.receipt; }
else process.exit(9);
fs.writeFileSync(path,JSON.stringify(s));
if(args[1]==='send' && s.drop) process.exit(1);
console.log(JSON.stringify({ok:true,result,_meta:{runtimeId:s.runtimeId}}));
`, { mode: 0o700 })
  const rpc = vi.fn(async (method: string) => ({ ok: true, _meta: {runtimeId: state().runtimeId}, result: method === 'session.tabs.list'
    ? {worktree: 'worktree', tabs: state().missingSession ? [] : [{type: 'agent-session', id: 'chat', sessionId: 'claude_router'}]}
    : {ok: true, page: {sessionId: 'claude_router', fence: 1}} }))
  const wake = new RouterWake(store, { cli, repository: dir, osaCommand: 'osa --state private', sessionRpc: rpc })
  const bind = () => wake.bind('term_router', undefined, 'claude_router')
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, wake, bind, state, update, advance: () => {now += 15_001} }
}

test('explicit exact binding; native attention deduplicates pending work without terminal input or lease changes', async () => {
  const f = fixture()
  f.store.put('candidate', 'one', { evalId: 'one' })
  await f.wake.tick()
  expect(f.state().calls).toEqual([])
  f.store.put('router', 'lease', { token: 'owner', expires: 123 })
  await f.bind()
  await Promise.all([f.wake.tick(), f.wake.tick()])
  await f.wake.tick()
  expect(f.state().sends).toBe(1)
  expect(f.state().calls.find((a: string[]) => a[1] === 'send')).toContain('orca_session_id:claude_router')
  expect(f.state().calls.some((a: string[]) => a[0] === 'terminal' && a[1] !== 'show')).toBe(false)
  expect(f.store.get('router', 'lease')).toEqual({ token: 'owner', expires: 123 })
  f.store.delete('candidate', 'one')
  await f.wake.tick()
  f.store.put('candidate', 'one', { evalId: 'one' })
  await f.wake.tick()
  expect(f.state().sends).toBe(2)
  f.wake.unbind()
  await f.wake.tick()
  expect(f.state().sends).toBe(2)
})

test('lost receipt reconciles after restart without duplicate send', async () => {
  const f = fixture()
  await f.bind()
  f.store.put('notice', 'work', { id: 'work', text: 'attention' })
  f.update({ ...f.state(), drop: true })
  await f.wake.tick()
  expect(f.store.list<any>('router-wake')[0].attempted).toBe(true)
  expect(f.store.list<any>('router-wake')[0].receipt).toBeUndefined()
  f.advance()
  await f.wake.tick()
  expect(f.state().sends).toBe(1)
  expect(f.store.list<any>('router-wake')[0].receipt.message.id).toBe('message')
})

test.each(['incarnation', 'runtime'])('fails closed on %s without another submission', async kind => {
  const f = fixture()
  await f.bind()
  f.store.put('candidate', 'one', { evalId: 'one' })
  if (kind === 'runtime') f.update({ ...f.state(), runtimeId: 'restarted' })
  else f.update({ ...f.state(), terminal: { ...f.state().terminal, incarnationId: 'replacement' } })
  const sends = f.state().sends ?? 0
  await f.wake.tick()
  expect(f.state().sends ?? 0).toBe(sends)
  expect(f.store.get<any>('notice', 'router-wake').text).toMatch(/changed|uncertain/)
})

test('absent attention request retries the same ID only on the same identity, with backoff', async () => {
  const f = fixture(); await f.bind()
  f.store.put('candidate','one',{evalId:'one'})
  f.update({...f.state(),drop:true}); await f.wake.tick()
  const requestId=f.store.list<any>('router-wake')[0].requestId
  f.update({...f.state(),receipt:undefined,drop:false})
  await f.wake.tick(); expect(f.state().sends).toBe(1)
  f.advance(); await f.wake.tick()
  expect(f.state().sends).toBe(2)
  expect(f.store.list<any>('router-wake')[0].receipt.mutation.requestId).toBe(requestId)
  expect(f.store.list<any>('router-wake')[0].error).toBeUndefined()
})

test('remote, stale and foreign terminal bindings are refused', async () => {
  const f = fixture(), original = f.state()
  for (const patch of [{ executionHostId: 'remote' }, { connected: false }, { worktreePath: tmpdir() }, { incarnationId: '' }]) {
    f.update({ ...original, terminal: { ...original.terminal, ...patch } })
    await expect(f.bind()).rejects.toThrow()
    expect(f.store.get('router', 'terminal')).toBeUndefined()
  }
})

test('regression: disconnected Router remains visible after successful attention receipt', async () => {
  const f = fixture(); await f.bind()
  f.store.put('candidate', 'one', { evalId: 'one' }); await f.wake.tick()
  expect(f.state().sends).toBe(1)
  f.update({ ...f.state(), terminal: { ...f.state().terminal, connected: false } }); f.advance()
  await f.wake.tick()
  expect(f.store.get('notice', 'router-wake')).toBeDefined()
})

test('legacy bindings never wake through PTY; missing structured tabs preserve work', async () => {
  const f = fixture()
  await f.wake.bind('term_router')
  f.store.put('candidate', 'pending', {evalId: 'pending'})
  await f.wake.tick()
  expect(f.state().sends).toBeUndefined()
  expect(f.store.get<any>('router', 'health').state).toBe('migration-required')
  await f.bind()
  f.update({...f.state(), missingSession: true})
  await f.wake.tick()
  expect(f.state().sends).toBeUndefined()
  expect(f.store.list('candidate')).toHaveLength(1)
})

test('draining a batch does not generate more hints and newly added work coalesces', async () => {
  const f=fixture(); await f.bind()
  f.store.put('notice','a',{id:'a',text:'first'}); f.store.put('notice','b',{id:'b',text:'second'})
  await f.wake.tick(); expect(f.state().sends).toBe(1)
  f.store.delete('notice','a'); f.advance(); await f.wake.tick()
  expect(f.state().sends).toBe(1)
  f.store.put('notice','c',{id:'c',text:'third'}); await f.wake.tick()
  expect(f.state().sends).toBe(2)
  f.store.put('notice','d',{id:'d',text:'fourth'}); await f.wake.tick()
  expect(f.state().sends).toBe(2)
  f.advance(); await f.wake.tick(); expect(f.state().sends).toBe(3)
})


test('unchanged unhandled work is reminded after five minutes, timestamp-only observations do not flood', async () => {
  const f=fixture(); await f.bind()
  f.store.put('notice','pending',{id:'pending',text:'Needs action',observedAt:1}); await f.wake.tick()
  for(let i=0;i<19;i++) {f.advance(); f.store.put('notice','pending',{id:'pending',text:'Needs action',observedAt:i+2}); await f.wake.tick()}
  expect(f.state().sends).toBe(1)
  f.advance(); await f.wake.tick(); expect(f.state().sends).toBe(2)
  f.store.delete('notice','pending'); f.advance(); await f.wake.tick(); expect(f.state().sends).toBe(2)
})
