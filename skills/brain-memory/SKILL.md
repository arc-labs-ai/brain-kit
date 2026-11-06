---
name: brain-memory
description: Durable memory across conversations, backed by the Brain memory database. Use when storing what the user told you (preferences, decisions, project facts, people and systems), recalling what was said before, correcting something that changed, or reasoning over what is already known. Triggers on "remember", "recall", "forget", "what do you know about me", "we decided", "from now on", "last time", and whenever a fact learned in this session would be useful in the next one. Also the entry point to Brain's wider surface — entities, statements, schema and workspace tools each have their own skill, mapped at the end of this one.
---

# Brain memory

Brain is a memory database reached through the `brain` MCP server. It is not a
note file: it extracts typed facts from what you store, supersedes the ones
that changed, and returns what is **currently true** rather than everything
ever written.

The server exposes **49 tools**. Most sessions need five of them. The rest
exist for work this skill names at the end — reach for them deliberately, not
by default.

## The loop

| | |
|---|---|
| `remember` | store a fact, decision or turn. Returns a memory id |
| `recall` | ask a question; get the current answer, not every match |
| `forget` | remove one memory by id |
| `list_memories` | page through what is stored, newest first |
| `inspect_memory` | everything behind one memory — the facts drawn from it |

## Store what will matter next time, not this time

`remember` costs a round trip and consumes the namespace. Store something when
a **future** session would be worse without it:

- preferences and standing instructions — "prefers pnpm", "always squash"
- decisions and their reasons — "chose Postgres over Dynamo for the join"
- facts about people, systems and projects that outlive the conversation
- corrections the user has had to make more than once

Do **not** store: anything you can re-derive from the repository, the contents
of a file you just read, your own intermediate reasoning, or a restatement of
what the user said one message ago.

**Never store a secret.** Keys, tokens, passwords and private URLs do not
belong in memory. If the user pastes one, use it and let it go.

## Recall before you assume

When a question touches preference, history or a prior decision, `recall`
first. The cost of one call is far below the cost of contradicting something
the user already told you.

Read the answer shape that comes back:

- `single` — one current answer. Use it.
- `multiple` — several things are true at once. Say so rather than picking.
- `none` — **a real answer.** Brain holds nothing. Say you do not know; do
  not fall back to a guess dressed as a memory.

Recall ranks by **similarity, not recency**. A stale claim can outrank a newer
one if it reads closer to the query. When the answer matters and looks old,
check `statement_history` (see `brain-knowledge`) rather than trusting rank.

## Correcting is storing, not deleting

When something changes, `remember` the new fact. Brain supersedes the old one
and keeps the chain, so "what is true now" and "what did we think before" both
stay answerable.

`forget` is for a memory that should never have been stored — wrong, private,
or noise. It is not the way to update a fact.

## Reasoning over what is held

Two tools ask Brain to work over its own store rather than pulling memories
into the transcript and reasoning there:

- `reason` — infer what follows from an observation, given what is known
- `plan` — find a route from a current state to a goal

Prefer these when the answer depends on many stored facts. Pulling fifty
memories into context to reason over them is the thing they exist to avoid.

## The id shapes differ, and mixing them fails quietly

- A **memory id** is a long decimal string — `inspect_memory`, `forget` and
  memory references in a statement take that.
- **Entity, statement and relation ids** are UUIDs.

Rendering a memory id as a UUID produces something that looks right and
resolves to nothing. Pass back exactly what the tool returned.

## The rest of the surface

Everything above is 8 of 49 tools. The other 41 are grouped by the job they
do, each with its own skill that loads only when that work comes up:

| when the work is | skill | tools |
|---|---|---|
| people, systems, projects as **typed objects** with relationships — "who is X", "how are X and Y connected", merging duplicates | `brain-entities` | 14 |
| a claim is **wrong, outdated or disputed**; where a fact came from; what changed and when | `brain-knowledge` | 11 |
| declaring the **types** this workspace uses, and what reads new writes | `brain-schema` | 6 |
| which workspace this is, why a recall came back empty, what a query cost, sessions and spaces | `brain-workspace` | 10 |

A full one-line index of all 49 is in
[references/tool-index.md](references/tool-index.md) — read it when you need
to know whether a capability exists at all.

## When the tools are not there

If the `brain` tools are missing, the server is not connected. **Do not
pretend to remember.** Say so, and give the one-line fix:

```
npx @brain-db/cli
```

That sets up every agent client on the machine. `npx @brain-db/cli doctor`
says what is wrong if it is already set up and still not working.
