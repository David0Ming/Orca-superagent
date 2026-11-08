import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { Engine, type OutboundMessage, type Trigger } from '../vendor/dsh-core/src/index.ts'
import { GitHub } from '../src/github.ts'
import { Store } from '../src/store.ts'

const cleanup: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); for (const fn of cleanup.splice(0)) fn() })
const repository = 'owner/project', owner = { id: '42', login: 'owner' }
const user = { id: 42, login: 'owner', type: 'User' }
const start = '2026-11-02T00:00:00.000Z', fresh = '2026-11-02T00:00:01.000Z'
const issue = (number: number, overrides = {}) => ({ id: number + 100, number, title: 'Owner request', body: 'Implement this', user,
  created_at: fresh, updated_at: fresh, ...overrides })
const comment = (id: number, number = 1, overrides = {}) => ({ id, body: `comment ${id}`, user, created_at: fresh, updated_at: fresh,
  issue_url: `https://api.github.com/repos/${repository}/issues/${number}`, ...overrides })
const pull = (number: number, overrides = {}) => ({ ...issue(number), state: 'open',
  head: { ref: 'fix-widget', sha: 'a'.repeat(40), repo: { full_name: repository } }, ...overrides })

function setup() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start)
  const dir = mkdtempSync(join(tmpdir(), 'osa-github-')), cli = join(dir, 'gh'), db = join(dir, 'db')
  const stateFile = join(dir, 'state.json'), logFile = join(dir, 'calls.jsonl')
  writeFileSync(stateFile, JSON.stringify({ routes: {}, pulls: {}, posts: [], user }))
  writeFileSync(logFile, '')
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(stateFile)}, log = ${JSON.stringify(logFile)};
const args = process.argv.slice(2), s = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if(args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'github.com') throw Error('Missing explicit host');
const url = new URL(args[3], 'https://api.github.com/');
const path = url.pathname.split('/').slice(url.pathname.startsWith('/repos/') ? 4 : 1).join('/');
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const output = value => { save(); console.log(JSON.stringify(value)); };
if(s.fail === path) { console.error('temporary unavailable'); process.exit(1); }
if(s.invalid === path) { console.log('{broken'); process.exit(0); }
if(path === 'user') { output(s.user); process.exit(0); }
if(args.includes('POST')) {
  const body = args[args.indexOf('--raw-field') + 1].slice(5);
  const number = Number(path.split('/')[1]);
  const c = {id: 9000 + s.posts.length, body, user: s.user, created_at: '${fresh}', updated_at: '${fresh}', issue_url: 'https://api.github.com/repos/${repository}/issues/' + number};
  s.posts.push({path, body});
  (s.routes[path] ??= [[]])[0].push(c);
  (s.routes['issues/comments'] ??= [[]])[0].push(c);
  if(s.dropOnce) { delete s.dropOnce; save(); process.exit(17); }
  output(c); process.exit(0);
}
if(/^pulls\\/\\d+$/.test(path)) { output(s.pulls[path.split('/')[1]]); process.exit(0); }
if(!['issues','issues/comments','pulls','pulls/comments'].includes(path) && !/^pulls\\/\\d+\\/reviews$/.test(path) && !/^issues\\/\\d+\\/comments$/.test(path) && !/^commits\\/[a-f0-9]+\\/(statuses|check-runs)$/.test(path)) throw Error('Unexpected path ' + path);
if(url.searchParams.get('per_page') !== '100') throw Error('Missing page size');
const pages = s.routes[path] ?? (path.endsWith('/check-runs') ? [{check_runs: []}] : [[]]);
output(args.includes('--paginate') && args.includes('--slurp') ? pages : pages[0]);
`, { mode: 0o755 })
  let store = new Store(db)
  const options = { repository, owner, cli }
  let source = new GitHub(store, options)
  const deliveries: string[] = []
  const makeEngine = () => new Engine({ repo: store,
    executor: { start() {}, stop() {}, deliver(ticket) { deliveries.push(ticket.id) } },
    policy: () => ({ version: 'test', paused: false, evalTimeoutMs: 1000,
      gate: trigger => trigger.human && trigger.actor.id === owner.id ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } } : { admissible: false, reason: 'ownerOnly' },
      revalidate: () => true, admitsInferred: () => false }),
    scope: { scope: input => input.meta.repository === repository ? { listened: true, observed: false } : { listened: false, reason: 'wrongRepo' } },
    assessor: { request(candidate) { store.put('candidate', candidate.evalId, candidate) } },
    outbox: { send(message) { store.put('outbox', message.id, { ...message, status: 'pending' }) }, status: () => undefined, withdraw() {} },
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: { name: outcome.name!, directory: '', assignment: 'Fix widget' } }),
  })
  let engine = makeEngine()
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const update = (patch: object) => writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }))
  return { options, deliveries, state, update,
    calls: (): string[][] => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    routes(routes: object) { update({ routes: { ...state().routes, ...routes } }) },
    get store() { return store }, get source() { return source }, get engine() { return engine },
    tick: () => source.tick(engine),
    triggers: () => store.list<Trigger>('core.trigger'),
    restart() { store.close(); store = new Store(db); source = new GitHub(store, options); engine = makeEngine() },
    accept() {
      const trigger = store.list<Trigger>('core.trigger').find(item => item.meta.kind === 'issue')!
      const decision = engine.decide(trigger.id, { kind: 'accept', title: 'Fix widget', scope: 'Fix widget', name: 'fix-widget', reason: 'Owner' })
      const ticket = store.tickets.get(decision.ticketId!)!
      engine.assignmentStarted(ticket.id, ticket.assignments[0].id)
      return ticket.id
    },
    mail(id: string, number = 1, overrides: Partial<OutboundMessage> = {}) {
      store.put('outbox', id, { id, channel: { source: 'github', thread: `${repository}:${number}`, address: { repository, number: String(number) } }, text: `Reply ${id}`, kind: 'notice', status: 'pending', ...overrides })
    },
  }
}

test('activation admits first-tick new issues across every page, preserves actual authors for policy, and deduplicates after restart', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1, { created_at: '2020-01-01T00:00:00Z' }), issue(2, { user: { ...user, id: 99 } }),
    issue(3, { user: { ...user, type: 'Bot' } }), issue(4, { user: null })], [issue(5), issue(6, { user: { ...user, login: 'renamed-owner' } })]] })
  await f.tick()
  expect(f.triggers().map(item => item.meta.number)).toEqual([2, 3, 5, 6])
  for (const trigger of f.triggers().slice(0, 2)) expect(() => f.engine.decide(trigger.id, {kind:'accept', title:'Unauthorized', scope:'Unauthorized', reason:'No'})).toThrow()
  expect(f.triggers()[2].channel).toEqual({ source: 'github', thread: `${repository}:5`, address: { repository, number: '5' } })
  await f.tick()
  f.restart(); await f.tick()
  expect(f.triggers()).toHaveLength(4)
  expect(f.calls().every(args => args.includes('github.com'))).toBe(true)
})

test('durable activation and cursor retain downtime events while ignoring historical backlog', async () => {
  const f = setup()
  vi.setSystemTime('2026-11-02T00:01:00Z')
  await f.tick()
  const saved = f.store.get('github.cursor', `${repository}:42`)
  vi.setSystemTime('2026-11-02T00:03:00Z')
  f.restart()
  expect(f.store.get('github.cursor', `${repository}:42`)).toEqual(saved)
  f.routes({ issues: [[issue(1, { created_at: '2026-11-02T00:02:00Z', updated_at: '2026-11-02T00:02:00Z' })]] })
  await f.tick()
  expect(f.triggers()).toHaveLength(1)
  const paths = f.calls().map(args => args[3]).filter(path => path.startsWith('repos/owner/project/issues?'))
  expect(decodeURIComponent(paths.at(-1)!)).toContain('since=2026-11-02T00:00:55.000Z')
})

test('issue timeline activity and own outbound replies never reingest an unchanged issue body', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1)]] }); await f.tick()
  f.mail('result')
  f.routes({ issues: [[issue(1, { updated_at: '2026-11-02T00:00:02Z' })]] })
  await f.tick()
  f.routes({ issues: [[issue(1, { updated_at: '2026-11-02T00:00:03Z' })]] })
  f.restart(); await f.tick()
  expect(f.triggers()).toHaveLength(1)
  f.routes({ issues: [[issue(1, { updated_at: '2026-11-02T00:00:04Z', body: 'Actual owner edit' })]] })
  await f.tick()
  expect(f.triggers()).toHaveLength(2)
  expect(f.triggers()[1].text).toContain('Actual owner edit')
})

test('malformed JSON and foreign repository links fail closed without advancing the cursor', async () => {
  const f = setup(), before = f.store.get('github.cursor', `${repository}:42`)
  vi.setSystemTime('2026-11-02T00:01:00Z')
  f.update({ invalid: 'issues' })
  await expect(f.tick()).rejects.toThrow()
  expect(f.store.get('github.cursor', `${repository}:42`)).toEqual(before)
  f.update({ invalid: null })
  f.routes({ 'issues/comments': [[comment(1, 1, { issue_url: 'https://api.github.com/repos/attacker/project/issues/1' })]] })
  await expect(f.tick()).rejects.toThrow('outside selected repository')
  expect(f.triggers()).toHaveLength(0)
  f.routes({ 'issues/comments': [[comment(2)]] })
  await f.tick()
  expect(f.triggers()).toHaveLength(1)
  expect(() => new GitHub(f.store, { ...f.options, repository: 'owner/project/../../other' })).toThrow('repository')
  expect(() => new GitHub(f.store, { ...f.options, owner: { ...owner, id: 'owner' } })).toThrow('owner')
})

test('conversation, inline comments and reviews use owner IDs, all pages, and content versions', async () => {
  const f = setup(), pr = pull(7, { user: { ...user, id: 99 } })
  f.update({ pulls: { 7: pr } })
  f.routes({ pulls: [[pr]], 'issues/comments': [[comment(1, 7, { user: { ...user, id: 99 } })], [comment(2, 7)]],
    'pulls/comments': [[comment(3, 7, { pull_request_url: `https://api.github.com/repos/${repository}/pulls/7`, path: 'file.ts', line: 9 })]],
    'pulls/7/reviews': [[{ id: 4, user, body: 'Looks good', state: 'APPROVED', submitted_at: fresh }],
      [{ id: 5, user, body: '', state: 'CHANGES_REQUESTED', submitted_at: fresh }, { id: 6, user, body: 'draft', state: 'PENDING' }]] })
  await f.tick()
  expect(f.triggers().map(item => item.meta.kind)).toEqual(['comment', 'comment', 'review-comment', 'review', 'review'])
  expect(f.triggers()[2].text).toContain('file.ts:9')
  expect(f.calls().some(args => args[3].includes('/commits/'))).toBe(false)
  f.routes({ 'pulls/7/reviews': [[{ id: 4, user, body: 'Edited review', state: 'APPROVED', submitted_at: fresh }]] })
  await f.tick()
  expect(f.triggers()).toHaveLength(6)
  expect(f.triggers().at(-1)?.text).toContain('Edited review')
})

test('exact owned branch binds before owner comments, ready stays live, CI cannot originate work, merge closes', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1)]] }); await f.tick()
  const ticketId = f.accept(), pr = pull(7)
  f.update({ pulls: { 7: pr } })
  f.routes({ pulls: [[pr]], 'issues/comments': [[comment(10, 7)]],
    [`commits/${'a'.repeat(40)}/check-runs`]: [{ check_runs: [] }, { check_runs: [{ id: 1, name: 'tests', status: 'completed', conclusion: 'success' }] }] })
  await f.tick()
  let ticket = f.store.tickets.get(ticketId)!
  expect(ticket.follows).toEqual([{ thread: `github:${repository}:7`, own: true }])
  const feedback = f.triggers().find(item => item.meta.nativeId === 10)!
  expect(f.store.triggers.disposition(feedback.id)?.fanout).toEqual([ticketId])
  expect(f.engine.candidate(feedback.id)).toBeUndefined()
  expect(f.deliveries).toContain(ticketId)
  f.engine.report(ticketId, { state: 'ready', summary: 'Ready for merge' })
  expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  f.routes({ [`commits/${'a'.repeat(40)}/check-runs`]: [{ check_runs: [{ id: 1, name: 'tests', status: 'completed', conclusion: 'failure' }] }] })
  await f.tick()
  const ci = f.triggers().find(item => item.meta.ci)!
  expect(ci.human).toBe(false)
  expect(f.store.triggers.disposition(ci.id)?.fanout).toEqual([ticketId])
  expect(() => f.engine.decide(ci.id, { kind: 'accept', title: 'CI', scope: 'CI', reason: 'CI' })).toThrow()
  expect(f.store.tickets.list()).toHaveLength(1)
  f.restart(); await f.tick()
  expect(f.triggers().filter(item => item.meta.ci)).toHaveLength(1)
  f.update({ pulls: { 7: { ...pr, state: 'closed', merged_at: '2026-11-02T00:10:00Z', closed_at: '2026-11-02T00:10:00Z' } } })
  f.routes({ pulls: [[]] })
  await f.tick()
  ticket = f.store.tickets.get(ticketId)!
  expect(ticket.ended?.outcome).toBe('merged')
})

test('changed gh identity cannot send replies from a different account', async () => {
  const f = setup()
  f.mail('identity-check')
  f.update({ user: { id: 99, login: 'other', type: 'User' } })
  await expect(f.tick()).rejects.toThrow('account changed')
  expect(f.state().posts).toHaveLength(0)
  expect(f.store.get<{ status: string }>('outbox', 'identity-check')?.status).toBe('pending')
})

test('a new commit with no CI checks does not create synthetic followup work', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1)]] }); await f.tick(); f.accept()
  const pr = pull(7)
  f.update({ pulls: { 7: pr } }); f.routes({ pulls: [[pr]] }); await f.tick()
  f.update({ pulls: { 7: { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } } } })
  await f.tick()
  expect(f.triggers().filter(item => item.meta.ci)).toHaveLength(0)
})

test('forks, nonowner PRs and suffix-only branch matches cannot bind or supply CI', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1)]] }); await f.tick()
  const ticketId = f.accept()
  const prs = [pull(2, { user: { ...user, id: 99 } }),
    pull(3, { head: { ref: 'fix-widget', sha: 'a'.repeat(40), repo: { full_name: 'attacker/project' } } }),
    pull(4, { head: { ref: 'prefix/fix-widget', sha: 'a'.repeat(40), repo: { full_name: repository } } })]
  f.update({ pulls: Object.fromEntries(prs.map(pr => [pr.number, pr])) }); f.routes({ pulls: [prs] })
  await f.tick()
  expect(f.store.tickets.get(ticketId)?.follows).toBeUndefined()
  expect(f.calls().some(args => args[3].includes('/commits/'))).toBe(false)
})

test('publisher-bound PR closes even when it merges before the first source metadata refresh', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1)]] }); await f.tick()
  const ticketId = f.accept()
  f.engine.bindThread(ticketId, { source: 'github', id: `${repository}:7` }, true)
  f.engine.report(ticketId, { state: 'ready', summary: 'Published' })
  f.update({ pulls: { 7: pull(7, { state: 'closed', merged_at: '2026-11-02T00:10:00Z', closed_at: '2026-11-02T00:10:00Z' }) } })
  f.routes({ issues: [[]], pulls: [[]] })
  await f.tick()
  expect(f.store.tickets.get(ticketId)?.ended?.outcome).toBe('merged')
})

test('outbox lost response recovers by paginated marker scan after restart and preserves channel order', async () => {
  const f = setup()
  f.mail('first', 1, { text: 'literal $(touch /should-not-exist) `echo text`' }); f.mail('second'); f.mail('other', 2)
  f.update({ dropOnce: true })
  await expect(f.tick()).rejects.toThrow('outbox')
  expect(f.state().posts.map((post: { path: string }) => post.path)).toEqual(['issues/1/comments', 'issues/2/comments'])
  expect(f.store.get<{ status: string }>('outbox', 'first')?.status).toBe('pending')
  expect(f.store.get<{ status: string }>('outbox', 'second')?.status).toBe('pending')
  const markerComment = f.state().routes['issues/1/comments'][0][0]
  f.routes({ 'issues/1/comments': [[], [markerComment]] })
  f.restart(); await Promise.all([f.tick(), f.tick()])
  expect(f.state().posts).toHaveLength(3)
  expect(f.state().posts[2].body).toContain('Reply second')
  expect(f.store.list<{ status: string }>('outbox').every(mail => mail.status === 'sent')).toBe(true)
  expect(f.triggers()).toHaveLength(0)
  await f.tick()
  expect(f.triggers()).toHaveLength(0)
  expect(f.state().posts).toHaveLength(3)
})

test('transient outbox failures retain notices, block only that channel, and leave foreign destinations untouched', async () => {
  const f = setup()
  f.mail('notice'); f.mail('later'); f.mail('elsewhere', 2)
  f.update({ fail: 'issues/1/comments' })
  await expect(f.tick()).rejects.toThrow('outbox')
  expect(f.store.get<{ status: string }>('outbox', 'notice')?.status).toBe('pending')
  expect(f.state().posts).toHaveLength(1)
  f.update({ fail: null }); await f.tick()
  expect(f.state().posts).toHaveLength(3)
  f.mail('foreign', 1, { channel: { source: 'github', thread: 'attacker/project:1', address: { repository: 'attacker/project', number: '1' } } })
  await expect(f.tick()).resolves.toBeUndefined()
  expect(f.store.get('outbox', 'foreign')).not.toHaveProperty('error')
  expect(f.state().posts).toHaveLength(3)
})

test('identity discovery requires a numeric human identity on github.com', async () => {
  const f = setup()
  expect(await GitHub.discover(f.options.cli)).toEqual(owner)
  f.update({ user: { ...user, type: 'Bot' } })
  await expect(GitHub.discover(f.options.cli)).rejects.toThrow('human')
  f.update({ user: { ...user, id: '42' } })
  await expect(GitHub.discover(f.options.cli)).rejects.toThrow('ID')
})


test('identical branches bind only to the exact target repository and account', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1)]] }); await f.tick()
  const ticketId = f.accept(), ticket = f.store.tickets.get(ticketId)!, pr = pull(7)
  f.store.tickets.save({ ...ticket, id: 'foreign-ticket' })
  const target = { ticketId, github: { repository, owner } }
  f.store.put('ticket-target', ticketId, target)
  f.store.put('ticket-target', 'foreign-ticket', { ticketId: 'foreign-ticket', github: { repository: 'owner/other', owner } })
  f.update({ pulls: { 7: pr } }); f.routes({ pulls: [[pr]] })
  await f.tick()
  expect(f.store.tickets.get(ticketId)?.follows).toEqual([{ thread: `github:${repository}:7`, own: true }])
  expect(f.store.tickets.get('foreign-ticket')?.follows).toBeUndefined()
  f.store.tickets.save(ticket)
  f.store.put('ticket-target', ticketId, { ...target, github: { repository, owner: { ...owner, id: '99' } } })
  await f.tick()
  expect(f.store.tickets.get(ticketId)?.follows).toBeUndefined()
  f.store.delete('ticket-target', ticketId)
  await f.tick()
  expect(f.store.tickets.get(ticketId)?.follows).toBeUndefined()
  const other = new GitHub(f.store, { ...f.options, repository: 'owner/other' })
  f.update({ pulls: { 7: pull(7, { head: { ...pr.head, repo: { full_name: 'owner/other' } } }) } })
  await other.tick(f.engine)
  expect(f.store.tickets.get('foreign-ticket')?.follows).toEqual([{ thread: 'github:owner/other:7', own: true }])
  expect(f.store.tickets.get(ticketId)?.follows).toBeUndefined()
})

test('multiple adapters send only their own mail and never authenticate or alter foreign mail', async () => {
  const f = setup()
  f.mail('own')
  f.mail('foreign', 1, { channel: { source: 'github', thread: 'owner/other:1', address: { repository: 'owner/other', number: '1' } } })
  const foreign = f.store.get('outbox', 'foreign')
  await f.tick()
  expect(f.store.get('outbox', 'own')).toHaveProperty('status', 'sent')
  expect(f.store.get('outbox', 'foreign')).toEqual(foreign)
  f.update({ user: { ...user, id: 99 } })
  const before = f.calls().filter(args => args[3] === 'user').length
  await expect(f.tick()).resolves.toBeUndefined()
  expect(f.calls().filter(args => args[3] === 'user')).toHaveLength(before)
  expect(f.store.get('outbox', 'foreign')).toEqual(foreign)
  f.update({ user, routes: {} })
  const other = new GitHub(f.store, { ...f.options, repository: 'owner/other' })
  await other.tick(f.engine)
  expect(f.store.get('outbox', 'foreign')).toHaveProperty('status', 'sent')
  expect(f.state().posts).toHaveLength(2)
})

test('regression: failing PR must not block unrelated new owner issue', async () => {
  const f = setup()
  f.routes({ issues: [[issue(1)]], pulls: [[pull(2)]] }); f.update({ fail: 'pulls/2' })
  await expect(f.tick()).rejects.toThrow()
  expect(f.triggers().some(item => item.meta.number === 1)).toBe(true)
})


test('subscribed other humans and bots reach the same task with actual identities and cannot authorize new work', async () => {
  const f=setup(); f.routes({issues:[[issue(1)]]}); await f.tick()
  const ticketId=f.accept(), pr=pull(7)
  f.update({pulls:{7:pr}})
  f.routes({pulls:[[pr]],'issues/comments':[[comment(20,7,{user:{id:99,login:'reviewer',type:'User'},body:'Fix the existing bug'}),comment(21,7,{user:{id:100,login:'ci[bot]',type:'Bot'},body:'Tests failed'})]]})
  await f.tick()
  const feedback=f.triggers().filter(trigger=>[20,21].includes(Number(trigger.meta.nativeId)))
  expect(feedback.map(trigger=>[trigger.actor.id,trigger.human])).toEqual([['99',true],['100',false]])
  for(const trigger of feedback) {
    expect(f.store.triggers.disposition(trigger.id)?.fanout).toEqual([ticketId])
    expect(() => f.engine.decide(trigger.id,{kind:'accept',title:'Unauthorized',scope:'New work',reason:'No'})).toThrow()
  }
  expect(f.store.tickets.get(ticketId)?.inputs.filter(input=>input.kind==='trigger'&&feedback.some(trigger=>trigger.id===input.triggerId))).toHaveLength(2)
  expect(f.store.tickets.list()).toHaveLength(1)
})


test('first repository merge waits for the second authorized PR binding and closure survives restart', async () => {
  const f=setup(); f.routes({issues:[[issue(1)]]}); await f.tick()
  const ticketId=f.accept(), primary={projectId:'p',componentId:'a',locationId:'a',repository:'/first',hostId:'local',kind:'git',github:{repository,owner}}
  const secondary={...primary,componentId:'b',locationId:'b',repository:'/second',github:{repository:'owner/second',owner}}
  f.store.put('ticket-target',ticketId,{...primary,ticketId,repositories:[primary,secondary]})
  const first=pull(7), closedFirst={...first,state:'closed',merged_at:'2026-11-02T00:10:00Z',closed_at:'2026-11-02T00:10:00Z'}
  f.update({pulls:{7:first}}); f.routes({issues:[[]],pulls:[[first]]}); await f.tick()
  f.engine.report(ticketId,{state:'progress',summary:'First PR published; still implementing second repository'})
  f.update({pulls:{7:closedFirst}}); f.routes({pulls:[[]]}); await f.tick()
  expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  expect(f.store.threads.get(`github:${repository}:7`)?.meta.prState).toEqual({state:'closed',outcome:'merged',at:'2026-11-02T00:10:00.000Z'})
  f.restart(); await f.tick(); expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  const second=pull(8,{head:{ref:'fix-widget',sha:'b'.repeat(40),repo:{full_name:'owner/second'}}})
  f.update({pulls:{7:closedFirst,8:second}}); f.routes({pulls:[[second]]})
  const secondSource=new GitHub(f.store,{...f.options,repository:'owner/second'})
  await secondSource.tick(f.engine)
  expect(f.store.tickets.get(ticketId)?.follows).toHaveLength(2)
  await f.tick()
  expect(f.store.tickets.get(ticketId)?.follows?.find(follow=>follow.thread===`github:${repository}:7`)?.closed).toBeUndefined()
  expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  f.engine.report(ticketId,{state:'ready',summary:'Both repositories ready'})
  await f.tick()
  expect(f.store.tickets.get(ticketId)?.follows?.find(follow=>follow.thread===`github:${repository}:7`)?.closed?.outcome).toBe('merged')
  f.update({pulls:{7:closedFirst,8:{...second,state:'closed',merged_at:'2026-11-02T00:20:00Z',closed_at:'2026-11-02T00:20:00Z'}}}); f.routes({pulls:[[]]})
  await secondSource.tick(f.engine)
  expect(f.store.tickets.get(ticketId)?.ended?.outcome).toBe('merged')
})


test('a resumed multi-repository round cannot count the previous round PRs as current completion', async () => {
  const f=setup(); f.routes({issues:[[issue(1)]]}); await f.tick()
  const ticketId=f.accept(), primary={projectId:'p',componentId:'a',locationId:'a',repository:'/first',hostId:'local',kind:'git',github:{repository,owner}}
  const secondary={...primary,componentId:'b',locationId:'b',repository:'/second',github:{repository:'owner/second',owner}}
  f.store.put('ticket-target',ticketId,{...primary,ticketId,repositories:[primary,secondary]})
  f.engine.bindThread(ticketId,{source:'github',id:`${repository}:1`},true)
  f.engine.bindThread(ticketId,{source:'github',id:'owner/second:1'},true)
  f.engine.report(ticketId,{state:'ready',summary:'Original two repositories delivered'})
  f.engine.threadClosed({source:'github',id:`${repository}:1`},'merged','2026-11-02T00:00:02Z')
  f.engine.threadClosed({source:'github',id:'owner/second:1'},'merged','2026-11-02T00:00:03Z')
  expect(f.store.tickets.get(ticketId)?.ended?.outcome).toBe('merged')
  f.engine.receive({id:'second-round',source:'github',actor:{source:'github',id:owner.id},human:true,addressed:'direct',at:'2026-11-02T00:00:04Z',text:'Fix the remaining behavior in both repositories',threads:[{source:'github',id:`${repository}:1`}],meta:{repository}})
  const assignment=f.store.tickets.get(ticketId)!.assignments.at(-1)!
  f.engine.assignmentStarted(ticketId,assignment.id)
  f.engine.report(ticketId,{state:'progress',summary:'A2 published; still implementing B2'})
  const previousA=pull(1,{state:'closed',merged_at:'2026-11-02T00:00:02Z',closed_at:'2026-11-02T00:00:02Z'})
  const nextA=pull(7), closedA={...nextA,state:'closed',merged_at:'2026-11-02T00:10:00Z',closed_at:'2026-11-02T00:10:00Z'}
  f.update({pulls:{1:previousA,7:nextA}}); f.routes({issues:[[]],pulls:[[nextA]]}); await f.tick()
  f.update({pulls:{1:previousA,7:closedA}}); f.routes({pulls:[[]]}); await f.tick()
  expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  expect(f.store.tickets.get(ticketId)?.assignments.at(-1)?.report?.summary).toBe('A2 published; still implementing B2')
  expect(f.store.threads.get(`github:${repository}:7`)?.meta.prState).toMatchObject({state:'closed',outcome:'merged'})
  f.restart(); await f.tick(); expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  const nextB=pull(8,{head:{ref:'fix-widget',sha:'b'.repeat(40),repo:{full_name:'owner/second'}}})
  f.update({pulls:{1:previousA,7:closedA,8:nextB}}); f.routes({pulls:[[nextB]]})
  const secondSource=new GitHub(f.store,{...f.options,repository:'owner/second'})
  await secondSource.tick(f.engine)
  await f.tick(); expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  f.engine.report(ticketId,{state:'ready',summary:'A2 and B2 are both delivered'})
  await f.tick()
  f.update({pulls:{1:previousA,7:closedA,8:{...nextB,state:'closed',merged_at:'2026-11-02T00:20:00Z',closed_at:'2026-11-02T00:20:00Z'}}}); f.routes({pulls:[[]]})
  await secondSource.tick(f.engine)
  expect(f.store.tickets.get(ticketId)?.ended?.outcome).toBe('merged')
})
