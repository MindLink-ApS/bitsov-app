"""UI-E2E spec: the owner's evening, through current main’s real app window, no money.

Run by scripts/ui-e2e-two-node.sh (see scripts/ui-e2e/runner.py for the
plumbing: `r.ui(...)` drives the real window through tests/e2e/driver.js,
`r.api(...)` reads a node with an operator fixture token for evidence only).

The scenario follows the daily message approval and first-contact quote, while
pay/file retain their ten-minute window. Body gets a tab/organ smoke check;
budget preset editing and full organ semantics remain in the component tests.

Every UI action is a click or keystroke the owner could make. Node-side calls
are limited to (1) evidence reads, (2) what the owner types at node A's
terminal (`konsensus grant` and the displayed first-contact HTTP command), and (3) owner setup the app has no screen for
(creating a room), each labelled where it happens.
"""
import base64
from datetime import datetime
import re
import time

def run(r):
    a, b = r.ids['a'], r.ids['b']

    def track(peer):
        return f'[data-track="peer:{peer.lower()}"]'

    def owner_op():
        cmd = r.ui('wait', selector='[data-owner-action]', timeoutMs=20000) and r.text('[data-owner-action]')
        m = re.search(r'konsensus grant --op (\S+)', cmd)
        return cmd, (m.group(1) if m else None)

    def b_has(plaintext, room=None, seconds=30):
        path = '/messages?limit=200' + (f'&peer={room}' if room else '')
        return r.wait_until(lambda: any(m.get('plaintext') == plaintext for m in r.get('b', path)), seconds)

    def send_message(plaintext, timeout=30000):
        r.ui('fill', selector='[data-composer] textarea', value=plaintext)
        r.ui('click', selector='[data-send]', timeoutMs=timeout)

    def window(s, what, ready):
        """'Approve spending' for pay/file: the owner at the node, or the live G1 grant."""
        r.ui('click', selector='[data-send]')
        r.wait_until(lambda: r.ui_try('exists', selector='[data-owner-action]') or ready in r.text('[data-send]'), 20)
        if r.ui_try('exists', selector='[data-owner-action]'):
            cmd, op = owner_op()
            s.snap(f'{what}-waiting')
            out = r.owner_grant(op, '--budget', '100', '--for', '10m')
            s.note(f'{what}: owner granted the 10-minute window at node A: ' + ' '.join(out.split())[-160:])
        else:
            s.note(f'{what}: "Approve spending" opened the 10-minute window with no owner step at the node '
                   f'(the live owner grant was reused): {r.ui_try("text", within={"selector": "[data-composer]"})!r}'[:400])
        s.check(f'{what}: spending window open', r.wait_until(lambda: ready in r.text('[data-send]'), 20), r.text('[data-send]'))

    def app_tally():
        r.ui('click', selector='[data-tab="budget"]')
        r.ui('wait', selector='[data-tally-total]')
        return float(r.text('[data-tally-total]').split('/')[0].strip().replace(',', ''))

    def out_count():
        return len(r.ui('attrs', selector='article.msg.out', names=['data-message']))

    # ---------------------------------------------------------------- step 1
    with r.Step(1, 'First run: node starts, pairs, identity gate, mock funding explanation') as s:
        s.need('app started node A from the dev path', r.ui_try('wait', selector='[data-pairing]', timeoutMs=90000))
        paired = r.ui_try('wait', selector='[data-pairing="paired"]', timeoutMs=60000)
        s.snap('pairing')
        s.need('pairing view says "This app is paired"', paired and 'This app is paired' in r.text('[data-pairing="paired"]'),
               r.text())
        code = r.text('[data-short-code]')
        printed = r.pairing_codes
        s.check('access is read + receive', 'read + receive' in r.text('[data-pairing="paired"]'))
        s.check('short code matches what node A printed', printed and printed[-1] in code, {'ui': code, 'node': printed})
        try:  # evidence only: genome #82 serves /energy and /membrane to a local paired read
            r.pair_reader('a')
        except Exception as error:
            s.note(f'no paired evidence reader on node A: {error}')
        r.ui('wait', text='I understand — continue to funding', role='button', timeoutMs=60000)
        s.check('identity gate shows the running node id', a[:8] in r.text() or a[-8:] in r.text(), r.text()[:300])
        s.check('local-trust notice before deposit', r.ui_try('exists', selector='[data-gate="g6-local-trust"]'))
        s.snap('identity-gate')
        r.ui('click', text='I understand — continue to funding', role='button')
        r.ui('click', selector='[data-tab="body"]', timeoutMs=20000)
        s.need('Body tab opens the organism panel', r.ui_try('wait', selector='[data-panel="body"]'))
        organs = r.ui('attrs', selector='[data-panel="body"] [data-organ]', names=['data-organ'])
        s.check('Body shows all five organs', {o['data-organ'] for o in organs} ==
                {'metabolism', 'membrane', 'setpoints', 'immune', 'nucleus'}, organs)
        identity = r.ui('attrs', selector='[data-nucleus-id]', names=['title'])
        s.check('Body identifies the running node', identity and identity[0]['title'] == a, identity)
        s.snap('body')
        r.ui('click', text='Wallet', role='tab', exact=True, timeoutMs=20000)
        if r.ui_try('exists', text='Get a deposit address', role='button'):
            r.ui('click', text='Get a deposit address', role='button')
        r.ui('wait', selector='[data-deposit-error], svg.qr[aria-label="Deposit address as a QR code"]', timeoutMs=20000)
        qr = r.ui_try('exists', selector='svg.qr[aria-label="Deposit address as a QR code"]')
        s.snap('funding-qr')
        status, mock_addr = r.api('a', 'GET', '/payments/funding-address')
        shown = r.ui_try('text', within={'selector': '[data-panel="receive"]'}) or r.text()[:300]
        if not qr and status != 200:
            explained = r.ui_try('text', within={'selector': '[data-deposit-error]'})
            s.check("deposit panel shows the node's reason for no address", explained, shown[:200])
            s.check('mock funding has no address or QR', status == 400 and not qr
                    and 'embedded LDK' in str(mock_addr) and 'embedded LDK' in (explained or ''),
                    {'status': status, 'reason': mock_addr})
            if not explained:
              r.bug('Deposit panel waits forever when the node has no deposit address',
                  f'GET /payments/funding-address → HTTP {status} {mock_addr!r}; the Wallet panel keeps saying '
                  '"Waiting for the node to produce a deposit address…" with "0 of 0 sats seen" and never shows the '
                  "node's reason. On LDK this path works; any other backend (or an LDK error) leaves the owner waiting.",
                  'app src/App.tsx funding panel (#42, main)')
        else:
            addr = r.ui_try('text', within={'selector': '[data-panel="receive"] code.address'})
            s.check('funding QR shown for node A\'s address', qr and addr and mock_addr.get('address') in addr, {'ui': addr, 'node': mock_addr})

    # ---------------------------------------------------------------- step 2
    with r.Step(2, 'Owner approves the message budget through node A’s CLI') as s:
        s.need('node A connected to node B (loopback)', r.wait_until(lambda: b in r.get('a', '/peers/connected'), 60))
        r.ui('click', selector=track(b), timeoutMs=30000)
        r.ui('click', selector='[data-send]')
        cmd, op = owner_op()
        s.snap('approval-waiting')
        s.need('app shows the owner command to type at the node', op, cmd)
        s.check('send is held while waiting', r.ui_try('exists', selector='[data-approval="pending"]'))
        # Room sends conservatively reserve the remaining node allowance.
        # Keep the fixture's overall grant within the default 100-sat room budget.
        out = r.owner_grant(op, '--budget', '100', '--for', '10m')
        s.note('owner CLI: ' + ' '.join(out.split())[-300:])
        s.need('owner approval enables first-contact confirmation', r.ui_try('wait', selector='[data-budget="first"]', timeoutMs=20000))
        status = r.run('sandbox-exec', '-f', str(r.SANDBOX), r.BIN, 'pair-status', '--config', str(r.ROOTS['a'] / 'konsensus.toml'))
        s.check('node lists the live spend grant', 'SPEND GRANT' in status, status[-300:])
        s.snap('approval-open')

    # ---------------------------------------------------------------- step 3
    with r.Step(3, 'First contact to price_open B: capped send, admission and recipient settlement') as s:
        r.ui('click', selector=track(b))
        r.ui('wait', selector='[data-door-quote]', timeoutMs=20000)
        quote = r.ui('attrs', selector='[data-cost-msat]', names=['data-cost-msat'])
        s.need('composer shows a positive message ceiling', quote and int(quote[0]['data-cost-msat']) > 0, quote)
        door = r.ui('attrs', selector='[data-door-quote]', names=['data-door-quote'])
        s.check('composer cap matches the confirmed admission + message quote',
                door and int(door[0]['data-door-quote']) == int(quote[0]['data-cost-msat']) == 4000, door)
        total = int(quote[0]['data-cost-msat'])
        s.snap('first-contact-cost')
        balance_before = r.get('a', '/payments/balance')['balance_msat']
        before_b = r.get('b', '/payments')
        text = f'UI-E2E first contact {int(time.time())}'
        send_message(text)
        s.need('contact waits for independent owner approval', r.ui_try('wait', selector='[data-contact-approval="pending"]', timeoutMs=20000))
        pending = r.ui('attrs', selector='[data-contact-approval]', names=['data-contact-request'])
        import json
        request = json.loads(pending[0]['data-contact-request'])
        s.check('owner request binds this contact, quote, budget and paired grant',
                request['recipient'] == b and request['max_total_msat'] == total
                and request['contact_budget_msat'] >= total and request['client_id'] and request['grant_op_id'], request)
        s.snap('contact-owner-pending')
        command = r.ui('attrs', selector='[data-contact-owner-command]', names=['data-command'])[0]['data-command']
        s.note('FIXTURE: node A operator executes the displayed owner CLI through its local control socket; the app receives only the public receipt.')
        r.owner_first_contact(command)
        r.ui_try('wait', selector='article.msg.out [data-delivery="delivered"], [data-artifact="failed"]', timeoutMs=60000)
        note = r.ui_try('text', within={'selector': '[data-composer-note]'})
        s.snap('first-contact-result')
        received = b_has(text, seconds=5 if note else 30)
        s.check('sent after one contact owner approval; no owner credential enters the app', received, note or r.text()[:500])
        s.check('B received the first-contact message', received, note)
        paid = balance_before - r.get('a', '/payments/balance')['balance_msat']
        s.check('A paid at most the confirmed cap (admission + message)', total is not None and 0 < paid <= total,
                {'paid_msat': paid, 'cap_msat': total})
        paid_in = [p for p in r.get('b', '/payments') if p not in before_b and str(p.get('direction', '')).lower() == 'incoming'
                   and str(p.get('status', '')).lower() == 'settled']
        s.check('B recorded settled incoming payments (admission + message)', paid > 0 and len(paid_in) >= 2 and sum(p['amount_msat'] for p in paid_in) == paid,
                paid_in)
        membrane_b = r.read('b', '/membrane?limit=50')
        admitted = [e for e in (membrane_b.get('events', membrane_b) if isinstance(membrane_b, dict) else membrane_b)
                    if e.get('verdict') == 'admitted']
        s.check("B's membrane (N2) logged the admission by settlement", admitted, membrane_b)
        status = r.run('sandbox-exec', '-f', str(r.SANDBOX), r.BIN, 'pair-status', '--config', str(r.ROOTS['a'] / 'konsensus.toml'))
        s.note('node grant after first contact: ' + ' '.join(l for l in status.splitlines() if 'SPEND GRANT' in l)[:200])
        r.wait_until(lambda: r.get('a', f'/sessions/{b}').get('active'), 40)

    # ---------------------------------------------------------------- step 4
    with r.Step(4, 'Messages within the approval window deliver and wallet updates live') as s:
        r.ui('click', text='Wallet', role='tab', exact=True)
        before = r.text('[data-balance]')
        r.ui('click', selector=track(b))
        for i in range(3):
            msg = f'UI-E2E approved message #{i + 1} {int(time.time())}'
            s.check(f'message {i + 1}: no new owner prompt', not r.ui_try('exists', selector='[data-approval="pending"]'))
            n = out_count()
            send_message(msg)
            s.check(f'message {i + 1}: appears in the thread', r.wait_until(lambda: out_count() > n, 20))
            s.check(f'message {i + 1}: B received it', b_has(msg))
        s.check('receipts show delivered', r.wait_until(lambda: sum(1 for d in r.ui('attrs', selector='span.delivery', names=['data-delivery']) if d['data-delivery'] == 'delivered') >= 4, 20))
        s.check('wallet balance updates without reload', r.wait_until(lambda: r.text('[data-balance]') != before, 30), {'before': before, 'after': r.text('[data-balance]')})
        s.snap('messages-wallet')

    # ---------------------------------------------------------------- step 5
    with r.Step(5, 'Pay and request, file send, room with A+B') as s:
        r.ui('click', selector=track(b))
        # Request: no spend authority needed.
        r.ui('click', selector='[data-composer-mode="request"]')
        r.ui('fill', selector='input[data-request-amount]', value='5')
        r.ui_try('fill', selector='input[data-request-note]', value='UI-E2E request')
        r.ui('click', text='Create invoice', role='button')
        bolt = r.ui_try('wait', selector='[data-artifact="invoice"] code[data-bolt11]', timeoutMs=20000)
        s.snap('request-invoice')
        s.check('request: invoice + QR created on node A', bolt and r.ui_try('exists', selector='svg.qr[aria-label="Invoice as a QR code"]'))
        before_pay = app_tally()
        # Pay: B's owner hands A an invoice (made on B for this test).
        inv = r.api('b', 'POST', '/payments/invoice', {'amount_msat': 3000, 'description': 'UI-E2E pay'}, expect=200)[1]
        bolt11 = inv.get('bolt11') or inv.get('payment_request') or inv.get('invoice')
        r.ui('click', selector='[data-composer-mode="pay"]')
        r.ui_try('click', text='Invoice', role='tab')
        r.ui('fill', selector='textarea[data-pay-invoice]', value=bolt11)
        time.sleep(1)
        label = r.text('[data-send]')
        s.snap('pay-before')
        if 'Approve' in label:
            window(s, 'pay', 'Pay')
        r.ui('click', selector='[data-send]', timeoutMs=20000)
        paid = r.ui_try('wait', selector='[data-artifact="payment"]', timeoutMs=30000)
        s.snap('pay-result')
        status = r.ui('attrs', selector='[data-artifact="payment"]', names=['data-status']) if paid else None
        settled_b = r.wait_until(lambda: any(p.get('payment_hash') == inv.get('payment_hash') and str(p.get('status')).lower() == 'settled'
                                             for p in r.get('b', '/payments')), 20)
        s.check('pay: B\'s invoice settled', settled_b, status)
        s.check('payment scope and fee warning are visible', 'Routing fees are outside' in r.text('[data-budget-payment]'))
        s.check('app invoice payment counts 3 sats in the shared daily book', r.wait_until(lambda: app_tally() == before_pay + 3, 15))
        s.check('budget scope lists exclusions and finite G1 grant', 'does not refill daily' in r.text('[data-budget-scope]'))
        s.snap('budget-scope-copy')
        before_file = app_tally()
        # File send.
        r.ui('click', selector='[data-composer-mode="file"]')
        payload = b'UI-E2E throwaway file bytes\n'
        r.ui('attach', selector='input[data-file-input]', filename='ui-e2e.txt', mime='text/plain',
             data_b64=base64.b64encode(payload).decode())
        r.ui('wait', text='Send file', selector='[data-send]', timeoutMs=20000)
        s.snap('file-before')
        if 'Approve' in r.text('[data-send]'):
            window(s, 'file', 'Send file')
        r.ui('click', selector='[data-send]', timeoutMs=20000)
        filed = r.ui_try('wait', selector='[data-artifact="file"]', timeoutMs=30000)
        s.snap('file-result')
        got = r.wait_until(lambda: [f for f in r.get('b', '/files') if f.get('filename') == 'ui-e2e.txt'], 30)
        same = False
        if got:
            data = r.get('b', '/files/' + got[0]['id'])
            same = base64.b64decode(data['data_b64']) == payload
        s.check('file: B received identical bytes', filed and same, r.text('[data-artifact="file"]') if filed else r.text()[:400])
        s.check('file counts 3 sats against the shared daily book', r.wait_until(lambda: app_tally() == before_file + 3, 15))
        row = f'[data-budget-row="{b}"]'
        original_limit = r.text(row + ' [data-row-tally]').split('/')[1].split('sats')[0].strip()
        r.ui('click', selector=row + ' [data-budget-edit]')
        r.ui('fill', selector=row + ' [data-budget-input]', value='1')
        r.ui('click', selector=row + ' [data-budget-save]')
        r.ui('wait', selector=row + ' [data-budget-edit]')
        r.ui('attach', selector='input[data-file-input]', filename='budget-refused.txt', mime='text/plain',
             data_b64=base64.b64encode(payload).decode())
        r.ui('click', selector='[data-send]')
        refused = r.ui_try('wait', selector='[data-composer-note]', text='Raise the budget', timeoutMs=10000)
        s.check('file refused by app contact budget', refused, r.ui_try('text', within={'selector': '[data-composer-note]'}))
        s.check('refused file never reached B', not any(f.get('filename') == 'budget-refused.txt' for f in r.get('b', '/files')))
        s.check('refusal leaves shared tally unchanged', app_tally() == before_file + 3)
        s.snap('file-budget-refused')
        r.ui('click', selector=row + ' [data-budget-edit]')
        r.ui('fill', selector=row + ' [data-budget-input]', value=original_limit)
        r.ui('click', selector=row + ' [data-budget-save]')
        # Room: the app has no screen to create rooms or add members, so the
        # owner creates it on node A (admin), then uses it from the app.
        room = r.api('a', 'POST', '/rooms', {'name': 'UI-E2E A+B'}, expect=200)[1]['id']
        for member in (a, b):
            r.api('a', 'POST', f'/rooms/{room}/members', {'node_id': member}, expect=200)
        s.note(f'room {room} created on node A by the owner (no app UI for rooms)')
        opened = r.ui_try('click', selector=f'[data-track="room:{room}"]', timeoutMs=30000)
        s.check('room appears in the rail without a restart', opened)
        if opened:
            s.snap('room-open')
            msg = f'UI-E2E room A+B {int(time.time())}'
            send_message(msg)
            time.sleep(1)
            note = r.ui_try('text', within={'selector': '[data-composer-note]'})
            s.check('room: B received the room message', b_has(msg, room=room, seconds=30), note)
            s.snap('room-result')

    # ---------------------------------------------------------------- step 4b
    with r.Step('4b', 'A pause in the conversation: send again after 50 s idle') as s:
        # An evening conversation has pauses. Stay idle past the transport's 30 s
        # keepalive/read timeout, then send again from the UI.
        r.ui('click', selector=track(b))
        flaps_before = r.logs['app'].read_text(errors='replace').count('peer disconnected, will reconnect')
        time.sleep(50)
        flaps = r.logs['app'].read_text(errors='replace').count('peer disconnected, will reconnect') - flaps_before
        s.note(f'A→B transport reconnects during 50 s idle: {flaps}')
        msg = f'UI-E2E after a pause {int(time.time())}'
        send_message(msg)
        ok = b_has(msg, seconds=45)
        failed = r.ui_try('text', within={'selector': '[data-artifact="failed"]', 'nth': -1})
        s.snap('after-idle')
        s.check('after 50 s idle: the next message still reaches B', ok, failed or r.text('[data-composer]')[:300])
        if not ok:
            r.bug('Message after idle did not reach B',
                  f'{flaps} reconnect(s) during the pause; visible failure: {failed!r}',
                  'UI send / node transport; inspect the sanitized node logs')
            if r.ui_try('exists', selector='[data-spend-reconcile], [data-reconcile]'):
                r.ui_try('click', selector='[data-spend-reconcile], [data-reconcile]')
                time.sleep(2)

    # ---------------------------------------------------------------- step 6
    with r.Step(6, 'Spending lock and a price rise above the displayed ceiling refuse payment') as s:
        r.ui('click', selector=track(b))
        # Pay/file still use the ten-minute window; messages use the daily budget.
        r.ui('click', selector='[data-composer-mode="pay"]')
        r.ui('click', selector='[data-spend-lock]')
        s.need('lock closes the spending window', r.ui_try('wait', selector='[data-spend="locked"]'))
        s.check('locked send offers approval', 'Approve' in r.text('[data-send]'))
        r.ui('click', selector='[data-send]')
        if r.ui_try('exists', selector='[data-owner-action]'):
            _, op = owner_op()
            r.owner_grant(op, '--budget', '100', '--for', '10m')
        s.need('approval window reopened', r.ui_try('wait', selector='[data-spend="open"]', timeoutMs=20000))
        r.ui('click', selector='[data-composer-mode="message"]')
        shown = r.ui('attrs', selector='[data-cost-msat]', names=['data-cost-msat'])
        s.note(f'composer price before B raises it: {shown}')
        r.restart_b(5000)
        r.api('b', 'POST', '/peers', {'node_id': a, 'addr': f'127.0.0.1:{r.ports["a"][1]}', 'label': 'A'}, expect=200)
        s.need('nodes reconnect after the price change', r.wait_until(lambda: b in r.get('a', '/peers/connected'), 60))
        balance = r.get('a', '/payments/balance')
        msg = f'UI-E2E over cap {int(time.time())}'
        send_message(msg)
        failed = r.ui_try('wait', selector='[data-door="out-refused"]', timeoutMs=60000)
        s.snap('over-cap')
        s.check('price rise produces a visible cap refusal', failed and 'their price is above your cap' in r.text('[data-door="out-refused"]'), r.text('[data-stream]')[-600:])
        s.check('over-cap: nothing paid', r.get('a', '/payments/balance') == balance)
        s.check('over-cap: B did not receive it', not b_has(msg, seconds=3))

    # ---------------------------------------------------------------- step 7
    with r.Step(7, 'Ask your node: "what did I spend today" answers from real node data with freshness') as s:
        r.ui('click', selector='[data-track="ai"]')
        r.ui('fill', selector='textarea[data-ai-input]', value='what did I spend today')
        r.ui('click', selector='button[data-ai-ask]')
        answer = r.ui_try('wait', selector='[data-ai-answer]', timeoutMs=30000)
        time.sleep(1)
        s.snap('ask')
        body = r.text('[data-ai-answer]') if answer else ''
        s.need('an answer appears', body, r.text()[-400:])
        s.check('answered (not no-read / error)', r.ui_try('exists', selector='[data-ai-answer="answered"]'), body)
        source = r.ui_try('text', within={'selector': '[data-ai-source]'})
        fresh = r.ui_try('text', within={'selector': '[data-ai-fresh]'})
        s.check('names its source (node, read broker, routes)', source and 'From your node' in source, source)
        s.check('shows freshness', fresh and ('Updated' in fresh or 'Stale' in fresh), fresh)
        # Node truth: what A paid today in paid messages to peers.
        since_ms = int(datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        msgs = r.get('a', f'/messages?peer={b}&limit=500')
        spent_msat = sum(int(m.get('amount_msat') or m.get('payment_amount_msat') or 0) for m in msgs
                         if m.get('sender') == a and int(m.get('timestamp') or 0) >= since_ms)
        m = re.search(r'spent ([\d,]+) sats', body)
        s.note(f'answer: {body[:300]!r}; node A outgoing to B today: {spent_msat} msat over {len(msgs)} rows')
        s.check('answer total matches node A\'s own records (sats)', m and int(m.group(1).replace(',', '')) == spent_msat // 1000,
                {'answer': m.group(1) if m else None, 'node_msat': spent_msat})
