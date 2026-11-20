import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

BASE = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('snapshot', BASE / 'sealed-plugin-snapshot.py')
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


def digest(path):
    module = (BASE / 'plugin-tree-observation.mjs').as_uri()
    program = f"import {{observePluginTree}} from '{module}'; console.log(JSON.stringify(await observePluginTree(process.argv[1])));"
    result = subprocess.run(['/usr/local/bin/node', '--input-type=module', '-e', program, str(path)],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)['sha256']


class SealedPluginSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'plugin'
        self.root.mkdir()
        (self.root / 'nested').mkdir()
        (self.root / 'nested' / 'é.py').write_text('original\n')
        (self.root / 'nested' / 'é.py').chmod(0o751)
        self.expected = digest(self.root)

    def test_snapshot_is_sealed_and_retains_original_contents_and_mode(self):
        fd = snapshot.sealed_plugin_snapshot(str(self.root), self.expected)
        self.addCleanup(os.close, fd)
        (self.root / 'nested' / 'é.py').write_text('changed\n')
        with self.assertRaises(PermissionError):
            os.write(fd, b'x')
        code = 'import os,sys\ntry: os.write(int(sys.argv[1]),b"x");sys.exit(1)\nexcept PermissionError: sys.exit(0)'
        self.assertEqual(subprocess.run(['/usr/bin/python3', '-c', code, str(fd)], pass_fds=(fd,)).returncode, 0)
        data = os.pread(fd, os.fstat(fd).st_size, 0)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(archive.read('nested/é.py'), b'original\n')
            self.assertEqual((archive.getinfo('nested/é.py').external_attr >> 16) & 0o777, 0o751)

    def test_changed_content_and_symlinks_fail_closed(self):
        (self.root / 'nested' / 'é.py').write_text('changed\n')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            snapshot.sealed_plugin_snapshot(str(self.root), self.expected)
        (self.root / 'linked').symlink_to(self.root / 'nested')
        with self.assertRaises((ValueError, OSError)):
            snapshot.sealed_plugin_snapshot(str(self.root), self.expected)


if __name__ == '__main__':
    unittest.main()
