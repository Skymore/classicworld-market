import unittest
from collector_recovery import failure_state
from packet_keybindings import PacketKeyBindingError

class RecoveryTests(unittest.TestCase):
    def test_transient_key_state_has_bounded_recovery(self):
        for reason in ('connection_unavailable','waiting_for_keymap','waiting_for_active_preset','movement_bindings_changed','keymap_edited_waiting_for_snapshot'):
            error=PacketKeyBindingError(reason)
            self.assertEqual(failure_state(error,1)[0],'rebuilding')
            self.assertEqual(failure_state(error,3)[0],'needs_attention')
    def test_unsupported_keys_do_not_recover_by_guessing(self):
        for reason in ('unsupported_keymap_layout','unsupported_preset_record','movement_keys_incomplete'):
            self.assertEqual(failure_state(PacketKeyBindingError(reason),0)[0],'needs_attention')
