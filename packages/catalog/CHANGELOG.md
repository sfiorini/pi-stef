# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
