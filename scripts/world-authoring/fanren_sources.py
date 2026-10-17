"""Acquire public source evidence and audit the Fanren main-novel candidate.

Raw text stays in the ignored cache. Metadata never implies semantic review.
"""

import argparse
import concurrent.futures
import difflib
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".livingworld-cache/fanren-sources"
AUTHORING = ROOT / "worlds/fanren/authoring"
INDEX_URL = "https://fanrenxiuxianzhuan.bookresource.qq.com/"
TEXT_PATH = "《凡人修仙传》（校对版全本+番外）作者：忘语.txt"
TEXT_REVISION = "094be1bb8dd4c8ed26bc2b298ec2351b6d22fa03"
TEXT_URL = f"https://raw.githubusercontent.com/qiuliw/Books/{TEXT_REVISION}/" + urllib.parse.quote(TEXT_PATH)
TEXT_SHA256 = "2fc1698410418bf136448807335c6359bf515b75e6f9c1e1d1f443a1c928e6cc"
NUMBER = r"[一二三四五六七八九十百千万零〇两白\d]+"
CHAPTER = re.compile(rf"^第{NUMBER}章[^\n]*$", re.M)
VOLUME = re.compile(rf"^第{NUMBER}卷[^\n]*$", re.M)
SUPPLEMENT = re.compile(r"^凡人外传[^\n]*$", re.M)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def page_data(html):
    match = re.search(r'<script id="vite-plugin-ssr_pageContext" type="application/json">(.*?)</script>', html, re.S)
    if not match:
        raise ValueError("page has no source data; a challenge page is not a catalogue")
    return json.loads(match[1])["pageContext"]["pageProps"]["pageData"]


def fetch(url, destination):
    if destination.exists():
        return destination.read_bytes()
    with urllib.request.urlopen(url, timeout=35) as response:
        if response.status != 200:
            raise ValueError(f"unexpected HTTP status {response.status}: {url}")
        body = response.read()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)
    return body


def catalogue_entries(volumes):
    entries = []
    for volume in volumes:
        for chapter in volume["cs"]:
            # Two actual chapters have supplemental UUIDs. Chapter identity and
            # textual title take precedence over the site's sequence counter.
            is_main = volume["vN"] != "作品相关" and (
                chapter["uuid"] <= 2450 or chapter["id"] in {24317020, 26965056}
            )
            entries.append({
                "id": f"qq-{chapter['id']}", "source_id": chapter["id"],
                "source_uuid": chapter["uuid"], "title": chapter["cN"],
                "volume": volume["vN"], "source_word_count": chapter["cnt"],
                "published_at": chapter["uT"], "kind": "main" if is_main else "supplement",
                "url": f"{INDEX_URL}chapter/107580/{chapter['id']}/",
            })
    if len({entry["id"] for entry in entries}) != len(entries):
        raise ValueError("duplicate source chapter identity in catalogue")
    return entries


def split_text(text):
    markers = sorted([(m.start(), m.end(), "chapter", m[0]) for m in CHAPTER.finditer(text)] +
                     [(m.start(), m.end(), "volume", m[0]) for m in VOLUME.finditer(text)] +
                     [(m.start(), m.end(), "supplement", m[0]) for m in SUPPLEMENT.finditer(text)])
    chapters, supplements = [], []
    for index, (start, end, kind, title) in enumerate(markers):
        next_start = markers[index + 1][0] if index + 1 < len(markers) else len(text)
        if kind == "volume":
            continue
        body = text[end:next_start].strip()
        record = {"ordinal": len(chapters) + 1, "title": title, "body": body,
                  "start": start, "end": next_start, "sha256": digest(body)}
        (chapters if kind == "chapter" else supplements).append(record)
    if not chapters or "山边小村" not in chapters[0]["title"] or "飞升仙界" not in chapters[-1]["title"]:
        raise ValueError("main-novel boundaries are missing or contaminated")
    return chapters, supplements


def title_key(title):
    title = title.replace("（", "(").replace("）", ")")
    title = re.sub(rf"^第?{NUMBER}卷\s*", "", title)
    title = re.sub(r"^(?:七玄门风云|初踏修仙路|魔道入侵|风起海外|名震一方|通天灵宝|纵横人界|初入灵界|灵界百族|魔界之战|真仙降[世临])\s*", "", title)
    title = re.sub(rf"^(?:第?{NUMBER}\s*章\s*)+", "", title)
    title = re.sub(r"\([^)]*(?:月票|票票|快乐|更完|解禁|第[一二三四五六七八九十]+更)[^)]*\)", "", title)
    return re.sub(r"[\s,，、()！!。.?？]", "", title)


def align(chapters, catalogue):
    left = [title_key(chapter["title"]) for chapter in chapters]
    right = [title_key(chapter["title"]) for chapter in catalogue]
    matches, issues = {}, []
    for operation, i, i_end, j, j_end in difflib.SequenceMatcher(None, left, right, autojunk=False).get_opcodes():
        if operation == "equal" or (operation == "replace" and i_end - i == j_end - j):
            for source_index, catalog_index in zip(range(i, i_end), range(j, j_end)):
                entry = catalogue[catalog_index]
                matches[source_index] = entry
                if operation != "equal":
                    issues.append({"kind": "title_difference", "chapter_id": entry["id"],
                                   "candidate": chapters[source_index]["title"], "catalogue": entry["title"],
                                   "status": "needs_text_comparison"})
        else:
            issues.append({"kind": "alignment_gap", "candidate_ordinals": list(range(i + 1, i_end + 1)),
                           "catalogue_ids": [entry["id"] for entry in catalogue[j:j_end]], "status": "unresolved"})
    return matches, issues


def compact_text(text):
    return re.sub(r"\s+", "", text)


def compare_source(candidate, reference, expected_words):
    candidate, reference = compact_text(candidate), compact_text(reference)
    if not reference:
        return {"kind": "unavailable", "similarity": None}
    kind = "full" if len(reference) >= expected_words * 0.85 else "preview"
    sample = candidate if kind == "full" else candidate[:len(reference)]
    similarity = difflib.SequenceMatcher(None, sample, reference, autojunk=False).ratio()
    return {"kind": kind, "reference_characters": len(reference), "similarity": round(similarity, 6),
            "reference_sha256": digest(reference), "exact": sample == reference}


def batch_parts(chapters, max_chapters=8, max_characters=20_000):
    """Plan bounded reading units without assigning any semantic completion."""
    batches, current, count = [], [], 0
    for chapter in chapters:
        body = chapter["body"]
        offset = 0
        while offset < len(body):
            remaining = max_characters - count
            if current and (len({part["chapter_id"] for part in current}) >= max_chapters or len(body) - offset > remaining):
                batches.append(current)
                current, count, remaining = [], 0, max_characters
            end = min(len(body), offset + remaining)
            if end < len(body):
                boundary = body.rfind("\n", offset, end)
                if boundary > offset:
                    end = boundary + 1
            current.append({"chapter_id": chapter["id"], "start": offset, "end": end,
                            "sha256": digest(body[offset:end]), "characters": end - offset})
            count += end - offset
            offset = end
            if count == max_characters:
                batches.append(current)
                current, count = [], 0
    if current:
        batches.append(current)
    return [{"id": f"batch-{index:04}", "parts": parts, "characters": sum(part["characters"] for part in parts),
             "read": False, "extracted": False, "reviewed": False} for index, parts in enumerate(batches, 1)]


def revised_batch_parts(chapters, previous_batches, previous_rows, max_chapters=8, max_characters=20_000):
    """Rebuild changed reading units without renumbering unrelated evidence."""
    if not previous_batches:
        return batch_parts(chapters, max_chapters, max_characters)
    bodies = {chapter["id"]: chapter["body"] for chapter in chapters}
    covered_ids = {part["chapter_id"] for batch in previous_batches for part in batch["parts"]}
    if set(bodies) != covered_ids:
        raise ValueError("source chapter inventory changed; explicit batch replan required")
    identities = [batch["id"] for batch in previous_batches]
    if len(set(identities)) != len(identities) or any(not re.fullmatch(r"batch-\d+", identity) for identity in identities):
        raise ValueError("invalid previous reading batch identities")
    next_id = max(int(identity.split("-")[1]) for identity in identities) + 1
    changed = {identity for identity, body in bodies.items() if previous_rows.get(identity, {}).get("sha256") != digest(body)}
    output = []
    for batch in previous_batches:
        parts = batch["parts"]
        if not any(part["chapter_id"] in changed for part in parts):
            if any(digest(bodies[part["chapter_id"]][part["start"]:part["end"]]) != part["sha256"] for part in parts):
                raise ValueError("unchanged reading part fingerprint drift")
            output.append(batch)
            continue
        chunks, offsets = [], {}
        for part in parts:
            identity = part["chapter_id"]
            if identity in offsets:
                raise ValueError("repeated chapter in a changed batch requires explicit replan")
            if identity in changed:
                if part["start"] != 0 or part["end"] != previous_rows.get(identity, {}).get("characters"):
                    raise ValueError("changed split chapter requires explicit source-span replan")
                body, start = bodies[identity], 0
            else:
                start = part["start"]
                body = bodies[identity][start:part["end"]]
                if digest(body) != part["sha256"]:
                    raise ValueError("unchanged reading part fingerprint drift")
            chunks.append({"id": identity, "body": body})
            offsets[identity] = start
        for index, revised in enumerate(batch_parts(chunks, max_chapters, max_characters)):
            revised["id"] = batch["id"] if index == 0 else f"batch-{next_id:04}"
            if index:
                next_id += 1
            for part in revised["parts"]:
                part["start"] += offsets[part["chapter_id"]]
                part["end"] += offsets[part["chapter_id"]]
            output.append(revised)
    for batch in output:
        if batch["characters"] > max_characters or len({part["chapter_id"] for part in batch["parts"]}) > max_chapters:
            raise ValueError("revised reading batch exceeds source-input limits")
    return output


def apply_source_repairs(chapter_id, body, manifest, cache):
    """Apply reviewed insertions without changing or discarding candidate bytes.

    A repair binds the complete input, complete auxiliary source, selected span,
    and complete output. Lineage uses Unicode code-point offsets throughout.
    """
    if manifest.get("format_version") != 1:
        raise ValueError("unsupported source repair manifest")
    repairs = [repair for repair in manifest.get("repairs", []) if repair["chapter_id"] == chapter_id]
    if len(repairs) > 1:
        raise ValueError(f"duplicate source repair {chapter_id}")
    base_hash = digest(body)
    base_segment = {"kind": "candidate", "source_sha256": base_hash, "source_start": 0,
                    "source_end": len(body), "start": 0, "end": len(body)}
    if not repairs:
        return body, {"version": "candidate-2fc16984", "segments": [base_segment]}
    repair = repairs[0]
    if repair.get("status") != "adopted-working-text" or repair.get("base_sha256") != base_hash:
        raise ValueError(f"source repair is unapproved or stale: {chapter_id}")
    if not repair.get("reviewer") or not repair.get("notes"):
        raise ValueError("source repair needs reviewer and collation notes")
    result, segments, consumed, output_offset = [], [], 0, 0
    seen_positions = set()
    operations = repair.get("insertions", [])
    if not operations:
        raise ValueError("source repair contains no insertions")
    for insertion in operations:
        at = insertion["at"]
        if not isinstance(at, int) or at < consumed or at > len(body) or at in seen_positions:
            raise ValueError("invalid or unordered source insertion")
        seen_positions.add(at)
        if at > consumed:
            chunk = body[consumed:at]
            result.append(chunk)
            segments.append({"kind": "candidate", "source_sha256": base_hash, "source_start": consumed,
                             "source_end": at, "start": output_offset, "end": output_offset + len(chunk)})
            output_offset += len(chunk)
        source = insertion["source"]
        source_path = (cache / source["path"]).resolve()
        if not source_path.is_relative_to(cache.resolve()):
            raise ValueError("source insertion escapes the cache")
        raw = source_path.read_bytes()
        if digest(raw) != source["sha256"]:
            raise ValueError("source insertion file fingerprint mismatch")
        text = raw.decode("utf-8")
        start, end = insertion["start"], insertion["end"]
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start or end > len(text):
            raise ValueError("invalid source insertion span")
        chunk = text[start:end]
        if digest(chunk) != insertion["sha256"]:
            raise ValueError("source insertion span fingerprint mismatch")
        result.append(chunk)
        segments.append({"kind": "comparison-source", "source_id": source["id"], "source_sha256": source["sha256"],
                         "source_start": start, "source_end": end, "start": output_offset, "end": output_offset + len(chunk)})
        output_offset += len(chunk)
        consumed = at
    if consumed < len(body):
        chunk = body[consumed:]
        result.append(chunk)
        segments.append({"kind": "candidate", "source_sha256": base_hash, "source_start": consumed,
                         "source_end": len(body), "start": output_offset, "end": output_offset + len(chunk)})
    value = "".join(result)
    if digest(value) != repair["result_sha256"]:
        raise ValueError("source repair output fingerprint mismatch")
    return value, {"version": repair["working_version"], "repair_id": repair["id"], "segments": segments}


def store_working_chapter(path, body):
    """Retain every superseded byte sequence before advancing a working source."""
    raw = body.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        previous = path.read_bytes()
        if previous == raw:
            return
        revision = path.parent / "revisions" / path.stem / f"{digest(previous)}.txt"
        revision.parent.mkdir(parents=True, exist_ok=True)
        if revision.exists() and revision.read_bytes() != previous:
            raise ValueError("archived source fingerprint collision")
        revision.write_bytes(previous)
    temporary = path.with_suffix(".txt.tmp")
    temporary.write_bytes(raw)
    temporary.replace(path)


def acquire():
    fetch(INDEX_URL, CACHE / "qq-index.html")
    raw = fetch(TEXT_URL, CACHE / "fanren-candidate.txt")
    if digest(raw) != TEXT_SHA256:
        raise ValueError("candidate source fingerprint differs from the pinned edition")
    # This pinned candidate is GB18030. Decode strictly: replacement is corruption.
    (CACHE / "fanren-candidate.utf8.txt").write_text(raw.decode("gb18030"), encoding="utf-8")


def acquire_references(entries, limit):
    targets = [entry for entry in entries if entry["kind"] == "main"]
    if limit is not None:
        targets = targets[:limit]

    def retrieve(entry):
        path = CACHE / f"qq-{entry['source_id']}.html"
        try:
            if not path.exists():
                time.sleep(0.5)
            data = page_data(fetch(entry["url"], path).decode("utf-8"))["chapterInfo"]
            if str(data["chapterId"]) != str(entry["source_id"]):
                raise ValueError("chapter identity mismatch")
            return {"id": entry["id"], "status": "cached", "characters": len(data.get("content", ""))}
        except Exception as error:
            return {"id": entry["id"], "status": "error", "detail": str(error)}

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        for result in executor.map(retrieve, targets):
            results.append(result)
            if len(results) % 100 == 0:
                print(json.dumps({"references_processed": len(results), "total": len(targets)}, ensure_ascii=False), flush=True)
    write_json(CACHE / "reference-acquisition.json", results)


def audit():
    raw_index = (CACHE / "qq-index.html").read_bytes()
    entries = catalogue_entries(page_data(raw_index.decode())["vs"])
    raw_text = (CACHE / "fanren-candidate.txt").read_bytes()
    if digest(raw_text) != TEXT_SHA256:
        raise ValueError("candidate source fingerprint differs from the pinned edition")
    text = raw_text.decode("gb18030")
    chapters, supplements = split_text(text)
    matches, issues = align(chapters, [entry for entry in entries if entry["kind"] == "main"])
    old_path = AUTHORING / "coverage/chapters.jsonl"
    previous = {row["id"]: row for row in map(json.loads, old_path.read_text().splitlines())} if old_path.exists() else {}
    batch_path = AUTHORING / "coverage/batches.json"
    previous_batches = json.loads(batch_path.read_text()) if batch_path.exists() else []
    repair_path = AUTHORING / "sources/repairs.json"
    repairs = json.loads(repair_path.read_text()) if repair_path.exists() else {"format_version": 1, "repairs": []}
    rows, bodies = [], []
    hashes = Counter(chapter["sha256"] for chapter in chapters)
    for index, chapter in enumerate(chapters):
        entry = matches.get(index)
        identity = entry["id"] if entry else f"candidate-{index + 1:04}"
        body, lineage = apply_source_repairs(identity, chapter["body"], repairs, CACHE)
        working_hash = digest(body)
        body_path = CACHE / "chapters" / f"{identity}.txt"
        store_working_chapter(body_path, body)
        reference_path = CACHE / f"qq-{entry['source_id']}.html" if entry else None
        comparison = None
        if reference_path and reference_path.exists():
            info = page_data(reference_path.read_text())["chapterInfo"]
            comparison = compare_source(body, info.get("content", ""), info["actualWords"])
        previous_row = previous.get(identity, {})
        unchanged = previous_row.get("sha256") == working_hash
        row = {"id": identity, "ordinal": index + 1, "candidate_title": chapter["title"],
               "catalogue_title": entry["title"] if entry else None,
               "characters": len(body), "sha256": working_hash,
               "candidate_sha256": chapter["sha256"], "source_version": lineage["version"],
               "source_segments": lineage["segments"],
               "acquired": True, "catalogue_aligned": entry is not None, "reference_comparison": comparison,
               "read": previous_row.get("read", False) if unchanged else False,
               "extracted": previous_row.get("extracted", False) if unchanged else False,
               "reviewed": previous_row.get("reviewed", False) if unchanged else False}
        if hashes[chapter["sha256"]] > 1:
            issues.append({"kind": "duplicate_body", "chapter_id": identity, "status": "unresolved"})
        if "\ufffd" in chapter["body"]:
            issues.append({"kind": "replacement_character", "chapter_id": identity, "status": "unresolved"})
        if comparison and comparison["similarity"] is not None and comparison["similarity"] < 0.9:
            issues.append({"kind": "text_difference", "chapter_id": identity, "comparison": comparison, "status": "unresolved"})
        rows.append(row)
        bodies.append({"id": identity, "body": body})
    write_json(AUTHORING / "sources/catalogue.json", entries)
    old_path.parent.mkdir(parents=True, exist_ok=True)
    old_path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")
    # Keep source changes from silently preserving review against different bytes.
    batches = revised_batch_parts(bodies, previous_batches, previous)
    write_json(batch_path, batches)
    write_json(AUTHORING / "sources/discrepancies.json", issues)
    report = {"format_version": 1, "audited_at": datetime.now(timezone.utc).isoformat(),
              "candidate": {"url": TEXT_URL, "git_revision": TEXT_REVISION, "sha256": digest(raw_text), "encoding": "gb18030", "bytes": len(raw_text),
                            "characters_with_supplements": len(text), "status": "acquired_not_fully_collated"},
              "catalogue": {"url": INDEX_URL, "sha256": digest(raw_index), "items": len(entries),
                            "main_items": sum(entry["kind"] == "main" for entry in entries)},
              "qidian_catalogue": {"url": "https://www.qidian.com/book/107580/catalog/", "status": "http_202_challenge"},
              "main_chapters": len(chapters), "aligned_chapters": len(matches),
              "working_repairs": [{"id": repair["id"], "chapter_id": repair["chapter_id"],
                                   "result_sha256": repair["result_sha256"]} for repair in repairs["repairs"]],
              "excluded_supplements": [{"title": part["title"], "sha256": part["sha256"]} for part in supplements],
              "reference_comparisons": dict(Counter(row["reference_comparison"]["kind"] if row["reference_comparison"] else "not_acquired" for row in rows)),
              "issues": dict(Counter(issue["kind"] for issue in issues)), "batches": len(batches),
              "semantic_progress": {key: sum(row[key] for row in rows) for key in ["read", "extracted", "reviewed"]}}
    write_json(AUTHORING / "sources/baseline.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["acquire", "references", "audit"])
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if args.command == "acquire":
        acquire()
    elif args.command == "references":
        entries = catalogue_entries(page_data((CACHE / "qq-index.html").read_text())["vs"])
        acquire_references(entries, args.limit)
    else:
        audit()


if __name__ == "__main__":
    main()
