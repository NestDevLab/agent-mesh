import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'bin' / 'sealed-restart.py'
spec = importlib.util.spec_from_file_location('sealed_restart', MODULE)
sealed_restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sealed_restart)


@unittest.skipUnless(hasattr(os, 'memfd_create') and hasattr(fcntl, 'F_ADD_SEALS'), 'sealed memory unavailable')
class SealedRestartTest(unittest.TestCase):
    def test_snapshot_survives_source_replacement_and_refuses_child_writes(self):
        with tempfile.TemporaryDirectory(prefix='sealed-restart-') as root:
            path = Path(root) / 'state.yaml'
            body = b'fixture restart state\n'
            path.write_bytes(body)
            path.chmod(0o600)
            digest = hashlib.sha256(body).hexdigest()
            fd = sealed_restart.sealed_restart_snapshot(root, 'state.yaml', digest)
            try:
                replacement = Path(root) / 'replacement'
                replacement.write_bytes(b'changed\n')
                replacement.replace(path)
                self.assertEqual(os.pread(fd, len(body), 0), body)
                with self.assertRaises(PermissionError):
                    os.write(fd, b'changed')
                script = "import os,sys,hashlib; fd=int(sys.argv[1]); print(hashlib.sha256(os.read(fd,1024)).hexdigest());\ntry: os.write(fd,b'x'); sys.exit(2)\nexcept PermissionError: pass"
                result = subprocess.run([sys.executable, '-c', script, str(fd)], pass_fds=(fd,), text=True, capture_output=True, check=True)
                self.assertEqual(result.stdout.strip(), digest)
            finally:
                os.close(fd)

    def test_rejects_wrong_digest_unsafe_mode_and_symlink(self):
        with tempfile.TemporaryDirectory(prefix='sealed-restart-') as root:
            path = Path(root) / 'state.yaml'
            body = b'fixture\n'
            path.write_bytes(body)
            path.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                sealed_restart.sealed_restart_snapshot(root, 'state.yaml', 'a' * 64)
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'invalid restart file'):
                sealed_restart.sealed_restart_snapshot(root, 'state.yaml', hashlib.sha256(body).hexdigest())
            path.chmod(0o600)
            (Path(root) / 'link.yaml').symlink_to(path)
            with self.assertRaises(OSError):
                sealed_restart.sealed_restart_snapshot(root, 'link.yaml', hashlib.sha256(body).hexdigest())


if __name__ == '__main__':
    unittest.main()
