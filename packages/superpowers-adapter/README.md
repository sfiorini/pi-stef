# @pi-stef/superpowers-adapter

A [pi](https://pi.dev) extension that bridges the [superpowers](https://github.com/obra/superpowers) skill system to pi's extension API.

## Why This Extension Exists

Pi ships with 4 built-in tools: `read`, `bash`, `edit`, `write`. The superpowers skill system expects additional tools that pi doesn't provide natively:

| Tool | Pi Built-in | Superpowers Needs | Provided By |
|------|-------------|-------------------|-------------|
| TodoWrite | No | Yes | This extension |
| Skill | No | Yes | This extension |
| Agent | No | Yes | `@tintinweb/pi-subagents` |

The superpowers `using-superpowers` skill explicitly requires:
1. **"Use the `Skill` tool"** to load skill instructions
2. **"Never use the Read tool on skill files"** — the Skill tool must be used instead

While pi natively supports skill discovery (listing them in the system prompt), superpowers workflows depend on calling the `Skill` tool directly.

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

**Example:**
```
TodoWrite({
  todos: [
    { id: "1", content: "Design API", status: "completed" },
    { id: "2", content: "Implement", status: "in_progress", priority: "high" },
    { id: "3", content: "Write tests", status: "pending" }
  ]
})
```

### Skill

Load skill instructions by name. Discovers skills from standard pi skill directories.

**Parameters:**
- `skill` (string, required) — Skill name (e.g., `brainstorming`, `test-driven-development`)

**Discovery paths** (searched in order):
- `<cwd>/.pi/skills/`
- `<cwd>/.agents/skills/`
- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- Recursively under `~/.pi/agent/git/` (depth 10)

**Limitation:** The YAML frontmatter parser handles simple `key: value` pairs only. Nested values, multi-line values, and quoted strings with complex escaping are not supported.

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

The extension auto-injects the `using-superpowers` skill content into the system prompt via the `before_agent_start` lifecycle hook. This ensures the LLM receives superpowers instructions without manual configuration.

## Troubleshooting

**"using-superpowers skill not found"**
→ Install superpowers: `pi install https://github.com/obra/superpowers`

**Skills not discovered**
→ Check that skill directories contain `SKILL.md` files with valid YAML frontmatter.

## Security

This extension has read-only filesystem access. It reads `SKILL.md` files from standard pi directories. No network calls, no process execution, no file writes.

## License

MIT
