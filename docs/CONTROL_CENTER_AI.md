# Control center: Ask your node (slice C)

Code: `src-tauri/src/ai.rs` (host rules), the `ai_*` commands in `src-tauri/src/main.rs`,
the `payments` tool in `src-tauri/src/jarvis/broker/`, and `src/control/ai.ts` +
`src/control/AiTrack.tsx` (track). Bundled node: rc19.2 `04fe65e03aad949ade90c10c8e8ccf36daf2b0f6`; retained rc7 compatibility routes, plus the #78
`BitSov-Data-As-Of` / `BitSov-Data-Stale` headers when the node sends them.

This page describes the existing read broker and provider configuration. These
do not establish a complete paid AI service or enforcement of paid-AI spending
controls. The broker excludes message bodies from its model projections.

## The app is the broker

```
main window ──ai_read(topic)──▶ host ──closed read broker (GET only, allow-list)──▶ node (loopback)
     ▲                            │
     └── projection + freshness ◀─┘        node never talks to a model
```

- **Reads.** A question becomes one of six topics: balance, channels, node, inbox, prices, payments. The host reads the topic through `jarvis::broker` with the **paired token only**. The rc7 `/auth/local` token is never used for these reads, the same rule the sealed window follows. On an older rc7 node the track therefore says it cannot read, and it guesses nothing.
- **What comes back.** Only the broker's allowlisted projection. It never carries message bodies, ciphertext, hashes, labels or addresses. Canary tests cover every topic and every preset.
- **Local answers (default).** The answer text and cards (node, balance/channels, payments list) are composed in the window from that projection. Nothing leaves the machine.
- **Source and freshness.** Each answer names the routes read, and its age comes from the node's As-Of clock. Without an As-Of from the node on every route read, the answer is **unknown**, never fresh (main #41). The age keeps counting while the answer is on screen. An answer turns stale past the route's own bound (180 s for wallet, 60 s for the rest), or at once when the node sends `Data-Stale: 1`.
  The host returns `fresh_for_ms`, the shortest remaining route lifetime, separately from the oldest displayed age. For example, 70-second-old wallet reads and a current health read remain fresh for 60 more seconds. Local channel balances include inactive channels and are described as balances, not as a promise that they can be sent now.

## Broker change: one new tool

Nothing on rc7 lists payments, so "what did I spend" needs paid messages. The `payments` tool reads:

| Route | Kept | Dropped |
|---|---|---|
| `GET /peers` | valid 64-hex node ids | label, address, fingerprint, safety number |
| `GET /messages?peer=<PeerKey>&limit=200` for each contact (at most 32) | time, direction, amount | id, kind, body, ciphertext, hash, references |

- **Peer key.** `PeerKey` is 32 bytes, parsed from 64 hex and written back as lowercase. `admit()` allows `peer=` only on `/messages`, and only together with `limit`. Peer ids are never logged.
- **Floors, not guesses.** A thread that fails counts in `peers_unread`. A thread that fills a whole page counts in `partial_threads`. The answer says so, so a total is a floor.
- **Scope.** Paid messages only. The answer says that other Lightning payments are not in a list the app may read.
- **Sealed window.** The sealed assistant window does not call this tool. Its 50-question fixture is unchanged.

## Remote models: off by default, one preview per send

| Provider | Default | Where it is set |
|---|---|---|
| On this computer | on | built in |
| Shared open model | off | `ai-providers.json` → `shared` |
| Frontier model | off | `ai-providers.json` → `frontier` |

`ai-providers.json` sits in the app config dir (macOS: `~/Library/Application Support/<bundle id>/`). The window cannot write it.

```json
{
  "shared": {
    "label": "Shared open model",
    "endpoint": "https://models.example.org/v1/chat/completions",
    "model": "open-8b",
    "key_env": "BITSOV_SHARED_AI_KEY",
    "enabled": true
  }
}
```

**Endpoint rules.** The endpoint must be `https`, or plain `http` to a loopback IP (a model server on this machine). Credentials in the URL are refused. Unknown fields are refused, so an inline `api_key` fails the whole file. The key is read from the named environment variable at send time and never reaches the window. No key lives in the repo.

**Sending takes two steps:**

1. **`ai_disclose`.** The host re-reads the topic, narrows it by a preset, builds the exact OpenAI-compatible request body, and holds it under a random id. It lives in host memory only, for 5 minutes at most. The window shows it two ways:
   - **What you share:** the user message, decoded character for character.
   - **Exact bytes:** the body verbatim.
2. **`ai_send(disclosure_id)`.** Takes only the id. The host sends the held bytes once and then forgets them. There is no redirect, no proxy and a 60 s timeout. The host rejects responses over 256 KiB while reading, before accumulating an oversized body or parsing JSON; the same cap applies without a declared length. Error text never quotes the response. The answer is rendered as plain text, labelled with the provider and host, and marked "Your node did not check this answer". What was sent stays folded under it.

No preset or send is ever approved ahead of time. Changing the preset drops the old preview and prepares a new one.
Leaving the AI track cancels its pending previews and records them as not sent, so returning cannot offer Send for a canceled disclosure.

**Presets only narrow.** Each preset keeps less than the one before, and each is idempotent. Tests check both properties.

| Preset | Keeps |
|---|---|
| Counts only (default) | counts; lists become their length |
| Rounded | amounts to two significant figures in sats, times to the day, no node ids |
| Exact | the broker projection unchanged |

## Own tier: a model on this computer (P2)

"On this computer" still defaults to **rules** (compose from the broker read; nothing leaves). When a local model server is already running on loopback, Own can use it:

1. The host probes `127.0.0.1` only — Ollama on port 11434 (`GET /api/tags`) or an OpenAI-compatible llama.cpp server on 8080 (`GET /v1/models`). The port is configurable in the AI track.
2. The owner picks a listed model. The pick is saved in `ai-local.json` next to `ai-providers.json`. The window cannot write the remotes file.
3. Questions use the same two-step disclose/send as remotes: the owner sees **What you share** and **Exact bytes**, then presses Send. The host posts only those held bytes to `http://127.0.0.1:<port>/v1/chat/completions`. The badge stays **Own** (green): `On this computer · <model>` · Nobody is paid · Nothing leaves (loopback only).
4. If nothing is listening, the track shows a short how-to and Own badges as **rules** (the model name is cleared) until the server answers again — a saved pick that is down is unavailable, not silently ready. BitSov does not download or install models. Remotes stay off unless `ai-providers.json` turns them on. There is no new spend path.

Commands: `ai_local_status`, `ai_local_select`, `ai_local_clear` (Own uses `ai_disclose` / `ai_send`).

## Endpoint badge

The chat header always shows which endpoint answers, who gets paid and what leaves the node. The sealed assistant window shows the same badge (always Own: it has no model).

| Badge | Endpoint | Who gets paid | What leaves |
|---|---|---|---|
| **Own** (green) | On this computer · rules *or* `<model>` | Nobody | Nothing |
| **Shared open** (amber) | `<model> at <host>` | The host's operator, on your own API key (billed off-app); nobody when no key is set | The preview you send, at its preset (counts only by default) |
| **Frontier** (red) | `<model> at <host>` | The vendor at that host, on your own API key | The same, and vendor terms apply |

The host derives it: `ProviderView` carries `pays: {to, rail: none | fiat}` and `data_leaves` (`null` = nothing; otherwise the preset a preview starts at), both from the provider kind and `ai-providers.json`. The window cannot set them. Switching provider changes the badge before the first question; while a preview is on screen, it names that preview's preset, and after Send or Don't send it returns to the selection's. **Who answers** is locked while any preview waits for Send or is sending, and the badge always shows the widest exposure of the selection and every pending preview, so it can never understate what could leave. A keyed model server on this computer (loopback) reads "Paid: your API key (local endpoint)". There is no sats rail and no spend path to any model: the badge only describes, and no AI holds spend. The tier is written out, so colour is never the only signal; every badge colour meets WCAG AA in both themes (`tests/endpoint-badge.test.tsx`).

The sealed window uses the same words as the AI track: **From your node** for live rows and **Sample data** (not "Mock data") otherwise; the rc7 reason reads "Your node version has no pairing."

## Actions never spend

A request like "draft a 2-sat message to Robin", "pay Kim 500 sats" or "request 2000 sats from Kim" produces a draft card. **Open in Robin's composer** fills that peer's composer once, in Message, Pay (direct, amount only) or Request mode. From there slice B takes over:

- The composer shows the cost.
- The spend window still needs the owner's approval.
- The owner presses Send.

Actions are handled on this computer only; they are never sent to a remote model. A remote model's text can trigger nothing.
Message proposals carry separate `recipient`, `draft_text`, and `amount_hint` fields from the local rules. Enter the literal message or invoice note in **Draft text (optional)**; the question selects the action/contact and optional amount. The composer copies `draft_text` verbatim, including whitespace, apostrophes, nested quotes, and text that looks like instructions. An empty field opens an empty draft. Neither the question nor an answer's display prose is parsed for a message body or invoice note. Remote read answers remain display-only. The message amount hint never changes the recipient's price or grants permission to send.

Payment and invoice drafts accept whole positive sats only (including correctly grouped thousands). Decimal, signed, fractional, or malformed amount tokens are rejected instead of interpreting their trailing digits as a different amount.

## Gates

| Gate | Status |
|---|---|
| G1 | Unchanged. |
| G2 | Unchanged: node reads stay on loopback. The only non-loopback request is the owner-approved model call, which is TLS-only. |
| G4 | This question-and-answer slice has no unattended runtime or AI peer/`node_id`; remote calls happen only per explicit send. The broker excludes message bodies. A complete paid AI service remains unshipped. |
| Authority check | The existing static check is `scripts/authority-check.sh`; a pass does not establish the new G4 runtime, privacy or spending controls. |

## Screens (sample data, `docs/control-center/`)

| Shot | Shows |
|---|---|
| `20-ai-empty` | The empty track |
| `21-ai-spend-week` | Week's spending with the payments list, source and freshness |
| `22-ai-node-card` | Node card |
| `23-ai-balance-card` | Balance card |
| `24-ai-stale-prices` | A stale answer: the node marked the price table stale |
| `25`, `26` | A draft, and that draft filled into Robin's composer behind the spend approval |
| `27`–`29` | Preview: counts only, rounded, exact bytes |
| `30-ai-remote-answer` | The sample model's answer |
| `31-ai-phone` | Phone width |

## Not in this slice

- Remotes on by default: shared and frontier stay off until `ai-providers.json` enables them.
- Downloading or installing a model: Own only talks to a server you already run (Ollama or llama.cpp).
- A sats rail to any model vendor (see research `AI-ENDPOINTS-AND-SATS-VENDORS.md` P3).
- Outside-agent credentials or a receptor/x402 door (P4).
- Streaming answers.
- Other Lightning payment history.
- Remembering the chosen provider between launches.
- A real remote endpoint: the send path is tested against a loopback server only.
