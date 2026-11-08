import { atom, read, set, update, plugin, settings, Stack, Row, Heading, Text, Button, Input, Textarea, Select, List, ListItem, Separator, Callout, Collapsible, Checkbox, Skeleton, Table, Link, CodeView, type PanelContext } from 'orca'

type Draft = { text: string; id: string }
const snapshot = atom<any>(null), error = atom(''), busy = atom(false), page = atom('settings'), selectedProject = atom(''), selectedTicket = atom(''), selectedTrigger = atom(''), query = atom('')
const drafts = atom<Record<string, Draft>>('drafts', {}, { persist: 'plugin' })
const viewedResults = atom<Record<string, boolean>>('viewed-results', {}, { persist: 'plugin' })
const connected = atom<boolean | null>(null), lastRead = atom(''), configuredDir = atom(''), snapshotDir = atom('')
const projectId = atom('project-id', '', { persist: 'plugin' }), repositoryId = atom('repository-id', '', { persist: 'plugin' })
const windows = atom<any>(null), observation = atom<any>(null), windowMessage = atom('')
const stopReason = atom(''), locations = atom<string[]>([]), projectName = atom(''), repositoryName = atom(''), repositoryPath = atom(''), baseBranch = atom(''), stateDir = atom('')
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
const call = (action: string, options: Record<string, string> = {}) => plugin.request('osa.call', { action, options, ...(action === 'status' ? {} : { stateDir: read(snapshotDir) }) }, { timeoutMs: ['retry', 'windows', 'window-link', 'window-observe', 'window-open'].includes(action) ? 120000 : 30000 })
async function refresh() {
  const dir = read(configuredDir)
  try { const result = await call('status'); if (dir !== read(configuredDir)) return; set(snapshot, result); set(snapshotDir, result.stateDir || ''); set(lastRead, new Date().toISOString()); set(connected, true); set(error, '') }
  catch (e) { if (dir === read(configuredDir)) { set(connected, false); set(error, String(e)) } }
}
export function setup(ctx: PanelContext) {
  void settings.get('stateDir').then(value => { const dir = typeof value === 'string' ? value : ''; set(stateDir, dir); set(configuredDir, dir); return refresh() }).catch(e => { set(connected, false); set(error, String(e)) })
  ctx.subscriptions.push(settings.onDidChange(({ key }) => {
    if (key !== 'stateDir') return
    set(connected, null)
    void settings.get('stateDir').then(value => { const dir = typeof value === 'string' ? value : ''; set(stateDir, dir); set(configuredDir, dir); return refresh() }).catch(e => { set(connected, false); set(error, String(e)) })
  }))
  const timer = setInterval(() => { if (read(ctx.visible)) void refresh() }, 15000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}
function editDraft(key: string, text: string) {
  update(drafts, all => ({ ...all, [key]: { text, id: all[key]?.text === text ? all[key].id : uid() } }))
}
async function submit(key: string, action: string, options: Record<string, string>) {
  const draft = read(drafts)[key]
  if (!draft?.text.trim() || read(busy) || read(connected) !== true || !read(snapshotDir)) return
  set(busy, true)
  try {
    await call(action, { ...options, id: draft.id, text: draft.text })
    update(drafts, all => all[key]?.id === draft.id ? { ...all, [key]: { text: '', id: uid() } } : all)
    set(error, '')
    await refresh()
  } catch (e) { set(error, String(e)) }
  finally { set(busy, false) }
}
async function action(name: string, options: Record<string, string>, done?: () => void) {
  if (read(busy) || read(connected) !== true || !read(snapshotDir)) return
  set(busy, true)
  try { await call(name, options); done?.(); set(error, ''); await refresh() }
  catch (e) { set(error, String(e)) }
  finally { set(busy, false) }
}
const parts = (value: string) => value.match(/[\s\S]{1,12000}/gu) || ['']
async function windowCall(name: string, options: Record<string, string>) {
  if (read(busy) || read(connected) !== true || !read(snapshotDir)) return
  set(busy, true)
  try {
    const result = await call(name, options)
    if (name === 'windows') set(windows, result)
    else if (name === 'window-observe') set(observation, result)
    else if (name === 'window-open') set(windowMessage, result.navigated === false ? result.reason : '已打开执行窗口')
    else { set(windowMessage, '已关联窗口'); await refresh() }
    set(error, '')
  } catch (e) { set(error, String(e)) }
  finally { set(busy, false) }
}
const cell = (value: unknown) => String(value || '').slice(0, 1000)
const stateLabel = (state: string) => ({ progress: '进行中', waiting: '等待中', ready: '结果就绪', blocked: '受阻', failed: '失败', dropped: '已放弃', completed: '已完成', merged: '已合并', closed: '已关闭', stopped: '已停止', pending: '待处理' } as Record<string, string>)[state] || state || '未知'
const stage = (t: any) => t.ended ? stateLabel(t.ended.outcome) : t.delivery ? `投递失败：${t.delivery.error}` : t.attention ? '等待回答' : t.assignments?.at(-1)?.report ? stateLabel(t.assignments.at(-1).report.state) : t.assignments?.at(-1)?.state === 'running' ? '执行中，暂无报告' : t.assignments?.at(-1)?.state === 'ended' ? '执行已结束，业务状态未知' : '待处理'
const goProject = (id: string) => { set(selectedProject, id); set(selectedTicket, ''); set(page, 'project'); set(locations, []) }
const requestReplies = (data: any, trigger: any) => !trigger?.channel?.source || !trigger?.channel?.thread ? [] : (data?.outbox || []).filter((m: any) => m.kind === 'reply' && m.channel?.source === trigger.channel.source && m.channel?.thread === trigger.channel.thread)
const replyKey = (trigger: any, reply: any) => JSON.stringify([read(snapshotDir), 'request-reply', trigger.id, reply.id, reply.createdAt || null])
const goTrigger = (id: string) => { const data = read(snapshot), trigger = data?.triggers?.find((item: any) => item.id === id); if (read(snapshotDir) && trigger) update(viewedResults, all => { const next = { ...all }; for (const reply of requestReplies(data, trigger)) if (reply.status === 'sent') next[replyKey(trigger, reply)] = true; return next }); set(selectedTrigger, id); set(page, 'trigger') }
const resultKey = (t: any) => JSON.stringify([read(snapshotDir), t.id, t.assignments?.at(-1)?.report?.at])
const goTicket = (id: string) => { const t = read(snapshot)?.tickets?.find((item: any) => item.id === id); if (read(snapshotDir) && t?.assignments?.at(-1)?.report?.state === 'ready') update(viewedResults, all => ({ ...all, [resultKey(t)]: true })); set(selectedTicket, id); set(windows, null); set(observation, null); set(windowMessage, ''); set(page, 'ticket') }
export default function Panel() {
  const data = read(snapshot), err = read(error), current = read(page), project = read(selectedProject), ticketId = read(selectedTicket), working = read(busy) || read(connected) !== true || !read(snapshotDir)
  const projects = data?.projects?.projects || [], tasks = data?.projects?.tasks || [], tickets = data?.tickets || []
  const getProject = (t: any) => tasks.find((row: any) => row.ticket.id === t.id)?.context?.target?.projectId
  const executor = (t: any) => { const id = t.assignments?.at(-1)?.id; const execution = (data?.executions || []).find((e: any) => e.id === id); const binding = (data?.executionBindings || []).find((b: any) => b.id === id); return [execution?.provider, execution?.model].filter(Boolean).join(' · ') || binding?.terminal || '未知' }
  const projectLabel = (id: string) => projects.find((p: any) => p.id === id)?.name || id || '未关联项目'
  const record = (data?.triggers || []).find((t: any) => t.id === read(selectedTrigger))
  const ticket = tickets.find((t: any) => t.id === ticketId)
  const attentionTickets = tickets.filter((t: any) => { const report = t.assignments?.at(-1)?.report; return (!t.ended && (t.attention || t.delivery || ['blocked', 'failed'].includes(report?.state))) || (report?.state === 'ready' && !read(viewedResults)[resultKey(t)]) })
  const q = read(query).trim().toLowerCase()
  const matches = (t: any) => !q || JSON.stringify(t).toLowerCase().includes(q) || (data?.triggers || []).some((x: any) => (t.origin?.triggerIds?.includes(x.id) || t.inputs?.some((i: any) => i.triggerId === x.id)) && JSON.stringify(x).toLowerCase().includes(q))
  const rows = tickets.filter((t: any) => (!project || current !== 'project' || getProject(t) === project) && matches(t))
  const draftKey = JSON.stringify([read(snapshotDir), current === 'ticket' ? 'ticket' : 'project', current === 'ticket' ? ticketId : project])
  const draft = read(drafts)[draftKey]?.text || ''
  const projectComponents = (data?.projects?.components || []).filter((c: any) => c.projectId === project)
  const projectLocations = (data?.projects?.locations || []).filter((l: any) => projectComponents.some((c: any) => c.id === l.componentId))
  const inputs = ticket?.inputs || [], triggers = data?.triggers || []
  const candidate = (id: string) => (data.candidates || []).some((c: any) => c.triggers?.some((t: any) => t.id === id))
  const decision = (id: string) => { const rows = (data.routingHistory || []).filter((d: any) => d.triggerIds?.includes(id)); const decisionId = (data.triggerDispositions || []).find((d: any) => d.triggerId === id)?.decisionId; return rows.find((d: any) => d.id === decisionId) || rows.sort((a: any, b: any) => String(b.at || '').localeCompare(String(a.at || '')))[0] }
  const originalRequests = triggers.filter((t: any) => t.source === 'panel' && !t.meta?.ticketId && !tickets.some((item: any) => item.origin?.triggerIds?.includes(t.id)))
  const pendingRequests = originalRequests.filter((t: any) => t.meta?.projectId === project && (candidate(t.id) || !decision(t.id) || decision(t.id).kind === 'unavailable' || requestReplies(data, t).length))
  const unreadRequests = originalRequests.filter((t: any) => requestReplies(data, t).some((m: any) => m.status === 'sent' && !read(viewedResults)[replyKey(t, m)]))
  const unavailableRequests = originalRequests.filter((t: any) => !candidate(t.id) && decision(t.id)?.kind === 'unavailable')
  const triggerIds = new Set([...(ticket?.origin?.triggerIds || []), ...inputs.map((i: any) => i.triggerId).filter(Boolean)])
  const reports = new Map<string, any>()
  for (const receipt of (data?.reportReceipts || []).filter((r: any) => r.ticketId === ticketId)) {
    const assignment = receipt.result?.assignments?.find((a: any) => a.id === receipt.assignmentId)
    if (assignment?.report) reports.set(JSON.stringify([assignment.id, assignment.report]), assignment.report)
  }
  for (const assignment of ticket?.assignments || []) if (assignment.report) reports.set(JSON.stringify([assignment.id, assignment.report]), assignment.report)
  const messages = (data?.outbox || []).filter((m: any) => m.ticketId === ticketId)
  const reportItems = [...reports.values()].map(report => ({ kind: 'report', at: report.at, text: report.summary, report, deliveries: [] as any[] }))
  const separateMessages = messages.filter((message: any) => {
    const matches = reportItems.filter(report => report.text === message.text)
    if (matches.length !== 1) return true
    matches[0].deliveries.push(message)
    return false
  })
  const conversation = [
    ...triggers.filter((t: any) => triggerIds.has(t.id)).map((trigger: any) => ({ kind: 'trigger', at: trigger.at, text: trigger.text, trigger })),
    ...reportItems,
    ...separateMessages.map((message: any) => ({ kind: 'reply', at: message.createdAt, text: message.text, message }))
  ].sort((a, b) => { const aTime = Date.parse(a.at), bTime = Date.parse(b.at); return (Number.isFinite(aTime) ? aTime : Infinity) - (Number.isFinite(bTime) ? bTime : Infinity) })
  const deliveryLabel = (m: any) => m.status === 'sent' ? (m.channel?.source === 'panel' ? '已保存到面板对话' : `已发送至 ${m.channel?.source || '来源'}`) : m.status === 'pending' ? '待发送' : m.status || '状态未知'
  return <Stack gap="md">
    <Row justify="between"><Heading>OSA</Heading><Button variant="ghost" icon="refresh" onPress={refresh}>刷新</Button></Row>
    <Button icon="open-external" disabled={read(busy) || !read(stateDir).trim()} onPress={async () => { set(busy, true); try { await plugin.request('osa.open-workbench', {}); set(error, '') } catch (e) { set(error, String(e)) } finally { set(busy, false) } }}>打开任务工作台</Button>
    <Text size="xs" muted>日期、项目和工作树视图在主区域标签页中打开。</Text>
    <Row gap="xs" wrap><Button variant={current === 'overview' ? 'solid' : 'ghost'} onPress={() => { set(page, 'overview'); set(selectedProject, '') }}>总览</Button><Button variant={current === 'settings' ? 'solid' : 'ghost'} onPress={() => set(page, 'settings')}>设置</Button></Row>
    {err && read(connected) !== false && <Callout tone="danger" title="操作失败">{err}</Callout>}
    {read(connected) === false && <Callout tone="warning" title="服务未连接">{data ? `显示 ${read(lastRead)} 的记录，可能已过期。` : '请检查连接设置。'}{data && read(snapshotDir) !== read(configuredDir) ? ' 当前设置目录与记录来源不同；旧数据仅供查看。' : ''}</Callout>}
    {data && read(connected) === null && <Callout tone="warning" title="正在检查连接">显示 {read(lastRead)} 的记录，可能已过期。</Callout>}
    {read(connected) === false && <Collapsible title="连接详情"><Text>{err}</Text><Text>记录来源：{read(snapshotDir) || '未知'}</Text><Text>当前设置：{read(configuredDir) || '未设置'}</Text></Collapsible>}
    {!data && !err && <Skeleton lines={3} label="正在读取 OSA" />}
      {data?.routerHealth && !data.routerHealth.binding && <Callout tone="warning" title="Router 未绑定">Router 尚未绑定；已保存的请求需要 Router 处理。</Callout>}
      {data?.routerHealth?.binding && data.routerHealth?.health?.state !== 'connected' && <Callout tone="warning" title="Router 状态">{data.routerHealth.health?.state === 'unavailable' ? `不可用：${data.routerHealth.health.error || '请检查 Router'}` : data.routerHealth.health?.state === 'migration-required' ? '需要迁移绑定。' : '尚无连接状态记录。'}</Callout>}

    {current === 'settings' ? <Stack gap="sm"><Heading level={2}>连接</Heading><Text>填写运行中 OSA 服务的状态目录，保存后重新连接。</Text><Input label="状态目录（绝对路径）" value={read(stateDir)} onChange={value => set(stateDir, value)} /><Button disabled={read(busy)} onPress={async () => { try { set(connected, null); await settings.set('stateDir', read(stateDir)); set(configuredDir, read(stateDir)); set(connected, null); await refresh() } catch (e) { set(connected, false); set(error, String(e)) } }}>保存并连接</Button><Text muted>{read(connected) === true ? '已连接 OSA 服务' : read(connected) === false ? '尚未连接 OSA 服务' : '正在检查连接'}</Text>{read(lastRead) && <Text size="xs" muted>上次读取：{read(lastRead)}</Text>}{data?.configuration && <Stack gap="xs"><Text>执行者：{data.configuration.executor?.agent || '未知'}{data.configuration.executor?.model ? ` · ${data.configuration.executor.model}` : ''}</Text><Text>服务仓库：{data.configuration.repository || '未知'}</Text>{data.configuration.runtime && <Stack gap="xs"><Text>服务代码：{data.configuration.runtime.codeVersion?.slice(0, 12) || '未知'}</Text><Text size="xs" muted>加载于 {data.configuration.runtime.loadedAt} · {data.configuration.runtime.nodeVersion}</Text><Text size="xs" muted>{data.configuration.runtime.codePath}</Text></Stack>}</Stack>}</Stack> : null}
    {data && current === 'overview' ? <Stack gap="md">
      <Heading level={2}>需要关注</Heading>
      {attentionTickets.length ? <List label="需要关注的任务">{attentionTickets.map((t: any) => <ListItem title={t.title} description={`${projectLabel(getProject(t))} · ${t.attention?.question || stage(t)}`} onPress={() => goTicket(t.id)} />)}</List> : !unavailableRequests.length && !unreadRequests.length && <Text muted>目前没有需要处理的任务。</Text>}
      {unreadRequests.length > 0 && <List label="未读请求回复">{unreadRequests.map((t: any) => <ListItem title={cell(t.text || t.id)} description={`${projectLabel(t.meta?.projectId)} · 有新回复`} onPress={() => goTrigger(t.id)} />)}</List>}
      {unavailableRequests.length > 0 && <List label="需要重新评估的请求">{unavailableRequests.map((t: any) => <ListItem title={cell(t.text || t.id)} description={`${projectLabel(t.meta?.projectId)} · 路由未能完成`} onPress={() => goProject(t.meta.projectId)} />)}</List>}
      {data.routerHealth?.attention && <Callout tone="warning" title="Router 待处理">存在待处理的 Router 唤醒记录。</Callout>}
      {(data.notices || []).filter((n: any) => n.text).map((n: any) => <Callout tone="warning" title="系统提示">{n.text}</Callout>)}
      {(data.rejectedSubmissions || []).map((r: any) => <Callout tone="danger" title="提交未被接受">{r.text || ''} · {r.error || r.reason || '请检查记录'}</Callout>)}
      <Separator /><Heading level={2}>项目</Heading>
      <List label="项目">{projects.map((p: any) => <ListItem title={p.name} onPress={() => goProject(p.id)} />)}</List>
      {!projects.length && <Text muted>还没有项目。可在下方添加。</Text>}
      <Collapsible title="添加项目"><Stack gap="sm"><Input label="项目名称" value={read(projectName)} onChange={v => { set(projectName, v); set(projectId, uid()) }} /><Button disabled={!read(projectName).trim() || working} onPress={() => action('project-add', { id: read(projectId), name: read(projectName) }, () => { set(projectName, ''); set(projectId, '') })}>添加项目</Button></Stack></Collapsible>
      <Input label="搜索全部任务和消息" type="search" value={read(query)} onChange={v => set(query, v)} />
      {q && <Stack gap="sm"><List label="任务搜索结果">{rows.map((t: any) => <ListItem title={t.title} description={`${projectLabel(getProject(t))} · ${stage(t)}`} onPress={() => goTicket(t.id)} />)}</List><List label="消息搜索结果">{(data.triggers || []).filter((t: any) => JSON.stringify(t).toLowerCase().includes(q)).map((t: any) => <ListItem title={cell(t.text || t.id)} description={`${projectLabel(t.meta?.projectId)} · ${t.at || ''}`} onPress={() => goTrigger(t.id)} />)}</List></Stack>}
      <Collapsible title="待路由请求"><List label="待路由请求">{(data.candidates || []).map((c: any) => <ListItem title={c.triggers?.map((t: any) => t.text).join(' · ') || c.id} description="已保存，等待 Router 处理" />)}</List></Collapsible>
    </Stack> : null}
    {data && current === 'trigger' && record ? <Stack gap="sm"><Button variant="ghost" onPress={() => set(page, 'overview')}>返回搜索</Button><Heading level={2}>消息原文</Heading><Text size="xs" muted>{projectLabel(record.meta?.projectId)} · {record.at} · {record.id}</Text>{parts(record.text || '').map(part => <Text>{part}</Text>)}{record.url && <Link href={record.url}>打开原始消息</Link>}{requestReplies(data, record).slice().sort((a: any, b: any) => (Date.parse(a.createdAt) || Infinity) - (Date.parse(b.createdAt) || Infinity)).map((m: any) => <Stack gap="xs"><Text size="xs" muted>回复 · {Number.isFinite(Date.parse(m.createdAt)) ? m.createdAt : '时间未记录'} · {deliveryLabel(m)}</Text>{parts(m.text || '').map(part => <Text>{part}</Text>)}</Stack>)}{tickets.filter((t: any) => t.origin?.triggerIds?.includes(record.id) || t.inputs?.some((i: any) => i.triggerId === record.id)).map((t: any) => <Button variant="outline" onPress={() => goTicket(t.id)}>打开任务：{t.title}</Button>)}</Stack> : null}
    {data && current === 'project' ? <Stack gap="md">
      <Heading level={2}>{projectLabel(project)}</Heading><Input label="搜索项目任务和消息" type="search" value={read(query)} onChange={v => set(query, v)} />
      <Heading level={3}>任务</Heading><Table label="项目任务" columns={[{ key: 'title', label: '任务', minWidth: 'sm' }, { key: 'stage', label: '阶段', width: 'sm' }, { key: 'progress', label: '最近进展', hideBelow: 'md' }, { key: 'executor', label: '执行者', hideBelow: 'md' }, { key: 'updated', label: '更新', hideBelow: 'md' }, { key: 'action', label: '需要的动作', hideBelow: 'md' }]} rows={rows.map((t: any) => ({ key: t.id, cells: { title: cell(t.title), stage: cell(stage(t)), progress: cell(t.assignments?.at(-1)?.report?.summary || '暂无报告'), executor: cell(executor(t)), updated: cell(t.updatedAt || '未知'), action: cell(t.attention?.question || '') } }))} onRowAction={({ key }) => goTicket(key)} />
      {!rows.length && <Text muted>{pendingRequests.length ? '尚未建立任务；下面列出已保存的请求。' : '没有匹配的任务。'}</Text>}
      {pendingRequests.length > 0 && <Stack gap="sm"><Heading level={3}>已保存的请求</Heading>{pendingRequests.filter((t: any) => !q || JSON.stringify(t).toLowerCase().includes(q)).map((t: any) => <Stack gap="xs"><Text size="xs" muted>{candidate(t.id) ? '等待 Router 处理' : decision(t.id)?.kind === 'unavailable' ? '路由未能完成，请检查' : requestReplies(data, t).some((m: any) => m.status === 'sent') ? '已回复' : requestReplies(data, t).length ? '回复待发送' : '已保存，路由状态待核实'} · {t.at}</Text>{parts(t.text || '').map(part => <Text>{part}</Text>)}{requestReplies(data, t).length > 0 && <Button variant="ghost" onPress={() => goTrigger(t.id)}>查看回复</Button>}{!candidate(t.id) && decision(t.id)?.kind === 'unavailable' && <Button variant="outline" disabled={working || read(connected) !== true} onPress={() => action('reevaluate', { trigger: t.id })}>重新评估</Button>}</Stack>)}</Stack>}
      {q && <List label="项目消息搜索结果">{(data.triggers || []).filter((t: any) => t.meta?.projectId === project && JSON.stringify(t).toLowerCase().includes(q)).map((t: any) => <ListItem title={cell(t.text || t.id)} description={t.at || ''} onPress={() => goTrigger(t.id)} />)}</List>}
      <Separator /><Heading level={3}>提出请求</Heading><Textarea label="你的要求" value={draft} rows={4} onChange={v => editDraft(draftKey, v)} />
      {projectLocations.length > 1 && <Stack gap="xs"><Text>相关仓库（可多选）</Text>{projectLocations.map((l: any) => <Checkbox label={`${l.name} · ${l.repository}`} checked={read(locations).includes(l.id)} onChange={checked => set(locations, checked ? [...read(locations), l.id] : read(locations).filter(id => id !== l.id))} />)}</Stack>}
      <Button disabled={!draft.trim() || working} onPress={() => submit(draftKey, 'request', { project, ...(read(locations).length ? { locations: read(locations).join(',') } : {}) })}>提交请求</Button><Text size="xs" muted>提交后先保存并等待 Router 处理。</Text>
      <Collapsible title="添加仓库"><Stack gap="sm"><Input label="仓库名称" value={read(repositoryName)} onChange={v => { set(repositoryName, v); set(repositoryId, uid()) }} /><Input label="本机 Git 仓库绝对路径" value={read(repositoryPath)} onChange={v => { set(repositoryPath, v); set(repositoryId, uid()) }} /><Input label="基础分支（可选）" value={read(baseBranch)} onChange={v => { set(baseBranch, v); set(repositoryId, uid()) }} /><Button disabled={working || !read(repositoryName).trim() || !read(repositoryPath).trim()} onPress={() => action('repository-add', { id: read(repositoryId), project, name: read(repositoryName), repository: read(repositoryPath), ...(read(baseBranch) ? { 'base-branch': read(baseBranch) } : {}) }, () => { set(repositoryName, ''); set(repositoryPath, ''); set(baseBranch, ''); set(repositoryId, '') })}>添加仓库</Button></Stack></Collapsible>
    </Stack> : null}
    {data && current === 'ticket' && ticket ? <Stack gap="md"><Button variant="ghost" onPress={() => goProject(getProject(ticket))}>返回项目</Button><Heading level={2}>{ticket.title}</Heading><Text>{stage(ticket)}</Text>{ticket.attention && <Callout tone="warning" title="需要回答">{ticket.attention.question}</Callout>}{ticket.assignments?.at(-1)?.report && <Text>{ticket.assignments.at(-1).report.summary}</Text>}
      <Text size="xs" muted>执行状态：{data.taskProgress?.find((p: any) => p.ticketId === ticket.id)?.executionState || '未知'}</Text>
      {(data.publications || []).filter((p: any) => p.ticketId === ticket.id).map((p: any) => <Stack gap="xs"><Text>成果：{p.repository || '仓库未知'}{p.pr ? ` · PR #${p.pr}` : ' · 尚无 PR'}</Text>{typeof p.url === 'string' && /^https?:\/\//i.test(p.url) && <Link href={p.url}>打开 PR</Link>}</Stack>)}<Separator /><Heading level={3}>对话</Heading>
      {conversation.map((item: any) => {
        const t = item.trigger, input = t && inputs.find((i: any) => i.triggerId === t.id)
        const resolution = input && (data.inputResolutions || []).find((r: any) => r.inputId === input.id)
        const state = !input ? '原始请求' : resolution ? '已处理' : ticket.undelivered?.includes(input.id) ? '已保存，待投递' : input.readAt ? '已读取' : input.deliveredAt || input.deliveredTo ? '已投递' : '已保存'
        const timestamp = Number.isFinite(Date.parse(item.at)) ? item.at : '时间未记录'
        const author = t ? (['panel', 'router'].includes(t.source) && t.human ? '你' : t.actor?.id || t.source || '来源消息') : item.report ? '执行者' : 'OSA'
        return <Stack gap="xs"><Text size="xs" muted>{author} · {timestamp} · {t ? `${state} · ${t.source || '来源未知'}` : item.report ? `报告：${stateLabel(item.report.state)}${item.deliveries.length ? ` · ${item.deliveries.map(deliveryLabel).join('、')}` : ''}` : `回复 · ${deliveryLabel(item.message)}`}</Text>{parts(item.text || '').map(part => <Text>{part}</Text>)}{resolution?.summary && <Text size="xs" muted>处理说明：{resolution.summary}</Text>}</Stack>
      })}
      <Textarea label="补充或回答" value={draft} rows={4} onChange={v => editDraft(draftKey, v)} /><Button disabled={!draft.trim() || working} onPress={() => submit(draftKey, 'comment', { ticket: ticket.id })}>发送</Button><Text size="xs" muted>发送后保存到任务，投递和读取状态以记录为准。</Text>
      {!ticket.ended && (ticket.delivery || ['failed', 'blocked'].includes(ticket.assignments?.at(-1)?.report?.state)) && <Button variant="outline" disabled={working} onPress={() => action('retry', { ticket: ticket.id })}>重试此任务</Button>}
      {!ticket.ended && <Collapsible title="停止这项工作"><Stack gap="sm"><Text>停止只作用于当前任务。</Text><Input label="停止原因" value={read(stopReason)} onChange={v => set(stopReason, v)} /><Button tone="danger" disabled={working || !read(stopReason).trim()} onPress={() => action('stop', { ticket: ticket.id, reason: read(stopReason) }, () => set(stopReason, ''))}>确认停止</Button></Stack></Collapsible>}
      <Collapsible title="执行窗口"><Stack gap="sm"><Text size="xs" muted>窗口状态是 Orca 的观察，不代表任务状态。</Text><Button variant="outline" disabled={working} onPress={() => windowCall('windows', { ticket: ticket.id })}>查找此任务所在项目的窗口</Button>
      {read(windows)?.truncated && <Text>窗口列表未显示完整。</Text>}{read(windows)?.errors?.map((e: any) => <Text tone="danger">{e.workspace}：{e.error}</Text>)}
      {read(windows)?.windows?.map((w: any) => <Row gap="xs" wrap><Text>{w.title || w.sessionId || w.terminal} · {w.workspace} · {typeof w.state === 'string' ? w.state : '状态未知'}</Text><Button size="xs" disabled={working} onPress={() => windowCall('window-link', { ticket: ticket.id, ...(w.sessionId ? { session: w.sessionId } : { terminal: w.terminal }) })}>关联</Button></Row>)}
      {(data.windowLinks || []).filter((link: any) => link.ticketId === ticket.id).map((link: any) => <Stack gap="xs"><Text>{link.title || link.sessionId || link.terminal} · 关联于 {link.linkedAt}</Text><Row gap="xs"><Button size="xs" disabled={working} onPress={() => windowCall('window-open', { ticket: ticket.id, ...(link.sessionId ? { session: link.sessionId } : { terminal: link.terminal }) })}>打开窗口</Button><Button size="xs" variant="outline" disabled={working} onPress={() => windowCall('window-observe', { ticket: ticket.id, ...(link.sessionId ? { session: link.sessionId } : { terminal: link.terminal }) })}>查看最近观察</Button></Row></Stack>)}
      {read(windowMessage) && <Text>{read(windowMessage)}</Text>}{read(observation) && <Stack gap="xs"><Text size="xs" muted>{read(observation).source}</Text><CodeView label="窗口最近观察" code={JSON.stringify(read(observation).observation, null, 2).slice(0, 16000)} wrap /></Stack>}</Stack></Collapsible>
      <Collapsible title="详情"><Text>任务编号：{ticket.id}</Text><Text>原始要求：{ticket.mandate?.scope || '未知'}</Text><Text>相关仓库：{(tasks.find((r: any) => r.ticket.id === ticket.id)?.context?.targets || []).map((target: any) => target.repository).join('、') || '未知'}</Text>{(tasks.find((r: any) => r.ticket.id === ticket.id)?.context?.workspaces || []).map((w: any) => <Text>工作目录：{w.directory}{w.repository ? ` · 仓库 ${w.repository}` : ''}</Text>)}{(data.routingHistory || []).filter((d: any) => d.ticketId === ticket.id).map((d: any) => <Text>路由：{d.kind} · {d.at} · {(d.reason || []).map((r: any) => r.message || r.code || String(r)).join('、')}</Text>)}</Collapsible>
    </Stack> : null}
  </Stack>
}
