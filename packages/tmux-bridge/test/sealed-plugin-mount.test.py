import fcntl
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
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, BASE / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
mount = load('mount', 'sealed-plugin-mount.py')
snapshot = load('snapshot', 'sealed-plugin-snapshot.py')


def seal(data):
    fd = os.memfd_create('test-zip', os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
    os.write(fd, data)
    fcntl.fcntl(fd, fcntl.F_ADD_SEALS, mount.SEALS)
    return fd


class SealedPluginMountTest(unittest.TestCase):
    def test_readonly_private_copy_survives_source_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'plugin'
            root.mkdir()
            (root / 'hooks').mkdir()
            (root / 'hooks' / 'run.sh').write_text('original\n')
            (root / 'hooks' / 'run.sh').chmod(0o751)
            module = (BASE / 'plugin-tree-observation.mjs').as_uri()
            js = f"import {{observePluginTree}} from '{module}';console.log(JSON.stringify(await observePluginTree(process.argv[1])))"
            result = subprocess.run(['/usr/local/bin/node', '--input-type=module', '-e', js, str(root)], capture_output=True, text=True, check=True)
            fd = snapshot.sealed_plugin_snapshot(str(root), json.loads(result.stdout)['sha256'])
            try:
                with mount.SealedPluginMount(fd, '/tmp/plugin') as lease:
                    (root / 'hooks' / 'run.sh').write_text('changed\n')
                    code = '''import json,os,pathlib\np=pathlib.Path('/tmp/plugin/hooks/run.sh')\nr={'contents':p.read_text(),'mode':oct(p.stat().st_mode & 0o777),'writeBlocked':False}\ntry:p.write_text('change')\nexcept OSError:r['writeBlocked']=True\nprint(json.dumps(r))\n'''
                    command = ['bwrap', '--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--tmpfs', '/tmp',
                               *lease.arguments, '--', '/usr/bin/python3', '-c', code]
                    result = subprocess.run(command, pass_fds=lease.pass_fds, capture_output=True, text=True, check=True, timeout=10)
                    self.assertEqual(json.loads(result.stdout), {'contents': 'original\n', 'mode': '0o751', 'writeBlocked': True})
            finally:
                os.close(fd)

    def test_unsealed_and_path_escape_are_rejected(self):
        bad = io.BytesIO()
        with zipfile.ZipFile(bad, 'w') as archive:
            info = zipfile.ZipInfo('../outside')
            info.external_attr = (0o100644 << 16)
            archive.writestr(info, 'bad')
        fd = seal(bad.getvalue())
        self.addCleanup(os.close, fd)
        with self.assertRaisesRegex(ValueError, 'path'):
            mount.SealedPluginMount(fd, '/tmp/plugin')
        unsealed = os.memfd_create('unsealed', os.MFD_ALLOW_SEALING)
        self.addCleanup(os.close, unsealed)
        with self.assertRaisesRegex(ValueError, 'not sealed'):
            mount.SealedPluginMount(unsealed, '/tmp/plugin')
        with self.assertRaisesRegex(ValueError, 'invalid plugin mount'):
            mount.SealedPluginMount(fd, '/tmp/../plugin')
        linked = io.BytesIO()
        with zipfile.ZipFile(linked, 'w') as archive:
            info = zipfile.ZipInfo('linked')
            info.external_attr = (0o120777 << 16)
            archive.writestr(info, 'target')
        linkfd = seal(linked.getvalue())
        self.addCleanup(os.close, linkfd)
        with self.assertRaisesRegex(ValueError, 'invalid plugin file'):
            mount.SealedPluginMount(linkfd, '/tmp/plugin')


if __name__ == '__main__':
    unittest.main()
