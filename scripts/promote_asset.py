#!/usr/bin/env python3
"""Register an asset after user review; metadata cannot prove authorization."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

from jsonschema import Draft202012Validator, FormatChecker


KINDS = ("images", "video", "audio", "fonts", "models", "other")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
RESERVED_NAMES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
LICENSE_NAME = re.compile(r"(?:.*[-_])?(?:LICENSE|OFL|COPYING)(?:\.(?:txt|md))?\Z", re.I)
SCHEMA_PATH = "contracts/asset-manifest.schema.json"
MANIFEST_PATH = "assets/manifest.json"


def _safe_filename(name):
    return bool(SAFE_NAME.fullmatch(name)) and not name.endswith(".") and name.split(".")[0].lower() not in RESERVED_NAMES


def _root(root):
    root = Path(root).absolute()
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Repository root must be a real directory")
    return root


def _checked_path(root, relative, *, file=False, directory=False, missing=False):
    relative = Path(relative)
    if relative.is_absolute() or not relative.parts or any(p in (".", "..") for p in relative.parts):
        raise ValueError(f"Unsafe repository path: {relative}")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Symbolic links are not allowed: {relative}")
    if not current.exists():
        if missing:
            return current
        raise ValueError(f"Missing path: {relative}")
    mode = current.stat().st_mode
    if file and not stat.S_ISREG(mode):
        raise ValueError(f"Expected a regular file: {relative}")
    if directory and not stat.S_ISDIR(mode):
        raise ValueError(f"Expected a directory: {relative}")
    return current


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_json(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)


def _schema_errors(root, data):
    schema = _read_json(_checked_path(root, SCHEMA_PATH, file=True))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    return [f"manifest/{'/'.join(map(str, error.absolute_path))}: {error.message}"
            for error in sorted(validator.iter_errors(data), key=lambda e: str(e.absolute_path))]


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _license_text_errors(root, reference):
    name = Path(reference).name
    if not _safe_filename(name):
        return [f"Unsafe license filename: {reference}"]
    if Path(reference).suffix.lower() not in (".txt", ".md") and not LICENSE_NAME.fullmatch(name):
        return [f"License must be a .txt/.md file or named LICENSE, OFL or COPYING: {reference}"]
    try:
        path = _checked_path(root, reference, file=True)
        if path.stat().st_size > 1024 * 1024:
            return [f"License text exceeds 1 MiB: {reference}"]
        text = path.read_text(encoding="utf-8")
        if not text.strip() or "\x00" in text:
            return [f"License must contain nonempty UTF-8 text without NUL bytes: {reference}"]
    except (OSError, ValueError) as error:
        return [f"Invalid license file {reference}: {error}"]
    return []


def _license_errors(root, record):
    reference = record.get("licenseFile")
    if not reference:
        return []
    return _license_text_errors(root, reference)


def validate_manifest(root, data):
    """Return schema, path, hash and inventory errors without writing files."""
    errors = []
    try:
        root = _root(root)
        errors.extend(_schema_errors(root, data))
        if errors:
            return errors
        assets = _checked_path(root, "assets", directory=True)
        ids, paths, licenses = set(), set(), set()
        for record in data["assets"]:
            asset_id, path = record["id"], record["path"]
            if asset_id in ids:
                errors.append(f"Duplicate asset ID: {asset_id}")
            if path in paths:
                errors.append(f"Duplicate asset path: {path}")
            ids.add(asset_id)
            paths.add(path)
            if not path.startswith(f"assets/{record['kind']}/"):
                errors.append(f"Asset kind does not match path: {path}")
            if not _safe_filename(Path(path).name):
                errors.append(f"Unsafe asset filename: {path}")
            try:
                asset = _checked_path(root, path, file=True)
                if _sha256(asset) != record["sha256"]:
                    errors.append(f"SHA-256 mismatch: {path}")
            except (OSError, ValueError) as error:
                errors.append(str(error))
            errors.extend(_license_errors(root, record))
            if record.get("licenseFile"):
                licenses.add(record["licenseFile"])
        for parent, directories, files in os.walk(assets, followlinks=False):
            for name in directories + files:
                path = Path(parent) / name
                relative = path.relative_to(root).as_posix()
                try:
                    _checked_path(root, relative, directory=name in directories, file=name in files)
                except (OSError, ValueError) as error:
                    errors.append(str(error))
                    continue
                if name in directories:
                    if Path(relative).parts[1] not in (*KINDS, "licenses"):
                        errors.append(f"Unexpected asset directory: {relative}")
                    continue
                is_license = (relative.startswith("assets/licenses/") or relative in licenses
                              or (relative.startswith("assets/fonts/") and LICENSE_NAME.fullmatch(name)))
                if is_license and name != ".gitkeep":
                    errors.extend(_license_text_errors(root, relative))
                if relative not in paths and relative != MANIFEST_PATH and name != ".gitkeep" and not is_license:
                    errors.append(f"Unregistered asset: {relative}")
    except (OSError, ValueError, TypeError) as error:
        errors.append(str(error))
    return errors


def promote_asset(root, source, record, filename):
    """Copy one reviewed file and atomically replace the validated manifest."""
    root = _root(root)
    if not _safe_filename(filename):
        raise ValueError("Filename must use 1–128 ASCII letters, digits, dots, underscores or hyphens and start with a letter or digit")
    source = Path(source)
    if source.is_absolute():
        try:
            source = source.relative_to(root)
        except ValueError as error:
            raise ValueError("Source must be inside this repository's tmp directory") from error
    if not source.parts or source.parts[0] != "tmp":
        raise ValueError("Source must be inside this repository's tmp directory")
    source_path = _checked_path(root, source, file=True)
    tmp = _checked_path(root, "tmp", directory=True)
    manifest_path = _checked_path(root, MANIFEST_PATH, file=True)
    kind = record.get("kind")
    if kind not in KINDS:
        raise ValueError("Unknown asset kind")
    parent = _checked_path(root, f"assets/{kind}", directory=True)
    target_relative = f"assets/{kind}/{filename}"
    target = _checked_path(root, target_relative, missing=True)
    if target.exists():
        raise ValueError(f"Destination already exists: {target_relative}")
    record = {**record, "path": target_relative, "sha256": _sha256(source_path)}
    lock_path = tmp / ".asset-promotion.lock"
    try:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise ValueError("Another asset promotion is running; inspect tmp/.asset-promotion.lock before retrying") from error
    os.close(lock_fd)
    try:
        data = _read_json(manifest_path)
        errors = validate_manifest(root, data)
        if errors:
            raise ValueError("\n".join(errors))
        if any(item["id"] == record.get("id") for item in data["assets"]):
            errors.append(f"Duplicate asset ID: {record.get('id')}")
        candidate = {"schemaVersion": 1, "assets": [*data["assets"], record]}
        errors.extend(_schema_errors(root, candidate))
        if not errors:
            errors.extend(_license_errors(root, record))
        if errors:
            raise ValueError("\n".join(errors))
        with tempfile.TemporaryDirectory(prefix="asset-promotion-", dir=tmp) as stage:
            staged_asset = Path(stage) / "payload"
            shutil.copyfile(source_path, staged_asset)
            if _sha256(staged_asset) != record["sha256"]:
                raise ValueError("Source changed while being copied; review it again")
            staged_manifest = Path(stage) / "manifest.json"
            with staged_manifest.open("w", encoding="utf-8") as stream:
                json.dump(candidate, stream, indent=2, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            _checked_path(root, parent.relative_to(root), directory=True)
            _checked_path(root, MANIFEST_PATH, file=True)
            os.link(staged_asset, target)
            try:
                os.replace(staged_manifest, manifest_path)
            except BaseException:
                if target.exists() and os.path.samestat(target.stat(), staged_asset.stat()):
                    target.unlink()
                raise
        return record
    finally:
        lock_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("source", "id", "kind", "filename", "source-url", "license", "license-evidence", "approved-by", "approval-ref", "approved-at"):
        parser.add_argument(f"--{flag}", required=True, choices=KINDS if flag == "kind" else ("user",) if flag == "approved-by" else None)
    parser.add_argument("--license-file")
    args = parser.parse_args()
    record = {"id": args.id, "kind": args.kind, "source": args.source_url,
              "license": args.license, "licenseEvidence": args.license_evidence,
              "approvedBy": args.approved_by, "approvalRef": args.approval_ref, "approvedAt": args.approved_at}
    if args.license_file:
        record["licenseFile"] = args.license_file
    try:
        result = promote_asset(Path(__file__).resolve().parents[1], args.source, record, args.filename)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Asset promotion failed: {error}\n")
    print(f"Registered {result['id']}: {result['path']}")


if __name__ == "__main__":
    main()
