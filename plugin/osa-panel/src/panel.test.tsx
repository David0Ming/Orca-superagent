import { assert, mockHost, mount, stored, test } from 'orca/testing'
import * as main from './panel'
import { isActionableMessage } from './protocol'
import type { Snapshot, RunView, TaskView } from './protocol'

const task = (status: string): TaskView => ({ id: status, title: `${status} task`, status, spec: `需求 ${status}`, result: '', updatedAt: '2026-11-11T00:00:00Z', dispatchId: `ctx_${status}`, assignee: '' })
const run: RunView = { runId: 'run_one', name: 'Run One', objective: '目标', project: 'Project', handle: '', updatedAt: '2026-11-11T00:00:00Z',
  tasks: ['pending', 'ready', 'blocked', 'dispatched', 'failed', 'completed'].map(task),
  workers: ['pending', 'ready', 'blocked', 'dispatched', 'failed', 'completed'].map(status => ({ dispatchId: `ctx_${status}`, taskId: status, state: 'running', liveness: 'live', agent: 'codex', terminal: `term_${status}`, workspace: 'ws_one', terminalState: 'active' })),
  messages: [{ id: 'msg_one', taskId: 'dispatched', dispatchId: 'ctx_dispatched', from: 'term_dispatched', to: 'run:run_one', subject: '需要回复', body: '请确认需求', type: 'question', unread: true, createdAt: '2026-11-11T00:01:00Z' }],
}
const data: Snapshot = { runs: [run, { ...run, runId: 'run_two', name: 'Run Two', tasks: [task('dispatched')], workers: [{ ...run.workers[3], workspace: 'ws_two', agent: 'claude' }], messages: [] }],
  workspaces: [{ id: 'ws_one', name: 'One', path: '/one', project: 'project_one', projectName: 'One' }, { id: 'ws_two', name: 'Two', path: '/two', project: 'project_two', projectName: 'Two' }],
  currentWorkspace: 'ws_one', currentProject: 'project_one', more: false, warnings: [],
}

test('exact task enum wins over live workers; completed stays hidden', () => {
  const rows = main.rows(data)
  assert.deepEqual(rows.filter(row => row.runId === 'run_one').map(row => [row.taskId || 'message', row.section]), [
    ['pending', 'waiting'], ['ready', 'ready'], ['blocked', 'attention'], ['dispatched', 'active'], ['failed', 'attention'], ['message', 'attention'],
  ])
})

test('tickets of a Run with no bound Router and no live worker stay in history', () => {
  const dormant: RunView = { ...run, canReassess: false, workers: [], messages: [], tasks: ['blocked', 'pending', 'ready', 'dispatched'].map(task) }
  assert.deepEqual(main.rows({ ...data, runs: [dormant] }).map(row => [row.taskId, row.section, row.summary]), [
    ['blocked', 'history', '任务状态：blocked'], ['pending', 'history', '任务状态：pending'],
    ['ready', 'history', '任务状态：ready'], ['dispatched', 'history', '任务状态：dispatched'],
  ])
  const live = main.rows({ ...data, runs: [{ ...dormant, tasks: [task('blocked')], workers: [{ ...run.workers[2], taskId: 'blocked', dispatchId: 'ctx_blocked' }] }] })
  assert.deepEqual(live.map(row => [row.taskId, row.section]), [['blocked', 'attention']])
})

test('scope, search, filters, grouping, folding and read-only title details', async () => {
  const actions: unknown[] = []
  const panel = await mount(main, { host: mockHost({ requests: {
    'osa-tasks.list': data,
    'osa-tasks.detail': { spec: '任务全文', result: '', messages: [], source: 'transcript', text: 'assistant：已处理', cursor: '', limited: false, warnings: [] },
    'osa-tasks.action': input => { actions.push(input); return { ok: true, message: '已交付' } },
  } }) })
  try {
    assert.deepEqual(panel.errors, [])
    assert.deepEqual(panel.warnings, [])
    assert.ok(panel.find({ type: 'Text', text: '任务清单' }))
    assert.ok(panel.find({ type: 'Text', text: '待开始' }))
    assert.equal(panel.find({ type: 'Text', text: '待开始·阻塞' }), null)
    assert.equal(panel.findAll({ type: 'ListItem', label: 'dispatched task' }).length, 2)
    assert.ok(panel.findAll({ type: 'ListItem', label: 'dispatched task' }).every(row => !row.props.icon))
    assert.ok(panel.find({ type: 'Image', label: 'Codex' }) || panel.findAll({ type: 'Image' }).some(image => image.props.alt === 'Codex'))
    assert.match(JSON.stringify(panel.tree()), /"background":"warning","border":"warning"/)
    assert.match(JSON.stringify(panel.tree()), /"background":"success","border":"success"/)
    assert.match(JSON.stringify(panel.tree()), /"background":"danger","border":"danger"/)
    assert.match(JSON.stringify(panel.tree()), /"background":"accent","border":"accent"/)
    assert.match(JSON.stringify(panel.tree()), /"background":"neutral","border":"neutral"/)
    await panel.press({ type: 'Button', text: '工作区' })
    assert.equal(panel.findAll({ type: 'ListItem', label: 'dispatched task' }).length, 1)
    await panel.press({ type: 'Button', text: '项目' })
    assert.equal(panel.findAll({ type: 'ListItem', label: 'dispatched task' }).length, 1)
    await panel.press({ type: 'Button', text: '全部' })
    await panel.type({ label: '搜索会话' }, '需求 ready', { replace: true })
    assert.ok(panel.find({ type: 'ListItem', label: 'ready task' }))
    assert.equal(panel.find({ type: 'ListItem', label: 'blocked task' }), null)
    await panel.type({ label: '搜索会话' }, '', { replace: true })
    await panel.press({ label: '筛选与分组' })
    await panel.select({ label: '智能体' }, 'claude')
    assert.equal(panel.findAll({ type: 'ListItem', label: 'dispatched task' }).length, 1)
    await panel.select({ label: '智能体' }, 'all')
    await panel.select({ label: '状态' }, 'ready')
    assert.equal(panel.find({ type: 'ListItem', label: 'failed task' }), null)
    await panel.select({ label: '分组' }, 'run')
    await panel.press({ testId: 'ready:run:run_one' })
    assert.equal(panel.find({ type: 'ListItem', label: 'ready task' }), null)
    await panel.press({ label: '刷新' })
    assert.equal(panel.find({ type: 'ListItem', label: 'ready task' }), null)
    await panel.press({ testId: 'ready:run:run_one' })
    await panel.select({ label: '状态' }, 'all')
    await panel.select({ label: '分组' }, 'workspace')
    assert.ok(panel.find({ type: 'List', label: 'One · 分组' }))
    await panel.press({ type: 'ListItem', label: 'ready task' })
    assert.ok(panel.find({ type: 'CodeView' }))
    assert.equal(panel.find({ type: 'Text', text: '任务全文' }), null)
    await panel.press({ type: 'Button', text: '查看往来消息' })
    assert.ok(panel.find({ type: 'Text', text: '任务全文' }))
    await panel.press({ type: 'Button', text: '收起往来消息' })
    assert.equal(panel.find({ type: 'Button', text: '交给 Router 重新判断' })?.disabled, true)
    for (const text of ['接续', '定位窗口', '回消息', '发送', '取消']) assert.equal(panel.find({ type: 'Button', text }), null)
    assert.equal(panel.find({ label: '回复消息' }), null)
    await panel.press({ type: 'ListItem', label: '有消息待回' })
    assert.equal(panel.find({ label: '回复内容' }), null)
    assert.deepEqual(actions, [])
    const labels = panel.findAll({ type: 'IconButton' }).map(button => button.label || '')
    assert.equal(labels.some(label => /停止|删除|修改 Run|操作：|详情：/.test(label)), false)
    assert.deepEqual(panel.errors, [])
  } finally { await panel.unmount() }
})

test('one latest unread question row per Run; queued and completed win over live workers', () => {
  const mixed: Snapshot = { ...data, runs: [{ ...run,
    tasks: [...run.tasks, ...['succeeded', 'success', 'done', 'other'].map(task)],
    workers: [...run.workers, ...['succeeded', 'success', 'done', 'other'].map(status => ({ ...run.workers[0], taskId: status, dispatchId: `ctx_${status}` }))],
    messages: [...run.messages,
      { ...run.messages[0], id: 'new', type: 'escalation', subject: '最新问题', createdAt: '2026-11-11T02:00:00Z' },
      { ...run.messages[0], id: 'failure', type: 'failed', subject: '失败通知' }],
  }] }
  const rows = main.rows(mixed)
  const messages = rows.filter(r => !r.taskId)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].title, '有消息待回')
  assert.equal(messages[0].summary, '未读待回复 · 最新问题')
  assert.equal(messages[0].updatedAt, '2026-11-11T02:00:00Z')
  assert.deepEqual(rows.filter(r => r.taskId === 'blocked').map(r => r.section), ['attention'])
  assert.equal(rows.some(r => ['completed', 'succeeded', 'success', 'done'].includes(r.taskId || '')), false)
  assert.equal(rows.find(r => r.taskId === 'other')?.section, 'active')
})

test('history uses raw counts and stays collapsed; empty sections have no headings', async () => {
  const historical = { ...run, runId: 'run_history', name: '历史工作', tasks: [], workers: [{ ...run.workers[0], liveness: 'exited' }], messages: [], activeTaskCount: 0, actionableMessageCount: 0 }
  assert.equal(main.rows({ ...data, runs: [{ ...historical, actionableMessageCount: 1 }] })[0].section, 'history')
  assert.equal(main.rows({ ...data, runs: [{ ...historical, activeTaskCount: 1 }] }).length, 0)
  const panel = await mount(main, { host: mockHost({ requests: { 'osa-tasks.list': { ...data, runs: [historical] } } }) })
  try {
    assert.ok(panel.find({ type: 'Button', text: '历史' }))
    assert.equal(panel.find({ type: 'ListItem', label: '历史工作' }), null)
    assert.equal(panel.find({ type: 'Text', text: '需要你' }), null)
    assert.equal(panel.find({ type: 'Text', text: '待开始' }), null)
    assert.equal(panel.find({ type: 'Text', text: '进行中' }), null)
    await panel.press({ type: 'Button', text: '历史' })
    assert.ok(panel.find({ type: 'ListItem', label: '历史工作' }))
    await panel.type({ label: '搜索会话' }, '不匹配', { replace: true })
    assert.equal(panel.find({ type: 'Button', text: '历史' }), null)
    assert.deepEqual(panel.warnings, [])
  } finally { await panel.unmount() }
})

test('blocked needs a person; pending waits for an event; failed needs a live Run', () => {
  const base: RunView = { ...run, workers: [], messages: [] }
  for (const status of ['failed', 'blocked']) {
    const dead = main.rows({ ...data, runs: [{ ...base, tasks: [task(status)] }] })
    assert.deepEqual(dead.map(r => r.section), [status === 'blocked' ? 'attention' : 'history'])
    assert.equal(dead[0].taskId, status)
    const pending = main.rows({ ...data, runs: [{ ...base, tasks: [task(status), task('pending')] }] })
    assert.deepEqual(pending.map(r => r.section), [status === 'blocked' ? 'attention' : 'attention', 'waiting'])
    const unread = main.rows({ ...data, runs: [{ ...base, tasks: [task(status)], messages: run.messages }] })
    assert.deepEqual(unread.map(r => r.section), [status === 'blocked' ? 'attention' : 'history', 'history'])
    const live = main.rows({ ...data, runs: [{ ...base, tasks: [task(status)], workers: [run.workers[0]] }] })
    assert.deepEqual(live.map(r => r.section), ['attention'])
  }
})

test('remount draws persisted rows before a slow list refresh completes', async () => {
  let firstTree = ''
  let firstPaintMs = 0
  const start = performance.now()
  const wrapped = { ...main, default: () => {
    const tree = main.default()
    if (!firstTree) { firstTree = JSON.stringify(tree); firstPaintMs = performance.now() - start }
    return tree
  } }
  const panel = await mount(wrapped, { persisted: { workspace: { 'last-snapshot': stored(data, 3) } }, host: mockHost({ requests: {
    'osa-tasks.list': () => new Promise<Snapshot>(resolve => setTimeout(() => resolve(data), 200)),
  } }) })
  try {
    console.log('Cached first tree milliseconds:', Math.round(firstPaintMs))
    assert.match(firstTree, /dispatched task/)
    assert.ok(firstPaintMs < 200)
    assert.deepEqual(panel.warnings, [])
  } finally { await panel.unmount() }
})

test('dead blocked tickets still need a person while failed tickets stay historical', () => {
  const base: RunView = { ...run, workers: [], messages: [], tasks: [task('blocked'), task('failed'), task('other')] }
  const dead = main.rows({ ...data, runs: [base] })
  assert.deepEqual(dead.map(row => [row.taskId, row.section]), [['blocked', 'attention'], ['failed', 'history'], ['other', 'history']])
  const live = main.rows({ ...data, runs: [{ ...base, workers: [{ ...run.workers[0], taskId: 'other', dispatchId: 'ctx_other' }] }] })
  assert.deepEqual(live.map(row => [row.taskId, row.section]), [['blocked', 'attention'], ['failed', 'attention'], ['other', 'active']])
  const unrelatedLive = main.rows({ ...data, runs: [{ ...base, tasks: [task('pending'), task('other')] }] })
  assert.deepEqual(unrelatedLive.map(row => [row.taskId, row.section]), [['pending', 'waiting'], ['other', 'history']])
})

test('system receipts never create attention or keep failed Runs live; blocked stays in attention', () => {
  const receipts = ['DiD nOt ReAcH', 'REACH THE FINISHED WORKER', 'Worker STOPPED without REPORTING', 'waiting ON a PROMPT']
  for (const type of ['question', 'escalation']) {
    for (const phrase of receipts) for (const field of ['subject', 'body']) {
      const message = { ...run.messages[0], type, subject: '需要决定', body: '真实内容', [field]: phrase }
      assert.equal(isActionableMessage(message, run), false)
      const rows = main.rows({ ...data, runs: [{ ...run, tasks: [task('failed'), task('blocked')], workers: [], messages: [message] }] })
      assert.deepEqual(rows.map(row => [row.taskId, row.section]), [['failed', 'history'], ['blocked', 'attention']])
    }
    assert.equal(isActionableMessage({ ...run.messages[0], type, id: 'msg_stop_test' }, run), false)
    assert.equal(isActionableMessage({ ...run.messages[0], type }, run), true)
    assert.equal(isActionableMessage({ ...run.messages[0], type, to: 'term_worker' }, run), false)
  }
  for (const type of ['status', 'info', 'heartbeat', 'worker_done']) {
    const message = { ...run.messages[0], type }
    assert.equal(isActionableMessage(message, run), false)
    assert.equal(main.rows({ ...data, runs: [{ ...run, tasks: [task('failed')], workers: [], messages: [message] }] })[0].section, 'history')
  }
})

test('bound Router reassess is a single mailbox action without an input composer', async () => {
  const actions: unknown[] = []
  const panel = await mount(main, { host: mockHost({ requests: {
    'osa-tasks.list': { ...data, runs: [{ ...run, canReassess: true, tasks: [task('failed')] }] },
    'osa-tasks.action': input => { actions.push(input); return { ok: true, message: '已请求重新判断' } },
  } }) })
  try {
    assert.ok(panel.find({ type: 'Button', text: '交给 Router 重新判断' }))
    await panel.press({ type: 'Button', text: '交给 Router 重新判断' })
    assert.ok(panel.find({ type: 'ListItem', label: 'failed task' }))
    assert.deepEqual(actions, [{ runId: 'run_one', taskId: 'failed', dispatchId: 'ctx_failed', kind: 'reassess' }])
    assert.equal(panel.find({ type: 'Textarea' }), null)
    assert.equal(panel.find({ label: '回复内容' }), null)
  } finally { await panel.unmount() }
})


test('@ copies a reference without a Router picker; double click only locates; unmount cancels copying', async () => {
  const actions: { kind: string }[] = []
  const panel = await mount(main, { host: mockHost({ requests: {
    'osa-tasks.list': { ...data, runs: [{ ...run, handle: '', tasks: [task('ready')], messages: [] }] },
    'osa-tasks.action': input => { actions.push(input); return { ok: true, message: '已复制任务 ready 的引用，可粘贴给 Router 询问；未发送。' } },
  } }) })
  try {
    await panel.press({ type: 'Button', text: '@' })
    assert.equal(actions.length, 0)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.deepEqual(actions, [{ runId: 'run_one', taskId: 'ready', dispatchId: 'ctx_ready', kind: 'mention' }])
    await panel.rerender()
    assert.equal(panel.find({ type: 'Select', label: 'Router 窗口' }), null)
    assert.equal(panel.find({ type: 'Button', text: '填入 Router 输入框' }), null)
    assert.ok(panel.find({ type: 'Text', text: '已复制任务 ready 的引用，可粘贴给 Router 询问；未发送。' }))
    await panel.press({ type: 'Button', text: '@' })
    await panel.press({ type: 'Button', text: '@' })
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.deepEqual(actions.map(action => action.kind), ['mention', 'open'])
    await panel.press({ type: 'Button', text: '@' })
  } finally { await panel.unmount() }
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.deepEqual(actions.map(action => action.kind), ['mention', 'open'])
})

test('inner conversation/history/message disclosures toggle; parent close resets them', async () => {
  const panel = await mount(main, { host: mockHost({ requests: {
    'osa-tasks.list': { ...data, runs: [{ ...run, tasks: [task('dispatched')] }] },
    'osa-tasks.detail': input => ({ spec: '任务全文', result: '', messages: run.messages, source: 'transcript', text: input.history ? '原始历史会话' : '最新一轮会话', history: !!input.history, cursor: '', limited: false, warnings: [] }),
  } }) })
  try {
    await panel.press({ type: 'ListItem', label: 'dispatched task' })
    assert.equal(panel.find({ type: 'CodeView' })?.props.code, '最新一轮会话')
    await panel.press({ type: 'Button', text: '收起执行者会话' })
    assert.equal(panel.find({ type: 'CodeView' }), null)
    await panel.press({ type: 'Button', text: '查看执行者会话' })
    assert.equal(panel.find({ type: 'CodeView' })?.props.code, '最新一轮会话')
    await panel.press({ type: 'Button', text: '查看执行历史' })
    assert.equal(panel.find({ type: 'CodeView' })?.props.code, '原始历史会话')
    await panel.press({ type: 'Button', text: '收起执行历史' })
    assert.equal(panel.find({ type: 'CodeView' }), null)
    await panel.press({ type: 'Button', text: '查看执行历史' })
    assert.equal(panel.find({ type: 'CodeView' })?.props.code, '原始历史会话')
    await panel.press({ type: 'Button', text: '查看往来消息' })
    assert.ok(panel.find({ type: 'Text', text: '请确认需求' }))
    await panel.press({ type: 'Button', text: '收起往来消息' })
    assert.equal(panel.find({ type: 'Text', text: '请确认需求' }), null)
    await panel.press({ type: 'Button', text: '查看往来消息' })
    await panel.press({ type: 'ListItem', label: 'dispatched task' })
    await panel.press({ type: 'ListItem', label: 'dispatched task' })
    assert.equal(panel.find({ type: 'CodeView' })?.props.code, '最新一轮会话')
    assert.ok(panel.find({ type: 'Button', text: '查看执行历史' }))
    assert.ok(panel.find({ type: 'Button', text: '查看往来消息' }))
    assert.equal(panel.find({ type: 'Text', text: '请确认需求' }), null)
    assert.deepEqual(panel.errors, [])
    assert.deepEqual(panel.warnings, [])
  } finally { await panel.unmount() }
})


test('same terminal does not mix explicitly identified tasks in read-only message rows', () => {
  const original = { ...run.messages[0], taskId: 'failed', dispatchId: 'ctx_failed', from: 'term_failed' }
  const mixed = { ...data, runs: [{ ...run, tasks: [task('failed')], messages: [
    original,
    { ...original, id: 'other_task', taskId: 'other', dispatchId: 'ctx_failed' },
    { ...original, id: 'other_dispatch', taskId: '', dispatchId: 'ctx_other' },
    { ...original, id: 'by_dispatch', taskId: '', dispatchId: 'ctx_failed' },
    { ...original, id: 'legacy', taskId: '', dispatchId: '' },
  ] }] }
  assert.deepEqual(main.rows(mixed).find(row => row.taskId === 'failed')?.messages.map(message => message.id), ['msg_one', 'by_dispatch', 'legacy'])
})


test('only workers and pending/ready/dispatched tasks keep Runs live; old read questions stay in history', () => {
  const message = { ...run.messages[0], unread: false }
  const dead = { ...run, tasks: [task('failed')], workers: [], messages: [message] }
  const historical = main.rows({ ...data, runs: [dead] })
  assert.ok(historical.every(row => row.section === 'history'))
  assert.ok(historical.some(row => row.messages.some(item => item.id === message.id)))
  const live = { ...dead, workers: [run.workers[0]] }
  assert.deepEqual(main.rows({ ...data, runs: [live] }).map(row => row.section), ['attention', 'attention'])
  const answered = { ...live, messages: [{ ...message, replied: true }] }
  assert.equal(main.rows({ ...data, runs: [answered] }).filter(row => !row.taskId).length, 0)
  const unread = { ...dead, messages: [{ ...message, unread: true }] }
  assert.deepEqual(main.rows({ ...data, runs: [unread] }).map(row => row.section), ['history', 'history'])
  const blocked = { ...dead, tasks: [task('blocked')] }
  assert.equal(main.rows({ ...data, runs: [blocked] })[0].section, 'attention')
  for (const own of [{ ...message, source: 'osa-panel' }, { ...message, from: 'run:run_one' }, { ...message, type: 'status', subject: 'queue-scan' }]) {
    assert.equal(isActionableMessage(own, live), false)
  }
})

test('completed totals include only active Runs, follow actual assignment and appear once across sections', async () => {
  const current = { ...run, completedTasks: [{ id: 'completed', dispatchId: 'ctx_completed' }] }
  const mixed = { ...data, runs: [current, { ...current, runId: 'dead', workers: [], tasks: [], messages: [], activeTaskCount: 0, actionableMessageCount: 0 }] }
  assert.equal(main.completedCounts(mixed, 'run').get('run_one'), 1)
  assert.equal(main.completedCounts(mixed, 'run').has('dead'), false)
  assert.equal(main.completedCounts(mixed, 'project').get('project_one'), 1)
  assert.equal(main.completedCounts(mixed, 'workspace').get('ws_one'), 1)
  assert.equal(main.completedCounts(mixed, 'agent').get('codex'), 1)
  assert.equal(main.completedCounts(mixed, 'run', { workspace: 'ws_two' }).size, 0)
  assert.equal(main.rows(mixed).some(row => row.taskId === 'completed'), false)
  const panel = await mount(main, { host: mockHost({ requests: { 'osa-tasks.list': mixed } }) })
  try {
    assert.equal(panel.findAll({ type: 'Text', text: '已完成 1' }).length, 1)
  } finally { await panel.unmount() }
})


test('blocked shows the owner question and native dependencies, never a derived condition', () => {
  const summary = (evidence: Partial<TaskView>) => main.rows({ ...data, runs: [{ ...run, tasks: [{ ...task('blocked'), ...evidence }], messages: [] }] })[0].summary
  assert.equal(summary({ result: '问题：给别的冻结路径还是排同窗双采？' }), '问题：给别的冻结路径还是排同窗双采？')
  assert.equal(summary({ dependencies: ['镜像构建'], result: '问题：先改哪一处？' }), '依赖：镜像构建；问题：先改哪一处？')
  assert.equal(summary({ dependencies: ['镜像构建'] }), '依赖：镜像构建；受阻但未写明要你决定什么')
  assert.equal(summary({ resultTitle: '等生产窗口', spec: '【前置】等待生产窗口' }), '受阻但未写明要你决定什么')
  assert.equal(summary({ result: '等待：生产窗口；解除：owner确认窗口可用' }), '受阻但未写明要你决定什么；记录：等待：生产窗口；解除：owner确认窗口可用')
})

test('three blocked tickets in a dead Run stay in attention without a duplicate historical summary', () => {
  const current = { ...run, workers: [], messages: [], tasks: [1, 2, 3].map(id => ({ ...task('blocked'), id: `blocked_${id}`, title: `Wave2 ${id}` })) }
  const rows = main.rows({ ...data, runs: [current] })
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.section === 'attention'))
})


test('visibility restoration and remount force fresh immediately; ordinary renders do not reload', async () => {
  const requests: { force?: boolean }[] = []
  const host = mockHost({ requests: { 'osa-tasks.list': input => { requests.push(input || {}); return data } } })
  const panel = await mount(main, { visible: false, host, persisted: { workspace: { 'last-snapshot': stored(data, 3) } } })
  try {
    assert.equal(requests.length, 1)
    assert.equal(requests[0].force, true)
    const start = performance.now()
    await panel.setVisible(true)
    assert.ok(performance.now() - start < 1000)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].force, true)
    await panel.rerender()
    await panel.setVisible(true)
    assert.equal(requests.length, 2)
    assert.deepEqual(panel.errors, [])
  } finally { await panel.unmount() }
  const remount = await mount(main, { host, persisted: { workspace: { 'last-snapshot': stored(data, 3) } } })
  try {
    assert.equal(requests.length, 3)
    assert.equal(requests[2].force, true)
    assert.deepEqual(remount.errors, [])
  } finally { await remount.unmount() }
})

test('visibility changes reuse an already running fresh request', async () => {
  let requests = 0
  let finish: ((value: Snapshot) => void) | undefined
  const panel = await mount(main, { visible: false, host: mockHost({ requests: {
    'osa-tasks.list': () => { requests += 1; return requests === 1 ? data : new Promise<Snapshot>(resolve => { finish = resolve }) },
  } }) })
  try {
    const first = panel.setVisible(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    const hidden = panel.setVisible(false)
    const shown = panel.setVisible(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(requests, 2)
    finish!(data)
    await Promise.all([first, hidden, shown])
    assert.equal(requests, 2)
    assert.deepEqual(panel.errors, [])
  } finally { finish?.(data); await panel.unmount() }
})



test('UTF-8-sized preview cache preserves rows while rejecting oversized persisted values', () => {
  const large = { ...data, runs: [{ ...run,
    tasks: Array.from({ length: 150 }, (_, index) => ({ ...task('blocked'), id: `task_${index}`, spec: '背景资料'.repeat(150), result: '问题：owner先确认窗口可用？' })),
    messages: Array.from({ length: 150 }, (_, index) => ({ ...run.messages[0], id: `message_${index}`, subject: '', body: '中文正文'.repeat(150) + ' Worker stopped without reporting' })),
  }] }
  assert.ok(new TextEncoder().encode(JSON.stringify({ version: 3, value: large })).length > 262144)
  const preview = main.cachePreview(large)!
  assert.ok(preview)
  assert.ok(new TextEncoder().encode(JSON.stringify({ version: 3, value: preview })).length <= 262144)
  assert.deepEqual(main.rows(preview).map(row => [row.key, row.section, row.updatedAt]), main.rows(large).map(row => [row.key, row.section, row.updatedAt]))
  assert.equal(preview.runs[0].tasks.length, 150)
  assert.equal(preview.runs[0].messages.length, 150)
  assert.equal(preview.runs[0].tasks[0].blockedQuestion, '问题：owner先确认窗口可用？')
  assert.equal(isActionableMessage(preview.runs[0].messages[0], preview.runs[0]), false)
  assert.equal(main.cachePreview({ ...large, workspaces: [{ ...data.workspaces[0], path: '路径'.repeat(150000) }] }), null)
})

test('old full cache is invalidated; oversized cache leaves fresh data visible with an explicit warning', async () => {
  let firstTree = ''
  const oversized = { ...data, workspaces: [{ ...data.workspaces[0], path: '路径'.repeat(150000) }] }
  const wrapped = { ...main, default: () => { const tree = main.default(); if (!firstTree) firstTree = JSON.stringify(tree); return tree } }
  const panel = await mount(wrapped, { persisted: { workspace: { 'last-snapshot': data } }, host: mockHost({ requests: { 'osa-tasks.list': oversized } }) })
  try {
    assert.equal(firstTree.includes('dispatched task'), false)
    assert.ok(panel.find({ type: 'ListItem', label: 'ready task' }))
    assert.ok(panel.find({ type: 'Callout', text: '列表已更新；快照超过 Orca 256 KiB 缓存上限，本次不保留缓存。' }))
  } finally { await panel.unmount() }
})



test('long original records are bounded and list failures are visible without opening filters', async () => {
  const warning = '消息读取失败：实际接口不可用'
  const panel = await mount(main, { host: mockHost({ requests: {
    'osa-tasks.list': { ...data, warnings: [warning], runs: [{ ...run, tasks: [task('dispatched')] }] },
    'osa-tasks.detail': { spec: '原始说明'.repeat(5000), result: '结果'.repeat(10000), messages: [{ ...run.messages[0], body: '原始消息'.repeat(5000) }], source: 'transcript', text: '最新回答', cursor: '', limited: false, warnings: [] },
  } }) })
  try {
    assert.ok(panel.find({ type: 'Callout', text: warning }))
    await panel.press({ type: 'ListItem', label: 'dispatched task' })
    await panel.press({ type: 'Button', text: '查看往来消息' })
    assert.equal(panel.findAll({ type: 'Text', text: '内容超过 16000 字，已截断显示；原始记录未改动。' }).length, 3)
    assert.deepEqual(panel.errors, [])
    assert.deepEqual(panel.warnings, [])
  } finally { await panel.unmount() }
})
