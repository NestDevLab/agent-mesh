import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

BIN = Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('isolated_namespace', BIN / 'isolated-pid-namespace.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def supported():
    if not hasattr(os, 'pidfd_open') or not Path('/usr/bin/bwrap').exists():
        return False
    result = subprocess.run(['/usr/bin/bwrap', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
                             '--unshare-pid', '--unshare-net', '--', '/usr/bin/true'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    return result.returncode == 0


@unittest.skipUnless(supported(), 'isolated PID namespaces or pidfd unavailable')
class IsolatedPidNamespaceTest(unittest.TestCase):
    def wait_for(self, path):
        for _ in range(200):
            if path.exists():
                return
            time.sleep(.01)
        self.fail('fixture did not start')

    def test_stop_before_release_does_not_execute_command(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'ran'
            code = 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("ran")'
            lease = module.IsolatedNamespace.prepare(directory, [sys.executable, '-c', code, str(marker)])
            self.assertFalse(marker.exists())
            receipt = lease.stop()
            self.assertEqual(receipt['status'], 'init-exited')
            self.assertEqual(receipt['descendants'], 'unverified')
            self.assertEqual(receipt['remoteEffects'], 'unverified')
            self.assertFalse(marker.exists())
            with self.assertRaises(RuntimeError):
                lease.release()

    def test_release_and_stop_own_namespace_with_escaped_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker, child_started, late = root / 'ran', root / 'child-started', root / 'late'
            escaped = root / 'escaped.py'
            escaped.write_text('import os,pathlib,signal,sys,time\nos.setsid()\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npathlib.Path(sys.argv[1]).write_text("started")\ntime.sleep(2)\npathlib.Path(sys.argv[2]).write_text("late")\n')
            payload = root / 'payload.py'
            payload.write_text('import pathlib,subprocess,sys,time\nsubprocess.Popen([sys.executable,sys.argv[1],sys.argv[3],sys.argv[4]])\npathlib.Path(sys.argv[2]).write_text("ran")\nwhile True: time.sleep(1)\n')
            lease = module.IsolatedNamespace.prepare(directory, [sys.executable, str(payload), str(escaped), str(marker), str(child_started), str(late)])
            try:
                self.assertFalse(marker.exists())
                lease.release()
                self.wait_for(marker)
                self.wait_for(child_started)
                with self.assertRaises(RuntimeError):
                    lease.release()
                self.assertEqual(lease.stop()['status'], 'init-exited')
                time.sleep(2.2)
                self.assertFalse(late.exists())
            finally:
                if not lease._stopped:
                    lease.stop()

    def test_supervisor_death_before_and_after_release(self):
        for phase in ('before', 'after'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                escaped, payload, supervisor = root / 'escaped.py', root / 'payload.py', root / 'supervisor.py'
                escaped.write_text('import os,pathlib,signal,sys,time\nos.setsid()\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npathlib.Path(sys.argv[1]).write_text("started")\ntime.sleep(2)\npathlib.Path(sys.argv[2]).write_text("late")\n')
                payload.write_text('import subprocess,sys,time\nsubprocess.Popen([sys.executable,sys.argv[1],sys.argv[2],sys.argv[3]])\nwhile True:time.sleep(1)\n')
                supervisor.write_text('import importlib.util,os,pathlib,sys,time\nspec=importlib.util.spec_from_file_location("owned",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nroot=pathlib.Path(sys.argv[2]);lease=m.IsolatedNamespace.prepare(str(root),[sys.executable,str(root/"payload.py"),str(root/"escaped.py"),str(root/"started"),str(root/"late")])\nif sys.argv[3]=="before":os._exit(0)\nlease.release()\nfor _ in range(500):\n if (root/"started").exists():os._exit(0)\n time.sleep(.01)\nos._exit(2)\n')
                result = subprocess.run([sys.executable, '-B', str(supervisor), str(BIN / 'isolated-pid-namespace.py'), directory, phase], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
                self.assertEqual(result.returncode, 0)
                time.sleep(2.4)
                self.assertEqual((root / 'started').exists(), phase == 'after')
                self.assertFalse((root / 'late').exists())
                listing = subprocess.run(['ps', '-eo', 'args'], capture_output=True, text=True, check=True).stdout
                self.assertNotIn(directory, listing)

    def test_unverified_identity_closes_gate_without_running_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'ran'
            code = 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("ran")'
            with patch.object(module, '_identity', return_value=(-1, -1, '0', ['1'], -1)):
                with self.assertRaisesRegex(RuntimeError, 'cleanup may be unverified'):
                    module.IsolatedNamespace.prepare(directory, [sys.executable, '-c', code, str(marker)])
            self.assertFalse(marker.exists())
            listing = subprocess.run(['ps', '-eo', 'args'], capture_output=True, text=True, check=True).stdout
            self.assertNotIn(directory, listing)

    def test_sealed_plugin_mount_is_ready_before_release_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plugin = root / 'source-plugin'
            plugin.mkdir()
            (plugin / 'fixture.txt').write_text('original')
            observer = (BIN / 'plugin-tree-observation.mjs').as_uri()
            script = f"import {{observePluginTree}} from '{observer}';console.log(JSON.stringify(await observePluginTree(process.argv[1])))"
            observed = subprocess.run(['/usr/local/bin/node', '--input-type=module', '-e', script, str(plugin)], capture_output=True, text=True, check=True)
            spec = importlib.util.spec_from_file_location('snapshot', BIN / 'sealed-plugin-snapshot.py')
            snapshot = importlib.util.module_from_spec(spec); spec.loader.exec_module(snapshot)
            fd = snapshot.sealed_plugin_snapshot(str(plugin), json.loads(observed.stdout)['sha256'])
            marker = root / 'result.json'
            destination = root / 'mounted-plugin'
            code = "import json,pathlib,sys,time\np=pathlib.Path(sys.argv[1]);r={'value':(p/'fixture.txt').read_text(),'blocked':False}\ntry:(p/'fixture.txt').write_text('changed')\nexcept OSError:r['blocked']=True\npathlib.Path(sys.argv[2]).write_text(json.dumps(r))\nwhile True:time.sleep(1)"
            try:
                lease = module.IsolatedNamespace.prepare(directory, [sys.executable, '-c', code, str(destination), str(marker)], plugin_archives=[(fd, str(destination))])
                try:
                    self.assertFalse(marker.exists())
                    (plugin / 'fixture.txt').write_text('host changed')
                    lease.release()
                    self.wait_for(marker)
                    self.assertEqual(json.loads(marker.read_text()), {'value': 'original', 'blocked': True})
                    self.assertEqual(lease.stop()['status'], 'init-exited')
                finally:
                    if not lease._stopped:
                        lease.stop()
            finally:
                os.close(fd)

    def test_plugin_mount_rejects_outside_or_nested_destinations(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                module.IsolatedNamespace.prepare(directory, ['/usr/bin/true'], plugin_archives=[(0, '/etc')])
            root = Path(directory)
            first = root / 'plugin'
            first.mkdir()
            with self.assertRaises(ValueError):
                module.IsolatedNamespace.prepare(directory, ['/usr/bin/true'], plugin_archives=[(0, str(first)), (0, str(first / 'nested'))])

    def test_invalid_workspace_or_command_does_not_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                module.IsolatedNamespace.prepare(directory, ['relative-command'])
            os.chmod(directory, 0o755)
            try:
                with self.assertRaises(ValueError):
                    module.IsolatedNamespace.prepare(directory, ['/usr/bin/true'])
            finally:
                os.chmod(directory, 0o700)


if __name__ == '__main__':
    unittest.main()
