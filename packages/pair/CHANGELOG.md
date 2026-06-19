# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-06-19
### Changed
- fix(pair): use general-purpose agent type which inherits session model


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
