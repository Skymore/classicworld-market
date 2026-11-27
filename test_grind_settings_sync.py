import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError

from grind_desktop import GrindService
from grind_settings_sync import SettingsSync, flat


class Account:
    """The site's /api/v1/collector/grind-settings for one linked account."""
    def __init__(self, value=None):
        self.value, self.version, self.writes = value, 1 if value is not None else 0, 0

    def post(self, route, payload):
        if 'value' in payload:
            if payload['version'] != self.version:
                raise HTTPError(route, 409, 'sync_conflict', {}, None)
            self.value, self.version, self.writes = payload['value'], self.version + 1, self.writes + 1
        return dict(linked=True, value=self.value, version=self.version)


def client(folder, account, saved=None):
    service = GrindService(folder)
    if saved is not None:
        (service.data).mkdir(parents=True, exist_ok=True)
        (service.data / 'settings.json').write_text(json.dumps(saved), encoding='utf-8')
    service.shared = SettingsSync(service, post=account.post)
    return service


class SettingsSyncTest(unittest.TestCase):
    def test_first_meeting_takes_the_account_and_fills_what_it_lacks(self):
        with tempfile.TemporaryDirectory() as folder:
            account = Account(dict(performance=dict(enabled=True, exp_per_10k=0.8)))
            pc = client(folder, account, dict(performance=dict(exp_per_10k=0.5, income_per_10k=0.7), notable_value=900000,
                                              overlay=dict(x=12, y=34, layout='big')))
            pc.shared.step()
            settings = pc.settings()
            self.assertEqual(settings['performance']['exp_per_10k'], 0.8)        # the account's
            self.assertTrue(settings['performance']['enabled'])
            self.assertEqual(account.value['performance']['income_per_10k'], 0.7)  # filled from this PC
            self.assertEqual(account.value['notable_value'], 900000)
            self.assertEqual(account.value['overlay']['layout'], 'big')
            self.assertNotIn('x', account.value['overlay'])                         # position stays here
            self.assertNotIn('hotkeys', account.value)
            self.assertEqual(settings['overlay']['x'], 12)

    def test_changes_go_both_ways(self):
        with tempfile.TemporaryDirectory() as folder:
            account = Account()
            pc = client(folder, account)
            pc.shared.step()
            pc.save_settings(dict(performance=dict(enabled=True)))
            pc.shared.step()
            self.assertTrue(account.value['performance']['enabled'])
            # The site turns it off and changes a rate.
            account.value = json.loads(json.dumps(account.value))
            account.value['performance'].update(enabled=False, cost_per_10k=2)
            account.version += 1
            pc.shared.step()
            self.assertFalse(pc.settings()['performance']['enabled'])
            self.assertEqual(pc.settings()['performance']['cost_per_10k'], 2)
            writes = account.writes
            pc.shared.step()
            self.assertEqual(account.writes, writes, 'nothing to send when both agree')

    def test_three_way_merge_and_conflict(self):
        with tempfile.TemporaryDirectory() as folder:
            account = Account()
            pc = client(folder, account)
            pc.shared.step()
            # Here: the threshold; on the site meanwhile: the theme. Both survive.
            pc.save_settings(dict(notable_value=123456))
            account.value = {**account.value, 'overlay': {**account.value['overlay'], 'theme': 'cute'}}
            account.version += 1
            pc.shared.step()
            self.assertEqual(pc.settings()['overlay']['theme'], 'cute')
            self.assertEqual(account.value['notable_value'], 123456)
            # Both change the same one: the account's wins.
            pc.save_settings(dict(buff_warn_seconds=9))
            account.value = {**account.value, 'buff_warn_seconds': 5}
            account.version += 1
            pc.shared.step()
            self.assertEqual(pc.settings()['buff_warn_seconds'], 5)
            self.assertEqual(account.value['buff_warn_seconds'], 5)

    def test_bad_values_and_unknown_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            account = Account(dict(price_basis='free', notable_value='lots', overlay=dict(layout='round', opacity=0.5),
                                   future=dict(a=1)))
            pc = client(folder, account)
            pc.shared.step()
            settings = pc.settings()
            self.assertEqual(settings['price_basis'], 'typical')
            self.assertEqual(settings['overlay']['opacity'], 0.5)
            self.assertEqual(settings['overlay']['layout'], 'slim')
            self.assertEqual(account.value['future'], dict(a=1), 'a newer client\'s keys are kept')
            self.assertEqual(account.value['price_basis'], 'typical')

    def test_unlinked_and_position_only_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            pc = client(folder, Account())
            pc.shared.post = lambda route, payload: dict(linked=False)
            self.assertFalse(pc.shared.step())
            self.assertFalse(Path(folder, 'grind', 'settings-sync.json').exists())
            pc.shared.wake.clear()
            pc.save_settings(dict(overlay=dict(x=5, y=6)))
            self.assertFalse(pc.shared.wake.is_set(), 'moving the overlay sends nothing')
            pc.save_settings(dict(hp_warn=False))
            self.assertTrue(pc.shared.wake.is_set())

    def test_flat_paths(self):
        self.assertEqual(flat(dict(overlay=dict(fields=['time'], x=1), hotkeys=dict(end='F9'), hp_warn=True)),
                         {'overlay.fields': ['time'], 'hp_warn': True})


if __name__ == '__main__':
    unittest.main()
