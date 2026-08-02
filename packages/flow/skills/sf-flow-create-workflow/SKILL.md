---
name: sf-flow-create-workflow
description: Use when a user asks to create or validate a reusable flow from a declarative agents/phases/loops definition. Interviews the user, writes .pi/sf/flow/workflows/<name>.yaml (project-scoped), and registers /<name>.
---

# sf-flow-create-workflow

## Purpose
Turn a user's intent into a declarative flow YAML at `.pi/sf/flow/workflows/<name>.yaml` (project-scoped; a global default lives at `~/.pi/sf/flow/workflows/<name>.yaml`), validate it, and register it as a `/<name>` command runnable via `sf_flow_auto`.

## Process

### Phase 1: Interview (skip if all params provided)
Ask the user ONE question at a time for any missing field:
1. `name` (kebab-case)
2. `description`
3. `input` type (prompt / md-file / prd / jira)
4. `agents` — for each agent: name, tools, model, thinking, isolated, and whether it needs a `schema` (e.g. verdict)
5. `phases` — for each phase: id, run type (agent/skill/raw/questions), prompt, and any fanout/verify/in/out. For `questions` phases: the agent name (must be declared in `agents`) and optional `max_rounds` (default 5)
6. `loops` — for any phase or group: until_dry or until:approved (+ fail_on + max_rounds). Loop keys resolve group-first
7. `groups` — optional: for each group, the gate phase id (first) + fix phase ids (rest, ≥2 total); all must be agent phases; the group name must have a matching `loops` entry

### Phase 2: Write the YAML
Write the collected definition to `.pi/sf/flow/workflows/<name>.yaml` using the `writeFlowYaml` serializer (or write the file directly in the documented format).

### Phase 2.5: Emit agent stubs (write-once)
For each agent in `agents:` without an existing `.md` (check `~/.pi/agent/agents/<name>.md` then `<cwd>/.pi/agents/<name>.md`), write a write-once stub:
- frontmatter: the agent's tools/model/thinking/isolated from the YAML
- body: a one-line description derived from the agent name + the phase prompts that use it
Never overwrite an existing agent file (write-once, user-editable).

### Phase 3: Validate
Run `validateFlowYaml` on the assembled flow (the tool returns errors). If errors, surface them and re-interview only the broken parts. Repeat until valid.

### Phase 4: Register
Register `/<name>` (via `registerGeneratedFlow`) so the flow is runnable via `sf_flow_auto <name> <input>`.

### Phase 5: Confirm
Tell the user: `Flow "<name>" created at .pi/sf/flow/workflows/<name>.yaml. Run it with: sf_flow_auto <name> "<prompt>" (or a file/PRD/Jira id).`

## YAML format
The 4 knobs: `agents`, `phases`, `loops`, `groups`. See the canonical template at `packages/flow/templates/workflow.yaml` and the spec §3. Each phase runs exactly one of `agent` / `skill` / `raw` / `questions`. Cross-field rules (enforced by `validateFlowYaml`):
- a phase must set exactly one of agent/skill/raw/questions;
- `questions` must reference a name declared in `agents`; questions and fanout/verify are mutually exclusive;
- `fanout` is only supported on agent phases, and requires the phase to declare `out`;
- `until_dry` requires the phase to set `fanout`;
- `until: approved` requires the phase agent to declare a verdict `schema`;
- loops are not supported on skill/raw/questions phases (questions has a built-in follow-up loop);
- `out` values must be unique across phases;
- `groups.<name>.phases` must be ≥2, all agent phases; a phase may belong to at most one group;
- every `groups.<name>` must have a matching `loops.<name>`;
- loop keys that match a group name resolve as group loops (group-first precedence over phase loops).
