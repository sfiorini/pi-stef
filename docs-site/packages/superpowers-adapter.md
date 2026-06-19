# superpowers-adapter

A [pi](https://pi.dev) extension that bridges the [superpowers](https://github.com/obra/superpowers) skill system to pi's extension API.

## Why This Extension Exists

Pi ships with 4 built-in tools: `read`, `bash`, `edit`, `write`. The superpowers skill system expects additional tools that pi doesn't provide natively:

| Tool | Pi Built-in | Superpowers Needs | Provided By |
|------|-------------|-------------------|-------------|
| TodoWrite | No | Yes | This extension |
| Skill | No | Yes | This extension |
| Agent | No | Yes | `@tintinweb/pi-subagents` |

## Installation

```bash
# 1. Install superpowers (official skill pack)
pi install https://github.com/obra/superpowers

# 2. Install this extension
pi install npm:@pi-stef/superpowers-adapter
```

## Tools

### TodoWrite

Track implementation tasks with status progression.

**Parameters:**
- `todos` (array, required) — Array of todo items, each with:
  - `id` (string) — Unique identifier
  - `content` (string) — Task description
  - `status` (string) — One of: `pending`, `in_progress`, `completed`
  - `priority` (string, optional) — One of: `high`, `medium`, `low`

### Skill

Load skill instructions by name. Discovers skills from standard pi skill directories.

**Parameters:**
- `skill` (string, required) — Skill name (e.g., `brainstorming`, `test-driven-development`)

**Discovery paths** (searched in order):
- `<cwd>/.pi/skills/`
- `<cwd>/.agents/skills/`
- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- Workspace packages: `<cwd>/packages/<pkg>/skills/`
- Locally installed packages: `<cwd>/node_modules/<pkg>/skills/` (any scope)
- Globally installed packages: `~/.pi/agent/npm/node_modules/<pkg>/skills/` (any scope)
- Recursively under `~/.pi/agent/git/` (depth 10)

## Commands

| Command | Description |
|---------|-------------|
| `/todos` | Display current todo list with progress |
| `/todo-clear` | Reset all todos |

## Architecture

```
src/
  types.ts           — Shared type definitions
  tools/
    todo-write.ts    — TodoWrite tool + state management
    skill.ts         — Skill discovery, parsing, loading
  commands.ts        — /todos and /todo-clear
  index.ts           — Extension entry point + lifecycle hooks
```

The extension auto-injects the `using-superpowers` skill content into the system prompt via the `before_agent_start` lifecycle hook.

## Troubleshooting

**"using-superpowers skill not found"**
→ Install superpowers: `pi install https://github.com/obra/superpowers`

**Skills not discovered**
→ Check that skill directories contain `SKILL.md` files with valid YAML frontmatter.

## Security

This extension has read-only filesystem access. It reads `SKILL.md` files from standard pi directories. No network calls, no process execution, no file writes.
