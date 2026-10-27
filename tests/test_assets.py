import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("promote_asset", REPO / "scripts/promote_asset.py")
ASSETS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSETS)


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="test-assets-", dir=REPO / "tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "contracts").mkdir()
        shutil.copyfile(REPO / ASSETS.SCHEMA_PATH, self.root / ASSETS.SCHEMA_PATH)
        (self.root / "tmp/review").mkdir(parents=True)
        for kind in (*ASSETS.KINDS, "licenses"):
            (self.root / "assets" / kind).mkdir(parents=True)
            (self.root / "assets" / kind / ".gitkeep").touch()
        self.manifest = self.root / ASSETS.MANIFEST_PATH
        self.manifest.write_text('{"schemaVersion": 1, "assets": []}\n', encoding="utf-8")
        self.source = self.root / "tmp/review/hamster.png"
        self.source.write_bytes(b"synthetic-image-for-asset-tests")
        self.record = {"id": "test-hamster", "kind": "images", "source": "synthetic-test-fixture",
                       "license": "user-owned", "licenseEvidence": "synthetic-test-evidence",
                       "approvedBy": "user", "approvalRef": "synthetic-test-confirmation",
                       "approvedAt": "2026-10-14"}

    def promote(self, source="tmp/review/hamster.png", record=None, filename="hamster.png"):
        return ASSETS.promote_asset(self.root, source, self.record if record is None else record, filename)

    def data(self):
        return json.loads(self.manifest.read_text(encoding="utf-8"))

    def assert_rejected_without_change(self, **kwargs):
        before = self.manifest.read_bytes()
        with self.assertRaises((ValueError, OSError)):
            self.promote(**kwargs)
        self.assertEqual(before, self.manifest.read_bytes())

    def test_empty_manifest_and_normal_promotion(self):
        self.assertEqual([], ASSETS.validate_manifest(self.root, self.data()))
        result = self.promote()
        self.assertEqual("assets/images/hamster.png", result["path"])
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), result["sha256"])
        self.assertEqual([result], self.data()["assets"])
        self.assertEqual([], ASSETS.validate_manifest(self.root, self.data()))
        self.assertTrue(self.source.exists())

    def test_absolute_source_inside_tmp_and_manifest_filename(self):
        result = self.promote(source=str(self.source), filename="manifest.json")
        self.assertEqual(self.source.read_bytes(), (self.root / result["path"]).read_bytes())
        self.assertEqual([], ASSETS.validate_manifest(self.root, self.data()))

    def test_optional_metadata_accepts_descriptions_and_positive_duration(self):
        record = {**self.record, "metadata": {"dimensions": "1024 x 1024", "anchor": "bottom center",
                                              "animation": "idle", "durationSeconds": 1.5, "loop": True}}
        self.promote(record=record)
        self.assertEqual(record["metadata"], self.data()["assets"][0]["metadata"])
        self.assertEqual([], ASSETS.validate_manifest(self.root, self.data()))
        for metadata in ({}, {"dimensions": " "}, {"durationSeconds": -1}, {"unknown": "text"}):
            with self.subTest(metadata=metadata):
                data = self.data()
                data["assets"][0]["metadata"] = metadata
                self.assertTrue(ASSETS.validate_manifest(self.root, data))

    def test_rejects_outside_source_directory_and_traversal(self):
        other = self.root / "source.png"
        other.write_bytes(b"outside-tmp")
        for source in ("source.png", str(other), "tmp/../source.png", "tmp/review"):
            with self.subTest(source=source):
                self.assert_rejected_without_change(source=source)

    def test_rejects_source_symlink_and_symlink_ancestor(self):
        (self.root / "tmp/review/link.png").symlink_to(self.source)
        (self.root / "tmp/linked").symlink_to(self.root / "tmp/review", target_is_directory=True)
        for source in ("tmp/review/link.png", "tmp/linked/hamster.png"):
            with self.subTest(source=source):
                self.assert_rejected_without_change(source=source)

    def test_rejects_target_parent_symlink(self):
        parent = self.root / "assets/images"
        (parent / ".gitkeep").unlink()
        parent.rmdir()
        parent.symlink_to(self.root / "tmp/review", target_is_directory=True)
        self.assert_rejected_without_change()

    def test_rejects_unsafe_filenames(self):
        for filename in ("../escape.png", ".hidden", "a/b.png", "a b.png", "a;cmd.png", "x.png\n", "CON.png", "trailing."):
            with self.subTest(filename=filename):
                self.assert_rejected_without_change(filename=filename)

    def test_rejects_duplicate_id_and_existing_target(self):
        self.promote()
        self.assert_rejected_without_change(filename="another.png")
        record = {**self.record, "id": "different-id"}
        self.assert_rejected_without_change(record=record)
        self.assertEqual(self.source.read_bytes(), (self.root / "assets/images/hamster.png").read_bytes())

    def test_rejects_invalid_approval_and_license_metadata(self):
        for field, value in (("approvedBy", "agent"), ("approvalRef", " "), ("approvedAt", "2026-02-30"),
                             ("licenseEvidence", ""), ("source", ""), ("kind", "unknown")):
            with self.subTest(field=field):
                self.assert_rejected_without_change(record={**self.record, field: value})

    def test_rejects_damaged_manifest(self):
        for content in ("{", "[]", '{"schemaVersion": 2, "assets": []}', '{"schemaVersion": true, "assets": []}',
                        '{"schemaVersion": 1, "schemaVersion": 1, "assets": []}'):
            with self.subTest(content=content):
                self.manifest.write_text(content, encoding="utf-8")
                self.assert_rejected_without_change()

    def test_manifest_patterns_reject_trailing_newlines(self):
        self.promote()
        for field in ("id", "path", "sha256", "licenseFile"):
            with self.subTest(field=field):
                data = self.data()
                value = data["assets"][0].get(field, "assets/licenses/OFL.txt")
                data["assets"][0][field] = value + "\n"
                self.assertTrue(ASSETS.validate_manifest(self.root, data))

    def test_ofl_font_requires_existing_license(self):
        record = {**self.record, "kind": "fonts", "license": "SIL OFL 1.1"}
        self.assert_rejected_without_change(record=record, filename="test.ttf")
        record["licenseFile"] = "assets/licenses/OFL.txt"
        self.assert_rejected_without_change(record=record, filename="test.ttf")
        (self.root / record["licenseFile"]).write_text("Synthetic license evidence", encoding="utf-8")
        self.promote(record=record, filename="test.ttf")
        self.assertEqual([], ASSETS.validate_manifest(self.root, self.data()))

    def test_license_path_and_symlink_rejected(self):
        license_path = self.root / "assets/licenses/OFL.txt"
        license_path.symlink_to(self.source)
        self.assert_rejected_without_change(record={**self.record, "licenseFile": "assets/licenses/OFL.txt"})
        self.assert_rejected_without_change(record={**self.record, "licenseFile": "tmp/review/hamster.png"})

    def test_license_directory_rejects_binary_invalid_utf8_and_blank_text(self):
        for name, content in (("unregistered.png", b"image"), ("LICENSE.txt", b"\xff\xfe"),
                              ("OFL.txt", b" \n"), ("COPYING", b"binary\x00data")):
            with self.subTest(name=name):
                license_path = self.root / "assets/licenses" / name
                license_path.write_bytes(content)
                self.assertTrue(ASSETS.validate_manifest(self.root, self.data()))
                self.assert_rejected_without_change()
                license_path.unlink()

    def test_referenced_license_requires_utf8_text(self):
        license_path = self.root / "assets/fonts/LICENSE.txt"
        license_path.write_bytes(b"\xff")
        self.assert_rejected_without_change(record={**self.record, "licenseFile": "assets/fonts/LICENSE.txt"})
        license_path.write_text("Synthetic license text", encoding="utf-8")
        self.promote(record={**self.record, "licenseFile": "assets/fonts/LICENSE.txt"})
        self.assertEqual([], ASSETS.validate_manifest(self.root, self.data()))

    def test_hash_and_unregistered_inventory_detected(self):
        self.promote()
        (self.root / "assets/images/hamster.png").write_bytes(b"tampered")
        (self.root / "assets/audio/unregistered.wav").write_bytes(b"unknown")
        errors = ASSETS.validate_manifest(self.root, self.data())
        self.assertTrue(any("SHA-256 mismatch" in error for error in errors))
        self.assertTrue(any("Unregistered asset" in error for error in errors))
        self.assert_rejected_without_change(record={**self.record, "id": "new"}, filename="new.png")

    def test_inventory_symlink_and_duplicate_entries_detected(self):
        self.promote()
        data = self.data()
        data["assets"].append(copy.deepcopy(data["assets"][0]))
        errors = ASSETS.validate_manifest(self.root, data)
        self.assertTrue(any("Duplicate asset ID" in error for error in errors))
        self.assertTrue(any("Duplicate asset path" in error for error in errors))
        (self.root / "assets/other/link").symlink_to(self.source)
        self.assertTrue(any("Symbolic links" in error for error in ASSETS.validate_manifest(self.root, self.data())))

    def test_failure_to_replace_manifest_rolls_back_new_asset(self):
        before = self.manifest.read_bytes()
        with patch.object(ASSETS.os, "replace", side_effect=OSError("simulated write failure")):
            self.assert_rejected_without_change()
        self.assertEqual(before, self.manifest.read_bytes())
        self.assertFalse((self.root / "assets/images/hamster.png").exists())
        self.assertFalse((self.root / "tmp/.asset-promotion.lock").exists())

    def test_conflicting_promotion_lock_is_not_removed(self):
        lock = self.root / "tmp/.asset-promotion.lock"
        lock.write_text("another process", encoding="utf-8")
        self.assert_rejected_without_change()
        self.assertEqual("another process", lock.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
