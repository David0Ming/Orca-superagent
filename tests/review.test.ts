import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Ticket } from "../vendor/dsh-core/src/index.ts"
import { ReviewGate } from "../src/review.ts"
import { Store } from "../src/store.ts"

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "osa-review-"))
  const repository = join(dir, "repo")
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "pipe" })
  execFileSync("git", ["init", repository], { stdio: "pipe" })
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Test")
  writeFileSync(join(repository, "tracked"), "base\n")
  writeFileSync(join(repository, ".gitignore"), "ignored\n")
  git("add", ".")
  git("commit", "-m", "fixture")
  const state = join(dir, "evidence.json"), cli = join(dir, "orca"), database = join(dir, "store.sqlite")
  writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const data = args[1] === "worker-show" ? state.shown : args[1] === "dispatch-show" ? {dispatch:{id:state.current}} : {tasks:[state.task]};
console.log(JSON.stringify({ok:true,result:data}));
`, { mode: 0o755 })
  let store = new Store(database), gate = new ReviewGate(store, { cli, repository })
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const ticket: Ticket = {
    id: "ticket", title: "Review this", mandate: { scope: "Fix this", strength: "explicit", policyVersion: "1", basis: { via: "listed" }, actor: { source: "router", id: "owner" } },
    decisionId: "decision", channels: [], assignments: [{ id: "assignment", state: "running", createdAt: "now" }], inputs: [], undelivered: [],
    createdAt: "now", updatedAt: "now", origin: { triggerId: "trigger", triggerIds: ["trigger"] }, execution: { name: "branch", directory: repository, assignment: "Fix this" },
  }
  store.tickets.save(ticket)
  store.put("orca-assignment", "assignment", { ticketId: "ticket", dispatchId: "executor", terminal: "executor-terminal" })
  const evidence = async (id = "reviewer", verdict = "approve") => {
    const { fingerprint } = await gate.snapshot("ticket", "assignment")
    const body = "I reviewed the changes. Checks completed. Nothing remains.\nOSA_REVIEW " + JSON.stringify({ verdict, fingerprint, feedback: verdict === "approve" ? "Checks pass" : "Fix missing validation" })
    const result = { provenance: "worker_report", outcome: "succeeded", reportedBy: "review-terminal", completedBy: "review-terminal", messageId: "message-" + id, body }
    writeFileSync(state, JSON.stringify({ current: id,
      shown: { dispatch: { id, creatorDispatchId: "executor", assigneeHandle: "review-terminal", taskId: "review-task", runId: "child-run", status: "completed" },
        worker: { dispatchId: id, agentTerminalHandle: "review-terminal", state: "succeeded", worktreeId: "repo::" + repository, startOptions: { launch: { effective: { agent: "claude" } } } } },
      task: { id: "review-task", run_id: "child-run", status: "completed", result: JSON.stringify(result) },
    }))
  }
  const patch = (change: (data: any) => void) => { const data = JSON.parse(readFileSync(state, "utf8")); change(data); writeFileSync(state, JSON.stringify(data)) }
  return { dir, repository, ticket, git, evidence, patch, get gate() { return gate }, get store() { return store },
    restart() { store.close(); store = new Store(database); gate = new ReviewGate(store, { cli, repository }) },
  }
}

describe("independent review gate", () => {
  it("fingerprints stable content, tracked/index/untracked bytes, modes and symlinks while excluding ignored files", async () => {
    const f = setup(), snapshot = () => f.gate.snapshot("ticket", "assignment")
    const first = await snapshot()
    expect(await snapshot()).toEqual(first)
    writeFileSync(join(f.repository, "ignored"), "ignored output")
    expect(await snapshot()).toEqual(first)
    writeFileSync(join(f.repository, "tracked"), "changed\n")
    const changed = await snapshot()
    expect(changed).not.toEqual(first)
    f.git("add", "tracked")
    expect(await snapshot()).not.toEqual(changed)
    f.git("reset", "--hard", "HEAD")
    writeFileSync(join(f.repository, "untracked"), "one")
    const untracked = await snapshot()
    writeFileSync(join(f.repository, "untracked"), "two")
    expect(await snapshot()).not.toEqual(untracked)
    rmSync(join(f.repository, "untracked"))
    chmodSync(join(f.repository, "tracked"), 0o755)
    expect(await snapshot()).not.toEqual(first)
    chmodSync(join(f.repository, "tracked"), 0o644)
    symlinkSync("tracked", join(f.repository, "link"))
    expect(await snapshot()).not.toEqual(first)
  })

  it("requires evidence and persists idempotent approval across restart", async () => {
    const f = setup()
    await expect(f.gate.assertReady("ticket", "assignment")).rejects.toThrow("approval")
    await f.evidence()
    const approved = await f.gate.record("ticket", "assignment", "reviewer")
    expect(approved).toMatchObject({ verdict: "approve", round: 1, blocked: false, executorDispatchId: "executor" })
    await expect(f.gate.assertReady("ticket", "assignment")).resolves.toBeUndefined()
    f.restart()
    expect(await f.gate.record("ticket", "assignment", "reviewer")).toEqual(approved)
    expect(f.store.list("review-round")).toHaveLength(1)
    await expect(f.gate.assertReady("ticket", "assignment")).resolves.toBeUndefined()
  })

  it.each([
    ["non-Claude", (d: any) => { d.shown.worker.startOptions.launch.effective.agent = "codex" }],
    ["unproven model", (d: any) => { delete d.shown.worker.startOptions.launch.effective; d.shown.worker.startOptions.agent = "claude" }],
    ["foreign parent", (d: any) => { d.shown.dispatch.creatorDispatchId = "old-executor" }],
    ["same terminal", (d: any) => { d.shown.dispatch.assigneeHandle = "executor-terminal"; d.shown.worker.agentTerminalHandle = "executor-terminal" }],
    ["unsettled", (d: any) => { d.shown.dispatch.status = "dispatched" }],
    ["failed", (d: any) => { d.shown.worker.state = "failed" }],
    ["foreign worktree", (d: any) => { d.shown.worker.worktreeId = "repo::/tmp" }],
    ["stale retry", (d: any) => { d.current = "new-reviewer" }],
    ["manual result", (d: any) => { const r = JSON.parse(d.task.result); r.provenance = "manual"; d.task.result = JSON.stringify(r) }],
    ["forged reporter", (d: any) => { const r = JSON.parse(d.task.result); r.reportedBy = "executor-terminal"; d.task.result = JSON.stringify(r) }],
    ["missing marker", (d: any) => { const r = JSON.parse(d.task.result); r.body = "Looks good"; d.task.result = JSON.stringify(r) }],
    ["duplicate marker", (d: any) => { const r = JSON.parse(d.task.result); r.body += "\n" + r.body.split("\n")[1]; d.task.result = JSON.stringify(r) }],
  ])("rejects %s evidence", async (_name, change) => {
    const f = setup()
    await f.evidence()
    f.patch(change as (data: any) => void)
    await expect(f.gate.record("ticket", "assignment", "reviewer")).rejects.toThrow()
    expect(f.store.get("review", "assignment")).toBeUndefined()
  })

  it("invalidates approval when filesystem revision or input scope changes, but not on input acknowledgements", async () => {
    const f = setup()
    f.ticket.inputs.push({ id: "input", kind: "trigger", triggerId: "trigger", human: true, at: "now" })
    f.store.tickets.save(f.ticket)
    await f.evidence()
    await f.gate.record("ticket", "assignment", "reviewer")
    const input = f.ticket.inputs[0]!
    if (input.kind === "trigger") { input.readAt = "later"; input.deliveredTo = "assignment" }
    f.store.tickets.save(f.ticket)
    await expect(f.gate.assertReady("ticket", "assignment")).resolves.toBeUndefined()
    writeFileSync(join(f.repository, "tracked"), "unreviewed")
    await expect(f.gate.assertReady("ticket", "assignment")).rejects.toThrow("stale")
    await expect(f.gate.record("ticket", "assignment", "reviewer")).rejects.toThrow("stale")
    f.git("checkout", "--", "tracked")
    f.ticket.inputs.push({ id: "new", kind: "text", text: "New scope", at: "later" })
    f.store.tickets.save(f.ticket)
    await expect(f.gate.assertReady("ticket", "assignment")).rejects.toThrow("stale")
  })

  it("rejects a stale revision before recording and a previous Executor after reassignment", async () => {
    const f = setup()
    await f.evidence()
    writeFileSync(join(f.repository, "tracked"), "changed after review")
    await expect(f.gate.record("ticket", "assignment", "reviewer")).rejects.toThrow("stale")
    await f.evidence()
    f.store.put("orca-assignment", "assignment", { ticketId: "ticket", dispatchId: "replacement", terminal: "new-terminal" })
    await expect(f.gate.record("ticket", "assignment", "reviewer")).rejects.toThrow("current Executor")
  })

  it("returns rejection feedback, allows one fix/review and blocks a third round across restart", async () => {
    const f = setup()
    await f.evidence("first", "reject")
    expect(await f.gate.record("ticket", "assignment", "first")).toMatchObject({ feedback: "Fix missing validation", round: 1, blocked: false })
    await expect(f.gate.assertReady("ticket", "assignment")).rejects.toThrow("approval")
    writeFileSync(join(f.repository, "tracked"), "fix")
    await f.evidence("second", "reject")
    expect(await f.gate.record("ticket", "assignment", "second")).toMatchObject({ round: 2, blocked: true })
    f.restart()
    await expect(f.gate.assertReady("ticket", "assignment")).rejects.toThrow("report blocked")
    await f.evidence("third")
    await expect(f.gate.record("ticket", "assignment", "third")).rejects.toThrow("Two review rounds")
    expect(f.store.list("review-round")).toHaveLength(2)
  })

  it("invalidates approval for a new commit even with identical filesystem bytes", async () => {
    const f = setup()
    await f.evidence()
    await f.gate.record("ticket", "assignment", "reviewer")
    f.git("commit", "--allow-empty", "-m", "new revision")
    await expect(f.gate.assertReady("ticket", "assignment")).rejects.toThrow("stale")
  })

  it("accepts a corrected second review without letting a replay replace the latest verdict", async () => {
    const f = setup()
    await f.evidence("first", "reject")
    await f.gate.record("ticket", "assignment", "first")
    await f.evidence("second")
    await f.gate.record("ticket", "assignment", "second")
    await f.gate.record("ticket", "assignment", "first")
    expect(f.store.get("review", "assignment")).toMatchObject({ verdict: "approve", round: 2 })
    await expect(f.gate.assertReady("ticket", "assignment")).resolves.toBeUndefined()
  })
})


it("binds review fingerprints to the immutable target and the real Git common directory", async () => {
  const f = setup()
  const target = { ticketId: "ticket", projectId: "a", componentId: "main", locationId: "local", hostId: "local", kind: "git", repository: f.repository, boundAt: "now" }
  f.store.put("ticket-target", "ticket", target)
  const first = await f.gate.snapshot("ticket", "assignment")
  const worktree = join(f.dir, "worktree")
  f.git("worktree", "add", "-b", "isolated", worktree)
  f.store.tickets.save({ ...f.ticket, execution: { ...f.ticket.execution!, directory: worktree } })
  expect(await f.gate.snapshot("ticket", "assignment")).toEqual(first)
  await f.evidence()
  f.patch(data => { data.shown.worker.worktreeId = "repo::" + worktree })
  await f.gate.record("ticket", "assignment", "reviewer")
  f.store.put("ticket-target", "ticket", { ...target, projectId: "other" })
  await expect(f.gate.assertReady("ticket", "assignment")).rejects.toThrow("stale")
  f.store.put("ticket-target", "ticket", target)
  const clone = join(f.dir, "clone")
  execFileSync("git", ["clone", f.repository, clone], { stdio: "pipe" })
  f.store.tickets.save({ ...f.ticket, execution: { ...f.ticket.execution!, directory: clone } })
  await expect(f.gate.snapshot("ticket", "assignment")).rejects.toThrow("does not belong")
})

it("fails closed for missing, folder and remote review targets once targets are configured", async () => {
  const f = setup()
  f.store.put("ticket-target", "other", { ticketId: "other" })
  await expect(f.gate.snapshot("ticket", "assignment")).rejects.toThrow("unknown")
  for (const target of [{ kind: "folder", hostId: "local" }, { kind: "git", hostId: "remote" }]) {
    f.store.put("ticket-target", "ticket", { ticketId: "ticket", repository: f.repository, ...target })
    await expect(f.gate.snapshot("ticket", "assignment")).rejects.toThrow("Invalid review target")
  }
})

it("regression: new input during readiness verification invalidates approval", async () => {
  const f = setup(); await f.evidence(); await f.gate.record("ticket", "assignment", "reviewer")
  const checking = f.gate.assertReady("ticket", "assignment")
  const ticket = f.store.tickets.get("ticket")!
  ticket.inputs.push({ id: "during-check", kind: "text", text: "New requirement during verification", at: "later" })
  f.store.tickets.save(ticket)
  await expect(checking).rejects.toThrow("stale")
})
