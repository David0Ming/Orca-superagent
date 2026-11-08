import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assignment, type Ticket } from '../vendor/dsh-core/src/index.ts'
import { OrcaExecutor } from '../src/orca.ts'
import { Store } from '../src/store.ts'
import { Projects } from '../src/projects.ts'
import { App, type Request } from '../src/app.ts'

const cleanup: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0)) fn() })

function setup(twoLayer = false, stallMs?: number, maxExecutors?: number, agent?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'osa-orca-'))
  execFileSync('git', ['init', '--quiet', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
  const database = join(dir, 'store.sqlite'), stateFile = join(dir, 'fake.json'), log = join(dir, 'calls.jsonl'), cli = join(dir, 'orca')
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  let store = new Store(database)
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const update = (patch: object) => writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }))
  writeFileSync(stateFile, JSON.stringify({ requests: {}, terminals: [], worktrees: [], workers: [], messages: [], dispatchStatus: 'dispatched', created: 0, sent: 0 }))
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const stateFile = ${JSON.stringify(stateFile)}, log = ${JSON.stringify(log)};
const args = process.argv.slice(2), [group, command] = args;
const flag = name => args[args.indexOf('--' + name) + 1];
const lock=stateFile+'.lock';
while(true) {try {fs.mkdirSync(lock);break} catch(error) {if(error.code!=='EEXIST')throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}}
process.on('exit',()=>fs.rmdirSync(lock));
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
fs.appendFileSync(log, JSON.stringify({args, env: Object.keys(process.env).filter(k => k.startsWith('ORCA_'))}) + '\\n');
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s));
const output = result => { save(); console.log(JSON.stringify({ok:true,result})); };
const requestId = args.includes('--retry-request') ? flag('retry-request') : null;
if (requestId && s.requests[requestId]) { output(s.requests[requestId]); process.exit(0); }
let r;
if (group === 'worktree') {
  if(command === 'create') {
    const root=flag('repo').slice(5), directory=root + '/' + flag('name');
    require('node:child_process').execFileSync('git', ['-C', root, 'worktree', 'add', '-b', 'account/' + flag('name'), directory], {stdio:'pipe'});
    r={worktree:{id:'repo::' + directory,path:directory,comment:flag('comment')}}; s.worktrees.push(r.worktree);
  } else r={worktrees:s.worktrees};
} else if (group === 'terminal') {
  if (command === 'create') { s.anchorCount=(s.anchorCount || 0)+1; r = {terminal:{handle:'anchor-' + (s.anchorCount-1),title:flag('title'),worktree:flag('worktree')}}; s.terminals.push(r.terminal); }
  if (command === 'show') { const terminal=s.terminals.find(t=>t.handle===flag('terminal')); if(!terminal) { console.log(JSON.stringify({ok:false,error:{code:'terminal_not_found'}})); process.exit(1); } r={terminal}; }
  if (command === 'list') r={terminals:s.terminals.filter(t=>t.worktree===flag('worktree'))};
  if (command === 'close') { s.terminals=s.terminals.filter(t=>t.handle!==flag('terminal')); s.anchorClosed=true; r={closed:true}; }
} else if (command === 'request-show') r = s.requests[flag('request')] ? {state:'completed',receipt:s.requests[flag('request')]} : {state:s.pending ? 'pending' : 'absent'};
else if (command === 'run-create') r={run:{id:'run-' + flag('from')}};
else if (command === 'run-use') {s.coordinator=flag('from'); r={run:{id:flag('id')}};}
else if (command === 'run-show') r={run:{id:flag('id'),coordinator_handle:s.coordinator || 'anchor-0',consumer_generation:2}};
else if (command === 'dispatch-show') r={dispatch:{id:s.currentDispatch || s.workers.at(-1).dispatchId}};
else if (command === 'task-list') r={tasks:s.taskResults || []};
else if (command === 'run-list') r={runs:s.childRuns || []};
else if (command === 'worker-start') {
  if((args.includes('--retry-of') && s.rejectRetries) || s.rejectInitial) {s.rejectedStarts=(s.rejectedStarts || 0)+1; save(); console.log(JSON.stringify({ok:false,error:{code:'task_not_startable',message:'native circuit breaker'}})); process.exit(1);}
  s.created++;
  const n=s.created, runId=flag('run');
  r={runId,taskId:args.includes('--task')?flag('task'):'task-' + n,dispatchId:'dispatch-' + n,state:(args.includes('--retry-of')?s.retryState:s.startState) || 'ready',effects:[{kind:'terminal',role:'agent',id:'worker-' + n},{kind:'worktree',id:'repo::' + flag('worktree').slice(5)}]};
  if(args.includes('--retry-of')) {s.dispatchStatus='dispatched'; s.workerState='ready';}
  if(r.state === 'failed') {s.workerState='failed'; s.dispatchStatus='failed';}
  s.workers.push({...r,workerState:'ready',agentTerminalHandle:'worker-' + n});
} else if (command === 'worker-list') r={workers:s.workers.filter(w=>w.runId===flag('run')),page:{hasMore:false}};
else if (command === 'worker-show') {
  if(s.showUnavailable) {console.log(JSON.stringify({ok:false,error:{code:'host_unavailable',message:'unverifiable'}})); process.exit(1);}
  const w=s.workers.find(w=>w.dispatchId===flag('dispatch'));
  r={dispatch:{id:w.dispatchId,taskId:w.taskId,runId:w.runId,status:s.dispatchStatus,...(s.observation?{hostScope:{kind:'local'}}:{})},observation:s.observation,worker:{state:s.workerState || 'ready',stage:'input_accepted',effects:w.effects,startOptions:s.startOptions},...(s.projection?{projection:s.projection}:{})};
} else if (command === 'send') { s.sent++; r={message:{id:'message-' + s.sent}}; }
else if (command === 'check') {
  if(s.coordinator && s.coordinator!==flag('terminal')) {console.log(JSON.stringify({ok:false,error:{code:'consumer_fenced'}})); process.exit(1);}
  if (args.includes('--ack')) {
    const db=new (require('node:sqlite').DatabaseSync)(${JSON.stringify(database)});
    s.ackSawRelease=JSON.parse(db.prepare("SELECT value FROM records WHERE kind='orca-assignment' AND id='assignment-1'").get().value).released === true;
    s.ackReportReceipts=db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='report-receipt'").get().count;
    db.close(); s.acked=flag('ack'); s.messages=s.afterAck || []; delete s.afterAck;
  }
  r={deliveryId:s.messages.length ? 'delivery-1' : null,messages:s.messages};
} else if (command === 'worker-release') {
  const db=new (require('node:sqlite').DatabaseSync)(${JSON.stringify(database)});
  s.releaseSawSettlement=JSON.parse(db.prepare("SELECT value FROM records WHERE kind='orca-assignment' AND id='assignment-1'").get().value).settled === 'done-1';
  db.close(); s.released=true; r={state:s.releaseState || 'released'};
}
else if (command === 'worker-stop') { s.stopped=true; if(!s.stopState || s.stopState === 'stopped') {s.workerState='stopped'; s.dispatchStatus='failed';} r={state:s.stopState || 'stopped'}; }
if (!r) throw Error('Unsupported fake command ' + args.join(' '));
if (requestId) s.requests[requestId]=r;
if (s.dropOnce === command || s.dropOnce === group + ':' + command) { delete s.dropOnce; save(); process.exit(17); }
output(r);
`, { mode: 0o755 })
  const options = { repository: dir, cli, twoLayer, stallMs, maxExecutors, agent, osaCommand: "'/node path' --experimental-transform-types '/osa path' --state '/state path'",
    report: async (request: Request): Promise<unknown> => new App(store, executor, 'owner').acceptReport(request) }
  let executor = new OrcaExecutor(store, options)
  const makeEngine = () => new Engine({ repo: store, executor,
    policy: () => ({ version: '1', paused: false, evalTimeoutMs: 1000, gate: () => ({ admissible: false, reason: 'unused' }), revalidate: () => true, admitsInferred: () => false }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} }, outbox: { send() {}, status: () => undefined, withdraw() {} },
  })
  let engine = makeEngine()
  const assignment: Assignment = { id: 'assignment-1', state: 'pending', createdAt: '2026-11-02T00:00:00Z' }
  const ticket: Ticket = { id: 'ticket-1', title: 'Implement ticket', mandate: { scope: 'Do a small change', strength: 'explicit', policyVersion: '1', basis: { via: 'listed' }, actor: { source: 'router', id: 'owner' } },
    decisionId: 'decision', channels: [], assignments: [assignment], inputs: [], undelivered: [], createdAt: assignment.createdAt, updatedAt: assignment.createdAt,
    origin: { triggerId: 'trigger', triggerIds: ['trigger'] }, execution: { name: 'small-change', directory: '', assignment: 'Task scope' } }
  store.tickets.save(ticket)
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { dir, ticket, assignment, options, state, update, calls, get store() { return store }, get executor() { return executor }, get engine() { return engine },
    tick() { now += 15_001; return executor.tick(engine) },
    restart() { store.close(); store = new Store(database); executor = new OrcaExecutor(store, options); engine = makeEngine() },
    done(overrides = {}) {
      update({ dispatchStatus: 'completed', messages: [{ id: 'done-1', type: 'worker_done', run_id: 'run-anchor-0', from_handle: 'worker-1', body: 'Process done',
        payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded' }), ...overrides }] })
    },
  }
}

describe('OrcaExecutor durable effects', () => {
  it('dispatches owner words and target information without a Router assignment rewrite', async () => {
    const f = setup()
    f.ticket.mandate.scope = '检查启动问题，修好本地代码；不要改线上，也不要推送。'
    f.ticket.execution!.assignment = 'Router invented steps: deploy first, stop on any error'
    f.store.tickets.save(f.ticket)
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const args = f.calls().find(call => call.args[1] === 'worker-start').args
    const spec = args[args.indexOf('--spec') + 1]
    expect(spec).toContain(`Owner request (verbatim):\n${f.ticket.mandate.scope}`)
    expect(spec).toContain(`Target location: ${JSON.stringify({ repository: f.dir })}`)
    expect(spec).not.toContain('Router invented steps')
    expect(spec).toContain('a peer of the Router')
    expect(spec).toContain('If a premise is false')
    expect(spec).toContain('Preserve refusals and disagreements')
    expect(spec).toContain('--report-to')
    expect(spec).toContain('already confirmed project or repository delivery agreements')
    expect(spec).toContain('do not invent a project rule or ask again')
    expect(spec).toContain('full OS permissions do not authorize new scope')
    expect(spec).not.toContain('unless the ticket explicitly authorizes it')
  })

  it.each(['before acceptance', 'after acceptance', 'after ack'])('recovers mailbox reports across interruption %s', async point => {
    const f = setup()
    f.ticket.channels = [{ source: 'router', thread: 'test-owner', address: {} }]
    f.store.tickets.save(f.ticket)
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const token = f.store.get<any>('capability', f.assignment.id).token
    const request = { id: 'domain-1', command: ['report', 'ready'], options: { ticket: f.ticket.id, assignment: f.assignment.id, token, summary: 'Owner request completed' } }
    new App(f.store, f.executor, 'owner').handle({ ...request, command: ['read'] })
    f.update({ messages: [{ id: 'report-message', type: 'status', subject: 'osa domain report', body: JSON.stringify(request), from_handle: 'worker-1', run_id: 'run-anchor-0' }] })
    const accept = f.options.report
    f.options.report = async request => {
      if (point === 'before acceptance') throw new Error('interrupted before commit')
      const result = await accept(request)
      if (point === 'after acceptance') throw new Error('interrupted after commit')
      return result
    }
    await f.tick()
    expect(f.store.list('report-receipt'), JSON.stringify(f.store.list('notice'))).toHaveLength(point === 'before acceptance' ? 0 : 1)
    expect(f.state().acked).toBe(point === 'after ack' ? 'delivery-1' : undefined)
    f.options.report = accept
    f.restart(); await f.tick(); await f.tick()
    expect(f.store.list('report-receipt'), JSON.stringify(f.store.list('notice'))).toHaveLength(1)
    expect(f.state().ackReportReceipts).toBe(1)
    expect(f.store.tickets.get(f.ticket.id)?.ended?.outcome).toBe('completed')
    expect(f.store.list('outbox')).toHaveLength(1)
  })

  it('bounds empty inbox and status polling across restart without delaying a timeout notice', async () => {
    const f = setup(false, 0)
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const count = (command: string) => f.calls().filter(call => call.args[1] === command).length
    expect(f.store.get<any>('notice', 'supervision:assignment-1').text).toContain('not proof of exit')
    const checks = count('check'), shows = count('worker-show')
    await f.executor.tick(f.engine)
    f.restart(); await f.executor.tick(f.engine)
    expect(count('check')).toBe(checks)
    expect(count('worker-show')).toBe(shows)
    expect(f.state().created).toBe(1)
    expect(f.state().stopped).toBeUndefined()
    await f.tick()
    expect(count('check')).toBe(checks + 1)
  })

  it('records only actual provider metadata and a validated completion outcome', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    expect(f.store.get<any>('execution', f.assignment.id)).toMatchObject({ provider: null, model: null, outcome: 'unknown' })
    f.update({ projection: { provider: { id: 'actual-provider', model: 'actual-model' }, outcome: 'in_progress', liveness: { verdict: 'live' } } })
    await f.tick()
    expect(f.store.get<any>('execution-attempt', 'dispatch-1')).toMatchObject({ provider: 'actual-provider', model: 'actual-model', outcome: 'in_progress' })
    f.done(); f.update({ projection: null }); await f.tick()
    expect(f.store.get<any>('execution-attempt', 'dispatch-1')).toMatchObject({ provider: 'actual-provider', model: 'actual-model', outcome: 'succeeded' })
  })

  it('records effective Orca launch metadata when the optional projection is absent', async () => {
    const f = setup()
    f.update({ startOptions: { launch: { requested: { model: 'requested' }, effective: { agent: 'provider-from-orca', model: 'effective-model' } } } })
    f.executor.start(f.ticket, f.assignment); await f.tick()
    expect(f.store.get<any>('execution', f.assignment.id)).toMatchObject({ provider: 'provider-from-orca', model: 'effective-model' })
  })

  it('preserves unknown work on unavailable status and bounds failed observation polling across restart', async () => {
    const f = setup(false, 0)
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ showUnavailable: true })
    await f.tick()
    const observations = f.calls().filter(call => call.args[1] === 'worker-show').length
    f.restart(); await f.executor.tick(f.engine)
    expect(f.calls().filter(call => call.args[1] === 'worker-show')).toHaveLength(observations)
    expect(f.store.get<any>('notice', 'supervision:assignment-1').text).toContain('preserve the original Dispatch')
    expect(f.state().created).toBe(1)
    expect(f.state().stopped).toBeUndefined()
    expect(f.state().released).toBeUndefined()
  })

  it('retires a positively exited agent before retrying the same Task', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ workers: f.state().workers.map((worker: object) => ({ ...worker, projection: { liveness: { verdict: 'exited' } } })) })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    const calls = f.calls(), stop = calls.findIndex(call => call.args[1] === 'worker-stop')
    const retry = calls.findIndex(call => call.args.includes('--retry-of'))
    expect(stop).toBeGreaterThan(-1); expect(retry).toBeGreaterThan(stop)
    expect(calls[retry]!.args).toEqual(expect.arrayContaining(['--task', 'task-1', '--retry-of', 'dispatch-1']))
    expect(f.store.list('orca-recovery')).toHaveLength(1)
    expect(f.store.list('orca-message')).toEqual([])
  })

  it('refuses a stale failed state contradicted by positive live evidence', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ workerState: 'failed', dispatchStatus: 'failed', projection: { liveness: { verdict: 'live' } } })
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('positively failed or stopped')
    expect(f.state().created).toBe(1)
    expect(f.state().stopped).toBeUndefined()
  })

  it('honors cancellation before a persisted recovery starts', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.store.put('orca-recovery', 'retry:assignment-1:dispatch-1', { id: 'retry:assignment-1:dispatch-1', ticketId: f.ticket.id, assignmentId: f.assignment.id, previous: 'dispatch-1' })
    f.engine.stopTicket(f.ticket.id, 'Owner stopped')
    f.restart(); await f.tick()
    expect(f.state().created).toBe(1)
    expect(f.state().stopped).toBe(true)
    expect(f.store.get<any>('execution', f.assignment.id).stopReceipt.state).toBe('stopped')
    expect(f.store.get<any>('orca-assignment', f.assignment.id).finished).toBe(true)
    expect(f.store.list('orca-message')).toEqual([])
  })

  it('reconciles an accepted retry then stops that replacement after cancellation during receipt loss', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ workerState: 'stopped', dispatchStatus: 'failed', dropOnce: 'worker-start' })
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('pending')
    f.engine.stopTicket(f.ticket.id, 'Owner stopped')
    f.restart(); await f.tick()
    expect(f.state().created).toBe(2)
    expect(f.calls().filter(call => call.args[1] === 'worker-stop').at(-1)!.args).toContain('dispatch-2')
    expect(f.store.get<any>('orca-assignment', f.assignment.id).finished).toBe(true)
    expect(f.store.tickets.get(f.ticket.id)!.inputs.filter(input => input.kind === 'note' && input.text.includes('Recovery after confirmed'))).toHaveLength(1)
  })

  it('preserves native circuit-breaker refusal across restart without new Tasks or repeated starts', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ workerState: 'stopped', dispatchStatus: 'failed', rejectRetries: true })
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('pending')
    f.restart(); await f.tick(); await f.tick()
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('pending')
    expect(f.state().created).toBe(1)
    expect(f.state().rejectedStarts).toBe(1)
    expect(f.store.get<any>('notice', 'retry:assignment-1:dispatch-1').text).toContain('task_not_startable')
    f.engine.stopTicket(f.ticket.id, 'Owner cancelled refused recovery')
    await f.tick()
    expect(f.state().stopped).toBe(true)
    expect(f.store.get<any>('orca-assignment', f.assignment.id).finished).toBe(true)
  })

  it('retains a positively failed initial launch for explicit retry of its original Task', async () => {
    const f = setup()
    f.update({ startState: 'failed' })
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.restart(); await f.tick()
    expect(f.state().created).toBe(1)
    expect(f.store.get<any>('orca-assignment', f.assignment.id).dispatchId).toBe('dispatch-1')
    expect(f.store.get<any>('execution-attempt', 'dispatch-1')).toMatchObject({ nativeState: 'failed', outcome: 'failed' })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    expect(f.state().created).toBe(2)
    expect(f.calls().filter(call => call.args[1] === 'worker-start').at(-1)!.args).toEqual(expect.arrayContaining(['--task', 'task-1', '--retry-of', 'dispatch-1']))
  })

  it('never replays the initial launch over a recovered Dispatch, including after restart', async () => {
    const f = setup()
    f.update({ startState: 'outcome_unknown' })
    f.executor.start(f.ticket, f.assignment); await f.tick()
    expect(f.store.get<any>('orca-job', 'start:assignment-1').done).toBeUndefined()
    f.update({ workerState: 'stopped', dispatchStatus: 'failed' })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    await f.tick()
    expect(f.store.get<any>('orca-assignment', f.assignment.id).dispatchId).toBe('dispatch-2')
    expect(f.store.get<any>('orca-job', 'start:assignment-1').done).toBe(true)
    // Also cover an unfinished initial job persisted by the pre-fix service.
    f.store.put('orca-job', 'start:assignment-1', { id: 'start:assignment-1', kind: 'start', ticketId: f.ticket.id, assignmentId: f.assignment.id })
    f.restart(); await f.tick()
    expect(f.store.get<any>('orca-assignment', f.assignment.id).dispatchId).toBe('dispatch-2')
    expect(f.store.get<any>('execution', f.assignment.id).dispatchId).toBe('dispatch-2')
    expect(f.store.get<any>('orca-job', 'start:assignment-1').done).toBe(true)
    expect(f.state().created).toBe(2)
  })

  it('reconciles a completed recovery whose binding was overwritten before retrying', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const stale = f.store.get<any>('orca-assignment', f.assignment.id)
    f.update({ workerState: 'stopped', dispatchStatus: 'failed' })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    f.store.put('orca-assignment', f.assignment.id, stale)
    f.update({ workerState: 'stopped', dispatchStatus: 'failed' })
    f.restart()
    await f.executor.retryTicket(f.engine, f.ticket.id)
    expect(f.state().created).toBe(3)
    expect(f.calls().filter(call => call.args.includes('--retry-of')).at(-1)!.args).toContain('dispatch-2')
    expect(f.store.get<any>('orca-assignment', f.assignment.id).dispatchId).toBe('dispatch-3')
  })

  it('refuses a stale binding when the completed recovery has no saved receipt', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.store.put('orca-recovery', 'retry:assignment-1:dispatch-1', { id: 'retry:assignment-1:dispatch-1', ticketId: f.ticket.id, assignmentId: f.assignment.id, previous: 'dispatch-1', done: true })
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('no usable receipt')
    expect(f.state().created).toBe(1)
  })

  it('records failed native recovery attempts and keeps explicit retries within the same Task', async () => {
    const f = setup()
    f.update({ startState: 'failed', retryState: 'failed' })
    f.executor.start(f.ticket, f.assignment); await f.tick()
    await f.executor.retryTicket(f.engine, f.ticket.id)
    f.restart(); await f.tick()
    expect(f.state().created).toBe(2)
    expect(f.store.get<any>('execution-attempt', 'dispatch-2')).toMatchObject({ outcome: 'failed', recoveredFrom: 'dispatch-1' })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    await f.executor.retryTicket(f.engine, f.ticket.id)
    expect(f.state().created).toBe(4)
    expect(f.store.get<any>('execution-attempt', 'dispatch-4')).toMatchObject({ outcome: 'failed', recoveredFrom: 'dispatch-3' })
    expect(f.calls().filter(call => call.args.includes('--retry-of')).every(call => call.args[call.args.indexOf('--task') + 1] === 'task-1')).toBe(true)
  })

  it('timeout and unverifiable observations notify without stopping or duplicating the worker', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const record = f.store.get<any>('execution', f.assignment.id)
    f.store.put('execution', f.assignment.id, { ...record, observedAt: 1, startedAt: 1 })
    f.update({ projection: { provider: { id: 'codex', model: 'observed-model' }, outcome: 'in_progress', liveness: { verdict: 'unverifiable' } } })
    f.restart(); await f.tick()
    expect(f.store.get<any>('execution', f.assignment.id).model).toBe('observed-model')
    expect(f.store.get<any>('notice', 'supervision:' + f.assignment.id).text).toContain('not proof of exit')
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('positively failed or stopped')
    expect(f.state().created).toBe(1)
    expect(f.state().stopped).toBeUndefined()
  })

  it('explicit recovery reuses the native Task, preserves files and deduplicates concurrent and interrupted launches', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const directory = f.store.tickets.get(f.ticket.id)!.execution!.directory
    writeFileSync(join(directory, 'unfinished.txt'), 'keep me')
    const current = f.store.tickets.get(f.ticket.id)!
    current.inputs.push({ id: 'unread', kind: 'trigger', triggerId: 'unread-trigger', human: true, at: current.updatedAt, readAt: null, deliveredTo: f.assignment.id })
    current.assignments[0]!.report = { state: 'blocked', summary: 'Previous evidence to preserve', at: current.updatedAt }
    f.store.tickets.save(current)
    f.update({ workerState: 'stopped', dispatchStatus: 'failed', dropOnce: 'worker-start' })
    const results = await Promise.allSettled([f.executor.retryTicket(f.engine, f.ticket.id), f.executor.retryTicket(f.engine, f.ticket.id)])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(f.state().created).toBe(2)
    f.restart(); await f.tick()
    expect(f.state().created).toBe(2)
    const start = f.calls().filter(call => call.args[1] === 'worker-start').at(-1)!.args
    expect(start).toContain('--retry-of'); expect(start).toContain('dispatch-1')
    expect(start[start.indexOf('--task') + 1]).toBe('task-1')
    expect(start).not.toContain('--spec')
    expect(readFileSync(join(directory, 'unfinished.txt'), 'utf8')).toBe('keep me')
    expect(f.store.tickets.get(f.ticket.id)!.inputs.some(input => input.kind === 'note' && input.text.includes('Recovery after confirmed'))).toBe(true)
    expect(f.store.tickets.get(f.ticket.id)!.inputs.find(input => input.id === 'unread')).toMatchObject({ readAt: null, deliveredTo: f.assignment.id })
    expect(f.store.tickets.get(f.ticket.id)!.inputs.filter(input => input.kind === 'note' && input.text.includes('Previous evidence to preserve'))).toHaveLength(1)
    expect(f.store.get<any>('execution-attempt', 'dispatch-1').report.summary).toBe('Previous evidence to preserve')
    expect(f.store.get<any>('orca-assignment', f.assignment.id).dispatchId).toBe('dispatch-2')
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('positively failed or stopped')
    expect(f.state().created).toBe(2)
  })

  it('recovery refuses unresolved child editors', async () => {
    const f = setup(true)
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ workerState: 'stopped', dispatchStatus: 'failed', childRuns: [{ id: 'child-run', coordinator_handle: 'worker-1' }],
      workers: [...f.state().workers, { dispatchId: 'child', runId: 'child-run', terminalState: 'active' }] })
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('Child worker resources')
    expect(f.state().created).toBe(1)
  })

  it('allows retry when a retained child has positively exited', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ workerState: 'stopped', dispatchStatus: 'failed', childRuns: [{ id: 'child-run', coordinator_handle: 'worker-1' }],
      workers: [...f.state().workers, { dispatchId: 'child', runId: 'child-run', terminalState: 'retained', projection: { liveness: { verdict: 'exited' } } }] })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    expect(f.state().created).toBe(2)
  })

  it('explicit recovery follows native limits and records each terminal outcome', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    for (let attempt = 0; attempt < 3; attempt++) {
      f.update({ workerState: 'stopped', dispatchStatus: 'failed' })
      await f.executor.retryTicket(f.engine, f.ticket.id)
    }
    expect(f.state().created).toBe(4)
    expect(f.store.get<any>('execution-attempt', 'dispatch-1').outcome).toBe('failed')
    expect(f.store.get<any>('execution-attempt', 'dispatch-2').outcome).toBe('failed')
  })
  it.each([false, true])('lets the Executor plan and follow project review requirements (twoLayer=%s)', async twoLayer => {
    const f = setup(twoLayer)
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const args = f.calls().find(call => call.args[1] === 'worker-start').args
    const spec = args[args.indexOf('--spec') + 1]
    expect(spec).toContain('follow review requirements from the owner and project')
    expect(spec).toContain('After starting independent child work, end your turn')
    expect(spec).not.toContain('--agent claude')
    expect(spec).not.toContain('maximum two review rounds')
    expect(spec).not.toContain('do not create child workers or reviews')
    expect(spec).not.toContain('check --wait')
    f.restart(); await f.tick()
    expect(f.state().created).toBe(1)
  })

  it('retries a settled Executor only for new undelivered input and preserves its worktree', async () => {
    const f = setup(true)
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.done()
    await f.tick()
    f.restart()
    await f.tick()
    expect(f.state().created).toBe(1)
    const ticket = f.store.tickets.get(f.ticket.id)!
    ticket.inputs.push({ id: 'new-comment', kind: 'text', text: 'Fix the PR', at: '2026-11-02T01:00:00Z' })
    ticket.undelivered.push('new-comment')
    f.store.tickets.save(ticket)
    f.executor.deliver(ticket, ticket.assignments[0]!)
    await f.tick()
    const retried = f.store.tickets.get(ticket.id)!
    expect(retried.assignments).toHaveLength(2)
    expect(retried.assignments[0]?.state).toBe('ended')
    expect(retried.undelivered).toContain('new-comment')
    expect(retried.execution?.directory).toBe(ticket.execution?.directory)
    f.restart()
    await f.tick()
    await f.tick()
    expect(f.state().created).toBe(2)
    expect(f.state().worktrees).toHaveLength(1)
    expect(f.store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
  })

  it('uses the configured agent for launch and recovery', async () => {
    const f = setup(false, undefined, undefined, 'claude')
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ workerState: 'stopped', dispatchStatus: 'failed' })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    for (const call of f.calls().filter(call => call.args[1] === 'worker-start'))
      expect(call.args[call.args.indexOf('--agent') + 1]).toBe('claude')
  })

  it('creates and reports a workspace for each selected repository', async () => {
    const f = setup(false, undefined, 2), second = mkdtempSync(join(tmpdir(), 'osa-second-'))
    cleanup.push(() => rmSync(second, { recursive: true, force: true }))
    execFileSync('git', ['init', '--quiet', second])
    execFileSync('git', ['-C', second, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
    const firstTarget = { projectId: 'p', componentId: 'c', locationId: 'one', hostId: 'local', repository: f.dir, kind: 'git' }
    const secondTarget = { ...firstTarget, locationId: 'two', repository: second }
    f.store.put('project', 'p', { id: 'p' }); f.store.put('component', 'c', { id: 'c' })
    for (const id of ['one', 'two']) f.store.put('location', id, { id })
    f.store.put('ticket-target', f.ticket.id, { ...firstTarget, ticketId: f.ticket.id, boundAt: 'now', repositories: [firstTarget, secondTarget] })
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const workspaces = new Projects(f.store).workspaces(f.ticket.id)
    expect(workspaces.map(workspace => workspace.locationId)).toEqual(['one', 'two'])
    expect(workspaces.map(workspace => workspace.directory)).toEqual([join(f.dir, 'small-change'), join(second, 'small-change')])
    const args = f.calls().find(call => call.args[1] === 'worker-start').args
    expect(args[args.indexOf('--spec') + 1]).toContain(join(second, 'small-change'))
    const overlapping = { ...f.ticket, id: 'overlap', execution: { name: 'overlap', directory: f.dir, assignment: 'Overlap' } }
    f.store.tickets.save(overlapping)
    f.store.put('ticket-target', overlapping.id, { ...firstTarget, ticketId: overlapping.id, boundAt: 'now', repositories: [firstTarget, secondTarget] })
    f.store.put('ticket-workspace', 'overlap:two', { ...workspaces[1], ticketId: overlapping.id })
    expect((f.executor as any).canStart(overlapping, 'overlap-assignment')).toBe(false)
    expect(f.store.get<any>('notice', 'queue:overlap').text).toContain('workspace occupied')
    f.restart(); await f.tick()
    expect(f.state().worktrees).toHaveLength(2)
    expect(f.state().created).toBe(1)
    f.done(); await f.tick()
    const previous = f.store.tickets.get(f.ticket.id)!
    previous.ended = { by: 'human', outcome: 'completed', at: new Date().toISOString() }; f.store.tickets.save(previous)
    const next = { ...previous, id: 'next', ended: undefined, execution: { name: 'next', directory: '', assignment: 'Continue' }, assignments: [{ id: 'next-assignment', state: 'pending' as const, createdAt: previous.createdAt }] }
    f.store.tickets.save(next)
    f.store.put('ticket-target', next.id, { ...firstTarget, ticketId: next.id, boundAt: 'now', repositories: [firstTarget, secondTarget] })
    f.store.put('task-plan', next.id, { ticketId: next.id, priority: 0, dependsOn: [], resources: [], createdAt: next.createdAt, continueFrom: previous.id })
    f.executor.start(next, next.assignments[0]); await f.tick()
    expect(new Projects(f.store).workspaces(next.id).map(workspace => workspace.directory)).toEqual(workspaces.map(workspace => workspace.directory))
    expect(f.state().worktrees).toHaveLength(2)
    expect(f.state().created).toBe(2)
  })

  it('preserves new inputs while settled-worker cleanup is still uncertain', async () => {
    const f = setup(true)
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.done()
    f.update({ releaseState: 'release_unknown' })
    await f.tick()
    const ticket = f.store.tickets.get(f.ticket.id)!
    ticket.inputs.push({ id: 'new-comment', kind: 'text', text: 'Fix the PR', at: '2026-11-02T01:00:00Z' })
    ticket.undelivered.push('new-comment')
    f.store.tickets.save(ticket)
    f.executor.deliver(ticket, ticket.assignments[0]!)
    f.restart()
    await f.tick()
    expect(f.store.get<any>('orca-job', 'deliver:assignment-1:new-comment')?.done).not.toBe(true)
    expect(f.store.tickets.get(ticket.id)?.undelivered).toContain('new-comment')
    expect(f.store.tickets.get(ticket.id)?.assignments).toHaveLength(1)
    expect(f.state().created).toBe(1)
  })

  it('queues transactionally and launches an isolated codex worktree with no inherited Orca identity', async () => {
    const f = setup()
    expect(() => f.store.atomic(() => { f.executor.start(f.ticket, f.assignment); throw Error('rollback') })).toThrow('rollback')
    expect(f.store.list('orca-job')).toEqual([])
    expect(f.store.list('capability')).toEqual([])
    f.executor.start(f.ticket, f.assignment)
    f.executor.start(f.ticket, f.assignment)
    expect(f.store.list('orca-job')).toHaveLength(1)
    process.env.ORCA_FAKE_ATTESTATION = 'must-not-leak'
    try { await f.tick() } finally { delete process.env.ORCA_FAKE_ATTESTATION }
    expect(f.calls().every(call => call.env.length === 0)).toBe(true)
    const args = f.calls().find(call => call.args[1] === 'worker-start').args
    expect(args).toEqual(expect.arrayContaining(['--worktree', 'path:' + join(f.dir, 'small-change'), '--agent', 'codex']))
    expect(execFileSync('git', ['-C', join(f.dir, 'small-change'), 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('small-change')
    expect(args[args.indexOf('--spec') + 1]).toContain(f.options.osaCommand + ' read')
    expect(args[args.indexOf('--spec') + 1]).toContain('--token')
    expect(f.store.tickets.get(f.ticket.id)?.execution?.directory).toBe(join(f.dir, 'small-change'))
    expect(f.store.tickets.get(f.ticket.id)?.assignments[0]?.state).toBe('running')
    f.restart()
    const interrupted = vi.spyOn(f.engine, 'assignmentInterrupted')
    await f.tick()
    expect(f.state().created).toBe(1)
    expect(interrupted).not.toHaveBeenCalled()
  })

  it('recovers a launch accepted before its receipt was persisted across a database reopen', async () => {
    const f = setup()
    f.update({ dropOnce: 'worker-start' })
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    expect(f.state().created).toBe(1)
    expect(f.store.tickets.get(f.ticket.id)?.assignments[0]?.state).toBe('pending')
    f.restart()
    await f.tick()
    expect(f.state().created).toBe(1)
    expect(f.calls().filter(call => call.args[1] === 'worker-start')).toHaveLength(1)
    expect(f.store.tickets.get(f.ticket.id)?.assignments[0]?.state).toBe('running')
    expect(f.store.get<any>('orca-job', 'start:assignment-1')?.done).toBe(true)
  })

  it('reconciles a missing launch receipt from the unique assignment Run instead of relaunching', async () => {
    const f = setup()
    f.update({ dropOnce: 'worker-start' })
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.update({ requests: {} })
    f.restart()
    await f.tick()
    expect(f.state().created).toBe(1)
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.dispatchId).toBe('dispatch-1')
  })

  it('preserves an uncertain launch when neither receipt nor worker is observable', async () => {
    const f = setup()
    f.update({ dropOnce: 'worker-start' })
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.update({ requests: {}, workers: [] })
    f.restart()
    await f.tick()
    await f.tick()
    expect(f.state().created).toBe(1)
    expect(f.store.get<any>('orca-job', 'start:assignment-1')?.error).toContain('refusing duplicate')
  })

  it('reconciles an accepted anchor without creating a second terminal', async () => {
    const f = setup()
    f.update({ dropOnce: 'create' })
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.restart()
    await f.tick()
    expect(f.state().terminals).toHaveLength(1)
    expect(f.state().created).toBe(1)
  })

  it('persists matching completion before release, and release before ack, even after receipt loss', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.done()
    f.update({ dropOnce: 'worker-release' })
    await f.tick()
    expect(f.store.get<any>('orca-message', 'done-1')?.accepted).toBe(true)
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.settled).toBe('done-1')
    expect(f.state().released).toBe(true)
    expect(f.state().releaseSawSettlement).toBe(true)
    expect(f.state().acked).toBeUndefined()
    expect(f.store.tickets.get(f.ticket.id)?.ended).toBeUndefined()
    expect(f.store.get<any>('notice', 'done-1')?.text).toContain('without an osa domain report')
    f.restart()
    await f.tick()
    expect(f.state().acked).toBe('delivery-1')
    expect(f.state().ackSawRelease).toBe(true)
    expect(f.state().anchorClosed).toBe(true)
    expect(f.calls().filter(call => call.args[1] === 'worker-release')).toHaveLength(1)
    const release = f.calls().findIndex(call => call.args[1] === 'worker-release')
    const ack = f.calls().findIndex(call => call.args.includes('--ack'))
    expect(ack).toBeGreaterThan(release)
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.finished).toBe(true)
  })

  it.each([
    { payload: '{invalid json' },
    { payload: JSON.stringify({ taskId: 'stale-task', dispatchId: 'dispatch-1', outcome: 'succeeded' }) },
    { payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'old-dispatch', outcome: 'succeeded' }) },
    { from_handle: 'another-worker' },
    { run_id: 'another-run' },
    { type: 'status' },
  ])('never releases on invalid or mismatched completion %j', async overrides => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.done(overrides)
    await f.tick()
    expect(f.state().released).toBeUndefined()
    expect(f.state().acked).toBe('delivery-1')
    expect(f.store.get<any>('orca-message', 'done-1')?.accepted).toBe(false)
  })

  it('retains a batch if release is uncertain and does not turn absence into settlement', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.done()
    f.update({ releaseState: 'release_unknown' })
    await f.tick()
    f.restart()
    await f.tick()
    expect(f.state().acked).toBeUndefined()
    expect(f.store.get<any>('notice', 'poll:assignment-1')?.text).toContain('release_unknown')
    const count=f.calls().length
    await f.executor.tick(f.engine)
    await f.executor.tick(f.engine)
    expect(f.calls()).toHaveLength(count)
  })

  it('sends an input once and stores its original message/input IDs without marking it read', async () => {
    const f = setup()
    f.ticket.inputs = [{ id: 'input-1', kind: 'trigger', triggerId: 'followup', human: true, at: '2026-11-02T00:00:01Z' }]
    f.ticket.undelivered = ['input-1']
    f.store.tickets.save(f.ticket)
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.update({ dropOnce: 'send' })
    await f.tick()
    f.restart()
    await f.tick()
    f.executor.deliver(f.ticket, f.assignment)
    await f.tick()
    expect(f.state().sent).toBe(1)
    expect(f.store.get('orca-delivery', 'message-1')).toEqual({ messageId: 'message-1', ticketId: 'ticket-1', assignmentId: 'assignment-1', inputIds: ['input-1'] })
    expect(f.store.tickets.get(f.ticket.id)?.inputs[0]).toMatchObject({ readAt: null, deliveredTo: 'assignment-1' })
  })

  it('does not stop workers on normal domain completion, but persists explicit cancellation', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.engine.report(f.ticket.id, { state: 'ready', summary: 'Complete' })
    await f.tick()
    expect(f.state().stopped).toBeUndefined()
    f.done()
    await f.tick()
    expect(f.state().released).toBe(true)
    expect(f.store.tickets.get(f.ticket.id)?.ended?.outcome).toBe('completed')
  })

  it('delivers to a nested coordinator Dispatch without constraining its child inbox Run', async () => {
    const f = setup(true)
    f.ticket.inputs = [{ id: 'input-1', kind: 'trigger', triggerId: 'followup', human: true, at: '2026-11-02T00:00:01Z' }]
    f.ticket.undelivered = ['input-1']; f.store.tickets.save(f.ticket)
    f.store.put('orca-operation', 'deliver:assignment-1:input-1', { id: 'deliver:assignment-1:input-1', requestId:'old-rejected', attempted:true,
      args:['orchestration','send','--run','parent-run'], response:{ok:false,error:{code:'recipient_run_mismatch'}} })
    f.executor.start(f.ticket,f.assignment); await f.tick(); await f.tick()
    const sends = f.calls().filter(call=>call.args[1]==='send')
    expect(sends).toHaveLength(1)
    expect(sends[0].args).toEqual(expect.arrayContaining(['--to','dispatch:dispatch-1']))
    expect(sends[0].args).not.toContain('--run')
    expect(f.store.get('orca-rejected-operation','old-rejected')).toBeTruthy()
    expect(f.store.get('orca-delivery','message-1')).toMatchObject({inputIds:['input-1']})
  })

  it('recovers a lost anchor-close receipt without recreating the completed anchor', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.done()
    f.update({ dropOnce: 'close' })
    await f.tick()
    expect(f.state().anchorClosed).toBe(true)
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.finished).not.toBe(true)
    f.restart()
    await f.tick()
    expect(f.calls().filter(call => call.args[0] === 'terminal' && call.args[1] === 'create')).toHaveLength(1)
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.finished).toBe(true)
  })

  it('cleans an already-finished legacy binding whose anchor cleanup was not recorded', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    const binding = f.store.get<any>('orca-assignment', 'assignment-1')
    f.store.put('orca-assignment', binding.id, { ...binding, released: true, finished: true })
    f.restart()
    await f.tick()
    expect(f.state().anchorClosed).toBe(true)
    expect(f.state().created).toBe(1)
    expect(f.store.get('orca-operation', 'close:assignment-1')).toMatchObject({ done: true })
  })

  it('does not accept matching-looking worker_done while the dispatch is still running', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.done()
    f.update({ dispatchStatus: 'dispatched' })
    await f.tick()
    expect(f.state().released).toBeUndefined()
    expect(f.store.get<any>('orca-message', 'done-1')?.accepted).toBe(false)
  })

  it('stops an explicitly cancelled assignment without worker-release and frees its slot', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.engine.stopTicket(f.ticket.id, 'User cancellation')
    await f.tick()
    expect(f.state().stopped).toBe(true)
    expect(f.state().released).toBeUndefined()
    expect(f.state().anchorClosed).toBe(true)
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.finished).toBe(true)
  })

  it('does not free a cancelled assignment when worker-stop is unknown', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.update({ stopState: 'stop_unknown' })
    f.engine.stopTicket(f.ticket.id, 'User cancellation')
    await f.tick()
    expect(f.state().released).toBeUndefined()
    expect(f.state().anchorClosed).toBeUndefined()
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.finished).not.toBe(true)
  })

  it('recovers unknown worktree creation by its durable ticket marker and never recreates it', async () => {
    const f = setup()
    f.update({ dropOnce: 'worktree:create' })
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    f.restart()
    await f.tick()
    expect(f.state().worktrees).toHaveLength(1)
    expect(f.state().created).toBe(1)
    expect(execFileSync('git', ['-C', join(f.dir, 'small-change'), 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('small-change')
  })

  it('does not overwrite an existing branch to satisfy a ticket short name', async () => {
    const f = setup()
    execFileSync('git', ['-C', f.dir, 'branch', 'small-change'])
    f.executor.start(f.ticket, f.assignment)
    await f.tick()
    expect(f.state().created).toBe(0)
    expect(f.store.get<any>('orca-job', 'start:assignment-1')?.error).toContain('already exists')
    f.engine.stopTicket(f.ticket.id, 'Cancel blocked preparation')
    await f.tick()
    expect(f.state().anchorClosed).toBe(true)
    expect(f.store.get<any>('orca-assignment', 'assignment-1')?.finished).toBe(true)
  })

  it('keeps one P1 assignment active and prunes consumed check operations', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment)
    const next = { ...f.ticket, id: 'ticket-2', execution: { ...f.ticket.execution!, name: 'second-change' }, assignments: [{ ...f.assignment, id: 'assignment-2' }] }
    f.store.tickets.save(next)
    f.executor.start(next, next.assignments[0]!)
    await f.tick()
    await f.tick()
    expect(f.state().created).toBe(1)
    expect(f.store.list<any>('orca-operation').filter(row => row.id.startsWith('check:'))).toEqual([])
    f.done()
    await f.tick()
    expect(f.store.list<any>('orca-operation').filter(row => row.id.startsWith('ack:'))).toEqual([])
    await f.tick()
    expect(f.state().created).toBe(2)
    expect(f.store.list<any>('orca-assignment').map(row => row.runId)).toHaveLength(2)
    expect(new Set(f.store.list<any>('orca-assignment').map(row => row.runId)).size).toBe(2)
  })
})

function registryFixture(maxExecutors = 2) {
  const f = setup(false, undefined, maxExecutors), projects = new Projects(f.store)
  projects.ensureLegacy(f.dir)
  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'osa-other-repo-')))
  execFileSync('git', ['init', '--quiet', otherRoot])
  execFileSync('git', ['-C', otherRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'])
  cleanup.push(() => rmSync(otherRoot, { recursive: true, force: true }))
  projects.handle(['project', 'add'], { id: 'other', name: 'Unrelated arbitrary project' })
  projects.handle(['component', 'add'], { id: 'other', name: 'Component', project: 'other' })
  projects.handle(['location', 'add'], { id: 'other', name: 'Checkout', component: 'other', repository: otherRoot, 'base-branch': 'HEAD' })
  const queue = (id: string, project: string, priority = 0, resources = '') => {
    const assignment: Assignment = { ...f.assignment, id: 'assignment-' + id }
    const ticket: Ticket = { ...f.ticket, id, assignments: [assignment], execution: { ...f.ticket.execution!, name: id, directory: '' } }
    f.store.tickets.save(ticket); projects.bind(ticket, { project, priority: String(priority), resources }); f.executor.start(ticket, assignment)
    return ticket
  }
  return { ...f, projects, otherRoot, queue }
}

it('launches two isolated repositories concurrently with frozen roots and baseline across restart', async () => {
  const f = registryFixture()
  f.projects.handle(['task', 'plan'], { ticket: f.ticket.id, priority: '20' })
  f.executor.start(f.ticket, f.assignment)
  const other = f.queue('different-project', 'other', -10)
  await f.tick()
  expect(f.state().created).toBe(2)
  expect(f.store.tickets.get(other.id)?.execution?.directory).toBe(join(f.otherRoot, other.id))
  const create = f.calls().find(call => call.args[0] === 'worktree' && call.args.includes('path:' + f.otherRoot))
  expect(create.args).toEqual(expect.arrayContaining(['--base-branch', 'HEAD']))
  expect(f.calls().filter(call => call.args[0] === 'terminal' && call.args[1] === 'create').map(call => call.args[call.args.indexOf('--worktree') + 1])).toEqual(expect.arrayContaining(['path:' + realpathSync(f.dir), 'path:' + f.otherRoot]))
  f.restart(); await f.tick()
  expect(f.state().created).toBe(2)
})

it('blocks shared resources, paused projects, and unsupported remote targets without blocking unrelated work', async () => {
  const f = registryFixture()
  f.projects.handle(['task', 'plan'], { ticket: f.ticket.id, resources: 'shared-db' })
  f.executor.start(f.ticket, f.assignment)
  const conflict = f.queue('conflicting', 'other', 0, 'shared-db')
  await f.tick()
  expect(f.state().created).toBe(1)
  expect(f.store.get<any>('notice', 'queue:' + conflict.id).text).toContain('resource')
  const free = f.queue('free', 'other')
  f.projects.handle(['project', 'pause'], { id: 'other' }); await f.tick()
  expect(f.state().created).toBe(1)
  f.projects.handle(['project', 'resume'], { id: 'other' }); await f.tick()
  expect(f.state().created).toBe(2)
  expect(f.store.tickets.get(free.id)?.execution?.directory).toContain(f.otherRoot)
  expect(() => f.projects.handle(['task', 'plan'], { ticket: free.id, resources: 'new-resource' })).toThrow('frozen')
})

it('rotates projects before another high-priority start and retains capacity across restart', async () => {
  const f = registryFixture(1)
  f.executor.start(f.ticket, f.assignment); await f.tick()
  f.queue('high-new', 'legacy', 1000)
  f.queue('low-waiting', 'other', -1000)
  f.store.put('orca-assignment', f.assignment.id, { ...f.store.get<any>('orca-assignment', f.assignment.id), finished: true })
  await f.tick()
  const starts = f.calls().filter(call => call.args[1] === 'worker-start')
  expect(starts).toHaveLength(2)
  expect(starts[1].args.join(' ')).toContain('low-waiting')
  f.restart(); await f.tick()
  expect(f.state().created).toBe(2)
})

it('rejects a configured ticket trying to adopt a business root or another repository worktree', async () => {
  const f = registryFixture()
  const ticket = f.store.tickets.get(f.ticket.id)!
  ticket.execution!.directory = f.dir; f.store.tickets.save(ticket)
  f.executor.start(ticket, f.assignment); await f.tick()
  expect(f.state().created).toBe(0)
  expect(f.store.get<any>('notice', 'start:' + f.assignment.id).text).toContain('isolated worktree')
})

it('does not recover a paused project and still delivers inputs to its active worker', async () => {
  const f = registryFixture()
  f.executor.start(f.ticket, f.assignment); await f.tick()
  f.projects.handle(['project', 'pause'], { id: 'legacy' })
  const ticket = f.store.tickets.get(f.ticket.id)!
  ticket.inputs.push({ id: 'follow', kind: 'note', text: 'Authorized followup', at: ticket.createdAt })
  ticket.undelivered.push('follow'); f.store.tickets.save(ticket)
  f.executor.deliver(ticket, ticket.assignments.at(-1)!); await f.tick()
  expect(f.state().sent).toBe(1)
  await expect(f.executor.retryTicket(f.engine, ticket.id)).rejects.toThrow('paused')
  expect(f.state().created).toBe(1)
  expect(f.state().stopped).toBeUndefined()
})

it('lets waiting time raise an older task above a newer priority within a project', async () => {
  const f = registryFixture(1)
  f.projects.handle(['task', 'plan'], { ticket: f.ticket.id, priority: '10' })
  f.executor.start(f.ticket, f.assignment)
  const older = f.queue('older', 'legacy', 0)
  const plan = f.store.get<any>('task-plan', older.id)
  f.store.put('task-plan', older.id, { ...plan, createdAt: new Date(Date.now() - 60 * 60_000).toISOString() })
  await f.tick()
  expect(f.state().created).toBe(1)
  expect(f.calls().find(call => call.args[1] === 'worker-start').args.join(' ')).toContain('--task-title Implement ticket --worktree path:' + realpathSync(f.dir) + '/older')
})

it('recovers one failed executor while another project remains active within maxExecutors', async () => {
  const f = registryFixture(2)
  f.executor.start(f.ticket, f.assignment); f.queue('other-active', 'other')
  await f.tick(); expect(f.state().created).toBe(2)
  const original = f.store.get<any>('orca-assignment', f.assignment.id)
  f.update({ workerState: 'failed', dispatchStatus: 'failed' })
  await f.executor.retryTicket(f.engine, f.ticket.id)
  expect(f.state().created).toBe(3)
  const recovery = f.calls().find(call => call.args.includes('--retry-of'))
  expect(recovery.args).toEqual(expect.arrayContaining(['--task', original.taskId, '--retry-of', original.dispatchId]))
  expect(f.store.list<any>('orca-recovery').every(item => item.done)).toBe(true)
})

it('regression: slow launch does not prevent supervision of another running assignment', async () => {
  const f = setup(false, undefined, 2)
  f.executor.start(f.ticket, f.assignment)
  f.store.put('orca-assignment', 'running-other', { id: 'running-other', ticketId: 'other', dispatchId: 'other-dispatch', generation: 0, poll: 0 })
  let release!: () => void, began!: () => void
  const entered = new Promise<void>(resolve => { began = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.executor as any, 'launch').mockImplementation(async () => { began(); await blocked })
  const poll = vi.spyOn(f.executor as any, 'poll').mockResolvedValue(undefined)
  vi.spyOn(f.executor as any, 'observe').mockResolvedValue(undefined)
  const work = f.tick()
  await entered; await new Promise(resolve => setTimeout(resolve, 25))
  const observedWhileLaunching = poll.mock.calls.length
  release(); await work
  expect(observedWhileLaunching).toBeGreaterThan(0)
})

it('regression: owner cancellation during workspace preparation prevents new worker launch', async () => {
  const f = setup()
  const workspace = (f.executor as any).workspace.bind(f.executor)
  vi.spyOn(f.executor as any, 'workspace').mockImplementation(async (...args: any[]) => {
    const directory = await workspace(...args)
    f.engine.stopTicket(f.ticket.id, 'Owner cancelled before any worker-start')
    return directory
  })
  f.executor.start(f.ticket, f.assignment)
  await f.tick()
  expect(f.store.tickets.get(f.ticket.id)?.ended?.outcome).toBe('stopped')
  expect(f.state().created).toBe(0)
})

it('inspection reuses the registered directory and never creates or renames a worktree', async () => {
  const f = registryFixture(2)
  f.projects.handle(['task','plan'], {ticket:f.ticket.id, workspace:'inspect'})
  f.executor.start(f.ticket, f.assignment); await f.tick()
  expect(f.state().worktrees).toHaveLength(0)
  expect(f.store.tickets.get(f.ticket.id)?.execution?.directory).toBe(realpathSync(f.dir))
  expect(f.calls().find(c=>c.args[1]==='worker-start').args.join(' ')).toContain('Do not change its code')
  expect(()=>f.projects.handle(['task','plan'],{ticket:f.ticket.id,workspace:'isolated'})).toThrow('frozen')
})

it('an ended ticket can hand off its directory to a separately identified continuation', async () => {
  const f = registryFixture(2)
  f.executor.start(f.ticket, f.assignment); await f.tick()
  f.engine.report(f.ticket.id,{state:'ready',summary:'Done'}); f.done(); await f.tick()
  const previous = f.store.tickets.get(f.ticket.id)!
  const next = f.queue('continuation','legacy')
  f.projects.handle(['task','plan'],{ticket:next.id,'continue-from':previous.id})
  await f.tick()
  expect(f.state().worktrees).toHaveLength(1)
  expect(f.store.tickets.get(next.id)?.execution?.directory).toBe(previous.execution?.directory)
  expect(f.store.get<any>('orca-assignment',next.assignments[0].id)?.runId).not.toBe(f.store.get<any>('orca-assignment',f.assignment.id)?.runId)
})


it('persists an outcome-unknown native launch and stops its exact Dispatch after cancellation and restart', async () => {
  const f=setup();f.update({startState:'outcome_unknown'})
  f.executor.start(f.ticket,f.assignment);await f.tick()
  expect(f.store.get<any>('orca-assignment',f.assignment.id).dispatchId).toBe('dispatch-1')
  f.engine.stopTicket(f.ticket.id,'Owner cancelled');f.restart();await f.tick()
  expect(f.state().created).toBe(1)
  expect(f.calls().filter(c=>c.args[1]==='worker-stop').at(-1).args).toContain('dispatch-1')
  expect(f.store.get<any>('orca-assignment',f.assignment.id).finished).toBe(true)
})

it('persists an outcome-unknown recovery and cancels the replacement rather than the retired Dispatch', async () => {
  const f=setup();f.executor.start(f.ticket,f.assignment);await f.tick()
  f.update({workerState:'stopped',dispatchStatus:'failed',retryState:'outcome_unknown'})
  await f.executor.retryTicket(f.engine,f.ticket.id)
  expect(f.store.get<any>('orca-assignment',f.assignment.id).dispatchId).toBe('dispatch-2')
  expect(f.store.get<any>('execution-attempt','dispatch-2').outcome).toBe('unknown')
  f.engine.stopTicket(f.ticket.id,'Owner cancelled');f.restart();await f.tick()
  expect(f.state().created).toBe(2)
  expect(f.calls().filter(c=>c.args[1]==='worker-stop').at(-1).args).toContain('dispatch-2')
  expect(f.store.get<any>('orca-assignment',f.assignment.id).finished).toBe(true)
})

it('settles cancellation without a start job or native resources', async () => {
  const f=setup();f.engine.stopTicket(f.ticket.id,'Cancel pending before executor start');await f.tick()
  expect(f.store.get<any>('orca-job','stop:'+f.assignment.id).done).toBe(true)
  expect(f.store.list('orca-assignment')).toEqual([])
  expect(f.state().created).toBe(0)
})

it('backs off preparation failures while cancellation still closes the unused anchor immediately', async () => {
  const f=setup();execFileSync('git',['-C',f.dir,'branch','small-change'])
  f.executor.start(f.ticket,f.assignment);await f.tick()
  const count=f.calls().length;await f.executor.tick(f.engine);expect(f.calls()).toHaveLength(count)
  f.engine.stopTicket(f.ticket.id,'Cancel failed preparation');await f.executor.tick(f.engine)
  expect(f.state().anchorClosed).toBe(true)
  expect(f.store.get<any>('orca-assignment',f.assignment.id).finished).toBe(true)
})

it('retry waits for a lane that began before recovery was queued, then processes recovery', async () => {
  const f=setup();f.executor.start(f.ticket,f.assignment);await f.tick()
  f.update({workerState:'stopped',dispatchStatus:'failed'})
  let release!:()=>void, began!:()=>void
  const gate=new Promise<void>(r=>{release=r}), entered=new Promise<void>(r=>{began=r})
  const executor=f.executor as any, read=executor.read.bind(executor)
  let injected=false
  vi.spyOn(executor,'read').mockImplementation(async (...args:any[])=>{
    if(args[0][1]==='run-list' && !injected) {
      injected=true
      vi.spyOn(executor,'poll').mockImplementationOnce(async ()=>{began();await gate})
      f.executor.pulse(f.engine)
      await entered
    }
    return read(...args)
  })
  let queued!:()=>void
  const persisted=new Promise<void>(r=>{queued=r}), put=f.store.put.bind(f.store)
  vi.spyOn(f.store,'put').mockImplementation((kind,id,value)=>{put(kind,id,value);if(kind==='orca-recovery')queued()})
  const retry=f.executor.retryTicket(f.engine,f.ticket.id)
  await persisted
  release();await retry
  expect(f.state().created).toBe(2)
  expect(f.store.list<any>('orca-recovery').every(r=>r.done)).toBe(true)
})


it('cancels an explicitly refused initial launch without retaining the unused anchor', async () => {
  const f=setup();f.update({rejectInitial:true});f.executor.start(f.ticket,f.assignment);await f.tick()
  f.engine.stopTicket(f.ticket.id,'Cancel refused launch');await f.executor.tick(f.engine)
  expect(f.state().created).toBe(0)
  expect(f.state().anchorClosed).toBe(true)
  expect(f.store.get<any>('orca-assignment',f.assignment.id).finished).toBe(true)
  await f.tick();expect(f.store.get<any>('orca-job','start:'+f.assignment.id).done).toBe(true)
})


describe('settlement reconciliation', () => {
  it('resumes polling after a cached local runtime outage and releases a completed worker', async () => {
    const f = setup(); f.executor.start(f.ticket, f.assignment); await f.tick()
    const binding = f.store.get<any>('orca-assignment', f.assignment.id)
    f.store.put('orca-operation', `check:${binding.id}:${binding.poll}`, {
      id: `check:${binding.id}:${binding.poll}`, requestId: 'local-outage', attempted: true,
      args: ['orchestration', 'check', '--run', binding.runId, '--terminal', binding.anchor],
      response: { id: 'local', ok: false, error: { code: 'runtime_unavailable', message: 'No runtime metadata' }, _meta: { runtimeId: null } },
    })
    f.done(); f.restart(); await f.tick()
    expect(f.store.get<any>('orca-assignment', binding.id).finished).toBe(true)
    expect(f.state().created).toBe(1)
    expect(f.store.get('notice', `poll:${binding.id}`)).toBeUndefined()
  })

  function settled(f: ReturnType<typeof setup>, patch: object = {}) {
    f.update({ coordinator: 'worker-1', dispatchStatus: 'completed', workerState: 'succeeded',
      taskResults: [{id:'task-1', run_id:'run-anchor-0', status:'completed', result:{provenance:'worker_report',outcome:'succeeded',reportedBy:'worker-1',completedBy:'worker-1',messageId:'done-lost',body:'Completed'}}], ...patch })
  }
  it('recovers a genuine settlement from a fenced mailbox and releases only after recording evidence', async () => {
    const f=setup(); f.executor.start(f.ticket,f.assignment); await f.tick()
    settled(f); await f.tick()
    expect(f.store.get<any>('orca-assignment','assignment-1').settled).toBe('done-lost')
    expect(f.store.get<any>('orca-settlement','dispatch-1').result.provenance).toBe('worker_report')
    expect(f.state().coordinator).toBe('anchor-0')
    f.restart(); await f.tick()
    expect(f.state().released).toBe(true)
    expect(f.store.get<any>('orca-assignment','assignment-1').finished).toBe(true)
    expect(f.state().created).toBe(1)
  })
  it.each([
    {currentDispatch:'a-newer-dispatch'},
    {taskResults:[{id:'task-1',run_id:'run-anchor-0',status:'completed',result:{provenance:'manual',messageId:'fake'}}]},
    {coordinator:'foreign-coordinator'},
    {childRuns:[{id:'child-run',coordinator_handle:'worker-1'}],workers:[{dispatchId:'dispatch-1',taskId:'task-1',runId:'run-anchor-0'},{dispatchId:'child',runId:'child-run',terminalState:'owned'}]},
  ])('preserves unresolved ownership or evidence %j', async patch => {
    const f=setup(); f.executor.start(f.ticket,f.assignment); await f.tick(); settled(f,patch); await f.tick(); await f.tick()
    expect(f.state().released).toBeUndefined()
    expect(f.store.get<any>('orca-assignment','assignment-1').finished).not.toBe(true)
    expect(f.state().created).toBe(1)
  })
  it.each([
    [{ workerState: 'succeeded', projection: { liveness: { verdict: 'unverifiable' } } }, true],
    [{ workerState: 'ready', projection: { liveness: { verdict: 'live' } } }, false],
    [{ projection: { liveness: { verdict: 'unverifiable', reason: 'missing_status' } } }, false],
    [{ workerState: 'succeeded', projection: { liveness: { verdict: 'live' } } }, false],
    [{ terminalState: 'released', projection: { liveness: { verdict: 'live' } } }, false],
  ])('handles retained child execution evidence %j', async (child, finished) => {
    const f = setup(); f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ childRuns: [{ id: 'child-run', coordinator_handle: 'worker-1' }],
      workers: [...f.state().workers, { dispatchId: 'child', runId: 'child-run', terminalState: 'retained', ...child }] })
    f.done(); await f.tick()
    const ticket = f.store.tickets.get(f.ticket.id)!
    ticket.inputs.push({ id: 'late', kind: 'text', text: 'Continue', at: new Date().toISOString() }); ticket.undelivered.push('late'); f.store.tickets.save(ticket)
    f.executor.deliver(ticket, ticket.assignments[0]!); await f.tick(); await f.tick()
    expect(!!f.store.get<any>('orca-assignment', f.assignment.id).finished).toBe(finished)
    expect(f.store.tickets.get(ticket.id)!.assignments.length).toBe(finished ? 2 : 1)
    if (!finished) expect(f.store.get<any>('notice', `poll:${f.assignment.id}`).text).toContain('child')
  })

  it('does not send late inputs to an inactive Dispatch and continues them after safe release', async () => {
    const f=setup(); f.executor.start(f.ticket,f.assignment); await f.tick(); settled(f)
    const ticket=f.store.tickets.get(f.ticket.id)!
    ticket.inputs.push({id:'late',kind:'trigger',triggerId:'late',human:true,at:new Date().toISOString()}); ticket.undelivered.push('late'); f.store.tickets.save(ticket)
    f.executor.deliver(ticket,ticket.assignments[0]); await f.tick(); await f.tick(); await f.tick()
    expect(f.state().sent).toBe(0)
    expect(f.store.tickets.get(ticket.id)!.assignments.length).toBe(2)
  })
  it('retires a cancelled abandoned attempt only with positive exit and no live children', async () => {
    const f=setup(); f.executor.start(f.ticket,f.assignment); await f.tick()
    const ticket=f.store.tickets.get(f.ticket.id)!; ticket.ended={by:'human',outcome:'stopped',at:new Date().toISOString()}; f.store.tickets.save(ticket)
    f.update({workerState:'abandoned',dispatchStatus:'failed'}); await f.tick()
    expect(f.store.get<any>('orca-assignment','assignment-1').finished).not.toBe(true)
    f.update({workers:f.state().workers.map((w:object)=>({...w,projection:{liveness:{verdict:'exited'}}}))}); await f.tick()
    expect(f.store.get<any>('orca-assignment','assignment-1').finished).toBe(true)
    expect(f.state().released).toBeUndefined()
    expect(f.state().created).toBe(1)
  })
})


it('retry does not wait for an unrelated slow assignment', async () => {
  const f=setup(); f.executor.start(f.ticket,f.assignment); await f.tick()
  f.update({workerState:'failed',dispatchStatus:'failed'})
  let unblock!: () => void
  const unrelated=new Promise<void>(resolve=>{unblock=resolve})
  const lanes=(f.executor as any).working as Map<string,Promise<void>>
  lanes.set('unrelated',unrelated)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([f.executor.retryTicket(f.engine,f.ticket.id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Retry waited on unrelated work')),3000)})])
    expect(f.state().created).toBe(2)
  } finally { clearTimeout(timer); unblock(); lanes.delete('unrelated') }
})


it.each(['missing_status','host_unavailable'])('cancelled exact-host exit only outranks a client evidence gap: %s', async reason => {
  const f=setup(); f.executor.start(f.ticket,f.assignment); await f.tick()
  const ticket=f.store.tickets.get(f.ticket.id)!; ticket.ended={by:'human',outcome:'stopped',at:new Date().toISOString()}; f.store.tickets.save(ticket)
  f.update({workerState:'abandoned',dispatchStatus:'failed',observation:{status:'exited',exactWorker:true},workers:f.state().workers.map((w:object)=>({...w,projection:{liveness:{verdict:'unverifiable',reason}}}))})
  await f.tick()
  expect(!!f.store.get<any>('orca-assignment','assignment-1').finished).toBe(reason==='missing_status')
  if(reason==='missing_status') expect(f.store.get('notice','supervision:assignment-1')).toBeUndefined()
  expect(f.state().created).toBe(1)
})


it('retires an exited stopped attempt without cancelling or silently retrying its unfinished goal', async () => {
  const f=setup(); f.executor.start(f.ticket,f.assignment); await f.tick()
  f.update({workerState:'stopped',dispatchStatus:'failed',workers:f.state().workers.map((w:object)=>({...w,projection:{liveness:{verdict:'exited'}}}))})
  await f.tick()
  expect(f.store.get<any>('orca-assignment','assignment-1').finished).toBe(true)
  expect(f.store.tickets.get(f.ticket.id)!.ended).toBeUndefined()
  expect(f.store.get<any>('notice','recovery:assignment-1').text).toContain('route retry')
  expect(f.state().created).toBe(1)
})

describe('mailbox report refusal', () => {
  it('settles a refused report so a later worker_done is still processed', async () => {
    const f = setup()
    f.executor.start(f.ticket, f.assignment); await f.tick()
    f.update({ dispatchStatus: 'completed', messages: [
      { id: 'foreign-report', type: 'status', subject: 'osa domain report', from_handle: 'old-worker', run_id: 'run-anchor-0',
        body: JSON.stringify({ id: 'foreign', command: ['report', 'waiting'], options: { ticket: f.ticket.id, assignment: f.assignment.id } }) },
      { id: 'done-1', type: 'worker_done', run_id: 'run-anchor-0', from_handle: 'worker-1', body: 'Process done',
        payload: JSON.stringify({ taskId: 'task-1', dispatchId: 'dispatch-1', outcome: 'succeeded' }) }] })
    for (let i = 0; i < 5; i++) await f.tick()
    expect(f.store.get<any>('orca-assignment', 'assignment-1').settled).toBe('done-1')
    expect(f.store.get<any>('notice', 'foreign-report').text).toContain('does not match')
    expect(f.store.list('report-receipt')).toHaveLength(0)
  })
})

describe('cutover execution hold', () => {
  it('preserves queued work and new comments across restart without any native effects', async () => {
    const f = setup(); f.executor.start(f.ticket, f.assignment); await f.tick()
    const ticket = f.store.tickets.get(f.ticket.id)!
    ticket.inputs.push({ id: 'late-hold', kind: 'text', text: 'Keep this', at: new Date().toISOString() }); ticket.undelivered.push('late-hold'); f.store.tickets.save(ticket)
    f.executor.deliver(ticket, ticket.assignments[0]!)
    f.store.put('execution-hold', f.assignment.id, { assignmentId: f.assignment.id, ticketId: ticket.id, reason: 'cutover', at: new Date().toISOString(), capacityReleased: true })
    const job = f.store.get('orca-job', 'deliver:assignment-1:late-hold'), binding = f.store.get('orca-assignment', f.assignment.id), before = f.calls().length
    f.restart(); await f.tick(); await f.tick()
    expect(f.calls()).toHaveLength(before)
    expect(f.store.get('orca-job', 'deliver:assignment-1:late-hold')).toEqual(job)
    expect(f.store.get('orca-assignment', f.assignment.id)).toEqual(binding)
    expect(f.store.tickets.get(ticket.id)!.undelivered).toContain('late-hold')
    expect(f.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  })

  it('releases capacity only for an explicitly proven exited held assignment', async () => {
    const f = setup(false, undefined, 1)
    f.executor.start(f.ticket, f.assignment); await f.tick()
    const other = { ...f.ticket, id: 'other-hold', title: 'Other', execution: { name: 'other-hold', directory: '', assignment: 'Other' }, assignments: [{ id: 'other-assignment', state: 'pending' as const, createdAt: f.ticket.createdAt }] }
    f.store.tickets.save(other)
    f.store.put('execution-hold', f.assignment.id, { assignmentId: f.assignment.id, ticketId: f.ticket.id, reason: 'unknown', at: new Date().toISOString() })
    f.executor.start(other, other.assignments[0]); await f.tick()
    expect(f.state().created).toBe(1)
    f.store.put('execution-hold', f.assignment.id, { assignmentId: f.assignment.id, ticketId: f.ticket.id, reason: 'exited', at: new Date().toISOString(), capacityReleased: true })
    await f.tick()
    expect(f.state().created).toBe(2)
  })

  it('keeps the hold until explicit retry verifies native state and children', async () => {
    const f = setup(); f.executor.start(f.ticket, f.assignment); await f.tick()
    f.store.put('execution-hold', f.assignment.id, { assignmentId: f.assignment.id, ticketId: f.ticket.id, reason: 'cutover', at: new Date().toISOString(), capacityReleased: true })
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('positively failed or stopped')
    expect(f.store.get('execution-hold', f.assignment.id)).toBeDefined()
    f.update({ workerState: 'stopped', dispatchStatus: 'failed', childRuns: [{ id: 'child-run', coordinator_handle: 'worker-1' }], workers: [...f.state().workers, { dispatchId: 'child', runId: 'child-run', terminalState: 'active' }] })
    await expect(f.executor.retryTicket(f.engine, f.ticket.id)).rejects.toThrow('Child worker resources')
    expect(f.store.get('execution-hold', f.assignment.id)).toBeDefined()
    f.update({ workers: f.state().workers.filter((worker: any) => worker.dispatchId !== 'child') })
    await f.executor.retryTicket(f.engine, f.ticket.id)
    expect(f.store.get('execution-hold', f.assignment.id)).toBeUndefined()
    expect(f.state().created).toBe(2)
  })
})
