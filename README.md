# Sky Remote (Sonor) · v1.3.0

Finds Sky boxes on the local network and controls them over IP, for racks where the Sky remote can't reach.
Internal test tool (projects use the Chowmain Control4 driver).

Two ways to use the same page:

- **On site (local):** a bridge (Pi, Mac or PC) on the site network serves the page at `http://<bridge-ip>:8049`. Any phone, tablet or laptop on the site Wi-Fi opens it.
- **Hosted:** `https://apps.sonor.co.uk/sonor-sky-remote/` (Cloudflare login like every Sonor app). Pick a bridge from the list; commands go through Supabase (`sky_commands`) to the bridge, which makes only outbound HTTPS calls, so nothing needs opening on the site router. About half a second per key press.

A browser can't open the TCP connection a Sky box needs, so a bridge on site always does the actual talking.

## Pi test rig

1. Raspberry Pi OS (Bookworm), on the site network (Ethernet best).
2. Copy this folder to the Pi, then: `sudo bash pi/install.sh "Test rig Pi"`
3. It starts on every boot, serves the local page on port 8049 and links itself to the hosted page under that name.
Logs: `journalctl -u sonor-sky-remote -f`. The bridge's key is in `/opt/sonor-sky-remote/relay.json` (delete it to register as a new bridge).

## Supabase

`supabase/migrations/20261124100000_sky_remote_relay.sql`: `sky_bridges` (no table rights for anon; bridges act only through token-checked RPCs `sky_bridge_register / heartbeat / claim / finish`), `sky_commands` (page inserts + reads, 1 hour window, key presses expire after 20 s so they never fire late), view `v_sky_bridges` (never exposes the token hash).

## Run it on a Mac or PC

1. Install Node.js 18 or later (https://nodejs.org) if the machine doesn't have it.
2. Mac: double-click **Start Sky Remote.command**. Windows: double-click **start.bat**. Or in a terminal: `node server.js`.
3. The page opens at http://localhost:8049. The terminal also prints a LAN address (e.g. `http://192.168.1.20:8049`) to open on a phone.
4. Press **Find boxes**. Pick a box, rename it (e.g. "Lounge Sky Q"), and use the remote.

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
