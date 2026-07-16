# Changelog

## [Unreleased]

## [0.1.1] - 2026-07-16
### Changed
- feat(flow): register in catalog + docs-site; README + flow.md + CHANGELOG
- test(flow): end-to-end integration (YAML->script->chain, audit gate)
- feat(flow): example workflows (auth-audit, ship-feature, code-review, research-report)
- fix(flow): accurate shouldAdopt doc + try/catch controller callbacks (M6 P3)
- feat(flow): tmux manager + event-subscription controller (created->open, terminal->close)
- feat(flow): tmux renderer (port team pretty-pane, codex/plain themes)
- docs(flow): tmux event-bus spike findings
- fix(flow): surface explorer model + agent warnings (M5 parity)
- fix(flow): guard null reviewerModel in sf_flow_implement (M5 P1)
- feat(flow): sf-flow-plan/implement/auto tools + skills
- feat(flow): auto input classifier (prompt/md-file/prd/jira)
- feat(flow): sf-flow-audit skill + tool (full triad)
- feat(flow): request-review dual-blind AND-gate + respond-review fix-apply
- feat(flow): audit codereview wrapper + audit-code self-checklist/gate/score
- feat(flow): audit verdict contract (P0-P3 + APPROVED/REVISE)
- fix(flow): correct writeFlowYamlAsync JSDoc + add async test (M3 polish)
- feat(flow): sf-flow-create-workflow wizard + workflow.yaml template
- fix(flow): quote-safe meta name/titles + self-validating register (M2 polish)
- fix(flow): reject duplicate out values (M2 P2)
- fix(flow): enforce agent/skill/raw mutual exclusivity (M2 P2)
- fix(flow): M2 review fixes — emit tools, fail_on gate, robust slash handler
- feat(flow): register generated flow as /<name> command
- feat(flow): YAML -> pi-dynamic-workflows script generator
- feat(flow): cross-field YAML validation
- feat(flow): declarative workflow YAML schema (3 knobs)
- fix(flow): make audit/tmux/worktree Optional in config schema
- feat(flow): register skeleton + sf_flow_finalize tool
- feat(flow): worktree create/validate/cleanup/finalize (port pair's)
- feat(flow): ensureAgentFiles + 6 bundled agent definitions
- feat(flow): config schema + layered load (port pair's)
- feat(flow): scaffold @pi-stef/flow package + extension entry


## 0.1.0

- Initial release of `@pi-stef/flow`.
- Reusable declarative workflows (agents/phases/loops YAML + deterministic generator).
- `sf-flow-plan`, `sf-flow-implement`, `sf-flow-audit`, `sf-flow-auto`, `sf-flow-create-workflow`.
- CodeRabbit-style audit triad (pi-dw `/code-review` + bigpowers dual-blind AND-gate).
- tmux agent visualization (adapted from team).
