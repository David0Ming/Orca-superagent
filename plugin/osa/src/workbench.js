import { buildWorkbench, groupTopics, dateKey } from './workbench-model.js'

const $ = id => document.getElementById(id)
const list = $('list'), detail = $('detail'), composer = $('composer'), message = $('message'), notice = $('notice')
let draftWrites = Promise.resolve()
let status = null, model = { topics: [], aliases: {}, uniqueCount: 0 }, selected = '', view = 'project', connected = false, busy = false, drafts = {}, selections = {}, collapsed = new Set(), timer, refreshId = 0
const storageKey = 'workbench-drafts-v1'
const draftKey = (kind, id) => JSON.stringify([status?.stateDir || '', kind, id])
const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
const call = (action, options = {}) => window.orca.plugin.request('osa.call', { action, options, ...(action === 'status' ? {} : { stateDir: status?.stateDir }) }, { timeoutMs: action.startsWith('window') ? 120000 : 30000 })
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = String(text); if (className) el.className = className; return el }
function say(text) { notice.textContent = text; notice.hidden = !text }
function saveDraft(key, text) {
  const old = drafts[key]
  drafts[key] = { text, id: old?.text === text ? old.id : id() }
  const snapshot = structuredClone(drafts)
  draftWrites = draftWrites.catch(() => {}).then(() => window.orca.storage.set(storageKey, snapshot)).catch(e => say(`草稿保存失败：${e.message || e}`))
}
function topicDraftKey(topic) { return draftKey('topic', topic.draftTopicId || topic.triggerId || topic.id) }
function topicHasCandidate(topic) { const ids = new Set((topic.conversation || []).map(m => m.trigger?.id).filter(Boolean)); return (status?.candidates || []).some(c => c.triggers?.some(t => ids.has(t.id) || t.id === topic.triggerId || model.aliases?.[`request:${t.id}`] === topic.id)) }
function topicState(topic) {
  const t = topic.ticket, report = t?.assignments?.at(-1)?.report
  if (t?.attention || t?.delivery || (!t?.ended && ['blocked', 'failed'].includes(report?.state))) return 'attention'
  if (t?.ended) return 'ended'
  if (!t) { const decision = (topic.conversation || []).filter(m => m.kind === 'decision').at(-1); const active = topicHasCandidate(topic); if (!active && decision?.decision?.kind === 'unavailable') return 'attention'; if (!active && (decision?.decision?.kind === 'ignore' || (topic.conversation || []).some(m => m.kind === 'reply' && m.message?.status === 'sent'))) return 'ended'; return 'pending' }
  if (!t.assignments?.length || t.assignments.at(-1).state === 'pending') return 'pending'
  return 'working'
}
function stateText(topic) {
  const t = topic.ticket, report = t?.assignments?.at(-1)?.report
  if (!t && topic.triggerId) { if (topicHasCandidate(topic)) return '等待 Router 处理'; const replies = (topic.conversation || []).filter(m => m.kind === 'reply'); const decision = (topic.conversation || []).filter(m => m.kind === 'decision').at(-1); if (replies.some(m => m.message?.status === 'sent')) return '已回复'; if (decision?.decision?.kind === 'unavailable') return '路由未能完成'; if (decision?.decision?.kind === 'ignore') return '已处理'; return '等待 Router 处理' }
  if (t?.attention) return '等待回答'
  if (t?.delivery) return '投递失败'
  if (t?.ended) return ({ completed: '已完成', stopped: '已停止', merged: '已合并', dropped: '已放弃', closed: '已关闭' })[t.ended.outcome] || `已结束 · ${t.ended.outcome}`
  return ({ waiting: '等待中', ready: '结果就绪', blocked: '受阻', failed: '失败', progress: '进行中' })[report?.state] || (t?.assignments?.at(-1)?.state === 'running' ? '执行中' : '待处理')
}
function findTopic() { return model.topics.find(t => t.id === selected || t.id === model.aliases?.[selected] || t.aliases?.includes(selected)) }
async function refresh() {
  const request = ++refreshId
  try {
    const next = await call('status')
    if (request !== refreshId) return
    const changedDirectory = status?.stateDir !== next.stateDir
    status = next; connected = true; model = buildWorkbench(next, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date() })
    if (changedDirectory) { selected = selections[next.stateDir] || ''; list.replaceChildren(); detail.replaceChildren(); message.dataset.key = ''; message.value = ''; $('layout').classList.remove('show-detail') }
    if (model.aliases?.[selected]) selected = model.aliases[selected]
    if (!model.topics.some(t => t.id === selected)) selected = (model.topics.find(t => topicState(t) === 'attention') || model.topics[0])?.id || ''
    const health = next.routerHealth
    say(!health?.binding ? 'Router 尚未绑定，已保存的请求等待处理。' : health.health?.state === 'unavailable' ? 'Router 暂时不可用，已保存的请求仍可查看。' : '')
    render()
  } catch (e) { if (request !== refreshId) return; connected = false; say(`无法连接 OSA 服务${status ? '；显示上次读取的记录。' : '，请在侧栏设置状态目录。'} ${e.message || e}`); render() }
}
function showTopic(topic) {
  selected = topic.id
  selections[status.stateDir] = selected
  void window.orca.storage.set('workbench-selection-v1', selections).catch(e => say(`无法保存选中项：${e.message || e}`))
  $('layout').classList.add('show-detail')
  render()
}
function inlineForm(projectId, day) {
  const sourceDir = status?.stateDir
  const form = node('form', null, 'inline-form'), input = node('input'), button = node('button', '提出请求')
  input.placeholder = '添加今天的请求…'; input.setAttribute('aria-label', '添加今天的请求')
  const key = draftKey('new', projectId), draft = drafts[key]; input.value = draft?.text || ''
  input.addEventListener('input', () => saveDraft(key, input.value))
  button.type = 'submit'; button.disabled = !connected || busy || !projectId || projectId === 'unknown'
  form.append(input, button)
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (!connected || busy || status?.stateDir !== sourceDir) { say('连接已变化，请在当前项目重新提交。'); return }
    if (!input.value.trim()) return
    const sent = drafts[key]; busy = true; button.disabled = true
    try { const result = await call('request', { id: sent.id, project: projectId, text: sent.text }); if (drafts[key]?.id === sent.id) saveDraft(key, ''); selected = `request:${result.id}`; await refresh() }
    catch (err) { say(`提交失败，草稿已保留：${err.message || err}`) }
    finally { busy = false; button.disabled = !connected }
  })
  return form
}
function renderGroup(group, container, level = 0, sourceProject = '') {
  const section = node('section', null, 'group'), key = `${view}:${sourceProject}:${group.id}`, heading = node('button', null, 'group-head')
  const today = dateKey(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone)
  const label = group.id === today && (view === 'date' || level > 0) ? `今天 · ${group.label}` : group.label || '未知'
  heading.type = 'button'; heading.title = label; heading.setAttribute('aria-expanded', String(!collapsed.has(key)))
  heading.append(node('span', collapsed.has(key) ? '›' : '⌄', 'chevron'), node('span', label), node('span', group.count || '', 'group-count'))
  heading.onclick = () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); renderList() }
  section.append(heading)
  if (!collapsed.has(key)) {
    if (group.groups?.length || view === 'project' && level === 0) {
      const groups = [...(group.groups || [])]
      if (view === 'project' && level === 0 && group.id !== 'unknown') { const index = groups.findIndex(g => g.id === today); if (index < 0) groups.unshift({ id: today, label: today, topics: [], count: 0 }); else groups.unshift(groups.splice(index, 1)[0]) }
      groups.forEach(g => renderGroup(g, section, level + 1, level === 0 ? group.id : sourceProject))
    } else for (const topic of group.topics || []) {
      const row = node('button', null, 'task'); row.type = 'button'; row.dataset.state = topicState(topic); row.setAttribute('aria-current', String(findTopic()?.id === topic.id))
      const dot = node('span', null, 'dot'), content = node('span', null, 'task-main')
      const day = view === 'date' || view === 'project' && level === 1 ? group.id : null
      const latest = [...(topic.conversation || [])].reverse().find(m => m.text && m.at && Number.isFinite(Date.parse(m.at)) && (!day || dateKey(m.at, Intl.DateTimeFormat().resolvedOptions().timeZone) === day))
      const time = latest ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(latest.at)) : ''
      const route = sourceProject && topic.projectId && sourceProject !== topic.projectId ? `已路由至 ${topic.projectName} · ` : ''
      const title = node('span', topic.title || '未命名请求', 'task-title'); title.title = topic.title || '未命名请求'
      dot.setAttribute('aria-hidden', 'true'); content.append(title, node('span', stateText(topic), 'pill'), node('span', `${route}${latest?.text || ''}`, 'task-preview'), node('span', time, 'task-time'))
      row.append(dot, content); row.addEventListener('click', () => showTopic(topic)); section.append(row)
    }
    if (view === 'project' && level === 1 && group.id === today && sourceProject && sourceProject !== 'unknown') section.append(inlineForm(sourceProject))
  }
  container.append(section)
}
function renderList() {
  if (list.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return
  list.replaceChildren()
  const q = $('search').value.trim().toLocaleLowerCase()
  const topics = model.topics.filter(t => (!q || JSON.stringify([t.title, t.projectName, t.entryProjects, t.worktrees, t.conversation?.map(m => m.text)]).toLocaleLowerCase().includes(q)) && ($('filter').value === 'all' || $('filter').value === topicState(t)))
  const result = groupTopics(topics, { by: view })
  const taskCount = model.topics.filter(t => t.ticketId).length, requestCount = model.topics.length - taskCount
  $('count').textContent = `${taskCount} 项任务${requestCount ? ` · ${requestCount} 项请求` : ''}`
  if (view === 'project' && !q && $('filter').value === 'all') for (const project of status?.projects?.projects || []) if (!result.groups.some(g => g.id === project.id)) result.groups.push({ id: project.id, label: project.name, topics: [], groups: [] })
  if (!result.groups.length) list.append(node('div', status ? '没有匹配的任务。' : '正在读取任务…', 'placeholder'))
  for (const group of result.groups) renderGroup(group, list)
}
function addLink(parent, label, url) {
  if (!/^https?:\/\//i.test(url || '')) return
  const button = node('button', label); button.type = 'button'; button.addEventListener('click', async () => { try { const result = await window.orca.shell.openExternal(url); if (result?.opened === false) say('未打开链接。') } catch (e) { say(`无法打开链接：${e.message || e}`) } }); parent.append(button)
}
function renderDetail() {
  const topic = findTopic(), active = document.activeElement === message
  if (!topic) { detail.replaceChildren(node('div', '选择一项任务，查看已记录的交流。', 'placeholder')); composer.hidden = true; return }
  const previousScroll = detail.scrollTop, head = node('div', null, 'detail-head'), back = node('button', '←', 'back')
  back.type = 'button'; back.setAttribute('aria-label', '返回任务列表'); back.onclick = () => $('layout').classList.remove('show-detail')
  head.append(back, node('h1', topic.title || '未命名请求'), node('div', `${topic.projectName || '未关联项目'} · ${stateText(topic)}`, 'muted'))
  const body = node('div', null, 'detail-body'); body.append(node('div', (topic.historyLimitations || ['以下为已记录的交流，不代表完整原生会话。']).join(' '), 'history-note'))
  const hold = (status.executionHolds || []).find(item => item.ticketId === topic.ticketId && item.assignmentId === topic.ticket?.assignments?.at(-1)?.id)
  if (hold) body.append(node('div', '旧执行已隔离，历史和任务状态保留。补充会保存并交 Router 核对；不会直接重放旧动作。', 'history-note'))
  for (const entry of topic.conversation || []) {
    const item = node('article', null, 'message'), h = node('div', null, 'message-head')
    const actor = entry.kind === 'trigger' ? (['panel', 'router'].includes(entry.trigger?.source) && entry.trigger?.human ? '你' : entry.trigger?.actor?.id || entry.trigger?.source || '来源消息') : entry.kind === 'report' ? '执行者' : ['decision', 'routingAttachment'].includes(entry.kind) ? 'Router' : 'OSA'
    const input = entry.input, delivery = entry.kind === 'trigger' ? (!input ? '原始请求' : entry.resolution ? '已处理' : topic.ticket?.undelivered?.includes(input.id) ? '已保存，待投递' : input.readAt ? '已读取' : input.deliveredAt || input.deliveredTo ? '已投递' : '已保存') : entry.kind === 'reply' ? (entry.message?.status === 'sent' ? (entry.message.channel?.source === 'panel' ? '已保存到面板对话' : `已发送至 ${entry.message.channel?.source || '来源'}`) : entry.message?.status || '状态未知') : entry.kind === 'report' ? ({ progress: '进行中', waiting: '等待中', ready: '结果就绪', blocked: '受阻', failed: '失败', dropped: '已放弃' }[entry.report?.state] || entry.report?.state || '报告') : ''
    const timestamp = node('time', Number.isFinite(Date.parse(entry.at)) ? new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(entry.at)) : '时间未记录'); if (entry.at) timestamp.title = entry.at
    h.append(node('strong', actor), timestamp, document.createTextNode(delivery ? ` · ${delivery}` : ''))
    if (entry.deliveries?.length) h.append(document.createTextNode(` · ${entry.deliveries.map(m => m.status === 'sent' ? (m.channel?.source === 'panel' ? '已保存到面板对话' : `已发送至 ${m.channel?.source || '来源'}`) : m.status || '状态未知').join('、')}`))
    item.append(h, node('div', entry.text || '', 'message-body'))
    if (entry.resolution?.summary) item.append(node('div', `处理说明：${entry.resolution.summary}`, 'muted'))
    body.append(item)
  }
  const links = node('div', null, 'details-links')
  const decisions = (topic.conversation || []).filter(entry => entry.kind === 'decision')
  const candidate = topicHasCandidate(topic)
  if (topic.triggerId && !candidate && decisions.at(-1)?.decision?.kind === 'unavailable') {
    const retry = node('button', '重新评估'); retry.type = 'button'; retry.disabled = !connected || busy
    retry.onclick = async () => { if (!connected || busy) return; busy = true; retry.disabled = true; try { await call('reevaluate', { trigger: topic.triggerId }); await refresh() } catch (e) { say(`重新评估失败：${e.message || e}`) } finally { busy = false; retry.disabled = !connected } }
    links.append(retry)
  }
  for (const p of topic.publications || []) addLink(links, p.pr ? `打开 PR #${p.pr}` : '打开成果', p.url)
  for (const w of topic.windows || []) {
    const button = node('button', `打开窗口：${w.title || w.sessionId || w.terminal || '未知'}`); button.type = 'button'; button.disabled = !connected || busy
    button.onclick = async () => { try { const result = await call('window-open', { ticket: topic.ticketId, ...(w.sessionId ? { session: w.sessionId } : { terminal: w.terminal }) }); if (result.navigated === false) say(result.reason || '当前接口无法打开窗口。') } catch (e) { say(`无法打开窗口：${e.message || e}`) } }; links.append(button)
    const observe = node('button', '查看窗口最近观察'); observe.type = 'button'; observe.disabled = !connected || busy
    observe.onclick = async () => { try { const result = await call('window-observe', { ticket: topic.ticketId, ...(w.sessionId ? { session: w.sessionId } : { terminal: w.terminal }) }); const details = node('div', null, 'history-note'); details.append(node('strong', result.source || '窗口观察'), node('pre', JSON.stringify(result.observation, null, 2), 'observation')); body.append(details) } catch (e) { say(`无法读取窗口：${e.message || e}`) } }; links.append(observe)
  }
  if (links.childNodes.length) body.append(links)
  if (!(topic.windows || []).length) body.append(node('div', '执行窗口：未关联可打开的窗口；可在侧栏的原有任务详情中关联。', 'muted'))
  for (const w of topic.worktrees || []) body.append(node('div', `工作树：${w.directory || '未知'}${w.repository ? ` · 仓库 ${w.repository}` : ''}`, 'muted'))
  for (const target of topic.targets || []) if (target.repository) body.append(node('div', `仓库：${target.repository}`, 'muted'))
  if (!(topic.worktrees || []).length) body.append(node('div', '工作树：未关联或未知', 'muted'))
  detail.replaceChildren(head, body); detail.scrollTop = previousScroll
  composer.hidden = !(topic.ticketId || topic.triggerId)
  composer.dataset.stateDir = status?.stateDir || ''
  const stopped = topic.ticket?.ended?.by === 'human'
  $('compose-note').textContent = stopped ? '此任务已由所有者停止，不能继续回复。' : '内容保存在本机，发送后以实际投递状态为准'
  if (!active || message.dataset.key !== topicDraftKey(topic)) { message.dataset.key = topicDraftKey(topic); message.value = drafts[message.dataset.key]?.text || '' }
  composer.querySelector('button').disabled = !connected || busy || stopped
}
function render() { renderList(); renderDetail() }
message.addEventListener('input', () => saveDraft(message.dataset.key, message.value))
composer.addEventListener('submit', async e => {
  e.preventDefault(); const topic = findTopic(), key = message.dataset.key, draft = drafts[key]
  if (!topic || !connected || busy || composer.dataset.stateDir !== status?.stateDir || topic.ticket?.ended?.by === 'human') { say('当前任务不可发送，请检查连接或任务状态。'); return }
  if (!draft?.text.trim()) return
  busy = true; composer.querySelector('button').disabled = true
  try { await call('comment', { id: draft.id, text: draft.text, ...(topic.ticketId ? { ticket: topic.ticketId } : { trigger: topic.triggerId }) }); if (drafts[key]?.id === draft.id) { saveDraft(key, ''); if (message.dataset.key === key) message.value = '' } await refresh() }
  catch (e) { say(`发送失败，草稿已保留：${e.message || e}`) }
  finally { busy = false; composer.querySelector('button').disabled = !connected || findTopic()?.ticket?.ended?.by === 'human' }
})
$('search').addEventListener('input', renderList); $('filter').addEventListener('change', renderList); $('refresh').addEventListener('click', refresh)
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); renderList() }))
window.orca.settings.onDidChange(({ key }) => { if (key === 'stateDir') { connected = false; ++refreshId; list.replaceChildren(); render(); void refresh() } })
try { await window.orca.document.get(); drafts = await window.orca.storage.get(storageKey) || {}; selections = await window.orca.storage.get('workbench-selection-v1') || {} } catch (e) { say(`无法读取草稿：${e.message || e}`) }
await refresh()
timer = setInterval(() => { if (!document.hidden) void refresh() }, 15000)
window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
