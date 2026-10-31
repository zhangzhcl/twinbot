#!/usr/bin/env python3
"""端到端验证：创建会话 -> 发消息触发 code.run -> 轮询运行结果。只输出状态与回复，不输出任何密钥。"""
import json
import re
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:8788'


def load_token():
    with open('/home/ubuntu/twinbot/deploy/control/.env', encoding='utf-8') as f:
        for line in f:
            if line.startswith('CONTROL_TOKENS_JSON='):
                mapping = json.loads(line.split('=', 1)[1])
                first_user = next(iter(mapping.values()))
                first_token = next(iter(mapping))
                return first_token, first_user
    raise SystemExit('CONTROL_TOKENS_JSON not found in .env')


def request(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    if token:
        req.add_header('authorization', f'Bearer {token}')
    data = None
    if body is not None:
        req.add_header('content-type', 'application/json')
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=15) as resp:
        return json.loads(resp.read().decode())


def main():
    token, user = load_token()
    print(f'auth user: {user}')

    machines = request('GET', '/v1/machines', token=token)
    print('online machines:', [(m['machineId'], m['capabilities']) for m in machines.get('machines', [])])

    runtimes = request('GET', '/v1/runtimes', token=token)
    print('online runtimes:', [(r['podId'], r['capabilities']) for r in runtimes.get('runtimes', [])])

    session = request('POST', '/v1/sessions', {'title': 'deploy-verify'}, token=token)
    session_id = session.get('id') or (session.get('session') or {}).get('id')
    if not session_id:
        print('unexpected session response:', json.dumps(session, ensure_ascii=False)[:300])
        sys.exit(1)
    print('session created:', session_id)

    accepted = request('POST', f'/v1/sessions/{session_id}/messages', {
        'text': ('请用 cloud browser_use 工具依次执行：action=goto 打开 https://example.com，'
                 '再 action=screenshot 截图。然后告诉我页面标题和截图尺寸。')
    }, token=token)
    run_id = accepted.get('run', {}).get('id') or accepted.get('id')
    if not run_id:
        print('unexpected message response:', json.dumps(accepted, ensure_ascii=False)[:300])
        sys.exit(1)
    print('run queued:', run_id)

    for _ in range(60):
        time.sleep(2)
        run = request('GET', f'/v1/runs/{run_id}', token=token)
        status = run.get('status') or (run.get('run') or {}).get('status')
        if status in ('completed', 'failed', 'cancelled'):
            break
    print('run status:', status)
    if status == 'failed':
        print('run error:', json.dumps(run, ensure_ascii=False)[:500])
        sys.exit(1)

    messages = request('GET', f'/v1/sessions/{session_id}/messages', token=token)
    records = messages.get('messages', [])
    tool_texts = [m['text'] for m in records if m['role'] == 'tool']
    print('tool result contains marker:', any('tool-chain-ok' in t for t in tool_texts))
    reply = records[-1]['text'] if records else '(empty)'
    print('assistant reply (truncated):', re.sub(r'\s+', ' ', reply)[:300])


if __name__ == '__main__':
    main()
