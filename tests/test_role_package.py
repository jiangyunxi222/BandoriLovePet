import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "panel"))
import role_package


class RolePackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name).resolve()
        self.root = self.folder / "role"
        self.root.mkdir()
        self.parent = self.root / "00_integrated.model3.json"
        self.child = self.root / "001_costume.model3.json"
        self.asset = self.root / "assets" / "example.moc3"
        self.asset.parent.mkdir()
        self.asset.write_bytes(b"model asset")
        self.parent.write_text("{}")
        self.child.write_text("{}")
        index = self.root / "ControlPanel" / "data"
        index.mkdir(parents=True)
        role = {"id": "example", "entry": self.parent.name}
        (index.parent / "library.json").write_text(json.dumps([role]))
        catalog = {**role, "directory": ".", "costumes": [{"file": self.child.name}]}
        (index / "example.json").write_text(json.dumps(catalog))
        hashes = {p.relative_to(self.root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.root.rglob("*") if p.is_file()}
        (self.root / "manifest.json").write_text(json.dumps({"files_sha256": hashes}))

    def test_zip_and_folder_read_the_same_role(self):
        root, role, catalog, assets = role_package.inspect_folder(self.parent)
        self.assertEqual(root, self.root)
        self.assertEqual(assets, {"assets/example.moc3"})
        archive = self.folder / "role.zip"
        with zipfile.ZipFile(archive, "w") as package:
            for file in self.root.rglob("*"):
                if file.is_file():
                    package.write(file, file.relative_to(self.folder).as_posix())
        self.assertEqual(role_package.extract(archive, self.folder / "copy"), (role, catalog))

    def test_outfit_json_is_not_an_entry(self):
        with self.assertRaisesRegex(ValueError, self.parent.name):
            role_package.inspect_folder(self.child)

    def test_modified_asset_fails_validation(self):
        self.asset.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "assets/example.moc3"):
            role_package.inspect_folder(self.parent)

    def test_plain_models_only_expose_referenced_render_assets(self):
        root = self.folder / "plain"
        (root / "parts").mkdir(parents=True)
        (root / "parts/脸部.png").write_bytes(b"texture")
        for moc, settings in (
            ("role.moc3", {"FileReferences": {"Moc": "role.moc3", "Textures": ["parts/脸部.png"]}}),
            ("role.moc", {"model": "role.moc", "textures": [r".\parts\脸部.png"]}),
        ):
            with self.subTest(moc=moc):
                (root / moc).write_bytes(b"model")
                entry = root / "model.json"
                entry.write_text(json.dumps({**settings, "commands": ["external"]}))
                _, role, catalog, files, preview = role_package.inspect_plain_model(entry)
                self.assertTrue(role["renderOnly"])
                self.assertFalse(role_package.is_indexed_folder(root))
                self.assertEqual(files, {moc, "parts/脸部.png"})
                self.assertEqual(catalog["costumes"][0]["actions"], [])
                self.assertEqual(catalog["voices"], [])
                self.assertNotIn("commands", preview)

    def test_plain_model_reference_must_stay_in_its_folder(self):
        entry = self.root / "plain.model3.json"
        entry.write_text(json.dumps({"FileReferences": {
            "Moc": "../other.moc3", "Textures": ["missing.png"],
        }}))
        with self.assertRaisesRegex(ValueError, "无效的文件路径"):
            role_package.inspect_plain_model(entry)


if __name__ == "__main__":
    unittest.main()
