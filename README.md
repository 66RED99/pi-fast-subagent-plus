# pi-fast-subagent-plus

`pi-fast-subagent-plus` is a small fork of the original [`pi-fast-subagent`](https://github.com/tuansondinh/pi-fast-subagent).

It keeps the original feature set and adds two changes:

- **Per-agent `thinking` frontmatter**
- **Automatic parent prompt injection** via `before_agent_start`, using discovered agent names and descriptions so Pi can route to subagents more reliably

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

### 2. Automatic prompt injection

On each parent turn, the extension injects the discovered subagent list into the system prompt using:

- agent `name`
- agent `description`

This helps Pi understand:

- which subagents exist
- what each one is for
- when to use the `subagent` tool to delegate

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
