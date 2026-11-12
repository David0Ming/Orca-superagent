import { assert, mockHost, mount, test } from 'orca/testing'
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
  routers: [{ handle: 'term_router', title: 'Router', agent: 'codex' }], currentWorkspace: 'ws_one', currentProject: 'project_one', more: false, warnings: [],
}

test('exact task enum wins over live workers; completed stays hidden', () => {
  const rows = main.rows(data)
  assert.deepEqual(rows.filter(row => row.runId === 'run_one').map(row => [row.taskId || 'message', row.section]), [
    ['pending', 'queued'], ['ready', 'queued'], ['blocked', 'queued'], ['dispatched', 'active'], ['failed', 'attention'], ['message', 'attention'],
  ])
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
    assert.ok(panel.find({ type: 'Text', text: '待开始·等条件' }))
    assert.equal(panel.find({ type: 'Text', text: '待开始·阻塞' }), null)
    assert.equal(panel.findAll({ type: 'ListItem', label: 'dispatched task' }).length, 2)
    assert.ok(panel.findAll({ type: 'ListItem', label: 'dispatched task' }).every(row => !row.props.icon))
    assert.ok(panel.find({ type: 'Image', label: 'Codex' }) || panel.findAll({ type: 'Image' }).some(image => image.props.alt === 'Codex'))
    assert.match(JSON.stringify(panel.tree()), /"background":"warning","border":"warning"/)
    assert.match(JSON.stringify(panel.tree()), /"background":"success","border":"success"/)
    assert.match(JSON.stringify(panel.tree()), /"background":"danger","border":"danger"/)
    assert.match(JSON.stringify(panel.tree()), /"background":"none","border":false/)
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
    await panel.select({ label: '状态' }, 'queued')
    assert.equal(panel.find({ type: 'ListItem', label: 'failed task' }), null)
    await panel.select({ label: '分组' }, 'run')
    await panel.press({ testId: 'queued:run:run_one' })
    assert.equal(panel.find({ type: 'ListItem', label: 'ready task' }), null)
    await panel.press({ label: '刷新' })
    assert.equal(panel.find({ type: 'ListItem', label: 'ready task' }), null)
    await panel.press({ testId: 'queued:run:run_one' })
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
  assert.deepEqual(rows.filter(r => r.taskId === 'blocked').map(r => r.section), ['queued'])
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
    assert.equal(panel.find({ type: 'Text', text: '待开始·等条件' }), null)
    assert.equal(panel.find({ type: 'Text', text: '进行中' }), null)
    await panel.press({ type: 'Button', text: '历史' })
    assert.ok(panel.find({ type: 'ListItem', label: '历史工作' }))
    await panel.type({ label: '搜索会话' }, '不匹配', { replace: true })
    assert.equal(panel.find({ type: 'Button', text: '历史' }), null)
    assert.deepEqual(panel.warnings, [])
  } finally { await panel.unmount() }
})

test('waiting tasks always queue; failed tickets need attention only in a live Run', () => {
  const base: RunView = { ...run, workers: [], messages: [] }
  for (const status of ['failed', 'blocked']) {
    const dead = main.rows({ ...data, runs: [{ ...base, tasks: [task(status)] }] })
    assert.deepEqual(dead.map(r => r.section), [status === 'blocked' ? 'queued' : 'history'])
    assert.equal(dead[0].taskId, status)
    const pending = main.rows({ ...data, runs: [{ ...base, tasks: [task(status), task('pending')] }] })
    assert.deepEqual(pending.map(r => r.section), [status === 'blocked' ? 'queued' : 'attention', 'queued'])
    const unread = main.rows({ ...data, runs: [{ ...base, tasks: [task(status)], messages: run.messages }] })
    assert.deepEqual(unread.map(r => r.section), [status === 'blocked' ? 'queued' : 'history', 'history'])
    const live = main.rows({ ...data, runs: [{ ...base, tasks: [task(status)], workers: [run.workers[0]] }] })
    assert.deepEqual(live.map(r => r.section), [status === 'blocked' ? 'queued' : 'attention'])
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
  const panel = await mount(wrapped, { persisted: { workspace: { 'last-snapshot': data } }, host: mockHost({ requests: {
    'osa-tasks.list': () => new Promise<Snapshot>(resolve => setTimeout(() => resolve(data), 200)),
  } }) })
  try {
    console.log('Cached first tree milliseconds:', Math.round(firstPaintMs))
    assert.match(firstTree, /dispatched task/)
    assert.ok(firstPaintMs < 200)
    assert.deepEqual(panel.warnings, [])
  } finally { await panel.unmount() }
})

test('dead blocked tickets queue while failed tickets stay historical', () => {
  const base: RunView = { ...run, workers: [], messages: [], tasks: [task('blocked'), task('failed'), task('other')] }
  const dead = main.rows({ ...data, runs: [base] })
  assert.deepEqual(dead.map(row => [row.taskId, row.section]), [['blocked', 'queued'], ['failed', 'history'], ['other', 'history']])
  const live = main.rows({ ...data, runs: [{ ...base, workers: [{ ...run.workers[0], taskId: 'other', dispatchId: 'ctx_other' }] }] })
  assert.deepEqual(live.map(row => [row.taskId, row.section]), [['blocked', 'queued'], ['failed', 'attention'], ['other', 'active']])
  const unrelatedLive = main.rows({ ...data, runs: [{ ...base, tasks: [task('pending'), task('other')] }] })
  assert.deepEqual(unrelatedLive.map(row => [row.taskId, row.section]), [['pending', 'queued'], ['other', 'history']])
})

test('system receipts never create attention or keep failed Runs live; blocked remains queued', () => {
  const receipts = ['DiD nOt ReAcH', 'REACH THE FINISHED WORKER', 'Worker STOPPED without REPORTING', 'waiting ON a PROMPT']
  for (const type of ['question', 'escalation']) {
    for (const phrase of receipts) for (const field of ['subject', 'body']) {
      const message = { ...run.messages[0], type, subject: '需要决定', body: '真实内容', [field]: phrase }
      assert.equal(isActionableMessage(message, run), false)
      const rows = main.rows({ ...data, runs: [{ ...run, tasks: [task('failed'), task('blocked')], workers: [], messages: [message] }] })
      assert.deepEqual(rows.map(row => [row.taskId, row.section]), [['failed', 'history'], ['blocked', 'queued']])
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


test('@ delays mention, double click only locates, and unmount cancels a pending mention', async () => {
  const actions: { kind: string; router?: string }[] = []
  const panel = await mount(main, { host: mockHost({ requests: {
    'osa-tasks.list': { ...data, runs: [{ ...run, handle: 'term_router', tasks: [task('ready')], messages: [] }] },
    'osa-tasks.action': input => { actions.push(input); return { ok: true, message: 'ok' } },
  } }) })
  try {
    await panel.press({ type: 'Button', text: '@' })
    assert.equal(actions.length, 0)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.deepEqual(actions.map(action => action.kind), ['mention'])
    assert.equal(actions[0].router, 'term_router')
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
  assert.equal(main.rows({ ...data, runs: [blocked] })[0].section, 'queued')
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


test('blocked summaries use explicit waiting evidence, never infer conditions from the task goal', () => {
  const summary = (evidence: Partial<TaskView>) => main.rows({ ...data, runs: [{ ...run, tasks: [{ ...task('blocked'), ...evidence }], messages: [] }] })[0].summary
  assert.equal(summary({ resultTitle: '等生产窗口' }), '等生产窗口')
  assert.equal(summary({ result: '当前阻塞：等待制品通过验收。其他信息。' }), '等待制品通过验收')
  assert.equal(summary({ spec: '【前置（唯一长板）】V2 Worker 制品必须构建出来。' }), 'V2 Worker 制品必须构建出来')
  assert.equal(summary({ dependencies: ['镜像构建'] }), '等待：镜像构建')
  assert.equal(summary({ spec: '恢复自动回复。不等待审批直接做。若等待制品则暂缓。' }), '等待条件未注明')
  assert.equal(summary({ spec: '只准备方案，不执行生产切换。' }), '等待条件未注明')
})


test('three blocked tickets in a dead Run stay queued without a duplicate historical summary', () => {
  const current = { ...run, workers: [], messages: [], tasks: [1, 2, 3].map(id => ({ ...task('blocked'), id: `blocked_${id}`, title: `Wave2 ${id}` })) }
  const rows = main.rows({ ...data, runs: [current] })
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.section === 'queued'))
})
