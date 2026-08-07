# Template: Confluence Product Requirements Document (PRD)

A reusable, one-page-per-product PRD layout for Confluence. It captures *what* we're
building and *why*, the design and phased plan, the risks and open questions, and the
references behind it — in a structure that's consistent across every product PRD in this
space.

## When to use

- Kicking off a new product phase or major feature that needs alignment before build.
- Any document that must answer: problem, goals/non-goals, requirements, design, roadmap,
  risks, success criteria, and open questions.

Publish with `confluence_create_page` (new) or `confluence_update_page` (refresh), always
with `bodyRepresentation: "storage"`. Prefer to file the PRD under a per-product
**"PRD & Research"** parent page, with its source research documents as siblings.

## Placeholders

| Token | Required | Description |
| --- | --- | --- |
| `{{STATUS}}` | yes | Doc status shown in the metadata table. Typical values: `Draft`, `In review`, `Approved`, `Shipping`, `Shipped`. |
| `{{PHASE}}` | yes | Short phase tag, e.g. `Planning`, `Phase 1 — Committee MVP`. |
| `{{OWNER}}` | yes | DRI for this PRD (person or team). Use `TBD` if not yet assigned. |
| `{{PACKAGES}}` | yes | The repo packages this PRD concerns, e.g. `@pi-stef/finance`, `@pi-stef/finance-api`. |
| `{{DOC_URL}}` | yes | Link to the product/package doc site, or `—` if none. |
| `{{SOURCE_RESEARCH}}` | yes | Links to the sibling research pages this PRD synthesizes (Confluence page links or external URLs). |
| `{{EXECUTIVE_SUMMARY}}` | yes | The problem and the proposed direction in a few short paragraphs. |
| `{{BACKGROUND}}` | yes | Current state and architectural context the reader needs to understand the rest. |
| `{{GOALS}}` | yes | What success looks like — goals, explicit **non-goals**, and measurable **success criteria** keyed to milestones. |
| `{{REQUIREMENTS}}` | yes | Functional + non-functional requirements. Use bullets or a table. |
| `{{DESIGN}}` | yes | Solution and technical design — topology, components, data model, key algorithms. Diagrams welcome (wrap ASCII in a `code` macro). |
| `{{ROADMAP}}` | yes | Phased milestones with a one-line deliverable each. |
| `{{RISKS}}` | yes | Risks, governance, and mitigations. |
| `{{OPEN_QUESTIONS}}` | yes | Unresolved decisions, each with owner/options if known. Never publish this section empty — if there are none, say so explicitly. |
| `{{REFERENCES}}` | yes | Citations, links to research docs (Confluence page links or external URLs), and repos. |
| `{{PERSONAS}}` | no | Optional "Users & personas" section, dropped in after Goals. |

## Template body (Confluence storage format)

```xml
<ac:structured-macro ac:name="info" ac:schema-version="1">
  <ac:parameter ac:name="title">Product Requirements Document</ac:parameter>
  <ac:rich-text-body>
    <table>
      <tbody>
        <tr><th>Status</th><td>{{STATUS}}</td></tr>
        <tr><th>Phase</th><td>{{PHASE}}</td></tr>
        <tr><th>Owner</th><td>{{OWNER}}</td></tr>
        <tr><th>Packages</th><td>{{PACKAGES}}</td></tr>
        <tr><th>Doc site</th><td>{{DOC_URL}}</td></tr>
        <tr><th>Source research</th><td>{{SOURCE_RESEARCH}}</td></tr>
      </tbody>
    </table>
  </ac:rich-text-body>
</ac:structured-macro>

<h2>Executive summary</h2>
{{EXECUTIVE_SUMMARY}}

<h2>Background &amp; context</h2>
{{BACKGROUND}}

<h2>Goals, non-goals &amp; success criteria</h2>
{{GOALS}}

{{PERSONAS}}

<h2>Requirements</h2>
{{REQUIREMENTS}}

<h2>Solution &amp; technical design</h2>
{{DESIGN}}

<h2>Roadmap &amp; milestones</h2>
{{ROADMAP}}

<h2>Risks, governance &amp; mitigations</h2>
{{RISKS}}

<h2>Open questions</h2>
{{OPEN_QUESTIONS}}

<h2>References</h2>
{{REFERENCES}}
```

## Notes for the filling-in agent

- **Status lives in the metadata table.** Typical values: `Draft`, `In review`, `Approved`,
  `Shipping`, `Shipped`. Bump it as the PRD moves — it's the at-a-glance health of the doc.
- **Goals vs non-goals vs success criteria** are three distinct things in one section: what
  we *will* achieve, what we *explicitly won't*, and *how we'll know* (measurable, tied to
  milestones). Don't collapse them.
- **Open questions must be honest.** List the real unresolved decisions; this is often the
  most useful section for reviewers.
- **Diagrams**: paste ASCII/topology inside a `code` macro; for images, attach and embed with
  `<ac:image>`. A copy-pasteable code-macro skeleton:
  ```xml
  <ac:structured-macro ac:name="code" ac:schema-version="1">
    <ac:parameter ac:name="language">text</ac:parameter>
    <ac:plain-text-body><![CDATA[
      … ASCII diagram here …
    ]]></ac:plain-text-body>
  </ac:structured-macro>
  ```
  Put the literal diagram text inside `<![CDATA[ … ]]>`; if it ever contains `]]>`, split the
  CDATA around it.
- **Assumptions, dependencies, glossary:** this template intentionally has no dedicated
  section for these — fold assumptions into *Background &amp; context*, dependencies into
  *Risks, governance &amp; mitigations*, and term definitions into *References*. Don't invent
  ad-hoc headings; keep the canonical section order intact.
- **Link sibling research** in References — a PRD is only as credible as the research behind
  it, and the research docs live as sibling pages under the same "PRD & Research" parent.
- **Verify after publishing** with `confluence_page`: confirm the version incremented and the
  body rendered cleanly (tables, code macros, headings).
