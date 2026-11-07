import { createServer, connect } from 'node:net'
import { mkdirSync, chmodSync, existsSync, unlinkSync, realpathSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Store } from '../src/store.ts'
import { App, type Request, type GitHubConfig } from '../src/app.ts'
import { OrcaExecutor } from '../src/orca.ts'
import { GitHub } from '../src/github.ts'
import { Publisher } from '../src/publish.ts'
import { Feishu } from '../src/feishu.ts'
import { Projects } from '../src/projects.ts'
import { WorkspaceCleanup } from '../src/cleanup.ts'
import { RouterWake } from '../src/router.ts'
import { collectWatchdog } from '../src/watchdog.ts'
import { Windows } from '../src/windows.ts'

const names = ['workspace', 'continue-from', 'fingerprint', 'purpose', 'asked-by', 'answers', 'state', 'repository', 'cli', 'lease', 'ticket', 'assignment', 'token', 'inputs', 'message', 'summary', 'question', 'trigger', 'reason', 'thread', 'id', 'text', 'title', 'scope', 'name', 'note', 'timeout', 'github', 'gh-cli', 'two-layer', 'dispatch', 'publish', 'body', 'feishu-chat', 'lark-cli', 'stall-ms', 'executor-model', 'executor-agent', 'locations', 'search']
names.push('project', 'projects', 'component', 'location', 'host', 'kind', 'repo-id', 'base-branch', 'github-repository', 'github-owner-id', 'github-owner-login', 'priority', 'depends-on', 'resources', 'goal', 'source', 'version', 'terminal', 'max-executors', 'acceptance-ticket', 'next-step', 'evidence', 'session', 'watchdog-events', 'report-to')
const parsed = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' as const }])), allowPositionals: true })
const options = parsed.values as Record<string, string>
const state = resolve(options.state ?? '.osa')
const socketPath = join(state, 'osa.sock')
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

function rpc(request: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    let data = ''
    socket.setTimeout(['pr', 'cleanup'].includes(request.command[0]) || ['route retry', 'owner retry', 'report ready', 'owner windows', 'owner window-link', 'owner window-observe', 'owner window-open'].includes(request.command.join(' ')) ? 180_000 : 15_000, () => socket.destroy(new Error('Service response timed out')))
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('error', reject)
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) {
      socket.end()
      try { const result = JSON.parse(data); result.ok ? resolve(result.result) : reject(new Error(result.error)) } catch (error) { reject(error) }
    } })
    socket.on('end', () => { if (!data) reject(new Error('Service closed without a response')) })
  })
}

async function queueReport(request: Request): Promise<unknown> {
  if (!options['report-to']?.startsWith('run:') || options['report-to'].length === 4 || !options.terminal) throw new Error('Mailbox reports require --report-to run:ID and --terminal WORKER_HANDLE')
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)(options.cli ?? process.env.ORCA_CLI_COMMAND ?? 'orca', [
      'orchestration', 'send', '--to', options['report-to'], '--from', options.terminal, '--type', 'status', '--subject', 'osa domain report',
      '--body', JSON.stringify(request), '--retry-request', request.id, '--json', '--full',
    ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }))
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? ''
    // execFile errors include argv, including the report's capability token.
    if (!stdout.trim()) throw new Error(`Orca report send failed; no confirmed receipt for ${request.id}`)
  }
  const response = JSON.parse(stdout)
  if (!response.ok || !response.result?.message?.id) throw new Error(`Orca report not confirmed: ${response.error?.message ?? 'missing message receipt'}`)
  return { queued: true, reportId: request.id, messageId: response.result.message.id, accepted: false }
}

async function serve() {
  mkdirSync(state, { recursive: true, mode: 0o700 }); chmodSync(state, 0o700)
  // An occupied socket is the singleton lock; only a refused stale socket may be removed.
  if (existsSync(socketPath)) await new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath)
    socket.on('connect', () => { socket.destroy(); reject(new Error('osa is already running')) })
    socket.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') { if (existsSync(socketPath)) unlinkSync(socketPath); resolve() } else reject(error) })
  })
  let app: App
  let executor: OrcaExecutor
  let wake: RouterWake, cleanup: WorkspaceCleanup, windows: Windows
  const publishers = new Map<string, Publisher>()
  const report = async (request: Request) => {
    if (!app.store.get('report-receipt', request.id) && request.command[1] === 'ready') {
      const ticket = app.executorTicket(request.options)
      const authorization = app.store.get<GitHubConfig & {repositories?: GitHubConfig[]}>('publish-authorization', ticket.id)
      for (const target of authorization?.repositories ?? (authorization ? [authorization] : [])) {
        const publisher = publishers.get(target.repository)
        if (!publisher) throw new Error(`Publishing is not configured for ${target.repository}`)
        const location = app.projects.targets(ticket.id).find(location => location.github?.repository === target.repository)
        await publisher.assertPublished(ticket.id, request.options.assignment, location?.locationId)
      }
    }
    return app.acceptReport(request)
  }
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    let data = ''
    socket.setTimeout(5000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', async chunk => {
      data += chunk
      if (data.length > 1_000_000) { socket.destroy(); return }
      if (!data.includes('\n')) return
      socket.removeAllListeners('data')
      socket.setTimeout(180_000)
      try {
        const request: Request = JSON.parse(data)
        let result: unknown
        if (request.command?.[0] === 'owner' && ['windows', 'window-link', 'window-observe', 'window-open'].includes(request.command[1])) {
          if (request.command[1] === 'windows') result = await windows.list(request.options)
          else if (request.command[1] === 'window-link') result = await windows.link(request.options)
          else if (request.command[1] === 'window-observe') result = await windows.observe(request.options)
          else result = await windows.open(request.options)
        } else if (request.command?.[0] === 'cleanup') {
          app.authorizeRouter(request.options)
          if (request.command[1] === 'inspect') result = await cleanup.inspect(request.options.ticket)
          else if (request.command[1] === 'references') result = await cleanup.references(request.options.ticket, request.options.fingerprint, request.options.evidence, () => app.authorizeRouter(request.options))
          else if (request.command[1] === 'remove') result = await cleanup.remove(request.options.ticket, request.options.fingerprint, () => app.authorizeRouter(request.options))
          else if (request.command[1] === 'reset') result = await cleanup.reset(request.options.ticket, request.options.fingerprint, () => app.authorizeRouter(request.options))
          else throw new Error('Use cleanup inspect|references|remove|reset --ticket ID; mutations require the corresponding fingerprint')
        } else if (request.command?.join(' ') === 'project sync') {
          app.authorizeRouter(request.options)
          const results = await Promise.all(['repo', 'project', 'worktree'].map(async kind => {
            const response = JSON.parse((await promisify(execFile)(cli, [kind, 'list', ...(kind === 'worktree' ? ['--limit', '1000'] : []), '--json'], { cwd: repository, timeout: 15_000, maxBuffer: 5_000_000 })).stdout)
            if (!response.ok || !Array.isArray(response.result?.[kind + 's'])) throw new Error('Invalid Orca discovery response')
            return response.result
          }))
          app.authorizeRouter(request.options)
          result = app.projects.importOrca(results[0].repos, results[1].projects, results[2])
        } else if (request.command?.[0] === 'router' && ['bind', 'unbind', 'status'].includes(request.command[1])) {
          if (request.command[1] !== 'status') app.authorizeRouter(request.options)
          if (request.command[1] === 'bind') result = await wake.bind(request.options.terminal, () => app.authorizeRouter(request.options), request.options.session)
          else if (request.command[1] === 'unbind') result = wake.unbind()
          else result = wake.status()
        } else if (['route retry', 'owner retry'].includes(request.command?.join(' '))) {
          const validated = app.handle(request) as { ticketId: string }
          result = await executor.retryTicket(app.engine, validated.ticketId)
        } else if (request.command?.[0] === 'report') result = await report(request)
        else if (request.command?.[0] === 'pr') {
          const ticket = app.executorTicket(request.options), assignment = request.options.assignment
          const targets = app.projects.targets(ticket.id)
          const selected = request.options.location ? targets.find(target => target.locationId === request.options.location) : targets.length === 1 ? targets[0] : undefined
          if (targets.length > 1 && !selected) throw new Error('Select --location for publishing a multi-repository task')
          const publisher = publishers.get(selected?.github?.repository ?? (!targets.length ? app.github?.repository ?? '' : ''))
          if (!publisher || request.command[1] !== 'publish') throw new Error('GitHub publishing is not enabled for this target')
          result = await publisher.publish(app.engine, ticket.id, assignment, request.options.title ?? '', request.options.body ?? '', request.options.location)
        } else result = app.handle(request)
        socket.end(JSON.stringify({ ok: true, result: result ?? null }) + '\n')
      }
      catch (error) { socket.end(JSON.stringify({ ok: false, error: String(error) }) + '\n') }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  chmodSync(socketPath, 0o600)
  const store = new Store(join(state, 'state.db'))
  const codePath = fileURLToPath(new URL('..', import.meta.url)), code = createHash('sha256')
  for (const folder of ['src', 'bin']) for (const file of readdirSync(join(codePath, folder)).filter(file => file.endsWith('.ts')).sort())
    code.update(`${folder}/${file}\0`).update(readFileSync(join(codePath, folder, file)))
  store.put('config', 'runtime', { codeVersion: code.digest('hex'), codePath, loadedAt: new Date().toISOString(), nodeVersion: process.version })
  const repository = realpathSync(resolve(options.repository ?? process.cwd()))
  const previous = store.get<string>('config', 'repository')
  if (previous && realpathSync(previous) !== repository) throw new Error('State directory belongs to a different repository')
  store.put('config', 'repository', repository)
  const cli = options.cli ?? process.env.ORCA_CLI_COMMAND ?? 'orca'
  if (options['two-layer'] && !['true', 'false'].includes(options['two-layer'])) throw new Error('--two-layer must be true or false')
  // Legacy state and --two-layer remain readable; review instructions belong to the task and repository.
  store.put('config', 'two-layer', false)
  const repositories = [...new Set((options.github ?? '').split(',').map(name => name.trim()).filter(Boolean))]
  if (repositories.some(name => !/^[\w.-]+\/[\w.-]+$/.test(name))) throw new Error('Invalid GitHub owner/repository')
  const githubOwner = repositories.length ? await GitHub.discover(options['gh-cli']) : undefined
  const githubConfigs = repositories.map(repository => ({ repository, owner: githubOwner! }))
  const savedGitHub = store.get<GitHubConfig>('config', 'github')
  const savedSources = store.get<GitHubConfig[]>('config', 'github-sources') ?? (savedGitHub ? [savedGitHub] : [])
  if (savedSources.some(saved => !githubConfigs.some(config => JSON.stringify(config) === JSON.stringify(saved)))) throw new Error('Cannot remove or change an existing GitHub repository or owner')
  const githubConfig = savedGitHub ?? githubConfigs[0]
  if (githubConfig) store.put('config', 'github', githubConfig)
  store.put('config', 'github-sources', githubConfigs)
  const feishuConfig = options['feishu-chat'] ? { chatId: options['feishu-chat'], ...await Feishu.discover(options['lark-cli']) } : undefined
  const savedFeishu = store.get('config', 'feishu')
  if (savedFeishu && JSON.stringify(savedFeishu) !== JSON.stringify(feishuConfig)) throw new Error('Feishu chat or identity changed for this state directory')
  const feishu = feishuConfig ? new Feishu(store, { ...feishuConfig, cli: options['lark-cli'] }) : undefined
  if (feishuConfig) store.put('config', 'feishu', feishuConfig)
  for (const config of githubConfigs) publishers.set(config.repository, new Publisher(store, config, options['gh-cli']))
  cleanup = new WorkspaceCleanup(store, cli)
  windows = new Windows(store, cli)
  const projects = new Projects(store)
  if (!store.get('config', 'legacy-target') && store.tickets.list().length) {
    // SQLite snapshot includes the WAL; never copy a live database file alone.
    store.db.exec(`VACUUM INTO '${join(state, 'before-p4-' + Date.now() + '.db').replaceAll("'", "''")}'`)
  }
  projects.ensureLegacy(repository, githubConfig)
  const maxExecutors = Number(options['max-executors'] ?? 2)
  if (!Number.isSafeInteger(maxExecutors) || maxExecutors < 1 || maxExecutors > 16) throw new Error('--max-executors must be an integer from 1 to 16')
  const stallMs = options['stall-ms'] === undefined ? undefined : Number(options['stall-ms'])
  if (stallMs !== undefined && (!Number.isSafeInteger(stallMs) || stallMs < 1000)) throw new Error('--stall-ms must be an integer >= 1000')
  if (options['executor-model'] && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(options['executor-model'])) throw new Error('Invalid executor model ID')
  if (options['executor-agent'] && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options['executor-agent'])) throw new Error('Invalid executor agent')
  store.put('config', 'executor', { agent: options['executor-agent'] ?? 'codex', ...(options['executor-model'] ? {model: options['executor-model']} : {}) })
  const osaCommand = [process.execPath, '--experimental-transform-types', fileURLToPath(import.meta.url), '--state', state].map(quote).join(' ')
  executor = new OrcaExecutor(store, { repository, cli, agent: options['executor-agent'], stallMs, maxExecutors, model: options['executor-model'], osaCommand, report })
  app = new App(store, executor, undefined, githubConfig, feishuConfig, projects, githubConfigs)
  wake = new RouterWake(store, { cli, repository, osaCommand })
  let waking: Promise<void> | undefined
  let stopping = false
  process.on('SIGTERM', () => { stopping = true; server.close() })
  process.on('SIGINT', () => { stopping = true; server.close() })
  console.log(JSON.stringify({ ready: true, state, repository }))
  const adapters: [string, GitHub | Feishu | undefined][] = [...githubConfigs.map(config => ['github:' + config.repository, new GitHub(store, { ...config, cli: options['gh-cli'] })] as [string, GitHub]), ['feishu', feishu]]
  const sources = adapters.flatMap(([name, adapter]) => adapter
    ? [{ name, adapter, nextPoll: 0, pending: undefined as Promise<void> | undefined }] : [])
  while (!stopping) {
    if (options['watchdog-events']) {
      try { collectWatchdog(store, options['watchdog-events']); store.delete('notice','watchdog-import') }
      catch { store.put('notice', 'watchdog-import', {id: 'watchdog-import', text: 'Watchdog event directory unavailable; events have not been discarded'}) }
    }
    if (!waking) waking = wake.tick().catch(error => console.error(String(error))).finally(() => { waking = undefined })
    // Source network delays must not block Orca inbox acknowledgments or supervision.
    for (const source of sources) if (!source.pending && Date.now() >= source.nextPoll) {
      source.nextPoll = Date.now() + 15_000
      source.pending = source.adapter.tick(app.engine)
        .then(() => { store.delete('notice', source.name + '-poll') })
        .catch(error => { store.put('notice', source.name + '-poll', { id: source.name + '-poll', text: String(error) }) })
        .finally(() => { source.pending = undefined })
    }
    try { app.engine.evaluateDue(); executor.pulse(app.engine) }
    catch (error) { console.error(String(error)) }
    if (!stopping) await sleep(500)
  }
  await Promise.all([...sources.map(source => source.pending), waking, executor.drain()])
  store.close()
}

try {
  if (parsed.positionals[0] === 'serve') await serve()
  else {
    const deadline = Date.now() + Number(options.timeout ?? 30_000)
    if (!Number.isFinite(deadline)) throw new Error('Invalid timeout')
    let result: unknown
    do {
      const request = { command: parsed.positionals, options, id: parsed.positionals[0] === 'report' ? options.id ?? randomUUID() : randomUUID() }
      // OSA online: direct, so refusals reach the Executor. Only an unreachable service falls back to the Orca mailbox.
      result = parsed.positionals[0] === 'report' && options['report-to']
        ? await rpc(request).catch(error => ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ? queueReport(request) : Promise.reject(error))
        : await rpc(request)
      const inbox = result as { candidates?: unknown[]; messages?: unknown[]; notices?: unknown[] }
      if (parsed.positionals.join(' ') !== 'router wait' || inbox.candidates?.length || inbox.messages?.length || inbox.notices?.length || Date.now() >= deadline) break
      await sleep(500)
    } while (true)
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) { console.error(String(error)); process.exit(1) }
