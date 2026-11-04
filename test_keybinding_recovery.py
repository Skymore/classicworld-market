import unittest

class VirtualKeyboardRecoveryTests(unittest.TestCase):
    def test_wrapped_relay_failure_has_bounded_recovery(self):
        from vmware_keyboard_bridge import BridgeTransportError
        from collector_recovery import failure_state
        error=RuntimeError('route failed');error.__cause__=BridgeTransportError('ack timeout')
        self.assertEqual(failure_state(error,1)[0],'rebuilding')
        self.assertEqual(failure_state(error,3)[0],'needs_attention')
from collector_recovery import failure_state
from packet_keybindings import PacketKeyBindingError

class RecoveryTests(unittest.TestCase):
    def test_route_wrappers_preserve_recovery_budget_and_cause(self):
        from free_market_route import RouteError, PositionSyncError
        from collector_recovery import recovery_error, bounded_recovery_failure
        for cause in (PositionSyncError('TCP gap timeout'),PacketKeyBindingError('connection_unavailable')):
            error=RouteError('enter room failed after 3 retries');error.__cause__=cause
            outer=RuntimeError('scan attempt failed');outer.__cause__=error
            self.assertIs(recovery_error(outer),cause)
            self.assertTrue(bounded_recovery_failure(outer))
            self.assertEqual(failure_state(outer,1)[0],'rebuilding')
            self.assertEqual(failure_state(outer,3)[0],'needs_attention')

    def test_typed_stop_and_unrelated_context_are_not_unwrapped(self):
        from inventory_check import InventoryCheckError
        from free_market_route import PositionSyncError
        from collector_recovery import recovery_error, bounded_recovery_failure
        error=InventoryCheckError('purchase verification failed');error.__cause__=PositionSyncError('stale')
        self.assertIs(recovery_error(error),error)
        self.assertFalse(bounded_recovery_failure(error))
        error=RuntimeError('ordinary route failure');error.__context__=PositionSyncError('previous failure')
        self.assertIs(recovery_error(error),error)
        self.assertFalse(bounded_recovery_failure(error))

    def test_transient_key_state_has_bounded_recovery(self):
        for reason in ('connection_unavailable','waiting_for_keymap','waiting_for_active_preset','movement_bindings_changed','keymap_edited_waiting_for_snapshot'):
            error=PacketKeyBindingError(reason)
            self.assertEqual(failure_state(error,1)[0],'rebuilding')
            self.assertEqual(failure_state(error,3)[0],'needs_attention')
    def test_unsupported_keys_do_not_recover_by_guessing(self):
        for reason in ('unsupported_keymap_layout','unsupported_preset_record','movement_keys_incomplete'):
            self.assertEqual(failure_state(PacketKeyBindingError(reason),0)[0],'needs_attention')
