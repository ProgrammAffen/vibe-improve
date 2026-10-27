"""Check development contracts and repository boundaries without network access."""

from __future__ import annotations

import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

from jsonschema import Draft202012Validator, FormatChecker

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.validate_route import load_route, validate_route
from scripts.promote_asset import validate_manifest

ROOT = Path(__file__).resolve().parents[1]
IGNORED_DIRS = {".git", "tmp", "output", "node_modules", "__pycache__"}
MEDIA_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".ico",
    ".mp4", ".mov", ".webm", ".mp3", ".wav", ".ogg", ".flac",
    ".ttf", ".otf", ".woff", ".woff2", ".glb", ".gltf", ".fbx", ".obj",
    ".blend", ".pdf", ".psd", ".zip",
}
REQUIRED = [
    "AGENTS.md", "README.md", ".gitignore", "requirements-dev.txt",
    "harness/product.md", "harness/architecture.md", "harness/learning.md",
    "harness/agents.md", "harness/experience.md", "harness/license.md",
    "harness/assets.md", "harness/verification.md", "harness/delivery.md",
    "skills/vibe-improve-dev/SKILL.md", "assets/manifest.json",
    "contracts/route.schema.json", "contracts/examples/route.valid.json",
    "contracts/agent-capabilities.json", "contracts/agent-capabilities.schema.json",
    "contracts/asset-manifest.schema.json", "scripts/validate_route.py",
    "scripts/promote_asset.py", "tests/test_route.py", "tests/test_assets.py",
]
PROVIDERS = {"codex", "claude-code", "qoder", "codebuddy", "openclaw", "hermes"}


def source_files(root: Path):
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        for filename in files:
            yield Path(directory) / filename


def check_links(root: Path) -> list[str]:
    errors = []
    for path in source_files(root):
        if path.suffix != ".md":
            continue
        content = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
        for match in re.finditer(r"\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)", content):
            target = match.group(1).strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith(("#", "//")):
                continue
            target_path = unquote(parsed.path)
            if not target_path:
                continue
            resolved = (path.parent / target_path).resolve()
            if not resolved.is_relative_to(root.resolve()):
                errors.append(f"{path.relative_to(root)}: link leaves repository: {target}")
            elif not resolved.exists():
                errors.append(f"{path.relative_to(root)}: missing link: {target}")
    return errors


def validate_registry(root: Path) -> list[str]:
    schema = load_route(root / "contracts/agent-capabilities.schema.json")
    data = load_route(root / "contracts/agent-capabilities.json")
    Draft202012Validator.check_schema(schema)
    errors = [f"Agent registry: {e.message}" for e in
              Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(data)]
    if errors:
        return errors
    ids = [provider["id"] for provider in data["providers"]]
    if set(ids) != PROVIDERS or len(ids) != len(set(ids)):
        errors.append("Agent registry must contain each target exactly once")
    return errors


def check_repo(root: Path = ROOT) -> list[str]:
    errors = [f"Missing: {name}" for name in REQUIRED if not (root / name).is_file()]
    if errors:
        return errors
    errors.extend(check_links(root))
    for path in source_files(root):
        relative = path.relative_to(root)
        if path.suffix.lower() in MEDIA_SUFFIXES and relative.parts[0] != "assets":
            errors.append(f"Asset outside assets/ or tmp/: {relative}")
    for name in ("dist", "build", "coverage", ".cache"):
        if (root / name).exists():
            errors.append(f"Generated directory must be under tmp/: {name}")
    skill = (root / "skills/vibe-improve-dev/SKILL.md").read_text(encoding="utf-8")
    frontmatter = re.match(r"\A---\n(.*?)\n---\n", skill, re.S)
    if not frontmatter or not re.search(r"(?m)^name: vibe-improve-dev$", frontmatter.group(1)) or not re.search(r"(?m)^description: \S.+$", frontmatter.group(1)):
        errors.append("Skill requires valid name and description frontmatter")
    for schema_path in (root / "contracts").glob("*.schema.json"):
        try:
            Draft202012Validator.check_schema(load_route(schema_path))
        except Exception as error:
            errors.append(f"{schema_path.name}: {str(error)[:300]}")
    for label, action in [
        ("Route", lambda: validate_route(load_route(root / "contracts/examples/route.valid.json"))),
        ("Agents", lambda: validate_registry(root)),
        ("Assets", lambda: validate_manifest(root, load_route(root / "assets/manifest.json"))),
    ]:
        try:
            errors.extend(f"{label}: {error}" for error in action())
        except Exception as error:
            errors.append(f"{label}: {str(error)[:300]}")
    return errors


def main() -> int:
    errors = check_repo()
    if errors:
        for error in errors:
            print(f"FAIL {error}", file=sys.stderr)
        return 1
    print("PASS harness: documents, skill, route, Agent registry, and assets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
