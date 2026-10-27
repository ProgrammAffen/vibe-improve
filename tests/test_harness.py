from copy import deepcopy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from scripts.check_harness import ROOT, check_links, validate_registry


class HarnessTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "tmp").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="harness-test-", dir=ROOT / "tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_local_links_resolve_from_their_document(self):
        (self.root / "docs").mkdir()
        (self.root / "docs/child.md").write_text("# Child", encoding="utf-8")
        (self.root / "README.md").write_text("[child](docs/child.md#child)", encoding="utf-8")
        self.assertEqual(check_links(self.root), [])

    def test_broken_and_escaping_links_fail(self):
        (self.root / "README.md").write_text("[missing](missing.md)\n[escape](../outside.md)", encoding="utf-8")
        errors = check_links(self.root)
        self.assertTrue(any("missing link" in error for error in errors))
        self.assertTrue(any("leaves repository" in error for error in errors))

    def test_external_links_code_examples_and_tmp_are_not_checked(self):
        (self.root / "tmp").mkdir()
        (self.root / "tmp/draft.md").write_text("[draft](unfinished.md)", encoding="utf-8")
        (self.root / "README.md").write_text(
            '[web](https://example.invalid)\n```md\n[example](missing.md)\n```', encoding="utf-8"
        )
        self.assertEqual(check_links(self.root), [])

    def registry(self):
        (self.root / "contracts").mkdir()
        shutil.copyfile(ROOT / "contracts/agent-capabilities.schema.json", self.root / "contracts/agent-capabilities.schema.json")
        return json.loads((ROOT / "contracts/agent-capabilities.json").read_text(encoding="utf-8"))

    def write_registry(self, data):
        (self.root / "contracts/agent-capabilities.json").write_text(json.dumps(data), encoding="utf-8")

    def test_duplicate_provider_cannot_hide_missing_target(self):
        data = self.registry()
        data["providers"][-1] = deepcopy(data["providers"][0])
        self.write_registry(data)
        self.assertTrue(validate_registry(self.root))

    def test_verified_requires_actual_version_platform_and_evidence(self):
        data = self.registry()
        data["providers"][0]["status"] = "verified"
        self.write_registry(data)
        self.assertTrue(validate_registry(self.root))

    def test_planned_cannot_advertise_verified_capabilities(self):
        data = self.registry()
        data["providers"][0]["verifiedCapabilities"] = ["file-generation"]
        self.write_registry(data)
        self.assertTrue(validate_registry(self.root))


if __name__ == "__main__":
    unittest.main()
