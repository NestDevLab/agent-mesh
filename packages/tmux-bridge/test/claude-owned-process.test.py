import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('owned', Path(__file__).resolve().parents[1] / 'bin/claude-owned-process.py')
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)
UUID = '12345678-1234-4234-8234-123456789abc'


class OwnedClaudeProcessTest(unittest.TestCase):
    def launch(self, *args):
        fixture = tempfile.NamedTemporaryFile(mode='w', suffix='.py')
        fixture.write('import time; time.sleep(30)\n')
        fixture.flush()
        self.addCleanup(fixture.close)
        process = subprocess.Popen([sys.executable, fixture.name, *args])
        def stop():
            if process.poll() is None:
                process.kill()
            process.wait()
        self.addCleanup(stop)
        return process

    def test_lease_checks_identity_and_detects_exit(self):
        process = self.launch('--session-id', UUID)
        with owned.OwnedClaudeProcess(process.pid, os.getpid(), 'claude:' + UUID, sys.executable) as lease:
            receipt = lease.verify()
            self.assertEqual(receipt['writerPid'], process.pid)
            self.assertEqual(receipt['panePid'], os.getpid())
            process.terminate()
            process.wait(timeout=3)
            with self.assertRaises((RuntimeError, ProcessLookupError, FileNotFoundError)):
                lease.verify()

    def test_rejects_wrong_id_duplicate_and_resume(self):
        for args in [('--session-id', UUID, '--session-id', UUID),
                     ('--session-id', UUID, '--resume', UUID),
                     ('--session-id', 'other')]:
            process = self.launch(*args)
            with self.assertRaises(RuntimeError):
                owned.OwnedClaudeProcess(process.pid, os.getpid(), 'claude:' + UUID, sys.executable)

    def test_rejects_wrong_executable_and_unrelated_pane(self):
        process = self.launch('--session-id=' + UUID)
        with self.assertRaises(RuntimeError):
            owned.OwnedClaudeProcess(process.pid, os.getpid(), 'claude:' + UUID, '/usr/bin/true')
        with self.assertRaises((RuntimeError, ProcessLookupError, FileNotFoundError)):
            owned.OwnedClaudeProcess(process.pid, process.pid + 10000000, 'claude:' + UUID, sys.executable)

if __name__ == '__main__':
    unittest.main()
