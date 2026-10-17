"""Public comparison parsing never grants literary approval or changes sources."""

import unittest

from fanren_comparison import comparison_body, comparison_catalogue, compare_chapter, split_comparison_text, coalesce_empty_headers, comparison_triage


class ComparisonSourceTests(unittest.TestCase):
    def test_catalogue_deduplicates_links_without_merging_equal_titles(self):
        source = '<a href="/Book/Read/1644,1">第一章 山邊小村</a><a href="/Book/Read/1644,1">重复导航</a><a href="/Book/Read/1644,2">第二章 山邊小村</a>'
        rows = comparison_catalogue(source)
        self.assertEqual([row["id"] for row in rows], ["hjwzw-1", "hjwzw-2"])

    def test_body_retains_narrative_with_chapter_word(self):
        prose = "他在书页上看见章字，但这是一段实际叙述。" + "山间日常。" * 80
        source = '<div style="font-size:20px; text-indent: 2em;">請記住本站域名: <b>黃金屋</b><p/>凡人修仙傳 第一章 山邊小村<p/>第一章山邊小村<p/>' + prose + '<p/></div>'
        self.assertEqual(comparison_body(source), prose + "\n")

    def test_challenge_and_short_preview_are_not_full_chapters(self):
        with self.assertRaises(ValueError):
            comparison_body('<html>请先验证</html>')
        with self.assertRaises(ValueError):
            comparison_body('<div style="text-indent: 2em;">第一章 山邊小村<p/>只有很短的预览</div>')

    def test_secondary_headers_preserve_duplicate_chapters_and_raw_offsets(self):
        text = "第一章山边小村\r\n甲乙\r\n第一章山边小村\r\n重复内容\r\n第十一卷真仙降临第两千四百四十六章飞升仙界\r\n终章\r\n"
        chapters = split_comparison_text(text)
        self.assertEqual(len(chapters), 3)
        self.assertEqual(chapters[0]["title"], chapters[1]["title"])
        for chapter in chapters:
            self.assertEqual(text[chapter["source_start"]:chapter["source_end"]], chapter["body"])

    def test_empty_duplicate_heading_is_joined_but_missing_chapter_is_retained(self):
        entries = [
            {"id": "1", "title": "第一章 甲", "body": "", "source_start": 10, "source_end": 10},
            {"id": "2", "title": "第一章 甲异写", "body": "正文", "source_start": 20, "source_end": 22},
            {"id": "3", "title": "第二章 乙", "body": "", "source_start": 30, "source_end": 30},
            {"id": "4", "title": "第三章 丙", "body": "另一正文", "source_start": 40, "source_end": 44},
        ]
        result = coalesce_empty_headers(entries)
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["id"], "1")
        self.assertEqual(result[0]["source_start"], 20)
        self.assertEqual(result[0]["body"], "正文")
        self.assertEqual(result[1]["body"], "")

    def test_large_missing_segment_is_not_equal_or_small_variant(self):
        result = compare_chapter("甲乙丙丁" * 100, "缺失段落" * 50 + "甲乙丙丁" * 100)
        self.assertEqual(result["status"], "needs-segment-collation")
        self.assertEqual(result["largest_variant_characters"], 200)
        self.assertEqual(compare_chapter("完整相等", "完整相等")["status"], "equal-after-comparison-normalization")

    def test_triage_keeps_small_variants_and_separates_source_corruption_leads(self):
        rows = [{"chapter_id": "missing", "status": "comparison-unavailable-or-unaligned", "triage_priority": 0},
                {"chapter_id": "corrupt", "status": "needs-segment-collation", "similarity": 0.1, "triage_priority": 1},
                {"chapter_id": "minor", "status": "small-variants-need-editorial-judgment", "similarity": 0.99, "triage_priority": 3}]
        result = comparison_triage({"chapters": rows})
        self.assertEqual(result["structural_priority_chapter_ids"], ["missing", "corrupt"])
        self.assertEqual(sum(group["chapters"] for group in result["groups"]), 3)
        self.assertEqual(result["groups"][-1]["chapter_ids"], ["minor"])
        self.assertEqual(result["status"], "unadjudicated-work-queue")


if __name__ == "__main__":
    unittest.main()
