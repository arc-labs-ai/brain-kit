# Changelog

## [0.1.1](https://github.com/arc-labs-ai/brain-kit/compare/v0.1.0...v0.1.1) (2026-11-06)


### Fixes

* **doctor:** report this package's real version to the server, not a literal ([0eb80d0](https://github.com/arc-labs-ai/brain-kit/commit/0eb80d0e92d6607a07523e3e368f300c560fd980))

## 0.1.0 (2026-11-06)


### ⚠ BREAKING CHANGES

* installs now write a remote MCP server by default. A machine set up by an earlier version keeps working, but re-running `connect` replaces its local stdio entry with a remote one. Pass `--self-host` for the old behaviour.

### Features

* brain-kit — one command to connect a machine to Brain ([7362e59](https://github.com/arc-labs-ai/brain-kit/commit/7362e5990c337f02b20b3d544a010aa0b4aa36c2))
* configure clients against the hosted MCP server, not a local one ([45377cd](https://github.com/arc-labs-ai/brain-kit/commit/45377cd216a572aa05a533df1b91f7aad5b32463))
* organise the skills around Brain's whole surface, not the core loop ([2db15f9](https://github.com/arc-labs-ai/brain-kit/commit/2db15f9cad21ff1a8fb48f89398e171e410b8b70))


### Fixes

* **build:** keep the bin executable when dist is regenerated ([64efaf2](https://github.com/arc-labs-ai/brain-kit/commit/64efaf27d81460a5c321fafba6ecae266750e8b5))
* production fixes for the CLI, found by running it against a live gateway ([9ab3e7c](https://github.com/arc-labs-ai/brain-kit/commit/9ab3e7cb844cf5db56de33e30b55367d5b11fcc6))
* restore docs/TIMERS.md ([8f29ca4](https://github.com/arc-labs-ai/brain-kit/commit/8f29ca4b964e6635f56a206b03d30f2155da5cf3))
* the Claude Code plugin path, which had never been run ([fab5d7e](https://github.com/arc-labs-ai/brain-kit/commit/fab5d7e0076e2672426bebfe7e036c064fcadb8a))


### Refactors

* organise plugins by client, one folder per vendor ([af1f34e](https://github.com/arc-labs-ai/brain-kit/commit/af1f34eb38cca381e43c1a3aa74ac859969257b5))


### CI

* release plumbing, and stop shipping a plugin the tarball cannot serve ([25dce18](https://github.com/arc-labs-ai/brain-kit/commit/25dce182b4a4089d4e62465de71aadcca669473f))
