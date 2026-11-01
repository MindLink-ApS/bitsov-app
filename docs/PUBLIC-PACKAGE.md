# Public package: a box's own page, fetched and paid in sats

Status: **design proposal, docs only.** No code in this change. Needs a
two-vendor review and the owner decisions listed at the end before any build.
Hardened after an independent review (round 1): quotes bound to the card
`seq` (§3.2), node-side hash check before payment (§5), `srcdoc` only and a
four-webview IPC gate (§7.2), and the fetch-size conflict recorded as open
item D9.

A box (node) publishes a **public package**: a profile, a CV or a small
homepage made of files the owner chooses (markdown, images, PDF, and only
optionally HTML/JS). Another box fetches it and shows it in a browser-like
view. Each fetch is paid in sats, inside a cap the reader approves once.

## 1. Current state (what exists today)

### 1.1 The signed card (`src-tauri/src/front_door.rs`)

`Card` (`front_door_v1`) is signed by the node key: Ed25519 over BLAKE3 of
`bitsov-front-door/v1\0` plus the canonical JSON without `sig`. The app
re-implements the format (gate G1 keeps konsensus crates out) and verifies it
before the renderer sees it. Fields that matter here:

| Field | Shape | Limits in `check_shape` |
|-------|-------|-------------------------|
| `profile` | kind, display_name, tagline, about, avatar | name ≤ 48, tagline ≤ 80, about ≤ 280; inline avatar ≤ 8 KiB |
| `cv` | `{path, hash, size}` | flat safe path ≤ 128 chars, 64-hex hash |
| `media[]` | `{hash, size, mime, thumb_b64?, title}` | ≤ 12 items, thumb ≤ 4 KiB, title ≤ 64 |
| `site` | `{manifest_hash?, index_path?, page_count, titles[]}` | ≤ 20 titles, flat `index_path`, 64-hex `manifest_hash` |
| `links[]` | `{label, url}` | ≤ 5, http(s) only, ≤ 512 chars |
| `prices` | `admission_msat, message_msat, page_msat, price_epoch` | — |

Whole card ≤ `MAX_CARD_BYTES` (16 KiB); lifetime ≤ 7 days; `seq` orders
re-publishes. `check_safe_path` refuses any `/`, so paths are flat today.
Content hashes on the card are **BLAKE3** (`front_door_hash_bytes` in
`app.rs`), not SHA-256.

`site.manifest_hash` is already in the signed body, but nothing produces or
reads a manifest yet. The node attaches `site`; the app never sends it.

### 1.2 The owner editor (`src/control/Discover.tsx`, `frontDoorMedia.ts`)

- Name, tagline, about, avatar, up to 12 media items, one website link and a
  CV text box.
- Images are resized in a canvas and re-encoded as JPEG; only a 64 px thumb
  or a 96 px avatar is inlined. Media go on the card **by hash only**; the
  full bytes are not uploaded anywhere.
- The CV: the size estimate uses a zero hash (`'0'.repeat(64)`) and the
  publish computes a real hash of the text, but the **CV text itself is never
  uploaded**. The card can name `cv.md` that the node does not serve.
- Publish budget 15 KiB (`CARD_PUBLISH_BUDGET`) under the 16 KiB node cap.
- The editor's preview defaults `page_msat` to 1 000 msat (1 sat).

### 1.3 Publish (`front_door_publish` in `src-tauri/src/app.rs`)

`PUT /front-door` with profile, prices, avatar, media, cv and links. Needs the
`front_door` scope; without it the app files an elevation request the owner
grants at the node (`put_front_door`, `ask_front_door_owner`). The returned
card is verified, must be signed by this node's key and must match its link.

### 1.4 Reading a porch (`src-tauri/src/porch.rs`, `do_porch_read`, `Porch.tsx`)

- `POST /browse/quote` is free and path-bound: node, path, principal and
  maximum routing fee, checked so that principal + fee = total.
- `POST /browse/fetch` pays once (kind 500, `KIND_PAGE_REQUEST`, category
  `web_content`), floor 1 sat (`MIN_READ_MSAT`), reply timeout 20 s.
- One review per read: the owner confirms each quote in `Porch.tsx`; reading
  again pays again; a paid read without a usable answer is accounted, never
  retried. The spend goes through the journal, the budget reservation and the
  node grant (`porch_post`).
- Paths: `/front-door.json` or a flat, visible `.md`/`.txt` at the site root
  (`is_site_page`, ≤ 128 chars, no `/`, `\`, `%`, `..`).
- Body ≤ `MAX_BODY_BYTES` (256 KiB), text only, cleaned by `clean_text`.

### 1.5 Rendering (`src/control/porchText.ts`)

Markdown is parsed into a small tree and rendered with text nodes only. A tag
is shown as characters, a link is shown as text with its URL, and an image is
a placeholder (`[Image: alt]`). Nothing is ever loaded or opened.

### 1.6 App CSP (`src-tauri/tauri.conf.json`)

`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
media-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost`.

The app origin can reach the Tauri IPC. **Anything run in the app's own
origin can call host commands, including money commands.** That is the key
fact for the HTML section below.

## 2. Goals and non-goals

Goals

- An owner chooses files, previews the result and publishes a package bound
  to the signed card.
- A reader sees one package-level price ("up to X sats for N files"), approves
  once, and the app fetches and pays within that cap.
- Every file is checked against the signed manifest before it is shown.
- Markdown, images and PDF render natively, with no script.
- HTML/JS, if allowed at all, runs only in an isolated sandbox with no network,
  no IPC and no shared origin.
- Works for a reader new to computers: one price, one
  yes, a clear "you paid X" line.

Non-goals

- A general web browser, open web links, or fetching anything outside the
  package.
- Server-side code, forms that post back, comments, or tracking.
- Live or streaming content; video in the first phases.
- Search or discovery across boxes (separate topic).
- Node-side storage implementation (lives in the node repo; only its API is
  specified here).

## 3. The package

### 3.1 Manifest

A small JSON document, stored by the node, addressed by its hash. The card's
`site.manifest_hash` names it, so the card signature covers the manifest and,
through it, every file.

```json
{
  "v": 1,
  "kind": "cv",
  "hash_alg": "blake3",
  "entry": "index.md",
  "title": "Curriculum vitae",
  "files": [
    { "path": "index.md",      "hash": "<64 hex>", "mime": "text/markdown",   "size": 4210 },
    { "path": "photo.jpg",     "hash": "<64 hex>", "mime": "image/jpeg",      "size": 81233 },
    { "path": "cv.pdf",        "hash": "<64 hex>", "mime": "application/pdf", "size": 412000 },
    { "path": "work/2024.md",  "hash": "<64 hex>", "mime": "text/markdown",   "size": 2100 }
  ]
}
```

Rules

- `kind`: `profile`, `cv` or `site` (a hint for layout only).
- `hash_alg`: fixed to `"blake3"` (decision D1). Every file hash and the
  manifest's own hash are BLAKE3, 32 bytes as 64 lowercase hex, the same
  function as the card, media and avatar hashes (`front_door_hash_bytes` in
  `app.rs`). The field stays in the format for future agility: version 1
  readers and the node refuse any other value, so a later algorithm needs a
  deliberate format change, never a silent mix inside one manifest.
- `entry`: optional; defaults to `index.md`. Must be listed in `files`.
- Paths: relative, ≤ 128 chars, at most 2 levels, `[a-z0-9._-]` segments, no
  leading dot, no `..`, `\`, `%` or control characters. Paths are unique after
  ASCII lowercasing. This is a deliberate widening of `check_safe_path`
  for the manifest only; the card's own paths stay flat.
- `mime` must be on the allow-list (§7) and agree with the file's sniffed
  type; a mismatch refuses that file.
- Manifest ≤ 32 KiB, ≤ 64 files, canonical JSON (sorted by path) so the hash
  is stable.

### 3.2 Binding to the card

- Card `site.manifest_hash` = hash of the canonical manifest bytes.
- Card `site.index_path` = manifest `entry`; `page_count` = number of files;
  `titles` = up to 20 human titles for the reader's table of contents.
- A new package means a new manifest hash, which means a re-signed card with
  a higher `seq`. A reader holding an old card sees the old package or a
  clear "this box has updated its page" line; it never mixes files from two
  manifests.
- **Quotes are bound to the card `seq`.** A held card may be older than the
  live one, so the manifest is trusted only through a card whose signature
  and `seq` the reader has checked:
  - the quote reply carries the node's current card `seq` and its
    `manifest_hash`;
  - the node refuses a quote for a `manifest_hash` that is not in its
    current card (the grace period in §5 covers fetches already quoted, not
    new quotes);
  - the reader refuses a quote whose `seq` is lower than the `seq` of the
    card it holds, and fetches the newer card first when the quote's `seq`
    is higher.
- **Rollback.** The reader keeps the highest `seq` it has seen per node and
  refuses any card with a lower one, so a peer replaying an old card is
  refused. A publisher re-publishing an old manifest under a **higher**
  `seq` is legitimate and accepted.
- Existing `cv` and `media` fields stay valid. A phase-1 package can list the
  same CV and media bytes, so old readers keep working.

## 4. Owner UI: "Min side" (My page)

A new section beside the Discover editor, same window, same `front_door`
authority.

1. **Choose a template**: Profile, CV, or Company page. Each starts with an
   `index.md` skeleton the owner edits in place.
2. **Add files**: drag in or pick markdown, images and PDF. Images are
   re-encoded in a canvas (as `frontDoorMedia.ts` does today) and EXIF is
   dropped. PDFs are kept as-is but shown with a "PDFs can contain hidden
   data" note.
3. **Preview**: the exact reader view (§6), rendered locally from the chosen
   bytes, with the price a reader would see.
4. **Price**: per-file price defaults to the card's `page_msat`; the screen
   shows the full-package total.
5. **Publish**: one button; the result shows the new card link and "N files,
   X KiB, up to Y sats for a reader".

HTML/JS files are hidden behind an "Advanced" switch and are off by default
(open decision D3).

## 5. Publish path

Host side (this repo), a new command `package_publish`:

1. Check `/status` lists a new capability `public_package_v1`.
2. Validate every file locally against §3.1 and §7; compute hashes in Rust,
   not in the renderer.
3. Upload each file whose hash the node does not hold yet, then the manifest.
4. Re-publish the card with `site.manifest_hash` set, through the existing
   `PUT /front-door` and scope flow.
5. Verify the returned card as `front_door_publish` does, and check
   `site.manifest_hash` equals what was uploaded.

Node API this needs (node repo, all under the `front_door` scope):

| Route | Purpose |
|-------|---------|
| `HEAD /api/v1/package/blobs/:hash` | does the node hold these bytes |
| `PUT /api/v1/package/blobs/:hash` | store bytes; node re-hashes and refuses a mismatch or an over-cap size |
| `PUT /api/v1/package/manifest` | store a manifest; node validates paths, mimes, sizes and that every hash is held; returns its hash |
| `PUT /front-door` (extended) | accepts `site.manifest_hash` from the owner and signs it into the card |
| `DELETE /api/v1/package/blobs/:hash` | drop unreferenced bytes (owner only) |

Peer-facing routes (paid, same model as today's porch):

| Route | Purpose |
|-------|---------|
| `POST /browse/quote` (extended) | with `{"node_id", "manifest_hash"}` returns per-file prices and a package total |
| `POST /browse/fetch` (extended) | with `{"node_id", "manifest_hash", "path", "max_total_msat", "max_routing_fee_msat"}` pays kind 500 once and returns the bytes base64 with `content_type` and `hash` |
| `GET` of the manifest itself | free through the quote, or one paid read; open decision D4 |

The node serves only paths in the current manifest, refuses anything else
before payment, and keeps the previous manifest for a short grace period so a
reader mid-fetch is not cut off.

**Hash checked by the node before payment.** The node re-hashes on
`PUT /blobs/:hash` and refuses a mismatch (above). On fetch, it serves only
bytes whose BLAKE3 equals the manifest entry for that path, and it refuses a
fetch **before payment** when the stored blob's hash differs from the
manifest entry (a corrupted or swapped store). Each per-file quote is bound
to (manifest hash, path, file hash, price), so a changed file under the same
path cannot be sold under the old quote. The reader's own hash check (§6.2)
is defence in depth, not the first line.

## 6. Fetch and pay

### 6.1 One quote, one yes

1. Reader opens a box's card (free if held, one paid read otherwise). A
   held card may be stale; step 2 detects that.
2. App asks `/browse/quote` with the manifest hash. Reply: manifest, the
   current card `seq`, per-file principal, routing fee ceiling per file, and
   the package total. Each per-file quote names (manifest hash, path, file
   hash, price). The reader applies the `seq` rules in §3.2.
3. The review shows: "**Up to X sats for N files** from <name>. You pay only
   for files you open." Default selection is the entry page plus files it
   links to; the reader may pick "whole package".
4. One approval sets a **package cap** in msat, bound to (peer, manifest
   hash, selected paths, cap, expiry ≤ 10 min). This is the same kind of
   binding as Approve & send: the approval is tied to the
   exact request it was armed for.

### 6.2 Fetching within the cap

- Files are fetched one at a time through the existing `porch_post` path:
  journal, budget reservation, node grant, never a retry.
- Before each file the host checks: path is in the approved set, the running
  total plus this file's quoted maximum stays ≤ cap. If not, it stops and
  asks again; it never pays past the cap.
- A price change beyond the quote is refused by the node before payment
  (`price_cap_exceeded`), as today.
- Each body is hashed in the host and compared with the manifest entry. A
  mismatch shows "this file did not match what the box signed" and the
  amount paid; the file is not shown or cached. Because the node must refuse
  a mismatch before payment (§5), a mismatch after payment counts as a
  **node fault**: the reader view marks the box with "this box is
  misbehaving", never a silent loss.
- The review line at the end: "Paid X sats for N files."

### 6.3 Caching

- Verified bytes are cached by hash in the app data directory, bounded (e.g.
  64 MiB, LRU), never in the webview's own cache.
- A cached file with a matching hash opens free and says "already on this
  device". A new manifest that reuses a hash reuses the bytes.
- The cache never holds unverified bytes.

## 7. Rendering

Order of work: native first, sandbox last.

| Type | Mime | Max size | How it renders |
|------|------|----------|----------------|
| Markdown / text | `text/markdown`, `text/plain` | 256 KiB (today's `MAX_BODY_BYTES`) | existing `porchText.ts` tree, text nodes only |
| Images | `image/png`, `image/jpeg`, `image/webp`, `image/gif` | 2 MiB each | decoded and re-encoded in the host, shown as a `data:` URL (CSP already allows `img-src data:`) |
| PDF | `application/pdf` | 5 MiB | pages rasterised in the host or a sandboxed viewer; no PDF JavaScript, no forms, no external links (open decision D2) |
| HTML/JS | `text/html`, `text/javascript`, `text/css` | 1 MiB total | sandboxed frame only (§7.2) |

Package total ≤ 16 MiB in phase 1. SVG is refused (it is script).

**Fetch size conflict (open item D9).** Today `porch::project` refuses any
fetch reply body over `MAX_BODY_BYTES` (256 KiB, `porch.rs`), so a fetch
"through the existing `porch_post` path" would refuse every image and PDF
above 256 KiB, while this table allows 2 MiB images and 5 MiB PDFs. Before
P2, a per-fetch reply cap for package files must be chosen (for example
per-mime, matching this table, or files split into chunks under 256 KiB),
and the doc must say which cap applies to which path. Whatever is chosen,
the cap is checked on the encoded reply length **before** base64 decode,
and the decoded length is checked against the manifest `size`.

### 7.1 Native rules

- Markdown images point at package paths only (`![x](photo.jpg)`). A path in
  the manifest renders the verified image; anything else stays a placeholder.
- Links to package paths navigate inside the view (and may cost a fetch,
  inside the cap). External links stay text with the URL shown, as today.
- No remote fetch of any kind. This removes tracking pixels by construction.

### 7.2 HTML/JS sandbox

Only if D3 says yes, and only after the native view ships.

- An `<iframe sandbox="allow-scripts">`: **no `allow-same-origin`**, no
  `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` or
  `allow-downloads`. The frame gets an opaque origin.
- Content goes in through **`srcdoc` only**. **No `blob:`**: a `blob:` URL
  created by the app is in the app's origin. Never a URL in the app's
  origin, never a Tauri asset or custom protocol that shares the app's
  origin.
- The frame carries `referrerpolicy="no-referrer"`, so it cannot read the
  parent's address through `document.referrer`.
- The frame document carries its own CSP meta, prepended by the host:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data:; font-src data:; connect-src 'none'; form-action 'none';
  frame-src 'none'; base-uri 'none'`. No `ipc:`, no `http://ipc.localhost`.
- Package assets are inlined by the host as `data:` URLs after hash checks;
  the frame cannot request anything.
- The app CSP gains `frame-src` only for what the sandbox needs (open
  decision D5), and `connect-src` stays as it is for the app itself.
- The parent ignores `postMessage` from the frame except one fixed message
  type (for example "navigate to package path"), checked against the manifest.
- Tauri: the frame must not get the IPC bridge. Verify in a test that
  `window.__TAURI__`, `__TAURI_INTERNALS__` and `fetch('ipc://...')` are
  absent or fail inside the frame, and that a `postMessage` with an
  off-manifest path is ignored.
- **Phase gate:** this IPC-absence test runs on **every** target webview:
  iOS WKWebView, macOS WKWebView, Android WebView and Windows WebView2.
  `srcdoc` CSP inheritance differs between webviews, so a pass on one proves
  nothing for the others. P4 does not ship until all four pass.
- A visible frame border and label: "Page from <name>, running in a sandbox".

## 8. Abuse and security

| Threat | Mitigation |
|--------|-----------|
| Script reaching host commands | no HTML in the app origin; sandbox without `allow-same-origin`; `srcdoc` only, no `blob:`; frame CSP with no connect; IPC absence test on all four webviews as a P4 gate |
| Tracking pixels, beacons, fonts from the web | no remote fetch anywhere; assets only from the verified package |
| Swapped or corrupted files | node refuses a blob whose hash differs from the manifest entry before payment; per-file quote bound to (manifest hash, path, file hash, price); reader hash-checks every file before it is shown or cached and reports a post-payment mismatch as a node fault |
| Payment griefing (many tiny files, price changes, slow replies) | package cap set once; per-file maximum checked before each payment; ≤ 64 files; node refuses a changed price before paying; 20 s timeout; no retries |
| Oversized packages | manifest, per-file and total caps checked by the host before the quote is shown and again on each reply |
| Malicious images or PDFs | host decodes and re-encodes images; PDF has no script or forms; type sniffed against declared mime |
| Misleading content (fake "pay here" pages) | the page renders inside a framed view with the box's name and node id; the app never takes payment instructions from page content |
| Path tricks | manifest path rules (§3.1); the node and the host both check |
| Stale or replayed packages | manifest hash bound to a card with `seq` and a 7-day lifetime; quote carries the current `seq` and the node refuses a quote for a manifest not in its current card; reader keeps `seq` monotonic per node and refuses a lower one; old manifests shown as old |
| Owner privacy | EXIF stripped; preview shows exactly what a reader gets; PDFs flagged |

## 9. Demo plan

Two boxes on regtest, and a third for a family member. The owner supplies all
page content; the demo ships no real text or photos.

1. **Company page** on box A: `index.md` (about the company), `team.md`,
   `logo.png`, `brochure.pdf`. Price 1 sat per file.
2. **Personal CV** on box B: `index.md`, `photo.jpg`, `cv.pdf`. Price 2 sats per
   file.
3. **Family member** on box C (already a contact of A and B) opens B's card,
   sees "up to 6 sats for 3 files", says yes once, reads the CV, opens the
   PDF. Then opens A's page and pays per page as they click through.
4. Show the result lines ("Paid 6 sats for 3 files") and the budget view.
5. Negative demos: a tampered file shows the mismatch line; a package over
   the cap stops and asks again; re-opening a cached file costs nothing.

## 10. Phased plan

| Phase | Scope | Repo |
|-------|-------|------|
| P0 | This doc, review, owner decisions | app |
| P1 | Node: blob store, manifest validation, extended quote/fetch, capability `public_package_v1` | node |
| P2 | App: manifest types and checks in Rust; `package_publish`; "Min side" with markdown and images; native reader with in-package links and images; cap-bound approval; hash cache | app |
| P3 | PDF rendering (D2), owner PDF upload | app |
| P4 | Optional HTML/JS sandbox (D3), `srcdoc` only, with the IPC absence test on iOS WKWebView, macOS WKWebView, Android WebView and WebView2 as a phase gate | app |
| P5 | Polish for first-time readers: plain wording, larger type, one-tap "open page" | app |

Each phase ships behind the capability check; an old node simply shows
today's porch.

## 11. Open decisions

- **D1 Hash algorithm. Decided: BLAKE3.** Consistent with the card, media
  and avatar hashes already in use, so there is one hash code path. The
  manifest keeps `hash_alg`, fixed to `"blake3"`, for future agility; any
  other value is refused (§3.1).
- **D2 PDF.** Rasterise in the host (safe, heavier) or a bundled viewer in a
  sandboxed frame (lighter, larger attack surface). Review recommendation:
  rasterise in the host; a bundled JavaScript viewer in a frame would bring
  P4's attack surface into P3.
- **D3 HTML/JS at all.** Ship native only, or allow sandboxed HTML/JS for
  company pages. Recommendation: native only until P4 has its own review.
- **D4 Manifest cost.** Free with the quote (simpler, slightly more free
  load on the node) or one paid read.
- **D5 App CSP change.** `srcdoc` only is now the design (§7.2), so `blob:`
  is not added. Still open: whether any `frame-src` value is needed for a
  `srcdoc` frame, confirmed on each target webview.
- **D6 Caps.** Defaults for per-file and package caps, cache size, and the
  approval expiry.
- **D7 Pricing shape.** One page price for all files, or per-file prices set
  by the owner (for example free index, paid PDF).
- **D8 Migration.** Keep the card's `cv` and `media` fields as they are, or
  fold them into the manifest once P2 ships.
- **D9 Fetch reply size (open item).** The porch cap of 256 KiB
  (`MAX_BODY_BYTES`) conflicts with 2 MiB images and 5 MiB PDFs (§7). Choose
  a per-fetch cap or chunking for package files before P2; checked before
  base64 decode.
