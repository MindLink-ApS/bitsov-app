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

    def settings(tab):
        # Settings is a modal (ui-calm redesign): open it, then pick the tab.
        if not r.ui_try('exists',selector='[data-settings-open="true"]'):
            r.ui('click',selector='[aria-label="Open profile and settings"]',timeoutMs=20000)
        r.ui('click',selector=f'[data-tab="{tab}"]',timeoutMs=20000)

    def close_settings():
        if r.ui_try('exists',selector='[data-settings-open="true"]'):
            r.ui('click',selector='[data-settings-close]')

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
        r.ui('click',selector='[data-pay-confirm]',timeoutMs=20000)
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
        settings('body')
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
        settings('body')
        s.check('Body says Money ready','Money ready' in r.text('[data-readiness]'))
        s.check('readiness pill says Local OK / Money ready',r.wait_until(lambda:r.text('[data-pill] .what')=='Local OK · Money ready',20),r.text('[data-pill]'))
        s.check('no money-not-ready banner',not r.ui_try('exists',selector='[data-money-notice]'))
        s.snap('readiness')
        close_settings()

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

    # ---- EUT-3 beats (steps 11-15). Each reconciles its own msat. ----------
    import base64
    import subprocess
    import zlib
    from pathlib import Path

    def since(n, seen):
        return [p for p in r.get(n,'/payments') if p['payment_hash'] and p['payment_hash'] not in seen]

    def seen(n):
        return {p['payment_hash'] for p in r.get(n,'/payments')}

    def ledger_delta(n, records):
        # What n's channel balance must move by, from its own settled records.
        settled=[p for p in records if p['status']=='settled']
        return (sum(p['amount_msat'] for p in settled if p['direction']=='incoming')
                - sum(p['amount_msat']+(p['fee_msat'] or 0) for p in settled if p['direction']=='outgoing'))

    def proofs(records):
        return all(p['preimage'] and hashlib.sha256(bytes.fromhex(p['preimage'])).hexdigest()==p['payment_hash']
                   for p in records if p['status']=='settled')

    def qr_path(link):
        # The app's own encoder (src/qr.ts), bundled once, for the exact SVG path.
        bundle=r.ROOTS['a'].parent/'qr.mjs'
        if not bundle.exists():
            r.run(str(r.APP/'node_modules/.bin/esbuild'),str(r.APP/'src/qr.ts'),'--format=esm','--log-level=error',f'--outfile={bundle}')
        out=subprocess.run(['node','--input-type=module','-e',
            f'import {{qrSvg}} from {json.dumps(str(bundle))}; process.stdout.write(qrSvg(process.argv[1]).path)','--',link],
            capture_output=True,text=True,timeout=30)
        return out.stdout if out.returncode==0 else None

    def open_pay_window(s):
        # Money needs the owner's ten-minute window (the app restarted in step 10).
        if not r.text('[data-send]').strip().startswith('Pay'):
            r.ui('click',selector='[data-send]')
            if r.wait_until(lambda:r.ui_try('exists',selector='[data-owner-action]'),3):
                owner_window(s)
            s.need('payment window ready',r.wait_until(lambda:r.text('[data-send]').strip().startswith('Pay'),20),r.text('[data-send]'))

    def ensure_window(s):
        # A decline pays like a message: make sure the owner's window is open
        # first (the step-10 grant lasts ten minutes).
        r.ui('click',selector=track,timeoutMs=30000)
        r.ui_try('click',selector='[data-composer-mode="message"]',timeoutMs=5000)
        r.ui('fill',selector='[data-composer] textarea',value='window check (not sent)')
        if not r.text('[data-send]').strip().startswith('Send'):
            r.ui('click',selector='[data-send]')
            if r.wait_until(lambda:r.ui_try('exists',selector='[data-owner-action]'),3):
                owner_window(s)
            s.need('spend window open',r.wait_until(lambda:r.text('[data-send]').strip().startswith('Send'),20),r.text('[data-send]'))
        r.ui('fill',selector='[data-composer] textarea',value='')

    def png(width=4, height=4):
        raw=b''.join(b'\x00'+bytes([200,30,30])*width for _ in range(height))
        chunk=lambda kind,data: len(data).to_bytes(4,'big')+kind+data+zlib.crc32(kind+data).to_bytes(4,'big')
        return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',width.to_bytes(4,'big')+height.to_bytes(4,'big')+b'\x08\x02\x00\x00\x00')
                +chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))

    with r.Step(11, 'Front door publish in the real window, share QR rendered') as s:
        k0=capacities()
        settings('frontdoor')
        r.ui('wait',selector='[data-panel="front-door"]',timeoutMs=20000)
        name=f'REAL-UI-E2E A {time.time_ns()%100000}'
        r.ui('fill',selector='[data-fd-edit-name]',value=name)
        r.ui('fill',selector='[data-fd-edit-tagline]',value='EUT-3 regtest front door')
        r.ui('click',selector='[data-fd-publish]')
        # A paired app publishes only under the owner's front_door grant (genome
        # front-door scope): the editor shows the node's command; the owner runs
        # it at A's terminal with the console code; Publish again.
        def outcome():
            return r.ui_try('exists',selector='[data-fd-seq]') or r.ui_try('exists',selector='[data-fd-owner-command]') \
                or r.ui_try('exists',selector='[data-fd-edit-error]')
        r.wait_until(outcome,30)
        if r.ui_try('exists',selector='[data-fd-owner-command]'):
            command=r.text('[data-fd-owner-command]')
            match=re.fullmatch(r'konsensus grant --op ([0-9a-f]+)',command)
            s.need('editor names the owner front_door command',match,command)
            s.snap('front-door-owner-request')
            out=r.owner_grant(match.group(1),'--for','10m')
            s.check('owner granted front_door only (no spend)','granted front_door' in out and 'moves no value' in out,out[-300:])
            status=r.run(r.BIN,'pair-status','--config',str(r.ROOTS['a']/'konsensus.toml'))
            s.check('pair-status lists the front-door grant','FRONT DOOR GRANT' in status,status[-400:])
            r.ui('click',selector='[data-fd-publish]')
        s.need('published: seq shown',r.ui_try('wait',selector='[data-fd-seq]',timeoutMs=30000),r.ui_try('text',within={'selector':'[data-panel="front-door"]'}))
        shown=r.text('[data-fd-link]')
        mine=r.get('a','/front-door')
        s.check('node serves the card the window published',mine['link']==shown and mine['card']['node_id'].lower()==a.lower(),{'shown':shown[:80],'node':mine['link'][:80]})
        s.check('card carries the display name',name in json.dumps(mine['card']))
        path=r.ui_try('attrs',selector='[data-panel="front-door"] [data-fd-qr] path',names=['d'])
        s.need('share QR rendered in the window',path and path[0]['d'],r.ui_try('exists',selector='[data-fd-qr-skip]'))
        s.check('QR is exactly the app encoder output for the link',path[0]['d']==qr_path(shown))
        s.check('publishing moved no money',capacities()==k0,{'before':k0,'after':capacities()})
        s.snap('front-door-published')
        close_settings()

    with r.Step(12, 'Discover: read a front-door card, QR, local consent, Knock') as s:
        k0=capacities()
        door=r.api('b','PUT','/front-door',{'display_name':'REAL-UI-E2E B','tagline':'regtest stranger door'},expect=200)[1]
        s.need('B published a front door',door['link'].startswith('bitsov://front-door#'),door['link'][:60])
        r.ui('click',selector='[data-track="discover"]',timeoutMs=20000)
        r.ui('fill',selector='[data-discover-paste]',value=door['link'])
        r.ui('click',selector='[data-discover-read]')
        s.need('card read and verified',r.ui_try('wait',selector='[data-panel="discover"] [data-front-door-card]',timeoutMs=20000),r.ui_try('text',within={'selector':'[data-panel="discover"]'}))
        s.check('card shows B',"REAL-UI-E2E B" in r.text('[data-panel="discover"] [data-front-door-card]'))
        path=r.ui_try('attrs',selector='[data-panel="discover"] [data-fd-qr] path',names=['d'])
        s.need('card QR rendered in the window',path and path[0]['d'])
        s.check('QR is exactly the app encoder output for the card link',path[0]['d']==qr_path(door['link']))
        knock=r.ui('attrs',selector='[data-discover-knock]',names=['disabled'])
        s.check('local card: Knock disabled until consent',knock and knock[0]['disabled'] is not None,knock)
        r.ui('click',selector='[data-discover-local]')
        s.snap('discover-card')
        r.ui('click',selector='[data-discover-knock]')
        s.need('Knock opened B for first contact',r.wait_until(lambda: not r.ui_try('exists',selector='[data-panel="discover"]') and r.ui_try('exists',selector='[data-composer]'),30),
               r.ui_try('text',within={'selector':'[data-discover-error]'}))
        s.check('A is connected to B',any(p.get('node_id','').lower()==b.lower() and p.get('connected') for p in r.get('a','/peers')))
        s.check('reading and knocking moved no money',capacities()==k0,{'before':k0,'after':capacities()})
        s.snap('knocked')

    with r.Step(13, 'Received file: B sends a PNG, A saves it from the window') as s:
        k0=capacities(); sa,sb=seen('a'),seen('b')
        data=png()
        filename=f'eut3-proof-{time.time_ns()%100000}.png'
        up=r.api('b','POST','/files',{'filename':filename,'mime_type':'image/png','data_b64':base64.b64encode(data).decode()},expect=200)[1]
        sent=r.api('b','POST',f"/files/{up['file_id']}/send",{'recipient':a,'max_total_msat':20000,'max_routing_fee_msat':1000},expect=200)[1]
        s.check('B file send delivered',sent.get('delivered') is not False,sent)
        r.ui('click',selector=track,timeoutMs=30000)
        r.ui_try('click',selector='[data-composer-mode="message"]',timeoutMs=5000)
        s.need('file bubble in the window',r.ui_try('wait',selector='[data-received-file]',text=filename,timeoutMs=60000))
        r.ui('click',selector='[data-file-save]',nth=-1)
        s.need('Save finished',r.ui_try('wait',selector='[data-file-save]',text='Saved',timeoutMs=30000),r.ui_try('attrs',selector='[data-file-meta]',names=[]))
        saved=r.SAVE_DIR/filename
        s.check('saved bytes equal the sent PNG',saved.exists() and saved.read_bytes()==data,{'exists':saved.exists()})
        s.check('Save showed no error',' could not save' not in r.text('[data-file-meta]') if r.ui_try('exists',selector='[data-file-meta]') else True)
        s.snap('file-saved')
        r.wait_until(lambda: capacities()!=k0,20)
        pa,pb=since('a',sa),since('b',sb)
        k1=capacities()
        delta={n:k1[n]-k0[n] for n in k0}
        s.check('exact msat: every channel move matches the settled records',
                delta['a']==ledger_delta('a',pa) and delta['b']==ledger_delta('b',pb) and delta['a']+delta['b']+delta['c']==0,
                {'delta':delta,'a':pa,'b':pb})
        b_out=[p for p in pb if p['direction']=='outgoing' and p['status']=='settled']
        s.check('B paid the file (and any re-admission) with 1000-msat fees, preimages prove it',
                b_out and all(p['fee_msat']==1000 for p in b_out) and proofs(pb),pb)
        failed=[p for p in pb if p['status']!='settled']
        if failed:
            s.note(f'B node recorded {len(failed)} non-settled attempt(s) before settling (no balance moved): '+json.dumps(failed))
        r.evidence.write('step13-file.json',{'filename':filename,'bytes':len(data),'send':sent,'delta':delta,'a':pa,'b':pb})
        saved.unlink(missing_ok=True)

    with r.Step(14, '1:1 call signalling: B rings A, A declines in the window (paid hangup)') as s:
        ensure_window(s)
        k0=capacities(); sa,sb=seen('a'),seen('b')
        call_id=hashlib.sha256(str(time.time_ns()).encode()).hexdigest()[:32]
        # B has no window: its owner places the offer through B's API. No SDP is
        # applied unless A accepts, and A declines, so no microphone is needed.
        sdp='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
        offer=r.api('b','POST','/messages/compose',{'recipient':a,'kind':400,'max_total_msat':30000,'max_routing_fee_msat':1000,
                     'plaintext':json.dumps({'v':1,'call_id':call_id,'media':'audio','sdp':sdp})})
        s.need('B offer (kind 400) accepted by its node',offer[0]==200,offer)
        s.need('incoming call rings in A\'s window',r.ui_try('wait',selector='[data-call-panel="incoming"]',timeoutMs=60000))
        s.snap('call-incoming')
        r.ui('click',selector='[data-call-decline]')
        s.need('call ended as declined in the window',r.ui_try('wait',selector='[data-call-panel="ended"]',timeoutMs=45000))
        s.note('window: '+(r.ui_try('text',within={'selector':'[data-call-panel]'}) or ''))
        def hangup():
            return [m for m in r.get('b','/messages?limit=200') if m.get('kind')==403 and call_id in (m.get('plaintext') or '')]
        got=r.wait_until(hangup,60)
        s.check('B received A\'s declined hangup (kind 403)',got and '"declined"' in got[0]['plaintext'],got)
        s.snap('call-declined')
        r.wait_until(lambda: len([p for p in since('a',sa) if p['status']=='settled'])>=2,30)
        pa,pb=since('a',sa),since('b',sb)
        k1=capacities()
        delta={n:k1[n]-k0[n] for n in k0}
        a_in=[p for p in pa if p['direction']=='incoming' and p['status']=='settled']
        a_out=[p for p in pa if p['direction']=='outgoing' and p['status']=='settled']
        s.check('A received the 10000-msat offer admission',any(p['amount_msat']==10000 for p in a_in),a_in)
        s.check('A paid one hangup: 1000 msat + 1000 fee',len(a_out)==1 and a_out[0]['amount_msat']==1000 and a_out[0]['fee_msat']==1000,a_out)
        s.check('exact msat: every channel move matches the settled records',
                delta['a']==ledger_delta('a',pa) and delta['b']==ledger_delta('b',pb) and delta['a']+delta['b']+delta['c']==0,
                {'delta':delta,'a':pa,'b':pb})
        s.check('preimage proofs',proofs(pa) and proofs(pb))
        r.evidence.write('step14-call.json',{'call_id':call_id,'offer':offer,'delta':delta,'a':pa,'b':pb,'hangup':got})
        r.ui_try('click',selector='[data-call-dismiss]',timeoutMs=3000)

    with r.Step(15, 'Pay -> Direct (keysend) 21 sats to B, exact msat on real LDK') as s:
        # Keysend carries no route hints, so it cannot cross the private C-B
        # channel. A opens a direct unannounced A-B channel first (last step: every
        # earlier A->B payment still routed through C).
        b_ln=r.get('b','/status')['lightning_node_pubkey']
        via_c={ch['peer_pubkey'] for ch in r.get('b','/payments/channels')}
        r.api('a','POST','/payments/open-channel',{'peer_pubkey':b_ln,'peer_addr':f"127.0.0.1:{r.ports['b'][2]}",
              'amount_sats':200_000,'announce':False},expect=200)
        s.need('A-B funding in mempool',r.wait_until(lambda: fixture('mempool'),120))
        fixture('mine')
        s.need('A-B channel usable',r.wait_until(lambda: any(ch['active'] and ch['peer_pubkey']==b_ln for ch in r.get('a','/payments/channels')),180,1))
        s.need('B sees the A-B channel',r.wait_until(lambda: len(r.get('b','/payments/channels'))==2 and all(ch['active'] for ch in r.get('b','/payments/channels')),180,1))
        # B's side of a fresh channel starts at zero, below its channel reserve,
        # where its reported balance cannot move. Give B liquidity over it first.
        def b_ab():
            return sum(ch['local_balance_msat'] for ch in r.get('b','/payments/channels') if ch['peer_pubkey'] not in via_c)
        inv=r.api('b','POST','/payments/invoice',{'amount_msat':5_000_000,'description':'A-B reply liquidity'},expect=200)[1]
        r.api('a','POST','/payments/pay',{'bolt11':inv['bolt11'],'max_routing_fee_msat':1000},expect=200)
        s.need('A-B liquidity settled',r.wait_until(lambda: any(p['payment_hash']==inv['payment_hash'] and p['status']=='settled' for p in r.get('a','/payments')),60))
        s.need('B balance on the A-B channel above its reserve',r.wait_until(lambda: b_ab()>0,60),b_ab())
        k0=capacities(); sa,sb=seen('a'),seen('b')
        r.ui('click',selector=track,timeoutMs=30000)
        r.ui('click',selector='[data-composer-mode="pay"]')
        r.ui('click',text='Direct',role='tab')
        unit=r.text('.pay-flow .amount-unit')
        r.ui('fill',selector='[data-pay-amount]',value='21' if unit=='sats' else '0.00000021')
        r.ui('fill',selector='[data-pay-pubkey]',value=b_ln)
        r.ui('fill',selector='[data-pay-note]',value='EUT-3 direct 21 sats')
        open_pay_window(s)
        r.ui('click',selector='[data-send]')
        review=r.ui('attrs',selector='[data-pay-review]',names=['data-review-msat','data-review-max-msat'])
        s.need('review shows exactly 21000 msat',review and review[0]['data-review-msat']=='21000',review)
        s.snap('keysend-review')
        r.ui('click',selector='[data-pay-confirm]',timeoutMs=20000)
        s.need('payment artifact in the window',r.ui_try('wait',selector='[data-artifact="payment"]',timeoutMs=60000),
               r.ui_try('attrs',selector='[data-artifact]',names=['data-artifact','data-code']))
        s.check('artifact says direct (keysend)','direct (keysend)' in r.text('[data-artifact="payment"]'))
        def settled():
            out=[p for p in since('a',sa) if p['direction']=='outgoing']
            return out if out and all(p['status']=='settled' for p in out) else None
        out=r.wait_until(settled,60)
        s.need('A keysend settled',out,since('a',sa))
        r.wait_until(lambda: capacities()!=k0,20)
        pb=since('b',sb)
        k1=capacities()
        delta={n:k1[n]-k0[n] for n in k0}
        s.check('one A outgoing payment of exactly 21000 msat',len(out)==1 and out[0]['amount_msat']==21000,out)
        s.check('B received the same payment hash, exactly 21000 msat',
                [p['payment_hash'] for p in pb if p['direction']=='incoming' and p['amount_msat']==21000 and p['status']=='settled']==[out[0]['payment_hash']],pb)
        fee=out[0]['fee_msat'] or 0
        s.check('exact msat: A -(21000+fee), B +21000, C unchanged',delta=={'a':-(21000+fee),'b':21000,'c':0},{'delta':delta,'fee':fee})
        s.check('direct route: zero routing fee',fee==0,fee)
        s.check('preimage proof',proofs(out))
        s.snap('keysend-paid')
        r.evidence.write('step15-keysend.json',{'delta':delta,'a':out,'b':pb,'review':review})
