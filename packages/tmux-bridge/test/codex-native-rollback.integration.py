#!/usr/bin/env python3
"""Opt-in isolated Codex rollback integration test. Never uses live state."""
import importlib.util, json, os, pathlib, selectors, subprocess, tempfile, time
base = pathlib.Path(__file__).resolve().parents[1] / 'bin'
spec = importlib.util.spec_from_file_location('owned', base / 'isolated-pid-namespace.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
rollback_spec = importlib.util.spec_from_file_location('isolated_rollback', base / 'isolated-role-rollback.py')
rollback_module = importlib.util.module_from_spec(rollback_spec)
rollback_spec.loader.exec_module(rollback_module)
binary = os.environ.get('AGENT_MESH_TEST_CODEX_BIN')
if not binary:
    print('SKIP: set AGENT_MESH_TEST_CODEX_BIN to an absolute Codex binary path')
    raise SystemExit(0)
if not os.path.isabs(binary) or not os.path.isfile(binary) or (not os.access(binary, os.X_OK)):
    raise RuntimeError('test Codex binary must be an absolute executable file')

class Client:

    def __init__(self, lease):
        self.lease = lease
        self.seq = 0
        self.buffer = b''
        self.events = []
        self.sel = selectors.DefaultSelector()
        self.sel.register(lease.process.stdout, selectors.EVENT_READ)

    def write(self, entry):
        self.lease.process.stdin.write((json.dumps(entry) + '\n').encode())
        self.lease.process.stdin.flush()

    def request(self, method, params, timeout=15):
        self.seq += 1
        rid = self.seq
        self.write({'id': rid, 'method': method, 'params': params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b'\n' not in self.buffer:
                if not self.sel.select(max(0, deadline - time.monotonic())):
                    break
                data = os.read(self.lease.process.stdout.fileno(), 65536)
                if not data:
                    break
                self.buffer += data
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get('method'):
                    self.events.append(row)
                    continue
                if row.get('id') == rid:
                    if 'error' in row:
                        raise RuntimeError('RPC error ' + str(row['error'].get('code')))
                    return row['result']
        raise RuntimeError('RPC timeout')

    def init(self):
        self.request('initialize', {'clientInfo': {'name': 'rollback-isolated', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
        self.write({'method': 'initialized', 'params': {}})
with tempfile.TemporaryDirectory(prefix='permission-rollback-isolated-') as td:
    root = pathlib.Path(td)
    (root / 'home').mkdir(mode=448)
    for name in ['old', 'new']:
        (root / name).mkdir(mode=448)
    fixture = root / 'elicitation.py'
    beat = root / 'heartbeat'
    fixture.write_text('import json,sys,pathlib,threading,time\np=pathlib.Path(sys.argv[1])\ndef tick():\n n=0\n while True:\n  n+=1;p.write_text(str(n));time.sleep(.1)\nthreading.Thread(target=tick,daemon=True).start()\nfor line in sys.stdin:\n try:req=json.loads(line)\n except:continue\n m=req.get("method")\n if m=="initialize":result={"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}\n elif m=="tools/list":result={"tools":[]}\n elif m=="notifications/initialized":\n  print(json.dumps({"jsonrpc":"2.0","id":"synthetic","method":"elicitation/create","params":{"message":"synthetic","requestedSchema":{"type":"object","properties":{}}}}),flush=True);continue\n else:continue\n if "id" in req:print(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":result}),flush=True)\n')
    (root / 'old' / 'config.toml').write_text('model_provider = "fixture"\nmodel = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:18765/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n')
    provider = root / 'provider.py'
    provider.write_text('from http.server import HTTPServer,BaseHTTPRequestHandler\nfrom pathlib import Path\nclass H(BaseHTTPRequestHandler):\n def do_POST(self):\n  self.rfile.read(int(self.headers.get("content-length",0)));Path(' + repr(str(root / 'provider-seen')) + ').write_text("seen");self.send_response(503);self.end_headers();self.wfile.write(b"{}")\n def log_message(self,*a):pass\nHTTPServer(("127.0.0.1",18765),H).serve_forever()\n')
    launcher = root / 'launcher.py'
    launcher.write_text('import os,subprocess,sys\nsubprocess.Popen([sys.executable,sys.argv[1]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nos.execv(sys.argv[2],sys.argv[2:])\n')
    (root / 'new' / 'config.toml').write_text('[mcp_servers.fixture]\ncommand = "/usr/bin/python3"\nargs = [' + json.dumps(str(fixture)) + ', ' + json.dumps(str(beat)) + ']\n')

    def open_server(name):
        command = ['/usr/bin/env', 'HOME=' + str(root / 'home'), 'CODEX_HOME=' + str(root / name), 'PATH=/usr/bin:/bin'] + (['/usr/bin/python3', str(launcher), str(provider)] if name == 'old' else []) + [binary, 'app-server', '--listen', 'stdio://']
        lease = module.IsolatedNamespace.prepare(td, command)
        leases.append(lease)
        lease.release()
        client = Client(lease)
        client.init()
        return (lease, client)
    leases = []
    try:
        old, oldc = open_server('old')
        oldthread = oldc.request('thread/start', {'ephemeral': True, 'cwd': td, 'approvalPolicy': 'never', 'sandbox': 'read-only'})['thread']['id']
        new, newc = open_server('new')
        started = newc.request('thread/start', {'ephemeral': True, 'cwd': td, 'approvalPolicy': 'on-request', 'sandbox': 'read-only'})
        newthread = started['thread']['id']
        deadline = time.monotonic() + 8
        req = None
        while time.monotonic() < deadline:
            newc.request('thread/loaded/list', {'limit': 100})
            req = next((x for x in newc.events if x.get('method') == 'mcpServer/elicitation/request' and x.get('params', {}).get('threadId') == newthread), None)
            if req and beat.exists():
                break
            time.sleep(0.1)
        if not req or not beat.exists():
            raise RuntimeError('expected isolated elicitation unavailable')
        js = "import {createCodexMcpStartupObserver} from OBS;import {assessCodexRoleStart} from ASSESS;const x=JSON.parse(await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s))}));const o=createCodexMcpStartupObserver();o.onNotification(x.event);o.bindThread(x.started.thread.id);const expected={profile:{id:':read-only',extends:null},approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}};const a=assessCodexRoleStart({startResponse:x.started,sample:o.snapshot(),expected});console.log(JSON.stringify(a));"
        js = js.replace('OBS', json.dumps((base / 'codex-mcp-startup-notifications.mjs').as_uri())).replace('ASSESS', json.dumps((base / 'codex-role-start-assessment.mjs').as_uri()))
        assessed = json.loads(subprocess.check_output(['/usr/bin/node', '--input-type=module', '-e', js], input=json.dumps({'started': started, 'event': req}).encode(), timeout=5))
        if assessed['status'] != 'rollback-required' or 'unexpected-permission-request' not in assessed['failures']:
            raise RuntimeError('assessment did not require rollback')
        first = beat.read_text()
        time.sleep(0.35)
        observed_before = beat.read_text()
        if observed_before == first:
            raise RuntimeError('fixture heartbeat was not active')
        journal = root / 'rollback-journal'
        journal.mkdir(mode=0o700)
        rollback = rollback_module.IsolatedRoleRollback('codex:' + newthread, new.stop, str(journal))
        decision = rollback.apply(assessed)
        if decision['status'] != 'local-init-exited' or decision['handover'] != 'blocked':
            raise RuntimeError('owned rollback did not verify namespace init exit')
        if rollback.apply(assessed) != decision:
            raise RuntimeError('replayed rollback changed its receipt')
        receipt = decision['namespaceStop']
        time.sleep(0.8)
        observed_after = beat.read_text()
        oldRead = oldc.request('thread/loaded/list', {'limit': 100})
        turn = oldc.request('turn/start', {'threadId': oldthread, 'input': [{'type': 'text', 'text': 'synthetic recovery check', 'text_elements': []}]})
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and (not (root / 'provider-seen').exists()):
            time.sleep(0.05)
        if turn.get('turn', {}).get('status') != 'inProgress' or not (root / 'provider-seen').exists():
            raise RuntimeError('predecessor did not accept isolated turn')
        if observed_before != observed_after or oldthread not in oldRead.get('data', []):
            raise RuntimeError('rollback isolation check failed')
        if receipt.get('status') != 'init-exited':
            raise RuntimeError('namespace init exit not verified')
        print(json.dumps({'predecessorAcceptedNewTurn': turn.get('turn', {}).get('status') == 'inProgress', 'localProviderObserved': (root / 'provider-seen').exists(), 'isolatedNetwork': True, 'temporaryHome': True, 'realSuccessorElicitation': True, 'permissionResponseSent': False, 'assessment': assessed['status'], 'permissionFailure': True, 'namespaceStop': receipt, 'successorFixtureHeartbeatStopped': observed_before == observed_after, 'predecessorStillLoaded': oldthread in oldRead.get('data', []), 'syntheticSessionsOnly': True}))
    finally:
        for lease in reversed(leases):
            if not lease._stopped:
                lease.stop()
