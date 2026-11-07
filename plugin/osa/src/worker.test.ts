import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
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
