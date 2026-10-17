"""Structural source-audit regressions use original miniature fixtures."""

import unittest
import tempfile
from pathlib import Path

from fanren_sources import align, batch_parts, catalogue_entries, compare_source, split_text, title_key, digest, apply_source_repairs, store_working_chapter, revised_batch_parts


class SourceAuditTests(unittest.TestCase):
    def test_numbering_never_merges_different_chapters(self):
        text = "第一章 山边小村\n甲\n第二章 两人\n乙\n第二章 重号\n丙\n第三章 飞升仙界\n丁\n凡人外传·仙界篇 一\n戊"
        chapters, supplements = split_text(text)
        self.assertEqual(len(chapters), 4)
        self.assertEqual(chapters[-1]["body"], "丁")
        self.assertEqual(len(supplements), 1)
        catalog = [{"id": str(i), "title": x["title"]} for i, x in enumerate(chapters)]
        matches, issues = align(chapters, catalog)
        self.assertEqual(len(matches), 4)
        self.assertEqual(issues, [])

    def test_catalogue_notice_and_unusual_chapter_uuid(self):
        entries = catalogue_entries([{"vN": "VIP卷", "cs": [
            {"id": 27504173, "uuid": 3813, "cN": "第二章更过了，向大家求下月票！", "cnt": 295, "uT": "2010"},
            {"id": 26965056, "uuid": 2522, "cN": "第七卷 纵横人界 第一千一百四十七章", "cnt": 3076, "uT": "2010"},
        ]}])
        self.assertEqual([entry["kind"] for entry in entries], ["supplement", "main"])

    def test_preview_cannot_pass_as_full_text(self):
        reference = "甲" * 300
        result = compare_source(reference + "乙" * 2700, reference, 3000)
        self.assertEqual(result["kind"], "preview")
        self.assertTrue(result["exact"])
        self.assertEqual(compare_source("甲乙", "甲乙", 2)["kind"], "full")

    def test_batch_limits_and_no_loss_on_long_paragraph(self):
        chapters = [{"id": str(i), "body": "甲" * size} for i, size in enumerate([30_100] + [30] * 20)]
        batches = batch_parts(chapters)
        for batch in batches:
            self.assertLessEqual(batch["characters"], 20_000)
            self.assertLessEqual(len({part["chapter_id"] for part in batch["parts"]}), 8)
            self.assertFalse(batch["read"] or batch["extracted"] or batch["reviewed"])
        for chapter in chapters:
            parts = [part for batch in batches for part in batch["parts"] if part["chapter_id"] == chapter["id"]]
            self.assertEqual(parts[0]["start"], 0)
            self.assertEqual(parts[-1]["end"], len(chapter["body"]))
            self.assertTrue(all(a["end"] == b["start"] for a, b in zip(parts, parts[1:])))

    def test_source_repair_rebatches_only_the_changed_unit_and_preserves_order(self):
        chapters = [{"id": str(i), "body": "甲" * 8} for i in range(6)]
        old = batch_parts(chapters, max_characters=20)
        previous = {c["id"]: {"sha256": digest(c["body"]), "characters": len(c["body"])} for c in chapters}
        chapters[1]["body"] += "乙" * 8
        updated = revised_batch_parts(chapters, old, previous, max_characters=20)
        self.assertEqual([b["id"] for b in updated], ["batch-0001", "batch-0004", "batch-0002", "batch-0003"])
        self.assertEqual(updated[2:], old[1:])
        self.assertEqual([p["chapter_id"] for b in updated for p in b["parts"]], [str(i) for i in range(6)])
        self.assertEqual(sum(b["characters"] for b in updated), 56)
        self.assertTrue(all(b["characters"] <= 20 for b in updated))
        self.assertFalse(any(b["read"] or b["reviewed"] for b in updated))
        current = {c["id"]: {"sha256": digest(c["body"]), "characters": len(c["body"])} for c in chapters}
        self.assertEqual(revised_batch_parts(chapters, updated, current, max_characters=20), updated)
        with self.assertRaisesRegex(ValueError, "identities"):
            revised_batch_parts(chapters, updated + [updated[0]], current, max_characters=20)
        with self.assertRaisesRegex(ValueError, "inventory"):
            revised_batch_parts(chapters[:-1], updated, current, max_characters=20)
        updated[2]["parts"][0]["sha256"] = "drift"
        with self.assertRaisesRegex(ValueError, "drift"):
            revised_batch_parts(chapters, updated, current, max_characters=20)

    def test_chapter_gap_stays_unresolved(self):
        _, issues = align([{"title": "第一章 甲"}, {"title": "第二章 乙"}],
                          [{"id": "a", "title": "第一章 甲"}, {"id": "b", "title": "第二章 缺"}, {"id": "c", "title": "第三章 乙"}])
        self.assertEqual(issues[0]["kind"], "alignment_gap")
        self.assertEqual(issues[0]["status"], "unresolved")

    def test_only_editorial_title_suffix_is_removed(self):
        self.assertEqual(title_key("第三卷 第二百六十八章 白蜘蛛"), "白蜘蛛")
        self.assertEqual(title_key("第十卷 魔界之战 第一千八百二十九章 切磋（中）"), "切磋中")
        self.assertEqual(title_key("第一百章 嘉元城（求月票）"), "嘉元城")


class SourceRepairTests(unittest.TestCase):
    def test_working_source_replacement_archives_previous_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "chapters/chapter-a.txt"
            store_working_chapter(source, "原始正文。")
            store_working_chapter(source, "原始正文。\n补齐结尾。")
            archived = source.parent / "revisions/chapter-a" / f"{digest('原始正文。')}.txt"
            self.assertEqual(archived.read_bytes(), "原始正文。".encode())
            self.assertEqual(source.read_text(), "原始正文。\n补齐结尾。")
            store_working_chapter(source, source.read_text())
            self.assertEqual(len(list(archived.parent.iterdir())), 1)

    def manifest(self, source, base="原始正文。", prefix="补入的证据。\n"):
        return {"format_version": 1, "repairs": [{
            "id": "gap", "chapter_id": "chapter-a", "status": "adopted-working-text",
            "working_version": "mixed-working-v1", "base_sha256": digest(base),
            "reviewer": "source-editor", "notes": ["Fixture comparison"],
            "insertions": [{"at": 0, "source": {"id": "comparison", "path": source.name,
                "sha256": digest(source.read_bytes())}, "start": 0, "end": len(prefix), "sha256": digest(prefix)}],
            "result_sha256": digest(prefix + base),
        }]}

    def test_repair_preserves_base_and_exact_segment_lineage(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            source = cache / "comparison.txt"
            source.write_text("补入的证据。\n后面的对照文字", encoding="utf-8")
            manifest = self.manifest(source)
            result, lineage = apply_source_repairs("chapter-a", "原始正文。", manifest, cache)
            self.assertEqual(result, "补入的证据。\n原始正文。")
            self.assertEqual(lineage["version"], "mixed-working-v1")
            self.assertEqual(lineage["segments"][0]["source_end"], 7)
            self.assertEqual(lineage["segments"][1]["start"], 7)
            self.assertEqual(source.read_text(), "补入的证据。\n后面的对照文字")
            unchanged, origin = apply_source_repairs("chapter-b", "其他正文", manifest, cache)
            self.assertEqual(unchanged, "其他正文")
            self.assertEqual(origin["version"], "candidate-2fc16984")

    def test_stale_base_and_tampered_comparison_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            source = cache / "comparison.txt"
            source.write_text("补入的证据。\n", encoding="utf-8")
            manifest = self.manifest(source)
            with self.assertRaisesRegex(ValueError, "stale"):
                apply_source_repairs("chapter-a", "另一正文", manifest, cache)
            source.write_text("被替换", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "fingerprint mismatch"):
                apply_source_repairs("chapter-a", "原始正文。", manifest, cache)

    def test_invalid_span_escape_and_output_fingerprint_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            source = cache / "comparison.txt"
            source.write_text("补入的证据。\n", encoding="utf-8")
            for field, value, message in [("end", 999, "span"), ("at", -1, "insertion")]:
                manifest = self.manifest(source)
                manifest["repairs"][0]["insertions"][0][field] = value
                with self.assertRaisesRegex(ValueError, message):
                    apply_source_repairs("chapter-a", "原始正文。", manifest, cache)
            manifest = self.manifest(source)
            manifest["repairs"][0]["insertions"][0]["source"]["path"] = "../outside.txt"
            with self.assertRaisesRegex(ValueError, "escapes"):
                apply_source_repairs("chapter-a", "原始正文。", manifest, cache)
            manifest = self.manifest(source)
            manifest["repairs"][0]["result_sha256"] = "wrong"
            with self.assertRaisesRegex(ValueError, "output fingerprint"):
                apply_source_repairs("chapter-a", "原始正文。", manifest, cache)


if __name__ == "__main__":
    unittest.main()
