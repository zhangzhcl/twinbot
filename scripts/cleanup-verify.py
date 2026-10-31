#!/usr/bin/env python3
"""删除标题为指定名称的验证会话。"""
import json
import sys
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:8788'
TITLE = sys.argv[1] if len(sys.argv) > 1 else 'preview-verify'

with open('/home/ubuntu/twinbot/deploy/control/.env', encoding='utf-8') as f:
    for line in f:
        if line.startswith('CONTROL_TOKENS_JSON='):
            token = next(iter(json.loads(line.split('=', 1)[1])))
            break


def request(method, path):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header('authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, (None if resp.status == 204 else json.loads(resp.read().decode()))
    except urllib.error.HTTPError as e:
        return e.code, None


_, sessions = request('GET', '/v1/sessions')
for session in sessions.get('sessions', []):
    if session['title'] == TITLE:
        status, _ = request('DELETE', f"/v1/sessions/{session['id']}")
        print('deleted', session['id'][:8], '->', status)
print('remaining:', sum(1 for s in request('GET', '/v1/sessions')[1]['sessions'] if s['title'] == TITLE))
