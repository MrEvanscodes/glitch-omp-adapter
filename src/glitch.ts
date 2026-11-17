// glitch.ts - Glitch for omp (oh-my-pi), the agent that Tern runs.
//
// Glitch's guards and memory are Claude Code hooks declared in `<glitch>/.claude/settings.json`.
// omp does not run those. This one extension does: it reads the SAME hook commands out of that
// file at run time (nothing is copied, so a Glitch update can never leave this stale), turns omp's
// events into the JSON those hooks expect on stdin, runs them, and turns their answer back into
// omp's vocabulary (block a tool call, add context to the next prompt).
//
//   Claude Code event   ->  omp event
//   PreToolUse          ->  tool_call            (can block)
//   PostToolUse         ->  tool_result          (adds context)
//   UserPromptSubmit    ->  before_agent_start   (adds context)
//   SessionStart        ->  first before_agent_start of a session / clear / compaction
//   PreCompact          ->  session_before_compact
//   SessionEnd          ->  session_before_shutdown (falls back to session_shutdown)
//
// It does nothing at all outside a Glitch folder. Guards fail CLOSED: if a PreToolUse hook cannot
// run (no `uv`, timeout, crash) the tool call is blocked and the reason says why, never waved
// through. Context and memory hooks fail open: a broken one must not stop you working.
//
// Plain TypeScript with no build step: omp loads it directly, and Node (>=22.18) can strip the
// types so the tests run without omp. Only `node:*` imports, and `import type` for omp's API.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------
// Which folder is Glitch? Same rule as the Glitch bridge and the OpenCode add-on: walk up to the
// first folder holding BOTH CLAUDE.md and .claude/hooks/write-guard.py (workspaces carry their own
// CLAUDE.md, so CLAUDE.md alone would stop the walk one level too early).
// ---------------------------------------------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function realpathLoose(p: string): string {
  const tail: string[] = [];
  let current = nodePath.resolve(p);
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? nodePath.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) return nodePath.resolve(p);
      tail.push(nodePath.basename(current));
      current = parent;
    }
  }
}

export function findGlitchRoot(start: unknown): string | null {
  try {
    if (typeof start !== "string" || start.trim() === "") return null;
    let cur = realpathLoose(start.startsWith("~") ? nodePath.join(os.homedir(), start.slice(1)) : start);
    for (;;) {
      if (isFile(nodePath.join(cur, "CLAUDE.md")) && isFile(nodePath.join(cur, ".claude", "hooks", "write-guard.py"))) {
        return cur;
      }
      const parent = nodePath.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Trusted folders. This add-on runs the hook programs that live INSIDE a Glitch folder. A Glitch
// folder you did not set up yourself (a friend's fork, a download) could therefore run its own
// programs the moment you open omp there. Claude Code asks "do you trust this folder?" before it does
// that; this list is the same idea. The installer writes it (`<omp agent dir>/glitch-adapter.json`).
// With NO list file the add-on runs in any Glitch folder (how it behaved before the list existed).
// A list file that cannot be read trusts nothing. It guards against opening the wrong folder by
// accident; it is not a sandbox against a model that is told to edit the file.
// ---------------------------------------------------------------------------------------------

export function trustFile(): string {
  return (
    process.env.GLITCH_OMP_TRUST_FILE ||
    nodePath.join(process.env.PI_CODING_AGENT_DIR || nodePath.join(os.homedir(), ".omp", "agent"), "glitch-adapter.json")
  );
}

let trustCache: { file: string; mtime: number; roots: string[] } | null = null;

export function trustState(root: string): "no-list" | "trusted" | "untrusted" {
  const file = trustFile();
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return "no-list";
  }
  if (!trustCache || trustCache.file !== file || trustCache.mtime !== mtime) {
    let roots: string[] = [];
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(j?.roots)) {
        roots = j.roots
          .filter((r: unknown): r is string => typeof r === "string" && r.trim() !== "")
          .map((r: string) => realpathLoose(r.startsWith("~") ? nodePath.join(os.homedir(), r.slice(1)) : r));
      }
    } catch {
      /* unreadable or not JSON: trust nothing */
    }
    trustCache = { file, mtime, roots };
  }
  return trustCache.roots.includes(realpathLoose(root)) ? "trusted" : "untrusted";
}

// ---------------------------------------------------------------------------------------------
// Reading Glitch's hook table.
// ---------------------------------------------------------------------------------------------

export interface HookDef {
  event: string;
  matcher: RegExp | null; // null = matches everything
  command: string;
  timeoutMs: number;
}

// Claude's own session-start and prompt hooks assume Claude Code loads the persona (output style)
// and memory (@imports in CLAUDE.md) itself. omp does neither. Glitch already ships a variant for
// tools in that position (Codex): it reads persona + USER.md + MEMORY.md fresh from the vault and
// injects them. For these two events the adapter uses the variant, from `.codex/hooks.json`.
// Set GLITCH_OMP_CONTEXT=claude to use the Claude ones instead.
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

function readHookDoc(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function loadHooks(root: string): HookDef[] {
  const out: HookDef[] = [];
  const sources: { file: string; only?: Set<string>; skip?: Set<string> }[] = [];
  // Override only the events the Codex file really defines; anything it lacks stays Claude's.
  const codexDoc = process.env.GLITCH_OMP_CONTEXT === "claude" ? null : readHookDoc(nodePath.join(root, ".codex", "hooks.json"));
  const override = new Set(
    [...CONTEXT_EVENTS].filter((e) => Array.isArray(codexDoc?.hooks?.[e]) && codexDoc.hooks[e].length > 0),
  );
  for (const name of ["settings.json", "settings.local.json"]) {
    sources.push({ file: nodePath.join(root, ".claude", name), skip: override.size ? override : undefined });
  }
  if (override.size) sources.push({ file: nodePath.join(root, ".codex", "hooks.json"), only: override });
  for (const src of sources) {
    const doc = readHookDoc(src.file);
    const hooks = doc && typeof doc === "object" ? doc.hooks : null;
    if (!hooks || typeof hooks !== "object") continue;
    for (const [event, entries] of Object.entries<any>(hooks)) {
      if (src.only && !src.only.has(event)) continue;
      if (src.skip && src.skip.has(event)) continue;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const m = typeof entry?.matcher === "string" ? entry.matcher.trim() : "";
        let matcher: RegExp | null = null;
        if (m !== "" && m !== "*") {
          try {
            matcher = new RegExp(`^(?:${m})$`);
          } catch {
            matcher = null;
          }
        }
        for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
          if (h?.type !== "command" || typeof h.command !== "string") continue;
          const secs = typeof h.timeout === "number" && h.timeout > 0 ? h.timeout : event === "UserPromptSubmit" ? 10 : 30;
          out.push({ event, matcher, command: h.command, timeoutMs: secs * 1000 });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running a hook the way Claude Code would.
// ---------------------------------------------------------------------------------------------

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
  ms: number;
}

const MAX_OUTPUT = 1_000_000;

export function runHook(def: HookDef, payload: unknown, root: string): Promise<HookRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (code: number | null, spawnError: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError, ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(def.command, {
        cwd: root,
        shell: true,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      resolve({ code: null, stdout, stderr, timedOut, spawnError: String(e?.message ?? e), ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, def.timeoutMs);
    child.stdout?.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (e) => finish(null, String(e.message)));
    child.on("close", (code) => finish(code, null));
    child.stdin?.on("error", () => {
      /* hook exited before reading stdin: its exit code still speaks */
    });
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      /* same */
    }
  });
}

export interface Verdict {
  decision: "allow" | "deny" | "ask";
  reason: string;
  contexts: string[];
  failed: string | null; // why a hook could not run (set only when it matters)
}

function parseJson(s: string): any {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Fold one hook run into the running verdict, the way Claude Code reads a hook's answer. */
export function foldRun(v: Verdict, run: HookRun, def: HookDef): void {
  if (run.spawnError || run.timedOut) {
    v.failed = run.timedOut ? `timed out after ${def.timeoutMs / 1000}s` : `could not start (${run.spawnError})`;
    return;
  }
  const out = parseJson(run.stdout);
  const spec = out && typeof out === "object" ? out.hookSpecificOutput ?? {} : {};
  if (run.code === 2) {
    v.decision = "deny";
    v.reason = (run.stderr.trim() || v.reason || "blocked by a Glitch guard").slice(0, 4000);
    return;
  }
  if (run.code !== 0) {
    v.failed = `exited with code ${run.code}${run.stderr.trim() ? `: ${run.stderr.trim().slice(0, 300)}` : ""}`;
    return;
  }
  const perm = spec.permissionDecision ?? (out?.decision === "block" ? "deny" : undefined);
  const why = spec.permissionDecisionReason ?? out?.reason;
  if (perm === "deny") {
    v.decision = "deny";
    v.reason = String(why ?? "blocked by a Glitch guard").slice(0, 4000);
  } else if (perm === "ask" && v.decision !== "deny") {
    v.decision = "ask";
    v.reason = String(why ?? "Glitch wants you to confirm this").slice(0, 4000);
  }
  const ctx = spec.additionalContext ?? out?.additionalContext;
  if (typeof ctx === "string" && ctx.trim()) v.contexts.push(ctx.trim());
}

async function fire(
  hooks: HookDef[],
  root: string,
  event: string,
  matchValue: string,
  payload: Record<string, unknown>,
): Promise<Verdict> {
  const v: Verdict = { decision: "allow", reason: "", contexts: [], failed: null };
  const chosen = hooks.filter((h) => h.event === event && (h.matcher === null || h.matcher.test(matchValue)));
  const runs = await Promise.all(
    chosen.map(async (def) => ({ def, run: await runHook(def, { hook_event_name: event, ...payload }, root) })),
  );
  for (const { def, run } of runs) foldRun(v, run, def);
  return v;
}

// ---------------------------------------------------------------------------------------------
// omp tool call -> the Claude-shaped call Glitch's guards understand.
// ---------------------------------------------------------------------------------------------

export interface ClaudeCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A tool's `path` argument -> a plain local path, or null when it is not a local file at all. */
export function localPath(raw: unknown, cwd?: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  const header = /^\[(.+)#[^\]]*\]$/.exec(p); // hashline write/edit header: [path#TAG]
  if (header) p = header[1];
  if (p.startsWith("file://")) {
    try {
      p = fileURLToPath(p);
    } catch {
      return null;
    }
  }
  if (SCHEME.test(p)) return null; // http://, local://, ssh:// ... not a path on this disk
  p = p.replace(/:(?:raw|img)$/i, "").replace(/:\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*$/, "");
  if (!p) return null;
  // Claude Code always hands its guards ABSOLUTE paths. omp may hand over a relative one, and
  // Glitch's hooks run from their own folder, so a relative path would be judged from the wrong
  // place (a write into the engine folder looked harmless). Make it absolute the way omp will.
  if (p === "~" || p.startsWith("~/")) p = nodePath.join(os.homedir(), p.slice(1));
  if (cwd && !nodePath.isAbsolute(p)) p = nodePath.resolve(cwd, p);
  return p;
}

function splitPaths(raw: unknown, cwd?: string): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(";")
    .map((s) => localPath(s, cwd))
    .filter((s): s is string => !!s);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * null = this tool is not one Glitch guards (let it through).
 * { error } = a guarded tool whose target we could not read: refuse rather than guess.
 */
export function translate(toolName: string, input: any, cwd?: string): ClaudeCall[] | { error: string } | null {
  const inp = input && typeof input === "object" ? input : {};
  switch (toolName) {
    case "bash":
      return [{ tool_name: "Bash", tool_input: { ...inp } }];
    case "eval": {
      // Python/JS cells can do anything a shell can. Hand the code to the Bash guards so their
      // text rules (git history, destructive commands, secrets) still apply. This is a net with
      // wide holes, not a wall: see README "What is and is not guarded".
      const code = typeof inp.code === "string" ? inp.code : "";
      const calls = [{ tool_name: "Bash", tool_input: { command: code, description: `omp eval (${inp.language ?? "?"})` } }];
      // omp's eval has a built-in `commit` namespace (`commit.draft()` then `d.commit(...)`) that commits
      // without any `git commit` text, so the text rules above miss it (seen: Kimi K3.1 committed into a
      // brain this way). Show the guards what the cell really does.
      if (/(?<![\w.])commit\s*\.\s*draft\s*\(/.test(code)) {
        calls.push({ tool_name: "Bash", tool_input: { command: 'git commit -m "omp eval commit namespace"', description: "omp eval: commit namespace" } });
      }
      return calls;
    }
    case "read": {
      const p = localPath(inp.path, cwd);
      return p ? [{ tool_name: "Read", tool_input: { ...inp, file_path: p } }] : null;
    }
    case "write": {
      const p = localPath(inp.path, cwd);
      if (p) return [{ tool_name: "Write", tool_input: { ...inp, file_path: p } }];
      return typeof inp.path === "string" && SCHEME.test(inp.path.trim())
        ? null
        : { error: "the write target could not be read" };
    }
    case "edit": {
      const found = [inp.path, ...strings(inp.paths)].map((x) => localPath(x, cwd)).filter((x): x is string => !!x);
      const uniq = [...new Set(found)];
      if (uniq.length === 0) return { error: "the edit target could not be read" };
      return uniq.map((p) => ({ tool_name: "Edit", tool_input: { ...inp, file_path: p } }));
    }
    case "ast_edit": {
      const paths = strings(inp.paths).map((x) => localPath(x, cwd)).filter((x): x is string => !!x);
      if (paths.length === 0) return { error: "the ast_edit targets could not be read" };
      return paths.map((p) => ({ tool_name: "Edit", tool_input: { ...inp, file_path: p } }));
    }
    case "grep":
    case "ast_grep": {
      const paths = splitPaths(inp.path ?? ".", cwd);
      const list = paths.length ? paths : [cwd ?? "."];
      return list.map((p) => ({ tool_name: "Grep", tool_input: { ...inp, path: p } }));
    }
    case "glob": {
      const globs = splitPaths(inp.path ?? ".", cwd);
      const list = globs.length ? globs : [cwd ?? "."];
      return list.map((g) => ({ tool_name: "Glob", tool_input: { ...inp, pattern: g } }));
    }
    case "find": {
      const paths = splitPaths(inp.path ?? ".", cwd);
      const list = paths.length ? paths : [cwd ?? "."];
      return list.map((p) => ({ tool_name: "Grep", tool_input: { pattern: inp.query, path: p } }));
    }
    case "notebook": {
      const p = localPath(inp.path ?? inp.notebook_path, cwd);
      return p ? [{ tool_name: "NotebookEdit", tool_input: { ...inp, notebook_path: p } }] : null;
    }
    default:
      return null;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => (c && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Tiny append-only log of what the adapter decided. Lives in omp's own log folder, never in Glitch.
// ---------------------------------------------------------------------------------------------

const DEFAULT_LOG = nodePath.join(os.homedir(), ".omp", "logs", "glitch-adapter.jsonl");

export function logLine(obj: Record<string, unknown>): void {
  try {
    // GLITCH_OMP_LOG lets tests and the self-check keep their deliberate refusals and failures out of the
    // log that records your real sessions.
    const file = process.env.GLITCH_OMP_LOG || DEFAULT_LOG;
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 2_000_000) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
  } catch {
    /* logging must never break a session */
  }
}

// ---------------------------------------------------------------------------------------------
// The extension.
// ---------------------------------------------------------------------------------------------

export default function glitch(pi: ExtensionAPI): void {
  try {
    pi.setLabel?.("Glitch");
  } catch {
    /* cosmetic */
  }

  // Per-folder cache of the hook table, reloaded when settings.json changes (a Glitch update).
  const tables = new Map<string, { mtime: number; hooks: HookDef[] }>();
  function hooksFor(root: string): HookDef[] {
    let mtime = 0;
    try {
      mtime = fs.statSync(nodePath.join(root, ".claude", "settings.json")).mtimeMs;
    } catch {
      /* missing: empty table */
    }
    const hit = tables.get(root);
    if (hit && hit.mtime === mtime) return hit.hooks;
    const hooks = loadHooks(root);
    tables.set(root, { mtime, hooks });
    return hooks;
  }

  // The Glitch folder the add-on acts in: a Glitch folder that is on the trusted list (or no list yet).
  const warned = new Set<string>();
  const rootOf = (ctx: any): string | null => {
    const root = findGlitchRoot(ctx?.cwd);
    if (!root) return null;
    if (trustState(root) !== "untrusted") return root;
    if (!warned.has(root)) {
      warned.add(root);
      logLine({ ev: "untrusted", root });
    }
    return null;
  };

  // omp runs helpers (its `task` tool) as child sessions with this add-on bound to them too. Claude Code
  // treats subagents specially and Glitch's hooks know it: a subagent's tool calls carry `agent_id` /
  // `subagent_type` (so the read guard does not tell a helper to ask a member who is not there), and
  // none of the session hooks run for it (no identity context, no saving its chatter as a member chat).
  const agentOf = (ctx: any): { id: string; name: string } | null => {
    const a = ctx?.agent;
    return a && a.kind === "sub" ? { id: String(a.id ?? ""), name: String(a.name ?? "") } : null;
  };

  function base(ctx: any, root: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    let sessionFile = "";
    let sessionId = "";
    try {
      sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? "";
    } catch {
      /* not persisted */
    }
    try {
      sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch {
      /* none yet */
    }
    const sub = agentOf(ctx);
    const who = sub ? { agent_id: sub.id, subagent_type: sub.name || "task" } : {};
    return { session_id: sessionId, transcript_path: sessionFile, cwd: ctx?.cwd ?? root, permission_mode: "default", ...who, ...extra };
  }

  // Per-session state. Child sessions share this module, so plain module-level variables would let a
  // helper starting re-arm the main chat's identity injection.
  const sessions = new Map<string, { pending: string | null; ended: boolean }>();
  function st(ctx: any): { pending: string | null; ended: boolean } {
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? "";
    } catch {
      /* none yet */
    }
    let s = sessions.get(sid);
    if (!s) {
      s = { pending: "startup", ended: false }; // what to tell the model on its next prompt
      sessions.set(sid, s);
    }
    return s;
  }

  pi.on("session_start", (_e: any, ctx: any) => {
    if (agentOf(ctx)) return;
    const found = findGlitchRoot(ctx?.cwd);
    if (found && trustState(found) === "untrusted") {
      // Say so out loud: silently doing nothing would look like "Glitch is on" with no guards at all.
      let installer = "scripts/install.py";
      try {
        installer = fileURLToPath(new URL("../scripts/install.py", import.meta.url));
      } catch {
        /* keep the short name */
      }
      try {
        ctx.ui?.notify?.(
          `Glitch is OFF in ${found}: it is not on your trusted-folders list, so no guards and no memory. ` +
            `If this is your own Glitch folder, run: uv run --no-project python "${installer}" trust "${found}"`,
          "warning",
        );
      } catch {
        /* cosmetic */
      }
      logLine({ ev: "untrusted", root: found });
    }
    const s = st(ctx);
    s.pending = "startup";
    s.ended = false;
  });
  pi.on("session_switch", (_e: any, ctx: any) => {
    if (agentOf(ctx)) return;
    const s = st(ctx);
    s.pending = "resume";
    s.ended = false;
  });
  pi.on("session_clear", (_e: any, ctx: any) => {
    if (agentOf(ctx)) return;
    st(ctx).pending = "clear";
  });
  pi.on("session_compact", (_e: any, ctx: any) => {
    if (agentOf(ctx)) return;
    st(ctx).pending = "compact";
  });

  // PreToolUse: the safety gate.
  pi.on("tool_call", async (event: any, ctx: any) => {
    const root = rootOf(ctx);
    if (!root) return;
    const toolName = String(event?.toolName ?? "");
    try {
      const calls = translate(toolName, event?.input, ctx?.cwd ?? root);
      if (calls === null) return;
      if (!Array.isArray(calls)) {
        logLine({ ev: "block", tool: toolName, why: calls.error });
        return { block: true, reason: `Glitch guard: ${calls.error}, so omp stopped this call rather than guess. (omp tool: ${toolName})` };
      }
      const hooks = hooksFor(root);
      const contexts: string[] = [];
      for (const call of calls) {
        const v = await fire(hooks, root, "PreToolUse", call.tool_name, {
          ...base(ctx, root),
          tool_name: call.tool_name,
          tool_input: call.tool_input,
          tool_use_id: event?.toolCallId ?? "",
        });
        if (v.failed) {
          logLine({ ev: "block", tool: toolName, why: `guard failed: ${v.failed}` });
          return {
            block: true,
            reason: `Glitch's safety guard could not run (${v.failed}), so this ${toolName} call was stopped instead of waved through. Check that \`uv\` is installed (uv --version), then try again.`,
          };
        }
        let decision = v.decision;
        if (decision === "ask") {
          let yes = false;
          if (ctx?.hasUI) {
            try {
              yes = !!(await ctx.ui.confirm("Glitch asks first", v.reason));
            } catch {
              yes = false;
            }
          }
          decision = yes ? "allow" : "deny";
          if (!yes) v.reason = `${v.reason}\n(Not confirmed${ctx?.hasUI ? "" : ": there is no screen to ask on"}.)`;
        }
        if (decision === "deny") {
          logLine({ ev: "deny", tool: toolName, as: call.tool_name, reason: v.reason.slice(0, 300) });
          return { block: true, reason: v.reason };
        }
        contexts.push(...v.contexts);
      }
      if (contexts.length) return { additionalContext: contexts.join("\n\n") };
    } catch (e: any) {
      logLine({ ev: "block", tool: toolName, why: `adapter error: ${String(e?.message ?? e)}` });
      return { block: true, reason: `Glitch's adapter hit an error checking this ${toolName} call (${String(e?.message ?? e)}), so it was stopped.` };
    }
  });

  // PostToolUse: the secret scan on command output.
  pi.on("tool_result", async (event: any, ctx: any) => {
    const root = rootOf(ctx);
    if (!root) return;
    const toolName = String(event?.toolName ?? "");
    if (toolName !== "bash" && toolName !== "eval") return;
    try {
      const text = resultText(event?.content);
      const input = event?.input ?? {};
      const command = toolName === "bash" ? String(input.command ?? "") : String(input.code ?? "");
      const v = await fire(hooksFor(root), root, "PostToolUse", "Bash", {
        ...base(ctx, root),
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: text, stderr: "", interrupted: false, isError: !!event?.isError },
        tool_use_id: event?.toolCallId ?? "",
      });
      if (v.contexts.length) return { additionalContext: v.contexts.join("\n\n") };
    } catch (e: any) {
      logLine({ ev: "error", where: "tool_result", why: String(e?.message ?? e) });
    }
  });

  // SessionStart (identity + memory) and UserPromptSubmit, delivered as one hidden message.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const root = rootOf(ctx);
    if (!root || agentOf(ctx)) return;
    try {
      const hooks = hooksFor(root);
      const parts: string[] = [];
      const state = st(ctx);
      if (state.pending) {
        const source = state.pending;
        state.pending = null;
        const v = await fire(hooks, root, "SessionStart", source, { ...base(ctx, root), source });
        if (v.failed) logLine({ ev: "error", where: "SessionStart", why: v.failed });
        parts.push(...v.contexts);
      }
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      const u = await fire(hooks, root, "UserPromptSubmit", "", { ...base(ctx, root), prompt });
      if (u.failed) logLine({ ev: "error", where: "UserPromptSubmit", why: u.failed });
      parts.push(...u.contexts);
      if (parts.length) {
        return { message: { customType: "glitch-context", content: parts.join("\n\n"), display: false } };
      }
    } catch (e: any) {
      logLine({ ev: "error", where: "before_agent_start", why: String(e?.message ?? e) });
    }
  });

  // PreCompact: save what is about to be summarised away.
  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    const root = rootOf(ctx);
    if (!root || agentOf(ctx)) return;
    try {
      const v = await fire(hooksFor(root), root, "PreCompact", "", { ...base(ctx, root), trigger: "auto", custom_instructions: "" });
      if (v.failed) logLine({ ev: "error", where: "PreCompact", why: v.failed });
    } catch (e: any) {
      logLine({ ev: "error", where: "PreCompact", why: String(e?.message ?? e) });
    }
  });

  // SessionEnd: capture the chat into Glitch's memory queue. `session_before_shutdown` has a
  // generous budget; `session_shutdown` only gets about 2 seconds, so it is the fallback.
  async function endSession(ctx: any, budgetMs: number | null): Promise<void> {
    const root = rootOf(ctx);
    if (!root || agentOf(ctx)) return;
    const state = st(ctx);
    if (state.ended) return;
    state.ended = true;
    try {
      const work = fire(hooksFor(root), root, "SessionEnd", "other", { ...base(ctx, root), reason: "other" });
      const v = budgetMs
        ? await Promise.race([work, new Promise<Verdict | null>((r) => setTimeout(() => r(null), budgetMs))])
        : await work;
      if (v && v.failed) logLine({ ev: "error", where: "SessionEnd", why: v.failed });
      if (!v) logLine({ ev: "error", where: "SessionEnd", why: `still running after ${budgetMs}ms` });
    } catch (e: any) {
      logLine({ ev: "error", where: "SessionEnd", why: String(e?.message ?? e) });
    }
  }
  pi.on("session_before_shutdown", async (_event: any, ctx: any) => {
    await endSession(ctx, null);
    return undefined; // never cancel the quit
  });
  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    await endSession(ctx, 1800);
  });
}
