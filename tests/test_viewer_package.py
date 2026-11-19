import json
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "panel"))
import role_package
import viewer_package


class ViewerPackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.model = "1" * 32 + ".bin3"
        self.moc = "2" * 32 + ".bin3"
        self.texture = "3" * 32 + ".bin3"
        self.motion = "4" * 32 + ".bin3"
        self.sound = "5" * 32 + ".bin3"
        self.config = {"fileId": "123456", "metaData": "test", "lpkFile": "123456.lpk", "title": "Workshop"}

    def make_lpk(self, path, mode="STD2_0", visual=None):
        model = {"Version": 3, "HitAreas": [{"Id": "Face", "Name": "Head", "Motion": "TapHead"}], "FileReferences": {
            "Moc": visual or self.moc, "Textures": [self.texture],
            "Motions": {"TapHead": [{"File": self.motion, "Sound": self.sound, "Text": "Hello"}],
                        "Ignored": [{"File": "script.cmd"}]},
        }}
        meta = {"type": mode, "id": "1234", "name": "Sample", "encrypt": "true",
                "list": [{"costume": [{"path": self.model}]}]}
        with ZipFile(path, "w") as archive:
            archive.writestr(viewer_package.META, json.dumps(meta))
            for name, data in ((self.model, json.dumps(model).encode()), (self.moc, b"MOC3example"),
                               (self.texture, b"\x89PNG\r\n\x1a\nexample"), (self.motion, b'{"Version": 3}'),
                               (self.sound, b"RIFF\0\0\0\0WAVE"), ("script.cmd", b"echo inert")):
                seed = "1234" + (self.config["fileId"] if mode == "STM_1_0" else "") + name
                if mode == "STM_1_0":
                    seed += self.config["metaData"]
                archive.writestr(name, viewer_package.decode_chunk(data, viewer_package.member_mask(seed)))

    def test_standalone_lpk_keeps_declared_interactions(self):
        lpk = self.root / "sample.lpk"
        self.make_lpk(lpk)
        entry, name = viewer_package.lpk_preview(lpk, self.root / "output")
        _, role, _, assets, _ = role_package.inspect_plain_model(entry)
        self.assertTrue(role["renderOnly"])
        self.assertEqual(name, "Sample")
        refs = json.loads(entry.read_bytes())["FileReferences"]
        self.assertEqual(assets, {refs["Moc"], *refs["Textures"]})
        self.assertEqual((entry.parent / refs["Moc"]).read_bytes(), b"MOC3example")
        graph = json.loads((entry.parent / "viewer.json").read_bytes())
        model = graph["models"][graph["initial"]]
        self.assertEqual(model["areas"][0]["Motion"], "TapHead")
        self.assertEqual(set(model["resources"]), {self.motion, self.sound})
        self.assertTrue(model["resources"][self.sound].endswith(".wav"))
        self.assertFalse((entry.parent / "script.cmd").exists())

    def test_wpk_pairs_nested_model_and_config(self):
        lpk = self.root / "123456.lpk"
        self.make_lpk(lpk, "STM_1_0")
        with self.assertRaisesRegex(ValueError, "config.json"):
            viewer_package.lpk_preview(lpk, self.root / "missing")
        wpk = self.root / "sample.wpk"
        with ZipFile(wpk, "w") as archive:
            archive.writestr("export/config.json", json.dumps(self.config))
            archive.write(lpk, "export/" + lpk.name)
        entry, name = viewer_package.wpk_preview(wpk, self.root / "output")
        self.assertEqual(name, "Workshop")
        self.assertFalse((entry.parent / "embedded.lpk").exists())
        texture, = json.loads(entry.read_bytes())["FileReferences"]["Textures"]
        self.assertEqual((entry.parent / texture).read_bytes(), b"\x89PNG\r\n\x1a\nexample")

    def test_model_references_cannot_escape_the_archive(self):
        lpk = self.root / "traversal.lpk"
        self.make_lpk(lpk, visual="../outside.moc3")
        with self.assertRaisesRegex(ValueError, "无效的文件路径"):
            viewer_package.lpk_preview(lpk, self.root / "output")


if __name__ == "__main__":
    unittest.main()
