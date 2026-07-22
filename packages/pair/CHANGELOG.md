# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.4] - 2026-07-22
### Deprecated
- `@pi-stef/pair` is deprecated in favor of `@pi-stef/flow`; tools now emit a migration banner.

## [0.2.3] - 2026-07-17
### Changed
- fix(pair,flow): make skills internal (path-loaded) to remove duplicate /skill:* listing


## [0.2.2] - 2026-07-17
### Changed
- fix(pair): hide skills from model invocation to remove duplicate listing


## [0.2.1] - 2026-06-21
### Changed
- feat(pair): use directive-first result message in sf_pair_implement
- feat(pair): buildImplementReadyMessage — directive-first implement tool result


## [0.2.0] - 2026-06-20
### Changed
- feat(team,pair): M3+M4 — pi-native migration, Global Constraints + Interfaces
- fix(pair): sf_pair_finalize uses ctx.cwd for git context, SKILL.md cd-before-finalize
- docs(pair): rewrite skills + docs for v6 migration, per-milestone loop, global agents
- feat(pair): create worktree deterministically in sf_pair_implement
- feat(pair): sf_pair_finalize preserves branch, removes worktree dir
- refactor(pair): replace writeReviewerAgent with global write-once ensureAgentFiles
- feat(pair): write-once global agent definitions for reviewer and explorer
- feat(pair,team): declare obra/superpowers companion + pair native skill discovery

### Changed
- pair no longer depends on superpowers-adapter; obra/superpowers v6 is loaded natively.
- Reviewer and explorer agent definitions now live globally at `~/.pi/agent/agents/` as write-once, user-editable templates (model resolved at dispatch).
- `sf_pair_implement` now creates the worktree deterministically and runs a per-milestone TDD→review→commit→tracker loop.
### Added
- `sf_pair_finalize` tool: removes the worktree directory while preserving the `pair/<slug>` branch for a PR.
- `explorer` agent definition.
- `pi.skills` and `pi.companions` manifest fields.
### Removed
- `rollupAndCleanup` (merge-into-base + branch delete) — replaced by `sf_pair_finalize`.

## [0.1.6] - 2026-06-19
### Changed
- fix: add skill discovery for workspace packages and fix tool instructions
- fix(pair): make skill loading instructions more explicit


## [0.1.5] - 2026-06-19
### Changed
- fix(pair): use correct skill names in tool responses
- fix(pair): address P2 findings in plan skill guardrails
- fix(pair): enforce ai_plan folder creation with strict guardrails
- fix(pair): address P3 findings and update documentation
- feat(pair): add explorer model configuration
- docs(pair): add missing changelog entry for design approval
- fix(pair): require user approval on design before planning


## [0.1.4] - 2026-06-19
### Changed
- fix(pair): use general-purpose agent type which inherits session model
- fix(pair): require user approval on design before planning


## [0.1.3] - 2026-06-19
### Changed
- fix(pair): use current session model for exploration, not hardcoded model
- fix(pair): use General agent for plan exploration instead of Explore (Haiku)


## [0.1.2] - 2026-06-19
### Changed
- fix(pair): fix slash command handlers to invoke tools via sendUserMessage


## [0.1.1] - 2026-06-18
### Changed
- feat(pair): add skills, templates, docs, and catalog registration
- fix(pair): read reviewer template from file instead of hardcoding
- fix(pair): fix tool registration issues
- feat(pair): add tool registration and reviewer agent generation
- test(pair): add worktree create and cleanup tests
- test(pair): add worktree validation tests
- feat(pair): add worktree helpers (validate, create, cleanup)
- test(pair): add config module tests
- feat(pair): add config schema and loading with 4-step model resolution
- feat(pair): scaffold package structure, tsconfig, and extension entry point
