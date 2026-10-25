"""Build and verify a self-contained, windowed Python recorder executable."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--shortcut", type=Path, help="Shortcut path; defaults to the project directory")
    args = parser.parse_args()
    sources = ["record_gameplay.py", "gameplay_recording.py", "gameplay_windows.py",
               "gameplay_status.py", "gameplay_overlay.py", "gameplay_smoke.py",
               "requirements-gameplay.txt", "requirements-gameplay-build.txt", "assets/app-icon.ico",
               "build_gameplay_recorder.py", "build_gameplay_recorder.ps1", "GAMEPLAY_RECORDER.md"]

    def source_hashes():
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sources}

    hashes = source_hashes()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--", *sources], cwd=root, text=True))
    destination = (args.destination or root / "dist" / ("gameplay-" + time.strftime("%Y%m%d-%H%M%S"))).resolve()
    # Build only into a new folder: existing apps and recordings are never removed.
    destination.mkdir(parents=True, exist_ok=False)
    command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--onedir", "--windowed",
               "--name", "GameplayRecorder", "--distpath", str(destination),
               "--workpath", str(root / "build" / "gameplay-pyinstaller"), "--specpath", str(destination),
               "--icon", str(root / "assets" / "app-icon.ico"),
               "--collect-submodules", "dxcam", "--collect-submodules", "comtypes",
               "--exclude-module", "comtypes.test", "--exclude-module", "PIL.AvifImagePlugin",
               "--exclude-module", "pytest"]
    for distribution in ("dxcam", "opencv-python-headless", "numpy", "Pillow", "comtypes"):
        command += ["--copy-metadata", distribution]
    command += [str(root / "record_gameplay.py")]
    subprocess.run(command, cwd=root, check=True)
    bundle = destination / "GameplayRecorder"
    executable = bundle / "GameplayRecorder.exe"
    checks = []
    for flag in ("--self-test", "--desktop-self-test"):
        report = destination / (flag.strip("-") + ".json")
        result = subprocess.run([str(executable), flag, "--output", str(destination / "test-recordings"),
                                 "--report", str(report)], timeout=45)
        data = json.loads(report.read_text(encoding="utf-8")) if report.exists() else {}
        if result.returncode or not data.get("ok"):
            raise RuntimeError(f"Packaged {flag} failed: {data}")
        checks.append(data)
    shutil.copy2(root / "GAMEPLAY_RECORDER.md", bundle / "GAMEPLAY_RECORDER.md")
    if hashes != source_hashes() or commit != subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip():
        raise RuntimeError("Sources changed during build; rebuild before using this package")
    manifest = dict(source_commit=commit, source_dirty=dirty,
                    sources=hashes,
                    files={str(path.relative_to(bundle)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in sorted(bundle.rglob("*")) if path.is_file()}, tests=checks)
    (bundle / "build-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    from comtypes.client import CreateObject
    shortcut_path = (args.shortcut or root / "游戏操作录制.lnk").resolve()
    shell = CreateObject("WScript.Shell", dynamic=True)
    shortcut = shell.CreateShortcut(str(shortcut_path))
    shortcut.TargetPath = str(executable)
    shortcut.Arguments = subprocess.list2cmdline(["--output", str(shortcut_path.parent / "shared_data" / "gameplay_recordings")])
    shortcut.WorkingDirectory = str(bundle)
    shortcut.Description = "游戏操作录制 · 20 Hz"
    shortcut.IconLocation = str(executable) + ",0"
    shortcut.Save()
    print(executable)


if __name__ == "__main__":
    main()
