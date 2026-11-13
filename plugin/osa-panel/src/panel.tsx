import { atom, derived, read, set, plugin, Stack, Row, Text, Button, IconButton, Box, Separator, RelativeTime, List, ListItem, Callout, Skeleton, Input, Select, CodeView, Image, env, type Tone, type PanelContext } from 'orca'
import { COMPLETED_STATUSES, isActionableMessage, belongsToTask, isLiveRun, blockedQuestion, isSystemReceipt } from './protocol'
import type { Action, Detail, MessageView, RunView, Section, Selection, Snapshot, TaskView, WorkerView } from './protocol'

const CACHE_VERSION = 3
const cachedSnapshot = atom<Snapshot | null>('last-snapshot', null, { persist: 'workspace', version: CACHE_VERSION, migrate: () => null })
const freshSnapshot = atom<Snapshot | null>(null)
const snapshot = derived(() => read(freshSnapshot) || read(cachedSnapshot))
const error = atom('')
const busy = atom(false)
const limit = atom(20)
const scope = atom('all')
const chosenWorkspace = atom('')
const chosenProject = atom('')
const query = atom('')
const agentFilter = atom('all')
const stateFilter = atom('all')
const grouping = atom('project')
const sort = atom('newest')
const filtersOpen = atom(false)
const collapsed = atom<string[]>([])
const expanded = atom<string[]>([])
const details = atom<Record<string, Detail>>({})
const loadingDetails = atom<string[]>([])
const detailErrors = atom<Record<string, string>>({})
const sending = atom(false)
const result = atom('')
const receipt = atom('')
const mentionTimers = new Map<string, ReturnType<typeof setTimeout>>()
let searchTimer: ReturnType<typeof setTimeout> | undefined
let visibilityContext: PanelContext | undefined
let wasVisible = false
const DONE = COMPLETED_STATUSES
const SECTIONS: { id: Section; name: string; tone: 'danger' | 'warning' | 'accent' | 'success' | 'neutral'; icon: 'bell' | 'flag' | 'activity' | 'pause' }[] = [
  { id: 'attention', name: '需要你', tone: 'danger', icon: 'bell' },
  { id: 'ready', name: '待开始', tone: 'success', icon: 'flag' },
  { id: 'waiting', name: '等外部事件', tone: 'neutral', icon: 'pause' },
  { id: 'active', name: '进行中', tone: 'accent', icon: 'activity' },
  { id: 'history', name: '历史', tone: 'neutral', icon: 'activity' },
]
export interface Item extends Selection {
  key: string; title: string; preview: string; status: string; section: Section
  run: RunView; task?: TaskView; worker?: WorkerView; messages: MessageView[]
  agent: string; summary: string; workspace: string; workspaceName: string; project: string; updatedAt: string
}
export function rows(data: Snapshot): Item[] {
  const items: Item[] = []
  for (const run of data.runs) {
    const live = isLiveRun(run)
    const hasLiveWorker = run.workers.some(worker => worker.liveness === 'live')
    // A Run with no bound Router and no live worker is dormant: keep its tickets out of the working sections.
    const dormant = run.canReassess === false && !hasLiveWorker
    for (const task of run.tasks) {
      if (DONE.has(task.status)) continue
      const worker = run.workers.find(w => w.dispatchId === task.dispatchId) || run.workers.find(w => w.taskId === task.id)
      const section: Section = dormant ? 'history' : task.status === 'blocked' ? 'attention'
        : task.status === 'ready' ? 'ready'
        : task.status === 'pending' ? 'waiting'
        : task.status === 'failed' ? live ? 'attention' : 'history'
        : task.status === 'dispatched' || worker?.liveness === 'live' ? 'active' : 'history'
      const workspace = data.workspaces.find(w => w.id === worker?.workspace)
      const runWorkspace = data.workspaces.find(w => run.workers.some(worker => worker.workspace === w.id))
      const messages = run.messages.filter(message => belongsToTask(message, task, worker))
      items.push({ key: `${run.runId}:${task.id}`, runId: run.runId, taskId: task.id, dispatchId: worker?.dispatchId,
        run, task, worker, messages, title: task.title, preview: task.resultTitle || (task.dependencies?.length ? `等待：${task.dependencies.join('、')}` : '') || task.result || messages[0]?.body || task.spec,
        summary: dormant ? `任务状态：${task.status}`
          : task.status === 'failed' ? `失败${task.resultTitle || task.result ? ` · ${task.resultTitle || task.result}` : ' · 任务记录标记失败'}`
          : task.status === 'blocked' ? task.blockedQuestion || blockedQuestion(task)
          : task.status === 'pending' ? (task.result.slice(0, 120) || '待派发 · 等外部事件') : task.status === 'ready' ? '就绪 · 等待派发'
          : worker?.liveness === 'live' ? (worker.activity === 'working' ? '正在执行' : worker.activity === 'waiting' ? '窗口等待输入' : '执行窗口在线')
          : section === 'history' ? `任务状态：${task.status}` : '已派发 · 运行情况待确认',
        status: task.status, section, agent: worker?.agent || '', workspace: worker?.workspace || '',
        workspaceName: workspace?.name || worker?.workspace?.split('/').pop() || '',
        project: workspace?.project || runWorkspace?.project || run.project,
        updatedAt: task.updatedAt })
    }
    const historicalQuestions = !live ? run.messages.filter(message => isActionableMessage(message, run)) : []
    if (!live && (run.tasks.every(task => DONE.has(task.status)) || historicalQuestions.length > 0)) {
      const worker = run.workers[0]
      const workspace = data.workspaces.find(w => w.id === worker?.workspace)
      items.push({ key: `${run.runId}:history`, runId: run.runId, dispatchId: worker?.dispatchId, run, worker, messages: run.messages, title: run.name,
        preview: run.objective, status: '已结束', summary: historicalQuestions.length ? `${historicalQuestions.length} 条待处理消息 · Run 已结束` : '无在线执行者或活动任务', section: 'history',
        agent: worker?.agent || '', workspace: worker?.workspace || '', workspaceName: workspace?.name || '', project: workspace?.project || run.project, updatedAt: run.updatedAt })
    }
    const pendingMessages = run.messages.filter(m => live && isActionableMessage(m, run))
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    const message = pendingMessages[0]
    if (message) {
      const worker = run.workers.find(w => w.dispatchId === message.dispatchId || w.terminal === message.from)
      const workspace = data.workspaces.find(w => w.id === worker?.workspace)
      items.push({ key: `${run.runId}:messages`, runId: run.runId, dispatchId: worker?.dispatchId, run, worker, messages: pendingMessages,
        title: '有消息待回', preview: message.subject || message.body, status: '待回复', summary: `${message.unread ? '未读待回复' : '已读待回复'} · ${message.subject || message.body || '提问'}`, section: 'attention',
        agent: worker?.agent || '', workspace: worker?.workspace || '', workspaceName: workspace?.name || '',
        project: workspace?.project || run.project, updatedAt: message.createdAt })
    }

  }
  return items
}
export function completedCounts(data: Snapshot, mode: string, scope: { workspace?: string; project?: string; agent?: string } = {}) {
  const counts = new Map<string, number>()
  for (const run of data.runs.filter(isLiveRun)) {
    for (const task of run.completedTasks || run.tasks.filter(task => DONE.has(task.status))) {
      const worker = run.workers.find(worker => worker.dispatchId === task.dispatchId) || run.workers.find(worker => worker.taskId === task.id)
      const workspace = data.workspaces.find(workspace => workspace.id === worker?.workspace)
      const project = workspace?.project || run.project
      if ((scope.workspace && worker?.workspace !== scope.workspace) || (scope.project && project !== scope.project) || (scope.agent && worker?.agent !== scope.agent)) continue
      const key = mode === 'run' ? run.runId : mode === 'project' ? project : mode === 'workspace' ? worker?.workspace || '' : worker?.agent || ''
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return counts
}
function selection(item: Item): Selection {
  return { runId: item.runId, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.dispatchId ? { dispatchId: item.dispatchId } : {}) }
}
function toggle(state: typeof expanded, key: string) {
  const current = read(state)
  set(state, current.includes(key) ? current.filter(id => id !== key) : [...current, key])
}
export function cachePreview(data: Snapshot): Snapshot | null {
  const preview = { ...data, runs: data.runs.map(run => ({ ...run, objective: run.objective.slice(0, 80),
    tasks: run.tasks.map(task => ({ ...task, spec: '', result: '', resultTitle: task.resultTitle || task.result.slice(0, 80),
      ...(task.status === 'blocked' ? { blockedQuestion: task.blockedQuestion || blockedQuestion(task) } : {}) })),
    messages: run.messages.map(message => ({ ...message, subject: message.subject.slice(0, 120), body: message.body.slice(0, 80), systemReceipt: isSystemReceipt(message) })),
  })) }
  // Orca limits each persisted atom to 256 KiB of UTF-8, including its version envelope.
  return new TextEncoder().encode(JSON.stringify({ version: CACHE_VERSION, value: preview })).length <= 262144 ? preview : null
}
async function refresh(force = false) {
  if (read(busy)) return
  set(busy, true)
  const searched = read(query)
  try {
    const next = await plugin.request('osa-tasks.list', { limit: read(limit), query: searched, force }, { timeoutMs: 60000 })
    set(freshSnapshot, next)
    const preview = cachePreview(next)
    set(cachedSnapshot, preview)
    set(error, preview ? '' : '列表已更新；快照超过 Orca 256 KiB 缓存上限，本次不保留缓存。')
  } catch (e) { set(error, String(e)) }
  finally {
    set(busy, false)
    if (searched !== read(query)) void refresh()
  }
}
export function setup(ctx: PanelContext) {
  visibilityContext = ctx
  wasVisible = read(ctx.visible)
  void refresh(true)
  const timer = setInterval(() => { if (read(ctx.visible)) void refresh(true) }, 15000)
  ctx.subscriptions.push({ dispose: () => { if (visibilityContext === ctx) visibilityContext = undefined; clearInterval(timer); clearTimeout(searchTimer); for (const timer of mentionTimers.values()) clearTimeout(timer); mentionTimers.clear() } })
}
async function loadDetail(item: Item, mode: 'latest' | 'history' | 'next' = 'latest') {
  if (read(loadingDetails).includes(item.key)) return
  set(loadingDetails, [...read(loadingDetails), item.key])
  try {
    const detailKey = mode === 'latest' ? item.key : `${item.key}:history`
    const previous = read(details)[detailKey]
    const detail = await plugin.request('osa-tasks.detail', { ...selection(item), history: mode !== 'latest', ...(mode === 'next' && previous?.cursor ? { cursor: previous.cursor } : {}) }, { timeoutMs: 60000 })
    set(details, { ...read(details), [detailKey]: { ...detail, text: mode === 'next' && previous ? `${previous.text}\n\n${detail.text}` : detail.text } })
    set(detailErrors, { ...read(detailErrors), [item.key]: '' })
  } catch (e) { set(detailErrors, { ...read(detailErrors), [item.key]: String(e) }) }
  finally { set(loadingDetails, read(loadingDetails).filter(key => key !== item.key)) }
}
async function act(item: Item, kind: Action['kind']) {
  if (read(sending)) return
  set(sending, true)
  set(result, '')
  set(receipt, '')
  try {
    const response = await plugin.request('osa-tasks.action', { ...selection(item), kind }, { timeoutMs: 60000 })
    set(result, response.message)
    set(receipt, response.receipt || '')
  } catch (e) { set(result, `${String(e)}。未自动重试，请先核对投递结果。`) }
  finally { set(sending, false) }
}
function RecordText({ text }: { text: string }) {
  return <Stack gap="xs"><Text size="xs">{text.slice(0, 16000)}</Text>{text.length > 16000 && <Text size="xs" tone="warning">内容超过 16000 字，已截断显示；原始记录未改动。</Text>}</Stack>
}
function SessionRow({ item }: { item: Item }) {
  const open = read(expanded).includes(item.key)
  const detail = read(details)[item.key]
  const history = read(details)[`${item.key}:history`]
  const conversationOpen = read(expanded).includes(`${item.key}:conversation`)
  const historyOpen = read(expanded).includes(`${item.key}:history`)
  const recordsOpen = read(expanded).includes(`${item.key}:records`)
  const at = Date.parse(item.updatedAt)
  const agent = item.agent.startsWith('claude') ? 'claude' : item.agent === 'codex' ? 'codex' : ''
  const agentName = agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : item.agent
  const frameTone = item.status === 'ready' ? 'success' : item.status === 'failed' || item.section === 'attention' && !item.taskId ? 'danger'
    : item.status === 'blocked' ? 'warning' : item.status === 'pending' ? 'neutral' : item.section === 'active' ? 'accent' : undefined
  const tone: Tone = frameTone || 'neutral'
  return <Stack gap="none">
    <Box paddingY="xs" gap="xs" background={frameTone || 'none'} border={frameTone || false}>
      <Row gap="none" align="center">
        <Box grow minWidth={0}>
          <List><ListItem title={item.title} onPress={() => {
            set(expanded, open ? read(expanded).filter(key => key !== item.key && !key.startsWith(`${item.key}:`)) : [...read(expanded), item.key, `${item.key}:conversation`])
            if (!open && !detail) void loadDetail(item)
          }} /></List>
        </Box>
        <Button size="xs" variant="ghost" tooltip={`单击复制任务引用，粘贴给 Router 询问；双击定位窗口：${item.title}`} disabled={read(sending)} onPress={() => {
          const pending = mentionTimers.get(item.key)
          if (pending) { clearTimeout(pending); mentionTimers.delete(item.key); void act(item, 'open'); return }
          mentionTimers.set(item.key, setTimeout(() => {
            mentionTimers.delete(item.key)
            void act(item, 'mention')
          }, 300))
        }}>@</Button>
      </Row>
      <Box paddingX="sm" gap="xs">
        <Row gap="xs">
          {agent && <Box width={16} height={16} shrink={false}><Image src={`assets/${agent}-${env.theme.colorScheme}.png`} alt={agentName} size="full" /></Box>}
          <Box grow minWidth={0}><Text size="xs" tone={tone} truncate>{item.section === 'active' && agentName ? `${agentName} · ` : ''}{item.summary.replace(/\s+/g, ' ')}</Text></Box>
          {Number.isFinite(at) && <Box shrink={false}><RelativeTime at={at} format="long" muted /></Box>}
        </Row>
        {item.workspaceName && <Row><Box border radius="full" paddingX="xs" minWidth={0}><Text size="xs" weight="medium" truncate>{item.project ? `${read(snapshot)?.workspaces.find(w => w.project === item.project)?.projectName || item.run.project || ''} / ` : ''}{item.workspaceName}</Text></Box></Row>}
      </Box>
      {item.status === 'failed' && item.section === 'attention' && <Box paddingX="sm"><Button size="xs" variant="ghost" tooltip={item.run.canReassess ? '只请求 Router 重新判断，不修改工单状态' : '此 Run 未绑定 Router'} disabled={read(sending) || !item.run.canReassess} onPress={() => void act(item, 'reassess')}>交给 Router 重新判断</Button></Box>}
    </Box>
    {open && <Box padding="sm" background="muted" gap="sm">
      {read(loadingDetails).includes(item.key) && <Skeleton />}
      {read(detailErrors)[item.key] && <Callout tone="danger">{read(detailErrors)[item.key]}</Callout>}
      {conversationOpen && detail && <Stack gap="xs">
        <Text size="xs" weight="semibold">执行者会话 · 最近一轮</Text>
        <Text size="xs" muted>{detail.source}{detail.limited ? ' · 部分记录' : ''}</Text>
        <CodeView code={detail.text} wrap maxHeight="md" />
        {detail.warnings.map(warning => <Text key={warning} size="xs" tone="warning">{warning}</Text>)}
      </Stack>}
      {historyOpen && history && <Stack gap="xs">
        <Text size="xs" weight="semibold">执行者会话 · 历史记录</Text>
        <Text size="xs" muted>{history.source}{history.limited ? ' · 部分记录' : ''}</Text>
        <CodeView code={history.text} wrap maxHeight="md" />
        {history.warnings.map(warning => <Text key={warning} size="xs" tone="warning">{warning}</Text>)}
        {history.cursor && <Button size="xs" variant="ghost" disabled={read(loadingDetails).includes(item.key)} onPress={() => void loadDetail(item, 'next')}>读取后续记录</Button>}
      </Stack>}
      {recordsOpen && <Stack gap="xs">
      <Text size="xs" weight="semibold">Router/Executor 往来消息与工单记录</Text>
      <Text size="xs" muted>Router 收件箱：{item.run.name} · Run {item.runId}</Text>
      <Text size="xs" muted>工单 {item.taskId || '消息'} · 派发 {item.dispatchId || '尚未派发'} · {item.worker?.agentSource || '未取得智能体信息'}</Text>
      <RecordText text={detail?.spec || item.task?.spec || item.run.objective} />
      {(detail?.result || item.task?.result) && <RecordText text={`结果：${detail?.result || item.task?.result}`} />}
      {(detail?.messages || item.messages).map(message => <Stack key={message.id} gap="xs">
        <Text size="xs" muted>{message.replied ? '已回复' : !message.unread ? '已读' : message.deliveredAt ? '已送达' : '待送达'}</Text>
        <Text size="xs" weight="medium">{message.subject} · {message.from}</Text>
        <RecordText text={message.body} />
      </Stack>)}
      </Stack>}
      <Row gap="sm" wrap>
        <Button size="xs" variant="ghost" disabled={read(loadingDetails).includes(item.key)} onPress={() => void loadDetail(item, historyOpen ? 'history' : 'latest')}>刷新详情</Button>
        <Button size="xs" variant="ghost" onPress={() => {
          toggle(expanded, `${item.key}:conversation`)
          if (!conversationOpen) { set(expanded, read(expanded).filter(key => key !== `${item.key}:history`)); if (!detail) void loadDetail(item) }
        }}>{conversationOpen ? '收起执行者会话' : '查看执行者会话'}</Button>
        {item.worker && <Button size="xs" variant="ghost" disabled={read(loadingDetails).includes(item.key)} onPress={() => {
          toggle(expanded, `${item.key}:history`)
          if (!historyOpen) { set(expanded, read(expanded).filter(key => key !== `${item.key}:conversation`)); if (!history) void loadDetail(item, 'history') }
        }}>{historyOpen ? '收起执行历史' : '查看执行历史'}</Button>}
        <Button size="xs" variant="ghost" onPress={() => toggle(expanded, `${item.key}:records`)}>{recordsOpen ? '收起往来消息' : '查看往来消息'}</Button>
        {item.run.canReassess && !(item.status === 'failed' && item.section === 'attention') && <Button size="xs" variant="ghost" disabled={read(sending)} onPress={() => void act(item, 'reassess')}>交给 Router 重新判断</Button>}
      </Row>
    </Box>}
    <Separator />
  </Stack>
}
export default function Panel() {
  if (visibilityContext) {
    const ctx = visibilityContext
    const visible = read(ctx.visible)
    const becameVisible = visible && !wasVisible
    wasVisible = visible
    // Reading subscribes to visibility; defer the refresh beyond the pure render phase.
    if (becameVisible) void Promise.resolve().then(() => { if (!ctx.signal.aborted && read(ctx.visible)) void refresh(true) })
  }
  const data = read(snapshot)
  const all = data ? rows(data) : []
  const needle = read(query).trim().toLocaleLowerCase()
  const filtered = all.filter(item => (read(scope) === 'all' || (read(scope) === 'workspace' ? item.workspace === (read(chosenWorkspace) || data?.currentWorkspace) : item.project === (read(chosenProject) || data?.currentProject)))
    && (read(agentFilter) === 'all' || item.agent === read(agentFilter))
    && (read(stateFilter) === 'all' || item.section === read(stateFilter))
    && (!needle || [item.title, item.preview, item.task?.spec, item.task?.result, item.task?.searchMatch, item.run.name, item.agent, item.workspaceName, item.status, ...item.messages.map(message => message.body)].join(' ').toLocaleLowerCase().includes(needle)))
    .sort((a, b) => read(sort) === 'title' ? a.title.localeCompare(b.title) : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
  const completed = data ? completedCounts(data, read(grouping), {
    ...(read(scope) === 'workspace' ? { workspace: read(chosenWorkspace) || data.currentWorkspace } : {}),
    ...(read(scope) === 'project' ? { project: read(chosenProject) || data.currentProject } : {}),
    ...(read(agentFilter) !== 'all' ? { agent: read(agentFilter) } : {}),
  }) : new Map<string, number>()
  const countedGroups = new Set<string>()
  return <Stack gap="none">
    <Box padding="xs" gap="sm">
      <Row justify="between">
        <Row gap="xs"><Box width={18} height={18}><Image src={`assets/paper-pen-${env.theme.colorScheme}.png`} alt="纸笔" size="full" /></Box><Text size="sm" weight="semibold">任务清单</Text></Row>
        <Row gap="none">
          <IconButton icon="filter" label="筛选与分组" size="xs" onPress={() => set(filtersOpen, !read(filtersOpen))} />
          <IconButton icon="refresh" label="刷新" size="xs" disabled={read(busy)} onPress={() => refresh(true)} />
        </Row>
      </Row>
      <Box columns={3} gap="none" border radius="sm" background="muted">
        <Button size="xs" variant={read(scope) === 'workspace' ? 'outline' : 'ghost'} disabled={!data?.workspaces.length} onPress={() => set(scope, 'workspace')}>工作区</Button>
        <Button size="xs" variant={read(scope) === 'project' ? 'outline' : 'ghost'} disabled={!data?.workspaces.length} onPress={() => set(scope, 'project')}>项目</Button>
        <Button size="xs" variant={read(scope) === 'all' ? 'outline' : 'ghost'} onPress={() => set(scope, 'all')}>全部</Button>
      </Box>
      {read(scope) === 'workspace' && <Select label="工作区" value={read(chosenWorkspace) || data?.currentWorkspace || '__choose__'} options={[{ value: '__choose__', label: '选择工作区' }, ...(data?.workspaces || []).map(w => ({ value: w.id, label: `${w.name} · ${w.path}` }))]} onChange={value => set(chosenWorkspace, value)} />}
      {read(scope) === 'project' && <Select label="项目" value={read(chosenProject) || data?.currentProject || '__choose__'} options={[{ value: '__choose__', label: '选择项目' }, ...Array.from(new Map((data?.workspaces || []).map(w => [w.project, { value: w.project, label: w.projectName }])).values())]} onChange={value => set(chosenProject, value)} />}

      <Input type="search" label="搜索会话" labelHidden placeholder="搜索已载入会话" value={read(query)} maxLength={500} onSubmit={() => refresh(true)} onChange={value => { set(query, value); clearTimeout(searchTimer); searchTimer = setTimeout(() => void refresh(), 300) }} />
      {read(filtersOpen) && <Stack gap="xs">
        <Select label="智能体" value={read(agentFilter)} options={[{ value: 'all', label: '全部智能体' }, ...Array.from(new Set(all.map(item => item.agent).filter(Boolean))).map(agent => ({ value: agent, label: agent }))]} onChange={value => set(agentFilter, value)} />
        <Select label="状态" value={read(stateFilter)} options={[{ value: 'all', label: '全部状态' }, ...SECTIONS.map(section => ({ value: section.id, label: section.name }))]} onChange={value => set(stateFilter, value)} />
        <Select label="分组" value={read(grouping)} options={[{ value: 'run', label: 'Router 收件箱' }, { value: 'project', label: '项目' }, { value: 'workspace', label: '工作区' }, { value: 'agent', label: '智能体' }]} onChange={value => set(grouping, value)} />
      </Stack>}
      <Row justify="between">
        <Text size="xs">{filtered.filter(item => item.section !== 'history').length} / {all.filter(item => item.section !== 'history').length} 项待办</Text>
        <Select label="排序" labelHidden value={read(sort)} options={[{ value: 'newest', label: '最后更新' }, { value: 'title', label: '标题' }]} onChange={value => set(sort, value)} />
      </Row>
    </Box>
    <Separator />
    {read(error) && <Callout tone="danger">{read(error)}</Callout>}
    {data?.warnings.map(warning => <Callout key={warning} tone="warning">{warning}</Callout>)}
    {read(result) && <Box padding="sm" gap="xs"><Text size="xs">{read(result)}</Text>{read(receipt) && <CodeView code={read(receipt)} wrap maxHeight="sm" />}</Box>}
    {!data && <Skeleton />}
    {data && !filtered.length && <Box padding="sm"><Text size="sm" muted>当前范围没有匹配的会话。</Text></Box>}
    {SECTIONS.map(section => {
      const groups = new Map<string, { name: string; items: Item[] }>()
      for (const item of filtered.filter(item => item.section === section.id)) {
        const mode = read(grouping)
        const key = mode === 'run' ? item.runId : mode === 'project' ? item.project : mode === 'workspace' ? item.workspace : item.agent
        const name = mode === 'run' ? item.run.name : mode === 'workspace' ? item.workspaceName : mode === 'project' ? data?.workspaces.find(w => w.project === item.project)?.projectName || item.run.project || item.project || '未分配项目' : item.agent
        const group = groups.get(key)
        if (group) group.items.push(item)
        else groups.set(key, { name, items: [item] })
      }
      if (!groups.size) return null
      return <Stack key={section.id} gap="none">
        <Box paddingX="sm" paddingY="xs">{section.id === 'history'
          ? <Button size="xs" variant="ghost" icon={read(expanded).includes('__history__') ? 'expand' : 'next'} onPress={() => toggle(expanded, '__history__')}>历史</Button>
          : <Text size="xs" weight="semibold" tone={section.tone}>{section.name}</Text>}</Box>
        {(section.id !== 'history' || read(expanded).includes('__history__')) && Array.from(groups, ([id, group]) => {
          const key = `${section.id}:${read(grouping)}:${id}`
          const closed = read(collapsed).includes(key)
          const completedCount = section.id !== 'history' && !countedGroups.has(id) ? completed.get(id) || 0 : 0
          countedGroups.add(id)
          return <Stack key={key} gap="none">
            <Separator />
            <Box background="muted"><List label={`${group.name} · 分组`}><ListItem key={key} icon={closed ? 'next' : 'expand'} onPress={() => toggle(collapsed, key)}>
              <Row justify="between"><Box grow minWidth={0}><Text size="xs" weight="semibold" truncate>{group.name}</Text></Box>{completedCount > 0 && <Box shrink={false}><Text size="xs" muted>已完成 {completedCount}</Text></Box>}<Box border radius="sm" background="card" minWidth={24} height={18} align="center" justify="center" shrink={false}><Text size="xs" weight="medium">{group.items.length}</Text></Box></Row>
            </ListItem></List></Box>
            <Separator />
            {!closed && group.items.map(item => <SessionRow key={item.key} item={item} />)}
          </Stack>
        })}
      </Stack>
    })}
    {data?.more && <Button size="sm" variant="ghost" disabled={read(busy) || read(limit) >= 1000} onPress={() => { set(limit, Math.min(1000, read(limit) + 20)); void refresh() }}>加载更早的 Run（已读取 {data.runs.length} 个）</Button>}
  </Stack>
}
