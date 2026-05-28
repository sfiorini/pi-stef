# @pi-stef/agent-workflows

Reusable TypeScript workflow-engine primitives for Pi extensions.

This package is maintainer-facing infrastructure. It does not register Pi tools by itself; extensions such as `@pi-stef/sf-team` import it to get durable workflow folders, exact resume, short widget messages, verification policy helpers, and a generic orchestrator lifecycle.

## Catalog Visibility

This package is internal infrastructure, not a user-facing fh-agent catalog package. Its `fh-agent.package.json` sets `"catalogVisibility": "internal"`, so it is intentionally omitted from `fh-agent packages`, `catalog/packages.json`, `packages/package-manager/catalog/packages.json`, the beginner guide package list, and web catalog package cards.

Do not install, update, remove, or startup-check this library directly through fh-agent. Consuming extensions own the dependency. Today `@pi-stef/sf-team` declares `@pi-stef/agent-workflows` as `file:../agent-workflows`; fh-agent's normal package-local dependency prep for `sf-team` runs `npm install --omit=peer --workspaces=false` and installs this library as part of that extension.

If a local Pi environment installed `agent-workflows` while a development branch briefly exposed it as a catalog package, treat that as a manual/orphan install from an unreleased catalog state. Remove the explicit Pi source or local package path directly if needed; do not reintroduce a public catalog package for cleanup.

## What It Owns

| Area | Module | Responsibility |
| --- | --- | --- |
| Artifact paths | `src/artifacts/paths.ts` | Canonical `ai_plan/<slug>/.sf-workflow` paths. |
| Atomic writes | `src/artifacts/atomic-write.ts` | Safe text/JSON writes for workflow metadata and artifacts. |
| Plan locks | `src/lock/plan-lock.ts` | Atomic plan-folder lock acquisition, stale lock takeover, and release. |
| Metadata | `src/state/workflow-metadata.ts` | Durable owner tool, current tool, status, phase, branch/worktree, checkpoints, and commit intents. |
| Checkpoints | `src/state/checkpoint-store.ts`, `src/state/checkpoint-runtime.ts` | Completed-step reuse with stable input/output fingerprints. |
| Resume | `src/resume/*` | Slug/path target resolution, same-tool ownership checks, and conservative legacy five-file policy. |
| Widget messages | `src/widget/messages.ts`, `src/orchestrator/reporter.ts` | Short bounded messages, TTL expiry, truncation, and fallback output. |
| Verification | `src/verification/*` | Per-tool config, command fingerprints, run/persistent cache, command runner, and read-only verifier prompt. |
| Runtime | `src/orchestrator/run-workflow.ts` | Generic lifecycle around resume prompt, lock, durable metadata upsert, reporter, checkpoints, verification cache, baseline hook, body execution, success/error hooks, cleanup, and lock release. |

## Durable Folder Layout

Consumers store workflow state under the existing plan folder:

```text
ai_plan/<slug>/
  .sf-team.lock/                  # transient lockdir while a run owns the folder
  .sf-workflow/
    workflow.json                 # owner/status/phase/worktree/branch metadata
    checkpoints.json              # step records and fingerprints
    verification-cache.json       # persistent verification cache when opted in
    artifacts/                    # checkpoint output payloads
```

`ai_plan/` is intentionally gitignored. These files are local recovery/debugging artifacts, not source commits.

## Resume Contract

Exact resume is same-tool only. A consumer should call `analyzeResumeTarget({ repoRoot, target, invokedTool })` before spawning agents. The target may be a slug, relative path, or absolute path.

Rules enforced by the shared policy:

- Existing `.sf-workflow/workflow.json` metadata must have `ownerTool === invokedTool`.
- Metadata parse failures are hard errors.
- Missing metadata is allowed for `sf_team_implement` against a legacy five-file plan folder.
- Missing metadata is also allowed for `sf_team_auto` only when a five-file plan folder has both plan-phase checkpoints (`spawnText:planner:<n>`) and milestone implementation checkpoints (`spawnText:developer-M...:<n>` or `spawnText:reviewer-M...:<n>`). This recovers auto folders created before metadata persistence was fixed. Once the resumed run enters `runWorkflow`, it writes `workflow.json`; later resumes use the normal metadata path.
- Other missing-metadata folders cannot exact-resume because same-tool ownership and a safe restart point are not reconstructable.

Checkpoint reuse is also conservative. Only `status: "completed"` checkpoints with the same input fingerprint are skipped. In-progress and failed checkpoints rerun.

`runWorkflow` writes `.sf-workflow/workflow.json` after acquiring the folder lock. `ownerTool` defaults to `toolName`; wrappers may pass `ownerTool` when a parent workflow owns nested phases. `sf_team_auto` uses `ownerTool: "sf_team_auto"` while its nested plan and implement phases set `currentTool` to `sf_team_plan` and `sf_team_implement`. Each nested phase may mark metadata `completed` when it exits; the next phase reopens the same owner record and sets `status` back to `running`.

Normal handoff flows can opt in to a narrow owner claim with `allowOwnerTakeoverFrom`. `sf_team_implement slug=<plan>` uses this to claim a completed `sf_team_plan` folder for implementation while still rejecting auto/task/followup-owned folders.

## Verification Contract

`resolveVerificationConfig(toolName, config, override)` returns a complete policy:

- `timing`: `off`, `before`, `after`, `both`
- `mode`: `commands`, `agent`, `commands-and-agent`
- `stages`: `typecheck`, `test`, `lint`, `all`, or custom commands
- `commands`: additional custom commands
- `cache`: `off`, `run`, `persistent`
- `maxAttempts`: retry count

`runVerificationPolicy` executes resolved commands, reports retries/cache hits, and records successful fingerprints in the run cache or persistent cache. The fingerprint includes command identity, cwd, tool, phase, package-manager files/install state, git `HEAD`, git status, unstaged diff, staged diff, and untracked file contents.

`composeVerifierAgentPrompt` and `runVerifierAgent` provide read-only verifier-agent mode. Approval requires exactly one `VERIFICATION: PASS` line.

## Integration Pattern

An extension adapter should keep domain-specific behavior outside this package:

```ts
await runWorkflow(
  {
    repoRoot,
    slug,
    toolName: "sf_team_implement",
    ownerTool: "sf_team_auto", // optional for nested workflows; omit when the invoked tool owns its own folder
    // allowOwnerTakeoverFrom: ["sf_team_plan"], // optional alternative for deliberate normal handoffs
    useWorktree: true,
    promptForResume,
    createReporter,
    resolveBaseline,
    onSuccess,
    onError,
    beforeReporterDispose,
    afterLockRelease,
  },
  async (workflowCtx) => {
    // Extension-owned work: prompts, agents, plan parsing, worktrees, commits.
    // Use workflowCtx.reporter, workflowCtx.checkpoints, and
    // workflowCtx.verificationCache rather than reimplementing those concerns.
  },
);
```

Keep this library generic. It must not import sf-team prompts, tmux, Telegram, plan parsers, or worktree helpers.

## Development

```bash
pnpm --dir packages/agent-workflows test
pnpm --dir packages/agent-workflows typecheck
```

When changing exported behavior, add package-local tests first and then add consumer tests in the extension that depends on the behavior.
