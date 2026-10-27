"""Structural route validation; accepted text remains untrusted content."""

from __future__ import annotations

import argparse
from collections import deque
from functools import lru_cache
import json
import math
from pathlib import Path
import sys
from typing import Any

from jsonschema import Draft202012Validator

MAX_FILE_BYTES = 1_048_576
MAX_NODES = 512
MAX_JSON_DEPTH = 16
MAX_ERRORS = 100
SCHEMA_PATH = Path(__file__).resolve().parents[1] / "contracts" / "route.schema.json"


class RouteFormatError(ValueError):
    """The source is not bounded, unambiguous UTF-8 JSON."""


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RouteFormatError(f"Duplicate JSON key: {key[:80]!r}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise RouteFormatError(f"Non-finite JSON number: {value}")


def _check_json_values(data: Any) -> None:
    stack = [(data, 0)]
    seen: set[int] = set()
    while stack:
        value, depth = stack.pop()
        if depth > MAX_JSON_DEPTH:
            raise RouteFormatError(f"JSON nesting exceeds {MAX_JSON_DEPTH}")
        if type(value) is dict:
            if id(value) in seen:
                raise RouteFormatError("Repeated or cyclic in-memory JSON container")
            seen.add(id(value))
            if any(type(key) is not str for key in value):
                raise RouteFormatError("JSON object keys must be strings")
            stack.extend((item, depth + 1) for item in value.values())
        elif type(value) is list:
            if id(value) in seen:
                raise RouteFormatError("Repeated or cyclic in-memory JSON container")
            seen.add(id(value))
            stack.extend((item, depth + 1) for item in value)
        elif type(value) is float and not math.isfinite(value):
            raise RouteFormatError("Non-finite JSON number")
        elif type(value) not in (str, int, float, bool, type(None)):
            raise RouteFormatError("Value is not a JSON type")


def load_route(path: str | Path) -> Any:
    """Read at most 1 MiB; reject duplicate keys, NaN, Infinity and invalid UTF-8.

    Raises RouteFormatError for read/parse failures. Call validate_route afterward.
    """
    try:
        with Path(path).open("rb") as source:
            raw = source.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            raise RouteFormatError(f"File exceeds {MAX_FILE_BYTES} bytes")
        data = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_object_pairs,
            parse_constant=_reject_constant,
        )
        _check_json_values(data)
        return data
    except RouteFormatError:
        raise
    except (OSError, UnicodeError, ValueError, RecursionError) as error:
        raise RouteFormatError(str(error)[:300]) from error


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def validate_route(data: Any) -> list[str]:
    """Return structural errors, or [] on success; never authorizes text execution."""
    try:
        _check_json_values(data)
        encoded = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_FILE_BYTES:
            return [f"Route exceeds {MAX_FILE_BYTES} encoded bytes"]
    except (RouteFormatError, ValueError, TypeError, UnicodeError, RecursionError) as error:
        return [str(error)[:300]]

    errors = []
    for error in _validator().iter_errors(data):
        location = "/" + "/".join(str(part)[:80] for part in error.absolute_path)
        errors.append(f"{location}: {error.message[:300]}")
        if len(errors) >= MAX_ERRORS:
            return errors
    if errors:
        return errors

    chapters: set[str] = set()
    nodes: dict[str, dict[str, Any]] = {}
    node_count = sum(len(chapter["nodes"]) for chapter in data["chapters"])
    if node_count > MAX_NODES:
        errors.append(f"Route exceeds {MAX_NODES} total nodes")
    for chapter in data["chapters"]:
        if chapter["id"] in chapters:
            errors.append(f"Duplicate chapter id: {chapter['id']}")
        chapters.add(chapter["id"])
        for node in chapter["nodes"]:
            node_id = node["id"]
            if node_id in nodes:
                errors.append(f"Duplicate node id: {node_id}")
            nodes[node_id] = node
            objective_ids = [objective["id"] for objective in node["objectives"]]
            if len(set(objective_ids)) != len(objective_ids):
                errors.append(f"{node_id}: duplicate objective id")
            if set(node["assessment"]["objectiveIds"]) != set(objective_ids):
                errors.append(f"{node_id}: assessment objectiveIds must match all node objectives")

    dependents: dict[str, list[str]] = {node_id: [] for node_id in nodes}
    indegree: dict[str, int] = {node_id: 0 for node_id in nodes}
    for node_id, node in nodes.items():
        for prerequisite in node["prerequisites"]:
            if prerequisite == node_id:
                errors.append(f"{node_id}: self prerequisite is not allowed")
            elif prerequisite not in nodes:
                errors.append(f"{node_id}: missing prerequisite {prerequisite}")
            else:
                dependents[prerequisite].append(node_id)
                indegree[node_id] += 1
    ready = deque(node_id for node_id, count in indegree.items() if count == 0)
    visited = 0
    while ready:
        node_id = ready.popleft()
        visited += 1
        for dependent in dependents[node_id]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                ready.append(dependent)
    if visited != len(nodes):
        errors.append("Prerequisites contain a cycle")
    return errors[:MAX_ERRORS]


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Vibe Improve route JSON file")
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        data = load_route(args.path)
    except RouteFormatError as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2
    errors = validate_route(data)
    if errors:
        for error in errors:
            print(f"错误: {error}", file=sys.stderr)
        return 1
    print(f"通过: {args.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
