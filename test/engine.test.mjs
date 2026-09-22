import test from "node:test";
import assert from "node:assert/strict";

import {
  findTransition,
  validatePayload,
  checkPlanFootguns,
  entityContract,
  schemaForEntity,
  generateTransitionGuard,
  searchStore,
} from "../dist/engine.js";
import { callTool } from "../dist/index.js";

const store = {
  meta: { project: "TestApp", version: "1.0.0", last_updated: "2026-01-01", owner: "t" },
  entities: {
    Order: {
      description: "A purchase",
      fields: {
        status: { type: "enum", values: ["draft", "pending", "confirmed", "cancelled"] },
        total_amount: { type: "number", notes: "cents, integer" },
        promo: { type: "string | null", deprecated: true, replacement: "discount_ids" },
        email: { type: "string" },
      },
      rules: ["No float money"],
      side_effects: ["Emit order.status_changed"],
      known_footguns: ["Use order_events audit table, not updated_at", "Soft deletes always filter deleted_at"],
    },
  },
  state_machines: {
    "Order.status": {
      initial: "draft",
      transitions: [
        { from: "draft", to: "pending", condition: "payment attached", side_effects: ["reserve"] },
        { from: "pending", to: "confirmed", condition: "captured", side_effects: ["sync ERP"] },
        { from: "draft", to: "cancelled", condition: "user cancels", side_effects: [] },
      ],
    },
  },
  cross_system_effects: {
    "order.cancelled": { description: "cancel flow", affected_systems: [], do_not: "x" },
  },
  global_footguns: [
    "Monetary values are stored in cents as integers — never use floats for money.",
    "Timestamps are stored in UTC.",
  ],
};

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

test("findTransition: legal and illegal", () => {
  const ok = findTransition(store, "Order.status", "draft", "pending");
  assert.equal(ok.valid, true);
  assert.equal(ok.transition.condition, "payment attached");

  const bad = findTransition(store, "Order.status", "draft", "confirmed");
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.allowed_targets, ["pending", "cancelled"]);

  const missing = findTransition(store, "Nope.status", "a", "b");
  assert.equal(missing.valid, false);
  assert.match(missing.reason, /not found/);
});

test("validatePayload: required, enum, deprecated, money footgun", () => {
  const ok = validatePayload(store, "Order", { status: "draft", total_amount: 100, email: "a@b.c" });
  assert.equal(ok.valid, true);

  const missing = validatePayload(store, "Order", { status: "draft" });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.includes("email")));

  const badEnum = validatePayload(store, "Order", { status: "onfire", email: "a@b.c" });
  assert.equal(badEnum.valid, false);
  assert.ok(badEnum.errors.some((e) => e.includes("must be one of")));

  const float = validatePayload(store, "Order", { status: "draft", total_amount: 9.99, email: "a@b.c" });
  assert.equal(float.valid, true);
  assert.ok(float.warnings.some((w) => w.includes("never a float")));

  const deprecated = validatePayload(store, "Order", { email: "a@b.c", promo: "x" });
  assert.ok(deprecated.warnings.some((w) => w.includes("deprecated")));

  const unknown = validatePayload(store, "Order", { email: "a@b.c", bogus: 1 });
  assert.ok(unknown.warnings.some((w) => w.includes("not a declared field")));
});

test("validatePayload: unknown entity", () => {
  const r = validatePayload(store, "Ghost", {});
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /not found/);
});

test("checkPlanFootguns: keyword matches + honest none", () => {
  const hit = checkPlanFootguns(store, "select * from orders order by updated_at");
  assert.equal(hit.none, false);
  assert.ok(hit.matched.some((m) => m.footgun.includes("audit table")));
  assert.match(hit.caveat, /heuristic/);

  const scoped = checkPlanFootguns(store, "reserve inventory then set status to confirmed", "Order");
  assert.equal(scoped.entity, "Order");

  const none = checkPlanFootguns(store, "the quick brown fox jumps");
  assert.equal(none.none, true);
  assert.deepEqual(none.matched, []);
});

test("schemaForEntity: JSON schema with enum, required, deprecation", () => {
  const s = schemaForEntity(store, "Order");
  assert.equal(s.found, true);
  assert.deepEqual(s.properties.status, { type: "string", enum: ["draft", "pending", "confirmed", "cancelled"] });
  assert.deepEqual(s.required.sort(), ["email", "status", "total_amount"]);
  assert.equal(s.properties.promo.deprecated, true);
});

test("entityContract: bundles transitions + cross-system", () => {
  const c = entityContract(store, "Order");
  assert.equal(c.found, true);
  assert.equal(c.state_machines.length, 1);
  assert.equal(c.cross_system_effects[0].operation, "order.cancelled");
  assert.equal(c.footguns.length, 2);
});

test("generateTransitionGuard: emits TS guard", () => {
  const r = generateTransitionGuard(store, "Order.status");
  assert.equal(r.ok, true);
  assert.match(r.code, /can\w+\(from: \w+, to: \w+\): boolean/);
  assert.match(r.code, /Illegal Order\.status transition/);
  assert.match(r.code, /payment attached/);
});

test("searchStore: substring hits across sections", () => {
  const r = searchStore(store, "floats");
  assert.equal(r.count >= 1, true);
  assert.ok(r.hits.some((h) => h.section === "global_footgun"));
  const fieldHit = searchStore(store, "total_amount");
  assert.ok(fieldHit.hits.some((h) => h.section === "field"));
});

// ---------------------------------------------------------------------------
// MCP tools (via callTool, merged store)
// ---------------------------------------------------------------------------

function text(result) {
  return JSON.parse(result.content[0].text);
}

test("callTool: validate_transition", async () => {
  // callTool uses the merged (built-in) store: Order.status allows draft -> pending only.
  const r = await callTool("validate_transition", { entity_field: "Order.status", from: "draft", to: "confirmed" });
  const parsed = text(r);
  assert.equal(parsed.valid, false);
  assert.ok(parsed.allowed_targets.includes("pending"));
  assert.ok(!parsed.allowed_targets.includes("confirmed"));

  const legal = await callTool("validate_transition", { entity_field: "Order.status", from: "draft", to: "pending" });
  assert.equal(text(legal).valid, true);
  assert.equal(text(legal).transition.from, "draft");
});

test("callTool: validate_payload", async () => {
  const r = await callTool("validate_payload", { entity: "Order", payload: { status: "bogus" } });
  assert.equal(text(r).valid, false);
});

test("callTool: get_entity_schema", async () => {
  const r = await callTool("get_entity_schema", { entity: "Order" });
  assert.equal(text(r).title, "Order");
});

test("callTool: get_entity_contract", async () => {
  const r = await callTool("get_entity_contract", { entity: "Order" });
  assert.ok(text(r).rules.length >= 0);
});

test("callTool: check_plan_footguns", async () => {
  const r = await callTool("check_plan_footguns", { plan: "query orders by updated_at" });
  assert.equal(text(r).none, false);
});

test("callTool: search_logic", async () => {
  const r = await callTool("search_logic", { query: "stripe" });
  assert.ok(typeof text(r).count === "number");
});

test("callTool: list_loaded_stores reports sources", async () => {
  const r = await callTool("list_loaded_stores", {});
  const parsed = text(r);
  assert.ok(parsed.project);
  assert.ok(Array.isArray(parsed.sources));
});

test("callTool: generate_transition_guard", async () => {
  const r = await callTool("generate_transition_guard", { entity_field: "Order.status" });
  assert.match(r.content[0].text, /Illegal Order\.status transition/);
});

test("callTool: unknown tool is an error", async () => {
  const r = await callTool("nope", {});
  assert.equal(r.isError, true);
});

test("callTool: list_state_machines", async () => {
  const r = await callTool("list_state_machines", {});
  const parsed = text(r);
  assert.ok(parsed.some((sm) => sm.entity_field === "Order.status"));
});