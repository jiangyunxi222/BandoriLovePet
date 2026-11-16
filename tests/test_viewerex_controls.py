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
        costume = {"id": 1, "name": "Test costume", "flag": "heart_fav_costume", "actions": [action], "expressions": []}
        self.owner.catalogs = {"test-role": {
            "id": "test-role", "directory": ".", "entry": self.entry, "costumes": [costume], "voices": [],
        }}
        self.sent = []
        self.variables = {"selected_costume": 1, "costume_loading": 0, "page_load_count": 1,
                          "page_backend_connected": 0}

        def native_data(path):
            if path.name == "autosave.dat":
                return {"charDatas": [{}, {"jsonFilePath": str(self.loaded_entry)}]}
            return {"varFloats": self.variables.copy()}

        for patcher in (patch.object(server, "native_data", side_effect=native_data),
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

    def test_command_connection_leaves_the_builtin_menu_active(self):
        self.owner.connect_imported_viewer()
        self.owner.viewer_session.sync_loop_flags()
        self.owner.disconnect_viewer()
        self.assertFalse(any("page_backend_connected" in motion for motion in self.motion_names()))

    def test_stale_menu_claim_is_cleared_once_per_loaded_model(self):
        self.variables["page_backend_connected"] = 1
        self.owner.connect_imported_viewer()
        viewer = self.owner.viewer_session
        reset = "web_set_page_backend_connected_0"
        self.assertEqual(self.motion_names().count(reset), 1)
        viewer.keep_native_menu(self.variables)
        self.assertEqual(self.motion_names().count(reset), 1)
        self.variables.update(page_load_count=2, costume_loading=1)
        viewer.keep_native_menu(self.variables)
        self.assertEqual(self.motion_names().count(reset), 1)
        self.variables["costume_loading"] = 0
        viewer.keep_native_menu(self.variables)
        self.assertEqual(self.motion_names().count(reset), 2)
        self.assertNotIn("web_set_page_backend_connected_1", self.motion_names())

    def test_connection_preserves_the_roles_running_menu_controller(self):
        self.variables["page_backend_connected"] = 1
        with patch.object(server, "live_panel", return_value=(25001, {"linked": True, "slot": 1, "menu": {"visible": False}})):
            self.owner.connect_imported_viewer()
            with patch.object(server.desktop_pet, "request") as bridge:
                self.owner.viewer_session.route_viewer_menu({"page_menu_request": 1})
            bridge.assert_not_called()
            self.owner.disconnect_viewer()
        self.assertFalse(any("page_backend_connected" in motion for motion in self.motion_names()))

    def test_clicks_route_to_the_desktop_menu_when_no_role_controller_is_listening(self):
        self.variables["page_menu_request"] = 3
        self.owner.connect_imported_viewer()
        viewer = self.owner.viewer_session
        with patch.object(server, "live_panel", return_value=(25001, {"linked": True, "slot": 2, "menu": {}})), \
             patch.object(server.desktop_pet, "request") as bridge:
            for count in (3, 4, 4, 0, 1):
                viewer.route_viewer_menu({"page_menu_request": count})
            self.assertEqual(bridge.call_count, 2)
            for call in bridge.call_args_list:
                self.assertEqual(call.args, ("viewer-menu",))
                self.assertEqual(call.kwargs, {"port": server.PORT})


if __name__ == "__main__":
    unittest.main()
