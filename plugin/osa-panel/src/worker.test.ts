import { assert, test } from 'orca/testing'
import { action, collect, detail } from './worker'

function fixture(coordinator = '') {
  const calls: string[][] = []
  const worker = { dispatchId: 'ctx_one', taskId: 'task_one', workerState: 'running', agentTerminalHandle: 'term_one', projection: { outcome: 'running', liveness: { verdict: 'live' }, provider: { id: 'codex' }, workspace: { id: 'repo::/one' }, stage: { activity: 'working' } } }
  const terminal = { connected: true, writable: true, agentIdentity: 'codex', handle: 'term_one' }
  const call = async (args: string[]) => {
    calls.push(args)
    switch (args.slice(0, 2).join(' ')) {
      case 'orchestration run-list': return { runs: [{ id: 'run_one', objective: 'One', coordinator_handle: coordinator, updated_at: '2026-11-11 03:00:00' }], nextCursor: 'more' }
      case 'orchestration run-show': return { run: { id: 'run_one', objective: 'One', coordinator_handle: coordinator } }
      case 'orchestration task-list': return { tasks: [{ id: 'task_one', task_title: 'Task', status: 'dispatched', spec: '任务原文', dispatch_id: 'ctx_one', created_at: '2026-11-11 03:00:00' }] }
      case 'orchestration worker-list': return { workers: [worker] }
      case 'project list': return { projects: [{ id: 'project_one', displayName: 'Project One' }] }
      case 'worktree list': return { worktrees: [{ id: 'repo::/one', path: '/one', displayName: 'One', projectId: 'project_one' }] }
      case 'worktree show': return { worktree: { id: 'repo::/one', projectId: 'project_one' } }
      case 'orchestration inbox': return { messages: [{ id: 'msg_one', run_id: 'run_one', type: 'question', from_handle: 'term_one', to_handle: 'run:run_one', body: 'Question', payload: '{"taskId":"task_one"}' }] }
      case 'orchestration worker-show': return { terminal, dispatch: { dispatchedAt: '2026-11-11T03:00:00Z' } }
      case 'orchestration worker-read': return { source: 'transcript', transcript: { messages: [{ role: 'assistant', blocks: [{ type: 'text', text: '完整内容' }] }] }, contentComplete: false, cursor: 'next' }
      case 'terminal list': return { terminals: [{ ...terminal, worktreeId: 'repo::/one' }] }
      case 'terminal show': return { terminal }
      case 'terminal switch': return { ok: true }
      case 'orchestration send': return { message: { id: 'msg_reassess' } }
      default: throw new Error(`Forbidden/unexpected: ${args.join(' ')}`)
    }
  }
  return { calls, call, terminal }
}
const target = { runId: 'run_one', taskId: 'task_one', dispatchId: 'ctx_one' }
test('read model carries full task text, workspace identity, UTC time and pagination', async () => {
  const { call } = fixture()
  const data = await collect(20, call)
  assert.equal(data.runs[0].tasks[0].spec, '任务原文')
  assert.equal(data.runs[0].tasks[0].updatedAt, '2026-11-11T03:00:00Z')
  assert.equal(data.currentWorkspace, 'repo::/one')
  assert.equal(data.more, true)
  assert.equal(data.runs[0].name, 'One')
  assert.equal(data.runs[0].tasks[0].title, 'Task')
  assert.equal(data.runs[0].workers[0].agent, 'codex')
  assert.equal(data.runs[0].workers[0].workspace, 'repo::/one')
  assert.equal(data.runs[0].workers[0].activity, 'working')
  assert.equal(data.runs[0].activeTaskCount, 1)
  assert.equal(data.runs[0].actionableMessageCount, 1)
  const content = await detail(target, call)
  assert.equal(content.source, 'transcript · 最近一轮')
  assert.match(content.text, /完整内容/)
  assert.equal(content.limited, true)
})
test('only supported owner actions; direct reply and old continuation reject before any CLI call', async () => {
  const { call, calls, terminal } = fixture()
  await assert.rejects(action({ ...target, kind: 'stop' } as never, call), /不支持/)
  await assert.rejects(action({ ...target, kind: 'reply', body: 'x', messageId: 'msg_one' } as never, call), /不支持/)
  assert.deepEqual(calls, [])
  await assert.rejects(action({ ...target, kind: 'continue', body: '' } as never, call), /不支持/)
  await assert.rejects(action({ ...target, dispatchId: 'ctx_wrong', kind: 'reassess' }, call), /不属于/)
  assert.equal(calls.some(c => ['send', 'reply', 'launch'].includes(c[1])), false)
  await action({ ...target, kind: 'open' }, call)
  assert.equal(calls.some(c => /stop|delete|abandon|release|task-update|run-use/.test(c[1])), false)
})

test('mention copies task and executor IDs without a Router binding or any message delivery', async () => {
  for (const coordinator of ['', 'term_router', 'orca_session_id:claude_router']) {
    const { call, calls } = fixture(coordinator)
    const copies: string[] = []
    const response = await action({ ...target, kind: 'mention' }, call, async text => { copies.push(text) })
    assert.equal(copies.length, 1)
    const reference = copies[0]
    assert.match(reference, /run=run_one.*task=task_one.*dispatch=ctx_one.*window=term_one.*workspace=repo::\/one/)
    assert.equal(/[\r\n]/.test(reference), false)
    assert.match(response.message, /已复制任务 task_one/)
    assert.equal(calls.some(c => ['send', 'switch', 'activate', 'run-use', 'task-update'].includes(c[1])), false)
  }
  const { call } = fixture()
  await assert.rejects(action({ ...target, kind: 'mention' }, call, async () => { throw new Error('剪贴板不可用') }), /剪贴板不可用/)
})

test('reopening the same list reuses the recent snapshot without repeating CLI collection', async () => {
  const { call, calls } = fixture()
  const first = await collect(20, call)
  const reads = calls.length
  assert.equal(await collect(20, call), first)
  assert.equal(calls.length, reads)
  await collect(20, call, undefined, '', true)
  assert.ok(calls.length > reads)
  const refreshed = calls.length
  await collect(20, call, undefined, 'different query')
  assert.ok(calls.length > refreshed)
  const context = { terminals: [{ id: 'term_one', title: 'before' }] }
  await collect(20, call, context)
  const contextual = calls.length
  context.terminals[0].title = 'after'
  await collect(20, call, context)
  assert.equal(calls.length, contextual)
})

test('history counts precede completed aliases and message-window trimming', async () => {
  const { call } = fixture()
  const data = await collect(20, async args => {
    if (args[0] === 'orchestration' && args[1] === 'task-list') return { tasks: ['completed', 'succeeded', 'success', 'done', 'failed', 'blocked'].map(status => ({ id: status, status })) }
    if (args[0] === 'orchestration' && args[1] === 'inbox') return { messages: Array.from({ length: 24 }, (_, i) => ({ id: i === 20 ? 'msg_stop_20' : `m${i}`, run_id: 'run_one', to_handle: 'run:run_one', read: i < 20, type: i >= 20 ? 'question' : 'info', subject: i === 21 ? 'Mail DID NOT REACH' : '', body: i === 22 ? 'WAITING ON A PROMPT' : 'note' })) }
    return call(args)
  })
  assert.equal(data.runs[0].tasks.length, 2)
  assert.equal(data.runs[0].completedTasks?.length, 4)
  assert.equal(data.runs[0].activeTaskCount, 0)
  assert.equal(data.runs[0].messages.length, 21)
  assert.equal(data.runs[0].actionableMessageCount, 1)
})

test('default detail shows the last user round and assistant text, without tool history', async () => {
  const { call, calls } = fixture()
  const message = (role: string, text: string) => ({ role, blocks: [{ type: 'text', text }] })
  const read = async (args: string[]) => args[1] === 'worker-read' ? {
    source: 'transcript', cursor: args.includes('50') ? 'older' : '', contentComplete: !args.includes('50'), transcript: { messages: [
      message('user', '旧问题'), message('assistant', '旧回答'), message('user', '最新问题'),
      { role: 'assistant', blocks: [{ type: 'tool-call', name: 'shell' }] },
      { role: 'tool', blocks: [{ type: 'tool-result', output: '大量工具输出' }] },
      message('reasoning', '内部推理'), message('assistant', '处理说明'), message('assistant', '最新回答'),
    ] },
  } : call(args)
  const latest = await detail(target, read)
  assert.equal(latest.text, 'user：最新问题\n\nassistant：处理说明\n\n最新回答')
  assert.equal(latest.limited, false)
  assert.equal(latest.cursor, '')
  assert.equal(latest.history, false)
  const history = await detail({ ...target, history: true }, read)
  assert.match(history.text, /旧问题/)
  assert.match(history.text, /大量工具输出/)
  assert.equal(history.cursor, 'older')
  const fixtureRead = await detail(target, call)
  assert.match(fixtureRead.text, /完整内容/)
  assert.equal(fixtureRead.history, false)
  assert.match(fixtureRead.warnings.join(' '), /未找到用户输入/)
  const request = calls.find(args => args[1] === 'worker-read')!
  assert.equal(request[request.indexOf('--limit') + 1], '32')
})

test('latest-round text budget keeps user context and the end of the latest answer', async () => {
  const { call } = fixture()
  const result = await detail(target, async args => args[1] === 'worker-read' ? {
    source: 'transcript', transcript: { messages: [
      { role: 'user', blocks: [{ type: 'text', text: '用户问题' + 'u'.repeat(20000) }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'a'.repeat(20000) + '最终答案' }] },
    ] },
  } : call(args))
  assert.ok(result.text.length <= 12000)
  assert.match(result.text, /^user：用户问题/)
  assert.match(result.text, /最终答案$/)
  assert.equal(result.limited, true)
  assert.match(result.warnings.join(' '), /截断/)
})

test('complete tail without a user input is labeled partial, never a complete round', async () => {
  const { call } = fixture()
  const content = await detail(target, async args => args[1] === 'worker-read' ? { source: 'transcript', transcript: { messages: [{ role: 'assistant', blocks: [{ type: 'text', text: '仅有回复' }] }] } } : call(args))
  assert.match(content.text, /仅有回复/)
  assert.equal(content.limited, true)
  assert.match(content.warnings.join(' '), /未找到用户输入/)
})

test('reassessment uses only the freshly bound Router mailbox with owner phrase and identifiers', async () => {
  const { call, calls, terminal } = fixture('term_router')
  await action({ ...target, kind: 'reassess' }, call)
  const send = calls.find(args => args[0] === 'orchestration' && args[1] === 'send')!
  assert.ok(send)
  assert.equal(send[send.indexOf('--to') + 1], 'run:run_one')
  assert.equal(send[send.indexOf('--body') + 1], '条件可能具备，请重新判断')
  assert.equal(send[send.indexOf('--subject') + 1], '条件可能具备，请重新判断')
  assert.deepEqual(JSON.parse(send[send.indexOf('--payload') + 1]), { source: 'osa-panel', runId: 'run_one', taskId: 'task_one', dispatchId: 'ctx_one' })
  assert.equal(calls.some(args => args[0] === 'terminal' && args[1] === 'send' || args[0] === 'agent'), false)
  terminal.connected = false
  await action({ ...target, kind: 'reassess' }, call)
  const nativeChat = fixture('orca_session_id:codex_router')
  assert.equal((await collect(20, nativeChat.call)).runs[0].canReassess, true)
  await action({ ...target, kind: 'reassess' }, nativeChat.call)
  assert.equal(nativeChat.calls.some(args => args[0] === 'terminal' && args[1] === 'send' || args[0] === 'agent'), false)
  const unbound = fixture()
  assert.equal((await collect(20, unbound.call)).runs[0].canReassess, false)
  await assert.rejects(action({ ...target, kind: 'reassess' }, unbound.call), /没有绑定/)
  assert.equal(unbound.calls.some(args => args[1] === 'send'), false)
})


test('native tail cursor and older-message limit do not hide the latest round', async () => {
  const { call } = fixture()
  for (const contentComplete of [true, false]) {
    const result = await detail(target, async args => args[1] === 'worker-read' ? {
      source: 'transcript', sourceExact: true, cursor: 'native-follow-new-output', contentComplete,
      transcript: { nextCursor: 'native-follow-new-output', limited: !contentComplete, messages: [
        { role: 'assistant', blocks: [{ type: 'text', text: '旧回答' }] },
        { role: 'user', blocks: [{ type: 'text', text: '尾部最新问题' }] },
        { role: 'tool', blocks: [{ type: 'tool-result', output: '不要展示工具内容' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: '尾部最新回答' }] },
      ] },
    } : call(args))
    assert.equal(result.text, 'user：尾部最新问题\n\nassistant：尾部最新回答')
    assert.equal(result.cursor, '')
    assert.equal(result.source, 'transcript · 最近一轮')
    assert.equal(result.warnings.some(warning => /未找到用户输入/.test(warning)), false)
  }
})


test('detail only includes messages belonging to this task despite a reused terminal', async () => {
  const { call } = fixture()
  const message = { run_id: 'run_one', type: 'info', from_handle: 'term_one', to_handle: 'run:run_one', body: '记录' }
  const result = await detail(target, async args => args[1] === 'inbox' ? { messages: [
    { ...message, id: 'own', payload: JSON.stringify({ taskId: 'task_one' }) },
    { ...message, id: 'other_task', payload: JSON.stringify({ taskId: 'task_other', dispatchId: 'ctx_one' }) },
    { ...message, id: 'other_dispatch', payload: JSON.stringify({ dispatchId: 'ctx_other' }) },
    { ...message, id: 'by_dispatch', payload: JSON.stringify({ dispatchId: 'ctx_one' }) },
    { ...message, id: 'legacy', payload: '{}' },
  ] } : call(args))
  assert.deepEqual(result.messages.map(message => message.id), ['own', 'by_dispatch', 'legacy'])
})


test('any later reverse-addressed same-thread message answers a question regardless of subject or type', async () => {
  const { call } = fixture()
  const question = { id: 'question', run_id: 'run_one', from_handle: 'term_one', to_handle: 'run:run_one', subject: '决定', body: '是否继续', type: 'question', read: true, delivered_at: '2026-11-11 03:00:00', created_at: '2026-11-11 03:00:00', thread_id: 'thread_root' }
  const response = { ...question, id: 'response', from_handle: 'run:run_one', to_handle: 'term_one', type: 'info', subject: '按计划继续', created_at: '2026-11-11 04:00:00' }
  for (const [reply, replied] of [
    [undefined, false], [response, true], [{ ...response, type: 'escalation', subject: '另一主题' }, true],
    [{ ...response, created_at: '2026-11-11 02:00:00' }, false], [{ ...response, created_at: question.created_at }, false],
    [{ ...response, from_handle: question.from_handle, to_handle: question.to_handle }, false],
    [{ ...response, thread_id: 'other_thread' }, false],
  ] as const) {
    const data = await collect(20, async args => args[1] === 'inbox' ? { messages: [question, ...(reply ? [reply] : [])] } : call(args))
    const message = data.runs[0].messages.find(message => message.id === 'question')!
    assert.equal(message.unread, false)
    assert.equal(message.deliveredAt, '2026-11-11T03:00:00Z')
    assert.equal(message.replied, replied)
    assert.equal(data.runs[0].actionableMessageCount, replied ? 0 : 1)
  }
})

test('panel reminders and queue-scan receipts do not become unanswered owner questions', async () => {
  const { call } = fixture()
  const base = { run_id: 'run_one', to_handle: 'run:run_one', type: 'question', read: false, body: '需要判断', created_at: '2026-11-11 03:00:00' }
  const data = await collect(20, async args => args[1] === 'inbox' ? { messages: [
    { ...base, id: 'panel', from_handle: 'term_one', payload: JSON.stringify({ source: 'osa-panel' }) },
    { ...base, id: 'self', from_handle: 'run:run_one' },
    { ...base, id: 'scan', from_handle: 'term_one', type: 'status', subject: 'queue-scan' },
    { ...base, id: 'real', from_handle: 'term_owner', subject: '需要判断' },
  ] } : call(args))
  assert.equal(data.runs[0].actionableMessageCount, 1)
})

test('task last update uses native update or latest dispatch/message, never creation; dispatch time is cached', async () => {
  const { call, calls } = fixture()
  const scoped = async (args: string[]) => args[1] === 'task-list' ? { tasks: [{ id: 'task_one', status: 'dispatched', dispatch_id: 'ctx_one', created_at: '2099-01-01 00:00:00' }] }
    : args[1] === 'inbox' ? { messages: [
      { id: 'own', run_id: 'run_one', type: 'status', payload: '{"taskId":"task_one"}', created_at: '2026-11-11 04:00:00' },
      { id: 'other', run_id: 'run_one', type: 'status', from_handle: 'term_one', payload: '{"taskId":"other"}', created_at: '2026-11-11 05:00:00' },
    ] } : call(args)
  const data = await collect(20, scoped)
  assert.equal(data.runs[0].tasks[0].updatedAt, '2026-11-11T04:00:00Z')
  const reads = calls.filter(args => args[1] === 'worker-show').length
  await collect(20, scoped, undefined, '', true)
  assert.equal(calls.filter(args => args[1] === 'worker-show').length, reads)
  const explicit = await collect(20, async args => args[1] === 'task-list' ? { tasks: [{ id: 'task_one', status: 'dispatched', dispatch_id: 'ctx_one', updated_at: '2026-11-11 06:00:00' }] } : scoped(args))
  assert.equal(explicit.runs[0].tasks[0].updatedAt, '2026-11-11T06:00:00Z')
  const unknown = await collect(20, async args => args[1] === 'inbox' ? { messages: [] } : args[1] === 'worker-show' ? Promise.reject(new Error('unavailable')) : scoped(args))
  assert.equal(unknown.runs[0].tasks[0].updatedAt, '')
  assert.match(unknown.warnings.join(' '), /派发时间读取失败/)
})


test('native Router and dispatch aliases verify a reply without accepting another dispatch', async () => {
  const { call } = fixture('orca_session_id:router')
  const question = { id: 'question', run_id: 'run_one', from_handle: 'term_one', to_handle: 'run:run_one', subject: '决定', type: 'escalation', read: true, created_at: '2026-11-11 03:00:00', payload: '{"taskId":"task_one","dispatchId":"ctx_one"}' }
  for (const destination of ['dispatch:ctx_one', 'dispatch:other']) {
    const data = await collect(20, async args => args[1] === 'inbox' ? { messages: [question,
      { id: 'answer', run_id: 'run_one', from_handle: 'orca_session_id:router', to_handle: destination, type: 'status', subject: 'Re: 决定', thread_id: 'question', created_at: '2026-11-11 04:00:00' },
    ] } : call(args))
    assert.equal(data.runs[0].messages.find(message => message.id === 'question')?.replied, destination === 'dispatch:ctx_one')
  }
})


test('blocked waiting evidence is captured before the list truncates task text', async () => {
  const { call } = fixture()
  const data = await collect(20, async args => args[1] === 'task-list' ? { tasks: [{ id: 'task_one', status: 'blocked', dispatch_id: 'ctx_one', spec: '背景资料'.repeat(100), result: '问题：' + '窗口是否可用'.repeat(90) + '？' }] } : call(args))
  assert.equal(data.runs[0].tasks[0].spec.length, 300)
  assert.match(data.runs[0].tasks[0].blockedQuestion || '', /^问题：.+？$/)
  assert.equal(data.runs[0].activeTaskCount, 0)
})


test('120 Runs use native pages no larger than 100 and retain the next cursor', async () => {
  const { call } = fixture()
  const pages: number[] = []
  const data = await collect(120, async args => {
    if (args[1] !== 'run-list') return call(args)
    const size = Number(args[args.indexOf('--limit') + 1]); pages.push(size)
    assert.ok(size <= 100)
    const start = args.includes('--cursor') ? Number(args[args.indexOf('--cursor') + 1]) : 0
    return { runs: Array.from({ length: size }, (_, index) => ({ id: `run_${start + index}`, objective: '历史' })), nextCursor: String(start + size) }
  })
  assert.deepEqual(pages, [100, 20])
  assert.equal(data.runs.length, 120)
  assert.equal(data.more, true)
})

test('system receipt evidence beyond the 300-character list excerpt remains classified', async () => {
  const { call } = fixture()
  const data = await collect(20, async args => args[1] === 'inbox' ? { messages: [{ id: 'receipt_long', run_id: 'run_one', from_handle: 'term_one', to_handle: 'run:run_one', type: 'question', body: '原文'.repeat(160) + ' did not reach the worker' }] } : call(args))
  assert.equal(data.runs[0].messages[0].body.length, 300)
  assert.equal(data.runs[0].messages[0].systemReceipt, true)
  assert.equal(data.runs[0].actionableMessageCount, 0)
})
