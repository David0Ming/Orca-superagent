import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { sessionRpc } from '../src/orca-session.ts'

test('structured observation authenticates locally, frames replies and rejects a changed runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(),'osa-session-')), endpoint = join(dir,'rpc.sock')
  let runtimeId = 'same'
  const server = createServer(socket => socket.once('data', bytes => {
    const request = JSON.parse(bytes.toString())
    expect(request.authToken).toBe('private')
    socket.write(JSON.stringify({id:'unrelated',ok:true})+'\n')
    socket.end(JSON.stringify({id:request.id,ok:true,result:{sessionId:'test'},_meta:{runtimeId}})+'\n')
  }))
  try {
    await new Promise<void>(resolve => server.listen(endpoint,resolve))
    writeFileSync(join(dir,'orca-runtime.json'),JSON.stringify({runtimeId:'same',authToken:'private',transports:[{kind:'unix',endpoint}]}))
    expect((await sessionRpc('agentSession.history',{sessionId:'test'},dir)).result.sessionId).toBe('test')
    runtimeId='new'
    await expect(sessionRpc('agentSession.history',{sessionId:'test'},dir)).rejects.toThrow('runtime changed')
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(dir,{recursive:true,force:true}) }
})
