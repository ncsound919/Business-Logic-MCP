import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStores } from "../dist/store.js";

const builtin = {
  meta: { project: "Builtin", version: "0.1.0", last_updated: "2026-01-01", owner: "builtin" },
  entities: { BuiltinEntity: { description: "d", fields: {}, rules: [], side_effects: [], known_footguns: [] } },
  state_machines: {},
  cross_system_effects: {},
  global_footguns: ["builtin footgun"],
};

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "blmcp-"));
  return dir;
}

test("no env: built-in store only, no sources", () => {
  const prevDir = process.env.BUSINESS_LOGIC_DIR;
  const prevFile = process.env.BUSINESS_LOGIC_FILE;
  delete process.env.BUSINESS_LOGIC_DIR;
  delete process.env.BUSINESS_LOGIC_FILE;
  try {
    const loaded = loadStores(builtin);
    assert.deepEqual(loaded.sources, []);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.store.entities.BuiltinEntity.description, "d");
  } finally {
    if (prevDir !== undefined) process.env.BUSINESS_LOGIC_DIR = prevDir;
    if (prevFile !== undefined) process.env.BUSINESS_LOGIC_FILE = prevFile;
  }
});

test("loads YAML store, merges entities/state_machines/footguns, reports bad file", () => {
  const dir = fixtureDir();
  const prev = process.env.BUSINESS_LOGIC_DIR;
  try {
    writeFileSync(
      join(dir, "business-logic.yaml"),
      [
        "meta:",
        "  project: Acme",
        "entities:",
        "  Invoice:",
        "    description: A billing record",
        "    fields:",
        "      status:",
        "        type: enum",
        "        values: [open, paid]",
        "    rules: [Invoices are immutable once paid]",
        "    side_effects: []",
        "    known_footguns: [Retain invoices 10 years]",
        "state_machines:",
        "  'Invoice.status':",
        "    initial: open",
        "    transitions:",
        "      - from: open",
        "        to: paid",
        "        condition: payment settles",
        "        side_effects: []",
        "global_footguns:",
        "  - Never expose draft invoices",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(dir, "bad.json"), "{ not json", "utf-8");
    process.env.BUSINESS_LOGIC_DIR = dir;

    const loaded = loadStores(builtin);
    assert.equal(loaded.sources.length, 1);
    assert.ok(loaded.sources[0].endsWith("business-logic.yaml"));
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0], /bad\.json/);
    // built-in + external merged
    assert.equal(loaded.store.entities.Invoice.rules[0], "Invoices are immutable once paid");
    assert.equal(loaded.store.entities.BuiltinEntity.description, "d");
    assert.equal(loaded.store.state_machines["Invoice.status"].initial, "open");
    assert.ok(loaded.store.global_footguns.includes("Never expose draft invoices"));
    // project name from external meta
    assert.equal(loaded.store.meta.project, "Acme");
  } finally {
    if (prev !== undefined) process.env.BUSINESS_LOGIC_DIR = prev;
    else delete process.env.BUSINESS_LOGIC_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BUSINESS_LOGIC_OVERRIDE=1 serves only external stores", () => {
  const dir = fixtureDir();
  const prevDir = process.env.BUSINESS_LOGIC_DIR;
  const prevOv = process.env.BUSINESS_LOGIC_OVERRIDE;
  try {
    writeFileSync(
      join(dir, "store.json"),
      JSON.stringify({
        entities: {
          Widget: { description: "w", fields: {}, rules: [], side_effects: [], known_footguns: [] },
        },
      }),
      "utf-8",
    );
    process.env.BUSINESS_LOGIC_DIR = dir;
    process.env.BUSINESS_LOGIC_OVERRIDE = "1";
    const loaded = loadStores(builtin);
    assert.equal(loaded.store.entities.Widget.description, "w");
    assert.equal(loaded.store.entities.BuiltinEntity, undefined);
    assert.deepEqual(loaded.store.global_footguns, []);
  } finally {
    if (prevDir !== undefined) process.env.BUSINESS_LOGIC_DIR = prevDir;
    else delete process.env.BUSINESS_LOGIC_DIR;
    if (prevOv !== undefined) process.env.BUSINESS_LOGIC_OVERRIDE = prevOv;
    else delete process.env.BUSINESS_LOGIC_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BUSINESS_LOGIC_PROJECT overrides project name", () => {
  const prev = process.env.BUSINESS_LOGIC_PROJECT;
  try {
    process.env.BUSINESS_LOGIC_PROJECT = "MyOverride";
    const loaded = loadStores(builtin);
    assert.equal(loaded.store.meta.project, "MyOverride");
  } finally {
    if (prev !== undefined) process.env.BUSINESS_LOGIC_PROJECT = prev;
    else delete process.env.BUSINESS_LOGIC_PROJECT;
  }
});