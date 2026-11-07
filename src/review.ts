import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readlink, realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import type { Store } from "./store.ts"

const execute = promisify(execFile)
type Target = { ticketId: string; repository: string; kind: string; hostId: string }
type Binding = { ticketId: string; dispatchId?: string; terminal?: string }
export type ReviewRecord = {
  ticketId: string; assignmentId: string; executorDispatchId: string; dispatchId: string
  verdict: "approve" | "reject"; fingerprint: string; feedback: string
  round: number; blocked: boolean; messageId: string
}

/** Orca supplies identity and settlement; only the service writes accepted evidence. */
export class ReviewGate {
  constructor(private readonly store: Store, private readonly options: { cli: string; repository: string }) {}

  private context(ticketId: string, assignmentId: string) {
    const ticket = this.store.tickets.get(ticketId)
    const binding = this.store.get<Binding>("orca-assignment", assignmentId)
    const assignment = ticket?.assignments.at(-1)
    if (!ticket || ticket.ended || assignment?.id !== assignmentId || assignment.state !== "running"
      || binding?.ticketId !== ticketId || !binding.dispatchId || !binding.terminal || !ticket.execution?.directory)
      throw new Error("Review requires the current running Executor assignment")
    return { ticket, binding, directory: ticket.execution.directory }
  }

  guard(ticketId: string, assignmentId: string): () => void {
    const revision = () => {
      const { ticket, binding, directory } = this.context(ticketId, assignmentId)
      return JSON.stringify({ directory, dispatchId: binding.dispatchId, terminal: binding.terminal,
        target: this.store.get('ticket-target', ticketId), mandate: ticket.mandate,
        inputs: ticket.inputs.map(input => {
          if (input.kind !== 'trigger') return input
          const { readAt: _read, deliveredTo: _delivered, ...content } = input
          return { ...content, trigger: this.store.triggers.get(input.triggerId) }
        }) })
    }
    const before = revision()
    return () => { if (revision() !== before) throw new Error('Review revision is stale') }
  }

  async snapshot(ticketId: string, assignmentId: string): Promise<{ fingerprint: string }> {
    const unchanged = this.guard(ticketId, assignmentId)
    const { ticket, binding, directory } = this.context(ticketId, assignmentId)
    const git = async (...args: string[]) => (await execute("git", ["-C", directory, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout
    const hash = createHash("sha256")
    const add = (value: string | Buffer) => { const bytes = Buffer.from(value); hash.update(String(bytes.length) + ":"); hash.update(bytes) }
    const target = this.store.get<Target>("ticket-target", ticketId)
    if (!target && (this.store.list("project").length || this.store.list("ticket-target").length || this.store.list("github.cursor").length > 1)) throw new Error("Ticket target is unknown")
    if (target) {
      if (target.ticketId !== ticketId || target.kind !== "git" || target.hostId !== "local" || !isAbsolute(target.repository)) throw new Error("Invalid review target")
      const root = await realpath(target.repository)
      const targetGit = async (...args: string[]) => (await execute("git", ["-C", root, ...args])).stdout.trim()
      if (await realpath(await targetGit("rev-parse", "--show-toplevel")) !== root
        || await realpath((await git("rev-parse", "--path-format=absolute", "--git-common-dir")).toString().trim())
          !== await realpath(await targetGit("rev-parse", "--path-format=absolute", "--git-common-dir"))
        || await realpath((await git("rev-parse", "--show-toplevel")).toString().trim()) !== await realpath(directory))
        throw new Error("Review workspace does not belong to ticket target")
      add(JSON.stringify(target))
      add(root)
      add(await realpath(await targetGit("rev-parse", "--path-format=absolute", "--git-common-dir")))
    }
    add(JSON.stringify({ ticketId, assignmentId, dispatchId: binding.dispatchId, mandate: ticket.mandate,
      inputs: ticket.inputs.map(input => {
        if (input.kind !== "trigger") return input
        const { readAt: _read, deliveredTo: _delivered, ...content } = input
        return { ...content, trigger: this.store.triggers.get(input.triggerId) }
      }) }))
    add(await git("rev-parse", "HEAD"))
    add(await git("diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"))
    add(await git("diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--"))
    const files = [...new Set((await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).toString().split("\0").filter(Boolean))].sort()
    for (const file of files) {
      add(file)
      let stat
      try { stat = await lstat(join(directory, file)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { add("deleted"); continue }; throw error }
      if (stat.isSymbolicLink()) { add("symlink"); add(await readlink(join(directory, file))) }
      else if (stat.isFile()) { add(String(stat.mode & 0o111)); add(await readFile(join(directory, file))) }
      else throw new Error(`Cannot fingerprint non-file ${file}; submodule review is unsupported`)
    }
    unchanged()
    return { fingerprint: hash.digest("hex") }
  }

  private async read(args: string[], directory: string): Promise<any> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ORCA_")))
    const { stdout } = await execute(this.options.cli, ["orchestration", ...args, "--json", "--full"], {
      env, cwd: directory, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    })
    const response = JSON.parse(stdout)
    if (response?.ok !== true || !response.result) throw new Error("Orca review evidence unavailable")
    return response.result
  }

  async record(ticketId: string, assignmentId: string, dispatchId: string): Promise<ReviewRecord> {
    const unchanged = this.guard(ticketId, assignmentId)
    const { binding, directory } = this.context(ticketId, assignmentId)
    const previous = this.store.get<ReviewRecord>("review-round", dispatchId)
    if (previous) {
      if (previous.ticketId !== ticketId || previous.assignmentId !== assignmentId || previous.executorDispatchId !== binding.dispatchId)
        throw new Error("Review belongs to a foreign Executor assignment")
      if (previous.fingerprint !== (await this.snapshot(ticketId, assignmentId)).fingerprint) throw new Error("Review revision is stale")
      unchanged()
      return previous
    }
    const shown = await this.read(["worker-show", "--dispatch", dispatchId], directory)
    const { dispatch, worker } = shown
    if (!dispatchId || dispatch?.id !== dispatchId || worker?.dispatchId !== dispatchId
      || dispatch.creatorDispatchId !== binding.dispatchId || dispatch.assigneeHandle === binding.terminal
      || worker.agentTerminalHandle !== dispatch.assigneeHandle)
      throw new Error("Review must be an independent child of the current Executor dispatch")
    if (worker.startOptions?.launch?.effective?.agent !== "claude") throw new Error("Independent review requires Claude")
    if (dispatch.status !== "completed" || worker.state !== "succeeded") throw new Error("Review has no succeeded settlement")
    const worktree = worker.worktreeId
    const path = typeof worktree === "string" && worktree.includes("::") ? worktree.slice(worktree.indexOf("::") + 2) : ""
    if (!isAbsolute(path) || await realpath(path) !== await realpath(directory)) throw new Error("Review worktree mismatch")
    // A task result can be replaced by a later retry; bind it to its current dispatch.
    const current = await this.read(["dispatch-show", "--task", dispatch.taskId], directory)
    if (current.dispatch?.id !== dispatchId) throw new Error("Review dispatch is stale")
    const tasks = await this.read(["task-list", "--run", dispatch.runId], directory)
    const task = tasks.tasks?.find((item: any) => item.id === dispatch.taskId && item.run_id === dispatch.runId)
    const result = typeof task?.result === "string" ? JSON.parse(task.result) : task?.result
    if (task?.status !== "completed" || result?.provenance !== "worker_report" || result.outcome !== "succeeded"
      || result.reportedBy !== dispatch.assigneeHandle || result.completedBy !== dispatch.assigneeHandle
      || typeof result.messageId !== "string" || !result.messageId || typeof result.body !== "string")
      throw new Error("Review requires a genuine worker_done result")
    const lines = result.body.split("\n").filter((line: string) => line.startsWith("OSA_REVIEW "))
    if (lines.length !== 1) throw new Error("Review result needs one OSA_REVIEW JSON line")
    const review = JSON.parse(lines[0].slice("OSA_REVIEW ".length))
    if (!review || !["approve", "reject"].includes(review.verdict) || typeof review.feedback !== "string"
      || !review.feedback.trim() || !/^[a-f0-9]{64}$/.test(review.fingerprint)) throw new Error("Invalid OSA_REVIEW result")
    const fingerprint = (await this.snapshot(ticketId, assignmentId)).fingerprint
    if (review.fingerprint !== fingerprint) throw new Error("Review revision is stale")
    return this.store.atomic(() => {
      unchanged()
      const currentBinding = this.context(ticketId, assignmentId).binding
      if (currentBinding.dispatchId !== binding.dispatchId) throw new Error("Executor changed during review verification")
      const duplicate = this.store.get<ReviewRecord>("review-round", dispatchId)
      if (duplicate) return duplicate
      const rounds = this.store.list<ReviewRecord>("review-round").filter(item => item.executorDispatchId === binding.dispatchId)
      if (rounds.length >= 2) throw new Error("Two review rounds exhausted; report blocked")
      const record: ReviewRecord = { ticketId, assignmentId, executorDispatchId: binding.dispatchId!, dispatchId,
        verdict: review.verdict, fingerprint, feedback: review.feedback, round: rounds.length + 1,
        blocked: rounds.length === 1 && review.verdict === "reject", messageId: result.messageId }
      this.store.put("review-round", dispatchId, record)
      this.store.put("review", assignmentId, record)
      return record
    })
  }

  async assertReady(ticketId: string, assignmentId: string): Promise<void> {
    const unchanged = this.guard(ticketId, assignmentId)
    const { binding } = this.context(ticketId, assignmentId)
    const record = this.store.get<ReviewRecord>("review", assignmentId)
    if (!record || record.ticketId !== ticketId || record.executorDispatchId !== binding.dispatchId || record.verdict !== "approve")
      throw new Error(record?.blocked ? "Two review rounds exhausted; report blocked" : "Current independent Claude approval required")
    if (record.fingerprint !== (await this.snapshot(ticketId, assignmentId)).fingerprint) throw new Error("Review revision is stale")
    unchanged()
    if (JSON.stringify(record) !== JSON.stringify(this.store.get("review", assignmentId))) throw new Error("Review approval changed")
  }
}
