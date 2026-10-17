"""Upgrade a disposable 0.6.7 container using the new public shell utility."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--container', required=True)
    parser.add_argument('--setup', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--docker-config')
    args = parser.parse_args()
    docker = ['docker'] + (['--config', args.docker_config] if args.docker_config else [])
    version = re.search(r'^PAIR_VERSION=(.+)$', args.setup.read_text(), re.MULTILINE).group(1)
    evidence = {'scope': 'disposable systemd container on one physical computer', 'targetVersion': version, 'checks': []}

    def command(*values, input=None, success=True):
        result = subprocess.run([*docker, *values], input=input, text=True, capture_output=True, timeout=900)
        if success and result.returncode:
            errors = [line for line in result.stderr.splitlines() if line.startswith('Pair Notebook installation failed:')]
            raise RuntimeError(f'Docker operation failed ({result.returncode}): ' + ' '.join(errors))
        return result

    def python(source):
        return command('exec', '-i', args.container, 'python3', '-', input=source)

    def check(label):
        evidence['checks'].append(label)
        print('PASS: ' + label, flush=True)

    verify = '''import base64, hashlib, json, pathlib, urllib.request
root=pathlib.Path('/var/lib/pair-notebook-install')
baseline=json.loads((root/'upgrade-baseline.json').read_text())
for file,digest in baseline.items(): assert hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()==digest
identities=json.loads((root/'acceptance-project.json').read_text())
def rpc(operation, identity, **fields):
 request=urllib.request.Request('http://127.0.0.1:8787/v1/sessions/rpc',data=json.dumps(dict(fields,operation=operation,sessionId=identity['sessionId'])).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+identity['token']})
 with urllib.request.urlopen(request,timeout=15) as reply:return json.load(reply)
for identity in identities.values(): assert base64.b64decode(rpc('read',identity,path='survival.txt')['content'])==b'preserved project and owner access'
'''
    try:
        command('start', args.container)
        for _ in range(60):
            if command('exec', args.container, 'systemctl', 'is-system-running', success=False).stdout.strip() in {'running', 'degraded'}:
                break
            time.sleep(.5)
        old = json.loads(command('exec', args.container, 'cat', '/opt/pair-notebook/server/BUILD.json').stdout)
        assert old['version'] == '0.6.7'
        python('''import hashlib,json,pathlib
root=pathlib.Path('/var/lib/pair-notebook-install')
files=list(pathlib.Path('/etc/pair-notebook').rglob('*'))+list(pathlib.Path('/etc/systemd/system').glob('pair-notebook-*.service'))+[root/'owner-server.json']
baseline={str(file):hashlib.sha256(file.read_bytes()).hexdigest() for file in files if file.is_file()}
(root/'upgrade-baseline.json').write_text(json.dumps(baseline))
''')
        python(verify)
        command('cp', str(args.setup), f'{args.container}:/var/lib/pair-notebook-install/setup-new.sh')
        setup = ['exec', '-i', args.container, 'sh', '/var/lib/pair-notebook-install/setup-new.sh']
        command(*setup, input='\n')
        assert json.loads(command('exec', args.container, 'cat', '/opt/pair-notebook/server/BUILD.json').stdout)['version'] == version
        python(verify)
        check('new utility defaults to update from published 0.6.7; owners, members, files and settings retained')
        command('cp', str(args.setup), f'{args.container}:/var/lib/pair-notebook-install/setup-new.sh')
        command(*setup, '--action', 'check')
        check('fresh copy of utility detects existing version and passes real Jupyter, HTTPS and encrypted reconnect')
        python(verify + '''
owner=identities['owner']
view=rpc('view',owner)
rpc('write',owner,path='owner-only.txt',visibility='private',expectedRevision=view['revision'],content=base64.b64encode(b'private survival').decode())
''')
        command(*setup, '--action', 'recover-owner', input='1\nyes\n')
        python(verify.replace("for identity in identities.values(): assert", "for identity in [identities['guest']]: assert") + '''
import urllib.error
old=identities['owner']
try: rpc('view',old); raise AssertionError('Old owner credential remains valid')
except urllib.error.HTTPError as error: assert error.code==401
files=sorted((root/'recovered-owners').glob('*.json'));assert files
owner=json.loads(files[-1].read_text());assert owner['memberId']==old['memberId']
assert base64.b64decode(rpc('read',owner,path='owner-only.txt')['content'])==b'private survival'
try:rpc('read',identities['guest'],path='owner-only.txt');raise AssertionError('Guest accessed private file')
except urllib.error.HTTPError as error:assert error.code==404
identities['owner']=owner;(root/'acceptance-project.json').write_text(json.dumps(identities))
''')
        python(verify)
        check('lost local owner credential recovered; prior owner key revoked, private file retained, guest access preserved and private denial enforced')
        command(*setup, '--action', 'rollback')
        assert json.loads(command('exec', args.container, 'cat', '/opt/pair-notebook/server/BUILD.json').stdout)['version'] == '0.6.7'
        python(verify)
        check('rollback to previous published server retains recovered identity and project data')
        command(*setup, '--action', 'update')
        python(verify)
        check('same newly downloaded utility upgrades again after rollback without local VS Code state')
        evidence['passed'] = True
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(evidence, indent=2) + '\n')


if __name__ == '__main__':
    main()
