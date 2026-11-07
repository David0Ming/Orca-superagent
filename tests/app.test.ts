import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { App } from '../src/app.ts'
import { Store } from '../src/store.ts'
import type { Executor } from '../vendor/dsh-core/src/index.ts'

const dirs: string[] = [], stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
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
  expect(() => call(['route','attach'], {ticket:b,trigger:remote.id})).toThrow('another ticket')
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
  const f = setup(); f.call(['intake'], { id: 'goal', text: 'Do it', thread: 'same' })
  const { ticketId } = f.call(['route', 'accept'], { trigger: 'goal', title: 'Goal', scope: 'Goal' })
  const assignment = f.store.tickets.get(ticketId)!.assignments[0].id
  f.store.put('capability', assignment, { token: 'secret' }); f.app.engine.assignmentStarted(ticketId, assignment)
  const auth = { ticket: ticketId, assignment, token: 'secret' }
  f.call(['acknowledge'], { ...auth, trigger: 'goal', text: 'Received' })
  f.call(['acknowledge'], { ...auth, trigger: 'goal', text: 'Replay' })
  expect(f.store.list<any>('outbox').filter(m => m.kind === 'acknowledgement')).toHaveLength(1)
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


test('shared chat is only a reply address; explicit attachment and scope revision stay on one ticket', () => {
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
  expect(context.ticket.mandate.scope).toContain('phase two')
  expect(context.scopeRevisions).toHaveLength(1)
  expect(f.store.tickets.list().filter(t=>t.id!==ticket.id).every(t=>t.inputs.length===0)).toBe(true)
  expect(()=>f.call(['report','ready'],{...auth,summary:'Done'})).toThrow('Unprocessed')
  f.call(['ack'],{...auth,inputs:input})
  expect(()=>f.call(['report','ready'],{...auth,summary:'Done'})).toThrow('Unprocessed')
  f.call(['report','ready'],{...auth,inputs:input,summary:'Phase two completed and verified'})
  expect(f.store.get<any>('input-resolution',input).summary).toContain('Phase two')
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
  expect(ticket.mandate.scope).toBe(`${original}\n\nOwner followup (owner-correction):\n${correction}`)
  expect(ticket.inputs).toHaveLength(1)
  expect(ticket.inputs[0]).not.toHaveProperty('note')
  expect(f.store.list('scope-revision')).toHaveLength(1)
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

test('unfinished waiting produces its own actionable progress notice and acknowledgement persists', () => {
  const f=setup(); f.call(['intake'],{id:'work',text:'Two steps'})
  const {ticketId}=f.call(['route','accept'],{trigger:'work',title:'Work',scope:'Both steps'})
  const assignment=f.store.tickets.get(ticketId)!.assignments[0].id
  f.app.engine.assignmentStarted(ticketId,assignment); f.store.put('capability',assignment,{token:'test'})
  f.call(['report','waiting'],{ticket:ticketId,assignment,token:'test',summary:'Step one done, step two remains'})
  const notice=f.call(['router','wait']).notices.find((n:any)=>n.kind==='progress')
  expect(notice.action).toContain('next authorized step')
  f.call(['router','ack'],{message:notice.id})
  expect(f.call(['router','wait']).notices.some((n:any)=>n.id===notice.id)).toBe(false)
})


test('scope correction invalidates an earlier read even before the followup is acknowledged', () => {
  const f=setup(); f.call(['intake'],{id:'original',text:'Stage one'})
  const {ticketId}=f.call(['route','accept'],{trigger:'original',title:'Stages',scope:'Only stage one'})
  const assignment=f.store.tickets.get(ticketId)!.assignments[0].id, auth={ticket:ticketId,assignment,token:'test'}
  f.app.engine.assignmentStarted(ticketId,assignment); f.store.put('capability',assignment,{token:'test'})
  f.call(['read'],auth)
  f.call(['intake'],{id:'new-scope',text:'Continue stage two'})
  f.call(['route','attach'],{ticket:ticketId,trigger:'new-scope',scope:'Both stages authorized'})
  expect(()=>f.call(['report','ready'],{...auth,summary:'Stage one done'})).toThrow('Read the current')
})
