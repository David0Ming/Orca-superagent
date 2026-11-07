# P4 read-only audit — Super-agent-orca

## Coordinator disposition after fixes

Audit Task `task_c363a5f3f8d8`, Dispatch `ctx_a0e5d5f72bdd`, independent Claude; settled succeeded and released. The findings below describe the pre-fix revision.

- Router attention: on the same proven runtime/terminal identity, an absent wake request can retry the same request ID; this is only an inbox hint, never task execution. Unknown states still fail closed. Failed attention is backed off 15 seconds; explicit `router unbind` then `router bind` is documented for inspected manual recovery.
- Cleanup: poll deadlines apply to settled/closing assignments; cleanup errors back off 15 seconds, and observation remains bounded. New settlement clears its observation deadline once so successful completion is still recorded immediately. No forced cancellation or blind release retry was added.
- Late attachment: repository guard now reads the target after binding, within the same transaction. A mismatched repository rolls the new binding back; regression added.
- Later GitHub enablement: verified source config is attached to an empty legacy component for future tickets, without retroactively changing frozen old targets.
- Unspecified local thread: now defaults to a stable per-request thread, so unrelated new requests cannot be absorbed by a global `window` subscription. Explicit thread continuation and `route attach` remain available.
- Migration: only the initial pre-marker migration may bind old unbound tickets. Later deliberately unbound tickets remain blocked instead of silently retargeting on restart.
- Owner-wide registry lists are intentional for the requested multi-project overview and remain Router-lease protected. Executor `read` remains project/goal scoped; no global knowledge is implicitly injected. This low-priority observation did not require a code change.

The audit worker left `delivery_a8b8b89f8101` outstanding in its now-released Dispatch mailbox (two coordinator status notes). Native inventory confirms all four implementation/audit workers released. Current CLI offers no targeted settled-mailbox discard; global reset would affect unrelated running Router state, so no reset or impersonated worker ack was used. The existing watchdog reports this batch only once. This is a native audit residue, not an active task blocker.

Scope: src/app.ts, src/projects.ts, src/router.ts, src/orca.ts, src/review.ts, src/publish.ts, src/github.ts,
bin/osa.ts, scripts/osa-service.mjs against docs/P4-MULTIPROJECT-PLAN.md.
Read-only: no repo file changed, no commit, no external side effects, full suite not run.
`tsc --noEmit`: clean.
Files re-checked for concurrent edits at 20:05–20:10 (src/projects.ts changed at 20:05:09 during the audit and was
re-read; the other eight targets were unchanged since my first read). Line numbers below match that state.

## P1 — Router attention can wedge permanently (P4-D "reliable wake")

`src/router.ts:85-99`, with `src/router.ts:92-93`, `src/router.ts:102-105`, `src/router.ts:38-42`.

- `wake.attempted = true` is persisted *before* the first `orchestration send --retry-request` (92-93).
- On the next tick, `attempted` routes through `request-show` (86); anything other than `completed` throws at 88
  ("receipt is uncertain"). `absent`, or any `request-show`/spawn/timeout failure, lands in the same place.
- The catch at 102-105 only records `notice router-wake`; `wake` keeps `attempted: true` and no receipt, so every
  later tick (service loop is 500 ms, `bin/osa.ts:171`) repeats the same read and never re-sends.

Failure scenario: the very first wake call fails before Orca durably records the request (CLI spawn error, the 15 s
timeout at `router.ts:18`, an arg rejection, or an Orca daemon restart). Pending Router work then never wakes again;
the Router must poll `router wait` by hand. Recovery is not what the skill documents: `router bind` on the same live
terminal returns the *identical* binding (`router.ts:39`), so the same wedged wake is picked up again. Only
`router unbind` (which deletes the binding, forcing a new binding id at 40) or a genuinely different terminal
identity clears it — neither is mentioned in `skills/super-agent-router/SKILL.md:29`.

Fix: treat `absent` the way `src/orca.ts:319-324` already does in `mutation()` — re-issue the same `requestId`
instead of throwing — and expose an explicit attention reset.

## P2 — Settled/closing assignments escape the poll/observe rate limits

`src/orca.ts:263` (observe guard), `src/orca.ts:564-566` (poll guard), `src/orca.ts:613-619` (closeAnchor),
`src/orca.ts:251-252` (closing bindings stay in the poll set).

Both guards are written as `!binding.settled && <deadline>`, so once an assignment settles the 1 s / 15 s backoff
stops applying while cleanup is still running. `closeAnchor` issues an uncached `terminal show` on every call (616),
and `observe` issues `worker-show` on every call (266).

Failure scenario: cleanup cannot complete — the coordinator anchor was taken over by an agent (618 throws), or
`worker-release` returns a state outside `released|retained` (596 throws), or `terminal close` keeps erroring (619).
Each stuck binding then spawns an Orca CLI process every 500 ms (≈2/s, indefinitely) plus a notice write per tick,
with no escalation and no operator-visible difference from a healthy poll.

Fix: apply the same `nextPollAt` / `nextObservationAt` backoff when settled or closing, and stop re-polling a
`closing` binding after a bounded number of consecutive failures.

## P2 — `route attach` checks the GitHub guard against the pre-bind target

`src/app.ts:153` (`target` read), `src/app.ts:156` (`this.projects.bind(ticket, o)`), `src/app.ts:157` (guard).

`target` is captured before `bind` writes `ticket-target`, so exactly when `bind` creates the target the guard still
sees `undefined` and is skipped. For an already-bound ticket the guard works (targets are immutable), which is why
this is easy to miss.

Failure scenario: a ticket accepted while the registry was empty has no target (`src/projects.ts:73` returns early);
a project is then registered in the same process (no restart needed). `route attach --ticket T --component A
--trigger <GitHub comment from repository B>` binds T to A and then skips the repository check, so a repo-B message
becomes an input of a repo-A ticket. The Executor reads it as its own (`app.ts:88`), and later reply/PR binding uses
repo B's channel for a repo-A workspace.

Fix: move the target read below `bind` — `route accept` already does it in the right order at `app.ts:175-177`.

## P2/P3 — Legacy migration cannot attach a GitHub binding to an existing legacy component

`src/projects.ts:33-38` (component written once, with `github`), `bin/osa.ts:122-128` (only guards against removing
or changing an existing source), `bin/osa.ts:141`.

Failure scenario: the first P4 start runs without `--github`, creating component `legacy` with `github: undefined`.
A later start with `--github owner/repo` is accepted by the source check but never updates the component, so every
legacy-project ticket fails `route accept --publish true` (`app.ts:180-181`) and `pr publish`
(`publish.ts:40-42`), and PR binding never matches (`github.ts:141-142`) — with no error naming the missing binding.
No repair is documented; the working (undocumented) fix is
`component update --id legacy --github-repository … --github-owner-id … --github-owner-login …`
(`projects.ts:195`, allowed because no ticket target changes).

## P3 — `intake` silently defaults the thread to `window`

`src/app.ts:134`. `SKILL.md:15` requires `--thread CONVERSATION`, but an omission is accepted silently, and
`vendor/dsh-core/src/intake.ts:37-53` adds a message on a subscribed thread as an *input of the live ticket* instead
of creating a candidate. A new owner request for another project is then executed by whatever ticket owns `window`.
Make `--thread` required, or refuse the default when the thread already has a live subscription.

## P3 — `ensureLegacy` re-targets tickets the service deliberately held back

`src/projects.ts:41` binds every ticket without a target to the startup repository's `legacy` project, which
`src/projects.ts:120` otherwise reports as "Ticket has no explicit execution target". A ticket accepted against an
empty registry is therefore silently executed in the startup repository after the next restart, and the binding is
then immutable (`projects.ts:69`). Consider migrating only tickets that predate the legacy marker, or requiring an
explicit adopt flag.

## P3 — Registry queries without a project scope return every project's records

`src/projects.ts:176`. Plan line 61 requires every query and operation to carry an explicit scope; `knowledge list`
and `goal list` with no `--project` return all projects' rows. Executor-facing context is correctly scoped
(`projects.ts:149`), so this is owner-surface only.

## Documented/deferred limitations (not defects)

- Remote and non-git-folder locations are refused at execution (`projects.ts:119`) — consistent with plan line 107's
  deferral, but "register any project without code changes" only holds for local git folders.
- `maxExecutors` bounds Executor dispatches only (`orca.ts:194`); child workers and Claude reviewers inside a Run are
  not counted, while plan line 53 asks for their consumption to be visible and constrained.
- Capacity is global with no per-project share (`orca.ts:192-205`): two long tickets in one project can hold both
  slots for hours. Start ordering itself is a fair rotation with priority and aging (`orca.ts:207-224`).
- Lease takeover is expiry-only (`app.ts:79-83`); plan line 91 asks that takeover wait for confirmed delivery and a
  proven-invalid old Router identity.
- The Router terminal must be a live local agent terminal inside the service's startup repository
  (`router.ts:27-28`), an implicit coupling for multi-project operation.
- Single host, no multi-host takeover (plan line 97).

## Verified sound

- Target binding is immutable and revalidated in review (`review.ts:39-46`), publish (`publish.ts:36-58`) and
  GitHub (`github.ts:138-143`); no cross-repository leak found in those paths.
- Settlement acceptance binds message to taskId + dispatchId + runId + from_handle (`orca.ts:577-583`); `ack`
  requires a matching delivery record (`app.ts:107-108`).
- Review independence requires a genuine Claude child of the current dispatch, current-task result provenance and a
  fresh fingerprint (`review.ts:94-119`, `review.ts:136-142`).
- Joint acceptance implicitly depends on all goal children and the cycle guard rejects a child that depends on the
  acceptance ticket even when the child was planned before binding (`projects.ts:101-108`, `projects.ts:121-126`).
  Verified with a throwaway repro outside the repo: `goal update --acceptance-ticket` is rejected with
  "Dependency cycle" and no deadlock is produced.
- The nested `recipient_run_mismatch` fix is present and correctly narrow: Dispatch-addressed followups send without
  `--run`, and only a proven-rejected old receipt is archived (`orca.ts:527-535`).
- Legacy migration snapshots state with `VACUUM INTO` before writing (`bin/osa.ts:137-140`) and preserves IDs,
  cursors and outbox receipts.
- Launcher singleton, identity checks and no-force-kill stop semantics hold (`scripts/osa-service.mjs:33-71`,
  `97-114`); the only gap is the 15 s readiness deadline (88-96), which can report failure while a slow start
  succeeds (recoverable via `status`).
