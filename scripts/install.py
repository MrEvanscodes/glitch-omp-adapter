#!/usr/bin/env python3
"""Install, check or remove Glitch for omp. Standard library only; run it with uv (Glitch needs uv anyway):

    uv run --no-project python scripts/install.py install   [--glitch DIR]... [--dry-run]
    uv run --no-project python scripts/install.py status
    uv run --no-project python scripts/install.py trust     DIR [--dry-run]
    uv run --no-project python scripts/install.py untrust   DIR [--dry-run]
    uv run --no-project python scripts/install.py uninstall [--dry-run]

What it touches, and nothing else:
  1. omp's `extensions` setting: this add-on is ADDED to the list. Extensions you already have stay.
     (An older copy of this add-on, or one from a moved folder, is replaced so it never runs twice.)
  2. A small trusted-folders list, `<omp agent dir>/glitch-adapter.json`: the Glitch folders in which the
     add-on may run their hooks. Any other Glitch-looking folder (a friend's fork, a download) is ignored.
It never changes your models, your approval mode, your logins or anything inside a Glitch folder.

Before it changes anything it copies the old settings into `<omp agent dir>/glitch-adapter-backups/`.
`--dry-run` shows what would change and writes nothing. Running `install` twice changes nothing the second time.
Set PI_CODING_AGENT_DIR to point it at a different omp settings folder (the tests do).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ADAPTER = Path(__file__).resolve().parent.parent
EXT = ADAPTER / "src" / "glitch.ts"
MARKER = "glitch-omp-adapter"
FIRST_LINE = "// glitch.ts - Glitch for omp"


def agent_dir() -> Path:
    return Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".omp" / "agent").expanduser()


def trust_path() -> Path:
    return Path(os.environ.get("GLITCH_OMP_TRUST_FILE") or agent_dir() / "glitch-adapter.json").expanduser()


def backup_dir() -> Path:
    return agent_dir() / "glitch-adapter-backups"


def die(msg: str, code: int = 1) -> "None":
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def omp_bin() -> str:
    found = shutil.which("omp")
    if not found:
        die("omp was not found. Make sure `omp --version` works in this terminal, then run this again.")
    return found


def current_extensions(omp: str) -> list:
    r = subprocess.run([omp, "config", "get", "extensions"], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    try:
        value = json.loads(r.stdout.strip() or "[]")
    except json.JSONDecodeError:
        value = None
    if r.returncode != 0 or not isinstance(value, list):
        die("could not read omp's current extension list, so nothing was changed. " + (r.stderr.strip()[:200] or r.stdout.strip()[:200]))
    return value


def set_extensions(omp: str, entries: list) -> None:
    r = subprocess.run([omp, "config", "set", "extensions", json.dumps(entries)], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        die("omp refused the new extension list: " + (r.stderr.strip()[:300] or r.stdout.strip()[:300]))


def same_file(a: str, b: Path) -> bool:
    try:
        return Path(a).expanduser().resolve() == b.resolve()
    except OSError:
        return False


def is_this_addon(entry: object) -> bool:
    """This add-on, wherever a copy of it lives (so a moved or re-downloaded folder is replaced, not doubled)."""
    if not isinstance(entry, str):
        return False
    p = Path(entry).expanduser()
    if same_file(entry, EXT):
        return True
    if p.name == "glitch.ts" and p.parent.name == "src" and p.parent.parent.name.startswith(MARKER):
        return True
    try:
        with open(p, encoding="utf8") as f:
            return f.readline().startswith(FIRST_LINE)
    except OSError:
        return False


def is_glitch(path: Path) -> bool:
    return (path / "CLAUDE.md").is_file() and (path / ".claude" / "hooks" / "write-guard.py").is_file()


def read_trust() -> tuple[list[str], str]:
    """(roots, state) where state is 'none' (no file), 'ok', or 'broken' (exists but unreadable)."""
    p = trust_path()
    if not p.exists():
        return [], "none"
    try:
        data = json.loads(p.read_text(encoding="utf8"))
        roots = data.get("roots")
        if not isinstance(roots, list):
            raise ValueError("roots is not a list")
        return [str(Path(r).expanduser().resolve()) for r in roots if isinstance(r, str) and r.strip()], "ok"
    except (OSError, ValueError, AttributeError):
        return [], "broken"


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(text, encoding="utf8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def trust_text(roots: list[str]) -> str:
    return json.dumps({"written_by": MARKER, "roots": sorted(set(roots))}, indent=2) + "\n"


def backup(files: list[Path]) -> list[Path]:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    made = []
    for f in files:
        if f.exists():
            dest = backup_dir() / f"{f.name}.{stamp}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            os.chmod(dest, 0o600)
            made.append(dest)
    return made


def resolve_glitch(dirs: list[str]) -> list[str]:
    chosen = dirs or [str(Path.home() / "Glitch")]
    out = []
    for d in chosen:
        p = Path(d).expanduser().resolve()
        if not is_glitch(p):
            die(f"{p} does not look like a Glitch folder (it needs CLAUDE.md and .claude/hooks/write-guard.py). "
                "If yours is somewhere else, add:  --glitch /path/to/your/Glitch")
        out.append(str(p))
    return out


def warnings() -> None:
    odd = [w for w in ("Downloads", "OneDrive", "Dropbox", "Mobile Documents", "iCloud") if w in str(ADAPTER)]
    if odd:
        print(f"note: this folder is inside a place that syncs or gets cleaned up ({', '.join(odd)}). "
              "omp is pointed at this exact folder, so move it somewhere ordinary (like your home folder) first.")
    if ADAPTER.name != MARKER:
        print(f"note: the folder is called '{ADAPTER.name}', not '{MARKER}'. The add-on itself does not mind; "
              "the optional Tern plugin expects it at ~/glitch-omp-adapter.")


def cmd_install(glitch_dirs: list[str], dry: bool) -> int:
    omp = omp_bin()
    if not EXT.is_file():
        die(f"{EXT} is missing: this folder is incomplete. Download it again.")
    warnings()
    glitch = resolve_glitch(glitch_dirs)
    before = current_extensions(omp)
    kept = [e for e in before if not is_this_addon(e)]
    # Keep our place in the list if we are already in it; otherwise go last so your other extensions run first.
    after = [str(EXT) if is_this_addon(e) else e for e in before] if any(is_this_addon(e) for e in before) else kept + [str(EXT)]
    # More than one copy of us in the list would run every guard twice.
    seen, deduped = False, []
    for e in after:
        if e == str(EXT):
            if seen:
                continue
            seen = True
        deduped.append(e)
    after = deduped
    roots, state = read_trust()
    new_roots = sorted(set(roots) | set(glitch))
    ext_change = before != after
    trust_change = state != "ok" or set(new_roots) != set(roots)

    print(f"omp:            {omp}")
    print(f"omp settings:   {agent_dir()}")
    print(f"extensions now: {json.dumps(before)}")
    print(f"extensions new: {json.dumps(after)}" if ext_change else "extensions new: (no change, already installed)")
    print(f"trusted folders: {new_roots}" + ("" if trust_change else "  (no change)"))
    if state == "broken":
        print("note: the old trusted-folders file could not be read; it will be replaced (a copy is kept in the backups).")
    if dry:
        print("\ndry run: nothing was written.")
        return 0
    if not ext_change and not trust_change:
        print("\nAlready installed. Nothing changed.")
        return 0

    made = backup([agent_dir() / "config.yml", trust_path()])
    if ext_change:
        set_extensions(omp, after)
    if trust_change:
        write_atomic(trust_path(), trust_text(new_roots))
    if str(EXT) not in current_extensions(omp):
        die("omp did not keep the setting. Your old settings are saved in " + str(backup_dir()))
    for m in made:
        print(f"backup:         {m}")
    print("\ninstalled.")
    print("Next: open a NEW omp chat inside your Glitch folder (chats that were already open do not pick it up).")
    print("Then check it:  uv run --no-project python scripts/install.py status")
    print("One thing to know: omp's default is to run commands without asking first. Glitch's guards still apply,")
    print("but if you would like omp itself to ask before running commands:  omp config set tools.approvalMode write")
    return 0


def cmd_trust(dirs: list[str], add: bool, dry: bool) -> int:
    paths = resolve_glitch(dirs) if add else [str(Path(d).expanduser().resolve()) for d in dirs]
    roots, state = read_trust()
    new = sorted(set(roots) | set(paths)) if add else sorted(set(roots) - set(paths))
    verb = "add" if add else "remove"
    print(f"trusted folders: {roots}  ->  {new}")
    if state == "none" and add:
        print("note: there was no list before, so from now on ONLY the folders on this list run Glitch's hooks.")
    if dry:
        print("dry run: nothing was written.")
        return 0
    if new == roots and state == "ok":
        print(f"Nothing to {verb}.")
        return 0
    made = backup([trust_path()])
    write_atomic(trust_path(), trust_text(new))
    for m in made:
        print(f"backup: {m}")
    print("done. It takes effect at once, in every open chat.")
    return 0


def cmd_status() -> int:
    omp = omp_bin()
    bad = 0

    def line(ok: bool, text: str, fix: str = "") -> None:
        nonlocal bad
        if not ok:
            bad += 1
        print(f"  {'ok  ' if ok else 'FAIL'}  {text}" + (f"\n          fix: {fix}" if (fix and not ok) else ""))

    version = subprocess.run([omp, "--version"], capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout.strip()
    print("Glitch for omp: status\n")
    print(f"  omp   {version}   (the tested version is 18.20.3)")
    exts = current_extensions(omp)
    here = [e for e in exts if is_this_addon(e)]
    line(len(here) == 1 and same_file(here[0], EXT), "omp loads this add-on, once", "uv run --no-project python scripts/install.py install")
    roots, state = read_trust()
    if state == "none":
        print("  note  no trusted-folders list: the add-on runs in ANY Glitch-looking folder.  Fix: run install.")
    elif state == "broken":
        line(False, "the trusted-folders list cannot be read, so NO folder is trusted", "uv run --no-project python scripts/install.py install")
    else:
        print(f"  ok    trusted folders: {', '.join(roots) or '(none)'}")
        for r in roots:
            line(is_glitch(Path(r)), f"{r} is a Glitch folder", f"uv run --no-project python scripts/install.py untrust '{r}'")
    line(shutil.which("uv") is not None, "uv is installed (Glitch's guards run on it)", "see https://docs.astral.sh/uv/")
    if shutil.which("node"):
        print("  ok    node found: the self-check works ->  node scripts/doctor.mjs  (needs Node 22.18 or newer)")
    else:
        print("  note  node not found. It is only needed for the self-check (node scripts/doctor.mjs), not for using Glitch.")
    mode = subprocess.run([omp, "config", "get", "tools.approvalMode"], capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout.strip()
    print(f"  note  omp approval mode: {mode or 'unknown'}  (yolo = omp runs commands without asking; Glitch's guards still apply)")
    print("\n" + ("All good." if not bad else f"{bad} problem{'s' if bad > 1 else ''}."))
    return 1 if bad else 0


def cmd_uninstall(dry: bool) -> int:
    omp = omp_bin()
    before = current_extensions(omp)
    after = [e for e in before if not is_this_addon(e)]
    roots, state = read_trust()
    ours = False
    if trust_path().exists():
        try:
            ours = json.loads(trust_path().read_text(encoding="utf8")).get("written_by") == MARKER
        except (OSError, ValueError, AttributeError):
            ours = False
    print(f"extensions now: {json.dumps(before)}\nextensions new: {json.dumps(after)}")
    print(f"trusted-folders file: {'will be removed (a copy is kept)' if ours else 'left alone'}")
    if dry:
        print("dry run: nothing was written.")
        return 0
    if before == after and not ours:
        print("Nothing to remove.")
        return 0
    made = backup([agent_dir() / "config.yml", trust_path()])
    if before != after:
        set_extensions(omp, after)
    if ours:
        trust_path().unlink()
    for m in made:
        print(f"backup: {m}")
    print("uninstalled. Glitch itself and your other omp settings were not touched.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Install, check or remove Glitch for omp.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("install", help="add the add-on to omp and trust your Glitch folder")
    i.add_argument("--glitch", action="append", default=[], metavar="DIR", help="your Glitch folder (default ~/Glitch); repeat for more")
    i.add_argument("--dry-run", action="store_true")
    sub.add_parser("status", help="check the setup")
    for name, help_ in (("trust", "let the add-on run in another Glitch folder"), ("untrust", "stop the add-on running in a folder")):
        t = sub.add_parser(name, help=help_)
        t.add_argument("dir", nargs="+")
        t.add_argument("--dry-run", action="store_true")
    u = sub.add_parser("uninstall", help="remove the add-on from omp")
    u.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.cmd == "install":
        return cmd_install(a.glitch, a.dry_run)
    if a.cmd == "status":
        return cmd_status()
    if a.cmd in ("trust", "untrust"):
        return cmd_trust(a.dir, a.cmd == "trust", a.dry_run)
    return cmd_uninstall(a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
