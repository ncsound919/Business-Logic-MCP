# Business-Logic-MCP

Logic aid for software development — an MCP server that hands LLM coding agents
the business rules, state machines, field semantics, and known footguns of a
domain **before** they generate code, and then **validates** their work
deterministically (no LLM, no network).

## What it does

Two kinds of tools:

1. **Knowledge lookups** — the store (entities, fields, rules, side effects,
   state machines, cross-system effects, permissions, decision tables,
   microflows, rulesets, semantic mappings) exposed as 28 read tools.

2. **Deterministic verification + codegen** (Feature 11, zero LLM) — 9 tools that
   check and generate rather than just describe:

   | Tool | What it returns |
   | --- | --- |
   | `list_loaded_stores` | Which stores are loaded (built-in + external files), sources, load errors |
   | `list_state_machines` | All `entity.field` state machines with states and transition counts |
   | `validate_transition` | Legal/illegal check for a state change + condition, side effects, allowed targets |
   | `validate_payload` | Field-level validation: required, enum, type, deprecated writes, float-for-money footgun |
   | `get_entity_schema` | JSON Schema (draft-07) for an entity — enums, nullability, deprecation |
   | `get_entity_contract` | One-call combined view: fields + rules + effects + footguns + state machines |
   | `check_plan_footguns` | Keyword scan of a plan/code against known footguns (honest heuristic, never a verdict) |
   | `search_logic` | Substring search across the whole store |
   | `generate_transition_guard` | Deterministic TypeScript runtime guard (allowed-transition table + assert) |

## Serving more than one project

The built-in store is demo data. The server loads **external store files at
startup** so one binary serves any project's domain without a rebuild:

```bash
# Point at a directory of JSON/YAML store files
export BUSINESS_LOGIC_DIR=/path/to/domain-files

# Or a single file
export BUSINESS_LOGIC_FILE=/path/to/business-logic.yaml

# Optional: force a project name / serve external-only
export BUSINESS_LOGIC_PROJECT=my-product
export BUSINESS_LOGIC_OVERRIDE=1   # drop the demo store entirely
```

A store file is a partial `BusinessLogicStore`:

```yaml
meta:
  project: Acme
entities:
  Invoice:
    description: A billing record
    fields:
      status:
        type: enum
        values: [open, paid]
    rules: ["Invoices are immutable once paid"]
    side_effects: []
    known_footguns: ["Retain invoices for 10 years"]
state_machines:
  "Invoice.status":
    initial: open
    transitions:
      - { from: open, to: paid, condition: payment settles, side_effects: [] }
global_footguns:
  - "Never expose draft invoices"
```

External entities, state machines, and cross-system effects are keyed additions;
global footguns are appended; `meta` is shallow-merged. A bad file is reported
via `list_loaded_stores` (errors array) — it never kills the server.

## Quick start

```bash
npm install
npm run build        # tsc -> dist/
npm run start        # node dist/index.js (stdio)
npm run test         # node --test (22 deterministic tests)
node scripts/smoke.mjs   # live stdio smoke test with an external store
```

MCP client config:

```json
{
  "mcpServers": {
    "business-logic": {
      "command": "node",
      "args": ["path/to/Business-Logic-MCP/dist/index.js"],
      "env": { "BUSINESS_LOGIC_DIR": "/path/to/domain-files" }
    }
  }
}
```

## Honesty contract

The verification tools are deterministic and mechanical. `validate_payload` and
`validate_transition` are exact (they check against the store's declarations).
`check_plan_footguns` is explicitly a keyword heuristic and says so in its
output — it surfaces candidate footguns for the model to verify, it never
asserts a violation. No tool fabricates a pass.

## Layout

```
src/index.ts    MCP server entry: tool registry + dispatch (37 tools)
src/types.ts    Store type definitions (shared)
src/store.ts    External store loader (JSON/YAML, env-driven, merge + error reporting)
src/engine.ts   Deterministic validation / contract / schema / search / codegen
test/           node:test suite (engine + MCP tools + store loader)
scripts/        Live stdio smoke test
```

## License

MIT