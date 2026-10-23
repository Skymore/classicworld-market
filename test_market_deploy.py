"""Deployment boundary checks use synthetic artifacts and never contact production."""
import json
from pathlib import Path
import tempfile
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

    def test_path_escape_is_rejected_before_reading_external_file(self):
        artifact = self.bundle()
        manifest = json.loads((artifact / "manifest.json").read_text())
        manifest["files"]["../outside"] = "0" * 64
        deployment.write_json(artifact / "manifest.json", manifest)
        with self.assertRaises(ValueError):
            deployment.verify_bundle(artifact, SHA)

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

    def test_relocated_web_keeps_local_google_credentials_out_of_artifact(self):
        credential = self.root / "shared_data/google-oauth.json"
        deployment.write_json(credential, {"synthetic": True})
        env = deployment.web_environment(self.root, {"database_url": "synthetic"}, self.root / "release/web")
        self.assertEqual(env["GOOGLE_OAUTH_CONFIG"], str(credential))
        self.assertEqual(env["BIND"], "127.0.0.1:8766")
        self.assertEqual(env["COLLECTOR_RELEASE_DIR"], str(self.root / "web/releases"))

    def test_site_package_does_not_bundle_collector_downloads(self):
        releases = self.root / "source/web/releases"
        releases.mkdir(parents=True)
        (releases / "old.zip").write_bytes(b"separate published download")
        artifact = self.bundle()
        self.assertFalse((artifact / "web/releases").exists())


if __name__ == "__main__":
    unittest.main()
