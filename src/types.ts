/**
 * Shared type definitions for the Business Logic MCP server.
 *
 * A store is the single source of truth for a project's domain knowledge:
 * entities, state machines, cross-system effects, and global footguns. It can
 * be shipped in code (the built-in demo store) or loaded at runtime from
 * JSON/YAML files (see src/store.ts).
 */

export interface FieldDef {
  type: string;
  values?: string[];
  notes?: string;
  deprecated?: boolean;
  replacement?: string;
}

export interface EntityDef {
  description: string;
  fields: Record<string, FieldDef>;
  rules: string[];
  side_effects: string[];
  known_footguns: string[];
}

export interface Transition {
  from: string;
  to: string;
  condition: string;
  side_effects: string[];
}

export interface StateMachine {
  initial: string;
  transitions: Transition[];
}

export interface AffectedSystem {
  system: string;
  action: string;
}

export interface CrossSystemEffect {
  description: string;
  affected_systems: AffectedSystem[];
  do_not: string;
}

export interface BusinessLogicStore {
  meta: {
    project: string;
    version: string;
    last_updated: string;
    owner: string;
  };
  entities: Record<string, EntityDef>;
  state_machines: Record<string, StateMachine>;
  cross_system_effects: Record<string, CrossSystemEffect>;
  global_footguns: string[];
}

// --- Feature 1: Dynamic Tool Registry ---
export interface MicroflowInput {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface MicroflowOutput {
  name: string;
  type: string;
  description: string;
}

export interface MicroflowDef {
  name: string;
  description: string;
  inputs: MicroflowInput[];
  outputs: MicroflowOutput[];
  steps: string[];
  tags: string[];
  owner?: string;
  async: boolean;
}

// --- Feature 2: Decision Tables (DMN) ---
export interface DecisionTableConditionValue {
  op: ">=" | "<=" | ">" | "<" | "!=";
  value: unknown;
}

export interface DecisionTableRow {
  id: string;
  conditions: Record<string, string | number | boolean | null | DecisionTableConditionValue>;
  outputs: Record<string, unknown>;
  priority?: number;
  annotation?: string;
}

export interface DecisionTable {
  id: string;
  description: string;
  hitPolicy: "UNIQUE" | "FIRST" | "COLLECT" | "RULE_ORDER";
  inputs: { name: string; type: string; description: string }[];
  outputs: { name: string; type: string; description: string }[];
  rows: DecisionTableRow[];
}

// --- Feature 3: UI Workflows ---
export interface UIAction {
  label: string;
  next: string;
  condition?: string;
  validation_rules: string[];
}

export interface UIField {
  name: string;
  type: string;
  required: boolean;
  label: string;
}

export interface UIStep {
  id: string;
  label: string;
  description: string;
  fields: UIField[];
  actions: UIAction[];
}

export interface UIWorkflow {
  id: string;
  description: string;
  initial: string;
  terminal_steps: string[];
  steps: Record<string, UIStep>;
}

// --- Feature 5: Governance & Security ---
export interface PermissionDef {
  entity: string;
  allowed_actions: string[];
  conditions?: string;
  denied_actions: string[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor_id: string;
  role: string;
  action: string;
  entity: string;
  entity_id: string;
  details: string;
}

// --- Feature 6: Logic Reuse (Rulesets) ---
export interface RulesetRule {
  id: string;
  condition: string;
  action: string;
  priority: number;
}

export interface Ruleset {
  id: string;
  description: string;
  version: string;
  rules: RulesetRule[];
  reuse_in: string[];
  tags: string[];
}

// --- Feature 7: Production Debugging ---
export interface ExecutionLogEntry {
  id: string;
  timestamp: string;
  tool: string;
  inputs: Record<string, unknown>;
  output_summary: string;
  duration_ms: number;
  shadow: boolean;
}

export interface ShadowTest {
  id: string;
  description: string;
  baseline_tool: string;
  candidate_tool: string;
  enabled: boolean;
  created_at: string;
}

// --- Feature 9: Hybrid Authoring (Rule Templates) ---
export interface RuleTemplateParam {
  name: string;
  type: string;
  description: string;
  example: string;
}

export interface RuleTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  parameters: RuleTemplateParam[];
  template_rule: string;
  example_output: string;
}

// --- Feature 10: Semantic Interoperability ---
export interface SemanticMapping {
  operational_term: string;
  analytical_term: string;
  description: string;
  entity?: string;
  field?: string;
  transformation?: string;
  examples?: string[];
}