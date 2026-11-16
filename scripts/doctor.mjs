// Is the Glitch add-on really active in omp on THIS machine? Run: npm run doctor [glitch-folder]
// Exits non-zero if anything that matters is wrong, so it can sit in a script.
// It only makes guard decisions (nothing is written or read except Glitch's own guard logs).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import glitch, { findGlitchRoot, loadHooks, trustFile, trustState } from "../src/glitch.ts";

process.env.GLITCH_OMP_LOG = "/dev/null"; // its probes are refusals on purpose: not real sessions
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extFile = path.join(here, "src", "glitch.ts");
let bad = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const note = (m) => console.log(`  note  ${m}`);
const fail = (m, fix) => {
  bad++;
  console.log(`  FAIL  ${m}${fix ? `\n          fix: ${fix}` : ""}`);
};
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

console.log("Glitch for omp: self-check\n");

// 1. omp present and pointed at this add-on
try {
  console.log(`  ok    omp ${sh("omp", ["--version"]).replace(/^omp\/?/, "")}`);
  const list = sh("omp", ["config", "get", "extensions"]);
  if (list.includes(extFile)) ok("omp is set to load this add-on");
  else fail("omp is NOT set to load this add-on", `omp config set extensions '["${extFile}"]'`);
} catch (e) {
  fail("omp is not installed or not on PATH", "make sure `omp --version` works in this terminal");
}

// 2. uv (Glitch's guards run on it; without it every guarded call is refused on purpose)
try {
  ok(`uv ${sh("uv", ["--version"]).split(" ")[1]}`);
} catch {
  fail("uv is not installed, so every guarded tool call would be refused", "brew install uv  (or https://docs.astral.sh/uv/)");
}

// 3. a Glitch folder, and its hook table
const target = process.argv[2] || path.join(os.homedir(), "Glitch");
const root = findGlitchRoot(target);
if (!root) {
  fail(`${target} is not a Glitch folder (needs CLAUDE.md and .claude/hooks/write-guard.py)`, "pass the folder: npm run doctor /path/to/Glitch");
} else {
  ok(`Glitch folder: ${root}`);
  const hooks = loadHooks(root);
  for (const ev of ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "PreCompact", "SessionEnd"]) {
    const n = hooks.filter((h) => h.event === ev).length;
    n ? ok(`${ev}: ${n} hook${n > 1 ? "s" : ""} found`) : fail(`${ev}: no hook found in Glitch's settings`);
  }

  // 3b. is this folder allowed to run its hooks? (the trusted-folders list the installer writes)
  const trust = trustState(root);
  if (trust === "trusted") ok(`this Glitch folder is on your trusted-folders list (${trustFile()})`);
  else if (trust === "no-list") note("no trusted-folders list yet, so the add-on runs in ANY Glitch-looking folder. Run scripts/install.py to add one.");
  else fail(`${root} is NOT on your trusted-folders list, so the add-on does nothing there`, `uv run --no-project python scripts/install.py trust "${root}"`);

  // 4. live guard decisions, through the same code omp runs
  if (trust !== "untrusted") {
  const h = {};
  glitch({ on: (n, f) => (h[n] = f), setLabel() {} });
  const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => `doctor-${process.pid}`, getSessionFile: () => "" } };
  const engine = fs.existsSync(path.join(root, "AGENTS.md")) ? "AGENTS.md" : "CLAUDE.md";
  const w = await h.tool_call({ toolName: "write", input: { path: engine, content: "x" }, toolCallId: "d1" }, ctx);
  w?.block ? ok(`guard refuses to overwrite ${engine} (relative path, as omp sends it)`) : fail(`guard did NOT refuse a write to ${engine}`, "run: npm run test:sandbox");
  const r = await h.tool_call({ toolName: "read", input: { path: "/etc/hosts" }, toolCallId: "d2" }, ctx);
  r?.block ? ok("guard asks before reading outside the Glitch folder") : fail("guard did NOT stop a read outside the Glitch folder");
  const c = await h.tool_call({ toolName: "bash", input: { command: "cd /tmp && ls" }, toolCallId: "d3" }, ctx);
  c?.block ? ok("guard refuses a folder-step command") : fail("guard did NOT refuse a folder-step command");
  const fine = await h.tool_call({ toolName: "bash", input: { command: "echo hello" }, toolCallId: "d4" }, ctx);
  fine === undefined ? ok("an ordinary command goes through") : fail(`an ordinary command was stopped: ${fine.reason?.slice(0, 120)}`);
  }
}

// Leave no trace: the guard keeps a tiny per-session stub for the fake session id used above.
if (root) {
  try {
    fs.rmSync(path.join(root, ".claude", "data", "state", `read-once.doctor-${process.pid}.json`), { force: true });
  } catch {
    /* harmless */
  }
}

console.log(bad ? `\n${bad} problem${bad > 1 ? "s" : ""}. Glitch is NOT fully protected in omp until these are fixed.` : "\nAll good: Glitch's guards, identity and memory are active in omp.");
process.exit(bad ? 1 : 0);
