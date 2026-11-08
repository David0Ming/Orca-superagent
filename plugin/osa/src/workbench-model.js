const rows = value => Array.isArray(value) ? value : []
const valid = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
export function dateKey(value, timeZone) {
  if (!valid(value)) return null
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  const part = name => parts.find(item => item.type === name)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function buildWorkbench(status = {}, { timeZone } = {}) {
  const tickets = rows(status.tickets), triggers = rows(status.triggers), decisions = rows(status.routingHistory)
  const projects = rows(status.projects?.projects), taskRows = rows(status.projects?.tasks)
  const aliases = {}, used = new Set()
  for (const ticket of tickets) for (const id of rows(ticket.origin?.triggerIds)) {
    used.add(id)
    aliases[`request:${id}`] ??= `ticket:${ticket.id}`
  }
  for (const trigger of triggers) if (trigger.meta?.topicTriggerId && aliases[`request:${trigger.id}`]) {
    used.add(trigger.meta.topicTriggerId)
    aliases[`request:${trigger.meta.topicTriggerId}`] ??= aliases[`request:${trigger.id}`]
  }
  for (const ticket of tickets) for (const id of rows(ticket.inputs).map(input => input.triggerId).filter(Boolean)) {
    used.add(id)
    const trigger = triggers.find(item => item.id === id)
    aliases[`request:${id}`] ??= aliases[`request:${trigger?.meta?.topicTriggerId}`] || `ticket:${ticket.id}`
  }
  for (const trigger of triggers) if (trigger.meta?.topicTriggerId && aliases[`request:${trigger.meta.topicTriggerId}`]) {
    used.add(trigger.id)
    aliases[`request:${trigger.id}`] ??= aliases[`request:${trigger.meta.topicTriggerId}`]
  }
  const makeTopic = (ticket, original) => {
    const ticketId = ticket?.id, ids = new Set(ticket ? [...rows(ticket.origin?.triggerIds), ...rows(ticket.inputs).map(input => input.triggerId).filter(Boolean)] : [original.id])
    const originalIds = (ticket ? rows(ticket.origin?.triggerIds) : [original.id]).map(id => {
      const parent = triggers.find(trigger => trigger.id === id)?.meta?.topicTriggerId
      return parent && (!ticket || aliases[`request:${parent}`] === `ticket:${ticketId}`) ? parent : id
    })
    for (const id of originalIds) ids.add(id)
    for (const trigger of triggers) if (originalIds.includes(trigger.meta?.topicTriggerId)) ids.add(trigger.id)
    const originals = originalIds.map(id => triggers.find(trigger => trigger.id === id)).filter(Boolean)
    const context = taskRows.find(row => row.ticket?.id === ticketId)?.context || {}
    const projectId = context.target?.projectId || original?.meta?.projectId || null
    const projectName = projects.find(project => project.id === projectId)?.name || (projectId ? projectId : '未关联项目')
    const entryProjectIds = [...new Set(originals.map(trigger => trigger.meta?.projectId).filter(Boolean))]
    const entryProjects = entryProjectIds.map(id => ({ id, name: projects.find(project => project.id === id)?.name || id }))
    const conversation = []
    for (const trigger of triggers.filter(trigger => ids.has(trigger.id))) {
      const input = rows(ticket?.inputs).find(item => item.triggerId === trigger.id)
      conversation.push({ kind: 'trigger', at: trigger.at || null, text: trigger.text || '', trigger, input,
        resolution: input && rows(status.inputResolutions).find(item => item.inputId === input.id) })
    }
    for (const input of rows(ticket?.inputs).filter(input => input.kind !== 'trigger' && input.text))
      conversation.push({ kind: 'input', at: input.at || null, text: input.text, input, resolution: rows(status.inputResolutions).find(item => item.inputId === input.id) })
    for (const decision of decisions.filter(decision => ticketId && decision.ticketId === ticketId || rows(decision.triggerIds).some(id => ids.has(id))))
      conversation.push({ kind: 'decision', at: decision.at || null, text: rows(decision.reason).map(reason => reason.values?.text || reason.message || reason.code || String(reason)).join('；'), decision })
    for (const attachment of rows(status.routingAttachments).filter(item => item.ticketId === ticketId))
      conversation.push({ kind: 'routingAttachment', at: attachment.at || null, text: attachment.reason || '', attachment })
    const reports = new Map()
    for (const receipt of rows(status.reportReceipts).filter(receipt => receipt.ticketId === ticketId)) {
      const assignment = rows(receipt.result?.assignments).find(item => item.id === receipt.assignmentId)
      if (assignment?.report) reports.set(JSON.stringify([assignment.id, assignment.report]), { assignmentId: assignment.id, report: assignment.report })
    }
    for (const assignment of rows(ticket?.assignments)) if (assignment.report)
      reports.set(JSON.stringify([assignment.id, assignment.report]), { assignmentId: assignment.id, report: assignment.report })
    const reportItems = [...reports.values()].map(({ assignmentId, report }) => ({ kind: 'report', at: report.at || null, text: report.summary || '', assignmentId, report, deliveries: [] }))
    conversation.push(...reportItems)
    const threadMatches = message => message.kind === 'reply' && originals.some(trigger => trigger.source === 'panel' && trigger.channel?.source && trigger.channel?.thread && message.channel?.source === trigger.channel.source && message.channel?.thread === trigger.channel.thread)
    const messages = rows(status.outbox).filter(message => (ticketId && message.ticketId === ticketId) || (!message.ticketId && (message.triggerId ? ids.has(message.triggerId) : threadMatches(message))))
      .filter((message, index, all) => !message.id || all.findIndex(other => other.id === message.id) === index)
    for (const message of messages) {
      const matching = reportItems.filter(item => item.text && item.text === message.text)
      if (valid(message.createdAt) && matching.length === 1) matching[0].deliveries.push(message)
      else conversation.push({ kind: 'reply', at: message.createdAt || null, text: message.text || '', message })
    }
    conversation.sort((a, b) => (valid(a.at) ? Date.parse(a.at) : Infinity) - (valid(b.at) ? Date.parse(b.at) : Infinity))
    const originDay = dateKey(originals[0]?.at, timeZone)
    const activityDays = [...new Set(conversation.flatMap(item => [item.at, ...rows(item.deliveries).map(delivery => delivery.createdAt)].map(at => dateKey(at, timeZone)).filter(Boolean)))].sort()
    const historyLimitations = ['仅显示 OSA 已记录的交流；不代表完整原生会话。']
    if (conversation.some(item => !valid(item.at))) historyLimitations.push('部分记录缺少有效时间。')
    const windows = rows(status.windowLinks).filter(link => link.ticketId === ticketId)
    if (rows(status.outbox).some(message => !message.ticketId && !message.triggerId && message.kind === 'reply' && originals.some(trigger => trigger.source === 'router' && trigger.channel?.source && trigger.channel?.thread && trigger.channel.source === message.channel?.source && trigger.channel.thread === message.channel?.thread))) historyLimitations.push('共享 Router 会话的未关联回复无法可靠归属到单个请求。')
    if (windows.length) historyLimitations.push('关联窗口仅显示元数据；历史需按需查看。')
    return { id: ticket ? `ticket:${ticketId}` : `request:${original.id}`, ...(ticket ? { ticketId, ticket } : { triggerId: original.id, trigger: original }),
      draftTopicId: originalIds[0] || null, title: ticket?.title || original?.text || (rows(original?.meta?.attachments).length ? `附件：${original.meta.attachments.map(file => file.name).join('、')}` : '未命名请求'), projectId, projectName, entryProjectIds, entryProjects, originDay, activityDays, conversation,
      worktrees: rows(context.workspaces).filter(workspace => workspace.directory || workspace.worktreeId), targets: rows(context.targets), windows,
      publications: rows(status.publications).filter(publication => publication.ticketId === ticketId), historyLimitations }
  }
  const topics = tickets.map(ticket => makeTopic(ticket, null))
  for (const trigger of triggers) if (['panel', 'router'].includes(trigger.source) && trigger.human && !trigger.meta?.ticketId && !trigger.meta?.topicTriggerId && !used.has(trigger.id)) {
    topics.push(makeTopic(null, trigger))
    for (const comment of triggers.filter(item => item.meta?.topicTriggerId === trigger.id)) aliases[`request:${comment.id}`] = `request:${trigger.id}`
  }
  return { topics, aliases, uniqueCount: topics.length }
}

export function groupTopics(topics, { by = 'date' } = {}) {
  const group = (id, label) => ({ id, label, count: 0, topics: [] })
  const dates = list => {
    const groups = new Map()
    for (const topic of list) for (const day of new Set([topic.originDay, ...topic.activityDays].filter(Boolean))) {
      if (!groups.has(day)) groups.set(day, group(day, day))
      groups.get(day).topics.push(topic)
    }
    for (const topic of list.filter(item => !item.originDay && !item.activityDays.length)) {
      if (!groups.has('unknown')) groups.set('unknown', group('unknown', '时间未知'))
      groups.get('unknown').topics.push(topic)
    }
    return [...groups.values()].sort((a, b) => a.id === 'unknown' ? 1 : b.id === 'unknown' ? -1 : b.id.localeCompare(a.id)).map(item => ({ ...item, count: new Set(item.topics.map(topic => topic.id)).size }))
  }
  if (by === 'date') return { groups: dates(topics), uniqueCount: new Set(topics.map(topic => topic.id)).size }
  const groups = new Map()
  for (const topic of topics) {
    const keys = by === 'project' ? [...new Map([{ id: topic.projectId || 'unknown', label: topic.projectName }, ...topic.entryProjects.map(project => ({ id: project.id, label: project.name }))].map(item => [item.id, item])).values()] : topic.worktrees.length ? topic.worktrees.map(tree => ({ id: tree.worktreeId || tree.directory, label: tree.directory || tree.worktreeId })) : [{ id: 'unknown', label: '工作区未知' }]
    for (const key of keys) {
      if (!groups.has(key.id)) groups.set(key.id, group(key.id, key.label))
      if (!groups.get(key.id).topics.some(item => item.id === topic.id)) groups.get(key.id).topics.push(topic)
    }
  }
  return { groups: [...groups.values()].map(item => ({ ...item, count: item.topics.length, ...(by === 'project' ? { groups: dates(item.topics) } : {}) })), uniqueCount: new Set(topics.map(topic => topic.id)).size }
}
