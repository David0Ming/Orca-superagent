import { afterEach, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { App } from '../src/app.ts'
import { Publisher } from '../src/publish.ts'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'osa-publish-')), repo = join(dir, 'repo'), remote = join(dir, 'remote.git')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'README.md'), 'test\n'); git('add', '.'); git('commit', '-m', 'initial')
  git('init', '--bare', remote); git('config', `url.${remote}.insteadOf`, 'https://github.com/owner/test.git')
  git('checkout', '-b', 'ticket-branch')
  const store = new Store(join(dir, 'db'))
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const app = new App(store, { start() {}, deliver() {}, stop() {} }, 'owner')
  app.engine.receive({ id: 'request', source: 'router', actor: { source: 'router', id: 'owner' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Create PR', threads: [{ source: 'router', id: 'window' }], meta: {} })
  const ticketId = app.engine.decide('request', { kind: 'accept', title: 'test', scope: 'Create PR', reason: 'test' }).ticketId!
  const ticket = store.tickets.get(ticketId)!, assignment = ticket.assignments[0].id
  ticket.execution = { name: 'ticket-branch', directory: repo, assignment: 'Create PR' }; store.tickets.save(ticket)
  app.engine.assignmentStarted(ticketId, assignment)
  store.put('publish-authorization', ticketId, { repository: 'owner/test' })
  const state = join(dir, 'gh-state.json'), cli = join(dir, 'gh')
  writeFileSync(state, JSON.stringify({ count: 0, owner: 42, pull: null, drop: false }))
  writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs'), file=${JSON.stringify(state)}, s=JSON.parse(fs.readFileSync(file,'utf8')), args=process.argv.slice(2), path=args[3];
let r;
if(path==='user') r={id:s.owner};
else if(path==='repos/owner/test') r={full_name:'owner/test',default_branch:'main'};
else if(path.includes('?')) r=s.pull?[s.pull]:[];
else if(path==='repos/owner/test/pulls') { s.count++; s.pull={number:1,html_url:'https://github.com/owner/test/pull/1',state:'open',user:{id:42},head:{ref:'ticket-branch',repo:{full_name:'owner/test'}}}; r=s.pull; }
else throw Error(path);
fs.writeFileSync(file,JSON.stringify(s));
if(s.drop && !path.includes('?') && path.endsWith('/pulls')) { s.drop=false; fs.writeFileSync(file,JSON.stringify(s)); process.exit(1); }
console.log(JSON.stringify(r));
`, { mode: 0o755 })
  const reviews = { assertReady: vi.fn(async () => {}) }
  const publisher = new Publisher(store, { repository: 'owner/test', owner: { id: '42', login: 'owner' } }, reviews, cli)
  const publish = () => publisher.publish(app.engine, ticketId, assignment, 'Change', 'Checked change')
  return { store, app, repo, git, remote, state, publisher, reviews, publish, ticketId, assignment }
}

test('publishes reviewed commit once and binds PR before ready; response loss reconciles', async () => {
  const f = fixture()
  writeFileSync(f.state, JSON.stringify({ count: 0, owner: 42, pull: null, drop: true }))
  await expect(f.publish()).rejects.toThrow()
  await expect(f.publish()).resolves.toMatchObject({ number: 1 })
  await f.publish()
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(1)
  expect(f.store.tickets.get(f.ticketId)?.follows).toMatchObject([{ thread: 'github:owner/test:1', own: true }])
  expect(execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'ticket-branch'], { encoding: 'utf8' }).trim()).toBe(f.git('rev-parse', 'HEAD'))
})

test('refuses publishing without review or Router authorization', async () => {
  const f = fixture()
  f.reviews.assertReady.mockRejectedValueOnce(new Error('review required'))
  await expect(f.publish()).rejects.toThrow('review required')
  f.store.delete('publish-authorization', f.ticketId)
  await expect(f.publish()).rejects.toThrow('not authorized')
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(0)
})

test('dirty worktree and switched GitHub account cannot publish', async () => {
  const f = fixture()
  writeFileSync(join(f.repo, 'extra.txt'), 'unreviewed')
  await expect(f.publish()).rejects.toThrow('Commit authorized')
  rmSync(join(f.repo, 'extra.txt'))
  writeFileSync(f.state, JSON.stringify({ count: 0, owner: 999, pull: null, drop: false }))
  await expect(f.publish()).rejects.toThrow('account changed')
})

test('concurrent publish requests share the same side effects', async () => {
  const f = fixture()
  await Promise.all([f.publish(), f.publish()])
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(1)
})


test('bound publishing requires exact target repository, account and Router authorization', async () => {
  const f = fixture(), github = { repository: 'owner/test', owner: { id: '42', login: 'owner' } }
  const target = { ticketId: f.ticketId, kind: 'git', hostId: 'local', repository: f.repo, github }
  f.store.put('ticket-target', f.ticketId, target)
  await expect(f.publish()).rejects.toThrow('not authorized')
  f.store.put('publish-authorization', f.ticketId, github)
  for (const mismatch of [{ repository: 'owner/other', owner: github.owner }, { repository: github.repository, owner: { id: '99', login: 'owner' } }, { repository: github.repository, owner: { id: '42', login: 'renamed' } }]) {
    f.store.put('ticket-target', f.ticketId, { ...target, github: mismatch })
    await expect(f.publish()).rejects.toThrow('does not match')
  }
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(0)
  f.store.put('ticket-target', f.ticketId, target)
  await expect(f.publish()).resolves.toMatchObject({ number: 1 })
})

test('publishing rejects a foreign Git clone and unknown targets without side effects', async () => {
  const f = fixture(), github = { repository: 'owner/test', owner: { id: '42', login: 'owner' } }
  f.store.put('ticket-target', 'other', { ticketId: 'other' })
  await expect(f.publish()).rejects.toThrow('unknown')
  const clone = join(f.repo, '..', 'clone')
  execFileSync('git', ['clone', f.repo, clone], { stdio: 'pipe' })
  f.store.put('ticket-target', f.ticketId, { ticketId: f.ticketId, kind: 'git', hostId: 'local', repository: clone, github })
  f.store.put('publish-authorization', f.ticketId, github)
  await expect(f.publish()).rejects.toThrow('does not belong')
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(0)
})

test('revoking target publishing authorization during verification prevents the push', async () => {
  const f = fixture()
  f.reviews.assertReady.mockImplementationOnce(async () => { f.store.delete('publish-authorization', f.ticketId) })
  await expect(f.publish()).rejects.toThrow('not authorized')
  expect(() => execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'ticket-branch'], { stdio: 'pipe' })).toThrow()
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(0)
})
