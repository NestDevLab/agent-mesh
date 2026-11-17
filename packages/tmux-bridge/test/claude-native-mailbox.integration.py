import json,os,pathlib,subprocess,sys,tempfile,threading,time,uuid
from http.server import HTTPServer,BaseHTTPRequestHandler
BINARY=os.environ.get('AGENT_MESH_TEST_CLAUDE_BIN')
if not BINARY:
 print('SKIP: set AGENT_MESH_TEST_CLAUDE_BIN to an absolute Claude binary path');sys.exit(0)
if not os.path.isabs(BINARY) or not os.path.isfile(BINARY) or not os.access(BINARY,os.X_OK):
 raise RuntimeError('test Claude binary must be an absolute executable file')
BASE=pathlib.Path(__file__).resolve().parents[1]/'bin'
NODE=os.environ.get('AGENT_MESH_TEST_NODE_BIN','/usr/local/bin/node')
if not os.path.isabs(NODE) or not os.access(NODE,os.X_OK):raise RuntimeError('test Node binary must be absolute and executable')
if len(sys.argv)>1:
 root=pathlib.Path(sys.argv[1]); count=[0]
 class H(BaseHTTPRequestHandler):
  def do_POST(self):
   self.rfile.read(int(self.headers.get('Content-Length',0))); count[0]+=1; time.sleep(2 if count[0]==1 else 0)
   es=[('message_start',{'type':'message_start','message':{'id':'msg_fixture','type':'message','role':'assistant','model':'fixture','content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':1,'output_tokens':1}}}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'fixture reply'}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':2}}),('message_stop',{'type':'message_stop'})]
   body=''.join('event: '+n+'\ndata: '+json.dumps(v)+'\n\n' for n,v in es).encode(); self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
  def log_message(self,*args): pass
 server=HTTPServer(('127.0.0.1',18984),H);threading.Thread(target=server.serve_forever,daemon=True).start(); sid=str(uuid.uuid4())
 cmd=[BINARY,'--print','--input-format','stream-json','--output-format','stream-json','--verbose','--model','claude-sonnet-4-5','--permission-mode','dontAsk','--session-id',sid,'--name','fixture-peer','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--settings','{"disableAllHooks":true}']
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 rec={'schema':'agent-mesh.monitor-inbox.v1','deliveryId':'fixture-1','meshId':'fixture-1','prompt':'synthetic delivery'}
 def send(content):p.stdin.write(json.dumps({'type':'user','message':{'role':'user','content':content}})+'\n');p.stdin.flush()
 send('first synthetic turn');time.sleep(.7)
 import importlib.util
 native=str(BASE/'agent-inbox-native.py')
 spec=importlib.util.spec_from_file_location('native',native); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 os.environ['CLAUDE_BIN']=BINARY
 try:
  owner=m.identity(p.pid); match=m.registration(sid,owner)
  with m.NativeClient() as client: listing=m.tool_json(client.request('tools/call',{'name':'ListAgents','arguments':{}}))
  native_result={'registrationFound':bool(match),'sections':[(x.get('kind'),len(x.get('rows',[]))) for x in listing.get('sections',[])]}
 except Exception as e:native_result={'errorType':type(e).__name__,'error':str(e)[:180]}
 inbox_script=native.replace('agent-inbox-native.py','agent-session-inbox.py')
 inbox_spec=importlib.util.spec_from_file_location('mailbox',inbox_script); inbox_mod=importlib.util.module_from_spec(inbox_spec); inbox_spec.loader.exec_module(inbox_mod)
 inbox_root=root/'inbox'; inbox=inbox_mod.prepare(inbox_root,sid)
 os.environ['MESH_COMMS_STATE']=str(root/'comms'); os.environ['XDG_STATE_HOME']=str(root/'state')
 watcher=subprocess.Popen(['/usr/bin/python3',inbox_script,'serve','--root',str(inbox_root),'--session',sid,'--owner-pid',str(p.pid),'--owner-start',owner['start'],'--batch-seconds','0.1','--retry-seconds','0.05'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
 deadline=time.monotonic()+5
 while time.monotonic()<deadline and not inbox_mod.watcher_active(inbox):time.sleep(.05)
 native_result['watcherReady']=bool(inbox_mod.watcher_active(inbox))
 graph_dir=root/'graph'
 def graph_call(*parts,check=True):
  result=subprocess.run([NODE,str(BASE/'mesh-graph.mjs'),'--state',str(graph_dir),*parts],capture_output=True,text=True,timeout=10)
  if check and result.returncode:raise RuntimeError('fixture graph operation failed: '+result.stderr[-300:])
  return result
 target='claude:'+sid
 graph_call('add','--agent','claude','--tmux-target','fixture','--cwd','/synthetic','--runtime-uuid',sid,'--json')
 graph_call('migrate','--apply','--json')
 graph_call('channel','create','--name','fixture','--session',target)
 graph_call('channel','enqueue','--name','fixture','--id','fixture-1','--input','synthetic delivery')
 graph_call('channel','begin-delivery','--name','fixture','--id','fixture-1','--session',target,'--generation','1')
 native_result['prematureRecoveryRejected']=graph_call('channel','recover-claude-delivery','--name','fixture','--id','fixture-1',check=False).returncode!=0
 sender=native.replace('agent-inbox-native.py','agent-native-call.mjs')
 call=subprocess.run([NODE,sender,'--agent','claude','--session',sid,'--correlation-id','fixture-1','--message','synthetic delivery','--delivery-only','--managed-inbox-root',str(inbox_root),'--timeout','10'],capture_output=True,text=True,timeout=20)
 native_result['senderExit']=call.returncode
 try:native_result['senderResult']=json.loads(call.stdout)
 except ValueError:native_result['senderOutput']=call.stdout[-400:];native_result['senderError']=call.stderr[-400:]
 if inbox.stat().st_size:rec=json.loads(inbox.read_text().splitlines()[0])
 deadline=time.monotonic()+12
 while time.monotonic()<deadline and not m.receipt_seen(sid,m.delivery_message(sid,['AGENT_MESH_INBOX '+json.dumps(rec)])):time.sleep(.1)
 native_result['transportReceiptObserved']=m.receipt_seen(sid,m.delivery_message(sid,['AGENT_MESH_INBOX '+json.dumps(rec)]))
 time.sleep(2)
 native_result['cursorMatches']=json.loads(inbox.with_suffix('.cursor.json').read_text())['offset']==inbox.stat().st_size
 recovered=graph_call('channel','recover-claude-delivery','--name','fixture','--id','fixture-1')
 native_result['graphRecovery']=json.loads(recovered.stdout).get('status')
 native_result['graphState']=json.loads(graph_call('channel','get','--name','fixture').stdout)['channel']['queue'][0]['state']
 import sqlite3
 db=sqlite3.connect(root/'comms'/'comms.sqlite');native_result['commsStatuses']=db.execute('select status,detail from deliveries').fetchall();db.close()
 p.stdin.close()
 try:p.wait(timeout=15)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 watcher.wait(timeout=4)
 native_result['watcherExit']=watcher.returncode
 native_result['deadLetter']=pathlib.Path(str(inbox)+'.unconfirmed.jsonl').exists()
 rows=[]
 for path in (root/'config'/'projects').glob('*/'+sid+'.jsonl'):
  rows += [json.loads(x) for x in path.read_text().splitlines()]
 observer=str(BASE/'claude-delivery-observation.mjs')
 js="import {observeClaudeDelivery} from 'file://"+observer+"'; try { let r=await observeClaudeDelivery({root:process.argv[1],session:'claude:'+process.argv[2],generation:1,messageId:'fixture-1',payload:'synthetic delivery'}); console.log(JSON.stringify({accepted:true,schema:r.schema})); } catch(e) {console.log(JSON.stringify({accepted:false,error:e.message})); process.exitCode=1}"
 check=subprocess.run([NODE,'--input-type=module','-e',js,str(root/'config'/'projects'),sid],capture_output=True,text=True,timeout=5)
 out={'nativeDiscovery':native_result,'observerExit':check.returncode,'observer':check.stdout.strip(),'exitCode':p.returncode,'providerRequests':count[0],'transcripts':len(list((root/'config'/'projects').glob('*/'+sid+'.jsonl'))),'records':[{'type':x.get('type'),'operation':x.get('operation'),'hasMarker':'AGENT_MESH_INBOX ' in json.dumps(x)} for x in rows if 'AGENT_MESH_INBOX ' in json.dumps(x)]}
 print(json.dumps(out));server.shutdown()
 expected={'registrationFound':True,'watcherReady':True,'prematureRecoveryRejected':True,'senderExit':0,'transportReceiptObserved':True,'cursorMatches':True,'graphRecovery':'accepted','graphState':'accepted','watcherExit':0,'deadLetter':False}
 for key,value in expected.items():
  if native_result.get(key)!=value:raise AssertionError('fixture condition failed: '+key)
 if native_result.get('senderResult',{}).get('status')!='queued':raise AssertionError('sender did not queue')
 if native_result.get('commsStatuses')!=[['delivered','transport accepted'],['delivered','read']]:
  # sqlite returns tuples before serialization
  if native_result.get('commsStatuses')!=[('delivered','transport accepted'),('delivered','read')]:raise AssertionError('gate receipts incomplete')
 if p.returncode!=0 or count[0]!=2 or check.returncode!=0:raise AssertionError('native transcript observation failed')
 sys.exit(0)
with tempfile.TemporaryDirectory(prefix='claude-queue-fixture-') as td:
 root=pathlib.Path(td);(root/'home').mkdir();(root/'config').mkdir()
 cmd=['bwrap','--die-with-parent','--ro-bind','/','/','--tmpfs','/tmp','--bind',td,td,'--ro-bind',__file__,__file__,'--proc','/proc','--dev','/dev','--unshare-pid','--unshare-net','--clearenv','--setenv','HOME',str(root/'home'),'--setenv','CLAUDE_CONFIG_DIR',str(root/'config'),'--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','ANTHROPIC_BASE_URL','http://127.0.0.1:18984','--setenv','ANTHROPIC_API_KEY','fixture-not-a-credential','--setenv','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','1','--setenv','CI','1','--setenv','AGENT_MESH_TEST_CLAUDE_BIN',BINARY,'--setenv','AGENT_MESH_TEST_NODE_BIN',NODE,'--chdir',td,'/usr/bin/python3',__file__,td]
 try:
  p=subprocess.run(cmd,capture_output=True,text=True,timeout=30);print(json.dumps({'sandboxExit':p.returncode,'output':p.stdout.strip(),'stderrTail':p.stderr.splitlines()[-2:]}));sys.exit(p.returncode)
 except subprocess.TimeoutExpired:print(json.dumps({'outcome':'timeout'}));sys.exit(1)
