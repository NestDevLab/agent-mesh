import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

GATE = Path(__file__).resolve().parents[1] / 'bin' / 'namespace-exec-gate.py'


class NamespaceExecGateTest(unittest.TestCase):
    def launch(self, fifo, marker):
        code = 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("executed")'
        return subprocess.Popen([sys.executable, '-B', str(GATE), str(fifo), '--', sys.executable, '-c', code, str(marker)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def writer(self, fifo):
        for _ in range(200):
            try:
                return os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            except OSError as exc:
                if exc.errno != 6:
                    raise
                time.sleep(.01)
        self.fail('fixture reader unavailable')

    def test_eof_and_wrong_permit_never_execute(self):
        for permit in (b'', b'NO\n', b'GO\nX'):
            with self.subTest(permit=permit), tempfile.TemporaryDirectory() as root:
                fifo, marker = Path(root) / 'gate', Path(root) / 'ran'
                os.mkfifo(fifo, 0o600)
                process = self.launch(fifo, marker)
                fd = self.writer(fifo)
                if permit:
                    os.write(fd, permit)
                os.close(fd)
                self.assertEqual(process.wait(timeout=5), 125)
                self.assertFalse(marker.exists())

    def test_explicit_permit_executes_only_fixture(self):
        with tempfile.TemporaryDirectory() as root:
            fifo, marker = Path(root) / 'gate', Path(root) / 'ran'
            os.mkfifo(fifo, 0o600)
            process = self.launch(fifo, marker)
            fd = self.writer(fifo)
            os.write(fd, b'GO\n'); os.close(fd)
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertTrue(marker.exists())

    def test_regular_file_symlink_and_public_directory_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            real, link, marker = root / 'real', root / 'link', root / 'ran'
            real.write_text('GO\n')
            self.assertEqual(self.launch(real, marker).wait(timeout=5), 125)
            link.symlink_to(real)
            self.assertEqual(self.launch(link, marker).wait(timeout=5), 125)
            os.mkfifo(root / 'fifo', 0o600)
            os.chmod(root, 0o755)
            self.assertEqual(self.launch(root / 'fifo', marker).wait(timeout=5), 125)
            os.chmod(root, 0o700)
            self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
