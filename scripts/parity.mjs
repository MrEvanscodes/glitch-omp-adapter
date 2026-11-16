// Parity check: the same probes through (A) Glitch's hook commands run exactly as Claude Code runs them
// (Claude-shaped stdin, CLAUDE_PROJECT_DIR, exit 2 / permissionDecision) and (B) this add-on's omp
// handlers. Prints the versions it ran against, one row per probe, and exits non-zero on any difference.
// Default target is ~/Glitch-sandbox (guards write small state files where they run); set GLITCH_ROOT
// to use another spare copy. Nothing is written by the probes themselves: only verdicts are asked for.
// Run: npm run parity
process.env.GLITCH_OMP_LOG = process.env.GLITCH_OMP_LOG || "/dev/null";
process.env.GLITCH_OMP_TRUST_FILE = `/private/tmp/glitch-omp-no-trust-list-${process.pid}.json`;
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import glitch, { findGlitchRoot } from "../src/glitch.ts";

const ROOT = findGlitchRoot(process.env.GLITCH_ROOT || path.join(os.homedir(), "Glitch-sandbox"));
if (!ROOT) {
  console.error("No Glitch folder: copy your Glitch folder to ~/Glitch-sandbox or set GLITCH_ROOT to a spare copy.");
  process.exit(2);
}
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
  } catch {
    return "unknown";
  }
};

console.log("Glitch for omp: parity check (Claude Code hook semantics vs this add-on)\n");
console.log(`  glitch   ${ROOT} @ ${run("git", ["-C", ROOT, "log", "-1", "--format=%h %cs"])}`);
console.log(`  adapter  ${run("git", ["-C", here, "log", "-1", "--format=%h %cs"])}${run("git", ["-C", here, "status", "--porcelain"]) ? " (uncommitted changes)" : ""}`);
console.log(`  omp      ${run("omp", ["--version"])}`);
console.log(`  tern     ${run("tern", ["--version"])}`);
console.log(`  node     ${process.version}   ${run("uv", ["--version"])}\n`);

const settings = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
let n = 0;
const sid = (side) => `parity-${side}-${process.pid}-${++n}`;
const sessionIds = [];

// (A) Claude Code semantics: every matching command for the event, in order; any deny wins over ask.
function claude(event, tool, input, extra = {}) {
  const entries = (settings.hooks?.[event] ?? []).filter((e) => {
    const m = (e.matcher ?? "").trim();
    return !m || m === "*" || new RegExp(`^(?:${m})$`).test(tool);
  });
  const id = sid("claude");
  sessionIds.push(id);
  let verdict = "allow";
  let note = false;
  for (const e of entries)
    for (const h of e.hooks ?? []) {
      const r = spawnSync(h.command, {
        shell: true,
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
        input: JSON.stringify({ session_id: id, transcript_path: "", cwd: ROOT, permission_mode: "default", hook_event_name: event, tool_name: tool, tool_input: input, ...extra }),
      });
      if (r.status === 2) {
        verdict = "deny";
        continue;
      }
      let out = null;
      try {
        out = JSON.parse(r.stdout);
      } catch {
        /* plain text: no decision */
      }
      const d = out?.hookSpecificOutput?.permissionDecision;
      if (d === "deny") verdict = "deny";
      else if (d === "ask" && verdict !== "deny") verdict = "ask";
      if (out?.hookSpecificOutput?.additionalContext || out?.systemMessage) note = true;
    }
  return { verdict, note };
}

// (B) omp: this add-on's handlers, called the way omp calls them. A confirm dialog that opens means "ask".
function ompSession() {
  const h = {};
  glitch({ on: (k, f) => (h[k] = f), setLabel() {} });
  const id = sid("omp");
  sessionIds.push(id);
  const state = { asked: false };
  const ctx = {
    cwd: ROOT,
    hasUI: true,
    ui: { confirm: async () => ((state.asked = true), false) },
    sessionManager: { getSessionId: () => id, getSessionFile: () => "" },
  };
  h.session_start({}, ctx);
  return { h, ctx, state };
}
async function omp(tool, input) {
  const { h, ctx, state } = ompSession();
  const r = await h.tool_call({ toolName: tool, input, toolCallId: "parity" }, ctx);
  return state.asked ? "ask" : r?.block ? "deny" : "allow";
}

const at = (p) => path.join(ROOT, p);
const scratch = path.join(os.tmpdir(), "glitch-parity-probe.txt");
const sqlite = `python3 -c "import sqlite3; sqlite3.connect('.claude/data/memory.db')"`;
// [label, Claude tool, Claude input, omp tool, omp input]: same intent, each in its own tool's shape.
const probes = [
  ["Overwrite engine file AGENTS.md", "Write", { file_path: at("AGENTS.md"), content: "x" }, "write", { path: "AGENTS.md", content: "x" }],
  ["Edit engine hook write-guard.py", "Edit", { file_path: at(".claude/hooks/write-guard.py"), old_string: "a", new_string: "b" }, "edit", { path: ".claude/hooks/write-guard.py", paths: [".claude/hooks/write-guard.py"] }],
  ["Write a vault note", "Write", { file_path: at("glitch-mem/Memory/parity-probe.md"), content: "x" }, "write", { path: "glitch-mem/Memory/parity-probe.md", content: "x" }],
  ["Write in a workspace", "Write", { file_path: at("workspaces/parity-probe.txt"), content: "x" }, "write", { path: "workspaces/parity-probe.txt", content: "x" }],
  ["Write outside Glitch (tmp)", "Write", { file_path: scratch, content: "x" }, "write", { path: scratch, content: "x" }],
  ["Read outside Glitch (/etc/hosts)", "Read", { file_path: "/etc/hosts" }, "read", { path: "/etc/hosts" }],
  ["Read own USER.md", "Read", { file_path: at("glitch-mem/Memory/USER.md") }, "read", { path: "glitch-mem/Memory/USER.md" }],
  ["Grep outside Glitch (/etc)", "Grep", { pattern: "localhost", path: "/etc" }, "grep", { pattern: "localhost", path: "/etc" }],
  ["Glob outside Glitch (/etc)", "Glob", { pattern: "*", path: "/etc" }, "glob", { path: "/etc/*" }],
  ["bash: cd /tmp && ls", "Bash", { command: "cd /tmp && ls" }, "bash", { command: "cd /tmp && ls" }],
  ["bash: echo hello", "Bash", { command: "echo hello" }, "bash", { command: "echo hello" }],
  ["bash: git commit to brain history", "Bash", { command: "git commit -m probe" }, "bash", { command: "git commit -m probe" }],
  ["bash: chmod engine file", "Bash", { command: "chmod u+w AGENTS.md" }, "bash", { command: "chmod u+w AGENTS.md" }],
  ["bash: rm engine file", "Bash", { command: "rm .claude/hooks/write-guard.py" }, "bash", { command: "rm .claude/hooks/write-guard.py" }],
  ["bash: cat /etc/hosts", "Bash", { command: "cat /etc/hosts" }, "bash", { command: "cat /etc/hosts" }],
  ["bash: python -c opening memory DB", "Bash", { command: sqlite }, "bash", { command: sqlite }],
];

const rows = [];
for (const [label, ct, ci, ot, oi] of probes) {
  const c = claude("PreToolUse", ct, ci).verdict;
  rows.push({ label, claude: c, omp: await omp(ot, oi) });
}

// PostToolUse: a token-shaped string in command output, assembled at runtime.
const out = `token=ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}\n`;
const pc = claude("PostToolUse", "Bash", { command: "echo token" }, { tool_response: { stdout: out, stderr: "", interrupted: false, isError: false } });
const { h, ctx } = ompSession();
const pr = await h.tool_result({ toolName: "bash", input: { command: "echo token" }, content: [{ type: "text", text: out }], toolCallId: "parity" }, ctx);
rows.push({ label: "PostToolUse: secret in bash output", claude: pc.note ? "warns" : "silent", omp: pr?.additionalContext ? "warns" : "silent" });

// Leave no trace: the read guard keeps a per-session stub for every probe session.
for (const id of sessionIds) fs.rmSync(path.join(ROOT, ".claude", "data", "state", `read-once.${id}.json`), { force: true });

const w = Math.max(...rows.map((r) => r.label.length));
console.log(`  ${"probe".padEnd(w)}  claude  omp     parity`);
for (const r of rows) console.log(`  ${r.label.padEnd(w)}  ${r.claude.padEnd(6)}  ${r.omp.padEnd(6)}  ${r.claude === r.omp ? "MATCH" : "DIFF"}`);
const diff = rows.filter((r) => r.claude !== r.omp).length;
console.log(`\n${rows.length - diff}/${rows.length} identical verdicts${diff ? `: ${diff} DIFFER` : ""}`);
process.exit(diff ? 1 : 0);
