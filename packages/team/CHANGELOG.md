# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
### Deprecated
- `@pi-stef/team` is deprecated in favor of `@pi-stef/flow`; tools now emit a migration banner.

## [0.4.0] - 2026-06-20
### Changed
- fix(team): normalize indentation in PLANNER_FORMAT_REMINDER
- docs: M6 — add pair to sidebar, README table, dev tree; changelog entries
- feat(team,pair): M3+M4 — pi-native migration, Global Constraints + Interfaces
- feat(pair,team): declare obra/superpowers companion + pair native skill discovery

### Changed
- Declares obra/superpowers as a `pi.companions` dependency.
- Planner contract now emits `## Global Constraints` and `**Interfaces:**` plan sections (obra v6).
- Task-plan template: removed Claude-Code-isms (Runtime/Reviewer CLI values, stale session IDs).
- README: corrected planner skills documentation (planner runs `--no-skills`).

## [0.3.4] - 2026-06-17
### Changed
- feat(all): add repository and homepage fields to all package.json files


## [0.3.3] - 2026-06-15
### Changed
- Version bump


## [0.3.2] - 2026-06-14
### Changed
- docs: update all READMEs and CHANGELOG for new features
- feat(setup): detect missing setup requirements for packages


## [0.3.1] - 2026-06-12
### Changed
- Version bump


## [0.3.0] - 2026-06-12
### Changed
- Version bump


## [0.2.2] - 2026-06-11
### Changed
- Version bump


## [0.2.1] - 2026-06-11
### Changed
- Version bump


## [0.2.0] - 2026-06-09
### Added
- Initial monorepo setup
