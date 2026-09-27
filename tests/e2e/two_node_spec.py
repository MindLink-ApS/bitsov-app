"""UI-E2E spec: the owner's evening, through the real app window, no money.

Run by scripts/ui-e2e-two-node.sh (see scripts/ui-e2e/runner.py for the
plumbing: `r.ui(...)` drives the real window through tests/e2e/driver.js,
`r.api(...)` reads a node with an operator fixture token for evidence only).

Every UI action is a click or keystroke the owner could make. Node-side calls
are limited to (1) evidence reads, (2) what the owner types at node A's
terminal (`konsensus grant`), and (3) owner setup the app has no screen for
(creating a room), each labelled where it happens.
"""
import base64
import re
import time

B_TEXTS = []  # plaintexts A sent to B, for the receipt checks


def run(r):
    a, b = r.ids['a'], r.ids['b']
    state = {'op_budget': None}

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
        asked = r.wait_until(lambda: r.ui_try('exists', selector='[data-owner-action]') or ready in r.text('[data-send]'), 20)
        if r.ui_try('exists', selector='[data-owner-action]'):
            cmd, op = owner_op()
            s.snap(f'{what}-waiting')
            out = r.owner_grant(op, '--for', '10m')
            s.note(f'{what}: owner granted the 10-minute window at node A: ' + ' '.join(out.split())[-160:])
        else:
            s.note(f'{what}: "Approve spending" opened the 10-minute window with no owner step at the node '
                   f'(the live G1 budget grant was reused): {r.ui_try("text", within={"selector": "[data-composer]"})!r}'[:400])
        s.check(f'{what}: spending window open', r.wait_until(lambda: ready in r.text('[data-send]'), 20), r.text('[data-send]'))

    def out_count():
        return len(r.ui('attrs', selector='article.msg.out', names=['data-message']))

    def tally():
        r.ui('click', selector='button[role=tab][data-tab="budget"]')
        return r.ui_try('text', within={'selector': '[data-tally-total]'})

    # ---------------------------------------------------------------- step 1
    with r.Step(1, 'First run: node starts, pairs, identity gate, funding QR (mock)') as s:
        s.need('app started node A from the dev path', r.ui_try('wait', selector='[data-pairing]', timeoutMs=90000))
        paired = r.ui_try('wait', selector='[data-pairing="paired"]', timeoutMs=60000)
        s.snap('pairing')
        s.need('pairing view says "This app is paired"', paired and 'This app is paired' in r.text('[data-pairing="paired"]'),
               r.text())
        code = r.text('[data-short-code]')
        printed = re.findall(r'bitsov pairing code for "[^"]+": (\S+)', r.logs['app'].read_text(errors='replace'))
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
        r.ui('click', selector='button[role=tab][data-tab="wallet"]', timeoutMs=20000)
        if r.ui_try('exists', text='Get a deposit address', role='button'):
            r.ui('click', text='Get a deposit address', role='button')
        qr = r.ui_try('wait', selector='svg.qr[aria-label="Deposit address as a QR code"]', timeoutMs=20000)
        s.snap('funding-qr')
        status, mock_addr = r.api('a', 'GET', '/payments/funding-address')
        shown = r.ui_try('text', within={'selector': '[data-panel="receive"]'}) or r.text()[:300]
        if not qr and status != 200:
            explained = r.ui_try('text', within={'selector': '[data-deposit-error]'})
            s.check("deposit panel shows the node's reason for no address", explained, shown[:200])
            s.check('funding QR shown', False,
                    f'node A answers /payments/funding-address with HTTP {status}: {mock_addr}. The mock Lightning '
                    f'backend has no deposit address (LDK only). The app shows: {shown[:200]!r}')
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
    with r.Step(2, 'Owner sets a budget (G1 grant via the node CLI on node A\'s terminal)') as s:
        connected = r.wait_until(lambda: b in r.get('a', '/peers/connected'), 60)
        s.need('node A connected to node B (loopback)', connected)
        r.ui('click', selector=track(b), timeoutMs=30000)
        r.ui('wait', selector='[data-budget-setup]', timeoutMs=20000)
        s.snap('budget-setup')
        r.ui('click', selector='[data-preset="everyday"]')
        r.ui('click', selector='[data-send]')
        cmd, op = owner_op()
        s.snap('budget-waiting')
        s.need('app shows the owner command to type at the node', op, cmd)
        s.check('send is held while waiting', 'Waiting for approval' in r.text('[data-send]'))
        out = r.owner_grant(op)
        s.check('owner grant accepted (proposal: 2,000 sats, 24 h)', 'sats' in out, out[-300:])
        s.note('konsensus grant output: ' + ' '.join(out.split())[-300:])
        # B is not in the book yet, so an open approval shows the first-contact ask.
        opened = r.ui_try('wait', selector='[data-budget-line], [data-first-contact]', timeoutMs=20000)
        s.snap('budget-open')
        s.need('budget approval opens in the app after the grant', opened, r.text('[data-composer]')[:400])
        r.ui('click', selector='button[role=tab][data-tab="budget"]')
        grant_line = r.ui_try('text', within={'selector': '[data-node-grant]'})
        s.snap('budget-panel')
        s.check('Budget panel shows the node grant', grant_line and 'Your node allows' in grant_line, grant_line)
        status = r.run('sandbox-exec', '-f', str(r.SANDBOX), r.BIN, 'pair-status', '--config', str(r.ROOTS['a'] / 'konsensus.toml'))
        s.check('node lists the live spend grant', 'SPEND GRANT' in status, status[-300:])

    # ---------------------------------------------------------------- step 3
    with r.Step(3, 'First contact to node B (stranger, price_open): door card, send under cap, admitted, B receives') as s:
        r.ui('click', selector=track(b))
        first = r.ui_try('wait', selector='[data-first-contact]', timeoutMs=20000)
        s.check('first paid message asks once', first, r.text('[data-composer]') if not first else None)
        # The door card: B's own signed quote, read before anything is paid.
        door = r.ui_try('wait', selector='[data-door-quote]', timeoutMs=30000)
        quoted = r.ui('attrs', selector='[data-door-quote]', names=['data-door-quote']) if door else []
        total = int(quoted[0]['data-door-quote']) if quoted else None
        cost = r.ui_try('text', within={'selector': '[data-cost]'}) or ''
        s.snap('first-contact-door')
        b_price = r.get('b', '/pricing')['prices']['communication']
        s.note(f"door card: {quoted[0]['text'] if quoted else None!r}; B's own chat price {b_price} msat")
        s.check("door card shows B's own signed quote before paying", total is not None and total >= b_price, quoted)
        if not s.check("composer shows B's quote, not an estimate from A's own price", 'own quote' in cost and 'Estimate' not in cost, cost):
            r.bug("The door never shows the stranger's own price",
                  f"Composer: {cost!r}. No stranger quote reached the app before paying.",
                  'genome first-contact quote / app door card')
        balance_before = r.get('a', '/payments/balance')['balance_msat']
        before_b = r.get('b', '/payments')
        r.ui('click', selector='[data-first-budget]')  # the owner's one confirmation, with B's budget
        text = f'UI-E2E first contact {int(time.time())}'
        send_message(text)
        delivered = r.ui_try('wait', selector='article.msg.out [data-delivery="delivered"]', timeoutMs=60000)
        note = r.ui_try('text', within={'selector': '[data-composer-note]'})
        s.snap('first-contact-result')
        received = b_has(text, seconds=5 if note else 30)
        s.check('sent from the app with one owner OK (no CLI, no owner key)', received, note or r.text()[:500])
        s.check('B received the first-contact message', received, note)
        paid = balance_before - r.get('a', '/payments/balance')['balance_msat']
        s.check('A paid at most the confirmed cap (admission + message)', total is not None and 0 < paid <= total,
                {'paid_msat': paid, 'cap_msat': total})
        paid_in = [p for p in r.get('b', '/payments') if p not in before_b and str(p.get('direction', '')).lower() == 'incoming'
                   and str(p.get('status', '')).lower() == 'settled']
        s.check('B recorded settled incoming payments (admission + message)', total is not None and sum(p['amount_msat'] for p in paid_in) == paid,
                paid_in)
        membrane_b = r.read('b', '/membrane?limit=50')
        admitted = [e for e in (membrane_b.get('events', membrane_b) if isinstance(membrane_b, dict) else membrane_b)
                    if e.get('verdict') == 'admitted']
        s.check("B's membrane (N2) logged the admission by settlement", admitted, membrane_b)
        status = r.run('sandbox-exec', '-f', str(r.SANDBOX), r.BIN, 'pair-status', '--config', str(r.ROOTS['a'] / 'konsensus.toml'))
        s.note('node grant after first contact: ' + ' '.join(l for l in status.splitlines() if 'SPEND GRANT' in l)[:200])
        if not received:
            r.bug('First contact from the app did not complete', f'App note: {note!r}', 'genome #85 / app #45')
            # Keep the run going for steps 4–7: the owner's key opens the door
            # once, capped (as PR #46 does). Labelled; this is not the UI path.
            reply = r.api('a', 'POST', '/messages/compose', {'recipient': b, 'is_room': False, 'kind': 0,
                                                             'plaintext': text + ' (owner key)', 'max_total_msat': 4000})
            s.note(f'WORKAROUND (not the UI): owner-key first contact → HTTP {reply[0]} {str(reply[1])[:200]}')
        r.wait_until(lambda: r.get('a', f'/sessions/{b}').get('active'), 40)

    # ---------------------------------------------------------------- step 4
    with r.Step(4, 'Messages inside the budget send without prompts; tally and Body tab update live') as s:
        r.ui('click', selector=track(b))
        r.ui('click', selector='button[role=tab][data-tab="body"]')
        energy_before = r.ui_try('text', within={'selector': '[data-energy="out-24h"]'})
        tally_before = tally()
        r.ui('click', selector='button[role=tab][data-tab="body"]')
        s.snap('body-before')
        sent = []
        for i in range(3):
            msg = f'UI-E2E inside budget #{i + 1} {int(time.time())}'
            prompts = r.ui_try('exists', selector='[data-first-contact], [data-approval="pending"], [data-budget-setup]')
            s.check(f'message {i + 1}: no prompt before send', not prompts, r.text('[data-composer]'))
            n = out_count()
            send_message(msg)
            ok = r.wait_until(lambda: out_count() > n, 20)
            s.check(f'message {i + 1}: appears in the thread', ok)
            s.check(f'message {i + 1}: B received it', b_has(msg))
            sent.append(msg)
        delivered = r.ui('attrs', selector='span.delivery', names=['data-delivery'])
        s.check('receipts show delivered', sum(1 for d in delivered if d['data-delivery'] == 'delivered') >= 3, delivered)
        s.snap('thread-after')
        live = r.wait_until(lambda: (r.ui_try('text', within={'selector': '[data-energy="out-24h"]'}) or '') != (energy_before or ''), 20)
        energy_after = r.ui_try('text', within={'selector': '[data-energy="out-24h"]'})
        s.check('Body metabolism (N1) out/24h moved without a reload', live, {'before': energy_before, 'after': energy_after})
        try:  # evidence only; node A's pairing is closed once the app paired
            s.note(f"node A /energy?window=24h: {str(r.read('a', '/energy?window=24h'))[:300]}")
        except Exception as error:
            s.note(f'node A /energy not read by the runner ({error}); the Body tab above is the check')
        s.check('Body metabolism reads N1 (node-wide source line)', 'N1' in (r.text('[data-organ="metabolism"]') or ''),
                r.text('[data-organ="metabolism"]')[:300])
        membrane = r.text('[data-organ="membrane"]')
        s.check('Body membrane shows N2 data (no "N2 unavailable" gap)', not r.ui_try('exists', selector='[data-membrane-n2]'), membrane[:300])
        s.snap('body-after')
        tally_after = tally()
        s.snap('budget-tally')
        s.check('budget tally moved', tally_after and tally_after != tally_before, {'before': tally_before, 'after': tally_after})

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
            if r.ui_try('exists', selector='[data-first-contact]'):
                r.ui('click', selector='[data-first-budget]')
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
            r.bug('A paid conversation breaks after ~30 s idle',
                  f'After {flaps} reconnect(s) during a 50 s pause, the next UI send failed: {failed!r}. B drops the idle '
                  'connection (transport READ_TIMEOUT 30 s == KEEPALIVE_INTERVAL 30 s), A reconnects UNPRIVILEGED because '
                  'promote-on-paid is per connection, and B silently drops non-admission invoice requests from '
                  'unprivileged peers. A still has an E2EE session so it never re-pays admission: every send times out '
                  'after 30 s as "outcome unknown", and the app then blocks all spending until reconciled.',
                  'genome konsensus-message transport + session_handler (main, not the PRs)')
            if r.ui_try('exists', selector='[data-spend-reconcile], [data-reconcile]'):
                r.ui_try('click', selector='[data-spend-reconcile], [data-reconcile]')
                time.sleep(2)

    # ---------------------------------------------------------------- step 6
    with r.Step(6, 'Over-cap and budget-exhausted refusals shown correctly') as s:
        r.ui('click', selector=track(b))
        r.ui('click', selector='[data-composer-mode="message"]')
        # (a) Budget exhausted: the owner lowers B's budget to what is already used.
        r.ui('click', selector='button[role=tab][data-tab="budget"]')
        row = r.ui('attrs', selector=f'[data-budget-row]', names=['data-budget-row'])
        s.note(f'budget rows: {row}')
        used = re.search(r'([\d,]+)\s*/', row[0]['text']) if row else None
        r.ui('click', selector='[data-budget-edit]')
        r.ui('fill', selector='[data-budget-input]', value=used.group(1).replace(',', '') if used else '1')
        r.ui('click', selector='[data-budget-save]')
        time.sleep(1.5)
        stop = r.ui_try('wait', selector='[data-budget-used]', timeoutMs=10000)
        s.snap('budget-exhausted')
        stop_text = r.ui_try('text', within={'selector': '[data-composer]'})
        s.check('budget exhausted: composer stops before paying and offers a raise',
                stop and ('used up' in stop_text), stop_text)
        s.check('budget exhausted: send is not offered', 'Budget used up' in r.text('[data-send]') or r.ui_try('exists', selector='[data-budget-raise]'),
                r.text('[data-send]'))
        balance = r.get('a', '/payments/balance')
        # Raise it back within the daily total (no new approval needed).
        if r.ui_try('exists', selector='[data-budget-raise]'):
            r.ui('click', selector='[data-budget-raise]')
            time.sleep(1)
            s.snap('budget-raised')
            s.check('raise within the daily total needs no new approval', not r.ui_try('exists', selector='[data-approval="pending"]'),
                    r.text('[data-composer]'))
        # (b) Over cap: B's owner raises B's price after A's composer quoted it.
        shown = r.ui('attrs', selector='[data-cost] [data-cost-msat]', names=['data-cost-msat'])
        s.note(f'composer price before B raises it: {shown}')
        r.restart_b(3000)
        # So B answers A's invoice requests after the restart (see the idle
        # finding in step 4), B's owner adds A as a known peer.
        r.api('b', 'POST', '/peers', {'node_id': a, 'addr': f'127.0.0.1:{r.ports["a"][1]}', 'label': 'A'})
        r.wait_until(lambda: b in r.get('a', '/peers/connected'), 60)
        r.wait_until(lambda: 'privileged=true' in r.logs['node-b'].read_text(errors='replace').split('API server listening')[-1], 45)
        if r.ui_try('exists', selector='[data-spend-reconcile], [data-reconcile]'):
            r.ui_try('click', selector='[data-spend-reconcile], [data-reconcile]')
            time.sleep(2)
        balance = r.get('a', '/payments/balance')
        msg = f'UI-E2E over cap {int(time.time())}'
        n = out_count()
        send_message(msg)
        card = r.ui_try('wait', selector='[data-door="out-refused"], [data-composer-note], [data-artifact="failed"]', timeoutMs=60000)
        time.sleep(1)
        s.snap('over-cap')
        what = {k: r.ui_try('text', within={'selector': k, 'nth': -1}) for k in ('[data-door="out-refused"]', '[data-composer-note]', '[data-artifact="failed"]')}
        s.check('over-cap: door card "Not sent · their price is above your cap"',
                what['[data-door="out-refused"]'] and 'above your cap' in what['[data-door="out-refused"]'], what)
        s.check('over-cap: nothing paid', r.get('a', '/payments/balance') == balance)
        s.check('over-cap: B did not receive it', not b_has(msg, seconds=3))
        s.check('over-cap: the composer tells the owner what happened', any(what.values()),
                {'composer': r.text('[data-composer]')[:300], 'thread_grew': out_count() > n})
        r.ui('click', selector='button[role=tab][data-tab="body"]')
        refused = r.ui_try('text', within={'selector': '[data-membrane-refused-by]'})
        s.snap('over-cap-body')
        s.check('Body membrane counts the outbound price refusal', refused and 'price' in refused, refused)

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
        since = int(time.time()) - int(time.time()) % 86400
        msgs = r.get('a', f'/messages?peer={b}&limit=500')
        spent_msat = sum(int(m.get('amount_msat') or m.get('payment_amount_msat') or 0) for m in msgs
                         if str(m.get('direction', 'outgoing')).lower().startswith('out'))
        m = re.search(r'spent ([\d,]+) sats', body)
        s.note(f'answer: {body[:300]!r}; node A outgoing to B today: {spent_msat} msat over {len(msgs)} rows')
        s.check('answer total matches node A\'s own records (sats)', m and int(m.group(1).replace(',', '')) == spent_msat // 1000,
                {'answer': m.group(1) if m else None, 'node_msat': spent_msat})

