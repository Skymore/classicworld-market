"""Build immutable site bundles and deploy CI artifacts through the local supervisor."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.request
from urllib.parse import unquote, urlsplit


COMMIT = re.compile(r"[0-9a-f]{40}")
REQUIRED = {"bin/market-web.exe", "web/index.html", "web/js/app.js",
            "web/collect/pkg/market_reader_wasm_bg.wasm"}
CHUNKS = "web/react/chunks"
VITE_MANIFEST = "web/react/.vite/manifest.json"
# Builds keep old chunks (emptyOutDir false), so the checkout holds every
# chunk ever built. A release takes those of the current build and of the
# KEPT_BUILDS frontend builds before it (the manifest's git history): a page
# opened before a deploy can still load its lazy routes, and the release
# does not copy 1000+ dead files.
KEPT_BUILDS = 3


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".pending")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_commit(commit):
    if not COMMIT.fullmatch(commit):
        raise ValueError("A full lowercase Git commit SHA is required")
    return commit


def verify_bundle(folder, commit):
    folder = Path(folder).resolve()
    check_commit(commit)
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or manifest.get("commit") != commit:
        raise ValueError("Artifact does not match the successful workflow commit")
    files = manifest.get("files", {})
    if not isinstance(files, dict) or not REQUIRED.issubset(files):
        raise ValueError("Incomplete site artifact")
    actual = set()
    for path in folder.rglob("*"):
        if path.is_symlink() or not path.resolve().is_relative_to(folder):
            raise ValueError("Artifact links are not supported")
        if path.is_file() and path != folder / "manifest.json":
            actual.add(path.relative_to(folder).as_posix())
    if actual != set(files):
        raise ValueError("Artifact file list differs from the manifest")
    for name, expected in files.items():
        path = folder / name
        if "\\" in name or not path.resolve().is_relative_to(folder):
            raise ValueError("Artifact path escapes its directory")
        if not (name == "bin/market-web.exe" or name.startswith("web/")):
            raise ValueError("Unexpected artifact path")
        if digest(path) != expected:
            raise ValueError(f"Artifact hash mismatch: {name}")
    return manifest


def manifest_chunks(text):
    """Chunk file names a Vite manifest references."""
    files = set()
    for entry in json.loads(text).values():
        files.add(entry["file"])
        files.update(entry.get("css", []))
        files.update(entry.get("assets", []))
    return {name.removeprefix("chunks/") for name in files if name.startswith("chunks/")}


def kept_chunks(root, builds=KEPT_BUILDS):
    """Chunks of the current build and the `builds` before it; None keeps all
    (no manifest, or one that cannot be read). Without git history only the
    current build's are known."""
    root = Path(root)
    try:
        texts = [(root / VITE_MANIFEST).read_text(encoding="utf-8")]
    except OSError:
        return None
    def git(*args):
        try:
            done = subprocess.run(["git", *args], cwd=root, capture_output=True,
                                  text=True, encoding="utf-8")
        except OSError:
            return None
        return done.stdout if done.returncode == 0 else None

    for revision in (git("log", "--format=%H", "--", VITE_MANIFEST) or "").split():
        if len(texts) > builds:
            break
        shown = git("show", f"{revision}:{VITE_MANIFEST}")
        # A Windows checkout may have CRLF; the build is the same.
        if shown is not None and shown.replace("\r\n", "\n") not in [t.replace("\r\n", "\n") for t in texts]:
            texts.append(shown)
    try:
        return set().union(*(manifest_chunks(text) for text in texts))
    except (ValueError, KeyError, TypeError, AttributeError):
        return None


def keep_modification_times(release, previous):
    """Files unchanged since the previous release keep its modification time,
    so their Last-Modified does not move with each deploy. Both manifests
    record every file's digest. Returns how many were kept."""
    try:
        old = json.loads((Path(previous) / "manifest.json").read_text(encoding="utf-8"))["files"]
        new = json.loads((Path(release) / "manifest.json").read_text(encoding="utf-8"))["files"]
    except (OSError, ValueError, KeyError, TypeError):
        return 0
    kept = 0
    for name, expected in new.items():
        if name.startswith("web/") and old.get(name) == expected:
            try:
                source = (Path(previous) / name).stat()
                os.utime(Path(release) / name, ns=(source.st_atime_ns, source.st_mtime_ns))
            except OSError:
                continue
            kept += 1
    return kept


def package(root, binary, output, commit, base_release=None):
    check_commit(commit)
    root, output = Path(root), Path(output)
    # A build must never silently mix files from a previous package.
    output.mkdir(parents=True, exist_ok=False)
    (output / "bin").mkdir()
    shutil.copy2(binary, output / "bin/market-web.exe")
    keep = kept_chunks(root)

    def ignore(folder, names):
        if Path(folder) == root / "web":
            return ["releases"]
        if keep is not None and Path(folder) == root / CHUNKS:
            return [name for name in names if name.removesuffix(".gz") not in keep]
        return []

    shutil.copytree(root / "web", output / "web", ignore=ignore)
    files = {p.relative_to(output).as_posix(): digest(p)
             for p in sorted(output.rglob("*")) if p.is_file()}
    manifest = {"schema": 1, "commit": commit, "files": files, "source_branch": "main"}
    pointer = root / "shared_data/deploy/current.json"
    if base_release is not None:
        manifest["base_release"] = check_commit(base_release) if base_release != "legacy" else "legacy"
    elif pointer.is_file():
        manifest["base_release"] = check_commit(json.loads(pointer.read_text(encoding="utf-8"))["commit"])
    write_json(output / "manifest.json", manifest)
    verify_bundle(output, commit)


def web_runtime(root):
    """Return only paths inside the known release store, or the original runtime."""
    root = Path(root).resolve()
    pointer = root / "shared_data/deploy/current.json"
    if not pointer.exists():
        return root / "server/target/release/market-web.exe", root / "web", "legacy"
    commit = check_commit(json.loads(pointer.read_text(encoding="utf-8"))["commit"])
    release = root / "shared_data/deploy/releases" / commit
    binary, web = release / "bin/market-web.exe", release / "web"
    if not binary.is_file() or not (web / "index.html").is_file():
        raise ValueError("Active release is incomplete")
    return binary, web, commit


def web_environment(root, native, web, port=8766):
    env = dict(os.environ, DATABASE_URL=native["database_url"],
               BIND=f"127.0.0.1:{port}", PUBLIC_HOSTNAME="mxd.ruit.me",
               PUBLIC_READ="true", WEB_DIR=str(web),
               COLLECTOR_RELEASE_DIR=str(Path(root).resolve() / "web/releases"))
    oauth = Path(root) / "shared_data/google-oauth.json"
    if oauth.is_file():
        env["GOOGLE_OAUTH_CONFIG"] = str(oauth)
    openrouter = Path(root) / "shared_data/openrouter.json"
    if openrouter.is_file():
        env.setdefault("OPENROUTER_CONFIG", str(openrouter))
    # Passed even before the file exists: the service then creates the VAPID key.
    env.setdefault("WEB_PUSH_CONFIG", str(Path(root) / "shared_data/web_push.json"))
    return env


def healthy(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/readyz", timeout=3) as response:
        return response.status == 200 and json.load(response).get("status") == "ok"


def wait_for_health(port, process=None, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError("Candidate service exited before becoming ready; inspect candidate.log")
        try:
            if healthy(port):
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("Service readiness check timed out")


def backup_database(root, native, commit):
    address = urlsplit(native["database_url"])
    folder = root / "shared_data/backups"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"deploy-{time.strftime('%Y%m%d-%H%M%S')}-{commit[:12]}.pgdump"
    env = dict(os.environ, PGPASSWORD=unquote(address.password or ""))
    command = [str(root / "market_data/runtime/pgsql/bin/pg_dump.exe"),
               "-h", address.hostname, "-p", str(address.port or 5432),
               "-U", unquote(address.username or ""), "-d", address.path.lstrip("/"),
               "-Fc", "-f", str(target)]
    with (folder / "deploy-backup.log").open("ab") as log:
        subprocess.run(command, env=env, stdout=log, stderr=log, check=True,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    return target


def wait_for_release(root, commit, timeout=75):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status = json.loads((root / "shared_data/supervisor_status.json").read_text())
            if (time.time() - status["time"] < 20 and status.get("release") == commit
                    and status["children"]["web"]["running"] and healthy(8766)):
                return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(1)
    raise RuntimeError("Supervisor did not activate a healthy release")


def verify_git_web_sources(root, release, commit, manifest):
    """A real commit label must describe the web files actually being served."""
    files = [name for name in manifest.get("files", {})
             if name.startswith("web/") and not name.endswith(".gz")]
    if not files:
        return
    archive = subprocess.check_output(["git", "archive", commit, "web"], cwd=root)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        for name in files:
            try:
                entry = tree.getmember(name)
            except KeyError:
                raise RuntimeError(f"Release web file is not recorded in main: {name}") from None
            if not entry.isfile():
                raise RuntimeError(f"Release web file is not a recorded regular file: {name}")
            expected = tree.extractfile(entry).read()
            actual = (release / name).read_bytes()
            # Checkout line endings may differ on Windows. Binary files and
            # all other content must still match exactly.
            if b"\0" not in expected:
                expected = expected.replace(b"\r\n", b"\n")
                actual = actual.replace(b"\r\n", b"\n")
            if expected != actual:
                raise RuntimeError(f"Release web file differs from main: {name}")


def verify_activation_source(root, commit, previous_commit):
    """Local overlay releases must include the active, recorded source revision."""
    manifest = root / "shared_data/deploy/releases" / commit / "manifest.json"
    if not manifest.exists():
        return
    metadata = json.loads(manifest.read_text(encoding="utf-8"))
    base = metadata.get("base_release")
    local_source = (root / ".git").exists()
    if local_source and (base is None or metadata.get("source_branch") != "main"):
        raise RuntimeError("Local releases must declare source_branch main and the active base_release")
    if base is None:
        return
    if base != previous_commit:
        raise RuntimeError("Active release changed; merge the current production version before activation")
    if not local_source:
        return
    source = subprocess.run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=root,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if source.returncode:
        raise RuntimeError("Release source is not committed; record the source and built assets together")
    main = subprocess.run(["git", "rev-parse", "refs/heads/main"], cwd=root,
                          capture_output=True, text=True)
    if main.returncode or main.stdout.strip() != commit:
        raise RuntimeError("Release source must match main; merge the reviewed change before activation")
    if previous_commit != "legacy":
        included = subprocess.run(["git", "merge-base", "--is-ancestor", previous_commit, commit], cwd=root,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if included.returncode:
            raise RuntimeError("Release source omits the active version; merge current production changes first")
    verify_git_web_sources(root, manifest.parent, commit, metadata)


def activate(root, commit):
    pointer = root / "shared_data/deploy/current.json"
    previous = json.loads(pointer.read_text()) if pointer.exists() else None
    previous_commit = previous["commit"] if previous else "legacy"
    verify_activation_source(root, commit, previous_commit)
    write_json(pointer, {"schema": 1, "commit": commit, "activated_at": time.time()})
    try:
        wait_for_release(root, commit)
    except Exception:
        if previous is None:
            pointer.unlink(missing_ok=True)
        else:
            write_json(pointer, previous)
        wait_for_release(root, previous_commit)
        raise
    return previous_commit


def deploy(root, artifact, commit, *, backup_database_before_deploy=False):
    root, artifact = Path(root).resolve(), Path(artifact).resolve()
    verify_bundle(artifact, commit)
    data = root / "shared_data"
    status = json.loads((data / "supervisor_status.json").read_text())
    if status.get("deployment_support") != 1 or time.time() - status["time"] > 30:
        raise RuntimeError("Start the updated shared_supervisor.py before deploying")
    native = json.loads((data / "native-runtime.json").read_text())
    if not native.get("enabled"):
        raise RuntimeError("This deployment requires the native PostgreSQL runtime")
    active = web_runtime(root)[2]
    if active == commit:
        wait_for_release(root, commit)
        print(f"Already deployed {commit}")
        return
    release = data / "deploy/releases" / commit
    release.parent.mkdir(parents=True, exist_ok=True)
    # Interrupted copies are never activated or reused without verification.
    if not release.exists():
        pending = release.with_name(commit + ".pending-" + str(time.time_ns()))
        shutil.copytree(artifact, pending)
        verify_bundle(pending, commit)
        if active != "legacy":
            keep_modification_times(pending, data / "deploy/releases" / active)
        pending.rename(release)
    verify_bundle(release, commit)
    backup = backup_database(root, native, commit) if backup_database_before_deploy else None
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 18766))
    with (data / "deploy/candidate.log").open("ab") as log:
        candidate = subprocess.Popen([str(release / "bin/market-web.exe")], cwd=root,
            env=web_environment(root, native, release / "web", 18766), stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            wait_for_health(18766, candidate)
            for path in ("/", "/web/js/app.js", "/collect/pkg/market_reader_wasm_bg.wasm"):
                with urllib.request.urlopen("http://127.0.0.1:18766" + path, timeout=10) as response:
                    if response.status != 200 or not response.read(1):
                        raise RuntimeError("Candidate assets failed the smoke check")
        finally:
            if candidate.poll() is None:
                candidate.terminate()
                candidate.wait(timeout=15)
    previous = activate(root, commit)
    write_json(data / "deploy/status.json", {"commit": commit, "previous": previous,
               "deployed_at": time.time(), "database_backup": str(backup) if backup else None, "healthy": True})
    print(f"Deployed {commit}; previous={previous}; readiness=ok")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    bundle = sub.add_parser("package")
    bundle.add_argument("--root", default=str(Path(__file__).resolve().parent))
    bundle.add_argument("--binary", required=True)
    bundle.add_argument("--output", required=True)
    bundle.add_argument("--commit", required=True)
    bundle.add_argument("--base-release", help="Active production commit, for a build in a separate checkout")
    install = sub.add_parser("deploy")
    install.add_argument("--root", default=str(Path(__file__).resolve().parent))
    install.add_argument("--artifact", required=True)
    install.add_argument("--commit", required=True)
    install.add_argument("--backup-database", action="store_true",
                         help="Back up PostgreSQL before high-risk schema or data changes")
    args = parser.parse_args()
    if args.command == "package":
        package(args.root, args.binary, args.output, args.commit, args.base_release)
    else:
        deploy(args.root, args.artifact, args.commit,
               backup_database_before_deploy=args.backup_database)


if __name__ == "__main__":
    main()
