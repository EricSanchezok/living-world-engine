#!/usr/bin/env python3
"""Cache explicitly catalogued public sources without executing remote content."""

import argparse
import concurrent.futures
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
LIMIT = 64 * 1024 * 1024


class ReadableHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript", "svg"}:
            self.hidden += 1
        if tag in {"p", "div", "li", "h1", "h2", "h3", "h4", "br", "tr"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript", "svg"}:
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)

    def text(self):
        lines = [re.sub(r"\s+", " ", line).strip() for line in "".join(self.parts).splitlines()]
        return "\n".join(line for line in lines if line)


def acquire(source):
    sid = source["id"]
    if not re.fullmatch(r"[A-Z][A-Z0-9-]*", sid):
        raise ValueError(f"Invalid source id: {sid}")
    record = {"id": sid, "url": source["url"], "retrieved_at": datetime.now(timezone.utc).isoformat()}
    try:
        req = urllib.request.Request(source["url"], headers={"User-Agent": "LivingWorldResearch/1.0"})
        with urllib.request.urlopen(req, timeout=45) as response:
            record.update(final_url=response.url, content_type=response.headers.get("Content-Type", ""))
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > LIMIT:
                raise ValueError("Source exceeds the 64 MiB cache limit")
            data = response.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("Source exceeds the 64 MiB cache limit")
        is_pdf = data.startswith(b"%PDF-")
        if source["format"] == "pdf" and not is_pdf:
            raise ValueError("Expected a PDF, received another content type")
        ext = "pdf" if is_pdf else "html"
        raw = ROOT / ".cache" / "raw" / f"{sid}.{ext}"
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(data)
        record.update(status="downloaded", bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), raw_path=str(raw.relative_to(ROOT)))
        extracted = ROOT / ".cache" / "text" / f"{sid}.txt"
        extracted.parent.mkdir(parents=True, exist_ok=True)
        if is_pdf:
            if shutil.which("pdftotext"):
                subprocess.run(["pdftotext", "-layout", str(raw), str(extracted)], check=True, timeout=45, capture_output=True)
                record["extraction"] = "pdftotext-layout; form-feed separates PDF pages"
            if shutil.which("pdfinfo"):
                info = subprocess.run(["pdfinfo", str(raw)], check=True, timeout=20, capture_output=True, text=True).stdout
                match = re.search(r"^Pages:\s+(\d+)", info, re.M)
                if match:
                    record["pages"] = int(match.group(1))
        else:
            parser = ReadableHTML()
            parser.feed(data.decode("utf-8", errors="replace"))
            extracted.write_text(parser.text(), encoding="utf-8")
            record["extraction"] = "HTML text; script/style content excluded"
        if extracted.exists():
            record["text_path"] = str(extracted.relative_to(ROOT))
            record["text_sha256"] = hashlib.sha256(extracted.read_bytes()).hexdigest()
    except Exception as exc:
        record.update(status="failed", error=f"{type(exc).__name__}: {exc}")
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ids", nargs="*", help="Fetch only these catalogue IDs")
    args = parser.parse_args()
    catalogue = json.loads((ROOT / "sources.json").read_text())
    known_ids = {source["id"] for source in catalogue["sources"]}
    if args.ids and set(args.ids) - known_ids:
        parser.error("Unknown source IDs: " + ", ".join(sorted(set(args.ids) - known_ids)))
    sources = [s for s in catalogue["sources"] if s.get("cache", True) and (not args.ids or s["id"] in args.ids)]
    manifest_path = ROOT / "cache-manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"records": []}
    records = {r["id"]: r for r in previous["records"]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(acquire, sources):
            records[result["id"]] = result
            print(f"{result['id']}: {result['status']} ({result.get('bytes', 0)} bytes)", flush=True)
    manifest_path.write_text(json.dumps({"records": sorted(records.values(), key=lambda x: x["id"])}, ensure_ascii=False, indent=2) + "\n")
    if any(records[s["id"]]["status"] == "failed" for s in sources):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
