#!/usr/bin/env python3
"""Measured >=24-hour real Session Host + isolated Jupyter soak; --check is a short harness check."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('soak_agent', ROOT / 'scripts/pair-notebook-session-agent.py')
AGENT = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(AGENT)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--image-file', required=True)
    parser.add_argument('--python', default='/opt/pair-python/bin/python')
    parser.add_argument('--hours', type=float, default=24)
    parser.add_argument('--interval', type=float, default=60)
    parser.add_argument('--check', action='store_true', help='Short harness check; NEVER 24-hour acceptance')
    args = parser.parse_args()
    if args.hours < 24 or args.interval < 1: parser.error('Measured acceptance requires >=24 hours and a positive interval')
    evidence = Path(args.evidence).resolve(); evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    admin, worker = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    state = evidence / 'state'; state.mkdir(mode=0o700, exist_ok=True)
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    endpoint = f'http://127.0.0.1:{port}'
    log = (evidence / 'events.jsonl').open('a', buffering=1)
    server = None; agent = None; personal = None; sequence = 0; executions = set(); started = time.monotonic()
    code = "from pathlib import Path\np=Path('ledger.txt')\nlines=p.read_text().splitlines() if p.exists() else []\nlines.append('execution')\np.write_text('\\n'.join(lines)+'\\n')\nprint(len(lines))"
    commit = json.loads((ROOT/'BUILD.json').read_text())['baseCommit'] if (ROOT/'BUILD.json').is_file() else subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()
    def record(kind, **fields): log.write(json.dumps({'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'elapsedSeconds': time.monotonic()-started, 'kind': kind, **fields})+'\n')
    def rpc(operation, token=None, **fields):
        request = urllib.request.Request(endpoint + '/v1/sessions/rpc', data=json.dumps({'operation': operation, **fields}).encode(), headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer '+token} if token else {})}, method='POST')
        with urllib.request.urlopen(request, timeout=15) as response: return json.load(response)
    def start_server():
        source = "const {VpsServer}=require(process.env.PAIR_SOAK_MODULE);const s=new VpsServer({dataDirectory:process.env.PAIR_SOAK_STATE,clientToken:process.env.PAIR_SOAK_ADMIN,agentTokens:{vps:process.env.PAIR_SOAK_WORKER}});process.on('SIGTERM',()=>s.stop().then(()=>process.exit(0)));s.start(Number(process.env.PAIR_SOAK_PORT)).catch(e=>{console.error(e);process.exit(1)});"
        env = {**os.environ, 'PAIR_SOAK_MODULE': str(ROOT/'out/src/vps/server.js'), 'PAIR_SOAK_STATE':str(state/'server'), 'PAIR_SOAK_ADMIN':admin,'PAIR_SOAK_WORKER':worker,'PAIR_SOAK_PORT':str(port)}
        stream = (evidence/'server.log').open('a')
        process = subprocess.Popen(['node','-e',source], env=env, stdout=stream, stderr=stream); stream.close()
        deadline = time.monotonic()+15
        while time.monotonic()<deadline:
            try: rpc('list',admin); return process
            except Exception:
                if process.poll() is not None: raise RuntimeError('Soak server failed to start; inspect server.log')
                time.sleep(.1)
        process.terminate(); process.wait(timeout=15); raise RuntimeError('Soak server startup deadline')
    try:
        sandbox = AGENT.ContainerSandbox(Path(args.image_file).read_text().strip(),args.python,ROOT/'media/jupyter_kernel_bridge.py',scope=str(state))
        if not sandbox.ready: raise RuntimeError(sandbox.reason)
        server = start_server()
        owners=[]; guests=[]
        for number in range(2):
            password=secrets.token_urlsafe(24)
            owner=rpc('create',admin,name=f'Measured soak {number}',password=password); owners.append(owner)
            guests.append(rpc('join',sessionId=owner['sessionId'],password=password,name='Soak member'))
            notebook={'nbformat':4,'nbformat_minor':5,'metadata':{},'cells':[{'id':'soak-cell','cell_type':'code','source':code,'metadata':{},'outputs':[],'execution_count':None}]}
            rpc('write',owner['token'],sessionId=owner['sessionId'],path='soak.ipynb',content=base64.b64encode(json.dumps(notebook).encode()).decode(),expectedRevision=0)
        config=argparse.Namespace(id='vps',session=None,url=endpoint,token_file=None,config_token=worker,python=sys.executable,bridge=str(ROOT/'media/jupyter_kernel_bridge.py'),state=str(state/'worker'),name='Measured isolated VPS worker',share=True,max_kernels=2)
        agent=AGENT.SessionAgent(config,sandbox=sandbox); agent.tick()
        personal_sandbox=AGENT.ContainerSandbox(Path(args.image_file).read_text().strip(),args.python,ROOT/'media/jupyter_kernel_bridge.py',scope=str(state/'personal'))
        if not personal_sandbox.ready: raise RuntimeError(personal_sandbox.reason)
        personal_config=argparse.Namespace(id='soak-personal',session=owners[0]['sessionId'],url=endpoint,token_file=None,config_token=owners[0]['token'],python=sys.executable,bridge=str(ROOT/'media/jupyter_kernel_bridge.py'),state=str(state/'personal'),name='Real consenting owner container executor',share=True,max_kernels=1)
        personal=AGENT.SessionAgent(personal_config,sandbox=personal_sandbox); personal.tick()
        record('started', sourceCommit=commit, pid=os.getpid(), runtimeImage=sandbox.image, hoursRequested=args.hours, shortHarnessCheck=args.check)
        while args.check and sequence<2 or not args.check and time.monotonic()-started<args.hours*3600:
            for owner,guest in zip(owners,guests):
                rpc('heartbeat',guest['token'],sessionId=owner['sessionId'])
                rpc('leave',owner['token'],sessionId=owner['sessionId'])
                snapshot=rpc('snapshot',guest['token'],sessionId=owner['sessionId'])
                request={'sessionId':owner['sessionId'],'notebook':'soak.ipynb','cellIndex':0,'expectedRevision':snapshot['revision'],'expectedSourceHash':hashlib.sha256(code.encode()).hexdigest(),'expectedCellId':'soak-cell','requestId':f'soak-{sequence}-{owner["sessionId"]}'}
                run=rpc('execute',guest['token'],**request); replay=rpc('execute',guest['token'],**request)
                if replay['id']!=run['id'] or run['id'] in executions: raise RuntimeError('Duplicate admission identity')
                agent.tick()
                # An actual broker restart while an admitted kernel remains independent.
                if sequence%10==1:
                    server.terminate(); server.wait(timeout=15); server=start_server(); record('server-restarted',executionId=run['id'])
                time.sleep(1)  # Actual polling disconnect; the container keeps running.
                deadline=time.monotonic()+60
                while time.monotonic()<deadline:
                    agent.tick(); result=rpc('execution',owner['token'],sessionId=owner['sessionId'],executionId=run['id'])
                    if result['state'] not in ('queued','running'): break
                    time.sleep(.1)
                if result['state']!='completed': raise RuntimeError(f'Execution failed: {result["state"]}')
                executions.add(run['id'])
                ledger=rpc('read',owner['token'],sessionId=owner['sessionId'],path='ledger.txt')
                count=len(base64.b64decode(ledger['content']).decode().splitlines())
                if count!=sequence+1: raise RuntimeError('Lost or repeated real kernel side effect')
                record('execution',executionId=run['id'],sessionId=owner['sessionId'],ledgerCount=count)
            if sequence%10==1:
                owner,guest=owners[0],guests[0]; personal.tick()
                rpc('select',owner['token'],sessionId=owner['sessionId'],target={'deviceId':'soak-personal'})
                selection=rpc('select',guest['token'],sessionId=owner['sessionId'],target={'deviceId':'soak-personal'})
                consent=selection['consent']; rpc('consent',owner['token'],sessionId=owner['sessionId'],consentId=consent['id'],approved=True)
                controlled=rpc('kernel',guest['token'],sessionId=owner['sessionId'],notebook='soak.ipynb',command='restart',requestId=f'personal-restart-{sequence}')
                deadline=time.monotonic()+60
                while time.monotonic()<deadline:
                    personal.tick(); result=rpc('execution',owner['token'],sessionId=owner['sessionId'],executionId=controlled['id'])
                    if result['state'] not in ('queued','running'): break
                    time.sleep(.1)
                if result['state']!='completed': raise RuntimeError('Consenting executor restart failed')
                rpc('revokeConsent',owner['token'],sessionId=owner['sessionId'],consentId=consent['id'])
                try:
                    snap=rpc('snapshot',guest['token'],sessionId=owner['sessionId'])
                    rpc('execute',guest['token'],sessionId=owner['sessionId'],notebook='soak.ipynb',cellIndex=0,expectedRevision=snap['revision'],requestId=f'revoked-{sequence}')
                    raise RuntimeError('Revoked device admitted new execution')
                except __import__('urllib.error',fromlist=['HTTPError']).HTTPError as denied:
                    if denied.code!=403: raise
                rpc('select',owner['token'],sessionId=owner['sessionId'],target={'deviceId':'vps'})
                record('consent-revoke-restart',deviceId='soak-personal',executionId=controlled['id'])
            sequence+=1
            usage=__import__('psutil').Process(os.getpid())
            processes=[usage,*usage.children(recursive=True)]
            disk=sum(item.stat().st_size for item in state.rglob('*') if item.is_file())
            names=[*sandbox.containers.values(),*personal_sandbox.containers.values()]
            statistics=subprocess.run([sandbox.docker,'stats','--no-stream','--format','{{json .}}',*names],env=sandbox.environment(None),check=True,capture_output=True,text=True,timeout=15) if names else None
            container_metrics=[json.loads(line) for line in statistics.stdout.splitlines()] if statistics else []
            record('sample',cycle=sequence,executions=len(executions),rssBytes=sum(item.memory_info().rss for item in processes if item.is_running()),diskBytes=disk,processes=len(processes),kernels=len(agent.kernels)+len(personal.kernels),containerStats=container_metrics)
            summary={'sourceCommit':commit,'elapsedSeconds':time.monotonic()-started,'executions':len(executions),'cycles':sequence,'status':'running','shortHarnessCheck':args.check,'acceptance24Hours':False}
            AGENT.atomic_json(evidence/'summary.json',summary)
            if not args.check:
                until=time.monotonic()+args.interval
                while time.monotonic()<until: agent.tick(); time.sleep(.5)
        summary.update(status='completed',elapsedSeconds=time.monotonic()-started,acceptance24Hours=not args.check and time.monotonic()-started>=86400)
        AGENT.atomic_json(evidence/'summary.json',summary); record('completed',**summary)
    except Exception as error:
        AGENT.atomic_json(evidence/'summary.json',{'sourceCommit':commit,'status':'failed','elapsedSeconds':time.monotonic()-started,'executions':len(executions),'error':str(error),'acceptance24Hours':False})
        record('failed',error=str(error)); raise
    finally:
        if personal: personal.close()
        if agent: agent.close()
        if server and server.poll() is None: server.terminate(); server.wait(timeout=15)
        log.close()

if __name__=='__main__': main()
