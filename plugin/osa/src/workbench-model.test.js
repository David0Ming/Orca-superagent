import { test, assert } from 'orca/testing'
import { buildWorkbench, dateKey, groupTopics } from './workbench-model.js'

const first = { id: 'one', source: 'panel', human: true, text: '原话', at: '2026-11-07T15:59:00Z', meta: { projectId: 'p' }, channel: { source: 'panel', thread: 'one' } }
const follow = { id: 'two', source: 'panel', human: true, text: '补充', at: '2026-11-07T16:01:00Z', meta: { ticketId: 't' } }
const report = { state: 'progress', at: '2026-11-07T16:02:00Z', summary: '进展' }
const ticket = { id: 't', title: '任务', origin: { triggerIds: ['one'] }, inputs: [{ id: 'i', kind: 'trigger', triggerId: 'two', readAt: '2026-11-07T16:02:00Z' }], assignments: [{ id: 'a', report }] }
const status = () => ({ tickets: [ticket], triggers: [first, follow], projects: { projects: [{ id: 'p', name: '项目' }], tasks: [{ ticket, context: { target: { projectId: 'p' }, targets: [{ repository: '/repo' }], workspaces: [{ directory: '/one', name: 'branch', worktreeId: 'wt1' }, { directory: '/two', worktreeId: 'wt2' }] } }] },
  reportReceipts: [{ ticketId: 't', assignmentId: 'a', result: { assignments: [{ id: 'a', report: { ...report, summary: '同毫秒进展' } }] } }],
  outbox: [{ ticketId: 't', text: '进展', createdAt: '2026-11-07T16:03:00Z', status: 'sent' }, { ticketId: 't', text: '旧回复', status: 'sent' }],
  inputResolutions: [{ ticketId: 't', inputId: 'i', state: 'progress', summary: '已处理' }], windowLinks: [{ ticketId: 't', sessionId: 'chat' }], routingHistory: [{ id: 'd', ticketId: 't', at: '2026-11-07T16:00:00Z', kind: 'accept', reason: [{ message: '接受' }] }] })

  test('groups one persistent topic across actual activity days in the owner timezone', () => {
    assert.equal(dateKey(first.at, 'Asia/Singapore'), '2026-11-07')
    assert.equal(dateKey(follow.at, 'Asia/Singapore'), '2026-11-08')
    const model = buildWorkbench(status(), { timeZone: 'Asia/Singapore' })
    assert.equal(model.uniqueCount, 1)
    assert.equal(model.aliases['request:one'], 'ticket:t')
    assert.equal(model.aliases['request:two'], 'ticket:t')
    const topic = model.topics[0]
    assert.equal(topic.originDay, '2026-11-07')
    assert.deepEqual(topic.activityDays, ['2026-11-07', '2026-11-08'])
    const groups = groupTopics(model.topics, { by: 'date' })
    assert.equal(groups.uniqueCount, 1)
    assert.deepEqual(groups.groups.map(group => group.topics[0].id), ['ticket:t', 'ticket:t'])
    const projects = groupTopics(model.topics, { by: 'project' })
    assert.equal(projects.groups[0].count, 1)
    assert.equal(projects.groups[0].groups.length, 2)
    assert.deepEqual(groupTopics(model.topics, { by: 'worktree' }).groups.map(group => group.id), ['wt1', 'wt2'])
  })

  test('preserves same-time different reports, delivery status, resolution and unknown time', () => {
    const topic = buildWorkbench(status(), { timeZone: 'Asia/Singapore' }).topics[0]
    assert.equal(topic.conversation.filter(item => item.kind === 'report').length, 2)
    assert.equal(topic.conversation.find(item => item.text === '进展')?.deliveries[0].status, 'sent')
    assert.equal(topic.conversation.find(item => item.text === '旧回复')?.at, null)
    assert.equal(topic.conversation.find(item => item.text === '补充')?.resolution.summary, '已处理')
    assert.equal(topic.conversation.find(item => item.kind === 'decision')?.decision.kind, 'accept')
    assert.ok(topic.historyLimitations.join(' ').includes('时间'))
    assert.ok(topic.historyLimitations.join(' ').includes('窗口'))
  })

  test('keeps pending, ignored queries and unknown association without inventing activity', () => {
    const query = { ...first, id: 'query', text: '查询', at: undefined, channel: { source: 'panel', thread: 'query' }, meta: {} }
    const model = buildWorkbench({ tickets: [], triggers: [query], routingHistory: [{ id: 'ignore', kind: 'ignore', triggerIds: ['query'] }], triggerDispositions: [{ triggerId: 'query', decisionId: 'ignore' }], outbox: [{ id: 'reply', kind: 'reply', status: 'sent', channel: query.channel, text: '答复' }], projects: { projects: [], tasks: [] }, observedAt: '2026-11-08T00:00:00Z' }, { timeZone: 'Asia/Singapore' })
    assert.equal(model.topics.length, 1)
    assert.equal(model.topics[0].id, 'request:query')
    assert.equal(model.topics[0].projectId, null)
    assert.equal(model.topics[0].originDay, null)
    assert.deepEqual(model.topics[0].activityDays, [])
    assert.deepEqual(model.topics[0].worktrees, [])
    assert.equal(model.topics[0].conversation.some(item => item.text === '答复' && item.message.status === 'sent'), true)
    assert.equal(groupTopics(model.topics, { by: 'date' }).groups[0].id, 'unknown')
    assert.equal(groupTopics(model.topics, { by: 'worktree' }).groups[0].id, 'unknown')
  })

test('keeps an entry project and its comments when routed to another project', () => {
  const comment = { id: 'comment', source: 'panel', human: true, text: '接单前补充', at: '2026-11-07T16:00:30Z', meta: { projectId: 'p', topicTriggerId: 'one' } }
  const pending = buildWorkbench({ tickets: [], triggers: [first, comment], projects: { projects: [{ id: 'p', name: '项目 A' }] } }, { timeZone: 'Asia/Singapore' })
  assert.equal(pending.topics.length, 1)
  assert.equal(pending.aliases['request:comment'], 'request:one')
  assert.ok(pending.topics[0].conversation.map(item => item.text).includes('接单前补充'))
  const routed = status()
  routed.triggers.push(comment)
  routed.projects.projects.push({ id: 'b', name: '项目 B' })
  routed.projects.tasks[0].context.target.projectId = 'b'
  const model = buildWorkbench(routed, { timeZone: 'Asia/Singapore' })
  assert.equal(model.uniqueCount, 1)
  assert.equal(model.aliases['request:comment'], 'ticket:t')
  assert.equal(model.topics[0].id, 'ticket:t')
  assert.equal(model.topics[0].projectId, 'b')
  assert.deepEqual(model.topics[0].entryProjectIds, ['p'])
  assert.equal(model.topics[0].originDay, '2026-11-07')
  assert.ok(model.topics[0].conversation.map(item => item.text).includes('接单前补充'))
  const grouped = groupTopics(model.topics, { by: 'project' })
  assert.equal(grouped.uniqueCount, 1)
  assert.deepEqual(grouped.groups.map(group => group.id).sort(), ['b', 'p'])
  for (const group of grouped.groups) {
    assert.equal(group.topics[0].id, 'ticket:t')
    assert.equal(group.groups.find(day => day.id === '2026-11-07')?.topics[0].id, 'ticket:t')
    assert.equal(group.groups.find(day => day.id === '2026-11-08')?.topics[0].id, 'ticket:t')
  }
})

test('preserves router intake as pending then aliases it to the accepted ticket without guessing shared replies', () => {
  const request = { id: 'router-1', source: 'router', human: true, at: first.at, text: '聊天请求', meta: {}, channel: { source: 'router', thread: 'shared' } }
  const pending = buildWorkbench({ triggers: [request], outbox: [{ id: 'unlinked', kind: 'reply', channel: request.channel, text: '谁的回复未知' }] }, { timeZone: 'Asia/Singapore' })
  assert.equal(pending.topics.length, 1)
  assert.equal(pending.topics[0].projectId, null)
  assert.equal(pending.topics[0].conversation.some(item => item.text === '谁的回复未知'), false)
  assert.ok(pending.topics[0].historyLimitations.join(' ').includes('无法可靠归属'))
  const accepted = { ...ticket, origin: { triggerIds: [request.id] }, inputs: [] }
  const model = buildWorkbench({ tickets: [accepted], triggers: [request], projects: { projects: [{ id: 'p', name: 'P' }], tasks: [{ ticket: accepted, context: { target: { projectId: 'p' } } }] } }, { timeZone: 'Asia/Singapore' })
  assert.equal(model.topics.length, 1)
  assert.equal(model.aliases['request:router-1'], 'ticket:t')
  assert.equal(model.topics[0].projectId, 'p')
})

test('preserves routing reasons and pre-accept exact panel replies on the accepted topic', () => {
  const data = status()
  data.routingHistory[0].reason = [{ code: 'said', values: { text: '真实路由理由' } }]
  data.routingAttachments = [{ ticketId: 't', triggerId: 'two', reason: '关联原因', at: '2026-11-08T16:00:00Z' }]
  data.outbox.push({ id: 'before', kind: 'reply', text: '接单前解释', createdAt: '2026-11-07T15:59:30Z', channel: first.channel }, { id: 'other', kind: 'reply', text: '不相关', createdAt: first.at, channel: { source: 'panel', thread: 'other' } })
  const topic = buildWorkbench(data, { timeZone: 'Asia/Singapore' }).topics[0]
  assert.equal(topic.conversation.find(item => item.kind === 'decision').text, '真实路由理由')
  assert.equal(topic.conversation.find(item => item.kind === 'routingAttachment').text, '关联原因')
  assert.ok(topic.activityDays.includes('2026-11-09'))
  assert.equal(topic.conversation.filter(item => item.text === '接单前解释').length, 1)
  assert.equal(topic.conversation.some(item => item.text === '不相关'), false)
})

test('accepting a pre-accept comment retains the original request and date', () => {
  const comment = { ...follow, id: 'comment', meta: { projectId: 'p', topicTriggerId: 'one' } }
  const accepted = { ...ticket, origin: { triggerIds: ['comment'] }, inputs: [] }
  const model = buildWorkbench({ tickets: [accepted], triggers: [first, comment] }, { timeZone: 'Asia/Singapore' })
  assert.equal(model.topics.length, 1)
  assert.equal(model.aliases['request:one'], 'ticket:t')
  assert.equal(model.topics[0].originDay, '2026-11-07')
  assert.equal(model.topics[0].draftTopicId, 'one')
  assert.ok(model.topics[0].conversation.some(item => item.text === '原话'))
})

test('uses explicit trigger identity to separate replies in a shared Router thread before and after acceptance', () => {
  const one = { id: 'router-one', source: 'router', human: true, text: '请求一', at: first.at, meta: {}, channel: { source: 'router', thread: 'shared' } }
  const two = { ...one, id: 'router-two', text: '请求二' }
  const mail = [
    { id: 'm1', kind: 'reply', triggerId: one.id, channel: one.channel, text: '回复一', createdAt: first.at },
    { id: 'm2', kind: 'reply', triggerId: two.id, channel: two.channel, text: '回复二', createdAt: first.at },
  ]
  const pending = buildWorkbench({ triggers: [one, two], outbox: mail })
  assert.equal(pending.topics.length, 2)
  assert.deepEqual(pending.topics.map(topic => topic.conversation.filter(item => item.kind === 'reply').map(item => item.text)), [['回复一'], ['回复二']])
  assert.equal(pending.topics[0].historyLimitations.some(text => text.includes('无法可靠归属')), false)
  const accepted = { ...ticket, origin: { triggerIds: [one.id] }, inputs: [] }
  const after = buildWorkbench({ tickets: [accepted], triggers: [one, two], outbox: mail })
  assert.equal(after.aliases['request:router-one'], 'ticket:t')
  assert.deepEqual(after.topics.find(topic => topic.id === 'ticket:t').conversation.filter(item => item.kind === 'reply').map(item => item.text), ['回复一'])
  assert.deepEqual(after.topics.find(topic => topic.id === 'request:router-two').conversation.filter(item => item.kind === 'reply').map(item => item.text), ['回复二'])
})

test('a handed-back comment cannot steal the original topic alias from its owning ticket', () => {
  const child = { ...follow, id: 'out', text: '交回的补充', meta: { projectId: 'p', topicTriggerId: 'one' } }
  const other = { ...first, id: 'other', text: 'B 原始要求' }
  const a = { ...ticket, id: 'A', origin: { triggerIds: ['one'] }, inputs: [{ id: 'input-a', kind: 'trigger', triggerId: 'out' }] }
  const b = { ...ticket, id: 'B', origin: { triggerIds: ['other'] }, inputs: [{ id: 'input-b', kind: 'trigger', triggerId: 'out' }] }
  for (const tickets of [[a, b], [b, a]]) {
    const model = buildWorkbench({ tickets, triggers: [first, other, child] })
    assert.equal(model.uniqueCount, 2)
    assert.equal(model.aliases['request:one'], 'ticket:A')
    assert.equal(model.aliases['request:out'], 'ticket:A')
    assert.equal(model.aliases['request:other'], 'ticket:B')
    assert.ok(model.topics.find(topic => topic.id === 'ticket:A').conversation.some(item => item.text === '原话'))
    assert.ok(model.topics.find(topic => topic.id === 'ticket:B').conversation.some(item => item.text === '交回的补充'))
  }
  const newB = { ...b, origin: { triggerIds: ['out'] }, inputs: [] }
  const model = buildWorkbench({ tickets: [a, newB], triggers: [first, child] })
  assert.equal(model.aliases['request:one'], 'ticket:A')
  assert.equal(model.aliases['request:out'], 'ticket:B')
  assert.equal(model.topics.find(topic => topic.id === 'ticket:B').draftTopicId, 'out')
  assert.equal(model.topics.find(topic => topic.id === 'ticket:B').originDay, dateKey(child.at))
  assert.equal(model.uniqueCount, 2)
})
