import { mockHost, mount, test } from 'orca/testing'
import assert from 'node:assert/strict'
import * as panel from './panel'

async function mountLegacy(options: Parameters<typeof mount>[1]) {
  const view = await mount(panel, options)
  await view.press({ text: '总览' })
  return view
}

test('refresh and failed submit preserve draft and retry identity', async () => {
  const submissions: any[] = []
  const status = { stateDir: '/state', tickets: [], projects: { projects: [{ id: 'p', name: '示例工程' }], components: [], locations: [], tasks: [] }, candidates: [] }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], requests: { 'osa.call': ({ action, options }: any) => {
    if (action === 'status') return status
    submissions.push(options)
    if (submissions.length === 1) throw new Error('offline')
    return { id: options.id }
  } } })
  const view = await mountLegacy({ host })
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
  const view = await mountLegacy({ host })
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
  const view = await mountLegacy({ host })
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
  const view = await mountLegacy({ host: mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': () => status } }) })
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
  const view = await mountLegacy({ host })
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
  const view = await mountLegacy({ host: mockHost({ capabilities: ['settings:own'], settings: { stateDir: '/configured-alias' }, requests: { 'osa.call': () => status } }) })
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
  const view = await mountLegacy({ host: mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': ({ action, options }: any) => {
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
  const view = await mountLegacy({ host })
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

test('conversation follows recorded times and retains legacy replies without duplicating reports', async () => {
  const time = (minute: number) => `2026-11-07T07:0${minute}:00.000Z`
  const first = { id: 'one', source: 'panel', actor: { source: 'panel', id: '501' }, human: true, at: time(1), text: '用户原始要求' }
  const answer = { id: 'two', source: 'panel', actor: { source: 'panel', id: '501' }, human: true, at: time(4), text: '用户的回答' }
  const progress = { state: 'progress', at: time(2), summary: '执行进展原文' }
  const final = { state: 'ready', at: time(5), summary: '最终结果原文' }
  const ticket = { id: 't', title: '对话测试', assignments: [{ id: 'a', state: 'ended', report: final }], inputs: [{ id: 'i', kind: 'trigger', triggerId: 'two', readAt: time(4) }], origin: { triggerIds: ['one'] }, undelivered: [], mandate: { scope: '工作' } }
  const status = { stateDir: '/state', tickets: [ticket], projects: { projects: [{ id: 'p', name: '对话项目' }], components: [], locations: [], tasks: [{ ticket, context: { target: { projectId: 'p' } } }] }, triggers: [answer, first], reportReceipts: [{ ticketId: 't', assignmentId: 'a', result: { assignments: [{ id: 'a', report: final }] } }, { ticketId: 't', assignmentId: 'a', result: { assignments: [{ id: 'a', report: progress }] } }, { ticketId: 't', assignmentId: 'a', result: { assignments: [{ id: 'a', report: { ...progress, summary: '同毫秒的另一进展' } }] } }, { ticketId: 't', assignmentId: 'a', result: { assignments: [{ id: 'a', report: final }] } }], outbox: [{ ticketId: 't', text: '最终结果原文', status: 'sent', createdAt: time(5), channel: { source: 'panel' } }, { ticketId: 't', text: '需要回答的问题', status: 'sent', createdAt: time(3), channel: { source: 'panel' } }, { ticketId: 't', text: '旧的无时间回复', status: 'sent', channel: { source: 'github' } }] }
  const view = await mountLegacy({ host: mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': () => status } }) })
  try {
    await view.press({ text: '对话项目' })
    await view.activateRow({ label: '项目任务' }, 't')
    const tree: any = view.tree()
    const detail = tree.children.find((child: any) => child?.children?.some((node: any) => node?.type === 'Heading' && node.children?.includes('对话')))
    const nodes = detail.children
    const conversation = JSON.stringify(nodes.slice(nodes.findIndex((n: any) => n?.type === 'Heading' && n.children?.includes('对话')), nodes.findIndex((n: any) => n?.type === 'Textarea')))
    const words = ['用户原始要求', '执行进展原文', '同毫秒的另一进展', '需要回答的问题', '用户的回答', '最终结果原文', '旧的无时间回复']
    assert.deepEqual(words.map(word => conversation.indexOf(word)).slice().sort((a, b) => a - b), words.map(word => conversation.indexOf(word)))
    assert.ok(words.every(word => conversation.includes(word)))
    assert.equal(conversation.split('最终结果原文').length - 1, 1)
    assert.match(conversation, /时间未记录/)
    assert.match(conversation, /"OSA".*回复/)
    assert.match(conversation, /已保存到面板对话/)
    assert.match(conversation, /已读取/)
    assert.doesNotMatch(conversation, /501/)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally { await view.unmount() }
})

test('external human retains their identity in task conversation', async () => {
  const external = { id: 'review', source: 'github', actor: { source: 'github', id: '99' }, human: true, at: '2026-11-07T07:00:00Z', text: '协作者的评论' }
  const ticket = { id: 't', title: '协作任务', assignments: [], inputs: [{ id: 'i', kind: 'trigger', triggerId: 'review' }], origin: { triggerIds: [] }, undelivered: ['i'], mandate: { scope: '工作' } }
  const status = { stateDir: '/state', tickets: [ticket], projects: { projects: [{ id: 'p', name: '协作项目' }], components: [], locations: [], tasks: [{ ticket, context: { target: { projectId: 'p' } } }] }, triggers: [external] }
  const view = await mountLegacy({ host: mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': () => status } }) })
  try {
    await view.press({ text: '协作项目' })
    await view.activateRow({ label: '项目任务' }, 't')
    assert.match(JSON.stringify(view.tree()), /99.*github/)
    assert.doesNotMatch(JSON.stringify(view.tree()), /你 · 2026-11-07T07:00:00Z/)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('ignored status query keeps its exact-thread replies and shows new replies as unread', async () => {
  const trigger = { id: 'panel:query', source: 'panel', human: true, at: '2026-11-07T07:00:00Z', text: '查询状态', channel: { source: 'panel', thread: 'request:query' }, meta: { projectId: 'p' } }
  const status = { stateDir: '/state', tickets: [], projects: { projects: [{ id: 'p', name: '查询项目' }], components: [], locations: [], tasks: [] }, triggers: [trigger], candidates: [], routingHistory: [{ id: 'd', kind: 'ignore', triggerIds: [trigger.id] }], triggerDispositions: [{ triggerId: trigger.id, decisionId: 'd' }], outbox: [{ id: 'reply1', kind: 'reply', status: 'sent', createdAt: '2026-11-07T07:01:00Z', channel: { source: 'panel', thread: 'request:query' }, text: '查询结果' }, { id: 'other', kind: 'reply', status: 'sent', createdAt: '2026-11-07T07:01:00Z', channel: { source: 'panel', thread: 'request:other' }, text: '无关内容' }, { id: 'foreign', kind: 'reply', status: 'sent', createdAt: '2026-11-07T07:01:00Z', channel: { source: 'github', thread: 'request:query' }, text: '其他来源' }] }
  const view = await mountLegacy({ host: mockHost({ capabilities: ['settings:own'], requests: { 'osa.call': () => status } }) })
  try {
    assert.ok(view.find({ label: '未读请求回复' }))
    await view.press({ label: '查询状态' })
    assert.ok(view.find({ text: '查询结果' }))
    assert.ok(!view.find({ text: '无关内容' }))
    assert.ok(!view.find({ text: '其他来源' }))
    await view.press({ text: '总览' })
    assert.ok(!view.find({ label: '未读请求回复' }))
    await view.press({ text: '查询项目' })
    assert.ok(view.find({ text: /已回复/ }))
    assert.ok(view.find({ text: '查看回复' }))
    assert.deepEqual(view.rowsOf({ label: '项目任务' }), [])
    status.outbox.push({ id: 'reply2', kind: 'reply', status: 'sent', createdAt: '2026-11-07T07:02:00Z', channel: { source: 'panel', thread: 'request:query' }, text: '补充结果' })
    await view.press({ text: '刷新' })
    await view.press({ text: '总览' })
    assert.ok(view.find({ label: '未读请求回复' }))
    await view.press({ label: '查询状态' })
    assert.ok(view.find({ text: '补充结果' }))
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally { await view.unmount() }
})


test('sidebar opens the main-area workbench through its dedicated handler', async () => {
  let opened = 0
  const view = await mount(panel, {host:mockHost({capabilities:['settings:own'],settings:{stateDir:'/state'},requests:{'osa.call':()=>({stateDir:'/state',tickets:[],projects:{projects:[]}}),'osa.open-workbench':()=>{opened++;return {opened:true,file:'/state/工作台.osaworkbench'}}}})})
  try {
    assert.ok(view.find({label:'状态目录（绝对路径）'}))
    await view.press({text:'打开任务工作台'})
    assert.equal(opened,1)
    assert.deepEqual(view.errors,[])
  } finally {await view.unmount()}
})
