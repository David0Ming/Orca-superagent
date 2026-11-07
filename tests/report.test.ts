import { expect, test } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { App } from '../src/app.ts'
import { Store } from '../src/store.ts'

test.each(['before-domain', 'after-domain', 'after-ack'])('offline report survives consumer SIGKILL %s', point => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-report-'))
  const database = join(dir, 'state.db'), mailbox = join(dir, 'mailbox.json'), cli = join(dir, 'orca'), consumer = join(dir, 'consumer.mts')
  let store = new Store(database)
  try {
    const app = new App(store, { start() {}, deliver() {}, stop() {} }, 'owner')
    const call = (command: string[], options: Record<string, string> = {}) => app.handle({ command, options, id: 'setup' }) as any
    const lease = call(['router', 'attach']).token
    call(['intake'], { id: 'owner-input', text: 'Produce a result', lease })
    const { ticketId } = call(['route', 'accept'], { trigger: 'owner-input', title: 'Result', scope: 'Produce a result', lease })
    const assignment = store.tickets.get(ticketId)!.assignments[0].id
    store.put('capability', assignment, { token: 'fixture-token' })
    app.engine.assignmentStarted(ticketId, assignment)
    call(['read'], { ticket: ticketId, assignment, token: 'fixture-token' })
    store.put('orca-assignment', assignment, { id: assignment, ticketId, runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1', terminal: 'worker-1', anchor: 'anchor-1', generation: 0, poll: 0 })
    store.close()
    writeFileSync(mailbox, JSON.stringify({ messages: [], requests: {} }))
    writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'), {DatabaseSync} = require('node:sqlite');
const path = ${JSON.stringify(mailbox)}, s = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2), flag = key => args[args.indexOf('--' + key) + 1];
let result;
if (args[1] === 'send') {
  const id = flag('retry-request');
  if (!s.requests[id]) {
    s.messages.push({id:'message-1',type:'status',subject:flag('subject'),body:flag('body'),from_handle:flag('from'),run_id:'run-1'});
    s.requests[id] = {message:{id:'message-1'}};
  }
  result = s.requests[id];
} else if (args[1] === 'show') result = {terminal:{handle:'anchor-1'}};
else if (args[1] === 'check') {
  if (args.includes('--ack')) {
    const db = new DatabaseSync(${JSON.stringify(database)}, {readOnly:true});
    s.receiptsAtAck = db.prepare("SELECT count(*) AS n FROM records WHERE kind='report-receipt'").get().n;
    db.close();
    if (s.receiptsAtAck !== 1) throw Error('ack before domain receipt');
    s.messages = [];
  }
  result = {messages:s.messages,deliveryId:s.messages.length ? 'delivery-1' : null};
} else if (args[1] === 'worker-show') result = {dispatch:{id:'dispatch-1',taskId:'task-1',runId:'run-1',status:'dispatched'},worker:{state:'ready'}};
else throw Error('Unexpected command ' + args.join(' '));
fs.writeFileSync(path, JSON.stringify(s));
console.log(JSON.stringify({ok:true,result}));
`, { mode: 0o700 })
    const args = ['--experimental-transform-types', resolve('bin/osa.ts'), '--state', dir, '--cli', cli,
      'report', 'ready', '--ticket', ticketId, '--assignment', assignment, '--token', 'fixture-token', '--summary', 'Result checked', '--id', 'report-1']
    // No OSA socket exists. This was the original lost-report failure.
    expect(spawnSync(process.execPath, args).status).toBe(1)
    const unavailable = [...args]
    unavailable[unavailable.indexOf('--cli') + 1] = join(dir, 'missing-cli')
    const failed = spawnSync(process.execPath, [...unavailable, '--report-to', 'run:run-1', '--terminal', 'worker-1'], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('no confirmed receipt')
    expect(failed.stderr).not.toContain('fixture-token')
    const queued = () => JSON.parse(execFileSync(process.execPath, [...args, '--report-to', 'run:run-1', '--terminal', 'worker-1'], { encoding: 'utf8' }))
    expect(queued()).toMatchObject({ queued: true, accepted: false, reportId: 'report-1' })
    queued()
    expect(JSON.parse(readFileSync(mailbox, 'utf8')).messages).toHaveLength(1)
    writeFileSync(consumer, `
import {Store} from ${JSON.stringify(resolve('src/store.ts'))};
import {App} from ${JSON.stringify(resolve('src/app.ts'))};
import {OrcaExecutor} from ${JSON.stringify(resolve('src/orca.ts'))};
const store = new Store(${JSON.stringify(database)});
const point = process.argv[2];
let app;
const executor = new OrcaExecutor(store, {repository:${JSON.stringify(dir)},cli:${JSON.stringify(cli)},osaCommand:'unused',report:async request => {
  if (point === 'before-domain') process.kill(process.pid, 'SIGKILL');
  const result = app.acceptReport(request);
  if (point === 'after-domain') process.kill(process.pid, 'SIGKILL');
  return result;
}});
app = new App(store, executor, 'owner');
const binding = store.get('orca-assignment', ${JSON.stringify(assignment)});
delete binding.nextPollAt; delete binding.nextObservationAt;
store.put('orca-assignment', binding.id, binding);
await executor.tick(app.engine);
if (point === 'after-ack') process.kill(process.pid, 'SIGKILL');
store.close();
`)
    const crashed = spawnSync(process.execPath, ['--experimental-transform-types', consumer, point], { encoding: 'utf8' })
    expect(crashed.signal, crashed.stderr).toBe('SIGKILL')
    const resumed = spawnSync(process.execPath, ['--experimental-transform-types', consumer, 'resume'], { encoding: 'utf8' })
    expect(resumed.status, resumed.stderr).toBe(0)
    store = new Store(database)
    expect(store.list('report-receipt')).toHaveLength(1)
    expect(store.list('outbox')).toHaveLength(1)
    expect(store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
    expect(JSON.parse(readFileSync(mailbox, 'utf8'))).toMatchObject({ messages: [], receiptsAtAck: 1 })
  } finally {
    if (store.db.isOpen) store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)
