// End-to-end checks against a REAL Glitch folder, with Glitch's real hook scripts.
// Default target is ~/Glitch-sandbox so nothing touches your real brain; point GLITCH_ROOT
// elsewhere only on purpose. These tests write a little state (guard logs, one pending-queue
// file that they delete again) into the folder they run against.
// Run: npm run test:sandbox
process.env.GLITCH_OMP_LOG = process.env.GLITCH_OMP_LOG || "/dev/null"; // keep deliberate test failures out of the real log
process.env.GLITCH_OMP_TRUST_FILE = `/private/tmp/glitch-omp-no-trust-list-${process.pid}.json`; // never read the real trusted-folders list
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import glitch, { findGlitchRoot } from "../src/glitch.ts";

const ROOT = findGlitchRoot(process.env.GLITCH_ROOT || path.join(os.homedir(), "Glitch-sandbox"));
const skip = ROOT ? false : "no ~/Glitch-sandbox found: copy your Glitch folder to a spare place and set GLITCH_ROOT to it";

function session(id, file = "") {
  const h = {};
  glitch({ on: (n, f) => (h[n] = f), setLabel() {} });
  const ctx = { cwd: ROOT, hasUI: false, sessionManager: { getSessionId: () => id, getSessionFile: () => file } };
  h.session_start({}, ctx);
  const call = (toolName, input) => h.tool_call({ toolName, input, toolCallId: "t" }, ctx);
  return { h, ctx, call, prompt: (p) => h.before_agent_start({ prompt: p }, ctx) };
}
const uid = () => `adapter-test-${process.pid}-${Date.now()}`;

test("an existing engine file cannot be written", { skip }, async () => {
  const s = session(uid());
  const r = await s.call("write", { path: path.join(ROOT, "AGENTS.md"), content: "x" });
  assert.equal(r?.block, true);
  assert.match(r.reason, /engine/i);
});

test("a relative path is judged against the session folder, not the hook's own", { skip }, async () => {
  const s = session(uid());
  const r = await s.call("edit", { path: "CLAUDE.md", paths: ["CLAUDE.md"] });
  assert.equal(r?.block, true);
});

test("a folder-step command is refused and an ordinary one is not", { skip }, async () => {
  const s = session(uid());
  assert.equal((await s.call("bash", { command: "cd /tmp && ls" }))?.block, true);
  assert.equal(await s.call("bash", { command: "echo hello" }), undefined);
});

test("reading outside the folder: blocked, then one yes gives a one-time pass", { skip }, async () => {
  const s = session(uid());
  await s.prompt("please read /etc/hosts");
  assert.equal((await s.call("read", { path: "/etc/hosts" }))?.block, true);
  const said = await s.prompt("yes");
  assert.match(said.message.content, /one-time pass/);
  assert.equal(await s.call("read", { path: "/etc/hosts" }), undefined);
});

test("the first prompt carries persona and memory", { skip }, async () => {
  const s = session(uid());
  const r = await s.prompt("hello");
  assert.equal(r.message.customType, "glitch-context");
  assert.match(r.message.content, /Who you are working with/);
  assert.ok(r.message.content.length > 5000);
});

test("ending a real-length omp conversation stages it into Glitch's memory queue", { skip }, async () => {
  const id = uid();
  const file = path.join(os.tmpdir(), `${id}.jsonl`);
  const turns = [];
  for (let i = 0; i < 6; i++) {
    turns.push({
      type: "message",
      id: `m${i}`,
      parentId: i ? `m${i - 1}` : null,
      message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `turn ${i}: we agreed the project is called Kiln Notes` }] },
    });
  }
  fs.writeFileSync(file, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
  const s = session(id, file);
  await s.h.session_before_shutdown({}, s.ctx);
  const pending = path.join(ROOT, ".claude", "data", "state", "pending");
  const staged = fs.readdirSync(pending).filter((f) => f.includes(id));
  try {
    assert.equal(staged.length, 1);
  } finally {
    for (const f of staged) fs.rmSync(path.join(pending, f), { force: true });
    fs.rmSync(file, { force: true });
  }
});
