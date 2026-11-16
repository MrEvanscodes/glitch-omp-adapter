// Logic tests. They need no omp and no real Glitch: a throwaway fake Glitch folder holds tiny hook
// scripts, so every branch (block, ask, fail-closed, timeout, context) is exercised on purpose.
// Run: node --test tests/
process.env.GLITCH_OMP_LOG = process.env.GLITCH_OMP_LOG || "/dev/null"; // keep deliberate test failures out of the real log
// Never read the real trusted-folders list: these tests make their own (or none).
process.env.GLITCH_OMP_TRUST_FILE = `/private/tmp/glitch-omp-no-trust-list-${process.pid}.json`;
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import glitch, { findGlitchRoot, localPath, loadHooks, translate } from "../src/glitch.ts";

function fakeRoot(hooks) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fake-glitch-")));
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# fake\n");
  fs.writeFileSync(path.join(root, ".claude", "hooks", "write-guard.py"), "# marker\n");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks }));
  return root;
}
const cmd = (s, timeout) => ({ type: "command", command: s, ...(timeout ? { timeout } : {}) });
const say = (obj) => `printf '%s' '${JSON.stringify(obj)}'`;

function boot() {
  const handlers = {};
  glitch({ on: (n, f) => (handlers[n] = f), setLabel() {} });
  return handlers;
}

test("localPath strips selectors, hashline headers and refuses URLs", () => {
  assert.equal(localPath("src/a.ts:50-100"), "src/a.ts");
  assert.equal(localPath("a.md:raw"), "a.md");
  assert.equal(localPath("[src/a.ts#K3]"), "src/a.ts");
  assert.equal(localPath("file:///tmp/x.txt"), "/tmp/x.txt");
  assert.equal(localPath("https://example.com/a"), null);
  assert.equal(localPath("local://notes"), null);
  assert.equal(localPath(""), null);
  assert.equal(localPath(42), null);
});

test("translate maps omp tools onto the Claude shapes the guards read", () => {
  assert.deepEqual(translate("bash", { command: "ls" }), [{ tool_name: "Bash", tool_input: { command: "ls" } }]);
  const r = translate("read", { path: "a/b.ts:1-5" });
  assert.equal(r[0].tool_name, "Read");
  assert.equal(r[0].tool_input.file_path, "a/b.ts");
  assert.equal(translate("read", { path: "https://x.y/z" }), null); // web page: not a disk path
  const e = translate("edit", { path: "a.ts", paths: ["a.ts", "b.ts"] });
  assert.deepEqual(e.map((c) => c.tool_input.file_path), ["a.ts", "b.ts"]);
  assert.equal(translate("edit", {}).error.includes("could not be read"), true); // fail closed
  assert.equal(translate("write", {}).error.includes("could not be read"), true);
  assert.equal(translate("write", { path: "local://scratch.md", content: "x" }), null);
  assert.equal(translate("glob", { path: "src/**/*.ts; test/**/*.ts" }).length, 2);
  assert.equal(translate("grep", { pattern: "x", path: "a;b" }).length, 2);
  assert.equal(translate("todo", {}), null); // unguarded tool
  const ev = translate("eval", { language: "py", code: "print(1)" });
  assert.equal(ev[0].tool_name, "Bash");
  assert.equal(ev[0].tool_input.command, "print(1)");
});

test("findGlitchRoot needs CLAUDE.md AND the write guard, and walks past a workspace", () => {
  const root = fakeRoot({});
  const ws = path.join(root, "workspaces", "proj");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# workspace stamp\n"); // CLAUDE.md alone must not stop the walk
  assert.equal(findGlitchRoot(ws), root);
  assert.equal(findGlitchRoot(root), root);
  assert.equal(findGlitchRoot(os.tmpdir()), null);
  assert.equal(findGlitchRoot(""), null);
  assert.equal(findGlitchRoot(undefined), null);
});

test("loadHooks reads settings.json matchers and timeouts", () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Edit|Write", hooks: [cmd("true", 7)] }], Stop: [{ hooks: [cmd("true")] }] });
  const h = loadHooks(root);
  assert.equal(h.length, 2);
  assert.equal(h[0].timeoutMs, 7000);
  assert.equal(h[0].matcher.test("Write"), true);
  assert.equal(h[0].matcher.test("Bash"), false);
  assert.equal(h[1].matcher, null);
});

test("outside a Glitch folder the extension does nothing", async () => {
  const h = boot();
  const out = await h.tool_call({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: os.tmpdir(), hasUI: false });
  assert.equal(out, undefined);
});

test("a hook's deny becomes a block with the hook's own words", async () => {
  const deny = say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "engine is read-only" } });
  const root = fakeRoot({ PreToolUse: [{ matcher: "Write", hooks: [cmd(deny)] }] });
  const h = boot();
  const out = await h.tool_call({ toolName: "write", input: { path: "x.txt", content: "hi" } }, { cwd: root, hasUI: false });
  assert.equal(out.block, true);
  assert.equal(out.reason, "engine is read-only");
});

test("exit code 2 blocks with stderr", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd("echo nope >&2; exit 2")] }] });
  const out = await boot().tool_call({ toolName: "bash", input: { command: "ls" } }, { cwd: root });
  assert.equal(out.block, true);
  assert.match(out.reason, /nope/);
});

test("a guard that cannot run blocks instead of waving the call through", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd("exit 1")] }] });
  const out = await boot().tool_call({ toolName: "bash", input: { command: "ls" } }, { cwd: root });
  assert.equal(out.block, true);
  assert.match(out.reason, /could not run/);
});

test("a guard that times out blocks", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd("sleep 5", 1)] }] });
  const t = Date.now();
  const out = await boot().tool_call({ toolName: "bash", input: { command: "ls" } }, { cwd: root });
  assert.equal(out.block, true);
  assert.match(out.reason, /timed out/);
  assert.ok(Date.now() - t < 4000);
});

test("ask: confirmed lets it through, declined or no screen blocks", async () => {
  const ask = say({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "sure?" } });
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd(ask)] }] });
  const call = { toolName: "bash", input: { command: "ls" } };
  const yes = await boot().tool_call(call, { cwd: root, hasUI: true, ui: { confirm: async () => true } });
  assert.equal(yes, undefined);
  const no = await boot().tool_call(call, { cwd: root, hasUI: true, ui: { confirm: async () => false } });
  assert.equal(no.block, true);
  const none = await boot().tool_call(call, { cwd: root, hasUI: false });
  assert.equal(none.block, true);
  assert.match(none.reason, /no screen/);
});

test("allow with additionalContext passes the note on", async () => {
  const note = say({ hookSpecificOutput: { permissionDecision: "allow", additionalContext: "heads up" } });
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd(note)] }] });
  const out = await boot().tool_call({ toolName: "bash", input: { command: "ls" } }, { cwd: root });
  assert.deepEqual(out, { additionalContext: "heads up" });
});

test("the hook receives Claude-shaped stdin and CLAUDE_PROJECT_DIR", async () => {
  const dump = path.join(os.tmpdir(), `dump-${process.pid}.json`);
  const root = fakeRoot({ PreToolUse: [{ matcher: "Read", hooks: [cmd(`cat > ${dump}; echo "$CLAUDE_PROJECT_DIR" > ${dump}.env`)] }] });
  await boot().tool_call({ toolName: "read", input: { path: "a/b.ts:3-9" }, toolCallId: "tc1" }, { cwd: root });
  const got = JSON.parse(fs.readFileSync(dump, "utf8"));
  assert.equal(got.hook_event_name, "PreToolUse");
  assert.equal(got.tool_name, "Read");
  assert.equal(got.tool_input.file_path, path.join(root, "a/b.ts")); // absolute, as Claude Code sends it
  assert.equal(got.tool_use_id, "tc1");
  assert.equal(fs.readFileSync(`${dump}.env`, "utf8").trim(), root);
});

test("session start and prompt context ride one hidden message; start fires once", async () => {
  const start = say({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "YOU ARE GLITCH" } });
  const prompt = say({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "prompt note" } });
  const root = fakeRoot({
    SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [cmd(start)] }],
    UserPromptSubmit: [{ hooks: [cmd(prompt)] }],
  });
  const h = boot();
  const ctx = { cwd: root };
  h.session_start({}, ctx);
  const first = await h.before_agent_start({ prompt: "hello" }, ctx);
  assert.equal(first.message.customType, "glitch-context");
  assert.equal(first.message.display, false);
  assert.match(first.message.content, /YOU ARE GLITCH/);
  assert.match(first.message.content, /prompt note/);
  const second = await h.before_agent_start({ prompt: "again" }, ctx);
  assert.doesNotMatch(second.message.content, /YOU ARE GLITCH/); // identity is not repeated each turn
  assert.match(second.message.content, /prompt note/);
  h.session_compact({}, ctx);
  const third = await h.before_agent_start({ prompt: "after compaction" }, ctx);
  assert.match(third.message.content, /YOU ARE GLITCH/); // re-injected once the old context is summarised away
});

test("PostToolUse sees the command's output and returns the note", async () => {
  const dump = path.join(os.tmpdir(), `post-${process.pid}.json`);
  const note = say({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "a secret was redacted" } });
  const root = fakeRoot({ PostToolUse: [{ matcher: "Bash", hooks: [cmd(`cat > ${dump}; ${note}`)] }] });
  const out = await boot().tool_result(
    { toolName: "bash", input: { command: "env" }, content: [{ type: "text", text: "KEY=abc" }], isError: false },
    { cwd: root },
  );
  assert.deepEqual(out, { additionalContext: "a secret was redacted" });
  const got = JSON.parse(fs.readFileSync(dump, "utf8"));
  assert.equal(got.tool_response.stdout, "KEY=abc");
  assert.equal(got.tool_name, "Bash");
});

test("SessionEnd runs once per session, from whichever shutdown event comes first", async () => {
  const mark = path.join(os.tmpdir(), `end-${process.pid}.log`);
  fs.rmSync(mark, { force: true });
  const root = fakeRoot({ SessionEnd: [{ matcher: "prompt_input_exit|clear|other", hooks: [cmd(`echo ran >> ${mark}`)] }] });
  const h = boot();
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" } };
  await h.session_before_shutdown({}, ctx);
  await h.session_shutdown({}, ctx);
  assert.equal(fs.readFileSync(mark, "utf8").trim().split("\n").length, 1);
});

test("relative paths become absolute against the session folder (Claude always sends absolute)", () => {
  assert.equal(localPath("a/b.ts:3-9", "/proj"), "/proj/a/b.ts");
  assert.equal(localPath("/etc/hosts", "/proj"), "/etc/hosts");
  assert.equal(localPath("~/x.txt", "/proj"), path.join(os.homedir(), "x.txt"));
  const w = translate("write", { path: ".claude/scripts/x.txt", content: "x" }, "/glitch");
  assert.equal(w[0].tool_input.file_path, "/glitch/.claude/scripts/x.txt");
  const g = translate("grep", { pattern: "x" }, "/glitch");
  assert.equal(g[0].tool_input.path, "/glitch"); // no path = the session folder
  const gl = translate("glob", { path: "src/**/*.ts" }, "/glitch");
  assert.equal(gl[0].tool_input.pattern, "/glitch/src/**/*.ts");
});

test("session-start and prompt context come from Glitch's Codex variants when present", () => {
  const root = fakeRoot({
    SessionStart: [{ hooks: [cmd("echo claude-start")] }],
    UserPromptSubmit: [{ hooks: [cmd("echo claude-prompt")] }],
    PreToolUse: [{ matcher: "Bash", hooks: [cmd("echo guard")] }],
  });
  fs.mkdirSync(path.join(root, ".codex"));
  fs.writeFileSync(
    path.join(root, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ matcher: ".*", hooks: [{ type: "command", command: "echo codex-start" }] }], PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "echo codex-guard" }] }] } }),
  );
  const cmds = (events) => loadHooks(root).filter((h) => events.includes(h.event)).map((h) => h.command);
  assert.deepEqual(cmds(["SessionStart"]), ["echo codex-start"]); // Codex variant replaces Claude's
  assert.deepEqual(cmds(["UserPromptSubmit"]), ["echo claude-prompt"]); // no Codex entry: keep Claude's
  assert.deepEqual(cmds(["PreToolUse"]), ["echo guard"]); // guards always stay Claude's
  process.env.GLITCH_OMP_CONTEXT = "claude";
  try {
    assert.deepEqual(cmds(["SessionStart"]), ["echo claude-start"]);
  } finally {
    delete process.env.GLITCH_OMP_CONTEXT;
  }
});

test("helper (sub-agent) sessions: guards still run and carry agent_id; no identity, no chat saving", async () => {
  const dump = path.join(os.tmpdir(), `sub-${process.pid}.json`);
  const marker = path.join(os.tmpdir(), `sub-end-${process.pid}.log`);
  fs.rmSync(marker, { force: true });
  const root = fakeRoot({
    PreToolUse: [{ matcher: "Read", hooks: [cmd(`cat > ${dump}`)] }],
    SessionStart: [{ hooks: [cmd(say({ hookSpecificOutput: { additionalContext: "IDENTITY" } }))] }],
    UserPromptSubmit: [{ hooks: [cmd(say({ hookSpecificOutput: { additionalContext: "PROMPT-NOTE" } }))] }],
    SessionEnd: [{ hooks: [cmd(`echo ran >> ${marker}`)] }],
  });
  const h = boot();
  const sub = { cwd: root, agent: { kind: "sub", id: "Finch", name: "task", depth: 1 }, sessionManager: { getSessionId: () => "child-1" } };
  h.session_start({}, sub);
  assert.equal(await h.before_agent_start({ prompt: "do the thing" }, sub), undefined); // no identity for a helper
  await h.tool_call({ toolName: "read", input: { path: "a.txt" }, toolCallId: "x" }, sub); // but the guards run
  const got = JSON.parse(fs.readFileSync(dump, "utf8"));
  assert.equal(got.agent_id, "Finch");
  assert.equal(got.subagent_type, "task");
  await h.session_before_shutdown({}, sub);
  await h.session_shutdown({}, sub);
  assert.equal(fs.existsSync(marker), false); // a helper's chatter is never saved as a member chat
});

test("a helper starting does not re-arm the main chat's identity injection", async () => {
  const root = fakeRoot({ SessionStart: [{ hooks: [cmd(say({ hookSpecificOutput: { additionalContext: "IDENTITY" } }))] }] });
  const h = boot();
  const main = { cwd: root, sessionManager: { getSessionId: () => "main-1" } };
  const sub = { cwd: root, agent: { kind: "sub", id: "Finch", name: "task" }, sessionManager: { getSessionId: () => "child-1" } };
  h.session_start({}, main);
  const first = await h.before_agent_start({ prompt: "hi" }, main);
  assert.match(first.message.content, /IDENTITY/);
  h.session_start({}, sub); // a helper spawns mid-chat
  const second = await h.before_agent_start({ prompt: "again" }, main);
  assert.equal(second, undefined); // identity is not injected a second time
});

// ---- trusted folders --------------------------------------------------------------------------

function withTrustFile(content, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trust-")), "glitch-adapter.json");
  if (content !== null) fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  const before = process.env.GLITCH_OMP_TRUST_FILE;
  process.env.GLITCH_OMP_TRUST_FILE = file;
  const restore = () => (process.env.GLITCH_OMP_TRUST_FILE = before);
  return Promise.resolve(fn(file)).finally(restore);
}
const denyAll = say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "guard says no" } });

test("trust list: a Glitch folder that is NOT on the list gets no hooks, and the member is told", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd(denyAll)] }] });
  await withTrustFile({ roots: ["/somewhere/else"] }, async () => {
    const h = boot();
    const said = [];
    const ctx = { cwd: root, hasUI: true, ui: { notify: (m, level) => said.push([m, level]) }, sessionManager: { getSessionId: () => "t1" } };
    h.session_start({}, ctx);
    assert.equal(await h.tool_call({ toolName: "bash", input: { command: "ls" } }, ctx), undefined);
    assert.equal(await h.before_agent_start({ prompt: "hi" }, ctx), undefined);
    assert.equal(said.length, 1);
    assert.equal(said[0][1], "warning");
    assert.match(said[0][0], /Glitch is OFF/);
    assert.match(said[0][0], /trust/);
  });
});

test("trust list: a folder that IS on the list runs its guards (also through a symlink and ~ style entry)", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd(denyAll)] }] });
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lnk-")), "g");
  fs.symlinkSync(root, link);
  for (const entry of [root, link]) {
    await withTrustFile({ roots: [entry] }, async () => {
      const out = await boot().tool_call({ toolName: "bash", input: { command: "ls" } }, { cwd: root, hasUI: false });
      assert.equal(out?.block, true);
    });
  }
});

test("trust list: no file means every Glitch folder runs (how it worked before the list)", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd(denyAll)] }] });
  await withTrustFile(null, async () => {
    const out = await boot().tool_call({ toolName: "bash", input: { command: "ls" } }, { cwd: root, hasUI: false });
    assert.equal(out?.block, true);
  });
});

test("trust list: a list that cannot be read trusts nothing", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd(denyAll)] }] });
  for (const bad of ["{ not json", JSON.stringify({ roots: "nope" }), JSON.stringify({ roots: [] })]) {
    await withTrustFile(bad, async () => {
      assert.equal(await boot().tool_call({ toolName: "bash", input: { command: "ls" } }, { cwd: root, hasUI: false }), undefined);
    });
  }
});

test("trust list: edits take effect without restarting omp", async () => {
  const root = fakeRoot({ PreToolUse: [{ matcher: "Bash", hooks: [cmd(denyAll)] }] });
  await withTrustFile({ roots: [] }, async (file) => {
    const h = boot();
    const ctx = { cwd: root, hasUI: false };
    assert.equal(await h.tool_call({ toolName: "bash", input: { command: "ls" } }, ctx), undefined);
    fs.writeFileSync(file, JSON.stringify({ roots: [root] }));
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000)); // make the change visible to mtime
    assert.equal((await h.tool_call({ toolName: "bash", input: { command: "ls" } }, ctx))?.block, true);
  });
});
