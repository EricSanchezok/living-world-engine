"""Structural source-audit regressions use original miniature fixtures."""

import unittest

from fanren_sources import align, batch_parts, catalogue_entries, compare_source, split_text, title_key


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

    def test_chapter_gap_stays_unresolved(self):
        _, issues = align([{"title": "第一章 甲"}, {"title": "第二章 乙"}],
                          [{"id": "a", "title": "第一章 甲"}, {"id": "b", "title": "第二章 缺"}, {"id": "c", "title": "第三章 乙"}])
        self.assertEqual(issues[0]["kind"], "alignment_gap")
        self.assertEqual(issues[0]["status"], "unresolved")

    def test_only_editorial_title_suffix_is_removed(self):
        self.assertEqual(title_key("第三卷 第二百六十八章 白蜘蛛"), "白蜘蛛")
        self.assertEqual(title_key("第十卷 魔界之战 第一千八百二十九章 切磋（中）"), "切磋中")
        self.assertEqual(title_key("第一百章 嘉元城（求月票）"), "嘉元城")


if __name__ == "__main__":
    unittest.main()
