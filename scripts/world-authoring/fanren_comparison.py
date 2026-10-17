"""Acquire a public comparison edition without replacing the working text."""

import argparse
import concurrent.futures
import ctypes
import ctypes.util
import difflib
import html
import json
import platform
import re
import time
from collections import Counter
from pathlib import Path

from fanren_sources import AUTHORING, CACHE, NUMBER, align, digest, fetch, write_json

INDEX_URL = "https://tw.hjwzw.com/Book/Chapter/1644"
COMPARISON_CACHE = CACHE / "hjwzw"


def comparison_catalogue(source):
    entries, seen = [], set()
    for match in re.finditer(r'<a\s+[^>]*href="(/Book/Read/1644,\d+)"[^>]*>(.*?)</a>', source, re.S | re.I):
        url, title = match.groups()
        title = html.unescape(re.sub(r"<[^>]*>", "", title)).strip()
        if url in seen:
            continue
        seen.add(url)
        entries.append({"id": "hjwzw-" + url.split(",")[-1], "title": title,
                        "url": "https://tw.hjwzw.com" + url})
    if not entries or "山邊小村" not in entries[0]["title"]:
        raise ValueError("comparison catalogue is absent or starts outside the novel")
    return entries


def comparison_body(source):
    candidates = re.findall(r'<div\s+style="[^"]*text-indent:\s*2em;[^"]*"\s*>(.*?)</div>', source, re.S | re.I)
    if not candidates:
        raise ValueError("public chapter body is absent; no challenge bypass is attempted")
    block = max(candidates, key=len)
    lines = [html.unescape(re.sub(r"<[^>]+>", "", line)).strip()
             for line in re.split(r"<p\s*/?>|</p>|<br\s*/?>", block, flags=re.I)]
    lines = [line for line in lines if line]
    while lines and (lines[0].startswith("請記住本站域名") or
                     (len(lines[0]) < 150 and re.match(rf"^(?:凡人修仙傳\s*)?第?{NUMBER}(?:章|卷)", lines[0]))):
        lines.pop(0)
    if not lines or len("".join(lines)) < 300:
        raise ValueError("comparison chapter is absent or only a short fragment")
    return "\n".join(lines) + "\n"


class ComparisonNormalizer:
    """Script conversion is restricted to comparison; raw sources stay intact."""
    def __init__(self):
        self.metadata = {"punctuation": "retain-unicode-word-characters", "purpose": "comparison-only"}
        if platform.system() == "Darwin":
            library = ctypes.util.find_library("CoreFoundation")
            if not library:
                raise RuntimeError("CoreFoundation is unavailable")
            self.cf = ctypes.CDLL(library)
            self.cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
            self.cf.CFStringCreateWithCString.restype = ctypes.c_void_p
            self.cf.CFStringCreateMutableCopy.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p]
            self.cf.CFStringCreateMutableCopy.restype = ctypes.c_void_p
            self.cf.CFStringTransform.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_bool]
            self.cf.CFStringTransform.restype = ctypes.c_bool
            self.cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
            self.cf.CFStringGetCString.restype = ctypes.c_bool
            self.cf.CFRelease.argtypes = [ctypes.c_void_p]
            self.metadata.update({"script_conversion": "CoreFoundation Traditional-Simplified", "os_version": platform.mac_ver()[0]})
        else:
            try:
                import opencc
            except ImportError as error:
                raise RuntimeError("Comparison requires OpenCC t2s on non-macOS hosts; no source is changed") from error
            self.opencc = opencc.OpenCC("t2s")
            self.metadata.update({"script_conversion": "OpenCC t2s", "library_version": getattr(opencc, "__version__", "unreported")})

    def simplified(self, text):
        if hasattr(self, "opencc"):
            return self.opencc.convert(text)
        source = self.cf.CFStringCreateWithCString(None, text.encode(), 0x08000100)
        target = self.cf.CFStringCreateMutableCopy(None, 0, source)
        transform = self.cf.CFStringCreateWithCString(None, b"Traditional-Simplified", 0x08000100)
        try:
            if not self.cf.CFStringTransform(target, None, transform, False):
                raise ValueError("script conversion failed")
            output = ctypes.create_string_buffer(max(len(text.encode()) * 4 + 1, 32))
            if not self.cf.CFStringGetCString(target, output, len(output), 0x08000100):
                raise ValueError("script conversion output exceeded buffer")
            return output.value.decode()
        finally:
            self.cf.CFRelease(source)
            self.cf.CFRelease(target)
            self.cf.CFRelease(transform)

    def compact(self, text):
        return re.sub(r"\W", "", self.simplified(text), flags=re.UNICODE)


def variant_classes(candidate, comparison, differences):
    classes = Counter()
    moved = {item["candidate_sha256"] for item in differences if item["operation"] == "delete"} & {
        item["comparison_sha256"] for item in differences if item["operation"] == "insert"}
    particles = set("的地得了着过也就又而则与和之于以其乃是为者所")
    number_units = set("零〇一二三四五六七八九十百千万两亿年月日时刻丈尺寸里斤两枚颗株座层级成倍")
    for item in differences:
        left = candidate[item["candidate_start"]:item["candidate_end"]]
        right = comparison[item["comparison_start"]:item["comparison_end"]]
        size = max(len(left), len(right))
        if item["candidate_sha256"] in moved or item["comparison_sha256"] in moved:
            category = "reordered-identical-text"
        elif not left and len(right) >= 24 and right in candidate:
            category = "comparison-repeats-existing-text"
        elif not right and len(left) >= 24 and left in comparison:
            category = "candidate-repeats-existing-text"
        elif size >= 40:
            category = "substantial-addition-deletion-or-substitution"
        elif set(left + right) <= particles:
            category = "grammatical-particle-variant-not-auto-approved"
        elif set(left + right) & number_units:
            category = "number-unit-or-time-token-needs-review"
        elif not left or not right:
            category = "short-content-addition-or-deletion"
        else:
            category = "lexical-substitution"
        item["category"] = category
        classes[category] += 1
    return dict(classes)


def format_relation(candidate, comparison, normalizer):
    if candidate == comparison:
        return "raw-identical"
    if re.sub(r"\s", "", candidate) == re.sub(r"\s", "", comparison):
        return "whitespace-only"
    if re.sub(r"\W", "", candidate) == re.sub(r"\W", "", comparison):
        return "punctuation-and-whitespace-only"
    if normalizer.compact(candidate) == normalizer.compact(comparison):
        return "script-conversion-plus-format-only"
    return "content-differences-remain-after-comparison-normalization"


def compare_chapter(candidate, comparison):
    """Return candidate differences, never a literary completeness verdict."""
    if candidate == comparison:
        return {"status": "equal-after-comparison-normalization", "similarity": 1.0, "difference_classes": {}, "triage_priority": 4, "differences": []}
    differences = []
    matcher = difflib.SequenceMatcher(None, candidate, comparison, autojunk=False)
    for operation, a, a_end, b, b_end in matcher.get_opcodes():
        if operation != "equal":
            differences.append({"operation": operation, "candidate_start": a, "candidate_end": a_end,
                                "comparison_start": b, "comparison_end": b_end,
                                "candidate_sha256": digest(candidate[a:a_end]), "comparison_sha256": digest(comparison[b:b_end])})
    classes = variant_classes(candidate, comparison, differences)
    similarity = matcher.ratio()
    longest = max(max(item["candidate_end"] - item["candidate_start"], item["comparison_end"] - item["comparison_start"])
                  for item in differences)
    return {"status": "small-variants-need-editorial-judgment" if similarity >= 0.95 and longest < 40 else "needs-segment-collation",
            "similarity": round(similarity, 6), "largest_variant_characters": longest,
            "difference_classes": classes, "triage_priority": 1 if similarity < 0.5 or longest >= 300 else
                (2 if longest >= 40 or "reordered-identical-text" in classes else 3), "differences": differences}


def comparison_triage(report):
    """Partition every chapter into review work; no group is an approval."""
    groups = {}
    for row in report["chapters"]:
        if row["status"] == "comparison-unavailable-or-unaligned":
            group = "missing-or-unaligned-comparison"
        elif row["status"] == "equal-after-comparison-normalization":
            group = "format-equivalent-still-source-bound"
        elif row.get("similarity", 1) < 0.5:
            group = "comparison-integrity-or-alignment-first"
        elif row.get("largest_variant_characters", 0) >= 300:
            group = "large-segment-boundary-or-omission"
        elif row.get("largest_variant_characters", 0) >= 40:
            group = "medium-segment-collation"
        elif row["status"] == "needs-segment-collation":
            group = "dense-small-content-variants"
        else:
            group = "short-lexical-and-grammatical-variants"
        groups.setdefault(group, []).append(row["chapter_id"])
    return {"format_version": 1, "status": "unadjudicated-work-queue",
            "groups": [{"group": key, "chapters": len(ids), "chapter_ids": ids} for key, ids in groups.items()],
            "structural_priority_chapter_ids": [row["chapter_id"] for row in report["chapters"]
                if row["status"] in {"comparison-unavailable-or-unaligned", "needs-segment-collation"}],
            "chapters": [{key: row[key] for key in ["chapter_id", "triage_priority", "status", "difference_classes", "detail_sha256"] if key in row}
                for row in sorted(report["chapters"], key=lambda item: (item["triage_priority"], item["chapter_id"]))
                if row["triage_priority"] <= 2]}


def acquire(limit=None, workers=3):
    raw = fetch(INDEX_URL, COMPARISON_CACHE / "catalogue.html")
    entries = comparison_catalogue(raw.decode("utf-8"))
    if limit:
        entries = entries[:limit]

    def retrieve(entry):
        destination = COMPARISON_CACHE / "pages" / f"{entry['id']}.html"
        try:
            if not destination.exists():
                time.sleep(0.5)
            raw_page = fetch(entry["url"], destination)
            body = comparison_body(raw_page.decode("utf-8"))
            body_path = COMPARISON_CACHE / "chapters" / f"{entry['id']}.txt"
            body_path.parent.mkdir(parents=True, exist_ok=True)
            body_path.write_text(body, encoding="utf-8")
            return {**entry, "status": "acquired-comparison-only", "html_sha256": digest(raw_page),
                    "body_sha256": digest(body), "characters": len(body)}
        except Exception as error:
            return {**entry, "status": "unavailable", "error": str(error)}

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for result in executor.map(retrieve, entries):
            results.append(result)
            if len(results) % 25 == 0:
                write_json(COMPARISON_CACHE / "acquisition.json", results)
                print(json.dumps({"comparison_chapters_processed": len(results), "total": len(entries)}, ensure_ascii=False), flush=True)
    write_json(COMPARISON_CACHE / "acquisition.json", results)
    print(json.dumps({"chapters": len(results), "statuses": dict(Counter(row["status"] for row in results))}, ensure_ascii=False), flush=True)


def split_comparison_text(text):
    pattern = re.compile(rf"^(?:</?br\s*/?>)?(?:凡人修仙传)?(?:(?:第)?{NUMBER}卷[^\n]*?)?第?{NUMBER}章[^\n]{{0,100}}$", re.M)
    markers = list(pattern.finditer(text))
    if not markers or "山边小村" not in markers[0][0] or "飞升仙界" not in markers[-1][0]:
        raise ValueError("comparison main-novel boundaries are missing")
    entries = []
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        span = text[marker.end():end]
        body = span.strip()
        body_start = marker.end() + len(span) - len(span.lstrip())
        body_end = end - (len(span) - len(span.rstrip()))
        entries.append({"id": f"fundgao-{index + 1:04}", "title": re.sub(r"^(?:</?br\s*/?>)?(?:凡人修仙传)?", "", marker[0]).strip(),
                        "body": body, "source_start": body_start, "source_end": body_end, "body_sha256": digest(body)})
    return entries


def coalesce_empty_headers(entries):
    """Adjacent repeated headings may share a body; real empty chapters remain."""
    output, index = [], 0
    while index < len(entries):
        first = entries[index]
        group = [first]
        numbers = re.findall(rf"第?({NUMBER})章", first["title"])
        while not group[-1]["body"] and index + 1 < len(entries):
            following = entries[index + 1]
            next_numbers = re.findall(rf"第?({NUMBER})章", following["title"])
            if not numbers or not next_numbers or numbers[-1] != next_numbers[-1]:
                break
            group.append(following)
            index += 1
        output.append({**group[-1], "id": first["id"], "title": first["title"],
                       "heading_variants": [{"id": item["id"], "title": item["title"]} for item in group]})
        index += 1
    return output


def acquire_fundgao():
    raw = (CACHE / "fundgao-上.txt").read_bytes()
    expected = "e69e69a7542b7c5729cecd75654328db2892b6e65564c34520b707469240cbb9"
    if digest(raw) != expected:
        raise ValueError("pinned fundgao main-novel fingerprint mismatch")
    destination = CACHE / "fundgao-comparison"
    entries = coalesce_empty_headers(split_comparison_text(raw.decode("gb18030")))
    metadata = []
    for entry in entries:
        chapter_path = destination / "chapters" / f"{entry['id']}.txt"
        chapter_path.parent.mkdir(parents=True, exist_ok=True)
        chapter_path.write_text(entry["body"], encoding="utf-8")
        metadata.append({key: value for key, value in entry.items() if key != "body"} | {
            "status": "acquired-comparison-only" if entry["body"] else "empty-comparison-chapter", "url": "https://github.com/fundgao/xiuxian/blob/b75ea20180a209ffd7eba6f5ac4559324be0b763/凡人修仙传/凡人修仙传-上.txt"})
    write_json(destination / "acquisition.json", metadata)
    return destination, expected


def collate(source="hjwzw"):
    comparison_cache, catalogue_hash = (acquire_fundgao() if source == "fundgao" else
        (COMPARISON_CACHE, digest((COMPARISON_CACHE / "catalogue.html").read_bytes())))
    normalizer = ComparisonNormalizer()
    primary = [json.loads(line) for line in (AUTHORING / "coverage/chapters.jsonl").read_text().splitlines()]
    acquired = json.loads((comparison_cache / "acquisition.json").read_text())
    comparison_entries = [{**entry, "title": normalizer.simplified(entry["title"])} for entry in acquired]
    aligned, issues = align([{"title": entry["catalogue_title"]} for entry in primary], comparison_entries)
    results = []
    for index, chapter in enumerate(primary):
        entry = aligned.get(index)
        if not entry or entry["status"] != "acquired-comparison-only":
            results.append({"chapter_id": chapter["id"], "status": "comparison-unavailable-or-unaligned", "triage_priority": 0})
            continue
        original = (CACHE / "chapters" / f"{chapter['id']}.txt").read_bytes().decode("utf-8")
        other = (comparison_cache / "chapters" / f"{entry['id']}.txt").read_bytes().decode("utf-8")
        if digest(original) != chapter["sha256"] or digest(other) != entry["body_sha256"]:
            raise ValueError("comparison source fingerprint drift")
        first, second = normalizer.compact(original), normalizer.compact(other)
        result = {"chapter_id": chapter["id"], "comparison_id": entry["id"], "url": entry["url"],
                  "candidate_sha256": chapter["sha256"], "comparison_sha256": entry["body_sha256"],
                  "candidate_normalized_sha256": digest(first), "comparison_normalized_sha256": digest(second),
                  "format_relation": format_relation(original, other, normalizer),
                  **compare_chapter(first, second)}
        detail_path = comparison_cache / "collation" / f"{chapter['id']}.json"
        write_json(detail_path, result)
        result["difference_count"] = len(result["differences"])
        result["detail_sha256"] = digest(detail_path.read_bytes())
        del result["differences"]
        results.append(result)
        if len(results) % 100 == 0:
            print(json.dumps({"comparison_chapters_collated": len(results), "total": len(primary)}), flush=True)
    report = {"format_version": 1, "status": "comparison-evidence-not-final-edition-review", "source": source,
              "catalogue_or_source_sha256": catalogue_hash,
              "normalizer": normalizer.metadata, "working_text_replaced": False,
              "counts": dict(Counter(row["status"] for row in results)),
              "format_counts": dict(Counter(row.get("format_relation", "unavailable") for row in results)),
              "difference_class_counts": dict(sum((Counter(row.get("difference_classes", {})) for row in results), Counter())),
              "triage_note": "优先级只安排校勘工作，不批准版本；语气助词、数量词和短词改动仍可能改变事实。",
              "alignment_issues": issues, "chapters": results}
    write_json(AUTHORING / f"sources/comparison-{source}.json", report)
    write_json(AUTHORING / f"sources/comparison-{source}-priority.json", {
        "comparison_report_sha256": digest((AUTHORING / f"sources/comparison-{source}.json").read_bytes()),
        **comparison_triage(report)})
    print(json.dumps(report["counts"], ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["acquire", "collate", "collate-fundgao"])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    if args.workers < 1 or args.workers > 4:
        raise ValueError("comparison-site concurrency must be between 1 and 4")
    acquire(args.limit, args.workers) if args.command == "acquire" else collate("fundgao" if args.command == "collate-fundgao" else "hjwzw")


if __name__ == "__main__":
    main()
