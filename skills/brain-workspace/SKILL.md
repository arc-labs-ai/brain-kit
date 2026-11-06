---
name: brain-workspace
description: Identity, sessions, spaces and query diagnostics for the Brain memory database. Use when a recall comes back empty and the workspace is in doubt, when the user asks which account or namespace is connected, when attributing writes to a session, when checking whether an LLM provider key is configured, or when a query is slow or returning something surprising and the plan or stage costs would explain it. Triggers on "which workspace", "wrong namespace", "why is this empty", "what did that cost", "why did recall return that", "provider key", "session", "space". Part of the Brain memory database; see brain-memory for the core store and recall loop.
---

# Brain workspace

What to reach for when the memory tools are connected but not behaving — and
the tools for attributing writes and reading what a query actually did.

## An empty recall is usually the wrong workspace

A key is bound to one **namespace** and one **space**. A recall against the
wrong one returns `none`, which is indistinguishable from "nothing is stored"
unless you check.

1. `whoami` — the namespace and space this connection runs as. **First stop
   whenever a recall is unexpectedly empty.**
2. `list_spaces` — the spaces this credential can see, with when each was
   last active. A space with recent activity that is not the one `whoami`
   reports is the likely answer.

## What this deployment can do

- `capabilities` — limits, enabled extractor tiers, what this deployment
  supports. Check before assuming a feature exists.
- `llm_credential_status` — whether this workspace has an LLM provider key,
  and which provider. Extraction depends on it; without one, `remember`
  stores prose and draws few facts from it.
- `verify_llm_credential` — re-checks the key by asking the provider. Use
  when extraction has stopped working and the key is the suspect.

## Sessions

A session attributes later writes, so one run's memories can be told from
another's.

| | |
|---|---|
| `create_session` | provision one to attribute writes to |
| `list_sessions` | sessions in this workspace, newest activity first |
| `delete_session` | retire one — soft by default, leaving its memories |

Create a session when a long or automated run should be separable afterwards.
A normal conversation needs none.

## Why a query did that

- `explain_query` — the plan Brain **would** use, and what it expects to cost.
  No execution.
- `trace_query` — runs it and reports what each stage **actually** cost.

Use `explain_query` when a query returns something surprising and you want to
know which stage decided it. Use `trace_query` when it is slow and you need
the stage that is responsible. Note that `trace_query` executes — it is not
free, and it is not a dry run.

## Standing instructions

`materialize_directives` renders this workspace's stored directives — the
standing instructions it holds. Read them when behaviour should be shaped by
what the user has told Brain to always do, rather than by what you can recall
about a single question.
