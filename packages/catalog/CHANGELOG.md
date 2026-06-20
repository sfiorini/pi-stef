# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
### Added
- `pi.companions` auto-install on `ct add` with BFS traversal (depth cap 3, dedup, cycle-safe). A package declaring `pi.companions` in its `package.json` gets companions installed alongside it.

## [0.5.4] - 2026-06-18
### Changed
- test(catalog): update add test for @pi-stef/pair
- feat(pair): add skills, templates, docs, and catalog registration


## [0.5.3] - 2026-06-18
### Changed
- docs(atlassian,catalog): document Confluence slash commands and catalog hot-reload
- feat(atlassian,catalog): implement milestones M1+M2 - confluence slash commands and catalog hot-reload


## [0.5.2] - 2026-06-17
### Changed
- feat(all): add repository and homepage fields to all package.json files


## [0.5.1] - 2026-06-15
### Changed
- Version bump


## [0.5.0] - 2026-06-14
### Changed
- docs: update all READMEs and CHANGELOG for new features
- feat(status): show individual packages with setup indicators
- feat(setup): detect missing setup requirements for packages
- feat(schema): remove rating system, replace with enabled boolean
- feat(ui): add progress indicators to long-running commands
- fix(sync): detect version drift on first sync after external pi update


## [0.4.0] - 2026-06-12
### Added
- `ct reset` command — full nuke of @pi-stef packages and config
- `ct update` command with `--all` support
- `--scope @pi-stef` flag for batch add/remove operations
- Auto-derive package name from source in `ct add` (deprecate 2-arg syntax)

### Fixed
- Immutable catalog in batch add operations
- Scope message formatting

## [0.3.5] - 2026-06-12
### Fixed
- `ct remove` now cleans up lock file entry

## [0.3.4] - 2026-06-12
### Fixed
- `ct remove` uses full source for `pi uninstall`

## [0.3.3] - 2026-06-12
### Fixed
- `ct sync` detects local version changes from `pi update`

## [0.3.2] - 2026-06-12
### Fixed
- `ct sync` preserves local-only packages during pull

## [0.3.1] - 2026-06-12
### Changed
- Updated package.json for all packages

## [0.3.0] - 2026-06-12
### Added
- Initial release with catalog sync, add, remove, toggle, enable, disable commands

## [0.2.2] - 2026-06-11
### Added
- CHANGELOG.md to all packages
- Fix catalog sync to update lock file when no actions needed
