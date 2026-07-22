# pair

> ⚠️ **DEPRECATED.** `@pi-stef/pair` is deprecated in favor of [`@pi-stef/flow`](/packages/flow). See [Migrating from team & pair](/migrating-from-team-and-pair) for the 1:1 tool mapping (`sf_pair_plan`→`sf_flow_plan`, `sf_pair_implement`→`sf_flow_implement`, `sf_pair_task`→`sf_flow_auto`, `sf_pair_finalize`→`sf_flow_finalize`).

A simplified plan/review/implement workflow for Pi using pi-subagents for reviewer spawning.

## Installation

```bash
pi install git:github.com/obra/superpowers   # required companion (declared via pi.companions)
pi install npm:@pi-stef/pair
```

pair declares obra/superpowers as a companion, so installing pair via the catalog
also installs it. pair's own skills are discovered natively via `pi.skills`.

## Workflows

| Workflow | Tool | Description |
|----------|------|-------------|
| Plan | `sf_pair_plan` | Create multi-milestone plan with reviewer loop |
| Implement | `sf_pair_implement` | Execute plan in worktree with milestone reviews |
| Finalize | `sf_pair_finalize` | Remove worktree dir, preserve branch for PR |
| Task | `sf_pair_task` | Execute single task end-to-end |

## Quickstart

```bash
# Create a plan
/sf-pair-plan implement authentication system

# Execute a plan
/sf-pair-implement 2026-06-17-auth-system

# Execute a single task
/sf-pair-task add login endpoint
```

## Natural Language Usage

```
"Create a plan for adding user authentication, use anthropic/sonnet-4-6 as reviewer"
"Create a plan for auth, use anthropic/sonnet-4-6 as reviewer, use anthropic/haiku-4-5 as explorer"
"Implement the plan in ai_plan/2026-06-17-auth-system"
"Execute this task end-to-end: add a health check endpoint"
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/sf-pair-plan` | Create implementation plan with reviewer loop |
| `/sf-pair-implement` | Execute plan in worktree with milestone reviews |
| `/sf-pair-task` | Execute single task end-to-end |

## Tools

### sf_pair_plan

Create a multi-milestone implementation plan with iterative reviewer approval.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | No | The task to plan |
| `reviewer_model` | No | Override reviewer model |
| `explorer_model` | No | Override explorer model (inherits parent if not set) |

### sf_pair_implement

Execute an approved plan milestone-by-milestone in a git worktree.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Plan folder path or slug |
| `reviewer_model` | No | Override reviewer model |

### sf_pair_task

Execute a single task end-to-end.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | Yes | The task to execute |
| `reviewer_model` | No | Override reviewer model |

### sf_pair_finalize

Remove the worktree directory after a run while PRESERVING the `pair/<slug>` branch.

| Parameter | Type | Description |
|-----------|------|-------------|
| worktree_path | string | Absolute path of the pair worktree directory to remove |

Use this after `sf_pair_implement` has committed all milestones to the worktree
branch. The branch survives so you can push it and open a PR from your main
checkout.

## Configuration

Config file location: `.pi/sf/pair/config.json`

```json
{
  "reviewer": {
    "model": "anthropic/sonnet-4-6"
  },
  "explorer": {
    "model": "anthropic/haiku-4-5"
  }
}
```

### Resolution Chain

**Reviewer Model** (required for plan/implement/task):
1. Prompt argument (e.g., "use X as reviewer")
2. Config file (global or project)
3. Environment variable `SF_PAIR_REVIEWER_MODEL`
4. Ask user

**Explorer Model** (optional, used only in plan):
1. Prompt argument (e.g., "use X as explorer")
2. Config file (global or project)
3. Environment variable `SF_PAIR_EXPLORER_MODEL`
4. Inherits parent model (current session model)

## Architecture

### Skill-Driven Design

Four tools delegate to SKILL.md files that contain workflow logic. The extension provides:
- Config loading and model resolution
- Global write-once agent templates (user-editable, model resolved at dispatch)
- Standalone worktree helpers

### Reviewer Spawning

Reviewer and explorer agents are spawned as pi-subagents using global agent definitions at `~/.pi/agent/agents/{reviewer,explorer}.md`. The files are write-once (never clobbered so users can edit them) and omit `model:` — the model is resolved by pair and passed at dispatch time.

### Worktree Lifecycle

The implement skill runs a per-milestone loop:
1. Creates a git worktree with branch `pair/<slug>`
2. For each milestone: TDD each story → reviewer loop → commit to worktree branch → update tracker
3. After all milestones: `sf_pair_finalize` removes the worktree directory while preserving the `pair/<slug>` branch for a PR

## Key Differences from Team

| Feature | pair | team |
|---------|------|------|
| Architecture | Skill-driven | Orchestration-driven |
| Reviewer spawning | pi-subagents | External CLI subprocess |
| Config | Reviewer + Explorer model | Full config with lanes |
| Worktree | Automatic lifecycle | Manual or tool-managed |
| Q&A | AskUserQuestion | External library |

## Plan-Folder Layout

```
ai_plan/YYYY-MM-DD-<slug>/
├── original-plan.md         # Raw approved plan
├── final-transcript.md      # Conversation log
├── milestone-plan.md        # Full specification
├── story-tracker.md         # Status tracking
└── continuation-runbook.md  # Resume context
```

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `reviewer.model` | `string` | `null` | Model for reviewer agent (required) |
| `explorer.model` | `string` | `null` | Model for explorer agent (inherits parent if not set) |
