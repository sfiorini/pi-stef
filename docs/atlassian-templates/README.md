# Atlassian Templates

Reusable templates for content we publish to Atlassian Cloud (Confluence spaces/pages,
Jira issue types, etc.). Each template is a self-documenting Markdown file containing:

- **What it's for** — the use case and when to apply it.
- **Placeholders** — every `{{TOKEN}}` the template exposes, with a description.
- **Template body** — the ready-to-use content (Confluence *storage format* XHTML for
  Confluence templates), in a fenced code block. Copy it, substitute the placeholders,
  and push it through the matching tool.

## Available templates

| Template | File | Tool / target | Purpose |
| --- | --- | --- | --- |
| Confluence space home page | [`confluence-space-homepage.md`](./confluence-space-homepage.md) | `confluence_update_page` (or `confluence_create_page`) | The landing page for a project/product space. Gives visitors the elevator pitch, architecture, key resources, a quick-reference, and a live "recently updated" feed in one consistent layout. |
| Confluence PRD | [`confluence-prd.md`](./confluence-prd.md) | `confluence_create_page` / `confluence_update_page` (storage format) | A new product phase or major feature. Captures problem, goals/non-goals, requirements, design, roadmap, risks, success criteria, open questions, and references. File under a per-product "PRD & Research" parent with the source research as siblings. |

## Conventions

- **One file per template.** Keep the template, its placeholder docs, and a filled-in
  example (when useful) together in a single `.md` so an agent can read one file and act.
- **Storage format for Confluence.** Confluence templates are authored in *storage format*
  (the XHTML + macro dialect the REST API accepts). When publishing, pass
  `bodyRepresentation: "storage"` to `confluence_update_page` / `confluence_create_page`.
- **Placeholders use `{{UPPER_SNAKE}}`.** Substitute every token before publishing; never
  publish a raw placeholder.
- **Preserve the section order.** The section order in each template is the canonical
  layout. Adapt the *content* of a section to the space, but keep the ordering and the
  macros (e.g. the live `recently-updated` feed) intact so every home page looks familiar.
- **Adding a template:** add the `.md` file here, then add a row to the table above and a
  bullet to `AGENTS.md` → *Atlassian templates* so future sessions can discover it.
