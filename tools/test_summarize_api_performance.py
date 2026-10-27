from datetime import datetime, timezone
import json
import unittest
from summarize_api_performance import summarize


class SummaryTests(unittest.TestCase):
    def test_weighted_cache_totals_and_missing_older_fields(self):
        result = summarize([
            '2026-10-27T10:01:00Z INFO public cache interval lane="item" requests=10 hits=9 rebuilds=1 collisions=2 lookup_ms=10 wait_ms=5 build_ms=40',
            '2026-10-27T10:02:00Z INFO public cache interval lane="item" requests=90 hits=9 rebuilds=81 cold=40 expired=20 invalidated=21 evictions=3 bypasses=1 entries=32 lookup_ms=90 wait_ms=45 key_wait_ms=20 permit_wait_ms=25 build_ms=160',
            '2026-10-27T10:02:00Z INFO public cache interval lane="watch" requests=1 hits=0 rebuilds=1 collisions=0 lookup_ms=1 wait_ms=2 build_ms=10',
        ], datetime(2026, 10, 27, 10, tzinfo=timezone.utc), datetime(2026, 10, 27, 11, tzinfo=timezone.utc))
        row = result["cache"]["item"]
        self.assertEqual((row["hit_percent"], row["mean_lookup_ms"], row["mean_wait_ms"]), (18, 1, .5))
        self.assertEqual((row["collisions"], row["cause_intervals"], row["entries_max"]), (2, 1, 32))
        self.assertEqual(row["mean_build_ms"], round(200 / 82, 3))
        self.assertEqual(row["mean_key_wait_ms"], round(20 / 90, 3))
        self.assertIsNone(result["cache"]["watch"]["entries_max"])
        self.assertIsNone(result["cache"]["watch"]["evictions"])
        self.assertIsNone(result["cache"]["watch"]["mean_key_wait_ms"])

    def test_window_and_slow_only_quantiles_exclude_private_log_text(self):
        result = summarize([
            '2026-10-27T09:59:00Z WARN slow API request route="/api/v1/items/{id}" elapsed_ms=900 status=200',
            '2026-10-27T10:01:00Z WARN slow API request route="/api/v1/items/{id}?secret=private" elapsed_ms=300 status=200',
            '2026-10-27T10:02:00Z WARN slow API request route="/api/v1/items/{id}" elapsed_ms=400 status=200',
            '2026-10-27T10:03:00Z INFO upload batch processed uploads=4 rows=16 elapsed_ms=80 committed=true',
            '2026-10-27T10:03:01Z INFO upload batch processed uploads=2 rows=8 elapsed_ms=120 committed=false',
            '2026-10-27T11:01:00Z ERROR private',
        ], datetime(2026, 10, 27, 10, tzinfo=timezone.utc), datetime(2026, 10, 27, 11, tzinfo=timezone.utc))
        self.assertEqual(result["slow_requests_only"]["/api/v1/items/{id}"],
                         {"count": 2, "median_ms": 350, "p95_ms": 400, "max_ms": 400})
        self.assertEqual(result["upload_batches"]["mean_batch_size"], 3)
        self.assertEqual(result["upload_batches"]["rolled_back"], 1)
        self.assertEqual(result["error_log_count"], 0)
        self.assertNotIn("private", json.dumps(result))

    def test_tail_phases_keep_writer_types_separate_and_exclude_identifiers(self):
        result = summarize([
            '2026-10-27T10:01:00Z INFO slow writer phases kind="roster" outcome="committed" units=1 items=0 elapsed_ms=120 prepare_ms=0 pool_ms=90 lock_ms=5 write_ms=20 stats_ms=0 commit_ms=5 unfinished_ms=0',
            '2026-10-27T10:01:01Z INFO slow writer phases kind="upload" outcome="committed" units=2 items=3 elapsed_ms=150 prepare_ms=1 pool_ms=2 lock_ms=3 write_ms=40 stats_ms=100 commit_ms=4 unfinished_ms=0',
            '2026-10-27T10:01:02Z INFO slow watch phases rows=1000 elapsed_ms=130 quotes_ms=100 grouping_ms=25 metadata_ms=5 private="must not export"',
        ], datetime(2026, 10, 27, 10, tzinfo=timezone.utc), datetime(2026, 10, 27, 11, tzinfo=timezone.utc))
        self.assertEqual(result["slow_writer_phases_only"]["roster"]["mean_pool_ms"], 90)
        self.assertEqual(result["slow_writer_phases_only"]["upload"]["mean_stats_ms"], 100)
        self.assertEqual(result["slow_watch_phases_only"]["mean_quotes_ms"], 100)
        self.assertNotIn("must not export", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
