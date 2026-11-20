---
name: brain-schema
description: The schema a Brain workspace declares — which entity types, predicates and relation types exist, and which extractors read new writes. Use when modelling a domain before storing much in it, when a create_entity or create_relation call is rejected for an unknown type, when the user asks what types exist, or when adding a type to an established workspace. Triggers on "declare a type", "what types are there", "model this domain", "unknown entity type", "unknown relation type", and schema validation or versioning questions. Part of the Brain memory database; see brain-memory for the core store and recall loop.
---

# Brain schema

A workspace declares the **types** it uses: entity types, predicates and
relation types. `create_entity` and `create_relation` are checked against it,
so an unknown type is a rejection rather than a new type invented on the spot.

## Read before you write

`list_entity_types` returns the entity types and their ids. **Read it before
creating a typed entity** — `create_entity` needs `entity_type_id`, and
`get_schema` returns only the DSL document and its version. It also reports
the six built-in `brain:` types in a fresh workspace: Person, Organization,
Project, Event, Place and Concept.

`get_schema` returns what this workspace has declared. Read it before
creating a typed relation — it is the difference between a call that works
and one rejected for a type that was never declared.

`list_extractors` shows what will read a new write: which extractors are
registered, and therefore what Brain will draw out of prose automatically.
Worth checking when `remember` stores something but `recall` cannot find the
fact you expected — often the extractor for that shape is not enabled.

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

The document is Brain's schema DSL, not JSON. A minimal document is:

```text
namespace <this workspace's namespace>
define entity_type Person { attributes {} }
define entity_type Org { attributes {} }
define predicate works_at { kind: Fact subject: Entity<Person> object: Entity<Org> }
define relation_type reports_into { from: Person to: Org cardinality: many-to-one }
```

For a predicate, `object:` accepts `Value<text|number|bool|date|timestamp>`,
`Entity<Name>`, `Memory`, `Statement` or `Any`. **Plain `Text` is not a
form**. For a relation type, `from:` and `to:` take bare type names such as
`Person`, not `Entity<Person>`; the wrapped form belongs on the predicate
line.

Before the first schema upload, undeclared `<this workspace's namespace>:name`
predicates and relation types are accepted. After the first upload, new writes
must use declarations in that schema namespace. Existing rows survive and
remain readable; only later writes are refused. The first upload therefore
changes the rules for everything written after it.

Both `upload_schema` and `replace_schema` accept `scope`: `namespace` is the
default base, and `space` creates an overlay visible only in this space.
**Leave `scope` alone** unless you specifically want a space-only overlay.
After a space upload, `get_schema` and `list_schema_versions` show only the
overlay path, and neither tool accepts `scope` to reveal both paths or undo
the split.

## Removing a type

`drop_schema_type` removes **one predicate or relation type**, and only those
two kinds. Entity types cannot be dropped.

Before dropping, consider what is already written against it. The declaration
goes; the rows that used it do not come back.

`drop_schema_type` works with the **bare name**, such as `works_at`, even
though its parameter description shows `namespace:name`. Passing
`acme:works_at` returns a success-shaped payload with
`dropped: false` and removes nothing. Check `dropped`; `false` also means an
unknown name, so it does not distinguish a wrong spelling from nothing to
drop.

`replace_schema` replaces the whole document and drops every declared row in
scope that the new document leaves out. It requires
`force_drop_existing: true`. Run it with
`force_drop_existing: false` first: the refusal shows what the true setting
would destroy. Its `scope` has the same `namespace` and `space` meanings as
`upload_schema`.

## History

`list_schema_versions` lists schema history in reverse order — distinct from
`get_schema`, which is only the current state. Call it without `limit` to see
the real count. `total` is the number of rows returned, not the number of
versions that exist. It does not page: `next_cursor` is null, and a fabricated
cursor is ignored and returns the first page. Do not build a paging loop on
it. Reach for it to answer when a type appeared, or what the shape was when a
batch of data was written.

## Modelling advice

Declare a type when the domain has objects you will **query across**: people,
services, repositories, customers. Do not declare one for a value that only
ever appears as an attribute of something else.

A workspace with no schema still works — `remember` and `recall` need none.
Schema is what turns prose into a graph you can traverse, so the time to add
it is when traversal becomes the question you are asking.
