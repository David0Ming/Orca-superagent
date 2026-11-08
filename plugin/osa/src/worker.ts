import { connect } from 'node:net'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('osa.open-workbench', async () => {
    const stateDir = await orca.settings.get('stateDir')
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('请先填写 OSA 状态目录。')
    const file = join(stateDir, '工作台.osaworkbench')
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    try { await writeFile(file, '{"kind":"osa-workbench","version":1}\n', { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_')))
    const { stdout } = await promisify(execFile)(process.env.ORCA_CLI_COMMAND || 'orca', ['plugin', 'open', 'local.osa', '--editor', file, '--json'], { env, timeout: 15000 })
    const response = JSON.parse(stdout)
    if (!response.ok) throw new Error(response.error?.message || '无法打开 OSA 工作台')
    return { opened: true, file }
  })
  orca.panels.handle('osa.call', async (input: any) => {
    const stateDir = await orca.settings.get('stateDir')
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('请在 Orca 插件设置中填写 OSA 状态目录的绝对路径。')
    const allowed = ['status', 'request', 'comment', 'project-add', 'repository-add', 'stop', 'retry', 'reevaluate', 'windows', 'window-link', 'window-observe', 'window-open']
    if (!allowed.includes(input.action)) throw new Error('不支持的操作')
    if (input.action !== 'status' && input.stateDir !== resolvePath(stateDir)) throw new Error('状态目录已改变，请刷新并确认连接后再操作。')
    return await new Promise((resolve, reject) => {
      const socket = connect(join(stateDir, 'osa.sock'))
      socket.setEncoding('utf8')
      let data = '', settled = false
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        socket.destroy()
        error ? reject(error) : resolve(value as any)
      }
      socket.setTimeout(['retry', 'windows', 'window-link', 'window-observe', 'window-open'].includes(input.action) ? 115000 : 15000, () => finish(new Error('OSA 服务响应超时，结果未知；请刷新状态后再操作。草稿仍保留。')))
      socket.on('error', error => finish(new Error(`无法连接 OSA 服务：${error.message}`)))
      socket.on('close', () => finish(new Error('OSA 服务未返回结果。')))
      socket.on('connect', () => socket.write(JSON.stringify({ command: ['owner', input.action], options: input.options || {}, id: randomUUID() }) + '\n'))
      socket.on('data', chunk => {
        data += chunk
        if (!data.includes('\n')) return
        try {
          const response = JSON.parse(data.slice(0, data.indexOf('\n')))
          finish(response.ok ? undefined : new Error(response.error), input.action === 'status' && response.ok ? { ...response.result, stateDir: resolvePath(stateDir) } : response.result)
        } catch (error) { finish(error as Error) }
      })
    })
  })
}
