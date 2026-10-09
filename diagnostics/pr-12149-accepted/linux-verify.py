"""Reviewed command package only; CEO must authorize external execution."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time

repo = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
pin = json.loads(Path(__file__).with_name("source-identity.json").read_text())
assert platform.system() == "Linux", "Linux is required"
assert not out.exists(), "Use a new evidence directory"
out.mkdir(parents=True)
home = Path(tempfile.mkdtemp(prefix="golaa-40580-linux-"))
env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(home),
       "PAPERCLIP_HOME": str(home / "paperclip"), "NO_COLOR": "1",
       "CI": "true"}
# Tool caches are allowed; no provider/API/production environment is inherited.
for key in ("CARGO_HOME", "RUSTUP_HOME", "COREPACK_HOME", "PNPM_HOME"):
    if key in os.environ:
        env[key] = os.environ[key]


def run(label, args, cwd=repo):
    start = time.time()
    with (out / (label + ".log")).open("w") as log:
        log.write(json.dumps({"command": args, "cwd": str(cwd)}) + "\n")
        log.flush()
        result = subprocess.run(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    (out / (label + "-exit.json")).write_text(json.dumps({
        "command": args, "cwd": str(cwd), "exitCode": result.returncode,
        "seconds": time.time() - start,
    }, indent=2))
    if result.returncode:
        raise SystemExit(result.returncode)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=repo, env=env, text=True).strip()


assert git("rev-parse", "HEAD") == pin["candidate"]
assert git("rev-parse", "HEAD^{tree}") == pin["tree"]
assert not git("status", "--porcelain"), "Candidate must be clean"
assert not (repo / "node_modules").exists(), "Pristine install requires a fresh checkout"
assert subprocess.check_output(["node", "--version"], env=env, text=True).strip() == "v24.13.1"
assert subprocess.check_output(["corepack", "pnpm", "--version"], env=env, text=True).strip() == "9.15.4"
lock = repo / "pnpm-lock.yaml"
before = hashlib.sha256(lock.read_bytes()).hexdigest()
assert before == pin["lockSha256"]
try:
    run("versions", ["node", "--version"])
    run("pnpm-version", ["corepack", "pnpm", "--version"])
    run("rust-version", ["rustc", "--version"])
    run("cargo-version", ["cargo", "--version"])
    run("install", ["corepack", "pnpm", "--filter", "@paperclipai/server...",
                    "--filter", "@paperclipai/adapter-cursor-local...", "install",
                    "--frozen-lockfile", "--ignore-scripts"])
    assert hashlib.sha256(lock.read_bytes()).hexdigest() == before
    run("plugin-build-deps", ["corepack", "pnpm", "--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"])
    runner = repo / "packages/paperclip-runner"
    run("runner-typescript", ["corepack", "pnpm", "build:typescript"], runner)
    run("runner-native", ["cargo", "build", "--manifest-path", "runner/Cargo.toml", "--locked", "--workspace", "--bins"], runner)
    binary = runner / "runner/target/debug/paperclip-runnerd"
    assert binary.is_file()
    env["PAPERCLIP_ATTACH_TRANSITION_RUNNER"] = str(binary)
    (out / "native-binary-sha256.txt").write_text(hashlib.sha256(binary.read_bytes()).hexdigest() + "\n")
    checks = [
        ("warm-attach", runner, "src/live/runnerd-codex-transport.test.ts",
         "preserves old warm-attach authority and event ownership", 4),
        ("directory-fsync", runner, "src/control-plane/durable-prp-control-plane.test.ts",
         "fails closed after a warm receipt rename", 1),
        ("successor-reuse", repo / "server", "src/__tests__/heartbeat-retry-scheduling.test.ts",
         "coalesces .* duplicate max-turn|denies exact successor reuse", 16),
    ]
    for label, cwd, path, pattern, count in checks:
        report = out / (label + ".json")
        run(label, ["corepack", "pnpm", "exec", "vitest", "run", path, "-t", pattern,
                    "--reporter=verbose", "--reporter=json", "--outputFile=" + str(report)], cwd)
        data = json.loads(report.read_text())
        selected = [test for suite in data["testResults"] for test in suite["assertionResults"]
                    if test["status"] == "passed"]
        assert len(selected) == count, (label, "Required cases did not all pass", len(selected), count)
    run("server-typecheck", ["corepack", "pnpm", "exec", "tsc", "--noEmit"], repo / "server")
    assert not git("status", "--porcelain"), "Verification changed tracked source"
finally:
    (out / "environment.json").write_text(json.dumps({
        "platform": platform.platform(), "candidate": pin["candidate"], "tree": pin["tree"],
        "lockBeforeSha256": before, "lockAfterSha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "environmentNames": sorted(env), "testHome": str(home),
    }, indent=2))
    manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.is_file()}
    (out / "MANIFEST.json").write_text(json.dumps(manifest, indent=2))
