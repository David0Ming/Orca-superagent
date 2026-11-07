import { connect } from 'node:net'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'

export default function activate(orca: OrcaWorkerApi): void {
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
