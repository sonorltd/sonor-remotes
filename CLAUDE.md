# APP - Remotes (sonor-remotes) · v2.4.2

> Current version: 2.4.2 (2026-11-25). One constant per surface: `APP_VERSION` in public/index.html, `VERSION` in server.js. The Android app (`APP - Android Apps/remotes`, id stays `uk.co.sonor.skyremote`) carries the same number in `versionName`.

IP remotes for the AV kit on a site network (Sky, AVRs, TVs, projectors, Sonos…), with Control4 setup checklists and known issues per device. Renamed from Sky Remote 2026-11-24; Hub / registry key stays `sky-remote`. Detail: README.md.

## Spine / platform
- Spine version: 1.2.6 pattern (pre-shell): sonor-header, sonor-theme (graphite), brand.css, served kit, the shared SonorProjectBar (`?pid=`, `sonor_active_project_id`, `sonor:project-changed`), `app_versions` self-report (app_key `sky-remote`), sonor-app-auth for the Android app.
- Hub group **android**. Favicon = `data/favicons/android.svg` copied to public/data/favicon.svg.
- The page loads **public/data/**. sync-everything.sh refreshes every shared file already there from its master; never hand-edit a copy.
- Runs as: a bridge on site (`node server.js`, port 8049), the Android app, and apps.sonor.co.uk/sonor-remotes/public/ (opens the demo: see Relay below). The Android copy `APP - Android Apps/remotes/web` is a **mirror** of public/ made by sync-everything.sh (`android-mirrors.tsv`): edit here only.

## Shared seams consumed
- `network_configs` (Network Map plan: project list, device names, MACs), `tasks_general`, `app_versions`.
- `public/data/c4-tips.json`: this app owns the master; the Terminal app takes a copy (`APP - Android Apps/shared/copy-shared.sh`).
- Shared files: sonor-header.*, sonor-theme.js, sonor-vocab.css, brand.css, sonor-brand.js, sonor-project-bus/list/bar.js, sonor-wireless.js, sonor-app-auth.js.

## Brand overrides
None. Maker marks are Simple Icons (CC0).

## Data: where it lives
- On the bridge / tablet: `remote.json` (devices, drivers, pairing keys, PSKs). Pairing secrets stay on the device on purpose.
- **Relay (hosted page → site bridge) is NOT live:** migration `supabase/migrations/20261124100000_sky_remote_relay.sql` (`sky_bridges`, `sky_commands`) has never been applied, and as written it lets the anon key insert and read commands. Before applying: signed-in only policies (net_scans pattern), a bridge credential, and the owner's yes. Until then the hosted page is demo only.
- **Open (CROSS-APP-CONTRACTS Notices):** upsert found devices to `site_findings` (source_app `remotes`); read radio roles through `SonorWireless.radioOf` and `projects.metadata.wireless_plan`.

## Rules
- Keys are never sent in demo mode. Port 8049.
- Sign-in: the gateway on the web, sonor-app-auth on Android; never a second login.
- Supabase objects keep their `sky_` names (renaming is a schema change). Schema changes need the owner's yes first.

## Timeline
- 2.4.2 (2026-11-25): universal project bar. 2.4.0 (2026-11-24): handset look per device kind, two-way feedback, C4 checklists, known issues, shared project.
- 2.2.0: demo with every device type. 2.1.0 (2026-11-24): renamed Remotes, maker logos, Discovered page. 1.x: Sky Remote.
