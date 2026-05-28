# @pi-stef/superpowers-adapter

A [pi](https://pi.dev) extension that bridges the [superpowers](https://github.com/obra/superpowers) skill system to pi's extension API.

## Why This Extension Exists

Pi ships with 4 built-in tools: `read`, `bash`, `edit`, `write`. The superpowers skill system expects additional tools that pi doesn't provide natively:

| Tool | Pi Built-in | Superpowers Needs | Provided By |
|------|-------------|-------------------|-------------|
| TodoWrite | No | Yes | This extension |
| Task | No | Yes | This extension (Agent alias) |
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

# 2. Install pi-subagents (required for Task/Agent tool)
pi install npm:@tintinweb/pi-subagents

# 3. Install this extension
pi install git:github.com/<USER>/pi-stef#packages/superpowers-adapter
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

### Task

Dispatch subagents for isolated work. This is an alias for the `Agent` tool from `@tintinweb/pi-subagents`.

**Parameters:**
- `subagent_type` (string, required) — Agent type (e.g., `general-purpose`, `Explore`, `Plan`)
- `prompt` (string, required) — Task description for the subagent
- `description` (string, required) — Short 3-5 word summary
- `model` (string, optional) — Model override
- `run_in_background` (boolean, optional) — Non-blocking execution

**Prerequisite:** `pi install npm:@tintinweb/pi-subagents`

**Limitation:** Pi's ExtensionAPI does not support tool-to-tool invocation. The Task tool returns a message directing the LLM to call the Agent tool directly rather than forwarding the call programmatically. This matches the behavior of the original upstream implementation.

### Skill

Load skill instructions by name. Discovers skills from standard pi skill directories.

**Parameters:**
- `skill` (string, required) — Skill name (e.g., `brainstorming`, `test-driven-development`)

**Discovery paths** (searched in order):
- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- `<cwd>/.pi/skills/`
- `<cwd>/.agents/skills/`
- Recursively under `~/.pi/agent/git/` (depth 10)

**Limitation:** The YAML frontmatter parser handles simple `key: value` pairs only. Description values containing colons will be truncated at the first colon. This matches the upstream implementation and is not an issue in practice — all known superpowers SKILL.md files use single-line descriptions without internal colons.

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
    task.ts          — Task tool (Agent shim)
    skill.ts         — Skill discovery, parsing, loading
  commands.ts        — /todos and /todo-clear
  index.ts           — Extension entry point + lifecycle hooks
```

The extension auto-injects the `using-superpowers` skill content into the system prompt via the `before_agent_start` lifecycle hook. This ensures the LLM receives superpowers instructions without manual configuration.

## Troubleshooting

**"using-superpowers skill not found"**
→ Install superpowers: `pi install https://github.com/obra/superpowers`

**"Task tool requires pi-subagents"**
→ Install subagents: `pi install npm:@tintinweb/pi-subagents`

**Skills not discovered**
→ Check that skill directories contain `SKILL.md` files with valid YAML frontmatter.

## Security

This extension has read-only filesystem access. It reads `SKILL.md` files from standard pi directories. No network calls, no process execution, no file writes.

## License

MIT
