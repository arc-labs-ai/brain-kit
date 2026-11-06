# Every Brain tool, by job

**Generated** by `scripts/build-tool-index.py` from the server's own
`registerTool` calls. Do not hand-edit.

This is for deciding **whether a capability exists**, not for learning how to
use one. Each group names the skill that explains the work it belongs to, and
that skill is where the judgement lives.


**49 tools.**


## Store and retrieve — `brain-memory`

- **`remember`** — Store a fact, event, or conversation turn.
- **`recall`** — Retrieve the current, consistent truth against a query.
- **`forget`** — Delete a specific memory.
- **`list_memories`** — Page through what is stored, newest first.
- **`inspect_memory`** — Everything behind one memory: the typed facts extracted from it, its provenance, how it scored, and `edges` — the links to and from other memories, including any you asserted with `link`.
- **`materialize_directives`** — Render this workspace's stored directives — the standing instructions it has learned — into a block ready to drop into a system prompt.


## Reason over what is held — `brain-memory`

- **`plan`** — Find a route from a start state to a goal across what is known about the workspace.
- **`reason`** — Infer what follows from an observation, given what is already known in the workspace.


## Entities — `brain-entities`

- **`create_entity`** — Declare an entity of a known type.
- **`list_entities`** — Entities of one type.
- **`resolve_entity`** — Map a surface form ('the Acme account', 'Priya') to the entity it refers to, or report no match.
- **`get_entity`** — One entity by id, with its canonical name, type and attributes.
- **`traverse_entity`** — Walk outward from an entity along its relations.
- **`entity_relations`** — The relations attached to one entity, without walking further out.
- **`update_entity`** — Replace an entity's name, aliases and attributes WHOLESALE.
- **`rename_entity`** — Give an entity a new canonical name, keeping the old one as an alias.
- **`merge_entities`** — Fold one entity into another when both describe the same thing.
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
- **`supersede_statement`** — Replace a claim with a corrected one, keeping both and the link between them.
- **`delete_statement`** — Soft-tombstone a claim.
- **`retract_statement`** — Retract a claim so its CONTENT does not survive — the stronger form of delete_statement, for something that should never have been recorded.
- **`create_relation`** — Assert a typed edge between two entities.
- **`supersede_relation`** — Replace an edge with a corrected one, keeping the chain.
- **`delete_relation`** — Tombstone a typed edge.


## Schema — `brain-schema`

- **`get_schema`** — The entity and relation types declared for this workspace.
- **`validate_schema`** — Check a schema document without storing it.
- **`upload_schema`** — Merge new declarations into the workspace schema.
- **`list_schema_versions`** — Page through the schema's version history.
- **`list_extractors`** — The extractors registered for this workspace — what will read a new memory and what it is allowed to produce.
- **`drop_schema_type`** — Remove one declared predicate or relation type.


## Identity and capability — `brain-workspace`

- **`whoami`** — Report the identity this connection runs as — the namespace and space your API key resolves to on the server.
- **`capabilities`** — What this deployment supports — limits, enabled extractor tiers, protocol version.
- **`llm_credential_status`** — Whether this workspace has an LLM provider key, and which provider and model it is for.
- **`verify_llm_credential`** — Re-check the provider key this workspace already has, by asking the provider.


## Sessions and spaces — `brain-workspace`

- **`create_session`** — Provision a session to attribute later writes to, so one conversation's memories can be told apart from another's.
- **`list_sessions`** — The sessions in this workspace, newest activity first.
- **`delete_session`** — Retire a session.
- **`list_spaces`** — The spaces this credential can see, with when each was last active.


## Query diagnostics — `brain-workspace`

- **`explain_query`** — Show the plan Brain would use for a query, and what it expects that to cost — without running it.
- **`trace_query`** — Run a query and report what each stage actually cost.

