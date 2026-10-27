from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.validate_route import MAX_FILE_BYTES, MAX_NODES, RouteFormatError, load_route, validate_route


class RouteValidationTests(unittest.TestCase):
    def setUp(self):
        self.data = load_route(ROOT / "contracts/examples/route.valid.json")
        (ROOT / "tmp").mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="route-tests-", dir=ROOT / "tmp")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def first_node(self):
        return self.data["chapters"][0]["nodes"][0]

    def second_node(self):
        return self.data["chapters"][1]["nodes"][0]

    def write(self, raw: bytes):
        path = self.directory / "route.json"
        path.write_bytes(raw)
        return path

    def assert_invalid(self, data=None, contains=None):
        errors = validate_route(self.data if data is None else data)
        self.assertTrue(errors)
        if contains:
            self.assertIn(contains.lower(), " ".join(errors).lower())

    def test_valid_example_has_cross_chapter_dependency(self):
        self.assertEqual(validate_route(self.data), [])
        self.assertEqual(self.second_node()["prerequisites"], [self.first_node()["id"]])

    def test_english_and_translated_routes(self):
        self.data["locale"] = "en"
        self.data["sourceLanguage"] = "zh-CN"
        self.data["title"] = "Workplace data literacy"
        self.assertEqual(validate_route(self.data), [])

    def test_dependency_does_not_require_display_order(self):
        self.data["chapters"].reverse()
        self.assertEqual(validate_route(self.data), [])

    def test_cycle(self):
        self.first_node()["prerequisites"] = [self.second_node()["id"]]
        self.assert_invalid(contains="cycle")

    def test_self_dependency(self):
        self.first_node()["prerequisites"] = [self.first_node()["id"]]
        self.assert_invalid(contains="self prerequisite")

    def test_missing_dependency(self):
        self.first_node()["prerequisites"] = ["missing"]
        self.assert_invalid(contains="missing prerequisite")

    def test_duplicate_dependency(self):
        self.second_node()["prerequisites"] *= 2
        self.assert_invalid(contains="non-unique")

    def test_duplicate_node_id(self):
        self.second_node()["id"] = self.first_node()["id"]
        self.assert_invalid(contains="Duplicate node id")

    def test_duplicate_chapter_id(self):
        self.data["chapters"][1]["id"] = self.data["chapters"][0]["id"]
        self.assert_invalid(contains="Duplicate chapter id")

    def test_duplicate_objective_id(self):
        self.first_node()["objectives"].append(copy.deepcopy(self.first_node()["objectives"][0]))
        self.assert_invalid(contains="duplicate objective id")

    def test_invalid_assessment_links(self):
        for ids in (["missing"], ["explain-change"], ["explain-change", "explain-change"]):
            with self.subTest(ids=ids):
                self.second_node()["assessment"]["objectiveIds"] = ids
                self.assert_invalid()

    def test_unknown_version(self):
        for version in (0, 2, "1", True):
            with self.subTest(version=version):
                self.data["schemaVersion"] = version
                self.assert_invalid()

    def test_identifier_rejects_whitespace_paths_and_urls(self):
        for identifier in ("node\n", "../node", "/node", "https://host/node", "", "n" * 65):
            with self.subTest(identifier=identifier):
                self.data["id"] = identifier
                self.assert_invalid()

    def test_extra_fields_at_every_object_level(self):
        targets = [self.data, self.data["chapters"][0], self.first_node(),
                   self.first_node()["objectives"][0], self.first_node()["assessment"]]
        for target in targets:
            with self.subTest(target=list(target)):
                target["localPath"] = "/private/material.pdf"
                self.assert_invalid(contains="Additional properties")
                del target["localPath"]

    def test_missing_or_empty_objectives_and_assessment(self):
        for field, value in (("objectives", []), ("assessment", {})):
            with self.subTest(field=field):
                data = copy.deepcopy(self.data)
                data["chapters"][0]["nodes"][0][field] = value
                self.assert_invalid(data)
        self.first_node()["assessment"]["task"] = " \n\t"
        self.assert_invalid()

    def test_string_and_duration_bounds(self):
        self.data["title"] = "学" * 160
        self.first_node()["estimatedMinutes"] = 1440
        self.assertEqual(validate_route(self.data), [])
        self.data["title"] += "习"
        self.assert_invalid()
        self.data["title"] = "Valid"
        for duration in (0, 1441, 1.5, True):
            with self.subTest(duration=duration):
                self.first_node()["estimatedMinutes"] = duration
                self.assert_invalid()

    def test_total_node_limit(self):
        template = copy.deepcopy(self.first_node())
        chapters = []
        for chapter_index in range(MAX_NODES // 64):
            nodes = []
            for node_index in range(64):
                node = copy.deepcopy(template)
                node["id"] = f"n-{chapter_index}-{node_index}"
                nodes.append(node)
            chapters.append({"id": f"c-{chapter_index}", "title": "Chapter", "nodes": nodes})
        self.data["chapters"] = chapters
        self.assertEqual(validate_route(self.data), [])
        extra = copy.deepcopy(template)
        extra["id"] = "extra-node"
        chapters.append({"id": "extra-chapter", "title": "Extra", "nodes": [extra]})
        self.assert_invalid(contains="total nodes")

    def test_collection_limits(self):
        for field, count in (("objectives", 13), ("prerequisites", 65)):
            with self.subTest(field=field):
                data = copy.deepcopy(self.data)
                node = data["chapters"][0]["nodes"][0]
                node[field] = ([{"id": f"o-{i}", "description": "Goal"} for i in range(count)]
                               if field == "objectives" else [f"n-{i}" for i in range(count)])
                self.assert_invalid(data)
        for chapter_count, nodes_per_chapter in ((25, 1), (1, 65)):
            data = copy.deepcopy(self.data)
            data["chapters"] = [
                {"id": f"c-{i}", "title": "Chapter", "nodes": [
                    {**copy.deepcopy(self.first_node()), "id": f"n-{i}-{j}"}
                    for j in range(nodes_per_chapter)
                ]} for i in range(chapter_count)
            ]
            self.assert_invalid(data)

    def test_file_size_boundary(self):
        raw = json.dumps(self.data, ensure_ascii=False).encode("utf-8")
        exact = raw + b" " * (MAX_FILE_BYTES - len(raw))
        self.assertEqual(validate_route(load_route(self.write(exact))), [])
        with self.assertRaisesRegex(RouteFormatError, "exceeds"):
            load_route(self.write(exact + b" "))

    def test_in_memory_size_limit(self):
        self.data["title"] = "学" * (MAX_FILE_BYTES // 3)
        self.assert_invalid(contains="encoded bytes")

    def test_reject_duplicate_json_keys(self):
        for raw in (b'{"schemaVersion": 1, "schemaVersion": 2}', b'{"chapters":[{"id":"a","id":"b"}]}'):
            with self.subTest(raw=raw), self.assertRaisesRegex(RouteFormatError, "Duplicate JSON key"):
                load_route(self.write(raw))

    def test_reject_nonfinite_numbers(self):
        for token in (b"NaN", b"Infinity", b"-Infinity", b"1e999"):
            with self.subTest(token=token), self.assertRaises(RouteFormatError):
                load_route(self.write(b'{"revision":' + token + b"}"))
        self.data["revision"] = float("nan")
        self.assert_invalid()

    def test_reject_bad_json_and_encoding(self):
        for raw in (b"\xff", b'{"a":}', b"[" * 1000 + b"]" * 1000):
            with self.subTest(raw=raw[:30]), self.assertRaises(RouteFormatError):
                load_route(self.write(raw))

    def test_in_memory_non_json_and_cycles(self):
        self.assert_invalid({1: "value"})
        self.assert_invalid({"value": (1, 2)})
        cyclic = []
        cyclic.append(cyclic)
        self.assert_invalid(cyclic, "cyclic")

    def test_cli_exit_status(self):
        path = self.write(json.dumps(self.data).encode("utf-8"))
        command = [sys.executable, "-B", str(ROOT / "scripts/validate_route.py"), str(path)]
        valid = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertIn("通过", valid.stdout)
        self.data["schemaVersion"] = 2
        self.write(json.dumps(self.data).encode("utf-8"))
        invalid = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(invalid.returncode, 1)
        self.assertIn("错误", invalid.stderr)
        self.write(b"NaN")
        malformed = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(malformed.returncode, 2)


if __name__ == "__main__":
    unittest.main()
