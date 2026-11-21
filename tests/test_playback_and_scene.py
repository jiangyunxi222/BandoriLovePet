from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "panel"))
from desktop_library import portable_layers
from server import Studio


class PlaybackTests(unittest.TestCase):
    def setUp(self):
        timers = patch("server.threading.Timer")
        timers.start()
        self.addCleanup(timers.stop)
        profile = tempfile.TemporaryDirectory()
        self.addCleanup(profile.cleanup)
        outfits = [
            {
                "id": ident, "flag": f"outfit-{ident}", "name": f"Outfit {ident}",
                "actions": [{"id": ident * 10, "flag": f"motion-{ident}", "name": "Motion", "duration": 2}],
                "expressions": [{"id": ident * 10, "flag": f"face-{ident}", "name": "Face"}],
            }
            for ident in (1, 2)
        ]
        voices = [
            {"id": ident * 10, "flag": f"voice-{ident}", "name": "Voice", "duration": 1, "costumeIds": [ident]}
            for ident in (1, 2)
        ]
        self.studio = Studio()
        self.studio.saved = {"roles": {}}
        self.studio.state_path = Path(profile.name) / "state.json"
        self.studio.activate_role(Path(profile.name), {"id": "role"}, {
            "id": "role", "costumes": outfits, "voices": voices,
        })

    def make_due(self, *tracks):
        for track in tracks:
            self.studio.repeat_at[track] = (time.monotonic() - 1, self.studio.jobs[track])

    def test_due_tracks_use_the_new_outfit_even_if_action_timer_fires_first(self):
        studio = self.studio
        with studio.lock:
            for track in ("action", "expression", "voice", "costume"):
                studio.operate(track, loop=True, randomize=True)
            studio.events.clear()
            self.make_due("action", "expression", "voice", "costume")
            studio.repeat("action", studio.jobs["action"])
            events = [event for event in studio.events if event["type"] in ("selection", "play")]
            self.assertEqual([event["type"] for event in events], ["selection", "play", "play", "play"])
            self.assertEqual(events[0]["state"]["settings"]["costume"], 2)
            self.assertEqual([(event["data"]["kind"], event["data"]["item"]["id"]) for event in events[1:]],
                             [("voice", 20), ("expression", 20), ("action", 20)])
            self.assertTrue(all(studio.looping.values()))

    def test_action_loop_plays_the_configured_performances_in_order(self):
        studio = self.studio
        with studio.lock:
            studio.settings()["performanceEnabled"] = True
            studio.settings()["performanceGroups"]["outfit-1"] = [
                {"id": "face", "name": "First", "tracks": {"expression": "face-1"}},
                {"id": "motion", "name": "Second", "tracks": {"action": "motion-1"}},
            ]
            studio.operate("action", loop=True, randomize=True)
            self.make_due("action")
            studio.repeat("action", studio.jobs["action"])
            shows = [event["data"]["tracks"] for event in studio.events if event["type"] == "performance"]
            self.assertEqual([list(tracks) for tracks in shows], [["expression"], ["action"]])
            self.assertTrue(studio.looping["action"])


class SceneTests(unittest.TestCase):
    def test_old_scenes_default_to_upright_and_preserve_saved_rotation(self):
        common = {"opacity": 1, "visible": True, "scale": 1, "x": 0, "y": 0}
        scene = [
            {"id": "background", "kind": "background", **common},
            {"id": "character", "kind": "character", **common},
            {"id": "photo", "kind": "image", "media": "photo", "rotation": -49, **common},
        ]
        self.assertEqual([layer["rotation"] for layer in portable_layers(scene)], [0, 0, -49])


if __name__ == "__main__":
    unittest.main()
