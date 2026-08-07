# Template: Confluence space home page

The landing page for a project/product Confluence space. Produces a consistent, scannable
home page that answers *what is this, how is it built, where are the docs, and what changed
recently* — without anyone having to click through.

## When to use

- Creating a **new space** for a package or product → publish this as the space's home page
  (the page whose `pageId == space.homepageId`).
- Refreshing an **existing** home page that is empty, a raw default template, or stale.

Publish with `confluence_update_page` (home page already exists) or
`confluence_create_page` (new page). Always pass `bodyRepresentation: "storage"`.

## Placeholders

| Token | Required | Description |
| --- | --- | --- |
| `{{SPACE_NAME}}` | yes | The product/package name, e.g. `Finance`. Used in the hero title. |
| `{{TAGLINE}}` | yes | One short phrase for the hero title, e.g. *Portfolio tracking & deterministic suggestions*. |
| `{{PITCH}}` | yes | 1–2 sentences in the hero panel describing what the space covers and which packages/docs it groups together. |
| `{{OVERVIEW_PARA}}` | yes | Opening paragraph of the Overview section. |
| `{{OVERVIEW_BULLETS}}` | yes | `<li>` items — the headline capabilities/features, one short line each. |
| `{{ARCHITECTURE_INTRO}}` | yes | Sentence(s) introducing how the pieces fit together. |
| `{{ARCHITECTURE_ROWS}}` | yes | `<tr>` rows for the Architecture table. Keep the header columns: `Component`, `Role`, `Runs where`, `Config`. |
| `{{RESOURCES_LINKS}}` | yes | `<li>` items, each a `<a href>` link to a doc page, repo, or related space. |
| `{{QUICK_REFERENCE}}` | yes | Filled content for the Quick reference section — typically one or more `code` macros (install / CLI / API). |
| `{{EXTRA_SECTIONS}}` | no | Optional extra sections (e.g. Providers, Data model) dropped in before the live feed, as raw storage-format XHTML. |
| `{{DISCLAIMER}}` | no | Optional short disclaimer rendered in a `note` panel. Omit the whole panel if not applicable. |

## Template body (Confluence storage format)

```xml
<ac:structured-macro ac:name="info" ac:schema-version="1">
  <ac:parameter ac:name="title">{{SPACE_NAME}} — {{TAGLINE}}</ac:parameter>
  <ac:rich-text-body>
    <p>{{PITCH}}</p>
  </ac:rich-text-body>
</ac:structured-macro>

<h2>Overview</h2>
<p>{{OVERVIEW_PARA}}</p>
<ul>{{OVERVIEW_BULLETS}}</ul>

<h2>Architecture</h2>
<p>{{ARCHITECTURE_INTRO}}</p>
<table>
  <tbody>
    <tr>
      <th>Component</th>
      <th>Role</th>
      <th>Runs where</th>
      <th>Config</th>
    </tr>
    {{ARCHITECTURE_ROWS}}
  </tbody>
</table>

<h2>Key resources</h2>
<ul>
  {{RESOURCES_LINKS}}
</ul>

{{EXTRA_SECTIONS}}

<h2>Quick reference</h2>
{{QUICK_REFERENCE}}

<h2>Recently updated content</h2>
<ac:structured-macro ac:name="recently-updated" ac:schema-version="1">
  <ac:parameter ac:name="types">page,whiteboard,database,blog</ac:parameter>
  <ac:parameter ac:name="max">8</ac:parameter>
  <ac:parameter ac:name="theme">concise</ac:parameter>
  <ac:parameter ac:name="hideHeading">true</ac:parameter>
</ac:structured-macro>

<ac:structured-macro ac:name="note" ac:schema-version="1">
  <ac:rich-text-body>
    <p>{{DISCLAIMER}}</p>
  </ac:rich-text-body>
</ac:structured-macro>
```

## Notes for the filling-in agent

- Substitute **every** `{{TOKEN}}`. Never publish a raw token.
- Keep the `recently-updated` macro — it makes the home page feel alive as content lands. **Important:** use the exact parameter set shown above (`types` / `max` / `theme` / `hideHeading`) and do **not** add `spaces=@self` — that combination causes the v2 page API to return HTTP 500. The macro defaults to the current space, which is what you want.
- The Architecture table header is fixed (`Component` / `Role` / `Runs where` / `Config`).
  Add rows that fit; if a column is genuinely meaningless for a space, drop that column
  for that space only, but prefer keeping all four for consistency.
- For code snippets use the `code` macro with `ac:parameter ac:name="language"` set
  (`bash`, `json`, …). Put the literal text inside `<![CDATA[ … ]]>`.
- Verify the result after publishing with `confluence_page` (or `confluence_get_page`) and
  confirm the version incremented and the body replaced cleanly.
