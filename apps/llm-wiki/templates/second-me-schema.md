# Wiki Schema — Second Me

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| person | wiki/people/ | People connected to Alessio, their roles, relationship, and interactions |
| organization | wiki/organizations/ | Companies, universities, associations, teams, and institutions |
| project | wiki/projects/ | Products, repositories, initiatives, research, and personal projects |
| experience | wiki/experiences/ | Jobs, education, applications, interviews, programs, and major activities |
| skill | wiki/skills/ | Technologies, domains, languages, and demonstrated capabilities |
| event | wiki/events/ | Dated meetings, deadlines, trips, interviews, and milestones |
| topic | wiki/topics/ | Recurrent subjects, interests, decisions, and areas of knowledge |
| source | wiki/sources/ | Source-specific summaries for documents and email threads |
| synthesis | wiki/synthesis/ | Cross-source timelines, profiles, comparisons, and conclusions |
| query | wiki/queries/ | Important unresolved questions or contradictions |
| overview | wiki/ | High-level summary of the whole knowledge base |

## Naming Conventions

- Files use stable `kebab-case.md` slugs.
- People use their full known name.
- Organizations and projects use their official or consistently used name.
- Experiences use a concise subject and date when needed to distinguish them.
- Source pages preserve source identity. Email thread sources should use their canonical thread identity.
- Avoid creating separate pages for spelling variants or minor name variants.

## Frontmatter

All non-structural pages include:

```yaml
---
type: person | organization | project | experience | skill | event | topic | source | synthesis | query | overview
title: Human-readable title
tags: []
related: []
sources: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

Use these optional fields when supported:

```yaml
status: current | historical | planned | completed | uncertain
start_date: YYYY-MM-DD
end_date: YYYY-MM-DD
organization: ""
people: []
projects: []
```

Source pages may additionally include:

```yaml
source_kind: email-thread | cv | cover-letter | reference-letter | project-note | attachment | document
source_date: YYYY-MM-DD
participants: []
```

## Source and Evidence Rules

- Every factual page should cite one or more source identities in `sources:`.
- Preserve source dates and distinguish current facts from historical facts.
- A CV is authoritative for the version of Alessio's profile at its document date, not automatically for the present.
- A cover or motivational letter may contain positioning tailored to a specific application; label it as such.
- A reference letter records a third party's assessment.
- An email thread is one evolving source. New messages should update the same canonical source page rather than create disconnected duplicates.
- Attachments remain separate source files but should be linked to the email thread and relevant entities.

## Index Format

`wiki/index.md` lists pages grouped by page type:

```markdown
- [[page-slug]] — concise description
```

## Log Format

`wiki/log.md` records ingest activity in reverse chronological order:

```markdown
## YYYY-MM-DD ingest | Source title

- Main additions or updates
```

## Cross-Referencing Rules

- Use `[[page-slug]]` for links between wiki pages.
- Link projects to people, organizations, skills, and dated experiences.
- Link applications and jobs to the relevant CV or letter versions.
- Link events and commitments to their originating email thread or document.
- Prefer updating an existing stable page over creating a near-duplicate.

## Contradiction and Privacy Handling

- Record conflicting claims and their dates; do not flatten them into one unsupported truth.
- Create a query page when a contradiction materially affects understanding.
- Do not copy credentials, access tokens, passwords, full identity-document numbers, or unnecessary financial details into wiki pages.
- Summarize sensitive administrative documents only to the minimum level needed for useful retrieval.
