# pi-fast-subagent-plus

`pi-fast-subagent-plus` is a small fork of the original [`pi-fast-subagent`](https://github.com/tuansondinh/pi-fast-subagent).

It keeps the original feature set and adds three changes:

- **Per-agent `thinking` frontmatter**
- **Dynamic subagent tool metadata** via `session_start`, with a delegation-first `subagent` prompt
- **A settings-style control panel** via `/fast-subagent` for browsing agents and job management

## What it adds

### 1. Per-agent `thinking`

Agents can define a `thinking` value in frontmatter:

```md
---
name: explorer
description: Codebase Explorer, Use this whenever codebase has to be explored or to gather context
thinking: medium
---
```

Supported values:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

### 2. Dynamic tool metadata

On session start, the extension refreshes the `subagent` tool metadata with a delegation-first prompt using:

- `description`
- `promptSnippet`
- `promptGuidelines`

The prompt details live in the tool registration itself, not in a `before_agent_start` hook.

This helps Pi understand:

- when to delegate to a subagent
- how to use the `subagent` tool
- when to inspect available agents with `{ action: 'list' }`

### 3. Settings-style control panel

Run `/fast-subagent` to open a popup-style TUI similar to Pi's `/settings` flow.

From there you can:

- browse available agents
- inspect background jobs
- cancel running background jobs
- detach foreground jobs to the background
- dump the live system prompt for debugging

The popup panel now replaces the old `fast-subagent:*` management commands. The `Alt+Shift+B` shortcut for detaching a foreground job still remains.

## Install

### Local path

```bash
pi install /absolute/path/to/pi-fast-subagent-plus
```

### GitHub

```bash
pi install git:github.com/66RED99/pi-fast-subagent-plus
```

## Notes

For all other behavior and usage patterns, see the original repo:

- https://github.com/tuansondinh/pi-fast-subagent
