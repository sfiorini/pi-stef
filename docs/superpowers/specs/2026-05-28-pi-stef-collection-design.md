# pi-stef Package Collection — Design Spec

## Overview

**pi-stef** is a custom package collection for the [pi](https://pi.dev) coding agent. It provides a curated set of extensions, skills, and prompts installable via standard `pi install` commands. The collection lives in a single git monorepo for easy maintenance.

Users install packages individually with `pi install git:github.com/<user>/pi-stef#packages/<name>`, or install everything at once with the convenience `install-all.sh` script. Package management across machines is handled by [pi-depo](https://github.com/fulgidus/pi-depo).

## Project Structure

```
pi-stef/
  .gitignore
  pnpm-workspace.yaml          # packages: [packages/*]
  package.json                  # root monorepo config
  tsconfig.base.json            # shared TypeScript config
  packages/
    superpowers-adapter/        # first package (see below)
      package.json
      extensions/
        index.ts
      src/
        tools/
          todo-write.ts
          task.ts
          skill.ts
        commands.ts
        index.ts
      tests/
        todo-write.test.ts
        skill.test.ts
        commands.test.ts
      README.md                 # comprehensive package documentation
  scripts/
    install-all.sh              # convenience: install all packages in order
  docs/
    superpowers/specs/          # design specs
  README.md                     # package catalog with links to per-package READMEs
```

## Package Manifest Format

Each package uses standard npm `package.json` with the pi-specific `"pi"` key. No custom catalog metadata files.

```json
{
  "name": "@pi-stef/<package-name>",
  "version": "1.0.0",
  "description": "...",
  "keywords": ["pi-package"],
  "type": "module",
  "main": "./src/index.ts",
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  }
}
```

Inter-package dependencies point to git URLs so `pi install` can resolve them remotely:

```json
{
  "dependencies": {
    "@pi-stef/shared-lib": "git:github.com/<user>/pi-stef#packages/shared-lib"
  }
}
```

## Package: superpowers-adapter

Bridges the [superpowers](https://github.com/obra/superpowers) skill system to pi's extension API. Based on [gadgj/pi-superpowers-support](https://github.com/gadgj/pi-superpowers-support), security-audited and cleaned up.

### Components

| Component | Type | Purpose |
|-----------|------|---------|
| TodoWrite | tool | In-memory task tracking with `pending`/`in_progress`/`completed` states |
| Task | tool | Shim that redirects to the `Agent` tool from `@tintinweb/pi-subagents` |
| Skill | tool | Discovers and reads `SKILL.md` files from pi's skill directories |
| /todos | command | Display current todo list |
| /todo-clear | command | Reset the todo list |
| System prompt injection | lifecycle hook | Auto-injects `using-superpowers` skill content at session start |

### Changes from Original

1. **Remove Chinese text** — original README has Chinese explanation sections; replaced with English
2. **Modular file structure** — original is a single 454-line `index.ts`; split into `tools/todo-write.ts`, `tools/task.ts`, `tools/skill.ts`, `commands.ts`, and `index.ts`
3. **Package rename** — from `@uadgj/pi-superpowers-support` to `@pi-stef/superpowers-adapter`
4. **Comprehensive README** — detailed English docs covering purpose, installation, tool reference, architecture, troubleshooting, and the comparison table explaining why each tool is needed
5. **Unit tests** — test each tool and command

### What Stays the Same

- Core tool logic (TodoWrite, Task shim, Skill discovery and parsing)
- System prompt injection via `before_agent_start` event
- Skill discovery paths: `~/.pi/agent/skills/`, `~/.agents/skills/`, `<cwd>/.pi/skills/`, `<cwd>/.agents/skills/`, recursive under `~/.pi/agent/git/` (depth 10)
- Peer dependency on `@tintinweb/pi-subagents` for the Task/Agent tool
- YAML frontmatter stripping when returning skill content

### Security Profile

The original code was security-audited and found clean:
- Read-only filesystem access only (`readFileSync`, `readdirSync`, `existsSync`)
- No network calls, no `child_process`, no `eval`, no dynamic imports
- No hardcoded secrets or tokens
- Skill name used as lookup key (not direct file path) — no path traversal risk
- Bounded directory recursion (depth 10)

### Dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| `@mariozechner/pi-coding-agent` | peer | Extension API |
| `@mariozechner/pi-ai` | peer | AI framework types |
| `@mariozechner/pi-tui` | peer | Terminal UI components |
| `@sinclair/typebox` | peer | JSON Schema for tool parameters |
| `@tintinweb/pi-subagents` | optional runtime | Provides the Agent tool that Task delegates to |
| `typescript` | dev | TypeScript compiler |

## install-all.sh

Convenience script for installing all packages:

- Installs each package via `pi install git:github.com/<user>/pi-stef#packages/<name>` in dependency order
- Supports `--project` flag for project-local installs (`pi install -l`)
- Checks `pi` is in PATH before starting
- Stops on first failure with clear error message
- Prints summary of installed packages on success

## Root README (Package Catalog)

The root README serves as the package catalog:

- Lists all packages in a table with name, type, description, and install command
- Links to each package's individual README for detailed documentation
- Documents prerequisites (pi version, Node.js version)
- Shows how to install all packages at once
- Links to pi-depo for cross-machine management

## Per-Package README

Each package has its own comprehensive README covering:

- What the package does and why it exists
- Installation instructions (individual and as part of the collection)
- Prerequisites and companion packages
- Tool/command reference with parameters and examples
- Architecture overview
- Troubleshooting guide
- License information

## Package Types Supported

The collection supports three pi package types:

| Type | Directory | Content |
|------|-----------|---------|
| Extensions | `extensions/` | TypeScript modules registering tools, commands, and event handlers |
| Skills | `skills/` | `SKILL.md` files instructing the LLM on capabilities |
| Prompts | `prompts/` | Markdown prompt templates with variable interpolation |

A single package may contain any combination of these types.
