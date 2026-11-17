// How many approval boxes does a member see, and in what order, when Glitch's guards and omp's own
// approval mode are both on? Drives real omp in RPC mode (`--mode rpc-ui`, which reports every dialog as
// an `extension_ui_request`), answers each box with "approve", and records them per command.
// Usage: GLITCH_ROOT=<spare Glitch copy> node scripts/box-count.mjs [model] [approval-mode]
// The Glitch copy must be trusted (GLITCH_OMP_TRUST_FILE may point at a list naming it).
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { findGlitchRoot } from "../src/glitch.ts";

const ROOT = findGlitchRoot(process.env.GLITCH_ROOT || path.join(os.homedir(), "Glitch-sandbox"));
if (!ROOT) {
  console.error("No Glitch folder: set GLITCH_ROOT to a spare Glitch copy.");
  process.exit(2);
}
const model = process.argv[2] || "anthropic/claude-opus-5-5";
const mode = process.argv[3] || "always-ask";

const probes = [
  ["Glitch pauses (asks): cat /etc/hosts", "Run exactly this one bash command once and nothing else: cat /etc/hosts"],
  ["Glitch allows: echo plain-ok", "Run exactly this one bash command once and nothing else: echo plain-ok"],
  ["Glitch refuses: cd /tmp && ls", "Run exactly this one bash command once and nothing else: cd /tmp && ls"],
  ["Glitch refuses: write AGENTS.md", "Use the write tool once to write the text probe to AGENTS.md. Nothing else."],
];

const omp = spawn("omp", ["--mode", "rpc-ui", "--no-session", "--approval-mode", mode, "--model", model, "--cwd", ROOT], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});
const send = (o) => omp.stdin.write(JSON.stringify(o) + "\n");
let boxes = [];
let ran = [];
let settle = null;

readline.createInterface({ input: omp.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(ev.method)) {
    const text = [ev.title, ev.message].filter(Boolean).join(" | ").replace(/\s+/g, " ");
    const who = /^Glitch asks first/.test(ev.title ?? "") ? "Glitch" : ev.method === "select" ? "omp" : "other";
    boxes.push(`${who}: ${text.slice(0, 90)}`);
    if (ev.method === "confirm") send({ type: "extension_ui_response", id: ev.id, confirmed: true });
    else if (ev.method === "select") {
      const pick = (ev.options ?? []).find((o) => /^approve$/i.test(o)) ?? (ev.options ?? []).find((o) => /approve/i.test(o)) ?? ev.options?.[0];
      boxes[boxes.length - 1] += `  [options: ${(ev.options ?? []).join(" / ")}]`;
      send({ type: "extension_ui_response", id: ev.id, value: pick });
    } else send({ type: "extension_ui_response", id: ev.id, cancelled: true });
  }
  if (ev.type === "tool_execution_end") ran.push(`${ev.toolName}${ev.isError ? " (error)" : ""}`);
  if (ev.type === "agent_end" && ev.isTerminal !== false && settle) settle();
});

console.log(`Box count: omp ${mode}, model ${model}, Glitch at ${ROOT}\n`);
for (const [label, message] of probes) {
  boxes = [];
  ran = [];
  const done = new Promise((r) => (settle = r));
  send({ id: label, type: "prompt", message });
  await Promise.race([done, new Promise((r) => setTimeout(r, 180_000))]);
  console.log(`${label}\n  boxes: ${boxes.length}${boxes.map((b, i) => `\n    ${i + 1}. ${b}`).join("")}\n  tools finished: ${ran.join(", ") || "none"}\n`);
}
omp.kill();
process.exit(0);
