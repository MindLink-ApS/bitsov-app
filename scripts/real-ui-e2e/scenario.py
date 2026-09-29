"""Ticket checks driven by the injected driver inside the actual Tauri window."""
import hashlib
from decimal import Decimal
import json
import re
import time


def run(r, fixture, capacities):
    from evidence import install
    install(r)
    a, b = r.ids['a'], r.ids['b']
    track = f'[data-track="peer:{b.lower()}"]'
    before = capacities()
    baseline = {n: {p['payment_hash'] for p in r.get(n, '/payments')} for n in ('a','b')}
    last = time.monotonic()
    original_exit = r.Step.__exit__

    def timed_exit(self, kind, error, tb):
        nonlocal last
        self.row['seconds'] = round(time.monotonic()-last, 3)
        last = time.monotonic()
        return original_exit(self, kind, error, tb)
    r.Step.__exit__ = timed_exit

    def received(n, plaintext):
        return r.wait_until(lambda: any(m.get('plaintext') == plaintext for m in r.get(n, '/messages?limit=200')), 60)

    def send(plaintext):
        r.ui('fill', selector='[data-composer] textarea', value=plaintext)
        r.ui('click', selector='[data-send]')

    def owner_window(s):
        r.ui('wait', selector='[data-owner-action]', timeoutMs=20000)
        command = r.text('[data-owner-action]')
        match = re.search(r'konsensus grant --op (\S+)', command)
        s.need('owner grant command displayed', match, command)
        r.owner_grant(match.group(1), '--budget', '100', '--for', '10m')

    with r.Step(1, 'Real window, regtest pairing and stranger card') as s:
        s.need('real WKWebView driver attached', r.ui('ping'))
        s.need('paired', r.ui_try('wait', selector='[data-pairing="paired"]', timeoutMs=60000))
        s.snap('paired')
        r.ui('click', text='I understand — continue to funding', role='button', timeoutMs=60000)
        r.ui('click', selector=track, timeoutMs=30000)
        s.snap('stranger-card')
        status, session = r.api('a','GET',f'/sessions/{b}')
        s.check('B has not admitted A', status==404 or (status==200 and not session.get('active')),session)
        s.check('both nodes report real LDK', all(r.get(n,'/status').get('lightning_node_pubkey') for n in ('a','b')))

    with r.Step(2, 'Owner CLI approves first contact') as s:
        r.ui('click', selector='[data-send]')
        owner_window(s)
        r.ui('wait', selector='[data-budget="first"]', timeoutMs=20000)
        r.ui('wait', selector='[data-door-quote]', timeoutMs=20000)
        total = int(r.ui('attrs',selector='[data-cost-msat]',names=['data-cost-msat'])[0]['data-cost-msat'])
        s.need('all-in quote is 14002 msat', total == 14002, total)
        r.ui('click', selector='[data-first-budget="100000"]')
        first = f'REAL-UI-E2E first contact {time.time_ns()}'
        send(first)
        r.ui('wait',selector='[data-contact-approval="pending"]',timeoutMs=20000)
        request = json.loads(r.ui('attrs',selector='[data-contact-approval]',names=['data-contact-request'])[0]['data-contact-request'])
        s.need('approval binds peer, cap, client and grant', request['recipient']==b and request['max_total_msat']==14002 and request['client_id'] and request['grant_op_id'],request)
        command = r.ui('attrs',selector='[data-contact-owner-command]',names=['data-command'])[0]['data-command']
        s.need('approval uses konsensus CLI', 'konsensus' in command and 'first-contact' in command, command)
        s.snap('owner-first-contact-pending')
        r.owner_first_contact(command)

    with r.Step(3, 'First contact delivered with real admission and message payments') as s:
        s.need('B decrypts first contact', received('b',first))
        r.ui('wait', selector='article.msg.out [data-delivery="delivered"]', timeoutMs=60000)
        s.snap('first-contact-delivered')
        delta = before['a']-capacities()['a']
        s.check('A paid 2×2001 principal plus 2×1000 fees', delta==6002,delta)

    with r.Step(4, 'Paid follow-up delivered') as s:
        followup = f'REAL-UI-E2E paid follow-up {time.time_ns()}'
        send(followup)
        s.need('B decrypts paid follow-up',received('b',followup))
        s.check('no new owner prompt',not r.ui_try('exists',selector='[data-contact-approval="pending"]'))
        s.snap('paid-message')

    with r.Step(5, 'Paid reply from a listed peer') as s:
        # B has no second app window. Its owner sends through the real API;
        # receipt and plaintext are checked in A's real window.
        r.api('a','POST','/peers',{'node_id':b,'addr':f"127.0.0.1:{r.ports['b'][1]}",'auto_connect':False},expect=200)
        reply = f'REAL-UI-E2E listed peer reply {time.time_ns()}'
        r.api('b','POST','/messages/compose',{'recipient':a,'kind':0,'plaintext':reply},expect=200)
        s.need('A decrypts reply',received('a',reply))
        s.need('reply is visible in real window',r.ui_try('wait',text=reply,timeoutMs=30000))
        s.snap('listed-peer-reply')

    with r.Step(6, 'UI refuses route above its fee cap without payment') as s:
        fixture('fee',base_msat=6000)
        def expensive_invoice():
            inv=r.api('b','POST','/payments/invoice',{'amount_msat':2001,'description':'regtest over-cap UI refusal'},expect=200)[1]
            return inv if fixture('invoice_policy',bolt11=inv['bolt11'])['fees']==[6000] else None
        inv=r.wait_until(expensive_invoice,60,1)
        s.need('B invoice advertises C fee 6000 msat',inv)
        cap_before=capacities()
        r.ui('click',selector='[data-composer-mode="pay"]')
        r.ui_try('click',text='Invoice',role='tab')
        r.ui('fill',selector='textarea[data-pay-invoice]',value=inv['bolt11'])
        r.ui('wait',text='up to 5 sats network fee',timeoutMs=20000)
        s.snap('over-cap-before')
        pay_ready=r.text('[data-send]').strip().startswith('Pay')
        r.ui('click',selector='[data-send]')
        if not pay_ready:
            if r.wait_until(lambda:r.ui_try('exists',selector='[data-owner-action]'),3):
                owner_window(s)
            s.need('payment window ready',r.wait_until(lambda:r.text('[data-send]').strip().startswith('Pay'),10))
            r.ui('click',selector='[data-send]')
        s.need('UI explicitly reports payment not dispatched',r.ui_try('wait',selector='[data-artifact="failed"][data-code="not_dispatched"]',timeoutMs=45000))
        s.check('UI says nothing was paid','Not sent - nothing was paid.' in r.text('[data-artifact="failed"][data-code="not_dispatched"]'))
        s.snap('over-cap-refused')
        failed=[p for p in r.get('a','/payments') if p['payment_hash']==inv['payment_hash']]
        s.check('payer failed pre-dispatch',len(failed)==1 and failed[0]['status']=='failed',failed)
        s.check('B invoice remains pending',r.get('b',f"/payments/{inv['payment_hash']}")['status'].lower()=='pending')
        s.check('all three capacities unchanged',capacities()==cap_before,capacities())
        s.check('confirmed pre-dispatch refusal does not retain an unknown-spend UI lock',
                not r.ui_try('exists',selector='[data-artifact="failed"][data-code="spend_unknown"]'))
        fixture('fee',base_msat=1000)

    with r.Step(7, 'Body refusal counts match the real node') as s:
        r.ui('click',selector='[data-tab="body"]')
        r.ui('wait',selector='[data-panel="body"]')
        r.ui('wait',selector='[data-pre-payment-refusals]',timeoutMs=20000)
        counts=r.read('a','/membrane?limit=50')['pre_payment_refusals']
        rows=r.ui('attrs',selector='[data-refusal-reason]',names=['data-refusal-reason'])
        s.need('eight refusal reasons visible',len(rows)==8,rows)
        for row in rows:
            reason=row['data-refusal-reason']
            day=sum(bk['counts'].get(reason,0) for bk in counts['buckets'])
            hour=sum(bk['counts'].get(reason,0) for bk in counts['buckets'] if bk['start_ms']==counts['effective_hour_start_ms'])
            selector=f'[data-refusal-reason="{reason}"]'
            s.check(reason,r.text(selector+' [data-refusals-hour]').replace(',','')==str(hour) and r.text(selector+' [data-refusals-day]').replace(',','')==str(day),{'hour':hour,'day':day})
        s.snap('body-refusal-counts')

    with r.Step(8, 'Readiness pill and Body agree with live status') as s:
        status=r.get('a','/status')
        s.need('node money_ready',status.get('money_ready'),status)
        s.check('Body says Money ready','Money ready' in r.text('[data-readiness]'))
        s.check('readiness pill says Local OK / Money ready',r.wait_until(lambda:r.text('[data-pill] .what')=='Local OK · Money ready',20),r.text('[data-pill]'))
        s.check('no money-not-ready banner',not r.ui_try('exists',selector='[data-money-notice]'))
        s.snap('readiness')

    with r.Step(9, 'Exact msat reconciliation and settlement proofs') as s:
        after=capacities()
        expected={'a':before['a']-3*3001+2001,'b':before['b']+3*2001-3001,'c':before['c']+4000}
        s.check('all channel capacities reconcile to the msat',after==expected,{'before':before,'after':after,'expected':expected})
        records={n:[p for p in r.get(n,'/payments') if p['payment_hash'] and p['payment_hash'] not in baseline[n] and p['status']=='settled'] for n in ('a','b')}
        for n in ('a','b'):
            outgoing=[p for p in records[n] if p['direction']=='outgoing']
            s.check(f'{n}: settled outgoing count',len(outgoing)==(3 if n=='a' else 1),outgoing)
            for p in records[n]:
                s.check(f'{n}: principal and preimage {p["payment_hash"][:12]}',p['amount_msat']==2001 and bool(p['preimage']) and hashlib.sha256(bytes.fromhex(p['preimage'])).hexdigest()==p['payment_hash'])
            s.check(f'{n}: real 1000-msat forwarding fees',all(p['fee_msat']==1000 for p in outgoing),outgoing)
        r.evidence.write('reconciliation.json',{'before':before,'after':after,'expected':expected,'payments':records})
        grant=r.run(r.BIN,'pair-status','--config',str(r.ROOTS['a']/'konsensus.toml'))
        amounts=re.search(r'SPEND GRANT client=\S+\s+([\d.]+) of ([\d.]+) sats left',grant)
        used=int((Decimal(amounts[2])-Decimal(amounts[1]))*1000) if amounts else None
        s.check('node paired budget debited exactly 9003 msat including actual fees; refusal released',used==9003,used)
        s.snap('final')

    def grant_used():
        grant=r.run(r.BIN,'pair-status','--config',str(r.ROOTS['a']/'konsensus.toml'))
        amounts=re.search(r'SPEND GRANT client=\S+\s+([\d.]+) of ([\d.]+) sats left',grant)
        return int((Decimal(amounts[2])-Decimal(amounts[1]))*1000) if amounts else None

    def settled_since(n, seen, direction):
        return [p for p in r.get(n,'/payments') if p['payment_hash'] and p['payment_hash'] not in seen
                and p['direction']==direction and p['status']=='settled']

    def send_from_composer(s, plaintext, journal, ops):
        # Records every operation id the app journals for this send.
        import threading
        done=threading.Event()
        def watch():
            while not done.is_set():
                try: op=json.loads(journal.read_text()).get('operation_id') if journal.exists() else None
                except Exception: op=None
                if op: ops.add(op)
                time.sleep(.005)
        watcher=threading.Thread(target=watch,daemon=True); watcher.start()
        r.ui('fill',selector='[data-composer] textarea',value=plaintext)
        path=[]
        for _ in range(4):
            # A restart forgets the app-side all-in approval: approve, then Send.
            label=r.text('[data-send]').strip(); path.append(label)
            r.ui('click',selector='[data-send]')
            if label.startswith('Send'): break
            if r.wait_until(lambda:r.ui_try('exists',selector='[data-owner-action]'),3): owner_window(s)
            r.wait_until(lambda:r.text('[data-send]').strip().startswith('Send'),20)
        ok=received('b',plaintext)
        done.set(); watcher.join(2)
        return ok, path

    with r.Step(10, 'Node restart between messages: quoted re-admission paid once, exact msat') as s:
        journal=r.ROOTS['a']/'app-spend'/'spend-pending.json'
        s.need('no pending app spend before the restart',not journal.exists())
        k_before=capacities()
        a_seen={p['payment_hash'] for p in r.get('a','/payments')}
        b_seen={p['payment_hash'] for p in r.get('b','/payments')}
        grant_before=grant_used()
        # Restart node A with its app, as the pilot node restarted: every
        # connection starts unpaid again, so B asks for admission again.
        r.stop('app',grace=20)
        r.stop('node-a',grace=20)
        (r.ROOTS['a']/'node.pid').unlink(missing_ok=True)
        r.relaunch_app()
        s.need('app restarts node A',r.wait_until(r.register_a,600,.5))
        s.need('real window driver after restart',r.wait_until(lambda:r.ui('ping'),180,1))
        s.need('paired after restart',r.ui_try('wait',selector='[data-pairing="paired"]',timeoutMs=90000))
        r.ui_try('click',text='I understand — continue to funding',role='button',timeoutMs=5000)
        s.need('A money ready after restart',r.wait_until(lambda:r.get('a','/status').get('money_ready'),180))
        # money_ready precedes channel reestablishment with the router C.
        s.need('A-C channel usable again after restart',r.wait_until(lambda:any(ch['active'] for ch in r.get('a','/payments/channels')),180,1))
        def b_connected():
            return any(p.get('node_id','').lower()==b.lower() and p.get('connected') for p in r.get('a','/peers'))
        if not r.wait_until(b_connected,60,1):
            r.api('a','POST','/peers',{'node_id':b,'addr':f"127.0.0.1:{r.ports['b'][1]}",'auto_connect':False})
        s.need('A reconnected to B on a new connection',r.wait_until(b_connected,120,1))
        r.ui('click',selector=track,timeoutMs=60000)
        r.ui_try('click',selector='[data-composer-mode="message"]',timeoutMs=5000)

        # Message 1 after the restart: admission again once, then the message.
        ops=set()
        first=f'REAL-UI-E2E after node restart {time.time_ns()}'
        ok,path=send_from_composer(s,first,journal,ops)
        s.need('B decrypts the first message after the restart',ok,path)
        s.check('one operation id for the refused and the paid attempt',len(ops)==1,sorted(ops))
        s.need('UI shows the re-admission in the all-in cost',
               r.ui_try('wait',selector='[data-readmission-paid]',timeoutMs=30000))
        s.check('UI names admission again at 2.001 sats','incl. admission again 2.001 sats' in r.text('[data-readmission-paid]'),r.text('[data-readmission-paid]'))
        s.check('no failure or refusal card for the send',not r.ui_try('exists',selector='[data-artifact="failed"]') and
                not r.ui_try('exists',selector='[data-door="out-refused"][data-code="readmission_capped"]'))
        s.check('app journal cleared after the paid send',r.wait_until(lambda:not journal.exists(),10))
        s.snap('restart-readmission-paid')
        k_first=capacities()
        out_first=settled_since('a',a_seen,'outgoing')
        s.check('exact msat after message 1: admission once + message once (A -6002, B +4002, C +2000)',
                k_first=={'a':k_before['a']-6002,'b':k_before['b']+4002,'c':k_before['c']+2000},{'before':k_before,'after':k_first})
        s.check('two settled A payments, each 2001 principal + 1000 fee',len(out_first)==2 and all(p['amount_msat']==2001 and p['fee_msat']==1000 for p in out_first),out_first)
        grant_first=grant_used()
        s.check('paired client budget debited 6002 msat for admission + message',grant_first is not None and grant_before is not None and grant_first-grant_before==6002,{'before':grant_before,'after':grant_first})

        # Message 2 on the same connection: the message only.
        second=f'REAL-UI-E2E second after node restart {time.time_ns()}'
        ok,path2=send_from_composer(s,second,journal,set())
        s.need('B decrypts the second message',ok,path2)
        r.wait_until(lambda:not journal.exists(),10)
        k_second=capacities()
        s.check('exact msat after message 2: the message only (A -3001, B +2001, C +1000)',
                k_second=={'a':k_first['a']-3001,'b':k_first['b']+2001,'c':k_first['c']+1000},{'before':k_first,'after':k_second})

        # The same operation id again pays nothing more.
        op=next(iter(ops)) if len(ops)==1 else None
        status,replay=r.api('a','POST','/messages/compose',{'recipient':b,'kind':0,'plaintext':first,'operation_id':op,'max_total_msat':14002})
        time.sleep(2)
        k_replay=capacities()
        s.check('retry with the same operation_id answers from the operation',status==200 and replay.get('operation_id')==op,{'status':status,'reply':replay})
        s.check('retry with the same operation_id pays nothing more',k_replay==k_second,{'before':k_second,'after':k_replay})
        out_a=settled_since('a',a_seen,'outgoing')
        in_b=settled_since('b',b_seen,'incoming')
        s.check('three settled A payments in step 10, B received the same hashes',
                len(out_a)==3 and sorted(p['payment_hash'] for p in in_b)==sorted(p['payment_hash'] for p in out_a),{'a':out_a,'b':in_b})
        s.check('preimage proofs',all(p['preimage'] and hashlib.sha256(bytes.fromhex(p['preimage'])).hexdigest()==p['payment_hash'] for p in out_a))
        s.check('no failed or pending stray A outgoing payment',all(p['status']=='settled' for p in r.get('a','/payments') if p['payment_hash'] not in a_seen and p['direction']=='outgoing'))
        stored=r.get('b','/messages?limit=200')
        s.check('B stored each message exactly once',sum(m.get('plaintext')==first for m in stored)==1 and sum(m.get('plaintext')==second for m in stored)==1)
        grant_after=grant_used()
        s.check('paired client budget debited 9003 msat in step 10',grant_after is not None and grant_after-grant_before==9003,{'before':grant_before,'after':grant_after})
        s.snap('restart-final')
        r.evidence.write('step10-node-restart.json',{'operation_id':op,'send_path':path,'send_path_2':path2,
            'capacities':{'before':k_before,'after_message_1':k_first,'after_message_2':k_second,'after_replay':k_replay},
            'payments':{'a':out_a,'b':in_b},'grant_used_msat':{'before':grant_before,'after_message_1':grant_first,'after':grant_after},
            'replay':{'status':status,'reply':replay}})
