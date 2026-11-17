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

    def test_existing_parser_and_role_validation_use_sealed_bytes(self):
        with tempfile.TemporaryDirectory(prefix='sealed-restart-') as root:
            path = Path(root) / 'state.yaml'
            session = 'codex:22222222-2222-4222-8222-222222222222'
            body = (f'schema: agent-mesh.restart.v1\nsession: {session}\nchannel: fixture\nharness: codex\nworking_directory: /workspace\nskills: []\ntriggers: []\ngoal: null\nrole_profile:\n  schema: agent-mesh.role-profile.v1\n  role: operator\n  permissions: []\n  mcp: [online, offline]\n  plugins: []\n').encode()
            path.write_bytes(body)
            path.chmod(0o600)
            digest = hashlib.sha256(body).hexdigest()
            fd = sealed_restart.sealed_restart_snapshot(root, 'state.yaml', digest)
            validator = (MODULE.parent / 'sealed-restart-validate.mjs').as_uri()
            script = f"import {{ validateSealedRestart }} from '{validator}'; const r=validateSealedRestart({{fd:Number(process.argv[1]),session:process.argv[2],channel:'fixture',expectedSha256:process.argv[3]}}); console.log(JSON.stringify({{role:r.roleProfile.role,state:r.stateSha256}}));"
            try:
                path.write_bytes(body.replace(b'operator', b'changed'))
                result = subprocess.run(['node', '--input-type=module', '-e', script, str(fd), session, digest], pass_fds=(fd,), text=True, capture_output=True, check=True)
                import json
                self.assertEqual(json.loads(result.stdout), {'role': 'operator', 'state': digest})
                preflight = (MODULE.parent / 'bound-role-preflight.mjs').as_uri()
                restart = (MODULE.parent / 'restart-state.mjs').as_uri()
                plan_script = f"import {{ prepareSealedRoleLaunch }} from '{preflight}'; import {{ roleProfileDigest }} from '{restart}'; const profile={{schema:'agent-mesh.role-profile.v1',role:'operator',permissions:[],mcp:['online','offline'],plugins:[]}}; const r=await prepareSealedRoleLaunch({{fd:Number(process.argv[1]),session:process.argv[2],channel:'fixture',expectedStateSha256:process.argv[3],expectedProfileSha256:roleProfileDigest(profile),authority:{{role:'operator',permissions:[],humanGatedPermissions:[],mcp:['online','offline'],plugins:[]}},probe:async name=>name==='online'}}); console.log(JSON.stringify({{checked:r.mcpChecked,available:r.plan.mcpToStart.length,unavailable:r.plan.mcpUnavailable.length}}));"
                planned = subprocess.run(['node', '--input-type=module', '-e', plan_script, str(fd), session, digest], pass_fds=(fd,), text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(planned.stdout), {'checked': 2, 'available': 1, 'unavailable': 1})
                claude_preflight = (MODULE.parent / 'claude-role-mcp-preflight.mjs').as_uri()
                claude_script = f"""import {{ prepareSealedClaudeRoleMcp }} from '{claude_preflight}'; import {{ roleProfileDigest }} from '{restart}';
const profile={{schema:'agent-mesh.role-profile.v1',role:'operator',permissions:[],mcp:['online','offline'],plugins:[]}};
const code=\"let b='';process.stdin.on('data',d=>{{b+=d;let i;while((i=b.indexOf('\\\\n'))>=0){{const x=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(x.method==='initialize')console.log(JSON.stringify({{jsonrpc:'2.0',id:1,result:{{protocolVersion:'2024-11-05',capabilities:{{}},serverInfo:{{name:'fixture',version:'1'}}}}}}));if(x.method==='ping')console.log(JSON.stringify({{jsonrpc:'2.0',id:2,result:{{}}}}));}}}});\";
const opts={{fd:Number(process.argv[1]),session:process.argv[2],channel:'fixture',expectedStateSha256:process.argv[3],expectedProfileSha256:roleProfileDigest(profile),authority:{{role:'operator',permissions:[],humanGatedPermissions:[],mcp:['online','offline'],plugins:[]}},inventory:{{online:{{command:process.execPath,args:['-e',code]}},offline:{{command:'/bin/false'}}}}}};
const r=await prepareSealedClaudeRoleMcp(opts);let rejected=false;try{{await prepareSealedClaudeRoleMcp({{...opts,expectedProfileSha256:'a'.repeat(64)}})}}catch{{rejected=true}}
console.log(JSON.stringify({{available:r.plan.mcpToStart,unavailable:r.plan.mcpUnavailable,candidate:Object.keys(r.candidate.config.mcpServers),state:r.stateSha256,rejected}}));"""
                claude = subprocess.run(['node', '--input-type=module', '-e', claude_script, str(fd), session, digest], pass_fds=(fd,), text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(claude.stdout), {'available': ['online'], 'unavailable': ['offline'], 'candidate': ['online'], 'state': digest, 'rejected': True})
                controller_uri = (MODULE.parent / 'successor-launch-controller.mjs').as_uri()
                frame_uri = (MODULE.parent / 'restart-delivery-frame.mjs').as_uri()
                claude_control = claude_script.split('const r=await prepareSealedClaudeRoleMcp(opts);')[0] + f"""
const {{invokeSealedClaudeSuccessor}}=await import('{controller_uri}');
const {{parseRestartDeliveryFrame}}=await import('{frame_uri}');
const {{createHash}}=await import('node:crypto');
const binding={{handoverId:'attempt',launchId:'launch',session:opts.session,successorSession:'claude:33333333-3333-4333-8333-333333333333',generation:1,stateSha256:opts.expectedStateSha256,profileSha256:opts.expectedProfileSha256}};
let calls=0,marks=0,received='',candidate=[];
const call={{binding,fd:opts.fd,channel:opts.channel,authority:opts.authority,inventory:opts.inventory,verifyPolicy:async()=>({{approvalPolicy:'never',policyVerified:true,pluginPlanVerified:true}}),markInvoking:async b=>{{marks++;return {{channel:{{phase:'handover',handoverId:b.handoverId,session:b.session,generation:b.generation,successorLaunch:{{id:b.launchId,...b,status:'invoking'}}}}}};}},launch:async value=>{{calls++;received=createHash('sha256').update(parseRestartDeliveryFrame(value.frame.text).text).digest('hex');candidate=Object.keys(value.candidate.config.mcpServers);}}}};
const outcome=await invokeSealedClaudeSuccessor(call); let rejected=false;
try{{await invokeSealedClaudeSuccessor({{...call,verifyPolicy:async()=>({{approvalPolicy:'ask',policyVerified:true,pluginPlanVerified:true}})}})}}catch{{rejected=true}}
console.log(JSON.stringify({{status:outcome.status,received,candidate,calls,marks,rejected}}));"""
                controlled = subprocess.run(['node', '--input-type=module', '-e', claude_control, str(fd), session, digest], pass_fds=(fd,), text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(controlled.stdout), {'status': 'outcome-unverified', 'received': digest, 'candidate': ['online'], 'calls': 1, 'marks': 1, 'rejected': True})
                delivery = (MODULE.parent / 'sealed-restart-delivery.mjs').as_uri()
                delivery_script = f"import {{ createHash }} from 'node:crypto'; import {{ readSealedRestartForDelivery }} from '{delivery}'; import {{ roleProfileDigest }} from '{restart}'; const p={{schema:'agent-mesh.role-profile.v1',role:'operator',permissions:[],mcp:['online','offline'],plugins:[]}}; const r=readSealedRestartForDelivery({{fd:Number(process.argv[1]),session:process.argv[2],channel:'fixture',expectedSha256:process.argv[3],expectedProfileSha256:roleProfileDigest(p)}}); console.log(createHash('sha256').update(r.text).digest('hex'));"
                delivered = subprocess.run(['node', '--input-type=module', '-e', delivery_script, str(fd), session, digest], pass_fds=(fd,), text=True, capture_output=True, check=True)
                self.assertEqual(delivered.stdout.strip(), digest)
                mismatch_script = delivery_script.replace('expectedProfileSha256:roleProfileDigest(p)', "expectedProfileSha256:'a'.repeat(64)")
                mismatch = subprocess.run(['node', '--input-type=module', '-e', mismatch_script, str(fd), session, digest], pass_fds=(fd,), text=True, capture_output=True)
                self.assertNotEqual(mismatch.returncode, 0)
                self.assertEqual(mismatch.stdout, '')
                coordinator = (MODULE.parent / 'successor-launch-controller.mjs').as_uri()
                combined_script = f"""import {{ createHash }} from 'node:crypto';
import {{ invokeSealedSuccessor }} from '{coordinator}';
import {{ roleProfileDigest }} from '{restart}';
const profile={{schema:'agent-mesh.role-profile.v1',role:'operator',permissions:[],mcp:['online','offline'],plugins:[]}};
const binding={{handoverId:'attempt',launchId:'launch',session:process.argv[2],generation:1,stateSha256:process.argv[3],profileSha256:roleProfileDigest(profile)}};
const authority={{role:'operator',permissions:[],humanGatedPermissions:[],mcp:['online','offline'],plugins:[]}};
let received='', calls=0, marks=0;
const opts={{binding,fd:Number(process.argv[1]),channel:'fixture',authority,probe:async name=>name==='online',verifyPolicy:async()=>({{approvalPolicy:'never',policyVerified:true,pluginPlanVerified:true}}),markInvoking:async b=>{{marks++;return {{channel:{{phase:'handover',handoverId:b.handoverId,session:b.session,generation:b.generation,successorLaunch:{{id:b.launchId,...b,status:'invoking'}}}}}};}},launch:async ({{delivery,plan}})=>{{calls++;received=createHash('sha256').update(delivery.text).digest('hex');if(plan.mcpToStart.join()!=='online'||plan.mcpUnavailable.join()!=='offline')throw Error('bad plan');}}}};
const result=await invokeSealedSuccessor(opts);
let rejected=false;try{{await invokeSealedSuccessor({{...opts,verifyPolicy:async()=>({{approvalPolicy:'on-request',policyVerified:true,pluginPlanVerified:true}})}})}}catch{{rejected=true}}
console.log(JSON.stringify({{status:result.status,received,calls,marks,rejected}}));"""
                combined = subprocess.run(['node', '--input-type=module', '-e', combined_script, str(fd), session, digest], pass_fds=(fd,), text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(combined.stdout), {'status': 'outcome-unverified', 'received': digest, 'calls': 1, 'marks': 1, 'rejected': True})
                wrong = subprocess.run(['node', '--input-type=module', '-e', script, str(fd), session, 'a' * 64], pass_fds=(fd,), text=True, capture_output=True)
                self.assertNotEqual(wrong.returncode, 0)
                plain = os.open(path, os.O_RDONLY)
                try:
                    unsealed = subprocess.run(['node', '--input-type=module', '-e', script, str(plain), session, digest], pass_fds=(plain,), text=True, capture_output=True)
                    self.assertNotEqual(unsealed.returncode, 0)
                finally:
                    os.close(plain)
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
