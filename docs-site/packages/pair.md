# pair

A simplified plan/review/implement workflow for Pi using pi-subagents for reviewer spawning.

## Installation

```bash
pi install npm:@pi-stef/pair
```

## Workflows

| Workflow | Tool | Description |
|----------|------|-------------|
| Plan | `sf_pair_plan` | Create multi-milestone plan with reviewer loop |
| Implement | `sf_pair_implement` | Execute plan in worktree with milestone reviews |
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

Three tools delegate to SKILL.md files that contain workflow logic. The extension provides:
- Config loading and model resolution
- Reviewer agent file generation via pi-subagents
- Standalone worktree helpers

### Reviewer Spawning

Reviewers are spawned as pi-subagents using a custom agent type defined in `.pi/agents/reviewer.md`. The agent file is generated at runtime with the resolved model.

### Worktree Lifecycle

The implement skill:
1. Creates a git worktree with branch `pair/<slug>`
2. Implements all milestones without stopping
3. Rolls up commits to base branch
4. Deletes the worktree

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
