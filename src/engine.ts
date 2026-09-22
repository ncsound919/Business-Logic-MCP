/**
 * Deterministic business-logic engine: validation, search, contracts, and
 * codegen. Pure functions over a BusinessLogicStore — no I/O, no LLM, no
 * network. These power the "verify before you generate" tools on the MCP:
 *
 *   - validateTransition: is this state change legal? returns the matching
 *     transition (condition + side effects) or the allowed targets.
 *   - validatePayload: field-level checks against the entity's declared types
 *     (required, enum membership, deprecated writes, float-for-money footgun).
 *   - checkPlanFootguns: keyword-based scan of a free-text plan/code against
 *     known footguns. Honest heuristic — it reports *matches*, never a verdict.
 *   - entityContract / schemaForEntity: one-call contract views and JSON Schema
 *     so a planner can generate matching code without extra round-trips.
 *   - generateTransitionGuard: emits deterministic TS that enforces the state
 *     machine at runtime (a real artifact, not a stub).
 *   - searchStore: substring search across the whole store.
 */

import type {
  BusinessLogicStore,
  EntityDef,
  FieldDef,
  Transition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

export interface TransitionCheck {
  valid: boolean;
  entity_field: string;
  from: string;
  to: string;
  transition?: Transition;
  allowed_targets?: string[];
  reason?: string;
}

export function findTransition(
  store: BusinessLogicStore,
  entityField: string,
  from: string,
  to: string,
): TransitionCheck {
  const sm = store.state_machines[entityField];
  if (!sm) {
    return { valid: false, entity_field: entityField, from, to, reason: "state machine not found" };
  }
  const transition = sm.transitions.find((t) => t.from === from && t.to === to);
  if (!transition) {
    const allowed = sm.transitions
      .filter((t) => t.from === from)
      .map((t) => t.to);
    return {
      valid: false,
      entity_field: entityField,
      from,
      to,
      allowed_targets: allowed,
      reason: `'${from}' -> '${to}' is not a declared transition`,
    };
  }
  return { valid: true, entity_field: entityField, from, to, transition };
}

// ---------------------------------------------------------------------------
// Payload validation (deterministic, field-level)
// ---------------------------------------------------------------------------

export interface PayloadCheck {
  valid: boolean;
  entity: string;
  errors: string[];
  warnings: string[];
  notes: string[];
}

const MONEY_FIELD_RE = /amount|price|total|cost|fee|subtotal|balance/i;

function typeOf(field: FieldDef): string {
  return field.type.split("|")[0].trim().toLowerCase();
}

function isNullable(field: FieldDef): boolean {
  return /null/i.test(field.type);
}

function validateFieldValue(
  field: FieldDef,
  name: string,
  value: unknown,
  errors: string[],
  warnings: string[],
): void {
  const present = value !== undefined && value !== null;
  if (field.deprecated && present) {
    warnings.push(
      `'${name}' is deprecated${field.replacement ? `; use ${field.replacement} instead` : ""} — do not write it in new code`,
    );
  }
  if (!present) {
    if (!isNullable(field)) {
      errors.push(`'${name}' is required (type ${field.type})`);
    }
    return;
  }
  if (Array.isArray(field.values)) {
    if (!field.values.includes(String(value))) {
      errors.push(`'${name}' must be one of [${field.values.join(", ")}], got '${String(value)}'`);
    }
    return;
  }
  const t = typeOf(field);
  if (t === "string" || t === "text" || t === "uuid" || t === "timestamp" || t === "datetime") {
    if (typeof value !== "string") errors.push(`'${name}' must be a string, got ${typeof value}`);
  } else if (t === "number" || t === "integer") {
    if (typeof value !== "number") {
      errors.push(`'${name}' must be a number, got ${typeof value}`);
    } else if (t === "integer" && !Number.isInteger(value)) {
      errors.push(`'${name}' must be an integer`);
    } else if (MONEY_FIELD_RE.test(name) && !Number.isInteger(value)) {
      warnings.push(
        `'${name}' looks like a monetary field (${name}) — stored in cents as an integer, never a float`,
      );
    }
  } else if (t === "boolean" || t === "bool") {
    if (typeof value !== "boolean") errors.push(`'${name}' must be a boolean, got ${typeof value}`);
  } else {
    warnings.push(`'${name}' has untyped constraint '${field.type}' — no deterministic check possible`);
  }
}

export function validatePayload(
  store: BusinessLogicStore,
  entity: string,
  payload: Record<string, unknown>,
): PayloadCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const def = store.entities[entity];
  if (!def) {
    return { valid: false, entity, errors: [`entity '${entity}' not found`], warnings, notes };
  }
  const known = new Set(Object.keys(def.fields));
  for (const key of Object.keys(payload)) {
    if (!known.has(key)) {
      warnings.push(`'${key}' is not a declared field on '${entity}'`);
    }
  }
  for (const [name, field] of Object.entries(def.fields)) {
    validateFieldValue(field, name, payload[name], errors, warnings);
  }
  if (def.known_footguns.some((f) => /soft delete|deleted_at/i.test(f))) {
    notes.push("This entity is soft-deleted — any read/update must filter deleted_at IS NULL.");
  }
  return { valid: errors.length === 0, entity, errors, warnings, notes };
}

// ---------------------------------------------------------------------------
// Footgun scan (honest keyword heuristic)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "not", "but",
  "has", "have", "its", "all", "any", "can", "into", "than", "was", "were",
  "been", "will", "would", "should", "must", "never", "always", "only",
  "when", "once", "then", "them", "they", "your", "you", "our", "their",
]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
}

export interface FootgunMatch {
  footgun: string;
  match_tokens: string[];
  score: number;
}

export interface FootgunScan {
  query: string;
  entity?: string;
  matched: FootgunMatch[];
  none: boolean;
  caveat: string;
}

export function checkPlanFootguns(
  store: BusinessLogicStore,
  plan: string,
  entity?: string,
): FootgunScan {
  const planTokens = new Set(tokens(plan));
  const candidates: string[] = entity
    ? [
        ...(store.entities[entity]?.known_footguns ?? []),
        ...store.global_footguns,
      ]
    : [
        ...Object.values(store.entities).flatMap((e) => e.known_footguns),
        ...store.global_footguns,
      ];
  const matched: FootgunMatch[] = [];
  for (const footgun of candidates) {
    const ft = tokens(footgun);
    const overlap = ft.filter((t) => planTokens.has(t));
    if (overlap.length > 0) {
      matched.push({ footgun, match_tokens: overlap.slice(0, 6), score: overlap.length });
    }
  }
  matched.sort((a, b) => b.score - a.score);
  return {
    query: plan.slice(0, 2000),
    entity,
    matched: matched.slice(0, 10),
    none: matched.length === 0,
    caveat: "Keyword heuristic only — verify each match against the actual code before trusting it.",
  };
}

// ---------------------------------------------------------------------------
// Contracts & schemas
// ---------------------------------------------------------------------------

export function entityContract(store: BusinessLogicStore, entity: string) {
  const def = store.entities[entity];
  if (!def) return { found: false as const };
  const transitions = Object.entries(store.state_machines)
    .filter(([key]) => key.toLowerCase().startsWith(entity.toLowerCase() + "."))
    .map(([key, sm]) => ({
      field: key.split(".")[1],
      initial: sm.initial,
      transitions: sm.transitions,
    }));
  const effects = Object.entries(store.cross_system_effects)
    .filter(([key]) => key.toLowerCase().startsWith(entity.toLowerCase() + "."))
    .map(([key, val]) => ({ operation: key, ...val }));
  return {
    found: true as const,
    entity,
    description: def.description,
    fields: def.fields,
    rules: def.rules,
    side_effects: def.side_effects,
    footguns: def.known_footguns,
    state_machines: transitions,
    cross_system_effects: effects,
  };
}

function schemaType(field: FieldDef): Record<string, unknown> {
  if (Array.isArray(field.values)) {
    const out: Record<string, unknown> = { type: "string", enum: field.values };
    if (field.deprecated) out.deprecated = true;
    if (field.notes) out.description = field.notes;
    return out;
  }
  const t = typeOf(field);
  const inner: Record<string, unknown> =
    t === "number" || t === "integer" ? { type: "integer" }
      : t === "boolean" || t === "bool" ? { type: "boolean" }
      : t === "timestamp" || t === "datetime" ? { type: "string", format: "date-time" }
      : { type: "string" };
  const out: Record<string, unknown> = isNullable(field)
    ? { anyOf: [{ type: "null" }, inner] }
    : inner;
  if (field.deprecated) out.deprecated = true;
  if (field.notes) out.description = field.notes;
  return out;
}

export function schemaForEntity(store: BusinessLogicStore, entity: string) {
  const def = store.entities[entity];
  if (!def) return { found: false as const };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    properties[name] = schemaType(field);
    if (!isNullable(field)) required.push(name);
  }
  return {
    found: true as const,
    entity,
    $schema: "http://json-schema.org/draft-07/schema#",
    title: entity,
    type: "object",
    properties,
    required,
    description: def.description,
  };
}

// ---------------------------------------------------------------------------
// Transition-guard codegen (deterministic TS artifact)
// ---------------------------------------------------------------------------

export function generateTransitionGuard(
  store: BusinessLogicStore,
  entityField: string,
): { ok: boolean; code?: string; note?: string } {
  const sm = store.state_machines[entityField];
  if (!sm) {
    return { ok: false, note: `state machine '${entityField}' not found` };
  }
  const states = new Set<string>([sm.initial]);
  for (const t of sm.transitions) {
    states.add(t.from);
    states.add(t.to);
  }
  const stateList = [...states].sort();
  const union = stateList.map((s) => `'${s}'`).join(" | ");
  const entityPart = entityField.split(".")[0];
  const typeName = (entityPart.charAt(0).toUpperCase() + entityPart.slice(1)) + "Status";
  const allowedLines = stateList.map((s) => {
    const targets = sm.transitions.filter((t) => t.from === s).map((t) => t.to);
    return targets.length
      ? `  ${JSON.stringify(s)}: [${targets.map((t) => JSON.stringify(t)).join(", ")}],`
      : `  ${JSON.stringify(s)}: [],`;
  });
  const conditionLines = sm.transitions
    .map((t) => `  // ${t.from} -> ${t.to}: ${t.condition}`)
    .join("\n");
  const code = [
    `// Generated from state machine '${entityField}' — deterministic, edit the store, not this file.`,
    `export type ${typeName} = ${union};`,
    ``,
    `export const ${typeName}Transitions: Record<${typeName}, ${typeName}[]> = {`,
    ...allowedLines,
    `};`,
    ``,
    `export function can${typeName}(from: ${typeName}, to: ${typeName}): boolean {`,
    `  return ${typeName}Transitions[from]?.includes(to) ?? false;`,
    `}`,
    ``,
    `export function assert${typeName}(from: ${typeName}, to: ${typeName}): void {`,
    `  if (!can${typeName}(from, to)) {`,
    `    throw new Error(\`Illegal ${entityField} transition: \${from} -> \${to}\`);`,
    `  }`,
    `}`,
    ``,
    `// Conditions (review before relying on them):`,
    conditionLines,
  ].join("\n");
  return { ok: true, code: code + "\n", note: "Runtime transition guard; conditions are documentation only." };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
  section: string;
  key: string;
  snippet: string;
}

export function searchStore(
  store: BusinessLogicStore,
  query: string,
  limit = 40,
): { query: string; hits: SearchHit[]; count: number } {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const [entity, def] of Object.entries(store.entities)) {
    const hay = `${entity} ${def.description} ${def.rules.join(" ")} ${def.known_footguns.join(" ")}`.toLowerCase();
    if (hay.includes(q)) {
      hits.push({ section: "entity", key: entity, snippet: def.description });
    }
    for (const [field, fdef] of Object.entries(def.fields)) {
      const fhay = `${field} ${fdef.type} ${fdef.notes ?? ""} ${fdef.values?.join(" ") ?? ""}`.toLowerCase();
      if (fhay.includes(q)) {
        hits.push({ section: "field", key: `${entity}.${field}`, snippet: fdef.notes ?? fdef.type });
      }
    }
  }
  for (const [key, sm] of Object.entries(store.state_machines)) {
    const hay = `${key} ${sm.initial} ${sm.transitions.map((t) => `${t.from} ${t.to} ${t.condition}`).join(" ")}`.toLowerCase();
    if (hay.includes(q)) {
      hits.push({ section: "state_machine", key, snippet: `${sm.initial} initial` });
    }
  }
  for (const [key, eff] of Object.entries(store.cross_system_effects)) {
    if (`${key} ${eff.description} ${eff.do_not}`.toLowerCase().includes(q)) {
      hits.push({ section: "cross_system_effect", key, snippet: eff.description });
    }
  }
  for (const fg of store.global_footguns) {
    if (fg.toLowerCase().includes(q)) {
      hits.push({ section: "global_footgun", key: fg.slice(0, 60), snippet: fg });
    }
  }
  return { query, hits: hits.slice(0, limit), count: hits.length };
}