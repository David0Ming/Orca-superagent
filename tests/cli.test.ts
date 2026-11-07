import { test, expect } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, symlinkSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { connect, createServer } from 'node:net'
import { Store } from '../src/store.ts'

test('CLI socket survives SIGKILL and restart; singleton and lease remain fenced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-cli-'))
  const alias = join(dir, 'repository-link')
  symlinkSync(process.cwd(), alias)
  const args = ['--experimental-transform-types', resolve('bin/osa.ts'), '--state', dir, '--repository', alias]
  const exec = promisify(execFile)
  const call = async (...command: string[]) => JSON.parse((await exec(process.execPath, [...args, ...command])).stdout)
  const start = async () => {
    const child = spawn(process.execPath, [...args, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      child.once('exit', code => reject(new Error(`Service exited ${code}`)))
      child.stdout.on('data', data => { if (String(data).includes('"ready":true')) resolve() })
    })
    return child
  }
  let child = await start()
  try {
    const stored = new Store(join(dir, 'state.db'))
    expect(stored.get('config', 'repository')).toBe(realpathSync(process.cwd()))
    stored.close()
    const lease = (await call('router', 'attach')).token
    await call('intake', '--lease', lease, '--id', 'durable', '--text', 'persist me')
    const idle = new Store(join(dir, 'state.db'))
    idle.put('router', 'lease', { token: lease, expires: Date.now() - 1 })
    idle.close()
    await call('intake', '--lease', lease, '--id', 'after-idle', '--text', 'persist after idle')
    await expect(call('serve')).rejects.toThrow('already running')
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    child = await start()
    const inbox = await call('router', 'wait', '--lease', lease, '--timeout', '0')
    expect(inbox.candidates).toHaveLength(2)
    expect(inbox.candidates.flatMap((candidate: any) => candidate.triggers.map((trigger: any) => trigger.text))).toEqual(expect.arrayContaining(['persist me', 'persist after idle']))
    await expect(call('router', 'attach')).rejects.toThrow('held')
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

test('slow Feishu polling does not block the executor loop; shutdown drains the source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-slow-source-'))
  const polling = join(dir, 'polling'), launched = join(dir, 'launched'), lark = join(dir, 'lark'), orca = join(dir, 'orca')
  const release = join(dir, 'release')
  writeFileSync(lark, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'auth') {
  console.log(JSON.stringify({ verified:true, appId:'cli_test', brand:'feishu', identities:{
    user:{available:true,verified:true,status:'ready',openId:'ou_owner'},
    bot:{available:true,verified:true,status:'ready',openId:'ou_bot'} } }));
} else {
  fs.writeFileSync(${JSON.stringify(polling)}, 'started');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    console.log(JSON.stringify({ok:true,identity:'bot',data:{items:[],messages:[],has_more:false}}));
  }, 25);
}
`, { mode: 0o700 })
  writeFileSync(orca, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'observed');
console.log(JSON.stringify({ok:false,error:{code:'test_boundary',message:'No real worker launched'}}));
`, { mode: 0o700 })
  const args = ['--experimental-transform-types', resolve('bin/osa.ts'), '--state', dir, '--repository', process.cwd(),
    '--lark-cli', lark, '--cli', orca, '--feishu-chat', 'oc_test']
  const exec = promisify(execFile)
  const call = async (...command: string[]) => JSON.parse((await exec(process.execPath, [...args, ...command])).stdout)
  const child = spawn(process.execPath, [...args, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('exit', code => reject(new Error(`Service exited ${code}: ${stderr}`)))
      child.stdout.on('data', data => { if (String(data).includes('"ready":true')) resolve() })
    })
    const until = async (path: string) => {
      const deadline = Date.now() + 10000
      while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      expect(existsSync(path)).toBe(true)
    }
    await until(polling)
    const lease = (await call('router', 'attach')).token
    await call('intake', '--lease', lease, '--id', 'slow-source', '--text', 'Test goal')
    await call('route', 'accept', '--lease', lease, '--trigger', 'slow-source', '--title', 'Test', '--scope', 'No external changes')
    await until(launched)
    expect(existsSync(release)).toBe(false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM')
      writeFileSync(release, 'drain')
      await exited
    }
    rmSync(dir, { recursive: true, force: true })
  }
  expect(stderr).not.toContain('database is not open')
}, 30_000)


test('owner socket reads and submissions preserve Router lease and legacy review state no longer gates startup', async () => {
  const dir=mkdtempSync(join(tmpdir(),'osa-owner-cli-')), stored=new Store(join(dir,'state.db'))
  stored.put('config','two-layer',true); stored.close()
  const args=['--experimental-transform-types',resolve('bin/osa.ts'),'--state',dir,'--repository',process.cwd(),'--executor-agent','claude']
  const execute=promisify(execFile), call=async(...command:string[])=>JSON.parse((await execute(process.execPath,[...args,...command])).stdout)
  const child=spawn(process.execPath,[...args,'serve'],{stdio:['ignore','pipe','pipe']})
  let stderr=''; child.stderr.on('data',data=>{stderr+=data})
  try {
    await new Promise<void>((resolve,reject)=>{ child.once('exit',code=>reject(new Error(`Service exited ${code}: ${stderr}`))); child.stdout.on('data',data=>{if(String(data).includes('"ready":true')) resolve()}) })
    const first=await call('owner','status'), project=first.projects.projects[0].id
    expect(first.configuration.executor).toEqual({agent:'claude'})
    expect(first.configuration.runtime.codeVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(realpathSync(first.configuration.runtime.codePath)).toBe(realpathSync(process.cwd()))
    await call('owner','request','--id','local-message','--project',project,'--text','  Original local request  ')
    const state=new Store(join(dir,'state.db'))
    expect(state.get('router','lease')).toBeUndefined()
    expect(state.get('config','two-layer')).toBe(false)
    state.put('router','lease',{token:'router-token',expires:1}); state.close()
    const second=await call('owner','status')
    expect(await call('router','status')).toMatchObject({binding:null,health:null,attention:null})
    expect(second.candidates).toHaveLength(1)
    expect(second.triggers[0]).toMatchObject({id:'panel:local-message',source:'panel',text:'  Original local request  '})
    expect(second.tickets).toEqual([])
    const check=new Store(join(dir,'state.db')); expect(check.get('router','lease')).toEqual({token:'router-token',expires:1}); check.close()
    const original = '中文要求：保留原话🙂'
    const packet = Buffer.from(JSON.stringify({id:'split-request',command:['owner','request'],options:{id:'split-utf8',project,text:original}}) + '\n')
    const cut = packet.indexOf(Buffer.from('中文')) + 1
    await new Promise<void>((resolve, reject) => {
      const socket = connect(join(dir,'osa.sock'))
      socket.on('error', reject)
      socket.on('connect', () => { socket.write(packet.subarray(0,cut)); setTimeout(() => socket.end(packet.subarray(cut)), 20) })
      socket.on('data', data => { expect(JSON.parse(String(data)).ok).toBe(true) })
      socket.on('close', resolve)
    })
    expect((await call('owner','status')).triggers.find((trigger:any)=>trigger.id==='panel:split-utf8').text).toBe(original)
    await expect(call('owner','unknown')).rejects.toThrow('Unknown owner action')
  } finally {
    if(child.exitCode===null && child.signalCode===null) {const exited=once(child,'exit');child.kill('SIGTERM');await exited}
    rmSync(dir,{recursive:true,force:true})
  }
},15000)

test('CLI preserves UTF-8 responses split inside a multibyte character', async () => {
  const dir = mkdtempSync(join(tmpdir(),'osa-utf8-')), original = '中文回复🙂不能变'
  const response = Buffer.from(JSON.stringify({ok:true,result:{text:original}}) + '\n')
  const cut = response.indexOf(Buffer.from('🙂')) + 2
  const server = createServer(socket => socket.once('data', () => {
    socket.write(response.subarray(0,cut)); setTimeout(() => socket.end(response.subarray(cut)), 20)
  }))
  await new Promise<void>(resolve => server.listen(join(dir,'osa.sock'),resolve))
  try {
    const {stdout} = await promisify(execFile)(process.execPath,['--experimental-transform-types',resolve('bin/osa.ts'),'--state',dir,'owner','status'])
    expect(JSON.parse(stdout).text).toBe(original)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir,{recursive:true,force:true}) }
})
