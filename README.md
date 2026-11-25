# Remotes (Sonor) · v2.4.2

Finds controllable AV kit on the site network (Sky, Denon / Marantz, Yamaha, Onkyo / Pioneer, LG, Samsung, Sony, Roku, Sonos,
PJLink and JVC projectors) and gives each one a remote with only the buttons it supports. Opens on **Discovered**: every device
as a card with its maker's mark (Simple Icons, CC0; wordmark tile where there is none), grouped by Sonor service colour
(03 Video, 02 Audio, 01 Cinema). Tap a card for its remote; Back returns to the list.

> **Renamed 2026-11-24** from *Sky Remote* (repo `sonor-sky-remote` → `sonor-remotes`, folder `APP - Sky Remote` → `APP - Remotes`,
> Pi service `sonor-sky-remote` → `sonor-remotes`, which `pi/install.sh` migrates). Supabase objects keep their `sky_` names
> (internal; renaming them is a schema change). Android id stays `uk.co.sonor.skyremote` so tablets upgrade in place.

Two ways to use the same page:

- **On site (local):** a bridge (Pi, Mac or PC) on the site network serves the page at `http://<bridge-ip>:8049`. Any phone, tablet or laptop on the site Wi-Fi opens it.
- **Hosted:** `https://apps.sonor.co.uk/sonor-remotes/` (Cloudflare login like every Sonor app). Pick a bridge from the list; commands go through Supabase (`sky_commands`) to the bridge, which makes only outbound HTTPS calls, so nothing needs opening on the site router. About half a second per key press.

A browser can't open the TCP connection a Sky box needs, so a bridge on site always does the actual talking.


## v2.4.2 (2026-11-25)
- The shared Sonor project bar replaces the toolbar's own project list (projects with a Network Map plan marked "network plan"). Offline on site the plain picker takes over.

## v2.4.0 (2026-11-24)
- **Handset look, per kind of device**: TVs, Sky and streamers get the D-pad ring, rockers and transport; receivers open on a big volume readout with inputs and sound modes (setup menu folded away); projectors show only power, inputs and picture mute; Sonos shows play controls and volume. Only keys the driver really has are drawn.
- **Two-way feedback**: each driver says what it reads back (`caps.feedback`). After every key the bridge reads the device again, and an open remote refreshes every 4 s (8 s via the relay). The strip shows power, volume, mute, input, mode, lamp hours, with "Live" or "One-way".
- **Device details**: IP and MAC (copy buttons; MAC from the ARP table on discovery, kept on rescans, or from the Network Map), make/model, firmware, serial, control protocol and port, what it reports back.
- **Sky installer menus and Control4 setup checklists** from `public/data/c4-tips.json` (researched with sources; master in project files `remotes/c4-tips.json`). One-tap code buttons for the installer menus.
- **Shared project**: `?pid=` and `sonor_active_project_id` pick the project; picking one writes it back and fires `sonor:project-changed`. Every IP has a ↗ link to the device's web page.
- **Sky Q installer button**: taught once for all Sky Q boxes (Guide always resets the menu: press ▼ until Settings is highlighted, save), then one button runs Guide › ▼ × N › 0 0 1 › Select with pauses. Sky+HD has Services 0 0 1 Select as one button.
- **Known issues** per device (c4-tips.json `issues[]`, 116 researched problems with symptom, fix, sources and how solid the evidence is), searchable by symptom.
- **Checklist → Tasks**: with a project picked and signed in, ticks save to `tasks_general` (one task per device, `external_source` `remotes`, `external_id` `c4setup|<MAC or IP>`, ticks carry who and when), so Tasks, Site and the office see the same progress. Without a project they stay on the device.

## Pi test rig

1. Raspberry Pi OS (Bookworm), on the site network (Ethernet best).
2. Copy this folder to the Pi, then: `sudo bash pi/install.sh "Test rig Pi"`
3. It starts on every boot, serves the local page on port 8049 and links itself to the hosted page under that name.
Logs: `journalctl -u sonor-remotes -f`. The bridge's key is in `/opt/sonor-remotes/relay.json` (delete it to register as a new bridge).

## Supabase

`supabase/migrations/20261124100000_sky_remote_relay.sql`: `sky_bridges` (no table rights for anon; bridges act only through token-checked RPCs `sky_bridge_register / heartbeat / claim / finish`), `sky_commands` (page inserts + reads, 1 hour window, key presses expire after 20 s so they never fire late), view `v_sky_bridges` (never exposes the token hash).

## Run it on a Mac or PC

1. Install Node.js 18 or later (https://nodejs.org) if the machine doesn't have it.
2. Mac: double-click **Start Remotes.command**. Windows: double-click **start.bat**. Or in a terminal: `node server.js`.
3. The page opens at http://localhost:8049. The terminal also prints a LAN address (e.g. `http://192.168.1.20:8049`) to open on a phone.
4. Press **Find devices**. Tap a card, rename it (e.g. "Lounge Sky Q"), and use the remote.

Found boxes are saved in `boxes.json` next to the app.

## What works on each model

| Model | Found by scan | Remote keys over IP | Power/standby status | Notes |
|---|---|---|---|---|
| Sky Q main box (1TB/2TB/UHD) | Yes | Yes, TCP 49160 | Yes (HTTP 9006) | Full support. |
| Sky Q Mini | Yes | Yes, TCP 49160 | Yes (HTTP 9006) | Labelled by the box's reported `deviceType`. Not yet tested on real hardware. |
| Sky+HD (incl. 2TB) | Yes | Yes, TCP 5900 | No | No status API, so power shows "unknown". Box must be connected to the network (Sky+HD often isn't). |
| Sky Q on very old firmware (pre-060) | Yes | Yes, TCP 5900 | Yes | Shown as "Sky+HD (or Sky Q on old firmware)" if the status API is off. |
| Sky Stream puck / Sky Glass | Not yet | **Not yet** | No | They do have IP control (mDNS `_rdk-rics._tcp`, TCP 8091, mutual-TLS + WebSocket, the method Sky's own remote app uses), but it needs Sky's app certificate. Not built in this version. On jobs: Chowmain driver, or IR into the puck's IR window. |

## How it finds boxes

- SSDP (UPnP) search for Sky's NDS device types.
- A sweep of every address on this computer's subnets for ports 49160, 5900 and 9006.
- Each hit is checked: the remote port must answer with the `SKY` banner, so a Mac or PC with VNC/screen sharing on 5900 is never listed as a box.

If the Sky boxes are on another VLAN, open **Add by IP or scan another subnet** and enter that subnet, or add a box by IP. The network must route between them, and SSDP won't cross VLANs on its own.

## If a box won't respond

- **Deep standby (Sky Q "Eco" mode):** in this mode the box stops listening on the network overnight. Set Sky Q power to **Active standby** (Settings > Setup > Preferences > Power) on every box in a rack.
- **Sky+HD:** check it's actually on the network (Settings > Network). Most were installed without a cable.
- Give each box a DHCP reservation so its IP doesn't change.

## Protocol

Remote keys use an RFB-style key protocol: connect, echo the 12-byte `SKY 000.001` banner, echo the first byte of each short reply, then send `[4, 1, 0, 0, 0, 0, 0xE0 + code>>4, code & 0xF]` for press and the same with byte 1 = 0 for release. Codes are in `lib/sky.js` (`KEYS`). Based on the open-source `sky-remote` and `pyskyqremote` projects. Sky doesn't document this and could change it in a firmware update.

## Test

`node test/test.js` (Linux) runs simulated Sky Q, Sky+HD and VNC hosts on loopback addresses and checks discovery and the exact key bytes.
`test/pgrest-shim.js` is a tiny PostgREST stand-in (runs as role `anon` against a local Postgres with the migration applied) used to test the relay end to end: add a box and send keys through the hosted page path, about 0.5 s per key.

## Demo
Open `public/?demo=1` (no bridge needed): four sample boxes, keys are shown instead of sent. The Master Hub Android Utilities card links here.
