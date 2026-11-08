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
function fixture(branch = 'ticket-branch') {
  const dir = mkdtempSync(join(tmpdir(), 'osa-publish-')), repo = join(dir, 'repo'), remote = join(dir, 'remote.git')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'README.md'), 'test\n'); git('add', '.'); git('commit', '-m', 'initial')
  git('init', '--bare', remote); git('config', `url.${remote}.insteadOf`, 'https://github.com/owner/test.git')
  git('checkout', '-b', branch)
  const store = new Store(join(dir, 'db'))
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const app = new App(store, { start() {}, deliver() {}, stop() {} }, 'owner')
  app.engine.receive({ id: 'request', source: 'router', actor: { source: 'router', id: 'owner' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: 'Create PR', threads: [{ source: 'router', id: 'window' }], meta: {} })
  const ticketId = app.engine.decide('request', { kind: 'accept', title: 'test', scope: 'Create PR', reason: 'test' }).ticketId!
  const ticket = store.tickets.get(ticketId)!, assignment = ticket.assignments[0].id
  ticket.execution = { name: branch, directory: repo, assignment: 'Create PR' }; store.tickets.save(ticket)
  app.engine.assignmentStarted(ticketId, assignment)
  const state = join(dir, 'gh-state.json'), cli = join(dir, 'gh')
  writeFileSync(state, JSON.stringify({ count: 0, owner: 42, pull: null, drop: false }))
  writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs'), file=${JSON.stringify(state)}, s=JSON.parse(fs.readFileSync(file,'utf8')), args=process.argv.slice(2), path=args[3];
let r;
if(path==='user') r={id:s.owner};
else if(path==='repos/owner/test') r={full_name:'owner/test',default_branch:'main'};
else if(path.includes('?')) r=s.pull?[s.pull]:[];
else if(path==='repos/owner/test/pulls') { s.count++; s.pull={number:1,html_url:'https://github.com/owner/test/pull/1',state:'open',user:{id:42},head:{ref:${JSON.stringify(branch)},sha:'${git('rev-parse','HEAD')}',repo:{full_name:'owner/test'}}}; r=s.pull; }
else throw Error(path);
fs.writeFileSync(file,JSON.stringify(s));
if(s.drop && !path.includes('?') && path.endsWith('/pulls')) { s.drop=false; fs.writeFileSync(file,JSON.stringify(s)); process.exit(1); }
console.log(JSON.stringify(r));
`, { mode: 0o755 })
  const publisher = new Publisher(store, { repository: 'owner/test', owner: { id: '42', login: 'owner' } }, cli)
  const publish = () => publisher.publish(app.engine, ticketId, assignment, 'Change', 'Checked change')
  return { store, app, repo, git, remote, state, publisher, publish, ticketId, assignment }
}

test('publishes a clean commit once and binds the PR; response loss reconciles', async () => {
  const f = fixture()
  writeFileSync(f.state, JSON.stringify({ count: 0, owner: 42, pull: null, drop: true }))
  await expect(f.publish()).rejects.toThrow()
  await expect(f.publish()).resolves.toMatchObject({ number: 1 })
  await f.publish()
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(1)
  expect(f.store.tickets.get(f.ticketId)?.follows).toMatchObject([{ thread: 'github:owner/test:1', own: true }])
  expect(execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'ticket-branch'], { encoding: 'utf8' }).trim()).toBe(f.git('rev-parse', 'HEAD'))
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


test('bound publishing requires the exact target repository and account', async () => {
  const f = fixture(), github = { repository: 'owner/test', owner: { id: '42', login: 'owner' } }
  const target = { ticketId: f.ticketId, kind: 'git', hostId: 'local', repository: f.repo, github }
  f.store.put('ticket-target', f.ticketId, target)
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
  await expect(f.publish()).rejects.toThrow('does not belong')
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(0)
})

test('changing the target during verification prevents the push', async () => {
  const f = fixture()
  vi.spyOn(f.publisher as any, 'api').mockImplementationOnce(async () => { f.store.put('ticket-target', f.ticketId, { ticketId: f.ticketId, repository: '/different' }); return {id: 42} })
  await expect(f.publish()).rejects.toThrow('target changed')
  expect(() => execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'ticket-branch'], { stdio: 'pipe' })).toThrow()
  expect(JSON.parse(readFileSync(f.state, 'utf8')).count).toBe(0)
})


test('multi-repository publication uses each bound workspace and waits for both owned PRs to close', async () => {
  const f=fixture(), secondRepo=join(f.repo,'..','second'), secondRemote=join(f.repo,'..','second-remote.git'), secondCli=join(f.repo,'..','second-gh')
  execFileSync('git',['clone',f.repo,secondRepo],{stdio:'pipe'})
  const git=(...args:string[])=>execFileSync('git',['-C',secondRepo,...args],{stdio:'pipe',encoding:'utf8'}).trim()
  git('checkout','-b','second-branch'); git('init','--bare',secondRemote); git('config',`url.${secondRemote}.insteadOf`,'https://github.com/owner/second.git')
  const github={repository:'owner/test',owner:{id:'42',login:'owner'}}, secondGithub={...github,repository:'owner/second'}
  const primary={projectId:'p',componentId:'a',locationId:'a',repository:f.repo,kind:'git' as const,hostId:'local',github}
  const secondary={...primary,componentId:'b',locationId:'b',repository:secondRepo,github:secondGithub}
  f.store.put('ticket-target',f.ticketId,{...primary,ticketId:f.ticketId,repositories:[primary,secondary],boundAt:new Date().toISOString()})
  for(const [target,name] of [[primary,'ticket-branch'],[secondary,'second-branch']] as const) f.store.put('ticket-workspace',`${f.ticketId}:${target.locationId}`,{ticketId:f.ticketId,locationId:target.locationId,repository:target.repository,directory:target.repository,name})
  writeFileSync(secondCli,`#!${process.execPath}
const path=process.argv[5];
console.log(JSON.stringify(path==='user'?{id:42}:path==='repos/owner/second'?{full_name:'owner/second',default_branch:'main'}:path.includes('?')?[]:{number:2,html_url:'https://github.com/owner/second/pull/2',state:'open',user:{id:42},head:{ref:'second-branch',sha:'${git('rev-parse','HEAD')}',repo:{full_name:'owner/second'}}}));
`,{mode:0o755})
  const secondPublisher=new Publisher(f.store,secondGithub,secondCli)
  await expect(f.publish()).rejects.toThrow('Select --location')
  await f.publisher.publish(f.app.engine,f.ticketId,f.assignment,'First','First checked','a')
  await secondPublisher.publish(f.app.engine,f.ticketId,f.assignment,'Second','Second checked','b')
  expect(f.store.list('publication')).toHaveLength(2)
  expect(f.store.tickets.get(f.ticketId)?.follows).toHaveLength(2)
  f.app.engine.report(f.ticketId,{state:'ready',summary:'Both repositories ready'})
  f.app.engine.threadClosed({source:'github',id:'owner/test:1'},'merged',new Date().toISOString())
  expect(f.store.tickets.get(f.ticketId)?.ended).toBeUndefined()
  f.app.engine.threadClosed({source:'github',id:'owner/second:2'},'merged',new Date().toISOString())
  expect(f.store.tickets.get(f.ticketId)?.ended?.outcome).toBe('merged')
  expect(execFileSync('git',['--git-dir',secondRemote,'rev-parse','second-branch'],{encoding:'utf8'}).trim()).toBe(git('rev-parse','HEAD'))
})


test('a PR for a different commit is never recorded as this publication', async () => {
  const f=fixture()
  writeFileSync(f.state,JSON.stringify({count:0,owner:42,pull:{number:1,html_url:'https://github.com/owner/test/pull/1',state:'open',user:{id:42},head:{ref:'ticket-branch',sha:'0'.repeat(40),repo:{full_name:'owner/test'}}}}))
  await expect(f.publish()).rejects.toThrow('does not belong')
  expect(f.store.tickets.get(f.ticketId)?.follows).toBeUndefined()
  expect(f.store.list<any>('publication')[0]).not.toHaveProperty('pr')
})


test.each(['inspect', 'continue'])('publishes the actual branch in an existing %s workspace without a publication grant', async mode => {
  const f = fixture('feature/existing'), github = { repository: 'owner/test', owner: { id: '42', login: 'owner' } }
  const target = { ticketId: f.ticketId, locationId: 'local', kind: 'git', hostId: 'local', repository: f.repo, github }
  f.store.put('ticket-target', f.ticketId, target)
  const ticket = f.store.tickets.get(f.ticketId)!
  ticket.execution = { ...ticket.execution!, name: 'new-task-name', directory: '' }
  f.store.tickets.save(ticket)
  f.store.put('task-plan', f.ticketId, mode === 'inspect' ? { workspace: 'inspect' } : { continueFrom: 'previous' })
  if (mode === 'continue') {
    f.store.put('ticket-workspace', 'previous:local', { ticketId: 'previous', locationId: 'local', repository: f.repo, directory: f.repo, name: 'feature/existing' })
  }
  await expect(f.publish()).resolves.toMatchObject({ number: 1 })
  expect(f.store.get('publish-authorization', f.ticketId)).toBeUndefined()
  expect(execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'feature/existing'], { encoding: 'utf8' }).trim()).toBe(f.git('rev-parse', 'HEAD'))
  expect(f.git('branch', '--show-current')).toBe('feature/existing')
})

test('publishing from an existing workspace still rejects the default branch', async () => {
  const f = fixture('main-copy')
  f.git('checkout', 'main')
  f.store.put('task-plan', f.ticketId, { workspace: 'inspect' })
  await expect(f.publish()).rejects.toThrow('default branch')
  expect(() => execFileSync('git', ['--git-dir', f.remote, 'rev-parse', 'main'], { stdio: 'pipe' })).toThrow()
})

test('status exposes publication identity and reconstructs only known legacy publication keys', async () => {
  const f=fixture()
  f.store.put('ticket-target', f.ticketId, { ticketId: f.ticketId, projectId: 'p', componentId: 'c', locationId: 'l', kind: 'git', hostId: 'local', repository: f.repo, github: { repository: 'owner/test', owner: { id: '42', login: 'owner' } } })
  await f.publish()
  const status=()=>f.app.handle({command:['owner','status'],options:{},id:'read'}) as any
  const sha=f.git('rev-parse','HEAD'), id=`${f.ticketId}:${sha}`
  expect(status().publications).toEqual([expect.objectContaining({ticketId:f.ticketId,repository:'owner/test',sha,pr:1,url:'https://github.com/owner/test/pull/1'})])
  const {ticketId:_ticket,repository:_repository,locationId:_location,...legacy}=f.store.get<any>('publication',id)
  f.store.put('publication',id,legacy)
  f.store.put('publication',`unknown-ticket:${sha}`,{...legacy,title:'Unrelated legacy record'})
  f.store.put('publication','other-modern',{...legacy,ticketId:'unknown-ticket',repository:'owner/unrelated'})
  expect(status().publications).toEqual([expect.objectContaining({ticketId:f.ticketId,repository:'owner/test',title:'Change',sha,pr:1})])
})
