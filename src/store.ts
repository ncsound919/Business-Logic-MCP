/**
 * Runtime store loading for the Business Logic MCP server.
 *
 * The built-in store (shipped in src/index.ts) is the fallback. When
 * BUSINESS_LOGIC_DIR (a directory) or BUSINESS_LOGIC_FILE (a single file) is
 * set, every *.json / *.yaml / *.yml file there is parsed and merged on top of
 * the built-in store so one server can serve many projects without a rebuild:
 *
 *   - entities, state_machines, cross_system_effects are keyed additions
 *     (external wins on collision);
 *   - global_footguns are appended;
 *   - meta is shallow-merged (BUSINESS_LOGIC_PROJECT overrides the project name).
 *
 * Set BUSINESS_LOGIC_OVERRIDE=1 to start from an *empty* store and only serve
 * the external files (no demo entities leaked into a production project).
 *
 * Errors are collected, not thrown: a bad file never kills the server — it is
 * reported via list_loaded_stores so the operator can fix it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import YAML from "yaml";
import type {
  BusinessLogicStore,
  CrossSystemEffect,
  EntityDef,
  StateMachine,
} from "./types.js";

export interface LoadedStore {
  store: BusinessLogicStore;
  sources: string[];
  errors: string[];
}

const EXT_RE = /\.(json|ya?ml)$/i;

function collectFiles(): { files: string[]; errors: string[] } {
  const files: string[] = [];
  const errors: string[] = [];
  const single = process.env.BUSINESS_LOGIC_FILE;
  if (single) {
    files.push(single);
  }
  const dir = process.env.BUSINESS_LOGIC_DIR;
  if (dir) {
    const abs = resolve(dir);
    try {
      for (const name of readdirSync(abs)) {
        if (EXT_RE.test(name)) files.push(join(abs, name));
      }
    } catch (err) {
      errors.push(`BUSINESS_LOGIC_DIR unreadable: ${abs} (${(err as Error).message})`);
    }
  }
  return { files, errors };
}

function parseFile(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf-8");
  if (extname(path).toLowerCase() === ".json") {
    return JSON.parse(raw) as Record<string, unknown>;
  }
  return YAML.parse(raw) as Record<string, unknown>;
}

export function loadStores(builtin: BusinessLogicStore): LoadedStore {
  const { files, errors } = collectFiles();
  const override = process.env.BUSINESS_LOGIC_OVERRIDE === "1";

  const merged: BusinessLogicStore = override
    ? {
        meta: { ...builtin.meta },
        entities: {},
        state_machines: {},
        cross_system_effects: {},
        global_footguns: [],
      }
    : {
        meta: { ...builtin.meta },
        entities: { ...builtin.entities },
        state_machines: { ...builtin.state_machines },
        cross_system_effects: { ...builtin.cross_system_effects },
        global_footguns: [...builtin.global_footguns],
      };

  const sources: string[] = [];
  const sorted = [...files].sort();
  for (const file of sorted) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseFile(file);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      errors.push(`${file}: not a valid object`);
      continue;
    }
    sources.push(file);
    const ext = parsed as Partial<BusinessLogicStore>;
    if (ext.meta && typeof ext.meta === "object") {
      merged.meta = { ...merged.meta, ...ext.meta };
    }
    if (ext.entities && typeof ext.entities === "object") {
      for (const [k, v] of Object.entries(ext.entities)) {
        merged.entities[k] = v as EntityDef;
      }
    }
    if (ext.state_machines && typeof ext.state_machines === "object") {
      for (const [k, v] of Object.entries(ext.state_machines)) {
        merged.state_machines[k] = v as StateMachine;
      }
    }
    if (ext.cross_system_effects && typeof ext.cross_system_effects === "object") {
      for (const [k, v] of Object.entries(ext.cross_system_effects)) {
        merged.cross_system_effects[k] = v as CrossSystemEffect;
      }
    }
    if (Array.isArray(ext.global_footguns)) {
      merged.global_footguns.push(...(ext.global_footguns as string[]));
    }
  }

  const project = process.env.BUSINESS_LOGIC_PROJECT;
  if (project) {
    merged.meta.project = project;
  }

  return { store: merged, sources, errors };
}