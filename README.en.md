# Orca-superagent (OSA)

**Multiple computers. Multiple agents. One place to collaborate.**

Give the Router a goal and let agents move the work forward. Follow progress in one panel, use Orca to access and control work on remote computers, and make the decisions that matter.

[中文](README.md) · [English](README.en.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md) · [العربية](README.ar.md)

## From Human to Human to Agent to Agent

| Collaboration | How work moves forward |
| --- | --- |
| **Human → Human** | People communicate, divide work, and hand it over |
| **Human → Agent** | A person describes a goal; an agent carries out the task |
| **Agent → Human** | Agents report progress, ask questions, and bring key decisions to people |
| **Agent → Agent** | Agents delegate tasks, return results, and relay questions to advance the work together |

**OSA brings Agent to Agent collaboration into your everyday development workspace.** The Router clarifies goals and dispatches work. Executors plan, explore, implement, and debug. You set the direction; agents handle execution and handoffs.

## Why OSA

- **One entry point, many tasks.** Describe goals in natural language, coordinate parallel work by agents such as Claude Code and Codex, and receive reports in a shared inbox.
- **Multiple computers, one workspace.** Use Orca's remote control and multi-computer management to access local and remote sessions and workspaces.
- **Progress at a glance.** The native sidebar organizes tasks into Needs you, Ready, Waiting for external events, In progress, and History, with grouping by project, workspace, and agent.
- **From the big picture to the actual session.** Expand a task to read conversations and records, locate its execution window, or click `@` to copy a task reference and continue with the Router.
- **Follow long-running work.** Decisions carry concrete questions, waits carry review dates, and dispatches and reports leave a record for the next handoff.

OSA combines dsh-superagent's division of roles and autoloop's event-and-clock approach with Orca's native orchestration, visual workspaces, and remote access to connect goals with the places where work happens.

## How it works

```text
Your goal → Router clarifies and dispatches → Executor works
                   ↑                              ↓
             Key decisions ← Questions, progress, results

Orca: execution windows · workspaces · inboxes · remote connections
OSA panel: browse tasks, follow progress, open the relevant session
```

## Get started

Have Orca and a signed-in agent, such as Claude Code or Codex, ready.

1. Place the [Router skill](skills/osa-router/SKILL.md) in your agent's skills directory, for example `~/.claude/skills/osa-router/SKILL.md`.
2. Place the [executor rules](skills/executor-rules.md) at `~/osa-team/executor-rules.md`.
3. Run from the repository root and approve the plugin permissions when Orca prompts you:

```sh
orca plugin install ./plugin/osa-panel
```

Start work in an Orca window:

```text
/osa-router Fix the login failure in this project and verify it locally
```

Continue an existing task:

```text
/osa-router resume <task-name>
```

## Explore further

The detailed guides below are in Chinese.

- [Task panel](plugin/osa-panel/README.md): browse, search, locate, and follow tasks.
- [Design philosophy](docs/000-philosophy.md): Router and Executor responsibilities.
- [State watch](docs/009-state-watch.md): implementation notes on reviews and automatic continuation.
- [Agents and channels](docs/010-agents-and-channels.md): agent preferences and directions for GitHub and Feishu integration.
- [Companion Orca patches](patches/README.md): versions and usage.

Share use cases, report problems, and suggest improvements through [Issues](https://github.com/David0Ming/Orca-superagent/issues).

## Credits and license

Thanks to [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), [Orca](https://github.com/stablyai/orca), and [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) for their ideas, interfaces, and practical work.

OSA code and documentation use [PolyForm Noncommercial 1.0.0](LICENSE), permitting noncommercial use, modification, and distribution. Orca-derived patches in `patches/` use [MIT](patches/LICENSE.orca).
