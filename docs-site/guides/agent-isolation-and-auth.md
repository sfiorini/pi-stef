# Agent Isolation & Auth

Flow agents run with different isolation levels. This guide explains what isolation means, what it strips vs preserves, and how to give an agent access to **private** sources (private GitHub, authenticated Confluence, Jira) without removing isolation everywhere.

> TL;DR — the `researcher` agent is the only built-in flow agent that runs **un-isolated** (`isolated: false` + `extensions: [web, atlassian]`), so it can reach private repos and authenticated pages. `explorer` and `analyst` stay isolated (fresh context, built-in tools only).

---

## How isolation works

When an agent is spawned with `isolated: true`, pi-subagents starts it in a **fresh context** with **no parent conversation** and **extensions disabled**. When `isolated: false`, the agent **inherits the parent's context** and any **extensions/skills declared in its `.md` frontmatter** are loaded.

| `isolated` | Context | Extensions | Skills | Extension tools (`ext:*`) |
|------------|---------|-----------|--------|---------------------------|
| `true` (default for most) | fresh, no parent | **forced off** (`extensions: false`) | off | stripped — unavailable even if listed in `tools:` |
| `false` | inherits parent | loaded per frontmatter `extensions:` | per frontmatter `skills:` | available (when the extension is installed) |

> ⚠️ **The `.md` frontmatter is authoritative and "sticky."** Declaring `extensions: [web, atlassian]` in an agent's `.md` frontmatter loads those extensions **whenever that agent is spawned** — including from a workflow's inline `agent()` call or the plan/implement skills. A workflow YAML cannot add an `extensions:` field (the flow `AgentDef` schema has none); it can only flip `isolated:` and set advisory `tools:`. To grant an extension, edit the agent `.md`.

There is **no allowlist variant** of isolation (no "isolated but keep one extension"). To grant selective access, set `extensions:` to the packages you want and use the `tools:` / `exclude_extensions:` selectors to narrow what surfaces.

---

## What isolation strips vs preserves

| Stripped when `isolated: true` | Preserved when `isolated: true` |
|-------------------------------|---------------------------------|
| Extension tools (`sf_web_*`, `confluence_*`, `jira_*`, …) | Built-in tools (`read`, `grep`, `find`, `ls`, `write`, `edit`) |
| The `extensions:` declaration (forced off) | `bash` (and the current working directory) |
| Auto-loaded skills | The process environment (`env`) |
| | Network access (no sandbox) |
| | Credentials on disk (e.g. `~/.config/gh` tokens, `~/.netrc`) |

The last three rows are the key insight: an isolated agent **can still shell out**. So `bash` + `gh` works even when `isolated: true`, because `gh` reads its token from `~/.config/gh` over the network. The agent just has to be **told** to use it.

---

## Agents in the deep-research workflow

Of these, only `researcher` is a shipped agent file (`~/.pi/agent/agents/researcher.md`, seeded by `/sf-flow-seed`); `explorer` and `analyst` are spawned inline by the `deep-research` workflow and have no shipped `.md`.

| Agent | `isolated` | `extensions` | Reaches private sources? |
|-------|-----------|--------------|--------------------------|
| `researcher` | **`false`** | `[web, atlassian]` | ✅ GitHub (gh), Confluence, Jira, web |
| `explorer` | `true` | — | codebase only (fast, cheap, fresh context) |
| `analyst` | `true` | — | synthesis/write only |

`researcher` is the only un-isolated agent — by design (decision: "researcher researches everywhere"). It is shared across `sf_flow_plan` (Phase 1 parallel research), the `research-report` flow, and the `deep-research` flow, so relaxing it once benefits all of them.

---

## Private-repo recipes

### Private GitHub (PRs, issues, commits)

`gh` is pre-authenticated (scopes `repo` + `read:org`) and works for **any** agent via `bash` — even isolated ones:

```bash
# compact structured view of a PR
gh pr view https://github.com/OWNER/REPO/pull/8701 --json number,title,body,reviews,comments,files

# the diff
gh pr diff https://github.com/OWNER/REPO/pull/8701
```

If `gh auth status` fails, run `gh auth login` once (stored in `~/.config/gh`).

### Confluence — native tools (preferred)

The `@pi-stef/atlassian` extension provides first-class Confluence tools. Requires environment variables:

| Variable | Purpose |
|----------|---------|
| `ATLASSIAN_BASE_URL` (or `ATLASSIAN_DOMAIN`) | Your instance, e.g. `https://acme.atlassian.net` |
| `ATLASSIAN_EMAIL` | The account email |
| `ATLASSIAN_API_TOKEN` | A personal API token (https://id.atlassian.com/manage-profile/security/api-tokens) |

```text
confluence_page    — compact page context, by URL or page ID
confluence_get_page — raw page content by ID
```

### Confluence — SAML SSO fallback

If your instance requires SAML SSO (personal API tokens rejected), fall back to a logged-in browser profile via `@pi-stef/web`:

```text
1. sf_web_login { url, profile: "confluence" }   # once — stores cookies
2. sf_web_fetch { url, profile: "confluence", mode: "browser" }
```

Re-run `sf_web_login` when sessions expire (you'll see redirects/login pages). Use `sf_web_session { action: "list" }` to inspect stored profiles. Prefer the native atlassian tools when both work — they're faster and return structured content.

### Jira

Same `ATLASSIAN_*` env vars:

```text
jira_issue      — an issue with bounded context (use includeContext: true)
jira_get_issue  — raw issue data
story_context   — a focused context bundle for a story
```

---

## Environment checklist

```bash
# GitHub (works even when isolated)
gh auth status

# Atlassian (needs all three for native tools)
echo "$ATLASSIAN_BASE_URL / $ATLASSIAN_EMAIL / ${ATLASSIAN_API_TOKEN:+set}"

# Optional: no-key web search
echo "${SF_WEB_SEARXNG_URL:-<unset>}"
```

---

## Worked example: deep-research

The built-in `deep-research` flow mixes isolation levels deliberately:

| Phase | Agent | `isolated` | Why |
|-------|-------|-----------|-----|
| intake / report | `analyst` | `true` | Synthesis only; no source access needed |
| code research | `explorer` | `true` | Fast codebase scan; fresh context |
| web / external research | `researcher` | **`false`** | Needs web + private Confluence/Jira |

The `researcher` agent's `.md` frontmatter carries `extensions: [web, atlassian]`, so every `web-research` task it runs can cite private pages alongside public web sources.

---

## See also

- [@pi-stef/flow](/packages/flow) — workflows, agents, the plan/implement/audit skills
- [@pi-stef/atlassian](/packages/atlassian) — Confluence & Jira tools
- [@pi-stef/web](/packages/web) — `sf_web_*` tools and login profiles
- [Getting Started](/getting-started)
