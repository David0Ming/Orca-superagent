import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('refresh and failed submit preserve draft and retry identity', async () => {
  const submissions: any[] = []
  const status = { stateDir: '/state', tickets: [], projects: { projects: [{ id: 'p', name: '示例工程' }], components: [], locations: [], tasks: [] }, candidates: [] }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], requests: { 'osa.call': ({ action, options }: any) => {
    if (action === 'status') return status
    submissions.push(options)
    if (submissions.length === 1) throw new Error('offline')
    return { id: options.id }
  } } })
  const view = await mount(panel, { host })
  await view.press({ text: '示例工程' })
  await view.type({ label: '你的要求' }, '保留原话')
  await view.press({ text: '刷新' })
  assert.equal(view.valueOf({ label: '你的要求' }), '保留原话')
  await view.press({ text: '提交请求' })
  assert.equal(view.valueOf({ label: '你的要求' }), '保留原话')
  await view.press({ text: '提交请求' })
  assert.equal(submissions[0].id, submissions[1].id)
  assert.equal(submissions[1].text, '保留原话')
  assert.equal(view.valueOf({ label: '你的要求' }), '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('opens a project task from its table', async () => {
  const ticket = { id: 't', title: '修复问题', assignments: [], inputs: [], origin: { triggerIds: [] }, undelivered: [], mandate: { scope: '请修复' } }
  const status = { stateDir: '/state', tickets: [ticket], projects: { projects: [{ id: 'p', name: '示例工程' }], components: [], locations: [], tasks: [{ ticket, context: { target: { projectId: 'p' } } }] }, triggers: [], candidates: [] }
  const host = mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': () => status } })
  const view = await mount(panel, { host })
  try {
    await view.press({ text: '示例工程' })
    assert.deepEqual(view.rowsOf({ label: '项目任务' }), ['t'])
    await view.activateRow({ label: '项目任务' }, 't')
    assert.ok(view.find({ text: '修复问题' }))
    assert.ok(view.find({ label: '补充或回答' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally { await view.unmount() }
})

test('links and opens the selected observed window', async () => {
  const ticket = { id: 't', title: '窗口任务', assignments: [], inputs: [], origin: { triggerIds: [] }, undelivered: [], mandate: { scope: '工作' } }
  const calls: any[] = []
  const status = { stateDir: '/state', tickets: [ticket], projects: { projects: [{ id: 'p', name: '窗口项目' }], components: [], locations: [], tasks: [{ ticket, context: { target: { projectId: 'p' } } }] }, triggers: [], candidates: [], windowLinks: [{ ticketId: 't', sessionId: 's', title: '会话', linkedAt: 'today' }] }
  const host = mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': ({ action, options }: any) => {
    calls.push({ action, options })
    if (action === 'windows') return { windows: [{ sessionId: 's', title: '会话', workspace: '路径' }], errors: [] }
    if (action === 'window-open') return { navigated: false, reason: '当前接口无法导航' }
    return status
  } } })
  const view = await mount(panel, { host })
  try {
    await view.press({ text: '窗口项目' })
    await view.activateRow({ label: '项目任务' }, 't')
    await view.toggle({ label: '执行窗口' })
    await view.press({ text: '查找此任务所在项目的窗口' })
    await view.press({ text: '关联' })
    assert.deepEqual(calls.find(c => c.action === 'window-link').options, { ticket: 't', session: 's' })
    assert.ok(view.find({ text: '已关联窗口' }))
    assert.equal(calls.filter(c => c.action === 'status').length, 2)
    await view.press({ text: '打开窗口' })
    assert.ok(view.find({ text: '当前接口无法导航' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally { await view.unmount() }
})

test('shows running executor and saved request without inventing delivery', async () => {
  const ticket = { id: 't', title: '工作', execution: { name: 'branch-name' }, assignments: [{ id: 'a', state: 'running' }], inputs: [], origin: { triggerIds: [] }, undelivered: [], mandate: { scope: '工作' } }
  const trigger = { id: 'new', source: 'panel', text: '这是真实原话', at: 'today', meta: { projectId: 'p' } }
  const status = { stateDir: '/state', tickets: [ticket], executions: [{ id: 'a', ticketId: 't', provider: 'codex', model: 'model' }], routerHealth: { binding: null }, projects: { projects: [{ id: 'p', name: '状态项目' }], components: [], locations: [], tasks: [{ ticket, context: { target: { projectId: 'p' }, targets: [{ repository: '/repo' }], workspaces: [{ directory: '/work', repository: '/repo' }] } }] }, triggers: [trigger], candidates: [{ triggers: [trigger] }], routingHistory: [], publications: [{ ticketId: 't', repository: 'owner/repo', pr: 42, url: 'https://github.com/owner/repo/pull/42' }], outbox: [{ ticketId: 't', status: 'sent', channel: { source: 'github' }, text: '回复内容' }] }
  const view = await mount(panel, { host: mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': () => status } }) })
  try {
    assert.ok(view.find({ text: /Router 未绑定/ }))
    await view.press({ text: '状态项目' })
    const tree = JSON.stringify(view.tree())
    assert.match(tree, /执行中，暂无报告/)
    assert.match(tree, /codex · model/)
    assert.doesNotMatch(tree, /branch-name/)
    assert.ok(view.find({ text: '这是真实原话' }))
    assert.ok(view.find({ text: /等待 Router 处理/ }))
    await view.activateRow({ label: '项目任务' }, 't')
    assert.ok(view.find({ text: /已发送至 github/ }))
    assert.ok(view.find({ text: '打开 PR' }))
    await view.toggle({ label: '详情' })
    assert.match(JSON.stringify(view.tree()), /\/work/)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally { await view.unmount() }
})

test('failed refresh marks retained data stale without confusing action failure with disconnect', async () => {
  let offline = false
  const status = { stateDir: '/state', tickets: [], projects: { projects: [], components: [], locations: [], tasks: [] } }
  const host = mockHost({ capabilities: ['settings:own'], settings: { stateDir: '/state' }, requests: { 'osa.call': ({ action }: any) => {
    if (action === 'status') { if (offline) throw new Error('offline'); return status }
    throw new Error('action failed')
  } } })
  const view = await mount(panel, { host })
  try {
    await view.toggle({ label: '添加项目' })
    await view.type({ label: '项目名称' }, '新项目')
    await view.press({ text: '添加项目' })
    await view.press({ text: '设置' })
    assert.ok(view.find({ text: '已连接 OSA 服务' }))
    assert.ok(view.find({ text: /上次读取/ }))
    offline = true
    await view.press({ text: '刷新' })
    assert.ok(view.find({ text: '尚未连接 OSA 服务' }))
    assert.ok(view.find({ text: /可能已过期/ }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('viewed ready report leaves attention until a new report arrives', async () => {
  const ticket = { id: 't', title: '已完成的工作', ended: { outcome: 'completed' }, assignments: [{ id: 'a', state: 'ended', report: { state: 'ready', at: 'first', summary: '结果一' } }], inputs: [], origin: { triggerIds: [] }, undelivered: [], mandate: { scope: '工作' } }
  const status = { stateDir: '/one', tickets: [ticket], projects: { projects: [{ id: 'p', name: '项目' }], components: [], locations: [], tasks: [{ ticket, context: { target: { projectId: 'p' } } }] }, triggers: [] }
  const view = await mount(panel, { host: mockHost({ capabilities: ['settings:own'], settings: { stateDir: '/configured-alias' }, requests: { 'osa.call': () => status } }) })
  try {
    assert.match(JSON.stringify(view.tree()), /已完成的工作/)
    await view.press({ label: '已完成的工作' })
    await view.press({ text: '总览' })
    assert.ok(view.find({ text: '目前没有需要处理的任务。' }))
    status.stateDir = '/two'
    await view.press({ text: '刷新' })
    assert.match(JSON.stringify(view.tree()), /已完成的工作/)
    status.stateDir = '/one'
    await view.press({ text: '刷新' })
    assert.ok(view.find({ text: '目前没有需要处理的任务。' }))
    ticket.assignments[0].report = { state: 'ready', at: 'second', summary: '结果二' }
    await view.press({ text: '刷新' })
    assert.match(JSON.stringify(view.tree()), /已完成的工作/)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('reevaluates only unavailable original requests and waits once candidate exists', async () => {
  const original = { id: 'panel:original', source: 'panel', text: '原始请求', at: 'today', meta: { projectId: 'p' } }
  const active = { id: 'panel:active', source: 'panel', text: '正在处理', at: 'today', meta: { projectId: 'p' } }
  const status = { stateDir: '/state', tickets: [], projects: { projects: [{ id: 'p', name: '项目甲' }], components: [], locations: [], tasks: [] }, triggers: [original, active], candidates: [{ triggers: [active] }], routingHistory: [{ id: 'd1', kind: 'unavailable', at: 'one', triggerIds: [original.id] }, { id: 'd2', kind: 'unavailable', at: 'one', triggerIds: [active.id] }], triggerDispositions: [{ triggerId: original.id, decisionId: 'd1' }, { triggerId: active.id, decisionId: 'd2' }] }
  const calls: any[] = []
  const view = await mount(panel, { host: mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': ({ action, options }: any) => {
    calls.push({ action, options })
    if (action === 'reevaluate') { status.candidates.push({ triggers: [original] }); return { triggerId: original.id, requeued: true } }
    return status
  } } }) })
  try {
    assert.ok(view.find({ label: '需要重新评估的请求' }))
    assert.ok(!view.find({ text: '目前没有需要处理的任务。' }))
    await view.press({ label: '原始请求' })
    assert.equal(view.findAll({ text: '重新评估' }).length, 1)
    await view.press({ text: '重新评估' })
    assert.deepEqual(calls.find(c => c.action === 'reevaluate').options, { trigger: 'panel:original' })
    assert.equal(view.findAll({ text: '重新评估' }).length, 0)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('switching state directories blocks stale actions and keeps each draft separate', async () => {
  let bOffline = true
  const calls: any[] = []
  const host = mockHost({ capabilities: ['settings:own'], settings: { stateDir: '/A' }, requests: { 'osa.call': ({ action, options, stateDir }: any) => {
    calls.push({ action, options, stateDir })
    const dir = host.data().settings.stateDir
    if (action === 'status') {
      if (dir === '/B' && bOffline) throw new Error('B offline')
      return { stateDir: dir, tickets: [], projects: { projects: [{ id: 'legacy', name: '共同项目' }], components: [], locations: [], tasks: [] }, triggers: [] }
    }
    return {}
  } } })
  const view = await mount(panel, { host })
  try {
    await view.press({ text: '共同项目' })
    await view.type({ label: '你的要求' }, 'A 的草稿')
    await view.press({ text: '设置' })
    await view.type({ label: '状态目录（绝对路径）' }, '/B', { replace: true })
    await view.press({ text: '保存并连接' })
    assert.match(JSON.stringify(view.tree()), /\/A/)
    assert.match(JSON.stringify(view.tree()), /\/B/)
    await view.press({ text: '总览' })
    await view.press({ text: '共同项目' })
    await assert.rejects(() => view.press({ text: '提交请求' }), /disabled/)
    assert.equal(calls.filter(c => c.action === 'request').length, 0)
    bOffline = false
    await view.press({ text: '刷新' })
    assert.equal(view.valueOf({ label: '你的要求' }), '')
    await view.type({ label: '你的要求' }, 'B 的草稿')
    await view.press({ text: '设置' })
    await view.type({ label: '状态目录（绝对路径）' }, '/A', { replace: true })
    await view.press({ text: '保存并连接' })
    await view.press({ text: '总览' })
    await view.press({ text: '共同项目' })
    assert.equal(view.valueOf({ label: '你的要求' }), 'A 的草稿')
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
