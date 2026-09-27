# Control center: Ask your node (slice C)

Code: `src-tauri/src/ai.rs` (host rules), the `ai_*` commands in `src-tauri/src/main.rs`,
the `payments` tool in `src-tauri/src/jarvis/broker/`, and `src/control/ai.ts` +
`src/control/AiTrack.tsx` (track). Node contract: rc7 `958e399` routes, plus the #78
`BitSov-Data-As-Of` / `BitSov-Data-Stale` headers when the node sends them.

## The app is the broker

```
main window ──ai_read(topic)──▶ host ──closed read broker (GET only, allow-list)──▶ node (loopback)
     ▲                            │
     └── projection + freshness ◀─┘        node never talks to a model
```

- **Reads.** A question becomes one of six topics: balance, channels, node, inbox, prices, payments. The host reads the topic through `jarvis::broker` with the **paired token only**. The rc7 `/auth/local` token is never used for these reads, the same rule the sealed window follows. On the bundled rc7 sidecar the track therefore says it cannot read, and it guesses nothing.
- **What comes back.** Only the broker's allowlisted projection. It never carries message bodies, ciphertext, hashes, labels or addresses. Canary tests cover every topic and every preset.
- **Local answers (default).** The answer text and cards (node, balance/channels, payments list) are composed in the window from that projection. Nothing leaves the machine.
- **Source and freshness.** Each answer names the routes read, and its age comes from the node's As-Of clock. Without an As-Of from the node on every route read, the answer is **unknown**, never fresh (main #41). The age keeps counting while the answer is on screen. An answer turns stale past the route's own bound (180 s for wallet, 60 s for the rest), or at once when the node sends `Data-Stale: 1`.

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
2. **`ai_send(disclosure_id)`.** Takes only the id. The host sends the held bytes once and then forgets them. There is no redirect, no proxy and a 60 s timeout. Error text never quotes the response. The answer is rendered as plain text, labelled with the provider and host, and marked "Your node did not check this answer". What was sent stays folded under it.

No preset or send is ever approved ahead of time. Changing the preset drops the old preview and prepares a new one.

**Presets only narrow.** Each preset keeps less than the one before, and each is idempotent. Tests check both properties.

| Preset | Keeps |
|---|---|
| Counts only (default) | counts; lists become their length |
| Rounded | amounts to two significant figures in sats, times to the day, no node ids |
| Exact | the broker projection unchanged |

## Actions never spend

A request like "draft a 2-sat message to Maya", "pay Josh 500 sats" or "request 2000 sats from Josh" produces a draft card. **Open in Maya's composer** fills that peer's composer once, in Message, Pay (direct, amount only) or Request mode. From there slice B takes over:

- The composer shows the cost.
- The spend window still needs the owner's approval.
- The owner presses Send.

Actions are handled on this computer only; they are never sent to a remote model. A remote model's text can trigger nothing.

## Gates

| Gate | Status |
|---|---|
| G1 | Unchanged. |
| G2 | Unchanged: node reads stay on loopback. The only non-loopback request is the owner-approved model call, which is TLS-only. |
| G4 | **This slice is the operator's re-scope of the AI seam (ticket C, 27 Sep).** There is no agent runtime, no ambient listening, and no AI participant or `node_id`. It is a question-and-answer track. A remote call happens only per explicit send. The copy never says "AI assistant" or "agent". |
| Authority check | `scripts/authority-check.sh` passes. |

## Screens (sample data, `docs/control-center/`)

| Shot | Shows |
|---|---|
| `20-ai-empty` | The empty track |
| `21-ai-spend-week` | Week's spending with the payments list, source and freshness |
| `22-ai-node-card` | Node card |
| `23-ai-balance-card` | Balance card |
| `24-ai-stale-prices` | A stale answer: the node marked the price table stale |
| `25`, `26` | A draft, and that draft filled into Maya's composer behind the spend approval |
| `27`–`29` | Preview: counts only, rounded, exact bytes |
| `30-ai-remote-answer` | The sample model's answer |
| `31-ai-phone` | Phone width |

## Not in this slice

- A local model runtime: "On this computer" composes answers from rules, not a model.
- Streaming answers.
- Other Lightning payment history.
- Remembering the chosen provider between launches.
- A real remote endpoint: the send path is tested against a loopback server only.
