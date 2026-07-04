# Steward on your phone (Tailscale + PWA + push)

Reach Steward from your phone — full conversations, action approvals, and push
notifications — without exposing your Mac to the internet and without an Apple
Developer account. The agent stays on the Mac; the phone is a client.

## How it fits together

- **Transport = Tailscale**: a private WireGuard network between your Mac and
  phone. The phone reaches the Mac's host at its tailnet address, from anywhere.
- **Client = the web UI as an installable PWA**: add it to the Home screen; it
  renders the mobile-adapted UI and receives Web Push.
- **Auth = a shared token**: the WS + data routes require it. The Mac's own
  browser auto-pairs; the phone pairs once by scanning a QR.
- **Push = standard Web Push (VAPID)**: the host pings the phone when an
  action-center proposal needs approval — works even with the app closed, as long
  as the Mac is awake and online.

## One-time setup

1. **Install Tailscale** on the Mac and the phone; sign both into the same
   account. On the Mac, note its tailnet name (Tailscale menu → "This device",
   e.g. `macbook.tailXXXX.ts.net`) or its `100.x.y.z` address. In the Tailscale
   admin console, **disable key expiry** for both devices so the connection
   survives without periodic re-login.

2. **Let the host listen on the tailnet**, not just localhost. Start it with:
   ```
   STEWARD_BIND_HOST=0.0.0.0 npm run dev -w @steward/host
   ```
   (Or set `STEWARD_BIND_HOST=0.0.0.0` in the launcher's
   `~/Library/Application Support/Steward/config.env`.) The default stays
   `127.0.0.1` — nothing is exposed unless you set this.

   Same-origin requests are accepted automatically, so you do **not** need to
   list the tailnet address anywhere. (To pin it further you still can, via
   `HOST_ALLOWED_ORIGINS`.)

3. **On the phone**, open `http://<mac-tailnet-name>:4317` in Safari/Chrome.
   The app loads and shows a pairing screen.

4. **Pair**: on the Mac, open Steward → **System** page → "Connetti il telefono".
   Scan the QR with the phone (it carries the token). The phone stores it and
   connects. (Or type the token shown there.)

5. **Add to Home Screen** (Safari → Share → Add to Home Screen). Launch Steward
   from the icon — it runs full-screen like an app.

6. **Enable notifications**: System page → **Attiva notifiche** (must be a tap —
   iOS requires a user gesture, and the app must be launched from the Home
   screen, iOS 16.4+). You'll now get a push when a proposal needs approval;
   tapping it opens Steward on that proposal.

## Keeping it reachable

- **The Mac must be awake.** If it sleeps, the phone can't reach the host and the
  host can't send proactive pushes. Prevent sleep (System Settings → Displays →
  Advanced → "Prevent automatic sleeping when the display is off", or run
  `caffeinate -s`), or accept that Steward answers only when the Mac is awake.
- **Auto-start the host** so it comes back after a reboot: enable it from the
  System page (Autostart) — the launcher registers a login item.
- After a reboot of either device, Tailscale reconnects on its own and the app's
  socket auto-reconnects — nothing to redo.

## Security notes

- The static app shell and `/health` are open; every **data** route and the
  WebSocket require the auth token. A device that isn't paired (no token) can't
  drive the agent even on your tailnet.
- The token lives only on your paired devices (localStorage on the phone, a file
  in the Steward config dir on the Mac). Re-pair to rotate it (delete
  `~/Library/Application Support/Steward/auth-token` to force a new one).
- Content the agent reasons over still goes to the LLM gateway/DeepSeek as usual
  — Tailscale secures the *transport to your Mac*, not what the agent sends
  onward.
