---
name: brain-entities
description: The typed entity graph in Brain — people, services, repositories, accounts and the relationships between them. Use when the user asks who or what something is, how two things are connected, what depends on what, or when the same thing has been referred to by several names and needs merging. Triggers on "who is", "what is", "how are X and Y related", "what depends on", "the Acme account", "is that the same person", duplicate or alias cleanup, and any question answered by walking relationships rather than by reading a memory. Part of the Brain memory database; see brain-memory for the core store and recall loop.
---

# Brain entities

Memories are prose that Brain extracts facts from. **Entities are the objects
those facts are about** — a person, a service, a repository, a customer — with
a canonical name, a type, attributes and typed relations to other entities.

Build a graph when the domain has real objects worth querying across. Do not
build one for loose prose: `remember` already extracts what it can.

## Finding something before creating it

`create_entity` on something that already exists is an error, and the surface
form a user says is rarely the canonical name.

1. `resolve_entity` — maps "the Acme account", "Priya", "that repo" onto the
   entity it means. **Start here.**
2. `get_entity` — one entity by id, with its canonical name, type and
   attributes.
3. `list_entities` — every entity of one type. The type is required; there is
   deliberately no list-across-all-types.

## Reading the graph

| | |
|---|---|
| `entity_relations` | the relations on one entity, without walking further |
| `traverse_entity` | walk outward along relations — "what does this depend on" |
| `graph` | a page of the whole workspace graph, entities and relations |

`traverse_entity` is the one that answers reachability questions. Prefer it
over pulling entities back one at a time and joining them yourself.

## Changing an entity

- `update_entity` replaces name, aliases and attributes **wholesale**. Send
  every field you want to keep — anything omitted is dropped.
- `rename_entity` gives a new canonical name and keeps the old one as an
  alias. Use this rather than `update_entity` when only the name changed; it
  preserves the alias that lets `resolve_entity` still find it.

## Duplicates

When two entities turn out to be the same thing, `merge_entities` folds one
into the other. It is reversible: `unmerge_entity` pulls it back out.

Merge when the evidence is clear — same person, same service under two names.
When it is a guess, say so and ask, because a merged graph reads as settled
fact to everything downstream.

`delete_entity` tombstones one so it stops appearing in listings and
traversals. Reach for it when something should never have been in the graph,
not when two things need combining.

## Relations

Typed edges between entities live in `brain-knowledge` —
`create_relation`, `supersede_relation`, `delete_relation`, `get_relation`.
Edges between **memories** (`caused`, `followed_by`) are `link` and `unlink`
here, and they are a different thing: a memory edge records sequence or cause
between two things that happened, not a fact about two objects.
