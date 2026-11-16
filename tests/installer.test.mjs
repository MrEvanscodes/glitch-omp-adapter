// The installer, run for real against a THROWAWAY omp settings folder (PI_CODING_AGENT_DIR), so your own
// omp settings are never touched. Needs omp on the PATH and uv (or python3). Run: npm run test:installer
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(here, "src", "glitch.ts");
const hasOmp = spawnSync("omp", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;
const hasUv = spawnSync("uv", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;
const skip = !hasOmp ? "omp not found" : false;

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "glitch-install-")));
  const agent = path.join(dir, "agent");
  fs.mkdirSync(agent);
  const glitch = path.join(dir, "Glitch");
  fs.mkdirSync(path.join(glitch, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(glitch, "CLAUDE.md"), "# fake\n");
  fs.writeFileSync(path.join(glitch, ".claude", "hooks", "write-guard.py"), "# marker\n");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
  delete env.GLITCH_OMP_TRUST_FILE;
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", env, cwd: here, stdio: ["ignore", "pipe", "pipe"] });
  const install = (...args) => (hasUv ? run("uv", ["run", "--no-project", "python", "scripts/install.py", ...args]) : run("python3", ["scripts/install.py", ...args]));
  const exts = () => JSON.parse(run("omp", ["config", "get", "extensions"]).stdout.trim());
  const setExts = (list) => run("omp", ["config", "set", "extensions", JSON.stringify(list)]);
  const trust = () => JSON.parse(fs.readFileSync(path.join(agent, "glitch-adapter.json"), "utf8"));
  return { dir, agent, glitch, install, exts, setExts, trust };
}

test("dry run writes nothing", { skip }, () => {
  const s = sandbox();
  s.setExts(["/x/other.ts"]);
  const r = s.install("install", "--glitch", s.glitch, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run: nothing was written/);
  assert.deepEqual(s.exts(), ["/x/other.ts"]);
  assert.equal(fs.existsSync(path.join(s.agent, "glitch-adapter.json")), false);
  assert.equal(fs.existsSync(path.join(s.agent, "glitch-adapter-backups")), false);
});

test("install adds the add-on after your own extensions, trusts the folder, keeps a backup", { skip }, () => {
  const s = sandbox();
  s.setExts(["/x/other.ts"]);
  const r = s.install("install", "--glitch", s.glitch);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.exts(), ["/x/other.ts", EXT]);
  assert.deepEqual(s.trust().roots, [s.glitch]);
  assert.equal(s.trust().written_by, "glitch-omp-adapter");
  assert.ok(fs.readdirSync(path.join(s.agent, "glitch-adapter-backups")).some((f) => f.startsWith("config.yml.")));
});

test("installing twice changes nothing the second time", { skip }, () => {
  const s = sandbox();
  s.install("install", "--glitch", s.glitch);
  const count = () => {
    try {
      return fs.readdirSync(path.join(s.agent, "glitch-adapter-backups")).length; // none yet on a brand-new settings folder
    } catch {
      return 0;
    }
  };
  const backups = count();
  const r = s.install("install", "--glitch", s.glitch);
  assert.match(r.stdout, /Already installed/);
  assert.deepEqual(s.exts(), [EXT]);
  assert.equal(count(), backups);
});

test("an older or moved copy of the add-on is replaced, never doubled", { skip }, () => {
  const s = sandbox();
  s.setExts(["/old/place/glitch-omp-adapter-main/src/glitch.ts", "/x/other.ts"]);
  s.install("install", "--glitch", s.glitch);
  const list = s.exts();
  assert.equal(list.filter((e) => e.endsWith("glitch.ts")).length, 1);
  assert.ok(list.includes("/x/other.ts") && list.includes(EXT));
});

test("a folder that is not Glitch is refused and nothing is written", { skip }, () => {
  const s = sandbox();
  s.setExts([]);
  const r = s.install("install", "--glitch", s.dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not look like a Glitch folder/);
  assert.deepEqual(s.exts(), []);
  assert.equal(fs.existsSync(path.join(s.agent, "glitch-adapter.json")), false);
});

test("trust and untrust edit only the list; a second folder keeps the first", { skip }, () => {
  const s = sandbox();
  s.install("install", "--glitch", s.glitch);
  const other = path.join(s.dir, "Glitch2");
  fs.cpSync(s.glitch, other, { recursive: true });
  assert.equal(s.install("trust", other).status, 0);
  assert.deepEqual(s.trust().roots.sort(), [s.glitch, other].sort());
  assert.equal(s.install("untrust", other).status, 0);
  assert.deepEqual(s.trust().roots, [s.glitch]);
});

test("an unreadable trusted-folders file is replaced, with a copy kept", { skip }, () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.agent, "glitch-adapter.json"), "{ broken");
  const r = s.install("install", "--glitch", s.glitch);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.trust().roots, [s.glitch]);
  assert.ok(fs.readdirSync(path.join(s.agent, "glitch-adapter-backups")).some((f) => f.startsWith("glitch-adapter.json.")));
});

test("uninstall removes only this add-on and the file it wrote", { skip }, () => {
  const s = sandbox();
  s.setExts(["/x/other.ts"]);
  s.install("install", "--glitch", s.glitch);
  const r = s.install("uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.exts(), ["/x/other.ts"]);
  assert.equal(fs.existsSync(path.join(s.agent, "glitch-adapter.json")), false);
});

test("uninstall leaves a trusted-folders file it did not write", { skip }, () => {
  const s = sandbox();
  s.install("install", "--glitch", s.glitch);
  fs.writeFileSync(path.join(s.agent, "glitch-adapter.json"), JSON.stringify({ roots: [s.glitch] }));
  s.install("uninstall");
  assert.equal(fs.existsSync(path.join(s.agent, "glitch-adapter.json")), true);
});
