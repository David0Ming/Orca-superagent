import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, renameSync, statfsSync, rmSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

const script = fileURLToPath(import.meta.url)
const launcher = join(dirname(script), 'osa-service.mjs')
const label = 'com.orca-super-agent.osa'
const minFreeBytes = 512 * 1024 * 1024
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => {
  const temporary = `${path}.${process.pid}`
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
}

export function configAt(path, previous) {
  const config = read(path)
  for (const key of ['state', 'runtimeFile', 'orcaExecutable']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`${key} must be an absolute path`)
  }
  if (!Array.isArray(config.serveArgs) || config.serveArgs.length % 2
    || config.serveArgs.some((value, index) => typeof value !== 'string' || !value || (index % 2 === 0 ? !/^--[a-z-]+$/.test(value) || value === '--state' : value.startsWith('--')))) {
    throw new Error('serveArgs must contain option/value pairs, without --state')
  }
  const repository = config.serveArgs.indexOf('--repository')
  if (repository < 0 || !isAbsolute(config.serveArgs[repository + 1])) throw new Error('serveArgs requires an absolute --repository')
  if (previous && ['state', 'runtimeFile', 'orcaExecutable'].some(key => config[key] !== previous[key])) throw new Error('Supervisor identity paths changed; restart the supervisor with its intended config')
  return config
}

export function orcaRuntime(config) {
  let runtime
  try { runtime = read(config.runtimeFile) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 1 || typeof runtime.runtimeId !== 'string'
    || !runtime.runtimeId || !Number.isFinite(runtime.startedAt)) throw new Error('Invalid Orca runtime identity')
  let command, started
  try {
    command = execFileSync('/bin/ps', ['-ww', '-p', String(runtime.pid), '-o', 'comm='], { encoding: 'utf8' }).trim()
    started = Date.parse(execFileSync('/bin/ps', ['-p', String(runtime.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim())
  } catch { return null }
  // Reject a reused PID, even if a newer process runs the same executable.
  if (command !== config.orcaExecutable || !Number.isFinite(started) || started > runtime.startedAt) return null
  return runtime.runtimeId
}

export function retryDelay(failures) { return Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5)) }

export async function supervise(config, configPath) {
  mkdirSync(config.state, { recursive: true, mode: 0o700 })
  const lock = new DatabaseSync(join(config.state, 'supervisor-lock.db'))
  lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
  const statusPath = join(config.state, 'supervisor.json')
  const service = command => JSON.parse(execFileSync(process.execPath, [launcher, command, '--state', config.state,
    ...(command === 'status' ? [] : ['--supervised']),
    ...(command === 'start' ? (configPath ? configAt(configPath, config) : config).serveArgs : [])], { encoding: 'utf8', timeout: command === 'stop' ? 40_000 : 25_000, stdio: ['ignore', 'pipe', 'pipe'] }))
  let stopping = false, lastReport, epoch, failures = 0, nextAttemptAt = 0, stableSince = 0, wasRunning = false
  process.on('SIGTERM', () => { stopping = true })
  process.on('SIGINT', () => { stopping = true })
  const report = (status, reason = '') => {
    const value = { pid: process.pid, status, reason, failures, nextAttemptAt, runtimeId: epoch ?? null }
    const fingerprint = JSON.stringify(value)
    if (fingerprint === lastReport) return
    const record = { ...value, at: new Date().toISOString() }
    console.log(JSON.stringify(record))
    save(statusPath, record)
    lastReport = fingerprint
  }
  try {
    while (!stopping) {
      try {
        const runtime = orcaRuntime(config)
        const current = service('status')
        if (current.manualStopped) {
          if (current.running) service('stop')
          wasRunning = false; stableSince = 0; failures = 0; nextAttemptAt = 0
          report('paused-owner', 'OSA was stopped by its owner; start it explicitly to resume')
        } else if (!runtime || (epoch && runtime !== epoch)) {
          if (current.running) service('stop')
          epoch = runtime; wasRunning = false; stableSince = 0
          report('waiting-orca', 'Orca is stopped or its runtime changed')
        } else {
          epoch = runtime
          const disk = statfsSync(config.state)
          if (Number(disk.bavail) * Number(disk.bsize) < minFreeBytes) {
            if (current.running) service('stop')
            wasRunning = false; stableSince = 0
            report('low-disk', 'Less than 512 MiB available; service paused until space recovers')
          } else if (current.running && current.status === 'starting' && Date.now() - Date.parse(current.startedAt) < 150_000) {
            report('starting', 'Waiting for source identity initialization')
          } else if (current.running && current.status === 'running') {
            wasRunning = true
            stableSince ||= Date.now()
            if (Date.now() - stableSince >= 60_000) { failures = 0; nextAttemptAt = 0 }
            report('running')
          } else {
            stableSince = 0
            if (wasRunning) {
              wasRunning = false
              nextAttemptAt = Date.now() + retryDelay(++failures)
            }
            if (Date.now() >= nextAttemptAt) {
              // Reuse exact-PID stop and the existing singleton; never overlap an orphan child.
              if (current.running) service('stop')
              const result = service('start')
              if (!['starting', 'running'].includes(result.status)) throw new Error('Service readiness unconfirmed')
              wasRunning = result.status === 'running'; stableSince = wasRunning ? Date.now() : 0
              report(result.status)
            } else report('retrying', 'Service exited; restart is delayed')
          }
        }
      } catch (error) {
        wasRunning = false; stableSince = 0
        nextAttemptAt = Date.now() + retryDelay(++failures)
        // An unreadable runtime or uncertain readiness must not leave admission running unchecked.
        let reason = String(error)
        try { service('stop') } catch (stopError) { reason += `; stop unconfirmed: ${String(stopError)}` }
        try { report('error', reason) } catch (reportError) { console.error(String(reportError)) }
      }
      // Short slices allow launchd bootout to reach the launcher's graceful stop promptly.
      for (let n = 0; n < 10 && !stopping; n++) await sleep(500)
    }
  } finally {
    try { service('stop'); report('stopped', 'Supervisor stopped') } finally { lock.close() }
  }
}

export function launchAgent(configPath, logDirectory) {
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[process.execPath, script, 'run', '--config', configPath].map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(resolve(dirname(script), '..'))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>45</integer>
<key>StandardOutPath</key><string>${xml(join(logDirectory, 'supervisor.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDirectory, 'supervisor.err.log'))}</string>
</dict></plist>\n`
}

async function main() {
  const [command, flag, input, ...extra] = process.argv.slice(2)
  if (!['install', 'uninstall', 'run'].includes(command) || flag !== '--config' || !input || extra.length) throw new Error('Use install, uninstall or run --config /absolute/config.json')
  const configPath = resolve(input), config = configAt(configPath)
  if (command === 'run') return supervise(config, configPath)
  if (process.platform !== 'darwin') throw new Error('LaunchAgent installation requires macOS')
  const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`
  const agents = join(homedir(), 'Library/LaunchAgents'), plist = join(agents, label + '.plist')
  const launchctl = args => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (command === 'uninstall') {
    let loaded = false
    try { launchctl(['print', target]); loaded = true } catch {}
    if (loaded) launchctl(['bootout', target])
    execFileSync(process.execPath, [launcher, 'stop', '--state', config.state], { stdio: 'inherit' })
    rmSync(plist, { force: true })
    console.log('Supervisor uninstalled; state and logs preserved')
    return
  }
  let installed = false
  try { readFileSync(plist); installed = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (installed) throw new Error('LaunchAgent already installed; uninstall it with its original config before replacing it')
  mkdirSync(agents, { recursive: true })
  mkdirSync(config.state, { recursive: true, mode: 0o700 })
  writeFileSync(plist, launchAgent(configPath, config.state), { mode: 0o600, flag: 'wx' })
  execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'inherit' })
  rmSync(join(config.state, 'manual-stop'), { force: true })
  launchctl(['bootstrap', domain, plist])
  console.log(JSON.stringify({ installed: target, config: configPath, status: join(config.state, 'supervisor.json') }))
}

if (process.argv[1] && realpathSync(process.argv[1]) === script) main().catch(error => { console.error(String(error)); process.exitCode = 1 })
