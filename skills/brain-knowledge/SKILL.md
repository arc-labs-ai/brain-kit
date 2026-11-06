---
name: brain-knowledge
description: Statements and corrections in Brain — the individual subject-predicate-object claims extracted from memories, their provenance, and their supersession history. Use when a stored fact is wrong, outdated or disputed, when the user asks where something came from or what changed and when, when a claim must be retracted rather than merely hidden, or when asserting a fact directly instead of waiting for extraction. Triggers on "that's wrong", "correct that", "where did you get that", "what changed", "since when", "retract", audit and provenance questions. Part of the Brain memory database; see brain-memory for the core store and recall loop.
---

# Brain knowledge

A memory is what was said. A **statement** is one claim drawn out of it —
subject, predicate, object — and statements are what `recall` actually ranks.
This skill is for working at that level: correcting a claim, tracing where it
came from, and seeing what it replaced.

## Reading

| | |
|---|---|
| `list_statements` | page through the facts extracted in this workspace |
| `get_statement` | one statement, with the memory it came from |
| `statement_history` | the full supersession chain, oldest to newest |
| `get_relation` | one typed edge between entities, with its endpoints |

`statement_history` is the one that answers "what did we think before". Reach
for it whenever the current answer looks older than it should — recall ranks
by **similarity, not recency**, so a stale claim can outrank the correction
that replaced it.

## Correcting

Three verbs, and the difference between them matters:

- **`supersede_statement`** — the claim changed. Both survive, linked, and
  the new one becomes current. **This is almost always the right one.**
- **`delete_statement`** — soft tombstone. The row survives for audit and
  stops being returned.
- **`retract_statement`** — the stronger form: the **content does not
  survive**. For something that should never have been recorded — a secret
  pasted by accident, a claim about a person that was false and harmful.

Use `retract_statement` only when the content itself is the problem.
Preferring it by default destroys the history that makes "what changed" a
question Brain can answer at all.

The same three exist for edges: `supersede_relation`, `delete_relation`.

## Asserting directly

`create_statement` and `create_relation` write a claim without waiting for
extraction to infer it. Use them when:

- the fact is structural and you already know it exactly, or
- extraction got it wrong and you are putting the right one in its place.

Prefer `remember` for anything a person said in prose. Extraction is what
turns one sentence into several linked claims; asserting by hand skips that
and gives you exactly what you typed and nothing more.

## Supersession is a chain, not an overwrite

Every correction keeps its predecessor. That is what makes provenance work —
and it is why the honest answer to "has this always been true?" is
`statement_history`, not a second `recall`.
