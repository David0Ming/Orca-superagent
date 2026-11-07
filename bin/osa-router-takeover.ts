// Turn the current Orca chat into the only OSA Router: take the lease, create its sender anchor, bind it, retire the old binding.
// Run inside the new chat: npm run router:takeover
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const { values } = parseArgs({ options: { state: { type: 'string' }, repository: { type: 'string' }, session: { type: 'string' }, title: { type: 'string' } } })
const repository = resolve(values.repository ?? process.cwd())
const state = resolve(values.state ?? resolve(repository, '.osa/p4-live'))
const session = values.session ?? process.env.ORCA_AGENT_SESSION_ID
if (!session) throw new Error('Run this inside an Orca structured chat (ORCA_AGENT_SESSION_ID is missing)')
const orca = process.env.ORCA_CLI_COMMAND ?? 'orca'
const osa = async (...args: string[]) => JSON.parse((await run(process.execPath,
  ['--experimental-transform-types', fileURLToPath(new URL('./osa.ts', import.meta.url)), '--state', state, ...args],
  { cwd: repository, encoding: 'utf8' })).stdout)
const orcaJson = async (...args: string[]) => JSON.parse((await run(orca, [...args, '--json'], { cwd: repository, encoding: 'utf8' })).stdout)

// A live lease is the only thing standing between us and a takeover; it expires within 60 seconds of the old Router's last command.
let before: { token: string; expires: number }
try { before = await osa('router', 'attach') as { token: string; expires: number } }
catch (error) {
  if (!String(error).includes('lease is held')) throw error
  console.error('Another Router still holds the lease; waiting for it to expire...')
  await sleep(65_000)
  before = await osa('router', 'attach') as { token: string; expires: number }
}
const terminal = (await orcaJson('terminal', 'create', '--worktree', `path:${repository}`, '--title', values.title ?? 'OSA Router sender')).result.terminal
const binding = await osa('router', 'bind', '--terminal', terminal.handle, '--session', session, '--lease', before.token)
const status = await osa('router', 'status', '--lease', before.token)
console.log(JSON.stringify({ session, binding, status }, null, 2))
console.log(`\nThis chat is now the Router. Run: npm run osa -- --state ${state} router wait --lease ${before.token}`)
