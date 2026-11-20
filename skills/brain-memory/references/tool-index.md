# Every Brain tool, by job

**Generated** by `scripts/build-tool-index.py` from the server's own
`registerTool` calls. Do not hand-edit.

This is for deciding **whether a capability exists**, not for learning how to
use one. Each group names the skill that explains the work it belongs to, and
that skill is where the judgement lives.


**58 tools.**


## Store and retrieve — `brain-memory`

- **`remember`** — Store something a FUTURE session would be worse without.
- **`recall`** — Ask a question, get the CURRENT answer — stale and contradicted facts are already resolved server-side.
- **`forget`** — Delete ONE memory by id, for something that should never have been stored — wrong, private, or noise.
- **`list_memories`** — Everything behind ONE memory: the typed facts drawn from it, its provenance, how it scored, and its edges to other memories.
- **`inspect_memory`** — Everything behind ONE memory: the typed facts drawn from it, its provenance, how it scored, and its edges to other memories.
- **`materialize_directives`** — Render this workspace's stored directives — the standing instructions it has learned — into a block ready to drop into a system prompt.
- **`encode_vector`** — Store a memory whose embedding the CALLER already computed.


## Reason over what is held — `brain-memory`

- **`plan`** — Find a route from a start state to a goal across what is known about the workspace.
- **`reason`** — Infer what follows from an observation, given what is already known in the workspace.


## Entities — `brain-entities`

- **`create_entity`** — Declare an entity of a type the workspace already knows (see `get_schema` — an undeclared type is rejected, not invented).
- **`list_entity_types`** — The entity types this workspace can use, each with the numeric `entity_type_id` that `create_entity` and `list_entities` require.
- **`list_entities`** — Entities of one type.
- **`resolve_entity`** — Match a candidate name exactly, ignoring case and surrounding whitespace, against the canonical name or recorded aliases.
- **`get_entity`** — One entity by id, with its canonical name, type and attributes.
- **`traverse_entity`** — The relations attached to one entity, without walking further out.
- **`entity_relations`** — The relations attached to one entity, without walking further out.
- **`update_entity`** — Replace an entity's name, aliases and attributes WHOLESALE — anything you omit is dropped, so send every field you mean to keep.
- **`rename_entity`** — Give an entity a new canonical name, keeping the old one as an alias.
- **`merge_entities`** — Fold one entity into another when both describe the same thing — two records for one person, a service under two names.
- **`unmerge_entity`** — Pull an entity back out of the survivor it was merged into — the undo for merge_entities.
- **`delete_entity`** — Tombstone an entity so it stops appearing in listings and traversals.


## Graph edges — `brain-entities`

- **`link`** — Connect two memories with a typed edge (caused, followed_by, derived_from, similar_to, contradicts, supports, references, part_of).
- **`unlink`** — Remove a typed edge between two memories.
- **`graph`** — A page of the workspace's knowledge graph — entities and the relations between them.


## Statements and relations — `brain-knowledge`

- **`list_statements`** — Page through the subject–predicate–object facts extracted from this workspace's memories.
- **`get_statement`** — One statement by id, with the memory it came from.
- **`get_relation`** — One relation by id, with its endpoints and type.
- **`statement_history`** — The full supersession chain for a claim, oldest to newest.
- **`create_statement`** — Assert a claim directly, rather than waiting for extraction to infer one.
- **`supersede_statement`** — Replace a claim with a corrected one.
- **`delete_statement`** — Soft-tombstone a claim: the row survives for audit and stops being returned.
- **`retract_statement`** — Retract a claim so its CONTENT does not survive — the strongest removal here.
- **`create_relation`** — Assert a typed edge between two entities.
- **`supersede_relation`** — Replace an edge with a corrected one, keeping the chain.
- **`delete_relation`** — Tombstone a typed edge BETWEEN ENTITIES.


## Schema — `brain-schema`

- **`get_schema`** — Returns the declared schema document and its version for this workspace.
- **`validate_schema`** — Check a schema document without storing it.
- **`upload_schema`** — Merge new declarations into the workspace schema.
- **`list_schema_versions`** — Page through the schema's version history.
- **`list_extractors`** — The extractors registered for this workspace — what will read a new memory and what it is allowed to produce.
- **`drop_schema_type`** — Remove one declared predicate or relation type.
- **`replace_schema`** — Replace the whole schema document, instead of merging into it.


## Identity and capability — `brain-workspace`

- **`whoami`** — Report the identity this connection runs as — the namespace and space your API key resolves to on the server.
- **`capabilities`** — What this deployment supports — limits, enabled extractor tiers, protocol version.
- **`llm_credential_status`** — Whether this workspace has an LLM provider key, and which provider and model it is for.
- **`verify_llm_credential`** — Re-check the provider key this workspace already has, by asking the provider.
- **`put_llm_credential`** — Install this workspace's LLM provider key, so writes can be extracted into typed facts.
- **`test_llm_credential`** — Check a provider key against the provider WITHOUT storing it and without touching the one already registered.
- **`delete_llm_credential`** — Remove this workspace's provider key.


## Sessions and spaces — `brain-workspace`

- **`create_session`** — Provision a session to attribute later writes to, so one conversation's memories can be told apart from another's.
- **`list_sessions`** — The sessions in this SPACE, newest activity first.
- **`delete_session`** — Retire a session.
- **`list_spaces`** — The spaces this credential can see, with when each was last active.
- **`create_space`** — Make sure THIS caller's space exists, and report its stats.
- **`delete_space`** — Erase THIS caller's whole workspace: every memory in it, and the entities, statements and relations derived from them.
- **`subscribe_events`** — Read what has changed in this workspace since a point in the feed.


## Query diagnostics — `brain-workspace`

- **`explain_query`** — Show the plan Brain WOULD use for a query and what it expects that to cost.
- **`trace_query`** — Run a query and report what each stage ACTUALLY cost.

