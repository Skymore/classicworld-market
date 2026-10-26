"""Deployment boundary checks use synthetic artifacts and never contact production."""
import json
import time
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

import deploy_market as deployment


SHA = "a" * 40
PREVIOUS = "b" * 40


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def bundle(self):
        source = self.root / "source"
        for name in deployment.REQUIRED:
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic test only")
        output = self.root / "artifact"
        deployment.package(source, source / "bin/market-web.exe", output, SHA)
        return output

    def test_tampered_or_extra_files_and_wrong_commit_are_rejected(self):
        artifact = self.bundle()
        deployment.verify_bundle(artifact, SHA)
        with self.assertRaises(ValueError):
            deployment.verify_bundle(artifact, PREVIOUS)
        extra = artifact / "web/credentials.txt"
        extra.write_text("synthetic")
        with self.assertRaisesRegex(ValueError, "file list"):
            deployment.verify_bundle(artifact, SHA)
        extra.unlink()
        (artifact / "bin/market-web.exe").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            deployment.verify_bundle(artifact, SHA)

    def test_routine_deploy_skips_database_backup_and_high_risk_deploy_requests_it(self):
        artifact = self.bundle()
        data = self.root / "shared_data"
        deployment.write_json(data / "supervisor_status.json",
                              {"deployment_support": 1, "time": time.time()})
        deployment.write_json(data / "native-runtime.json",
                              {"enabled": True, "database_url": "synthetic"})
        for required in [False, True]:
            with self.subTest(backup_required=required), \
                    patch.object(deployment, "web_runtime", return_value=(None, None, PREVIOUS)), \
                    patch.object(deployment, "backup_database", return_value=data / "backup.pgdump") as backup, \
                    patch.object(deployment, "wait_for_health"), \
                    patch.object(deployment, "activate", return_value=PREVIOUS), \
                    patch.object(deployment.socket, "socket"), \
                    patch.object(deployment.subprocess, "Popen") as popen, \
                    patch.object(deployment.urllib.request, "urlopen") as request:
                popen.return_value.poll.return_value = 0
                response = request.return_value.__enter__.return_value
                response.status = 200
                response.read.return_value = b"synthetic"
                deployment.deploy(self.root, artifact, SHA,
                                  backup_database_before_deploy=required)
                if required:
                    backup.assert_called_once_with(self.root, {"enabled": True, "database_url": "synthetic"}, SHA)
                else:
                    backup.assert_not_called()
                status = json.loads((data / "deploy/status.json").read_text())
                self.assertEqual(status["database_backup"], str(data / "backup.pgdump") if required else None)

    def test_path_escape_is_rejected_before_reading_external_file(self):
        artifact = self.bundle()
        manifest = json.loads((artifact / "manifest.json").read_text())
        manifest["files"]["../outside"] = "0" * 64
        deployment.write_json(artifact / "manifest.json", manifest)
        with self.assertRaises(ValueError):
            deployment.verify_bundle(artifact, SHA)

    def test_package_records_main_and_the_explicit_production_baseline(self):
        artifact = self.bundle()
        output = self.root / "second-artifact"
        deployment.package(self.root / "source", artifact / "bin/market-web.exe", output, SHA, PREVIOUS)
        manifest = deployment.verify_bundle(output, SHA)
        self.assertEqual(manifest["source_branch"], "main")
        self.assertEqual(manifest["base_release"], PREVIOUS)

    def test_served_files_must_match_the_git_source_not_only_the_bundle_manifest(self):
        def git(*args):
            return subprocess.check_output(["git", "-c", "user.name=Deployment Test", "-c",
                "user.email=test@example.invalid", *args], cwd=self.root).decode().strip()
        git("init", "--quiet")
        source = self.root / "web/app.js"
        source.parent.mkdir()
        source.write_bytes(b"current();\n")
        git("add", "web/app.js")
        git("commit", "--quiet", "-m", "current source")
        commit = git("rev-parse", "HEAD")
        release = self.root / "artifact"
        actual = release / "web/app.js"
        actual.parent.mkdir(parents=True)
        actual.write_bytes(b"current();\r\n")
        manifest = {"files": {"web/app.js": "verified separately"}}
        deployment.verify_git_web_sources(self.root, release, commit, manifest)
        actual.write_bytes(b"stale();\n")
        with self.assertRaisesRegex(RuntimeError, "differs from main: web/app.js"):
            deployment.verify_git_web_sources(self.root, release, commit, manifest)
        actual.write_bytes(b"current();\n")
        manifest["files"]["web/uncommitted.js"] = "verified separately"
        with self.assertRaisesRegex(RuntimeError, "not recorded in main"):
            deployment.verify_git_web_sources(self.root, release, commit, manifest)

    def test_failed_activation_restores_previous_release_and_checks_it(self):
        pointer = self.root / "shared_data/deploy/current.json"
        previous = {"schema": 1, "commit": PREVIOUS, "activated_at": 1}
        deployment.write_json(pointer, previous)
        with patch.object(deployment, "wait_for_release", side_effect=[RuntimeError("not ready"), None]) as wait:
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                deployment.activate(self.root, SHA)
        self.assertEqual(json.loads(pointer.read_text()), previous)
        self.assertEqual([call.args[1] for call in wait.call_args_list], [SHA, PREVIOUS])

    def test_failed_first_activation_restores_original_runtime(self):
        with patch.object(deployment, "wait_for_release", side_effect=[RuntimeError("failed"), None]) as wait:
            with self.assertRaises(RuntimeError):
                deployment.activate(self.root, SHA)
        self.assertFalse((self.root / "shared_data/deploy/current.json").exists())
        self.assertEqual(wait.call_args.args[1], "legacy")
        self.assertEqual(deployment.web_runtime(self.root)[2], "legacy")

    def test_release_pointer_cannot_select_an_arbitrary_executable(self):
        deployment.write_json(self.root / "shared_data/deploy/current.json", {"commit": "../../elsewhere"})
        with self.assertRaises(ValueError):
            deployment.web_runtime(self.root)

    def test_activation_rejects_a_bundle_prepared_for_another_active_version(self):
        pointer = self.root / "shared_data/deploy/current.json"
        previous = {"schema": 1, "commit": PREVIOUS, "activated_at": 1}
        deployment.write_json(pointer, previous)
        deployment.write_json(self.root / "shared_data/deploy/releases" / SHA / "manifest.json",
                              {"base_release": "c" * 40})
        with patch.object(deployment, "wait_for_release") as wait:
            with self.assertRaisesRegex(RuntimeError, "Active release changed"):
                deployment.activate(self.root, SHA)
        wait.assert_not_called()
        self.assertEqual(json.loads(pointer.read_text()), previous)

    def test_local_overlay_requires_committed_source_including_the_active_version(self):
        def git(*args, data=None):
            return subprocess.check_output(["git", "-c", "user.name=Deployment Test", "-c",
                "user.email=test@example.invalid", *args], cwd=self.root, input=data).decode().strip()
        git("init", "--quiet")
        tree = git("mktree", data=b"")
        previous = git("commit-tree", tree, data=b"active version\n")
        divergent = git("commit-tree", tree, data=b"stale source\n")
        merged = git("commit-tree", tree, "-p", previous, data=b"merged fix\n")
        pointer = self.root / "shared_data/deploy/current.json"
        deployment.write_json(pointer, {"schema": 1, "commit": previous})
        for commit, error in [(SHA, "not committed"), (divergent, "omits the active version")]:
            git("update-ref", "refs/heads/main", commit if commit != SHA else previous)
            deployment.write_json(self.root / "shared_data/deploy/releases" / commit / "manifest.json",
                                  {"base_release": previous, "source_branch": "main"})
            with patch.object(deployment, "wait_for_release") as wait:
                with self.assertRaisesRegex(RuntimeError, error):
                    deployment.activate(self.root, commit)
                wait.assert_not_called()
            self.assertEqual(json.loads(pointer.read_text())["commit"], previous)
        deployment.write_json(self.root / "shared_data/deploy/releases" / merged / "manifest.json",
                              {"base_release": previous, "source_branch": "main"})
        git("update-ref", "refs/heads/main", previous)
        with patch.object(deployment, "wait_for_release") as wait:
            with self.assertRaisesRegex(RuntimeError, "must match main"):
                deployment.activate(self.root, merged)
            wait.assert_not_called()
        git("update-ref", "refs/heads/main", merged)
        with patch.object(deployment, "wait_for_release"):
            self.assertEqual(deployment.activate(self.root, merged), previous)
        self.assertEqual(json.loads(pointer.read_text())["commit"], merged)

    def test_relocated_web_keeps_local_google_credentials_out_of_artifact(self):
        credential = self.root / "shared_data/google-oauth.json"
        deployment.write_json(credential, {"synthetic": True})
        env = deployment.web_environment(self.root, {"database_url": "synthetic"}, self.root / "release/web")
        self.assertEqual(env["GOOGLE_OAUTH_CONFIG"], str(credential))
        self.assertEqual(env["BIND"], "127.0.0.1:8766")
        self.assertEqual(env["COLLECTOR_RELEASE_DIR"], str(self.root / "web/releases"))

    def test_relocated_web_uses_private_openrouter_config_without_reading_its_key(self):
        credential = self.root / "shared_data/openrouter.json"
        deployment.write_json(credential, {"api_key": "fixture-key-only", "model": "openrouter/free"})
        with patch.dict(deployment.os.environ, {}, clear=True):
            env = deployment.web_environment(self.root, {"database_url": "synthetic"}, self.root / "release/web")
        self.assertEqual(env["OPENROUTER_CONFIG"], str(credential))
        self.assertNotIn("OPENROUTER_API_KEY", env)

    def test_site_package_does_not_bundle_collector_downloads(self):
        releases = self.root / "source/web/releases"
        releases.mkdir(parents=True)
        (releases / "old.zip").write_bytes(b"separate published download")
        artifact = self.bundle()
        self.assertFalse((artifact / "web/releases").exists())


if __name__ == "__main__":
    unittest.main()
