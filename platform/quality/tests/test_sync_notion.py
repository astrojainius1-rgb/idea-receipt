"""Tests for sync_notion.py's heading -> (title, tags) parsing rule.

Runs with either pytest (`python3 -m pytest`) or plain unittest
(`python3 -m unittest`). Stdlib only — matches sync_notion.py's no-deps policy.

We do NOT modify sync_notion.py. Its parsing logic currently lives inline in
`build_items` (see lines parsing `raw` -> tags/title), so this test re-expresses
that exact rule in `parse_heading()` and pins its behaviour with fixtures shared
with the JS side (platform/quality/lib/receipt.js `parseHeading`). The proposed
refactor (docs/PLAN-platform.md) extracts a real `parse_heading()` into
sync_notion.py; when that lands, swap the local copy below for:

    from importlib import import_module
    parse_heading = import_module("sync_notion").parse_heading

and delete the inline reference implementation.
"""
import re
import unittest


def parse_heading(raw):
    """Exact mirror of sync_notion.build_items' heading rule.

    In sync_notion.py the caller does `raw = plain_text(...).rstrip(":").strip()`
    BEFORE this logic; we fold that normalisation in here so the function is
    self-contained and testable.
    """
    raw = (raw or "")
    # caller normalisation: drop a trailing ":" and surrounding whitespace
    raw = raw.rstrip(":").strip()
    tags = re.findall(r"#(\w[\w-]*)", raw)
    title = re.sub(r"\s*#\w[\w-]*", "", raw).strip() or raw
    return title, tags


class TestParseHeading(unittest.TestCase):
    def test_extracts_hashtags_and_strips_from_title(self):
        title, tags = parse_heading("Shower Speaker #hardware #fun")
        self.assertEqual(title, "Shower Speaker")
        self.assertEqual(tags, ["hardware", "fun"])

    def test_no_tags(self):
        title, tags = parse_heading("3D Printed Lamps")
        self.assertEqual(title, "3D Printed Lamps")
        self.assertEqual(tags, [])

    def test_strips_trailing_colon_toggle_heading(self):
        title, tags = parse_heading("Claude Reminder:")
        self.assertEqual(title, "Claude Reminder")
        self.assertEqual(tags, [])

    def test_hyphenated_and_numeric_tag_bodies(self):
        title, tags = parse_heading("App #side-project #v2")
        self.assertEqual(title, "App")
        self.assertEqual(tags, ["side-project", "v2"])

    def test_tag_only_heading_falls_back_to_raw(self):
        # mirrors `title = ... or raw`
        title, tags = parse_heading("#idea")
        self.assertEqual(tags, ["idea"])
        self.assertEqual(title, "#idea")

    def test_tag_in_the_middle(self):
        title, tags = parse_heading("Build #urgent the thing")
        self.assertEqual(title, "Build the thing")
        self.assertEqual(tags, ["urgent"])

    def test_empty_and_none(self):
        self.assertEqual(parse_heading(""), ("", []))
        self.assertEqual(parse_heading(None), ("", []))

    def test_a_hash_without_word_char_is_not_a_tag(self):
        # `#` followed by non-word (e.g. "#1" -> body starts with digit IS a word
        # char, so it IS a tag; "# " is not). Pin the boundary case:
        title, tags = parse_heading("C# tips")
        # "#" here is preceded by 'C' but the regex is unanchored, so "#" before a
        # space matches nothing; "C# tips" has no \w after # -> no tag.
        self.assertEqual(tags, [])
        self.assertEqual(title, "C# tips")


if __name__ == "__main__":
    unittest.main()
