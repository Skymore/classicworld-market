import unittest
from unittest.mock import patch
import announce_collector_update as notice

class AnnounceRelease(unittest.TestCase):
    def test_only_verified_latest_stable_release_is_announced(self):
        with patch.object(notice,'read_release',return_value={'version':'v0.5.8'}),patch('psycopg.connect') as connect:
            with self.assertRaises(ValueError):notice.announce('v0.5.7','test-database')
            connect.assert_not_called()
            notice.announce('v0.5.8','test-database')
            connect.return_value.__enter__.return_value.execute.assert_called_once_with("SELECT pg_notify('collector_update', %s)",('v0.5.8',))

    def test_incomplete_or_nonstable_releases_cannot_trigger_push(self):
        with patch.object(notice,'read_release',return_value=None),patch('psycopg.connect') as connect:
            for tag in ('v0.5.8','v0.5.9-beta','bad; command'):
                with self.assertRaises(ValueError):notice.announce(tag,'test-database')
            connect.assert_not_called()
