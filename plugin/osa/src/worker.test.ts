import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('sends the owner request through the configured socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-panel-'))
  let received: any
  const server = createServer(socket => socket.on('data', bytes => {
    received = JSON.parse(String(bytes))
    const reply = Buffer.from(JSON.stringify({ ok: true, result: { id: '已接收' } }) + '\n')
    const split = reply.indexOf(Buffer.from('已')) + 1
    socket.write(reply.subarray(0, split))
    setTimeout(() => socket.end(reply.subarray(split)), 10)
  }))
  await new Promise<void>(resolve => server.listen(join(dir, 'osa.sock'), resolve))
  const worker = await mountWorker(main, { host: mockHost({ capabilities: ['settings:own'], settings: { stateDir: dir } }) })
  try {
    assert.deepEqual(await worker.request('osa.call', { action: 'comment', stateDir: dir, options: { ticket: 't', id: 'stable', text: '原话' } }), { id: '已接收' })
    assert.deepEqual(received.command, ['owner', 'comment'])
    assert.deepEqual(received.options, { ticket: 't', id: 'stable', text: '原话' })
    assert.deepEqual(await worker.request('osa.call', { action: 'status' }), { id: '已接收', stateDir: dir })
    await worker.request('osa.call', { action: 'reevaluate', stateDir: dir, options: { trigger: 'panel:original' } })
    assert.deepEqual(received.command, ['owner', 'reevaluate'])
    assert.deepEqual(received.options, { trigger: 'panel:original' })
    await assert.rejects(() => worker.request('osa.call', { action: 'comment', stateDir: '/wrong', options: { ticket: 't' } }), /状态目录已改变/)
  } finally {
    await worker.deactivate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('opens one workbench marker through the public editor command and preserves its file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-open-')), cli = join(dir, 'orca'), log = join(dir, 'args.json')
  writeFileSync(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({ok:true,result:{kind:'editor'}}));\n`, {mode:0o700})
  const previous = process.env.ORCA_CLI_COMMAND
  process.env.ORCA_CLI_COMMAND = cli
  const worker = await mountWorker(main, {host:mockHost({capabilities:['settings:own'],settings:{stateDir:dir}})})
  try {
    const opened = await worker.request('osa.open-workbench', {}) as {opened:boolean;file:string}
    assert.equal(opened.opened, true)
    assert.deepEqual(JSON.parse(readFileSync(log,'utf8')), ['plugin','open','local.osa','--editor',opened.file,'--json'])
    assert.equal(JSON.parse(readFileSync(opened.file,'utf8')).kind,'osa-workbench')
    writeFileSync(opened.file,'preserve existing document')
    await worker.request('osa.open-workbench', {})
    assert.equal(readFileSync(opened.file,'utf8'),'preserve existing document')
  } finally {
    await worker.deactivate()
    if (previous === undefined) delete process.env.ORCA_CLI_COMMAND; else process.env.ORCA_CLI_COMMAND = previous
    rmSync(dir,{recursive:true,force:true})
  }
})
