"""Cross-runtime fixtures for versioned item references and leases."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from mesh_item_ref import RANGES, valid_item_ref
from ledger_item_lock import LeaseError, validate


class ItemRefContract(unittest.TestCase):
    def test_shared_unicode_policy_and_codepoint_limits(self):
        fixtures = json.loads((ROOT / 'test/fixtures/item-ref-v1.json').read_text())
        for ref in fixtures['valid']:
            self.assertTrue(valid_item_ref(ref), repr(ref))
            validate(ref)
        for ref in fixtures['invalid']:
            self.assertFalse(valid_item_ref(ref), repr(ref))
            with self.assertRaises(LeaseError):
                validate(ref)
        self.assertTrue(valid_item_ref('x:' + '🧭' * 510))
        self.assertFalse(valid_item_ref('x:' + '🧭' * 511))
        self.assertTrue(valid_item_ref('x:é'))
        self.assertTrue(valid_item_ref('x:e\u0301'))
        self.assertNotEqual('x:é', 'x:e\u0301')
        ts = (ROOT.parent / 'gateway/src/mcp/item-ref.ts').read_text()
        encoded = ts.split('[] = ', 1)[1].split(';', 1)[0]
        self.assertEqual([list(pair) for pair in RANGES], json.loads(encoded))

    def test_lease_module_loads_by_file_without_bin_on_path(self):
        code = """import importlib.util, sys
spec = importlib.util.spec_from_file_location('isolated_lease', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.validate('work.test:item')
"""
        import subprocess
        subprocess.run([sys.executable, '-I', '-B', '-c', code, str(ROOT / 'bin/ledger_item_lock.py')], check=True)


if __name__ == '__main__':
    unittest.main()
