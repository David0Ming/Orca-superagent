import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import type { Ticket } from '../vendor/dsh-core/src/index.ts'
import { Projects } from '../src/projects.ts'
import { Store } from '../src/store.ts'
const clean: (() => void)[] = []
afterEach(() => { for (const fn of clean.splice(0)) fn() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'osa-projects-')), store = new Store(':memory:'), projects = new Projects(store)
  execFileSync('git', ['init', '-q', dir])
  clean.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const add = (id: string) => {
    projects.handle(['project', 'add'], { id, name: id })
    projects.handle(['component', 'add'], { id, name: id, project: id })
    projects.handle(['location', 'add'], { id, name: id, component: id, repository: dir })
  }
  const ticket = (id: string, project: string) => {
    const t: Ticket = { id, title: 'Same title', mandate: { scope: 'scope', strength: 'explicit', policyVersion: '1', basis: { via: 'listed' }, actor: { source: 'router', id: 'owner' } }, decisionId: 'd', channels: [], assignments: [], inputs: [], undelivered: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), origin: { triggerId: id, triggerIds: [id] } }
    store.tickets.save(t); projects.bind(t, { project }); return t
  }
  return { store, projects, add, ticket, dir }
}
it('registers arbitrary names, rejects ambiguity, preserves renamed target and archives without deleting history', () => {
  const f = fixture(); f.add('Arbitrary Chinese 项目'); f.add('Other')
  expect(() => f.projects.resolve({})).toThrow('unambiguous')
  const t = f.ticket('t', 'Arbitrary Chinese 项目'), before = f.store.get('ticket-target', t.id)
  f.projects.handle(['project', 'update'], { id: 'Arbitrary Chinese 项目', name: 'Renamed' })
  f.projects.bind(t, {})
  expect(f.store.get('ticket-target', t.id)).toEqual(before)
  expect(() => f.projects.bind(t, { project: 'Other' })).toThrow('immutable')
  f.projects.handle(['project', 'pause'], { id: 'Arbitrary Chinese 项目' })
  expect(f.projects.blocked(t.id)).toContain('paused')
  f.projects.handle(['project', 'resume'], { id: 'Arbitrary Chinese 项目' })
  expect(f.projects.blocked(t.id)).toBeUndefined()
  f.projects.handle(['project', 'archive'], { id: 'Arbitrary Chinese 项目' })
  expect(f.store.get('ticket-target', t.id)).toEqual(before)
  expect(f.projects.blocked(t.id)).toContain('archived')
})
it('keeps source/version knowledge history scoped to explicit projects and components', () => {
  const f = fixture(); f.add('a'); f.add('b'); f.ticket('a1', 'a'); f.ticket('b1', 'b')
  f.projects.handle(['knowledge', 'add'], { id: 'k', name: 'Rule', project: 'a', source: 'docs/rule', version: '1', text: 'old' })
  f.projects.handle(['knowledge', 'supersede'], { id: 'k', source: 'owner decision', version: '2', text: 'new' })
  expect((f.projects.context('a1') as any).knowledge.map((k: any) => k.text)).toEqual(['new'])
  expect((f.projects.context('b1') as any).knowledge).toEqual([])
  expect(f.store.get<any>('knowledge', 'k').supersededBy).toBeTruthy()
  expect(() => f.projects.handle(['knowledge', 'add'], { name: 'unscoped', source: 'x', version: '1', text: 'x' })).toThrow('scope')
})
it('validates goal scope and dependency cycles atomically and requires actual successful evidence', () => {
  const f = fixture(); f.add('a'); f.add('b'); const a = f.ticket('a1', 'a'); f.ticket('b1', 'b')
  expect(() => f.projects.handle(['task', 'plan'], { ticket: 'b1', 'depends-on': 'a1' })).toThrow('shared goal')
  f.projects.handle(['goal', 'add'], { id: 'g', name: 'Integrate', projects: 'a,b' })
  f.projects.handle(['task', 'plan'], { ticket: 'b1', goal: 'g', 'depends-on': 'a1', resources: 'db' })
  expect(() => f.projects.handle(['goal','update'], {id:'g',projects:'a'})).toThrow('excludes')
  expect(() => f.projects.handle(['task', 'plan'], { ticket: 'a1', goal: 'g', 'depends-on': 'b1' })).toThrow('cycle')
  expect(f.store.get<any>('task-plan', 'a1').dependsOn).toEqual([])
  a.ended = { at: a.createdAt, by: 'human', outcome: 'stopped' }; f.store.tickets.save(a)
  expect(f.projects.blocked('b1')).toContain('Dependency')
  a.ended.outcome = 'completed'; a.assignments = [{ id: 'aa', state: 'ended', createdAt: a.createdAt, report: { state: 'ready', summary: 'done', at: a.createdAt } }]; f.store.tickets.save(a)
  f.store.put('orca-assignment', 'aa', { dispatchId: 'd', settled: 'm' }); f.store.put('execution', 'aa', { dispatchId: 'd', outcome: 'succeeded' })
  expect(f.projects.blocked('b1')).toBeUndefined()
  f.store.put('config', 'two-layer', true)
  expect(f.projects.blocked('b1')).toBeUndefined()
  f.store.put('review', 'aa', { verdict: 'approve', executorDispatchId: 'd' })
  expect(f.projects.blocked('b1')).toBeUndefined()
  f.store.put('execution', 'aa', { dispatchId: 'old', outcome: 'succeeded' })
  expect(f.projects.blocked('b1')).toContain('Dependency')
})
it('discovery does not authorize execution, remote/folder locations fail closed and legacy migration is stable', () => {
  const f = fixture(); f.projects.importOrca([{ id: 'discovered' }]); expect(() => f.projects.resolve({})).toThrow()
  f.projects.ensureLegacy(f.dir); const t = f.ticket('old', 'legacy'); const target = f.store.get('ticket-target', t.id)
  f.projects.ensureLegacy(f.dir); expect(f.store.get('ticket-target', t.id)).toEqual(target)
  expect(() => f.projects.ensureLegacy(tmpdir())).toThrow('mismatch')
  f.projects.handle(['location', 'add'], { id: 'remote', name: 'remote', component: 'legacy', host: 'server-A', repository: '/srv/anything' })
  const other = { ...t, id: 'remote-task' }; f.store.tickets.save(other); f.projects.bind(other, { location: 'remote' })
  expect(f.projects.blocked(other.id)).toContain('local Git')
})

it('does not overwrite a pre-existing registry ID during legacy migration', () => {
  const f = fixture(); f.add('legacy')
  const before = f.store.get('project', 'legacy')
  expect(() => f.projects.ensureLegacy(f.dir)).toThrow('collision')
  expect(f.store.get('project', 'legacy')).toEqual(before)
  expect(f.store.get('config', 'legacy-target')).toBeUndefined()
})

it('keeps goal child completion separate from an explicit joint acceptance task', () => {
  const f = fixture(); f.add('a'); const child = f.ticket('child', 'a'), joint = f.ticket('joint', 'a')
  f.projects.handle(['goal', 'add'], { id: 'g', name: 'Joint goal', projects: 'a', 'acceptance-ticket': joint.id })
  f.projects.handle(['task', 'plan'], { ticket: child.id, goal: 'g' })
  expect(f.projects.blocked(joint.id)).toContain('Dependency')
  expect(() => f.projects.handle(['task','plan'],{ticket:child.id,'depends-on':joint.id})).toThrow('cycle')
  expect(() => f.projects.handle(['task','plan'],{ticket:joint.id,goal:''})).toThrow('leave')
  f.projects.handle(['task', 'plan'], { ticket: joint.id, goal: 'g', 'depends-on': child.id })
  const complete = (ticket: Ticket) => {
    const id = 'assignment-' + ticket.id, dispatchId = 'dispatch-' + ticket.id
    ticket.ended = { at: ticket.createdAt, by: 'executor', outcome: 'completed' }
    ticket.assignments = [{ id, state: 'ended', createdAt: ticket.createdAt, report: { state: 'ready', summary: 'done', at: ticket.createdAt } }]
    f.store.tickets.save(ticket)
    f.store.put('orca-assignment', id, { dispatchId, settled: 'message' }); f.store.put('execution', id, { dispatchId, outcome: 'succeeded' })
  }
  complete(child)
  expect(f.projects.handle(['goal', 'show'], { id: 'g' })).toMatchObject({ status: 'pending', children: [{ ticketId: child.id, successful: true }], acceptance: { ticketId: joint.id, successful: false } })
  complete(joint)
  expect(f.projects.handle(['goal', 'show'], { id: 'g' })).toMatchObject({ status: 'accepted', acceptance: { successful: true } })
  expect(() => f.projects.handle(['goal', 'update'], { id: 'g', 'acceptance-ticket': child.id })).toThrow('already bound')
  const late = f.ticket('late','a')
  expect(() => f.projects.handle(['task','plan'],{ticket:late.id,goal:'g'})).toThrow('frozen')
})
it('preserves obsolete publish records without using them as a migration gate', () => {
  const f = fixture(); const ticket = f.ticket('old', 'unused')
  const github = { repository: 'owner/repository', owner: { id: '42', login: 'owner' } }
  f.store.put('publish-authorization', ticket.id, { repository: github.repository })
  f.projects.ensureLegacy(f.dir, github)
  expect(f.store.get('publish-authorization', ticket.id)).toEqual({repository:github.repository})
  f.projects.ensureLegacy(f.dir, github)
  const bad = fixture(); const other = bad.ticket('old', 'unused')
  bad.store.put('publish-authorization', other.id, { repository: 'unrelated/repository' })
  expect(() => bad.projects.ensureLegacy(bad.dir, github)).not.toThrow()
  expect(bad.store.get('ticket-target', other.id)).toBeDefined()
  expect(bad.store.get<any>('publish-authorization', other.id).owner).toBeUndefined()
})

it('only migrates pre-marker tickets and adds a later GitHub source for future targets', () => {
  const f=fixture(); f.projects.ensureLegacy(f.dir)
  const old=f.ticket('old','legacy'), frozen=f.store.get('ticket-target',old.id)
  const held={...old,id:'deliberately-unbound'};f.store.tickets.save(held)
  const github={repository:'owner/a',owner:{id:'42',login:'owner'}}
  f.projects.ensureLegacy(f.dir,github)
  expect(f.store.get('ticket-target',old.id)).toEqual(frozen)
  expect(f.store.get('ticket-target',held.id)).toBeUndefined()
  expect(f.projects.blocked(held.id)).toContain('no explicit')
  expect(f.projects.resolve({project:'legacy'}).github).toEqual(github)
})

it('regression: explicit dependency exposes predecessor evidence without a shared goal', () => {
  const f = fixture(); f.add('a'); const prior = f.ticket('prior', 'a'); f.ticket('next', 'a')
  f.projects.handle(['task', 'plan'], { ticket: 'next', 'depends-on': 'prior' })
  prior.ended = { at: prior.createdAt, by: 'executor', outcome: 'completed' }
  prior.assignments = [{ id: 'prior-assignment', state: 'ended', createdAt: prior.createdAt, report: { state: 'ready', summary: 'Artifact is /isolated/prior/output.json; schema version 7', at: prior.createdAt } }]
  f.store.tickets.save(prior)
  f.store.put('orca-assignment', 'prior-assignment', { dispatchId: 'd', settled: 'm' })
  f.store.put('execution', 'prior-assignment', { dispatchId: 'd', outcome: 'succeeded' })
  expect(f.projects.blocked('next')).toBeUndefined()
  expect(JSON.stringify(f.projects.context('next'))).toContain('/isolated/prior/output.json')
})

it('continues a workline on its exact location, keeps separate identities and refuses ambiguous parallel directories', () => {
  const f = fixture(); f.add('a')
  f.projects.handle(['goal','add'], {id:'g',name:'Restore',projects:'a'})
  const prior = f.ticket('prior','a')
  f.projects.handle(['task','plan'], {ticket:prior.id,goal:'g'})
  const prepare = (id: string, extra = {}) => {
    const ticket = {...prior, id, execution: undefined, ended: undefined}
    f.projects.bind(ticket, {project:'a',goal:'g',...extra}); f.store.tickets.save(ticket); return ticket
  }
  expect(() => prepare('duplicate')).toThrow('already has open work')
  expect(f.store.get('ticket-target','duplicate')).toBeUndefined()
  prior.execution = {name:'prior',directory:f.dir,assignment:'restore'}
  prior.ended = {at:prior.createdAt,by:'executor',outcome:'completed'}; f.store.tickets.save(prior)
  const next = prepare('next')
  expect(f.store.get<any>('task-plan',next.id).continueFrom).toBe(prior.id)
  expect(f.projects.directory(next.id)).toBe(f.dir)
  expect(f.projects.blocked(next.id)).toContain('resources')
  f.store.put('orca-assignment','old',{ticketId:prior.id,finished:true,releaseState:'released'})
  expect(f.projects.blocked(next.id)).toBeUndefined()
  const parallel = prepare('parallel',{workspace:'isolated'})
  expect(f.projects.directory(parallel.id)).toBeUndefined()
  const publishing = prepare('publishing', {publish:'true'})
  expect(f.store.get<any>('task-plan', publishing.id).continueFrom).toBeUndefined()
  expect(() => f.projects.handle(['goal','close'],{id:'g'})).toThrow('open work')
})

it('isolates engineering facts by component, location and goal and protects owner decisions', () => {
  const f = fixture(); f.add('a'); f.add('b'); f.ticket('a1','a'); f.ticket('a2','a'); f.ticket('b1','b')
  f.projects.handle(['location','add'], {id:'second',name:'second',component:'a',repository:f.dir})
  const other = {...f.store.tickets.get('a1')!,id:'other-location'}; f.store.tickets.save(other); f.projects.bind(other,{project:'a',location:'second'})
  f.projects.handle(['goal','add'],{id:'g',name:'restore',projects:'a'})
  f.projects.handle(['task','plan'],{ticket:'a1',goal:'g'})
  const fact = {name:'environment',source:'evidence/verified.json',version:'1',text:'Use report venv; account is separate'}
  const saved = f.projects.memo('a1','exec','add',fact) as any
  expect(f.projects.memo('a1','exec','add',fact)).toEqual(saved)
  expect(() => f.projects.memo('a1','exec','add',{...fact,text:'Conflicting unversioned overwrite'})).toThrow('already exists')
  expect((f.projects.context('a2') as any).knowledge).toHaveLength(1)
  expect((f.projects.context('other-location') as any).knowledge).toHaveLength(0)
  expect((f.projects.context('b1') as any).knowledge).toHaveLength(0)
  f.projects.memo('a1','exec','add',{...fact,name:'handoff',scope:'goal'})
  expect((f.projects.context('a1') as any).knowledge).toHaveLength(2)
  expect((f.projects.context('a2') as any).knowledge).toHaveLength(1)
  expect(() => f.projects.memo('b1','exec','supersede',{...fact,id:saved.id})).toThrow('exact scope')
  expect(() => f.projects.memo('a1','exec','supersede',{...fact,id:saved.id,name:'Different rule'})).toThrow('preserves')
  f.projects.handle(['knowledge','add'],{...fact,id:'decision',project:'a',component:'a'})
  expect(() => f.projects.memo('a1','exec','supersede',{...fact,id:'decision'})).toThrow('decisions are protected')
  const update = {...fact,id:saved.id,version:'2',text:'New verified environment'}
  const replacement = f.projects.memo('a1','exec','supersede',update)
  expect(f.projects.memo('a1','exec','supersede',update)).toEqual(replacement)
  expect(f.store.get<any>('knowledge',saved.id).supersededBy).toBeTruthy()
})

it('explicit legacy adoption preserves execution and cannot move an already scoped ticket', () => {
  const f=fixture(); f.add('a'); const t=f.ticket('legacy','a')
  t.assignments=[{id:'active',state:'running',createdAt:t.createdAt}]; t.execution={name:'legacy',directory:f.dir,assignment:'unchanged'};f.store.tickets.save(t)
  f.store.put('orca-assignment','active',{id:'active',ticketId:t.id,dispatchId:'keep'})
  f.projects.handle(['goal','add'],{id:'g',name:'Existing business objective',projects:'a'})
  const peer=f.ticket('peer','a'); peer.ended={at:new Date().toISOString(),by:'executor',outcome:'completed'}; peer.execution={name:'peer',directory:f.dir+'/peer',assignment:'peer'}; f.store.tickets.save(peer)
  f.projects.handle(['task','plan'],{ticket:peer.id,goal:'g'})
  f.store.delete('task-plan',t.id)
  expect(() => f.projects.handle(['task','plan'],{ticket:t.id,goal:'g'})).toThrow('frozen')
  f.projects.handle(['goal','adopt'],{id:'g',ticket:t.id})
  expect(f.projects.workspaceOwner(t.id)).toBe(t.id)
  expect(f.store.get<any>('task-plan',t.id).continueFrom).toBeUndefined()
  expect(f.store.tickets.get(t.id)).toEqual(t)
  expect(f.store.get<any>('orca-assignment','active').dispatchId).toBe('keep')
  f.projects.handle(['goal','add'],{id:'other',name:'Other',projects:'a'})
  expect(() => f.projects.handle(['goal','adopt'],{id:'other',ticket:t.id})).toThrow()
})

it('binds several repositories to one immutable business task and scopes all workspace context', () => {
  const f = fixture(); f.add('a'); f.add('b')
  const second = realpathSync(mkdtempSync(join(tmpdir(), 'osa-project-repo-')))
  clean.push(() => rmSync(second, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', second])
  f.projects.handle(['component', 'add'], { id: 'api', name: 'API', project: 'a' })
  f.projects.handle(['location', 'add'], { id: 'api', name: 'API', component: 'api', repository: second })
  expect(f.projects.resolve({project: 'a', location: 'api'}).repository).toBe(second)
  const ticket = {...f.ticket('old', 'b'), id: 'multi'}
  f.projects.bind(ticket, {project: 'a', locations: 'a,api'}); f.store.tickets.save(ticket)
  expect(f.projects.targets(ticket.id).map(target => target.locationId)).toEqual(['a', 'api'])
  expect(() => f.projects.bind(ticket, {project: 'a', locations: 'api'})).toThrow('immutable')
  expect(() => f.projects.resolve({project: 'a', locations: 'a,b'})).toThrow('chosen project')
  f.store.put('ticket-workspace', `${ticket.id}:api`, {ticketId: ticket.id, locationId: 'api', repository: second, directory: second + '/work', name: 'multi'})
  expect(f.projects.directory(ticket.id, 'api')).toBe(second + '/work')
  const fact = {name:'API environment',source:'checked',version:'1',text:'API uses its own test command'}
  f.projects.memo(ticket.id, 'executor', 'add', {...fact,location:'api'})
  expect(JSON.stringify(f.projects.context(ticket.id))).toContain('API uses its own test command')
  expect(JSON.stringify(f.projects.context('old'))).not.toContain('API uses its own test command')
  f.projects.handle(['location', 'archive'], {id:'api'})
  expect(f.projects.blocked(ticket.id)).toContain('archived')
})
