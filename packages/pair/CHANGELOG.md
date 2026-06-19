# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
