# Docs Domain

> **Purpose:** route you to the right document. Read this first before touching
> or creating anything under `docs/`. This file navigates the docs tree; it does
> not repeat document content.
>
> **Progressive disclosure:** start at the quick-routing table. Only drop to the
> directory map when the table does not settle it. The lifecycle section matters
> only when you are writing a new document.

## Quick Routing

| When you need...                                                | Read…                                        |
| --------------------------------------------------------------- | -------------------------------------------- |
| Architecture / product decisions                                | `superpowers/specs/`                         |
| Implementation steps / task breakdown                            | `superpowers/plans/`                         |
| Reusable rendering, test, or integration traps                   | `memory/known-gotchas.md`                    |
| Pre-release manual verification matrix                          | `manual-qa.md`                               |
| User-visible shortcuts / operations                             | `guides/`                                    |
| Local competitor / benchmark notes                              | `competitors/`                               |
| A bug that spans multiple domains                               | Root `AGENTS.md`, then every affected guide  |

Still not sure? Read the directory map below.

## Directory Map

| Path                          | Purpose                                            | Read when                                          | Write when                                            |
| ----------------------------- | -------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `superpowers/specs/`          | Approved architecture / product decisions          | A design decision needs a documented home          | A feature is designed and approved                    |
| `superpowers/plans/`          | Dated implementation plans with task breakdown     | Executing an approved feature (multi-step)         | A spec is approved; before coding                     |
| `memory/known-gotchas.md`     | Verified, reusable cross-layer traps               | Symptoms match a known trap                        | You discover a trap that is reusable, not one-off     |
| `manual-qa.md`                | Release verification checklist                     | Before a release / interaction-sensitive change    | User-visible behavior or the release matrix changes   |
| `guides/`                     | User-facing documentation                          | Explaining behavior to users                       | User-visible operations change                        |
| `competitors/`                | Local competitor analysis                          | Benchmarking a feature against an existing product | Analyzing a new product or topic                      |

## Document Lifecycle

- **Specs precede plans.** A feature moves from `specs/` (what and why, approved)
  to `plans/` (how and in which order) only after its design is accepted.
- **Date-prefixed naming.** Use `YYYY-MM-DD-<topic>-design.md` for specs and
  `YYYY-MM-DD-<milestone>-<topic>.md` for plans. Read existing files in the
  directory before choosing a name; the prefix must stay sortable.
- **`memory/` only holds verified, reusable traps.** One-off decisions, task
  notes, and speculative risks belong nowhere in `docs/`. If a trap is not
  clearly a "this bit us again" pattern, do not file it.
- **`manual-qa.md` is living, not historical.** Update the checklist whenever
  user-visible behavior or the verification matrix changes. Its recorded counts
  are historical, not assertions about the current suite.
- **`competitors/` is local-only.** It is matched by `.gitignore`
  (`docs/competitors/`) and must never be committed or pushed. Follow the
  conventions in its `README.md`: one directory per product, one file per topic.
- **Do not duplicate.** If the content already exists elsewhere (domain
  `AGENTS.md`, root `AGENTS.md`, README), link to it instead of restating it.
- **CHANGELOG and README update at release time.** Run `pnpm release:changelog`
  (conventional commits are the input — the commit-msg hook enforces the type
  prefix) when cutting a version, and touch README whenever user-visible
  setup, shortcuts, or release flow change. Specs and plans record decisions;
  README and CHANGELOG are the only user-facing docs.

## Out of Scope

This file does not cover engineering rules, cross-layer boundaries, or
verification commands — those live in the root `AGENTS.md` and the domain
`AGENTS.md` files (see the root Task Routing table). It never hosts document
body content.
