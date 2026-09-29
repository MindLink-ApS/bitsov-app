# 1:1 calls (regtest prototype)

- **Media** goes directly between the two apps (WebRTC in the webview). It never passes through a node and is not billed.
- **Signalling** is four paid messages through your node: offer (the callee's call price, once per call), answer, ICE, hangup (the realtime price each). Same budget, approval and exactly-once rules as messages. Only contacts you have already paid can be called.
- **No third party by default.** The app ships no STUN or TURN server. With none set, calls use host candidates only, so they connect on the same network (or over a VPN).
- **Calls across routers (NAT)** need a STUN server you choose: Settings → Display → Calls, `stun:host` or `stun:host:port`. That server learns your public IP address each time you place or accept a call. A good choice later is one run on your own node. TURN relays are not supported (a relay would carry your media), so pairs behind symmetric NAT or carrier-grade NAT will not connect.
- **Ending a call:** Hang up pays one hangup message. Cancel while calling pays nothing if the offer has not gone out; if it is already being paid, the microphone stops at once and nothing more is sent. Closing the window, a lost connection (10 s grace) or a call that never connects (30 s) end the call locally without paying.
- **Camera off** stops the camera (its light goes off); camera on captures it again.
- Checks: `scripts/calls/media-check.py` (real WebRTC in Chromium through the app's call engine, loopback only) and `scripts/calls/regtest-demo.sh <genome>` (paid signalling on regtest plus the media check).
