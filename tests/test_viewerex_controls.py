import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "panel"))
import server


class ViewerControlsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent, prefix=".viewerex-test-")
        self.addCleanup(self.temp.cleanup)
        folder = Path(self.temp.name)
        for patcher in (patch.object(server, "HERE", folder / "panel"),
                        patch.object(server, "NATIVE", folder / "native"),
                        patch.object(server.threading.Thread, "start")):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.local = folder / "imported"
        self.loaded = folder / "viewer-loaded"
        self.local.mkdir()
        self.loaded.mkdir()
        self.entry = "00_integrated.model3.json"
        (self.local / self.entry).write_text('{"Options":{"Id":"ournotes_test"}}')
        self.loaded_entry = self.loaded / self.entry
        self.loaded_entry.write_bytes((self.local / self.entry).read_bytes())
        self.owner = server.Studio(standalone=True)
        self.owner.current = "test-role"
        self.owner.roles = {"test-role": {"directory": ".", "id": "test-role"}}
        self.owner.roots = {"test-role": self.local}
        action = {"id": 1, "name": "Test", "flag": "heart_fav_test", "duration": 0.1}
        voice = {"id": 0, "name": "Test voice", "flag": "heart_fav_voice", "duration": 0.1}
        costume = {"id": 1, "name": "Test costume", "flag": "heart_fav_costume", "actions": [action], "expressions": []}
        self.owner.catalogs = {"test-role": {
            "id": "test-role", "directory": ".", "entry": self.entry, "modelId": "ournotes_test",
            "costumes": [costume], "voices": [voice],
        }}
        self.sent = []
        self.variables = {"selected_costume": 1, "costume_loading": 0, "page_load_count": 1,
                          "page_backend_connected": 0}

        def native_data(path):
            if path.name == "autosave.dat":
                return {"charDatas": [{}, {"jsonFilePath": str(self.loaded_entry)}]}
            return {"varFloats": self.variables.copy()}

        for patcher in (patch.object(server, "native_data", side_effect=native_data),
                        patch.object(server, "claim_role_controller", return_value=(42, False)),
                        patch.object(server, "release_instance"),
                        patch.object(server, "restore_role_menu"),
                        patch.object(server.Player, "connect", lambda player: setattr(player, "socket", object())),
                        patch.object(server.Player, "close", lambda player: setattr(player, "socket", None)),
                        patch.object(server.Player, "send", lambda player, message, data: self.sent.append((message, data)))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_viewer_link_and_pet_visibility_are_independent(self):
        with patch.object(server.desktop_pet, "request", return_value={"connected": True}) as bridge:
            self.owner.connect_pet()
            view = self.owner.connect_imported_viewer()
        bridge.assert_called_once_with("attach", port=server.PORT, role="test-role")
        self.assertTrue(view["petLinked"] and view["viewerLinked"])
        self.assertEqual(view["slot"], 1)
        self.assertEqual(self.owner.snapshot()["desktopProvider"], "pet")

        self.sent.clear()
        viewer = self.owner.viewer_session
        viewer.operate("action", item_id=1)
        self.assertEqual(self.sent[0], (13200, {"id": 1, "type": 0, "mtn": "web_action_001_001"}))
        self.assertFalse(self.owner.playing)

        self.sent.clear()
        self.owner.operate("action", item_id=1)
        self.assertEqual(self.sent, [])
        # Showing or hiding the standalone window should not change the native socket.
        with patch.object(server.desktop_pet, "request") as bridge:
            self.owner.disconnect_pet()
        bridge.assert_called_once_with("detach", port=server.PORT)
        self.assertTrue(viewer.snapshot()["viewerLinked"])
        self.assertFalse(viewer.snapshot()["petLinked"])

        with patch.object(server.desktop_pet, "request", return_value={"connected": True}):
            self.owner.connect_pet()
        self.owner.disconnect_viewer()
        self.assertIsNone(viewer.player.socket)
        self.assertTrue(self.owner.snapshot()["petLinked"])

    def test_same_filename_from_another_role_is_not_attached(self):
        self.loaded_entry.write_text(json.dumps({"Options": {"Id": "wrong-role"}}))
        with self.assertRaisesRegex(ValueError, "同一角色包"):
            self.owner.connect_imported_viewer()
        self.assertEqual(self.sent, [])
        self.assertIsNone(self.owner.viewer_session)

    def motion_names(self):
        return [data["mtn"] for message, data in self.sent if message == 13200]

    def test_command_connection_claims_the_menu(self):
        self.owner.connect_imported_viewer()
        server.claim_role_controller.assert_called_once_with(str(self.loaded_entry))
        self.assertIn("web_set_page_backend_connected_1", self.motion_names())

    def test_menu_claim_is_reapplied_once_per_loaded_model(self):
        self.owner.connect_imported_viewer()
        viewer = self.owner.viewer_session
        claim = "web_set_page_backend_connected_1"
        self.assertEqual(self.motion_names().count(claim), 1)
        viewer.refresh_viewer_menu(self.variables)
        self.assertEqual(self.motion_names().count(claim), 1)
        self.variables.update(page_load_count=2, costume_loading=1)
        viewer.refresh_viewer_menu(self.variables)
        self.assertEqual(self.motion_names().count(claim), 1)
        self.variables["costume_loading"] = 0
        viewer.refresh_viewer_menu(self.variables)
        self.assertEqual(self.motion_names().count(claim), 2)

    def test_an_existing_controller_that_cannot_yield_blocks_connection(self):
        server.claim_role_controller.side_effect = ConnectionError("角色包控制台仍在运行")
        with patch.object(server.Player, "connect") as connect:
            with self.assertRaisesRegex(ConnectionError, "仍在运行"):
                self.owner.connect_imported_viewer()
        connect.assert_not_called()
        self.assertFalse(self.owner.snapshot()["viewerLinked"])

    def test_failed_takeover_releases_the_claim_and_restores_the_displaced_controller(self):
        server.claim_role_controller.return_value = (42, True)
        with patch.object(server.Player, "connect", side_effect=OSError):
            with self.assertRaises(ConnectionError):
                self.owner.connect_imported_viewer()
        server.release_instance.assert_called_once_with(42)
        server.restore_role_menu.assert_called_once()
        self.assertFalse(self.owner.snapshot()["viewerLinked"])

    def test_clicks_route_to_the_desktop_menu(self):
        self.variables["page_menu_request"] = 3
        self.owner.connect_imported_viewer()
        viewer = self.owner.viewer_session
        with patch.object(server.desktop_pet, "request") as bridge:
            for count in (3, 4, 4, 0, 1):
                viewer.route_viewer_menu({"page_menu_request": count})
            self.assertEqual(bridge.call_count, 2)
            for call in bridge.call_args_list:
                self.assertEqual(call.args, ("viewer-menu",))
                self.assertEqual(call.kwargs, {"port": server.PORT})

    def test_viewer_voice_tap_tracks_the_line_sent_to_the_loaded_model(self):
        self.owner.connect_imported_viewer()
        viewer = self.owner.viewer_session
        self.sent.clear()
        viewer.on_native_tap({"id": 0, "modelId": "ournotes_test_costume_001", "hitArea": "语音"})
        self.assertEqual(self.sent, [])
        viewer.on_native_tap({"id": 1, "modelId": "ournotes_test_costume_001", "hitArea": "语音"})
        self.assertIn((13200, {"id": 1, "type": 0, "mtn": "web_voice_000"}), self.sent)
        self.assertEqual(viewer.playing["voice"]["id"], 0)
        self.assertEqual(viewer.events[-1]["data"]["item"]["id"], 0)
        self.assertEqual(self.owner.playing, {})

    def test_manual_disconnect_restores_the_panel_for_the_model_loaded_in_viewer(self):
        self.owner.connect_imported_viewer()
        viewer = self.owner.viewer_session

        def restore(model, native):
            self.assertFalse(viewer.linked)
            self.assertIsNone(viewer.player.socket)
            self.assertIsNone(viewer.viewer_claim)
            server.release_instance.assert_called_once_with(42)
            self.assertEqual(Path(model), self.loaded_entry)
            self.assertEqual(native, server.NATIVE)

        with patch.object(server, "restore_role_menu", side_effect=restore) as handoff, \
             patch.object(server.desktop_pet, "request") as bridge:
            self.owner.disconnect_viewer(restore_menu=True)
            handoff.assert_called_once()
            bridge.assert_called_once_with("viewer-menu-close", port=server.PORT)
            self.assertFalse(self.owner.snapshot()["viewerLinked"])

    def test_disconnect_does_not_start_a_controller_for_a_model_no_longer_loaded(self):
        self.owner.connect_imported_viewer()
        with patch.object(self.owner.viewer_session, "slot_path", return_value=""):
            self.owner.disconnect_viewer()
        server.restore_role_menu.assert_not_called()


if __name__ == "__main__":
    unittest.main()
