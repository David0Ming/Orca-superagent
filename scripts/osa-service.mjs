import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, existsSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

const script = fileURLToPath(import.meta.url)
const args = process.argv.slice(2), command = args.shift()
const supervised = args.includes('--supervised')
if (supervised) args.splice(args.indexOf('--supervised'), 1)
const index = args.indexOf('--state')
if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('--state requires a path')
const state = resolve(index < 0 ? '.osa' : args[index + 1])
if (index >= 0) args.splice(index, 2)
mkdirSync(state, { recursive: true, mode: 0o700 }); chmodSync(state, 0o700)
const recordPath = join(state, 'service.json'), log = join(state, 'service.log')
const manualStop = join(state, 'manual-stop')
const read = () => { try { return JSON.parse(readFileSync(recordPath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
const identity = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args='], { encoding: 'utf8' }).trim()
    return value ? createHash('sha256').update(value).digest('hex') : undefined
  } catch { return undefined }
}
const live = record => !!record && typeof record.identity === 'string' && identity(record.pid) === record.identity
const childLive = record => !!record?.childIdentity && identity(record.childPid) === record.childIdentity
const save = record => {
  const temporary = `${recordPath}.${process.pid}`
  writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 })
  renameSync(temporary, recordPath)
}

async function run() {
  const nonce = args.shift()
  // Holding a SQLite write transaction is the OS-released singleton, including after SIGKILL.
  const db = new DatabaseSync(join(state, 'service-lock.db'))
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE') } catch { db.close(); throw new Error('Service launcher already running') }
  const record = { pid: process.pid, nonce, identity: identity(process.pid), state, log, startedAt: new Date().toISOString(), status: 'starting' }
  if (!record.identity) throw new Error('Cannot establish service process identity')
  save(record)
  const child = spawn(process.execPath, ['--experimental-transform-types', resolve(dirname(script), '../bin/osa.ts'), 'serve', '--state', state, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  record.childPid = child.pid
  record.childIdentity = identity(child.pid)
  save(record)
  let stopping = false, ready = false, buffer = ''
  const stop = () => { stopping = true; record.status = 'stopping'; save(record); child.kill('SIGTERM') }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  const fd = openSync(log, 'a', 0o600); chmodSync(log, 0o600)
  const append = chunk => writeFileSync(fd, chunk)
  child.stderr.on('data', append)
  child.stdout.on('data', chunk => {
    append(chunk)
    buffer = (buffer + chunk).slice(-1_000_000)
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) {
      try {
        if (JSON.parse(line).ready === true) { ready = true; record.status = 'running'; save(record) }
      } catch {}
    }
  })
  let failure
  const code = await new Promise(resolve => {
    child.once('error', error => { failure = String(error); resolve(1) })
    child.once('exit', (code, signal) => resolve(code ?? (stopping && signal === 'SIGTERM' ? 0 : 1)))
  })
  record.status = code === 0 && (stopping || ready) ? 'stopped' : 'failed'
  record.exitCode = code; record.stoppedAt = new Date().toISOString()
  if (failure) record.error = failure
  save(record); closeSync(fd); db.close()
  process.exitCode = code
}

try {
  if (command === '_run') await run()
  else if (command === 'status') {
    const record = read()
    const running = live(record), orphaned = !running && childLive(record)
    console.log(JSON.stringify({ ...record, state, log, manualStopped: existsSync(manualStop), running: running || orphaned, status: running ? record.status : orphaned ? 'orphaned' : record?.status === 'failed' ? 'failed' : 'stopped' }))
  } else if (command === 'start') {
    const previous = read()
    if (live(previous)) throw new Error('Service launcher already running')
    if (childLive(previous)) throw new Error('Service child is still running; use stop before restarting')
    if (!supervised) rmSync(manualStop, { force: true })
    const nonce = randomUUID(), fd = openSync(log, 'a', 0o600)
    const child = spawn(process.execPath, [script, '_run', nonce, '--state', state, ...args], { detached: true, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    const deadline = Date.now() + 15_000
    while (true) {
      const record = read()
      if (record?.nonce === nonce && record.status === 'running' && live(record)) { console.log(JSON.stringify(record)); break }
      if (record?.nonce === nonce && record.status === 'failed') throw new Error(`Service failed; inspect ${log}`)
      if (child.exitCode !== null) throw new Error(`Service launcher exited; inspect ${log}`)
      if (Date.now() >= deadline) {
        if (record?.nonce === nonce && record.status === 'starting' && live(record)) { console.log(JSON.stringify(record)); break }
        throw new Error(`Service readiness unconfirmed; inspect ${log} and status before retrying`)
      }
      await sleep(50)
    }
  } else if (command === 'stop') {
    if (!supervised) writeFileSync(manualStop, new Date().toISOString() + '\n', { mode: 0o600 })
    const record = read()
    if (live(record)) {
      // Never signal a stale/reused PID; the full start time and command must still match.
      if (identity(record.pid) !== record.identity) throw new Error('Service identity changed')
      process.kill(record.pid, 'SIGTERM')
      const deadline = Date.now() + 15_000
      while (live(record) && Date.now() < deadline) await sleep(50)
      if (live(record)) throw new Error('Service is still stopping; no forced kill was sent')
    }
    if (childLive(record)) {
      if (identity(record.childPid) !== record.childIdentity) throw new Error('Service child identity changed')
      process.kill(record.childPid, 'SIGTERM')
      const deadline = Date.now() + 15_000
      while (childLive(record) && Date.now() < deadline) await sleep(50)
      if (childLive(record)) throw new Error('Service child is still stopping; no forced kill was sent')
    }
    console.log(JSON.stringify({ state, status: 'stopped' }))
  } else throw new Error('Use start, stop or status [--state PATH] [serve options]')
} catch (error) { console.error(String(error)); process.exitCode = 1 }
