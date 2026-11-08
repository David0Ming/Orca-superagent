import { buildWorkbench, groupTopics, dateKey } from './workbench-model.js'

const $ = id => document.getElementById(id)
const list = $('list'), detail = $('detail'), composer = $('composer'), message = $('message'), notice = $('notice')
let draftWrites = Promise.resolve(), fingerprint = ''
const localFiles = new Map(), localUrls = new Map(), historyFiles = new Map(), composing = new WeakSet()
let status = null, model = { topics: [], aliases: {}, uniqueCount: 0 }, selected = '', view = 'project', connected = false, busy = false, drafts = {}, selections = {}, collapsed = new Set(), timer, refreshId = 0
const storageKey = 'workbench-drafts-v1'
const draftKey = (kind, id) => JSON.stringify([status?.stateDir || '', kind, id])
const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
const call = (action, options = {}, stateDir = status?.stateDir) => window.orca.plugin.request('osa.call', { action, options, ...(action === 'status' ? {} : { stateDir }) }, { timeoutMs: action.startsWith('window') ? 120000 : 30000 })
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = String(text); if (className) el.className = className; return el }
function say(text) { notice.textContent = text; notice.hidden = !text }
function saveDraft(key, text) {
  const old = drafts[key]
  drafts[key] = { ...old, text, id: old?.text === text ? old.id : id(), attachments: old?.attachments || [] }
  const snapshot = structuredClone(drafts)
  draftWrites = draftWrites.catch(() => {}).then(() => window.orca.storage.set(storageKey, snapshot)).catch(e => say(`草稿保存失败：${e.message || e}`))
}
function updateAttachments(key, attachments, changed = false) {
  const old = drafts[key] || { text: '', id: id() }
  drafts[key] = { ...old, id: changed ? id() : old.id, attachments }
  const snapshot = structuredClone(drafts)
  draftWrites = draftWrites.catch(() => {}).then(() => window.orca.storage.set(storageKey, snapshot)).catch(e => say(`草稿保存失败：${e.message || e}`))
}
async function fileHash(file) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
function bytesLabel(size) { return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` }
const startComposition = event => composing.add(event.currentTarget)
const endComposition = event => composing.delete(event.currentTarget)
function setupComposer(form, input, tray, picker, key, sourceDir) {
  tray.dataset.key = key
  function paint() {
    if (tray.dataset.key !== key) return
    tray.replaceChildren()
    const send = form.querySelector('button[type=submit]'); if (send) send.disabled = !connected || busy || status?.stateDir !== sourceDir || (form === composer && findTopic()?.ticket?.ended?.by === 'human') || !readyToSend(drafts[key])
    for (const file of drafts[key]?.attachments || []) {
      const item = node('div', null, 'attachment'), preview = localUrls.get(file.id)
      if (preview && /^image\/(png|jpeg|gif|webp)$/.test(file.mime)) { const image = node('img'); image.src = preview; image.alt = ''; item.append(image) }
      const text = node('span', `${file.name} · ${bytesLabel(file.size)} · ${file.state === 'ready' ? '已上传' : file.state === 'uploading' && localFiles.has(file.id) ? '上传中' : '需重选或重试'}`)
      item.append(text)
      if (file.state !== 'ready' && !localFiles.has(file.id)) { const reselect = node('label', '重新选择', 'reselect'); const field = node('input'); field.type = 'file'; field.onchange = async () => { const chosen = field.files?.[0]; if (!chosen || chosen.name !== file.name || chosen.size !== file.size) { say('请选择同名、同大小的原文件。'); return } try { const hash = await fileHash(chosen); if (file.fingerprint && hash !== file.fingerprint) { say('文件内容与原附件不同，请选择原文件。'); return } if (!drafts[key]?.attachments?.some(x => x.id === file.id)) return; const nextId = file.fingerprint ? file.id : crypto.randomUUID(); localFiles.set(nextId, chosen); updateAttachments(key, drafts[key].attachments.map(x => x.id === file.id ? { ...x, id: nextId, fingerprint: hash, state: 'uploading' } : x), !file.fingerprint); paint(); void upload(key, nextId, sourceDir, paint) } catch (e) { say(`无法校验文件：${e.message || e}`) } }; reselect.append(field); item.append(reselect) }
      if (file.state !== 'ready' && localFiles.has(file.id) && file.state !== 'uploading') { const retry = node('button', '重试'); retry.type = 'button'; retry.onclick = () => upload(key, file.id, sourceDir, paint); item.append(retry) }
      const remove = node('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${file.name}`)
      remove.onclick = () => { updateAttachments(key, (drafts[key]?.attachments || []).filter(x => x.id !== file.id), true); localFiles.delete(file.id); if (localUrls.has(file.id)) URL.revokeObjectURL(localUrls.get(file.id)); localUrls.delete(file.id); paint() }
      item.append(remove); tray.append(item)
    }
  }
  async function choose(files) {
    if (!connected || status?.stateDir !== sourceDir) { say('连接已变化，请重新选择附件。'); return }
    for (const file of files) {
      if ((drafts[key]?.attachments || []).length >= 10) { say('每条消息最多添加 10 个附件。'); break }
      if (file.size > 20 * 1024 * 1024) { say(`${file.name} 超过 20 MiB，未添加。`); continue }
      const entry = { id: crypto.randomUUID(), name: file.name, mime: file.type || 'application/octet-stream', size: file.size, state: 'uploading' }
      localFiles.set(entry.id, file); if (/^image\/(png|jpeg|gif|webp)$/.test(entry.mime)) localUrls.set(entry.id, URL.createObjectURL(file))
      updateAttachments(key, [...(drafts[key]?.attachments || []), entry], true); paint()
      try { const fingerprint = await fileHash(file); if (!drafts[key]?.attachments?.some(x => x.id === entry.id)) continue; updateAttachments(key, drafts[key].attachments.map(x => x.id === entry.id ? { ...x, fingerprint } : x)); void upload(key, entry.id, sourceDir, paint) }
      catch (e) { updateAttachments(key, (drafts[key]?.attachments || []).map(x => x.id === entry.id ? { ...x, state: 'failed' } : x)); paint(); say(`无法校验文件：${e.message || e}`) }
    }
  }
  picker.onchange = () => { void choose([...picker.files]); picker.value = '' }
  input.onpaste = event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); void choose(files) } }
  form.ondragover = event => { event.preventDefault() }
  form.ondrop = event => { event.preventDefault(); void choose([...(event.dataTransfer?.files || [])]) }
  input.addEventListener('compositionstart', startComposition)
  input.addEventListener('compositionend', endComposition)
  input.onkeydown = event => { if (event.key === 'Enter' && !composing.has(input) && !event.isComposing && event.keyCode !== 229 && (!event.shiftKey || event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit() } }
  input.oninput = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; saveDraft(key, input.value); paint() }
  paint()
}
async function upload(key, fileId, sourceDir, paint) {
  const file = localFiles.get(fileId), found = drafts[key]?.attachments?.find(x => x.id === fileId)
  if (!file || !found || !found.fingerprint) return
  const setState = (state, meta = {}) => { const all = drafts[key]?.attachments || []; if (all.some(x => x.id === fileId)) { updateAttachments(key, all.map(x => x.id === fileId ? { ...x, ...meta, state } : x)); paint() } }
  if (!connected || status?.stateDir !== sourceDir) { setState('failed'); say('连接已变化，附件需要重试。'); return }
  setState('uploading')
  try {
    let offset = 0
    do {
      if (!connected || status?.stateDir !== sourceDir || !drafts[key]?.attachments?.some(x => x.id === fileId)) throw Error('连接已变化或附件已移除')
      const bytes = new Uint8Array(await file.slice(offset, offset + 192 * 1024).arrayBuffer())
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
      const result = await call('attachment-write', { id: fileId, name: found.name, mime: found.mime, size: String(file.size), offset: String(offset), data: btoa(binary) }, sourceDir)
      if (!Number.isInteger(result.offset) || result.offset <= offset && !result.ready) throw Error('上传回执无效')
      offset = result.offset
      if (result.ready) { if (result.offset !== file.size) throw Error('附件上传长度不符'); setState('ready', { mime: result.mime, sha256: result.sha256 }); return }
    } while (offset < file.size)
    throw Error('附件尚未确认完成')
  } catch (e) { setState('failed'); say(`附件上传失败：${e.message || e}`) }
}
function releaseFiles(attachments) { for (const file of attachments || []) { localFiles.delete(file.id); if (localUrls.has(file.id)) URL.revokeObjectURL(localUrls.get(file.id)); localUrls.delete(file.id) } }
function readyToSend(draft) { return !!draft && (draft.text.trim() || draft.attachments?.length) && (draft.attachments || []).every(file => file.state === 'ready') }
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
    const changedDirectory = status?.stateDir !== next.stateDir, wasConnected = connected
    const nextFingerprint = JSON.stringify({ ...next, projects: next.projects ? { ...next.projects, observedAt: undefined } : next.projects })
    if (!changedDirectory && wasConnected && fingerprint === nextFingerprint) return
    fingerprint = nextFingerprint
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
  const form = node('form', null, 'inline-form'), input = node('textarea'), button = node('button', '提出请求'), tray = node('div', null, 'attachment-tray'), picker = node('input'), label = node('label', '📎', 'attachment-picker')
  picker.type = 'file'; picker.multiple = true; label.title = '添加图片或文件'; label.setAttribute('aria-label', '添加图片或文件'); label.append(picker); input.rows = 1
  input.placeholder = '添加今天的请求…'; input.setAttribute('aria-label', '添加今天的请求')
  const key = draftKey('new', projectId), draft = drafts[key]; input.value = draft?.text || ''
  button.type = 'submit'; button.disabled = !connected || busy || !projectId || projectId === 'unknown'
  form.append(input, tray, label, button); setupComposer(form, input, tray, picker, key, sourceDir)
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (!connected || busy || status?.stateDir !== sourceDir) { say('连接已变化，请在当前项目重新提交。'); return }
    const sent = drafts[key]; if (!readyToSend(sent)) { say('请输入内容或等待附件上传完成。'); return }
    busy = true; button.disabled = true
    try { const result = await call('request', { id: sent.id, project: projectId, text: sent.text, ...(sent.attachments?.length ? { attachments: JSON.stringify(sent.attachments.map(a => a.id)) } : {}) }); if (drafts[key]?.id === sent.id) { releaseFiles(sent.attachments); updateAttachments(key, []); saveDraft(key, ''); input.value = ''; setupComposer(form, input, tray, picker, key, sourceDir) } selected = `request:${result.id}`; await refresh() }
    catch (err) { say(`提交失败，草稿已保留：${err.message || err}`) }
    finally { busy = false; button.disabled = !connected || status?.stateDir !== sourceDir || !readyToSend(drafts[key]) }
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
  if (list.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
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
    for (const file of entry.trigger?.meta?.attachments || []) {
      const row = node('div', null, 'history-attachment'), key = `${status.stateDir}:${file.id}`, sourceDir = status.stateDir, sourceTopic = topic.id
      row.append(node('span', `${file.name} · ${bytesLabel(file.size)}`))
      const show = (requireConnected = true) => {
        const cached = historyFiles.get(key)
        if (!cached || (requireConnected && !row.isConnected) || status?.stateDir !== sourceDir || findTopic()?.id !== sourceTopic) return
        if (/^image\/(png|jpeg|gif|webp)$/.test(file.mime)) { const image = node('img'), zoom = node('button'); image.src = cached.url; image.alt = file.name; zoom.type = 'button'; zoom.setAttribute('aria-label', `放大或缩小 ${file.name}`); zoom.append(image); zoom.onclick = () => { image.classList.toggle('expanded') }; row.append(zoom) }
        const download = node('button', '保存文件'); download.type = 'button'; download.onclick = async () => { try { await window.orca.files.saveAs({ suggestedName: file.name, data: cached.bytes.buffer }) } catch (e) { say(`保存失败：${e.message || e}`) } }; row.append(download)
      }
      if (historyFiles.has(key)) show(false)
      else { const load = node('button', /^image\/(png|jpeg|gif|webp)$/.test(file.mime) ? '查看图片' : '读取附件'); load.type = 'button'; load.disabled = !connected; load.onclick = async () => { load.disabled = true; try {
        const chunks = []; let offset = 0, done = false
        while (!done) { if (!connected || status?.stateDir !== sourceDir) throw Error('连接已变化'); const result = await call('attachment-read', { id: file.id, offset: String(offset) }, sourceDir); const binary = atob(result.data); chunks.push(Uint8Array.from(binary, c => c.charCodeAt(0))); if (result.nextOffset <= offset && !result.done) throw Error('附件读取回执无效'); offset = result.nextOffset; done = result.done }
        const bytes = new Uint8Array(offset); let pos = 0; for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length } if (pos !== file.size) throw Error('附件长度不符')
        if (!connected || status?.stateDir !== sourceDir) throw Error('连接已变化'); historyFiles.set(key, { bytes, url: URL.createObjectURL(new Blob([bytes], { type: file.mime })) }); load.remove(); show()
      } catch (e) { load.disabled = false; say(`读取附件失败：${e.message || e}`) } }; row.append(load) }
      item.append(row)
    }
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
  setupComposer(composer, message, $('message-files'), $('message-picker'), message.dataset.key, status?.stateDir)
}
function render() { renderList(); renderDetail() }
composer.addEventListener('submit', async e => {
  e.preventDefault(); const topic = findTopic(), key = message.dataset.key, draft = drafts[key]
  if (!topic || !connected || busy || composer.dataset.stateDir !== status?.stateDir || topic.ticket?.ended?.by === 'human') { say('当前任务不可发送，请检查连接或任务状态。'); return }
  if (!readyToSend(draft)) { say('请输入内容或等待附件上传完成。'); return }
  busy = true; composer.querySelector('button[type=submit]').disabled = true
  try { await call('comment', { id: draft.id, text: draft.text, ...(draft.attachments?.length ? { attachments: JSON.stringify(draft.attachments.map(a => a.id)) } : {}), ...(topic.ticketId ? { ticket: topic.ticketId } : { trigger: topic.triggerId }) }); if (drafts[key]?.id === draft.id) { releaseFiles(draft.attachments); updateAttachments(key, []); saveDraft(key, ''); if (message.dataset.key === key) { message.value = ''; setupComposer(composer, message, $('message-files'), $('message-picker'), key, status?.stateDir) } } await refresh() }
  catch (e) { say(`发送失败，草稿已保留：${e.message || e}`) }
  finally { busy = false; composer.querySelector('button[type=submit]').disabled = !connected || findTopic()?.ticket?.ended?.by === 'human' || !readyToSend(drafts[message.dataset.key]) }
})
$('search').addEventListener('input', renderList); $('filter').addEventListener('change', renderList); $('refresh').addEventListener('click', refresh)
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); renderList() }))
window.orca.settings.onDidChange(({ key }) => { if (key === 'stateDir') { connected = false; ++refreshId; list.replaceChildren(); render(); void refresh() } })
try { await window.orca.document.get(); drafts = await window.orca.storage.get(storageKey) || {}; selections = await window.orca.storage.get('workbench-selection-v1') || {} } catch (e) { say(`无法读取草稿：${e.message || e}`) }
await refresh()
timer = setInterval(() => { if (!document.hidden) void refresh() }, 15000)
window.addEventListener('pagehide', () => { clearInterval(timer); for (const url of localUrls.values()) URL.revokeObjectURL(url); for (const file of historyFiles.values()) URL.revokeObjectURL(file.url) }, { once: true })
