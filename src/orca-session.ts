import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export function sessionMutation(method: string, sessionId: string, fields: Record<string, unknown>, fence: number | null = null) {
  const canonical = (value: any): string => value === null || typeof value !== 'object' ? JSON.stringify(value ?? null)
    : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return {envelope: {sessionId, clientOperationId: Date.now() + '-' + randomUUID().replaceAll('-',''), expectedRuntimeFence: fence,
    payloadFingerprint: createHash('sha256').update(canonical({method, sessionId, fields})).digest('hex')}, ...fields}
}

/** Orca exposes structured chat identity through RPC, not the terminal CLI. */
export async function sessionRpc(method: string, params: unknown, profile = process.env.ORCA_USER_DATA_PATH ?? join(
  process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA! : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'orca')): Promise<any> {
  const metadata = JSON.parse(readFileSync(join(profile, 'orca-runtime.json'), 'utf8'))
  const transport = (metadata.transports ?? [metadata.transport]).find((t: any) => t && ['unix', 'named-pipe'].includes(t.kind))
  if (!transport?.endpoint || !metadata.authToken || !metadata.runtimeId) throw new Error('Orca local runtime is unavailable')
  return new Promise((resolve, reject) => {
    const id = randomUUID(), socket = connect(transport.endpoint)
    socket.setEncoding('utf8')
    let buffer = '', settled = false
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value) }
    socket.setTimeout(15_000, () => finish(new Error('Orca session RPC timed out; preserve pending work')))
    socket.on('error', () => finish(new Error('Orca session RPC connection failed')))
    socket.on('close', () => finish(new Error('Orca session RPC closed without a response')))
    socket.on('connect', () => socket.write(JSON.stringify({ id, authToken: metadata.authToken, method, params }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 8_000_000) return finish(new Error('Orca session response exceeds limit'))
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        try {
          const response = JSON.parse(line)
          if (response.id !== id) continue
          if (response._meta?.runtimeId !== metadata.runtimeId) return finish(new Error('Orca runtime changed during session observation'))
          if (!response.ok) return finish(new Error(`Orca session RPC refused: ${response.error?.code ?? 'unknown'}`))
          return finish(undefined, response)
        } catch { return finish(new Error('Invalid Orca session response')) }
      }
    })
  })
}
