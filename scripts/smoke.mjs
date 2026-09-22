import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Live stdio smoke test: boots the real server with an external store loaded
// from BUSINESS_LOGIC_DIR and exercises the new deterministic tools end-to-end.
// Run: node scripts/smoke.mjs

const dir = mkdtempSync(join(tmpdir(), "blmcp-smoke-"));
writeFileSync(
  join(dir, "domain.yaml"),
  [
    "meta:",
    "  project: SmokeProject",
    "entities:",
    "  Widget:",
    "    description: A thing",
    "    fields:",
    "      status:",
    "        type: enum",
    "        values: [new, active, retired]",
    "    rules: [Widgets cannot be retired while active]",
    "    side_effects: []",
    "    known_footguns: [Widget status changes must go through the transition guard]",
    "state_machines:",
    "  'Widget.status':",
    "    initial: new",
    "    transitions:",
    "      - { from: new, to: active, condition: activation submitted, side_effects: [] }",
    "      - { from: active, to: retired, condition: archive approved, side_effects: [] }",
    "global_footguns:",
    "  - Never delete widgets, soft-delete only",
  ].join("\n"),
  "utf-8",
);

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: { ...process.env, BUSINESS_LOGIC_DIR: dir },
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let id = 0;
function send(method, params) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((resolve) => pending.set(mid, resolve));
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1" },
});
console.log("server name:", init.serverInfo.name, init.serverInfo.version);

const tools = await send("tools/list", {});
const names = tools.tools.map((t) => t.name);
const newTools = names.filter((n) =>
  ["list_loaded_stores", "validate_transition", "validate_payload", "get_entity_schema",
   "get_entity_contract", "check_plan_footguns", "search_logic", "generate_transition_guard",
   "list_state_machines"].includes(n),
);
console.log("total tools:", names.length, "| new tools present:", newTools.length, "->", newTools.join(", "));

const stores = await send("tools/call", { name: "list_loaded_stores", arguments: {} });
const storeText = JSON.parse(stores.content[0].text);
console.log("loaded stores -> project:", storeText.project, "| sources:", storeText.sources.length, "| merged entities:", storeText.merged_entities);

const trans = await send("tools/call", { name: "validate_transition", arguments: { entity_field: "Widget.status", from: "new", to: "retired" } });
const transText = JSON.parse(trans.content[0].text);
console.log("validate_transition new->retired valid:", transText.valid, "| allowed:", JSON.stringify(transText.allowed_targets));

const guard = await send("tools/call", { name: "generate_transition_guard", arguments: { entity_field: "Widget.status" } });
console.log("generate_transition_guard:\n" + guard.content[0].text.split("\n").slice(0, 12).join("\n"));

child.kill();
rmSync(dir, { recursive: true, force: true });
console.log("SMOKE OK");