#!/usr/bin/env python3
"""Verify the research catalogue and any local cached evidence without network access."""

from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def main():
    sources = json.loads((ROOT / "sources.json").read_text())["sources"]
    records = json.loads((ROOT / "cache-manifest.json").read_text())["records"]
    errors = []
    source_ids = [source["id"] for source in sources]
    record_ids = [record["id"] for record in records]
    if len(set(source_ids)) != len(source_ids) or len(set(record_ids)) != len(record_ids):
        errors.append("Duplicate source or capture ID")
    if set(record_ids) != set(source_ids):
        errors.append("Capture IDs do not match the source catalogue")
    catalogue = {source["id"]: source for source in sources}
    for source in sources:
        if not re.fullmatch(r"[A-Z][A-Z0-9-]*", source["id"]):
            errors.append(f"Invalid source ID: {source['id']}")
        if urlsplit(source["url"]).scheme != "https":
            errors.append(f"Non-HTTPS source: {source['id']}")
        if not source.get("scope") or not source.get("reviewed_locator"):
            errors.append(f"Missing scope or reading limit: {source['id']}")

    cached_files = 0
    missing_local = 0
    for record in records:
        sid = record["id"]
        if sid not in catalogue:
            continue
        if record["url"] != catalogue[sid]["url"]:
            errors.append(f"Source URL drift: {sid}")
        status = record["status"]
        if status not in {"downloaded", "extracted-via-tool", "failed"}:
            errors.append(f"Unknown capture status: {sid}")
        if status == "failed" and not record.get("error"):
            errors.append(f"Failed capture without reason: {sid}")
        if status == "downloaded" and not all(record.get(key) for key in ("raw_path", "sha256", "bytes")):
            errors.append(f"Downloaded capture lacks evidence metadata: {sid}")
        if status == "extracted-via-tool" and not all(record.get(key) for key in ("text_path", "text_sha256", "extracted_at")):
            errors.append(f"Tool extraction lacks evidence metadata: {sid}")
        for path_key, hash_key in (("raw_path", "sha256"), ("text_path", "text_sha256")):
            if not record.get(path_key):
                continue
            file = (ROOT / record[path_key]).resolve()
            if not file.is_relative_to(ROOT / ".cache"):
                errors.append(f"Cache path escapes local evidence directory: {sid}")
                continue
            if not file.exists():
                missing_local += 1
                continue
            data = file.read_bytes()
            if hashlib.sha256(data).hexdigest() != record.get(hash_key):
                errors.append(f"Hash mismatch: {sid} {path_key}")
            if path_key == "raw_path" and len(data) != record.get("bytes"):
                errors.append(f"Size mismatch: {sid}")
            if path_key == "raw_path" and file.suffix == ".pdf" and not data.startswith(b"%PDF-"):
                errors.append(f"Invalid PDF capture: {sid}")
            cached_files += 1

    ledger = (ROOT / "sources.md").read_text()
    for sid in source_ids:
        if f"### {sid}\n" not in ledger:
            errors.append(f"Missing human-readable source entry: {sid}")
    known_anchors = {sid.lower() for sid in source_ids}
    for file in ROOT.glob("*.md"):
        for anchor in re.findall(r"sources\.md#([a-z0-9-]+)", file.read_text()):
            if anchor not in known_anchors:
                errors.append(f"Unknown source reference: {file.name}#{anchor}")
    ignored = subprocess.run(["git", "check-ignore", "-q", str(ROOT / ".cache" / "raw" / "P03.pdf")], cwd=ROOT, check=False)
    if ignored.returncode:
        errors.append("Raw evidence cache is not Git-ignored")

    counts = dict(sorted(Counter(record["status"] for record in records).items()))
    print(json.dumps({"sources": len(sources), "capture_status": counts, "verified_local_files": cached_files,
                      "unavailable_local_files": missing_local, "errors": errors}, ensure_ascii=False, indent=2))
    if errors:
        sys.exit(1)
    if missing_local:
        print("Local evidence is incomplete; re-fetch available sources before relying on an offline audit.")


if __name__ == "__main__":
    main()
