import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { App } from '../src/app.ts'
import { Store } from '../src/store.ts'
import { randomUUID } from 'node:crypto'
import type { Executor } from '../vendor/dsh-core/src/index.ts'

const dirs: string[] = [], stores: Store[] = []
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'osa-app-')); dirs.push(dir)
  const store = new Store(join(dir, 'db')); stores.push(store)
  const executor: Executor = { start: (ticket, assignment) => store.put('launch', assignment.id, { ticket: ticket.id }), deliver() {}, stop() {} }
  const app = new App(store, executor, 'owner')
  let lease: string | undefined
  const call = (command: string[], options: Record<string, string> = {}) => app.handle({ command, options: { ...(lease ? { lease } : {}), ...options }, id: 'request' }) as any
  lease = call(['router', 'attach']).token
  return { app, store, call, executor, dir }
}
test('durable intake, routing, report and outbox survive restart without duplicate logical effects', () => {
  const { app, store, call, executor } = setup()
  call(['intake'], { id: 'input-1', text: 'Make a greeting' })
  call(['intake'], { id: 'input-1', text: 'Make a greeting' })
  expect(call(['router', 'wait']).candidates).toHaveLength(1)
  const decision = call(['route', 'accept'], { trigger: 'input-1', title: 'Greeting', scope: 'Create greeting' })
  call(['route', 'accept'], { trigger: 'input-1', title: 'Greeting', scope: 'Create greeting' })
  expect(store.list('launch')).toHaveLength(1)
  const ticket = store.tickets.get(decision.ticketId)!, assignment = ticket.assignments[0].id
  store.put('capability', assignment, { token: 'secret' })
  app.engine.assignmentStarted(ticket.id, assignment)
  const worker = { ticket: ticket.id, assignment, token: 'secret', summary: 'Greeting created; checked content.' }
  expect(() => call(['report', 'ready'], { ...worker, token: 'wrong' })).toThrow('capability')
  call(['read'], worker)
  call(['report', 'ready'], worker)
  const restarted = new App(store, executor, 'owner')
  restarted.handle({ command: ['report', 'ready'], options: worker, id: 'replay' })
  expect(store.list('outbox')).toHaveLength(1)
  const mail = call(['router', 'wait']).messages[0]
  expect(mail.text).toContain('Greeting')
  call(['router', 'ack'], { message: mail.id })
  expect(call(['router', 'wait']).messages).toHaveLength(0)
})

test('report effects and receipts commit together, deduplicate replay and reject ID collisions', () => {
  const { app, store, call } = setup()
  call(['intake'], { id: 'receipt-input', text: 'Create result' })
  const { ticketId } = call(['route', 'accept'], { trigger: 'receipt-input', title: 'Result', scope: 'Create result' })
  const assignment = store.tickets.get(ticketId)!.assignments[0].id
  store.put('capability', assignment, { token: 'secret' })
  app.engine.assignmentStarted(ticketId, assignment)
  const options = { ticket: ticketId, assignment, token: 'secret', summary: 'Done' }
  call(['read'], options)
  const request = { id: 'report-1', command: ['report', 'ready'], options }
  expect(() => store.atomic(() => { app.acceptReport(request); throw new Error('rollback') })).toThrow('rollback')
  expect(store.list('report-receipt')).toHaveLength(0)
  expect(store.list('outbox')).toHaveLength(0)
  expect(store.tickets.get(ticketId)?.ended).toBeUndefined()
  const result = app.acceptReport(request)
  expect(app.acceptReport(request)).toEqual(result)
  expect(store.list('outbox')).toHaveLength(1)
  expect(store.list('report-receipt')).toHaveLength(1)
  expect(() => app.acceptReport({ ...request, options: { ...options, summary: 'Changed' } })).toThrow('different content')
})

test('a waiting workline resumes across entries and service restart with scoped memo and the same durable brief', () => {
  const dir = mkdtempSync(join(tmpdir(),'osa-continuity-')); dirs.push(dir)
  execFileSync('git',['init','-q',dir])
  let store = new Store(join(dir,'state.db')); stores.push(store)
  const config = {chatId:'oc_test',ownerId:'ou_owner',botId:'ou_bot',appId:'cli_test'}
  const executor: Executor = {start(){},deliver(){},stop(){}}
  let app = new App(store,executor,'owner',undefined,config)
  const call = (command: string[], options: Record<string,string>) => app.handle({command,options,id:'test'}) as any
  const lease = call(['router','attach'],{}).token
  for (const [kind,options] of [ ['project',{id:'p',name:'Project'}],['component',{id:'c',name:'Report',project:'p'}],['location',{id:'l',name:'Local SSH workspace',component:'c',repository:dir}],['goal',{id:'g',name:'Restore report',projects:'p'}] ] as const)
    call([kind,'add'],{...options,lease})
  call(['intake'],{id:'initial',text:'Investigate report',lease})
  const {ticketId} = call(['route','accept'],{trigger:'initial',title:'Report',scope:'Inspect only',project:'p',goal:'g',workspace:'inspect',lease})
  let assignment = store.tickets.get(ticketId)!.assignments.at(-1)!.id
  store.put('capability',assignment,{token:'cap1'}); app.engine.assignmentStarted(ticketId,assignment)
  const auth = {ticket:ticketId,assignment,token:'cap1'}
  call(['memo','add'],{...auth,name:'Account scope',source:'owner-message-1',version:'1',text:'Report account differs from customer-service account'})
  call(['report','waiting'],{...auth,summary:'Waiting for login',question:'Please log in', 'next-step':'Verify identity then continue',evidence:'/durable/report-check.json'})
  const before = call(['read'],auth)
  expect(readFileSync(before.contextFile,'utf8')).toContain('Verify identity then continue')
  app.engine.turnEnded(ticketId,assignment)
  store.close(); stores.splice(stores.indexOf(store),1)
  store = new Store(join(dir,'state.db')); stores.push(store); app = new App(store,executor,'owner',undefined,config)
  app.engine.receive({id:'feishu-followup',source:'feishu',actor:{source:'feishu',id:'ou_owner'},human:true,addressed:'direct',threads:[{source:'feishu',id:'new-topic'}],text:'Logged in, continue',meta:{chatId:'oc_test'},at:new Date().toISOString()})
  app.engine.evaluateDue()
  call(['route','attach'],{ticket:ticketId,trigger:'feishu-followup',lease})
  const resumed = store.tickets.get(ticketId)!
  expect(resumed.ended).toBeUndefined()
  expect(store.tickets.list()).toHaveLength(1)
  assignment = resumed.assignments.at(-1)!.id
  store.put('capability',assignment,{token:'cap2'}); app.engine.assignmentStarted(ticketId,assignment)
  const after = call(['read'],{ticket:ticketId,assignment,token:'cap2'})
  expect(after.contextFile).toBe(before.contextFile)
  expect(after.context.handoff.nextStep).toContain('Verify identity')
  expect(after.context.knowledge[0].text).toContain('differs')
  expect(after.triggers.some((t:any)=>t?.id==='feishu-followup')).toBe(true)
})
test('owner-only intake, lease fencing, input collision and executor assignment scope', () => {
  const { app, call, store } = setup()
  expect(() => call(['router', 'attach'], { lease: '' })).toThrow('held')
  expect(() => call(['intake'], { lease: 'wrong', id: 'a', text: 'x' })).toThrow('invalid')
  call(['intake'], { id: 'a', text: 'x' })
  call(['intake'], { id: 'old-window-id', text: 'Legacy replay', thread: 'window' })
  expect(()=>call(['intake'],{id:'old-window-id',text:'Legacy replay'})).not.toThrow()
  expect(() => call(['intake'], { id: 'a', text: 'y' })).toThrow('different content')
  app.engine.receive({ id: 'foreign', source: 'router', actor: { source: 'router', id: 'other' }, human: true, addressed: 'direct', at: new Date().toISOString(), text: 'no', threads: [{ source: 'router', id: 'other' }], meta: {} })
  expect(() => app.engine.decide('foreign', { kind: 'accept', title: 'no', scope: 'no', reason: 'no' })).toThrow()
  expect(store.tickets.list()).toHaveLength(0)
  const decision = call(['route', 'accept'], { trigger: 'a', title: 'Owner task', scope: 'Owner scope' })
  call(['intake'], { id: 'new-unscoped-request', text: 'A separate project request' })
  expect(store.tickets.get(decision.ticketId)!.inputs).toHaveLength(0)
  expect(call(['router','wait']).candidates.some((candidate:any)=>candidate.triggers.some((t:any)=>t.id==='new-unscoped-request'))).toBe(true)
  expect(() => call(['route', 'attach'], { ticket: decision.ticketId, trigger: 'foreign' })).toThrow('Only owner')
})

test('idle Router resumes intake and dispatch with its latest lease, without duplicate work', () => {
  const { store, call } = setup()
  const lease = store.get<{ token: string; expires: number }>('router', 'lease')!
  store.put('router', 'lease', { ...lease, expires: Date.now() - 1 })
  call(['intake'], { id: 'after-idle', text: 'Resume after thinking for more than a minute' })
  store.put('router', 'lease', { ...lease, expires: Date.now() - 1 })
  const decision = call(['route', 'accept'], { trigger: 'after-idle', title: 'After idle', scope: 'Owner goal' })
  call(['route', 'accept'], { trigger: 'after-idle', title: 'After idle', scope: 'Owner goal' })
  expect(store.list('launch')).toHaveLength(1)
  expect(store.tickets.get(decision.ticketId)).toBeDefined()
  expect(store.get<{ expires: number }>('router', 'lease')!.expires).toBeGreaterThan(Date.now())
})

test('replaced Router cannot resume with its old token even after the successor expires', () => {
  const { app, store, call } = setup()
  const old = store.get<{ token: string; expires: number }>('router', 'lease')!
  store.put('router', 'lease', { ...old, expires: Date.now() - 1 })
  const next = app.handle({ command: ['router', 'attach'], options: {}, id: 'successor' }) as typeof old
  expect(next.token).not.toBe(old.token)
  expect(() => call(['intake'], { id: 'stale', text: 'Must not dispatch' })).toThrow('invalid')
  store.put('router', 'lease', { ...next, expires: Date.now() - 1 })
  expect(() => call(['intake'], { id: 'stale', text: 'Must not dispatch' })).toThrow('invalid')
  expect(store.list('launch')).toHaveLength(0)
})

test('status distinguishes unfinished business from released Executor slots', () => {
  const { store, call } = setup()
  call(['intake'], { id: 'blocked-work', text: 'Task with a partial result' })
  const { ticketId } = call(['route', 'accept'], { trigger: 'blocked-work', title: 'Partial', scope: 'Owner goal' })
  const ticket = store.tickets.get(ticketId)!, assignment = ticket.assignments.at(-1)!
  assignment.state = 'running'
  assignment.report = { state: 'blocked', summary: 'Needs owner decision', at: ticket.updatedAt }
  store.tickets.save(ticket)
  store.put('orca-assignment', assignment.id, { id: assignment.id, ticketId, settled: 'done-message', released: true, finished: true })
  expect(call(['status']).executionBindings).toEqual([expect.objectContaining({ id: assignment.id, holdsExecutorSlot: false, finished: true })])
  expect(store.tickets.get(ticketId)?.ended).toBeUndefined()
  store.put('orca-assignment', assignment.id, { id: assignment.id, ticketId, settled: 'done-message', released: true })
  expect(call(['status']).executionBindings[0].holdsExecutorSlot).toBe(true)
})

test('late target binding rechecks the incoming GitHub repository and rolls back a mismatch', () => {
  const f=setup(), owner={id:'42',login:'owner'}, configs=[{repository:'owner/a',owner},{repository:'owner/b',owner}]
  const app=new App(f.store,f.executor,'owner',configs[0],undefined,undefined,configs)
  const lease=f.store.get<{token:string}>('router','lease')!.token
  const call=(command:string[],options:Record<string,string>={})=>app.handle({command,options:{lease,...options},id:'test'}) as any
  call(['intake'],{id:'legacy-request',text:'Existing unbound task'})
  const ticketId=call(['route','accept'],{trigger:'legacy-request',title:'Legacy',scope:'Existing scope'}).ticketId
  execFileSync('git',['init','-q',f.dir])
  call(['project','add'],{id:'a',name:'a'})
  call(['component','add'],{id:'a',name:'a',project:'a','github-repository':'owner/a','github-owner-id':'42','github-owner-login':'owner'})
  call(['location','add'],{id:'a',name:'a',component:'a',repository:f.dir})
  app.engine.receive({id:'foreign-repo',source:'github',actor:{source:'github',id:'42'},human:true,addressed:'direct',at:new Date().toISOString(),text:'Scope B',threads:[{source:'github',id:'owner/b:1'}],meta:{repository:'owner/b'}})
  expect(()=>call(['route','attach'],{ticket:ticketId,trigger:'foreign-repo',project:'a'})).toThrow('another component')
  expect(f.store.get('ticket-target',ticketId)).toBeUndefined()
  expect(f.store.tickets.get(ticketId)!.inputs).toHaveLength(0)
})

test('GitHub numeric owner and selected repository gate admission; Router cannot ack remote outbox', () => {
  const { store, executor } = setup()
  const app = new App(store, executor, 'owner', { repository: 'owner/repo', owner: { id: '42', login: 'owner' } })
  const trigger = { id: 'github-good', source: 'github', actor: { source: 'github', id: '42' }, human: true, addressed: 'direct' as const, at: new Date().toISOString(), text: 'Goal', threads: [{ source: 'github', id: 'owner/repo:1' }], meta: { repository: 'owner/repo' }, channel: { source: 'github', thread: 'owner/repo:1', address: { repository: 'owner/repo', number: '1' } } }
  app.engine.receive({ ...trigger, id: 'github-foreign', actor: { source: 'github', id: '99' } })
  expect(() => app.engine.decide('github-foreign', { kind: 'accept', title: 'no', scope: 'no', reason: 'no' })).toThrow()
  expect(app.engine.receive({ ...trigger, id: 'other-repo', meta: { repository: 'owner/other' } })).toBe('filtered')
  app.engine.receive(trigger)
  const decision = app.engine.decide(trigger.id, { kind: 'accept', title: 'yes', scope: 'yes', reason: 'yes' })
  expect(decision.ticketId).toBeTruthy()
  const lease = store.get<{ token: string }>('router', 'lease')!.token
  store.put('outbox', 'remote', { id: 'remote', channel: trigger.channel, status: 'pending', text: 'Remote reply', kind: 'reply' })
  const call = (command: string[], options = {}) => app.handle({ command, options: { lease, ...options }, id: 'test' }) as any
  expect(call(['router', 'wait']).messages).toEqual([])
  call(['router', 'ack'], { message: 'remote' })
  expect(store.get<{ status: string }>('outbox', 'remote')!.status).toBe('pending')
})

test('Feishu admission and manual attachment both enforce the configured human and chat', () => {
  const { store, executor } = setup()
  const app = new App(store, executor, 'owner', undefined, { chatId: 'oc_test', ownerId: 'ou_owner', botId: 'ou_bot', appId: 'cli_test' })
  const trigger = { id: 'feishu-owner', source: 'feishu', actor: { source: 'feishu', id: 'ou_owner' }, human: true, addressed: 'direct' as const,
    at: new Date().toISOString(), text: 'Build a greeting', threads: [{ source: 'feishu', id: 'oc_test:om_root' }],
    channel: { source: 'feishu', thread: 'oc_test:om_root', address: { chatId: 'oc_test', messageId: 'om_root' } }, meta: { chatId: 'oc_test' } }
  expect(app.engine.receive({ ...trigger, id: 'wrong-chat', meta: { chatId: 'oc_other' } })).toBe('filtered')
  app.engine.receive({ ...trigger, id: 'wrong-user', actor: { source: 'feishu', id: 'ou_other' } })
  app.engine.receive({ ...trigger, id: 'bot', human: false })
  for (const id of ['wrong-user', 'bot']) expect(() => app.engine.decide(id, { kind: 'accept', title: 'x', scope: 'x', reason: 'x' })).toThrow()
  app.engine.receive(trigger)
  const decision = app.engine.decide(trigger.id, { kind: 'accept', title: 'Greeting', scope: 'Greeting', reason: 'Owner' })
  const lease = store.get<{ token: string }>('router', 'lease')!.token
  const call = (command: string[], options = {}) => app.handle({ command, options: { lease, ...options }, id: 'test' }) as any
  // Even a persisted input from an earlier configuration cannot bypass the manual attachment gate.
  store.triggers.save({ ...trigger, id: 'old-chat', meta: { chatId: 'oc_other' } })
  for (const id of ['wrong-user', 'bot', 'old-chat']) expect(() => call(['route', 'attach'], { ticket: decision.ticketId, trigger: id })).toThrow('Only owner')
  store.put('outbox', 'feishu-mail', { id: 'feishu-mail', channel: trigger.channel, status: 'pending', text: 'Reply', kind: 'reply' })
  call(['router', 'ack'], { message: 'feishu-mail' })
  expect(store.get<{ status: string }>('outbox', 'feishu-mail')!.status).toBe('pending')
  expect(call(['router', 'wait']).messages).toEqual([])
  app.engine.receive({ ...trigger, id:'status-question', threads:[{source:'feishu',id:'oc_test:status'}] })
  call(['reply'],{trigger:'status-question',text:'Project status from durable evidence'})
  call(['reply'],{trigger:'status-question',text:'Project status from durable evidence'})
  expect(store.list<any>('outbox').filter(m=>m.text==='Project status from durable evidence')).toHaveLength(1)
  expect(store.tickets.list()).toHaveLength(1)
  expect(() => call(['reply'],{trigger:'wrong-user',text:'private status'})).toThrow('owner')
  expect(call(['route', 'retry'], { ticket: decision.ticketId })).toEqual({ ticketId: decision.ticketId })
  expect(() => call(['route', 'retry'], { ticket: decision.ticketId, lease: 'wrong' })).toThrow('invalid')
  expect(() => call(['route', 'retry'], { ticket: 'absent' })).toThrow('open ticket')
  call(['route', 'stop'], { ticket: decision.ticketId })
  expect(() => call(['route', 'retry'], { ticket: decision.ticketId })).toThrow('open ticket')
})

test('generic targets, lease-guarded management and cross-entry attachment keep one scoped task', () => {
  const { store, executor, dir } = setup()
  const app = new App(store, executor, 'owner', undefined, { chatId: 'oc_test', ownerId: 'ou_owner', botId: 'ou_bot', appId: 'cli_test' })
  const lease = store.get<{token: string}>('router', 'lease')!.token
  const call = (command: string[], options: Record<string,string> = {}) => app.handle({ command, options: {lease,...options}, id: 'test' }) as any
  for (const id of ['arbitrary-a', 'arbitrary-b']) {
    const root = join(dir, id); execFileSync('git', ['init', '-q', root])
    call(['project', 'add'], {id, name: id})
    call(['component', 'add'], {id, name: id, project: id})
    call(['location', 'add'], {id, name: id, component: id, repository: root})
  }
  expect(() => call(['project', 'pause'], {id:'arbitrary-a', lease:'wrong'})).toThrow('lease')
  call(['intake'], {id:'local-a', text:'Create greeting', thread:'local-a'})
  expect(() => call(['route','accept'], {trigger:'local-a', title:'Greeting', scope:'Create greeting'})).toThrow('unambiguous')
  const a = call(['route','accept'], {trigger:'local-a', project:'arbitrary-a', title:'Greeting', scope:'Create greeting', name:'greeting'}).ticketId
  call(['intake'], {id:'local-b', text:'Create greeting', thread:'local-b'})
  const b = call(['route','accept'], {trigger:'local-b', project:'arbitrary-b', title:'Greeting', scope:'Create greeting', name:'greeting'}).ticketId
  const remote = {id:'feishu-followup',source:'feishu',actor:{source:'feishu',id:'ou_owner'},human:true,addressed:'direct' as const,at:new Date().toISOString(),text:'Add a newline',threads:[{source:'feishu',id:'oc_test:om_root'}],meta:{chatId:'oc_test'},channel:{source:'feishu',thread:'oc_test:om_root',address:{chatId:'oc_test',messageId:'om_root'}}}
  app.engine.receive(remote)
  expect(() => call(['route','attach'], {ticket:a,trigger:remote.id,project:'arbitrary-b'})).toThrow('immutable')
  call(['route','attach'], {ticket:a,trigger:remote.id})
  call(['route','attach'], {ticket:a,trigger:remote.id})
  expect(store.tickets.get(a)!.inputs.filter(input=>input.kind==='trigger'&&input.triggerId===remote.id)).toHaveLength(1)
  expect(() => call(['route','attach'], {ticket:b,trigger:remote.id})).toThrow('worker decides')
  expect(store.list('launch')).toHaveLength(2)
  const target = store.get('ticket-target', a)
  call(['project','update'], {id:'arbitrary-a',name:'Renamed'})
  expect(call(['status'],{project:'Renamed'}).tickets.map((t:any)=>t.id)).toEqual([a])
  expect(() => call(['route','accept'], {trigger:'local-a',project:'arbitrary-b',title:'x',scope:'x'})).toThrow('immutable')
  expect(store.get('ticket-target',a)).toEqual(target)
  // Reverse direction: a Feishu-origin task receives an explicit Router continuation.
  app.engine.receive({...remote,id:'feishu-origin',threads:[{source:'feishu',id:'oc_test:other'}]})
  const c = call(['route','accept'],{trigger:'feishu-origin',project:'arbitrary-b',title:'Remote origin',scope:'Exact owner goal'}).ticketId
  call(['intake'],{id:'router-followup',text:'Keep the existing scope',thread:'continuation'})
  call(['route','attach'],{ticket:c,trigger:'router-followup'})
  expect(store.tickets.get(c)!.inputs.some(input=>input.kind==='trigger'&&input.triggerId==='router-followup')).toBe(true)
  expect(store.tickets.list()).toHaveLength(3)
})

test('regression: Executor question can be relayed through supported Router reply', () => {
  const f = setup(); f.call(['intake'], { id: 'question-goal', text: 'Implement a goal' })
  const { ticketId } = f.call(['route', 'accept'], { trigger: 'question-goal', title: 'Goal', scope: 'Goal' })
  const assignment = f.store.tickets.get(ticketId)!.assignments[0].id
  f.store.put('capability', assignment, { token: 'secret' }); f.app.engine.assignmentStarted(ticketId, assignment)
  f.call(['report', 'waiting'], { ticket: ticketId, assignment, token: 'secret', summary: 'Need decision', question: 'Which account?' })
  expect(f.store.tickets.get(ticketId)?.attention?.question).toBe('Which account?')
  expect(() => f.call(['reply'], { ticket: ticketId, text: 'Which account?', question: 'Which account?', purpose: 'attention' })).not.toThrow()
})

test('question, acknowledgement, answer and clearing use durable core reply identities', () => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime('2026-11-07T00:00:00.000Z')
  const f = setup(); f.call(['intake'], { id: 'goal', text: 'Do it', thread: 'same' })
  const { ticketId } = f.call(['route', 'accept'], { trigger: 'goal', title: 'Goal', scope: 'Goal' })
  const assignment = f.store.tickets.get(ticketId)!.assignments[0].id
  f.store.put('capability', assignment, { token: 'secret' }); f.app.engine.assignmentStarted(ticketId, assignment)
  const auth = { ticket: ticketId, assignment, token: 'secret' }
  f.call(['acknowledge'], { ...auth, trigger: 'goal', text: 'Received' })
  vi.setSystemTime('2026-11-07T00:01:00.000Z')
  f.call(['acknowledge'], { ...auth, trigger: 'goal', text: 'Replay' })
  expect(f.store.list<any>('outbox').filter(m => m.kind === 'acknowledgement')).toHaveLength(1)
  expect(f.store.list<any>('outbox').find(m => m.kind === 'acknowledgement').createdAt).toBe('2026-11-07T00:00:00.000Z')
  f.call(['report', 'waiting'], { ...auth, summary: 'Need choice', question: 'Choose account?', 'asked-by': 'goal' })
  expect(f.call(['router', 'wait']).notices).toEqual(expect.arrayContaining([expect.objectContaining({kind:'attention'})]))
  f.call(['reply'], { ticket: ticketId, purpose: 'attention', question: 'Choose account?', text: 'Choose account?' })
  expect(f.call(['router', 'wait']).notices.some((n:any)=>n.kind==='attention')).toBe(false)
  f.call(['report', 'progress'], { ...auth, summary: 'Choice resolved', question: '' })
  expect(f.store.tickets.get(ticketId)?.attention).toBeUndefined()
  expect(f.store.list<any>('outbox').some(m=>m.status==='dropped')).toBe(true)
  f.call(['intake'], { id: 'follow-question', text: 'What did you find?', thread: 'same' })
  f.call(['route', 'attach'], {ticket: ticketId, trigger: 'follow-question'})
  f.call(['report', 'progress'], { ...auth, summary: 'Found the cause', answers: 'follow-question' })
  expect(f.call(['router','wait']).notices).toEqual(expect.arrayContaining([expect.objectContaining({kind:'answer',triggerId:'follow-question'})]))
  f.call(['report', 'progress'], { ...auth, summary: 'Later unrelated progress' })
  expect(f.call(['router','wait']).notices).toEqual(expect.arrayContaining([expect.objectContaining({kind:'answer',triggerId:'follow-question',text:'Found the cause'})]))
  f.call(['reply'], { trigger: 'follow-question', text: 'Found the cause' })
  expect(f.call(['router','wait']).notices.some((n:any)=>n.kind==='answer')).toBe(false)
})


test('shared chat is only a reply address; explicit attachment preserves the original mandate', () => {
  const f=setup()
  for (const id of ['daily','online','faq']) {
    f.call(['intake'],{id,text:id,thread:'management-chat'})
    f.call(['route','accept'],{trigger:id,title:id,scope:id})
  }
  expect(f.store.tickets.list()).toHaveLength(3)
  expect(f.store.tickets.list().every(t=>t.inputs.length===0)).toBe(true)
  const ticket=f.store.tickets.list().find(t=>t.title==='online')!, assignment=ticket.assignments[0].id
  f.app.engine.assignmentStarted(ticket.id,assignment); f.store.put('capability',assignment,{token:'test'})
  f.call(['intake'],{id:'phase2',text:'Logged in, continue phase two',thread:'management-chat'})
  f.call(['route','attach'],{ticket:ticket.id,trigger:'phase2',scope:'Complete online recovery including phase two'})
  f.call(['route','attach'],{ticket:ticket.id,trigger:'phase2',scope:'Complete online recovery including phase two'})
  const auth={ticket:ticket.id,assignment,token:'test'}
  const context=f.call(['read'],auth), input=context.ticket.inputs[0].id
  expect(context.ticket.mandate.scope).toBe('online')
  expect(context.triggers.some((trigger:any) => trigger.text === 'Logged in, continue phase two')).toBe(true)
  expect(context.scopeRevisions).toHaveLength(0)
  expect(f.store.tickets.list().filter(t=>t.id!==ticket.id).every(t=>t.inputs.length===0)).toBe(true)
  expect(context.ticket.inputs[0].readAt).toBeTruthy()
  f.call(['report','ready'],{...auth,summary:'Phase two completed and verified'})
  expect(f.store.get('input-resolution',input)).toBeUndefined()
  expect(f.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
  expect(f.store.list<any>('outbox')[0].channel.thread).toBe('management-chat')
})

test('routing preserves owner words and cannot inject Router scopes or notes', () => {
  const f = setup()
  const original = '检查这个项目的启动问题。\n不要改线上。'
  f.call(['intake'], { id: 'verbatim', text: original })
  const { ticketId } = f.call(['route', 'accept'], { trigger: 'verbatim', title: 'Startup', scope: 'Router plan: rewrite the scheduler', note: 'Deploy immediately' })
  let ticket = f.store.tickets.get(ticketId)!
  expect(ticket.mandate.scope).toBe(original)
  expect(ticket.execution?.assignment).toBe(original)
  const correction = '找到原因后修复本地代码，不要推送。'
  f.call(['intake'], { id: 'owner-correction', text: correction })
  f.call(['route', 'attach'], { ticket: ticketId, trigger: 'owner-correction', scope: 'Invented deployment authorization', note: 'Stop at the first error' })
  f.call(['route', 'attach'], { ticket: ticketId, trigger: 'owner-correction', scope: 'Different Router rewrite' })
  ticket = f.store.tickets.get(ticketId)!
  expect(ticket.mandate.scope).toBe(original)
  expect(ticket.execution?.assignment).toBe(original)
  expect(f.store.triggers.get('owner-correction')?.text).toBe(correction)
  expect(ticket.inputs).toHaveLength(1)
  expect(ticket.inputs[0]).not.toHaveProperty('note')
  expect(f.store.list('scope-revision')).toHaveLength(0)
  f.call(['intake'], { id: 'second-original', text: '另一个原始请求' })
  expect(f.call(['route', 'accept'], { trigger: 'second-original', title: 'Another' }).ticketId).toBeTruthy()
})

test('status retains the original refusal after later progress replaces the current report', () => {
  const f = setup()
  f.call(['intake'], { id: 'misplaced', text: '修复报表' })
  const { ticketId } = f.call(['route', 'accept'], { trigger: 'misplaced', title: 'Report' })
  const assignment = f.store.tickets.get(ticketId)!.assignments[0].id
  f.store.put('capability', assignment, { token: 'test' })
  f.app.engine.assignmentStarted(ticketId, assignment)
  const original = '不是我这里的：本仓库没有该报表，请转到 reporting 项目。证据：项目目录清单。'
  const request = { id: 'refusal-1', command: ['report', 'blocked'], options: { ticket: ticketId, assignment, token: 'test', summary: original } }
  f.app.acceptReport(request)
  f.app.acceptReport({ ...request, id: 'progress-2', command: ['report', 'progress'], options: { ...request.options, summary: '补充了定位依据' } })
  const status = f.call(['status'])
  expect(status.reportReceipts.find((r: any) => r.id === 'refusal-1').result.assignments[0].report.summary).toBe(original)
})

test('ordinary progress remains readable without waking Router', () => {
  const f=setup(); f.call(['intake'],{id:'work',text:'Two steps'})
  const {ticketId}=f.call(['route','accept'],{trigger:'work',title:'Work',scope:'Both steps'})
  const assignment=f.store.tickets.get(ticketId)!.assignments[0].id
  f.app.engine.assignmentStarted(ticketId,assignment); f.store.put('capability',assignment,{token:'test'})
  f.call(['report','waiting'],{ticket:ticketId,assignment,token:'test',summary:'Step one done, step two remains'})
  expect(f.call(['router','wait']).notices.some((notice:any)=>notice.kind==='progress')).toBe(false)
  expect(f.call(['owner','status']).taskProgress.find((task:any)=>task.ticketId===ticketId).report.summary).toBe('Step one done, step two remains')
})


test('late followup is released by the core rather than rejecting the completion report', () => {
  const f=setup(); f.call(['intake'],{id:'original',text:'Stage one'})
  const {ticketId}=f.call(['route','accept'],{trigger:'original',title:'Stages',scope:'Only stage one'})
  const assignment=f.store.tickets.get(ticketId)!.assignments[0].id, auth={ticket:ticketId,assignment,token:'test'}
  f.app.engine.assignmentStarted(ticketId,assignment); f.store.put('capability',assignment,{token:'test'})
  f.call(['read'],auth)
  f.call(['intake'],{id:'new-scope',text:'Continue stage two'})
  f.call(['route','attach'],{ticket:ticketId,trigger:'new-scope',scope:'Both stages authorized'})
  expect(()=>f.call(['report','ready'],{...auth,summary:'Stage one done'})).not.toThrow()
  expect(f.store.tickets.get(ticketId)?.mandate.scope).toBe('Stage one')
  expect(f.store.threads.list().some(thread => thread.pending.includes('new-scope'))).toBe(true)
})


test('owner status and project management never acquire or renew a Router lease', () => {
  const f = setup(), owner = (action: string, options: Record<string,string> = {}) => f.app.handle({command:['owner',action], options, id:'panel-rpc'}) as any
  f.store.delete('router', 'lease')
  expect(owner('status').tickets).toEqual([])
  owner('project-add', {id:'panel-project', name:'Panel project'})
  expect(f.store.get('router','lease')).toBeUndefined()
  const lease = {token:'held-by-router', expires:Date.now() + 1000}
  f.store.put('router','lease',lease)
  owner('status'); f.app.handle({command:['status'],options:{},id:'read'})
  expect(f.store.get('router','lease')).toEqual(lease)
  expect(() => owner('execute',{text:'arbitrary shell'})).toThrow('Unknown owner')
})

test('panel requests remain candidates until routed and keep owner project, locations and verbatim text', () => {
  const f=setup(), owner=(action:string,options:Record<string,string>={}) => f.app.handle({command:['owner',action],options,id:'rpc'}) as any
  execFileSync('git',['init','-q',f.dir])
  owner('project-add',{id:'p',name:'Project'})
  owner('repository-add',{id:'local',name:'Repository',project:'p',repository:f.dir})
  const options={id:'request',project:'p',locations:'local',text:'  修复日期。\n不要推送。  '}
  const result=owner('request',options)
  owner('request',options)
  expect(f.store.tickets.list()).toHaveLength(0)
  const status=owner('status',{project:'p'})
  expect(status.candidates).toHaveLength(1)
  expect(status.triggers).toEqual([expect.objectContaining({id:'panel:request',source:'panel',text:options.text,actor:{source:'panel',id:'owner'},meta:{projectId:'p',locationIds:['local']}})])
  expect(() => owner('request',{...options,text:'Replacement'})).toThrow('different content')
  const {ticketId}=f.call(['route','accept'],{trigger:result.id,title:'Fix date'})
  expect(f.store.get<any>('ticket-target',ticketId).locationId).toBe('local')
  expect(f.store.tickets.get(ticketId)?.mandate.scope).toBe(options.text)
  expect(owner('status').routingHistory).toEqual(expect.arrayContaining([expect.objectContaining({ticketId})]))
  expect(() => f.call(['route','accept'],{trigger:result.id,title:'Wrong project',project:'missing'})).toThrow()
})

test('owner comments attach once, preserve mandate and return answers and results to the local task', () => {
  const f=setup(), owner=(action:string,options:Record<string,string>={}) => f.app.handle({command:['owner',action],options,id:'rpc'}) as any
  execFileSync('git',['init','-q',f.dir])
  owner('project-add',{id:'p',name:'Project'}); owner('repository-add',{id:'repo',name:'Repo',project:'p',repository:f.dir})
  owner('request',{id:'task',text:'Find the cause',project:'p'})
  const {ticketId}=f.call(['route','accept'],{trigger:'panel:task',title:'Cause'})
  const ticket=f.store.tickets.get(ticketId)!, assignment=ticket.assignments[0].id, auth={ticket:ticketId,assignment,token:'secret'}
  f.store.put('capability',assignment,{token:'secret'}); f.app.engine.assignmentStarted(ticketId,assignment)
  f.call(['report','waiting'],{...auth,summary:'Need detail',question:'Which date?'})
  const comment={id:'comment',ticket:ticketId,text:'  导出日期，保持时区。\n  '}
  owner('comment',comment); owner('comment',comment)
  const read=f.call(['read'],auth), input=read.ticket.inputs.find((input:any)=>input.triggerId==='panel:comment')
  expect(read.ticket.mandate.scope).toBe('Find the cause')
  expect(read.ticket.inputs.filter((input:any)=>input.triggerId==='panel:comment')).toHaveLength(1)
  expect(read.triggers.find((trigger:any)=>trigger.id==='panel:comment').text).toBe(comment.text)
  f.call(['ack'],{...auth,inputs:input.id})
  f.call(['report','progress'],{...auth,inputs:input.id,answers:'panel:comment',summary:'Timezone preserved',question:''})
  f.call(['read'],auth)
  f.store.put('config','two-layer',true)
  f.call(['report','ready'],{...auth,summary:'Cause fixed'})
  const status=owner('status'), mails=status.outbox.filter((mail:any)=>mail.channel.source==='panel')
  expect(mails).toEqual(expect.arrayContaining([expect.objectContaining({text:'Which date?',status:'sent'}),expect.objectContaining({text:'Timezone preserved',triggerId:'panel:comment',status:'sent',channel:expect.objectContaining({thread:'request:panel:task'})}),expect.objectContaining({text:'Cause fixed',status:'sent'})]))
  expect(status.inputResolutions).toEqual([expect.objectContaining({inputId:input.id,summary:'Timezone preserved'})])
  expect(f.call(['router','wait']).messages).toEqual([])
  owner('comment',{id:'after-result',ticket:ticketId,text:'Verify another export'})
  expect(f.store.tickets.get(ticketId)?.ended).toBeUndefined()
  expect(f.store.tickets.get(ticketId)?.mandate.scope).toBe('Find the cause')
})

test('invalid panel submissions retain the exact original and reason without wrong-target delivery', () => {
  const f=setup(), owner=(action:string,options:Record<string,string>={}) => f.app.handle({command:['owner',action],options,id:'rpc'}) as any
  owner('project-add',{id:'p',name:'Project'})
  const rejected={id:'bad',project:'missing',text:'  Never lose this request  '}
  expect(() => owner('request',rejected)).toThrow()
  expect(owner('status').rejectedSubmissions).toEqual([expect.objectContaining({...rejected,error:expect.any(String)})])
  expect(f.store.triggers.get('panel:bad')).toBeUndefined()
  expect(() => owner('comment',{id:'comment',ticket:'missing',text:'Exact comment'})).toThrow('existing task')
  expect(owner('status').rejectedSubmissions.at(-1).text).toBe('Exact comment')
  expect(() => f.app.handle({command:['owner','status'],options:[] as any,id:'invalid'})).toThrow('Invalid request')
})

test('publish option records no extra permission and does not forbid existing-directory placement', () => {
  const f=setup()
  f.call(['intake'],{id:'publish',text:'Publish this change under the project delivery rules'})
  const result=f.call(['route','accept'],{trigger:'publish',title:'Publish',publish:'true',workspace:'inspect'})
  expect(f.store.tickets.get(result.ticketId)?.mandate.scope).toBe('Publish this change under the project delivery rules')
  expect(f.store.get('publish-authorization',result.ticketId)).toBeUndefined()
})


test('owner stop records the actual owner and refuses further comments without a Router lease', () => {
  const f=setup(), owner=(action:string,options:Record<string,string>={})=>f.app.handle({command:['owner',action],options,id:'rpc'}) as any
  execFileSync('git',['init','-q',f.dir])
  owner('project-add',{id:'p',name:'Project'}); owner('repository-add',{id:'repo',name:'Repo',project:'p',repository:f.dir})
  owner('request',{id:'stop',project:'p',text:'Investigate'})
  const {ticketId}=f.call(['route','accept'],{trigger:'panel:stop',title:'Investigation'})
  f.store.delete('router','lease')
  expect(owner('stop',{ticket:ticketId,reason:'Stop this task'}).ended).toMatchObject({by:'human',outcome:'stopped',reason:'Stop this task'})
  expect(owner('status').ownerActions).toEqual([expect.objectContaining({action:'stop',ticketId,actor:{source:'panel',id:'owner'}})])
  expect(() => owner('comment',{id:'too-late',ticket:ticketId,text:'Continue'})).toThrow('stopped')
  expect(f.store.get('router','lease')).toBeUndefined()
})


test('panel source context cannot change the accepted target and cross-project routing keeps its reason', () => {
  const f=setup(), owner=(action:string,options:Record<string,string>)=>f.app.handle({command:['owner',action],options,id:'rpc'}) as any
  for(const project of ['a','b']) owner('project-add',{id:project,name:project})
  for(const [id,project] of [['a1','a'],['a2','a'],['b1','b']]) {
    const repository=join(f.dir,id); execFileSync('git',['init','-q',repository])
    owner('repository-add',{id,name:id,project,repository})
  }
  owner('request',{id:'original',project:'a',locations:'a1',text:'Fix project A'})
  const {ticketId}=f.call(['route','accept'],{trigger:'panel:original',title:'A'})
  const target=f.store.get('ticket-target',ticketId), mandate=f.store.tickets.get(ticketId)?.mandate
  owner('request',{id:'foreign-project',project:'b',locations:'b1',text:'Fix project B'})
  expect(()=>f.call(['route','attach'],{ticket:ticketId,trigger:'panel:foreign-project'})).toThrow('reason')
  owner('request',{id:'foreign-repository',project:'a',locations:'a2',text:'Change another repository'})
  f.call(['route','attach'],{ticket:ticketId,trigger:'panel:foreign-repository'})
  owner('comment',{id:'outside-comment',ticket:ticketId,locations:'a2',text:'This may need a change in the other repository'})
  expect(f.store.triggers.get('panel:outside-comment')?.meta.locationIds).toEqual(['a2'])
  expect(f.store.tickets.get(ticketId)?.inputs).toHaveLength(2)
  expect(f.store.get('ticket-target',ticketId)).toEqual(target)
  expect(f.store.tickets.get(ticketId)?.mandate).toEqual(mandate)
  expect(f.call(['owner','status']).candidates.flatMap((candidate:any)=>candidate.triggers.map((trigger:any)=>trigger.id))).toEqual(expect.arrayContaining(['panel:foreign-project']))
  owner('request',{id:'same-target',project:'a',locations:'a1',text:'Another clue'})
  f.call(['route','attach'],{ticket:ticketId,trigger:'panel:same-target'})
  expect(f.store.tickets.get(ticketId)?.inputs).toHaveLength(3)
  f.call(['route','attach'],{ticket:ticketId,trigger:'panel:foreign-project',reason:'The request describes the existing A behavior'})
  expect(f.store.get('ticket-target',ticketId)).toEqual(target)
  expect(f.store.triggers.get('panel:foreign-project')?.meta.projectId).toBe('b')
  expect(f.call(['owner','status']).routingAttachments).toEqual([expect.objectContaining({ticketId,triggerId:'panel:foreign-project',reason:'The request describes the existing A behavior'})])
})


test('only Router candidate reads start the core deadline, whose bounded retries recover by original owner trigger', () => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime('2026-11-07T00:00:00Z')
  const f=setup()
  f.call(['intake'],{id:'unread',text:'Preserve this unanswered owner request'})
  const first=f.call(['owner','status']).candidates[0]
  vi.setSystemTime(Date.now()+30*60_000); f.app.engine.evaluateDue()
  expect(f.call(['owner','status']).candidates[0].evalId).toBe(first.evalId)
  expect(f.store.threads.active()[0].evaluating?.delivered).toBeUndefined()
  f.call(['router','wait'])
  const delivered=f.store.threads.active()[0].evaluating!
  expect(delivered.delivered).toBe(new Date().toISOString())
  vi.setSystemTime(Date.now()+60_000); f.call(['router','wait'])
  expect(f.store.threads.active()[0].evaluating).toEqual(delivered)
  for(let round=0;round<3;round++) {
    vi.setSystemTime(Date.now()+300_001); f.app.engine.evaluateDue()
    if(round<2) {
      expect(f.store.threads.active()[0].evaluating?.delivered).toBeUndefined()
      f.call(['router','wait'])
    }
  }
  expect(f.call(['owner','status']).candidates).toHaveLength(0)
  expect(f.call(['owner','status']).routingHistory).toEqual([expect.objectContaining({kind:'unavailable',triggerIds:['unread']})])
  const lease=f.store.get('router','lease')
  expect(f.call(['owner','reevaluate'],{trigger:'unread',lease:''})).toEqual({triggerId:'unread',requeued:true})
  expect(f.call(['owner','reevaluate'],{trigger:'unread',lease:''})).toEqual({triggerId:'unread',requeued:false})
  expect(f.call(['owner','status']).candidates[0].triggers[0].id).toBe('unread')
  expect(f.store.threads.active()[0].evaluating?.delivered).toBeUndefined()
  expect(f.store.list('core.trigger')).toHaveLength(1)
  expect(f.store.get('router','lease')).toEqual(lease)
})

test('owner reevaluation can reroute owned inputs while Router cannot hijack them or admit a foreign actor', () => {
  const f=setup(); f.call(['intake'],{id:'original',text:'Do the authorized work'})
  const {ticketId}=f.call(['route','accept'],{trigger:'original',title:'Work'})
  f.call(['intake'],{id:'owned-followup',text:'A clue within the task'})
  f.call(['route','attach'],{ticket:ticketId,trigger:'owned-followup'})
  expect(()=>f.call(['route','accept'],{trigger:'owned-followup',title:'Hijacked'})).toThrow('worker decides')
  expect(f.call(['owner','reevaluate'],{trigger:'owned-followup'})).toEqual({triggerId:'owned-followup',requeued:true})
  expect(f.store.triggers.disposition('owned-followup')?.requeued).toBe(true)
  expect(f.call(['owner','reevaluate'],{trigger:'owned-followup'})).toEqual({triggerId:'owned-followup',requeued:false})
  f.app.engine.receive({id:'foreign-reevaluate',source:'router',actor:{source:'router',id:'someone-else'},human:true,addressed:'direct',at:new Date().toISOString(),text:'Not owner work',threads:[{source:'router',id:'foreign-reevaluate'}],meta:{}})
  expect(()=>f.call(['owner','reevaluate'],{trigger:'foreign-reevaluate'})).toThrow('Only in-scope owner')
  expect(()=>f.call(['owner','reevaluate'],{trigger:'missing'})).toThrow('Only in-scope owner')
})


test('unavailable panel requests recover in their original project with unchanged source and words', () => {
  const f=setup()
  for(const id of ['p','other']) f.call(['owner','project-add'],{id,name:id})
  const original={id:'panel-request',project:'p',text:'  Preserve my exact original words  '}
  f.call(['owner','request'],original)
  f.app.engine.decide('panel:panel-request',{kind:'unavailable',reason:'Router unavailable'})
  const trigger=f.store.triggers.get('panel:panel-request')
  expect(()=>f.call(['owner','reevaluate'],{trigger:'panel:panel-request',project:'other'})).toThrow('project')
  f.call(['project','pause'],{id:'p'})
  expect(()=>f.call(['owner','reevaluate'],{trigger:'panel:panel-request'})).toThrow('project')
  f.call(['project','resume'],{id:'p'})
  expect(f.call(['owner','reevaluate'],{trigger:'panel:panel-request',project:'p'})).toEqual({triggerId:'panel:panel-request',requeued:true})
  expect(f.store.triggers.get('panel:panel-request')).toEqual(trigger)
  expect(f.call(['owner','status'],{project:'p'}).candidates[0].triggers[0]).toMatchObject({id:'panel:panel-request',source:'panel',text:original.text,meta:{projectId:'p'}})
})


test('pending request comments keep one topic, native candidate batches and exact originals through acceptance', () => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime('2026-11-08T03:00:00Z')
  const f=setup(), owner=(action:string,options:Record<string,string>)=>f.call(['owner',action],options)
  execFileSync('git',['init','-q',f.dir]); owner('project-add',{id:'p',name:'Project'}); owner('repository-add',{id:'repo',name:'Repo',project:'p',repository:f.dir})
  const original={id:'topic',project:'p',locations:'repo',text:'  Fix exported dates  '}
  owner('request',original)
  const first=f.call(['owner','status']).candidates[0]
  vi.setSystemTime('2026-11-09T03:00:00Z')
  const comment={id:'clarification',trigger:'panel:topic',text:'  Keep the existing timezone.\nOnly change the export.  '}
  owner('comment',comment); owner('comment',comment)
  const topic=f.store.triggers.get('panel:topic')!, reply=f.store.triggers.get('panel:clarification')!
  expect(reply).toMatchObject({text:comment.text,at:'2026-11-09T03:00:00.000Z',threads:topic.threads,channel:topic.channel,meta:{projectId:'p',topicTriggerId:topic.id,entryProjectId:'p',locationIds:['repo']}})
  const waiting=f.call(['router','wait'])
  expect(waiting.candidates[0].evalId).toBe(first.evalId)
  expect(waiting.candidates[0].triggers.map((trigger:any)=>trigger.id)).toEqual([topic.id])
  expect(f.store.threads.get('panel:request:panel:topic')?.pending).toEqual([reply.id])
  expect(waiting.topicInputs.map((trigger:any)=>trigger.id)).toEqual([topic.id,reply.id])
  const {ticketId}=f.call(['route','accept'],{trigger:topic.id,title:'Export dates'})
  const ticket=f.store.tickets.get(ticketId)!
  expect(ticket.mandate.scope).toBe(original.text)
  expect(ticket.inputs.filter(input=>input.kind==='trigger'&&input.triggerId===reply.id)).toHaveLength(1)
  owner('comment',comment)
  expect(f.store.triggers.get(reply.id)).toEqual(reply)
  expect(()=>owner('comment',{...comment,text:'Edited original'})).toThrow('different content')
  owner('comment',{id:'after-accept',trigger:topic.id,text:'Another clue'})
  expect(f.store.tickets.list()).toHaveLength(1)
  expect(f.store.tickets.get(ticketId)?.inputs.filter(input=>input.kind==='trigger')).toHaveLength(2)
  owner('stop',{ticket:ticketId,reason:'Stop this work'})
  expect(()=>owner('comment',{id:'after-stop',trigger:topic.id,text:'Resume'})).toThrow('stopped')
})

test('ignored query topics receive followup requests without losing the earlier question and reply', () => {
  const f=setup(); f.call(['owner','project-add'],{id:'p',name:'Project'})
  f.call(['owner','request'],{id:'question',project:'p',text:'What does this project do?'})
  f.call(['route','ignore'],{trigger:'panel:question',reason:'Answered as a query'})
  f.call(['reply'],{trigger:'panel:question',text:'It exports reports.'})
  f.call(['owner','comment'],{id:'followup',trigger:'panel:question',text:'Which timezone does it use?'})
  const waiting=f.call(['router','wait'])
  expect(waiting.candidates[0].triggers.map((trigger:any)=>trigger.id)).toEqual(['panel:followup'])
  expect(waiting.topicInputs.map((trigger:any)=>trigger.text)).toEqual(['What does this project do?','Which timezone does it use?'])
  expect(waiting.topicReplies).toEqual([expect.objectContaining({text:'It exports reports.'})])
  expect(f.call(['owner','status']).outbox).toEqual([expect.objectContaining({text:'It exports reports.',channel:expect.objectContaining({thread:'request:panel:question'})})])
  expect(f.store.tickets.list()).toHaveLength(0)
  expect(()=>f.call(['owner','comment'],{id:'bad',trigger:'panel:question',ticket:'made-up',text:'Ambiguous'})).toThrow('exactly one')
  expect(()=>f.call(['owner','comment'],{id:'bad',text:'No topic'})).toThrow('exactly one')
  expect(()=>f.call(['owner','comment'],{id:'bad',trigger:'missing',text:'Unknown topic'})).toThrow('original')
})

test('project is entry context: Router may route elsewhere with reason and later comments keep the original reply channel', () => {
  const f=setup()
  for(const project of ['a','b']) {
    f.call(['owner','project-add'],{id:project,name:project})
    const repository=join(f.dir,project); execFileSync('git',['init','-q',repository])
    f.call(['owner','repository-add'],{id:project,name:project,project,repository})
  }
  f.call(['owner','request'],{id:'entry-a',project:'a',locations:'a',text:'Fix the report described here'})
  f.call(['owner','comment'],{id:'before-route',trigger:'panel:entry-a',text:'The failure is in the shared export code'})
  const original=f.store.triggers.get('panel:entry-a')!, prior=f.store.triggers.get('panel:before-route')!
  expect(()=>f.call(['route','accept'],{trigger:original.id,project:'b',title:'Report'})).toThrow('reason')
  const {ticketId}=f.call(['route','accept'],{trigger:original.id,project:'b',title:'Report',reason:'The shared export implementation is in B'})
  expect(f.store.get<any>('ticket-target',ticketId).projectId).toBe('b')
  expect(f.store.triggers.get(original.id)).toEqual(original)
  f.call(['owner','comment'],{id:'before-route',trigger:original.id,text:prior.text})
  expect(f.store.triggers.get(prior.id)).toEqual(prior)
  f.call(['owner','comment'],{id:'after-route',trigger:original.id,project:'b',text:'Retest the original case'})
  const after=f.store.triggers.get('panel:after-route')!
  expect(after).toMatchObject({meta:{projectId:'b',entryProjectId:'a',topicTriggerId:original.id},channel:original.channel,threads:original.threads})
  expect(f.store.tickets.list()).toHaveLength(1)
  expect(f.store.tickets.get(ticketId)?.mandate.scope).toBe(original.text)
  expect(f.store.tickets.get(ticketId)?.inputs.some(input=>input.kind==='trigger'&&input.triggerId===after.id)).toBe(true)
  expect(f.call(['owner','status']).routingHistory).toEqual(expect.arrayContaining([expect.objectContaining({ticketId,reason:expect.arrayContaining([expect.objectContaining({code:'said',values:{text:'The shared export implementation is in B'}})])})]))
})


test('a handed-back panel followup can route to another project while a Router cannot steal owned work', () => {
  const f=setup()
  for(const project of ['a','b']) {
    f.call(['owner','project-add'],{id:project,name:project})
    const repository=join(f.dir,project); execFileSync('git',['init','-q',repository])
    f.call(['owner','repository-add'],{id:project,name:project,project,repository})
    f.call(['owner','request'],{id:project,project,text:`Work in ${project}`})
  }
  const a=f.call(['route','accept'],{trigger:'panel:a',title:'A'}).ticketId, b=f.call(['route','accept'],{trigger:'panel:b',title:'B'}).ticketId
  f.call(['owner','comment'],{id:'outside',trigger:'panel:a',text:'This also needs a change in B'})
  expect(()=>f.call(['route','attach'],{ticket:b,trigger:'panel:outside',reason:'B owns that feature'})).toThrow('worker decides')
  expect(f.store.tickets.get(b)?.inputs).toHaveLength(0)
  f.app.engine.handback(a,'panel:outside','This feature belongs to B')
  f.call(['route','attach'],{ticket:b,trigger:'panel:outside',reason:'Executor A identified B as the owning project'})
  expect(f.store.tickets.get(b)?.inputs.some(input=>input.kind==='trigger'&&input.triggerId==='panel:outside')).toBe(true)
  expect(f.store.triggers.get('panel:outside')?.meta.projectId).toBe('a')
  expect(f.store.triggers.disposition('panel:outside')?.handbacks).toEqual([expect.objectContaining({ticketId:a,reason:'This feature belongs to B'})])
  expect(f.call(['owner','status']).routingAttachments).toEqual([expect.objectContaining({ticketId:b,triggerId:'panel:outside',reason:'Executor A identified B as the owning project'})])
})


test('a query topic accepted only on a later request continues that actual ticket', () => {
  const f=setup(); execFileSync('git',['init','-q',f.dir])
  f.call(['owner','project-add'],{id:'p',name:'Project'}); f.call(['owner','repository-add'],{id:'repo',name:'Repo',project:'p',repository:f.dir})
  f.call(['owner','request'],{id:'query-first',project:'p',text:'Can this export dates?'})
  f.call(['route','ignore'],{trigger:'panel:query-first',reason:'A question only'})
  f.call(['reply'],{trigger:'panel:query-first',text:'Yes, dates are supported.'})
  f.call(['owner','comment'],{id:'request-now',trigger:'panel:query-first',text:'Fix the exported dates now'})
  const {ticketId}=f.call(['route','accept'],{trigger:'panel:request-now',title:'Export dates'})
  f.call(['owner','comment'],{id:'clue',trigger:'panel:query-first',text:'Use the existing timezone'})
  expect(f.store.tickets.list()).toHaveLength(1)
  expect(f.store.tickets.get(ticketId)?.mandate.scope).toBe('Fix the exported dates now')
  expect(f.store.tickets.get(ticketId)?.inputs.some(input=>input.kind==='trigger'&&input.triggerId==='panel:clue')).toBe(true)
  expect(f.store.triggers.get('panel:clue')?.channel).toEqual(f.store.triggers.get('panel:query-first')?.channel)
  expect(f.store.list('core.trigger')).toHaveLength(3)
})


test('answers to distinct original requests sharing one reply channel retain exact trigger attribution after accept', () => {
  const f=setup()
  for(const [id,text] of [['one','What is the first project?'],['two','What is the second project?']]) f.call(['intake'],{id,text,thread:'same-chat'})
  f.call(['reply'],{trigger:'one',text:'Answer to one'})
  f.call(['reply'],{trigger:'two',text:'Answer to two'})
  let outbox=f.call(['owner','status']).outbox
  expect(outbox).toEqual([expect.objectContaining({triggerId:'one',text:'Answer to one'}),expect.objectContaining({triggerId:'two',text:'Answer to two'})])
  expect(outbox[0].channel).toEqual(outbox[1].channel)
  f.call(['route','ignore'],{trigger:'two',reason:'Second question answered'})
  expect(f.call(['router','wait']).topicReplies.map((mail:any)=>mail.triggerId)).toEqual(['one'])
  const {ticketId}=f.call(['route','accept'],{trigger:'one',title:'First project'})
  outbox=f.call(['owner','status']).outbox
  expect(outbox.filter((mail:any)=>mail.triggerId==='one').map((mail:any)=>mail.text)).toEqual(['Answer to one'])
  expect(f.store.tickets.get(ticketId)?.origin.triggerIds).toEqual(['one'])
  expect(outbox.find((mail:any)=>mail.triggerId==='two').text).toBe('Answer to two')
})

test('a pending topic answer keeps its trigger attribution when later work in that topic is accepted', () => {
  const f=setup(); execFileSync('git',['init','-q',f.dir])
  f.call(['owner','project-add'],{id:'p',name:'Project'}); f.call(['owner','repository-add'],{id:'repo',name:'Repo',project:'p',repository:f.dir})
  f.call(['owner','request'],{id:'answered-topic',project:'p',text:'Does this export dates?'})
  f.call(['route','ignore'],{trigger:'panel:answered-topic',reason:'A query'})
  f.call(['reply'],{trigger:'panel:answered-topic',text:'Yes, dates are supported.'})
  const reply=f.call(['owner','status']).outbox[0]
  f.call(['owner','comment'],{id:'accepted-followup',trigger:'panel:answered-topic',text:'Fix the date export'})
  const {ticketId}=f.call(['route','accept'],{trigger:'panel:accepted-followup',title:'Dates'})
  expect(f.call(['owner','status']).outbox.find((mail:any)=>mail.id===reply.id)).toEqual(expect.objectContaining({triggerId:'panel:answered-topic',text:'Yes, dates are supported.'}))
  expect(f.store.triggers.get('panel:accepted-followup')?.meta.topicTriggerId).toBe('panel:answered-topic')
  expect(f.store.tickets.get(ticketId)?.origin.triggerId).toBe('panel:accepted-followup')
})


test('accepting handed-back work never sweeps historical sibling inputs out of the original task', () => {
  const f=setup()
  for(const project of ['a','b']) {
    f.call(['owner','project-add'],{id:project,name:project})
    const repository=join(f.dir,project); execFileSync('git',['init','-q',repository])
    f.call(['owner','repository-add'],{id:project,name:project,project,repository})
  }
  f.call(['owner','request'],{id:'initial-a',project:'a',text:'Fix A'})
  const a=f.call(['route','accept'],{trigger:'panel:initial-a',title:'A'}).ticketId
  f.call(['owner','comment'],{id:'owned-clue',trigger:'panel:initial-a',text:'The A failure occurs on export'})
  f.call(['owner','comment'],{id:'outside-b',trigger:'panel:initial-a',text:'Fix the unrelated B issue'})
  f.app.engine.handback(a,'panel:outside-b','B is a separate goal')
  const aBefore=f.store.tickets.get(a)!
  const {ticketId:b}=f.call(['route','accept'],{trigger:'panel:outside-b',project:'b',title:'B',reason:'A handed back this separate B request'})
  expect(b).not.toBe(a)
  expect(f.store.tickets.get(a)).toEqual(aBefore)
  expect(f.store.tickets.get(b)?.mandate.scope).toBe('Fix the unrelated B issue')
  expect(f.store.tickets.get(b)?.origin.triggerIds).toEqual(['panel:outside-b'])
  expect(f.store.tickets.get(b)?.inputs.some(input=>input.kind==='trigger'&&input.triggerId==='panel:owned-clue')).toBe(false)
  expect(f.store.triggers.disposition('panel:owned-clue')?.fanout).toEqual([a])
  expect(f.store.triggers.disposition('panel:outside-b')?.handbacks).toEqual([expect.objectContaining({ticketId:a,reason:'B is a separate goal'})])
  expect(f.store.tickets.list()).toHaveLength(2)
  expect(f.store.list('core.trigger')).toHaveLength(3)
})

test('an unassigned owner Router request accepts workbench comments on its original native thread', () => {
  const f=setup()
  f.call(['intake'],{id:'router-topic',text:'  Fix the report  ',thread:'shared-router-chat'})
  const original=f.store.triggers.get('router-topic')!
  const comment={id:'router-clarification',trigger:original.id,text:'  It fails when exporting dates  '}
  expect(f.call(['owner','comment'],comment)).toEqual({id:'panel:router-clarification',result:'stored'})
  expect(f.call(['owner','comment'],comment).result).toBe('duplicate')
  const reply=f.store.triggers.get('panel:router-clarification')!
  expect(reply).toMatchObject({source:'panel',actor:{source:'panel',id:'owner'},text:comment.text,threads:original.threads,channel:original.channel,meta:{topicTriggerId:original.id}})
  expect(reply.meta).not.toHaveProperty('projectId')
  expect(reply.meta).not.toHaveProperty('entryProjectId')
  expect(f.store.triggers.disposition(reply.id)?.filtered).toBeUndefined()
  expect(f.call(['router','wait']).topicInputs.map((trigger:any)=>trigger.id)).toEqual([original.id,reply.id])
  expect(f.store.tickets.list()).toHaveLength(0)
  execFileSync('git',['init','-q',f.dir])
  f.call(['owner','project-add'],{id:'p',name:'Project'}); f.call(['owner','repository-add'],{id:'repo',name:'Repo',project:'p',repository:f.dir})
  const {ticketId}=f.call(['route','accept'],{trigger:original.id,project:'p',title:'Report'})
  expect(f.store.tickets.get(ticketId)?.mandate.scope).toBe(original.text)
  expect(f.store.tickets.get(ticketId)?.inputs.filter(input=>input.kind==='trigger'&&input.triggerId===reply.id)).toHaveLength(1)
  f.call(['owner','comment'],{id:'after-router-accept',trigger:original.id,text:'Retest the same export'})
  expect(f.store.triggers.get('panel:after-router-accept')).toMatchObject({source:'panel',threads:original.threads,channel:original.channel,meta:{projectId:'p',topicTriggerId:original.id}})
  expect(f.store.tickets.list()).toHaveLength(1)
  expect(f.store.list('core.trigger')).toHaveLength(3)
  f.app.engine.receive({id:'foreign-topic',source:'router',actor:{source:'router',id:'other-user'},human:true,at:new Date().toISOString(),text:'Foreign owner',threads:[{source:'router',id:'foreign-topic'}],meta:{}})
  expect(()=>f.call(['owner','comment'],{id:'foreign-comment',trigger:'foreign-topic',text:'Do not forge ownership'})).toThrow('original in-scope owner')
})


test('accepting a pending clarification uses the original unresolved request mandate and leaves no duplicate candidate', () => {
  const f=setup(); execFileSync('git',['init','-q',f.dir])
  f.call(['owner','project-add'],{id:'p',name:'Project'}); f.call(['owner','repository-add'],{id:'repo',name:'Repo',project:'p',repository:f.dir})
  f.call(['owner','request'],{id:'export-root',project:'p',text:'  Fix exports  '})
  f.call(['owner','comment'],{id:'timezone-clue',trigger:'panel:export-root',text:'  Keep timezone  '})
  const decision=f.call(['route','accept'],{trigger:'panel:timezone-clue',title:'Exports'})
  const ticket=f.store.tickets.get(decision.ticketId)!, assignment=ticket.assignments[0].id
  expect(ticket.mandate.scope).toBe('  Fix exports  ')
  expect(ticket.origin.triggerId).toBe('panel:export-root')
  expect(ticket.inputs.filter(input=>input.kind==='trigger'&&input.triggerId==='panel:timezone-clue')).toHaveLength(1)
  expect(decision.audit).toEqual({requestedTriggerId:'panel:timezone-clue',topicTriggerId:'panel:export-root'})
  f.app.engine.evaluateDue()
  expect(f.call(['router','wait']).candidates).toHaveLength(0)
  f.store.put('capability',assignment,{token:'secret'}); f.app.engine.assignmentStarted(ticket.id,assignment)
  const read=f.call(['read'],{ticket:ticket.id,assignment,token:'secret'})
  expect(read.triggers.map((trigger:any)=>trigger.text)).toEqual(['  Fix exports  ','  Keep timezone  '])
  expect(f.call(['route','accept'],{trigger:'panel:timezone-clue',title:'Exports'}).ticketId).toBe(ticket.id)
  expect(f.store.tickets.list()).toHaveLength(1)
})


test('attachment-only requests preserve empty original text and expose verified files to Router and Executor context', () => {
  const f=setup(); execFileSync('git',['init','-q',f.dir])
  f.call(['owner','project-add'],{id:'p',name:'Project'}); f.call(['owner','repository-add'],{id:'repo',name:'Repo',project:'p',repository:f.dir})
  const id=randomUUID(), bytes=Buffer.from([137,80,78,71,13,10,26,10])
  const uploaded=f.call(['owner','attachment-write'],{id,name:'截图.png',mime:'image/png',size:String(bytes.length),offset:'0',data:bytes.toString('base64')})
  expect(uploaded).toMatchObject({id,name:'截图.png',mime:'image/png',ready:true,offset:bytes.length})
  expect(uploaded).not.toHaveProperty('path')
  const options={id:'image-only',project:'p',text:'',attachments:JSON.stringify([id])}
  f.call(['owner','request'],options); f.call(['owner','request'],options)
  const trigger=f.store.triggers.get('panel:image-only')!
  expect(trigger.text).toBe('')
  expect(trigger.meta.attachments).toEqual([expect.objectContaining({id,name:'截图.png',mime:'image/png',path:expect.any(String),sha256:uploaded.sha256})])
  expect(f.call(['router','wait']).topicInputs[0].meta.attachments).toEqual(trigger.meta.attachments)
  const {ticketId}=f.call(['route','accept'],{trigger:trigger.id,title:'查看附件'})
  const ticket=f.store.tickets.get(ticketId)!, assignment=ticket.assignments[0].id
  expect(ticket.mandate.scope).toBe('[无文字的附件请求：截图.png]')
  expect(f.store.triggers.get(trigger.id)?.text).toBe('')
  f.store.put('capability',assignment,{token:'file-context'}); f.app.engine.assignmentStarted(ticket.id,assignment)
  const context=f.call(['read'],{ticket:ticket.id,assignment,token:'file-context'})
  expect(context.triggers[0].meta.attachments).toEqual(trigger.meta.attachments)
  expect(f.call(['owner','attachment-read'],{id,offset:'0'})).toMatchObject({data:bytes.toString('base64'),done:true})
  expect(f.store.list('core.trigger')).toHaveLength(1)
})

test('message identities include the exact ready attachment references, including topic comment retries', () => {
  const f=setup(); f.call(['owner','project-add'],{id:'p',name:'Project'})
  const upload=(name:string) => {
    const id=randomUUID(), bytes=Buffer.from(name)
    f.call(['owner','attachment-write'],{id,name,mime:'text/plain',size:String(bytes.length),offset:'0',data:bytes.toString('base64')})
    return id
  }
  const first=upload('first.txt'), second=upload('second.txt'), text='  Keep my exact words.\n  '
  f.call(['owner','request'],{id:'with-file',project:'p',text,attachments:JSON.stringify([first])})
  expect(()=>f.call(['owner','request'],{id:'with-file',project:'p',text,attachments:JSON.stringify([second])})).toThrow('different content')
  const options={id:'file-comment',trigger:'panel:with-file',text:'',attachments:JSON.stringify([second])}
  f.call(['owner','comment'],options); f.call(['owner','comment'],options)
  expect(()=>f.call(['owner','comment'],{...options,attachments:JSON.stringify([first])})).toThrow('different content')
  expect(f.store.triggers.get('panel:with-file')?.text).toBe(text)
  expect(f.store.triggers.get('panel:file-comment')?.text).toBe('')
  const restarted=new App(f.store,f.executor,'owner')
  expect(restarted.handle({command:['owner','comment'],options,id:'retry'})).toMatchObject({result:'duplicate'})
  expect(f.store.list('core.trigger')).toHaveLength(2)
})

test('partial or unreadable attachments cannot be submitted or returned as successful content', () => {
  const f=setup(); f.call(['owner','project-add'],{id:'p',name:'Project'})
  const id=randomUUID(), options={id,name:'missing.txt',mime:'text/plain',size:'4',offset:'0',data:Buffer.from('ab').toString('base64')}
  f.call(['owner','attachment-write'],options)
  expect(()=>f.call(['owner','request'],{id:'not-ready',project:'p',text:'Read this',attachments:JSON.stringify([id])})).toThrow('not ready')
  expect(()=>f.call(['owner','attachment-read'],{id,offset:'0'})).toThrow('not ready')
  expect(()=>f.call(['owner','request'],{id:'empty',project:'p',text:''})).toThrow('text or a ready attachment')
  f.call(['owner','attachment-write'],{...options,offset:'2',data:Buffer.from('cd').toString('base64')})
  const path=f.store.get<any>('attachment',id).path
  rmSync(path)
  expect(()=>f.call(['owner','attachment-read'],{id,offset:'0'})).toThrow()
  expect(()=>f.call(['owner','request'],{id:'unreadable',project:'p',text:'Read this',attachments:JSON.stringify([id])})).toThrow()
  expect(f.store.list('core.trigger')).toHaveLength(0)
  expect(f.call(['owner','status']).rejectedSubmissions).toEqual(expect.arrayContaining([expect.objectContaining({id:'unreadable',text:'Read this',error:expect.any(String)})]))
})


test('ready uses DSH read and release semantics without requiring per-input forms', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-08T00:00:00Z'))
  const f=setup()
  f.call(['intake'],{id:'original',text:'Fix the bug'})
  const {ticketId}=f.call(['route','accept'],{trigger:'original',title:'Fix'})
  const assignment=f.store.tickets.get(ticketId)!.assignments[0].id
  f.app.engine.assignmentStarted(ticketId,assignment); f.store.put('capability',assignment,{token:'test'})
  const auth={ticket:ticketId,assignment,token:'test'}
  f.call(['intake'],{id:'read-followup',text:'Use the existing project rules'})
  f.call(['route','attach'],{ticket:ticketId,trigger:'read-followup'})
  f.call(['read'],auth)
  vi.advanceTimersByTime(10)
  f.call(['intake'],{id:'late-followup',text:'Also investigate this separate issue'})
  f.call(['route','attach'],{ticket:ticketId,trigger:'late-followup'})
  vi.advanceTimersByTime(10)
  f.call(['report','ready'],{...auth,summary:'Original bug fixed'})
  expect(f.store.threads.list().some(thread => thread.pending.includes('read-followup'))).toBe(false)
  expect(f.store.threads.list().some(thread => thread.pending.includes('late-followup'))).toBe(true)
  expect(f.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
})
