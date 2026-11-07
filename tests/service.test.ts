import { afterEach, expect, test } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const execute = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture(fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'osa-service-')), state = join(dir, 'private state')
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'bin'))
  const script = join(dir, 'scripts/osa-service.mjs')
  copyFileSync(resolve('scripts/osa-service.mjs'), script)
  copyFileSync(resolve('scripts/osa-supervisor.mjs'), join(dir, 'scripts/osa-supervisor.mjs'))
  writeFileSync(join(dir, 'bin/osa.ts'), fail ? `console.error('fake startup failed'); process.exit(1)` : `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ready:true}));
const timer=setInterval(()=>{},1000);
process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});
`)
  const call = async (command: string, ...args: string[]) => JSON.parse((await execute(process.execPath, [script, command, '--state', state, ...args], { timeout: 20_000 })).stdout)
  cleanups.push(async () => { await call('stop').catch(() => {}); rmSync(dir, { recursive: true, force: true }) })
  return { dir, state, call }
}

test('local launcher starts once, forwards options, records logs and stops without remote or terminal actions', async () => {
  const f = fixture()
  const [a, b] = await Promise.allSettled([f.call('start', '--repository', f.dir), f.call('start', '--repository', f.dir)])
  expect([a, b].filter(r => r.status === 'fulfilled')).toHaveLength(1)
  const status = await f.call('status')
  expect(status.running).toBe(true)
  expect(status.status).toBe('running')
  expect(JSON.parse(readFileSync(join(f.dir, 'args.json'), 'utf8'))).toEqual(['serve', '--state', f.state, '--repository', f.dir])
  expect(readFileSync(status.log, 'utf8')).toContain('"ready":true')
  await expect(f.call('start')).rejects.toThrow()
  await f.call('stop')
  expect((await f.call('status')).running).toBe(false)
  expect((await f.call('status')).manualStopped).toBe(true)
  await f.call('start')
  expect((await f.call('status')).manualStopped).toBe(false)
  await f.call('stop')
}, 30_000)

test('stale PID never signals an unrelated live process and can restart', async () => {
  const f = fixture()
  await f.call('status')
  writeFileSync(join(f.state, 'service.json'), JSON.stringify({ pid: process.pid, identity: 'previous process', status: 'running' }))
  expect((await f.call('status')).running).toBe(false)
  await f.call('stop')
  await f.call('start')
  await f.call('stop')
}, 30_000)

test('startup failure is visible and leaves no claimed running daemon', async () => {
  const f = fixture(true)
  await expect(f.call('start')).rejects.toThrow()
  expect((await f.call('status')).running).toBe(false)
  expect(readFileSync(join(f.state, 'service.log'), 'utf8')).toContain('fake startup failed')
})

test('lost launcher preserves a live child, refuses overlap and stops only that exact child', async () => {
  const f = fixture()
  const record = await f.call('start')
  process.kill(record.pid, 'SIGKILL')
  const status = await f.call('status')
  expect(status.status).toBe('orphaned')
  expect(status.running).toBe(true)
  await expect(f.call('start')).rejects.toThrow('child is still running')
  await f.call('stop')
  expect((await f.call('status')).running).toBe(false)
  await f.call('start')
}, 30_000)

async function eventually(check: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Condition did not become true')
}

test.skipIf(process.platform !== 'darwin')('supervisor follows Orca, delays crash recovery, preserves singleton and stops cleanly', async () => {
  const f = fixture(), runtimeFile = join(f.dir, 'runtime.json'), configFile = join(f.dir, 'config.json')
  const config = { state: f.state, runtimeFile, orcaExecutable: process.execPath, serveArgs: ['--repository', f.dir] }
  writeFileSync(configFile, JSON.stringify(config))
  const lowDisk = join(f.dir, 'low-disk'), preload = join(f.dir, 'disk-fixture.mjs')
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.statfsSync; fs.statfsSync=(...args)=>{const result=original(...args); if(fs.existsSync(${JSON.stringify(lowDisk)})) result.bavail=0; return result}; syncBuiltinESMExports();`)
  const supervisor = spawn(process.execPath, ['--import', preload, join(f.dir, 'scripts/osa-supervisor.mjs'), 'run', '--config', configFile], { stdio: 'ignore' })
  let orca: ReturnType<typeof spawn> | undefined
  cleanups.unshift(async () => {
    supervisor.kill('SIGTERM'); orca?.kill('SIGTERM')
    await eventually(async () => supervisor.exitCode !== null || supervisor.signalCode !== null)
  })
  const supervisorStatus = () => JSON.parse(readFileSync(join(f.state, 'supervisor.json'), 'utf8'))
  await eventually(async () => supervisorStatus().status === 'waiting-orca')
  expect((await f.call('status')).running).toBe(false)
  await expect(execute(process.execPath, [join(f.dir, 'scripts/osa-supervisor.mjs'), 'run', '--config', configFile])).rejects.toThrow()
  const startOrca = async (runtimeId: string) => {
    orca = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { orca!.once('spawn', resolve); orca!.once('error', reject) })
    writeFileSync(runtimeFile, JSON.stringify({ pid: orca.pid, runtimeId, startedAt: Date.now() }))
  }
  await startOrca('first-runtime')
  await eventually(async () => (await f.call('status')).running)
  const first = await f.call('status')
  writeFileSync(configFile, JSON.stringify({...config,serveArgs:[...config.serveArgs,'--max-executors','6']}))
  process.kill(first.childPid, 'SIGKILL')
  await eventually(async () => supervisorStatus().status === 'retrying')
  expect((await f.call('status')).running).toBe(false)
  expect(supervisorStatus().failures).toBe(1)
  await eventually(async () => (await f.call('status')).running, 25_000)
  expect((await f.call('status')).pid).not.toBe(first.pid)
  expect(JSON.parse(readFileSync(join(f.dir,'args.json'),'utf8'))).toEqual(expect.arrayContaining(['--max-executors','6']))
  await f.call('stop')
  await eventually(async () => supervisorStatus().status === 'paused-owner')
  await new Promise(resolve => setTimeout(resolve, 5500))
  expect((await f.call('status')).running).toBe(false)
  expect((await f.call('status')).manualStopped).toBe(true)
  await f.call('start', '--repository', f.dir)
  await eventually(async () => supervisorStatus().status === 'running')
  writeFileSync(lowDisk, '')
  await eventually(async () => supervisorStatus().status === 'low-disk')
  expect((await f.call('status')).running).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 5500))
  expect((await f.call('status')).running).toBe(false)
  rmSync(lowDisk)
  await eventually(async () => (await f.call('status')).running)
  orca!.kill('SIGTERM')
  await eventually(async () => supervisorStatus().status === 'waiting-orca' && !(await f.call('status')).running)
  // Stale runtime PID points at a new process: it must not authorize a start.
  await startOrca('second-runtime')
  const realRuntime = readFileSync(runtimeFile, 'utf8')
  writeFileSync(runtimeFile, JSON.stringify({ pid: orca!.pid, runtimeId: 'stale', startedAt: 1 }))
  await new Promise(resolve => setTimeout(resolve, 5500))
  expect((await f.call('status')).running).toBe(false)
  writeFileSync(runtimeFile, realRuntime)
  await eventually(async () => (await f.call('status')).running)
  writeFileSync(runtimeFile, '{')
  await eventually(async () => supervisorStatus().status === 'error')
  expect((await f.call('status')).running).toBe(false)
  expect(supervisorStatus().failures).toBe(1)
  writeFileSync(runtimeFile, realRuntime)
  await eventually(async () => (await f.call('status')).running, 40_000)
  supervisor.kill('SIGTERM')
  await eventually(async () => supervisor.exitCode === 0)
  expect((await f.call('status')).running).toBe(false)
}, 120_000)

test('slow initialization stays starting and can become ready after the launcher observation window', async () => {
  const f = fixture()
  writeFileSync(join(f.dir,'bin/osa.ts'), `
const timer=setInterval(()=>{},1000)
const ready=setTimeout(()=>console.log(JSON.stringify({ready:true})),16000)
process.on('SIGTERM',()=>{clearTimeout(ready);clearInterval(timer);process.exit(0)})
`)
  const first = await f.call('start')
  expect(first.status).toBe('starting')
  await eventually(async () => (await f.call('status')).status === 'running', 5000)
}, 25000)
