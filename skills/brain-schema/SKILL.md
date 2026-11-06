---
name: brain-schema
description: The schema a Brain workspace declares — which entity types, predicates and relation types exist, and which extractors read new writes. Use when modelling a domain before storing much in it, when a create_entity or create_relation call is rejected for an unknown type, when the user asks what types exist, or when adding a type to an established workspace. Triggers on "declare a type", "what types are there", "model this domain", "unknown entity type", "unknown relation type", and schema validation or versioning questions. Part of the Brain memory database; see brain-memory for the core store and recall loop.
---

# Brain schema

A workspace declares the **types** it uses: entity types, predicates and
relation types. `create_entity` and `create_relation` are checked against it,
so an unknown type is a rejection rather than a new type invented on the spot.

## Read before you write

`get_schema` returns what this workspace has declared. **Read it before
creating a typed entity or relation** — it is the difference between a call
that works and one rejected for a type that was never declared.

`list_extractors` shows what will read a new write: which extractors are
registered, and therefore what Brain will draw out of prose automatically.
Worth checking when `remember` stores something but `recall` cannot find the
fact you expected — often the extractor for that shape is simply not enabled.

## Adding types

```
validate_schema   →   upload_schema
```

`validate_schema` checks a document without storing it. Run it first; the
errors it returns are the cheapest form of this feedback.

`upload_schema` **merges** declarations in. It is additive by design: it
cannot remove a type, and it cannot change what an existing one means. That
is deliberate — data already written against a type would be orphaned by a
redefinition.

## Removing a type

`drop_schema_type` removes **one predicate or relation type**, and only those
two kinds. Entity types cannot be dropped.

Before dropping, consider what is already written against it. The declaration
goes; the rows that used it do not come back.

## History

`list_schema_versions` pages the schema's version history — distinct from
`get_schema`, which is only the current state. Reach for it to answer when a
type appeared, or what the shape was when a batch of data was written.

## Modelling advice

Declare a type when the domain has objects you will **query across**: people,
services, repositories, customers. Do not declare one for a value that only
ever appears as an attribute of something else.

A workspace with no schema still works — `remember` and `recall` need none.
Schema is what turns prose into a graph you can traverse, so the time to add
it is when traversal becomes the question you are asking.
