> **Moved (2026-11-24):** the tablet app is now built from `sonor-android-apps/remotes/` (signed APK by GitHub Actions). This folder is the old copy; change the page in `public/`, then re-copy it to `APP - Android Apps/remotes/web`.

# Remotes phone app (Android)

> Renamed from Sky Remote in v2.1.0. The Android id stays `uk.co.sonor.skyremote` so installed copies upgrade in place.

The same remote page as the web app, wrapped as an Android app. The app opens the TCP connection to the Sky box itself (plugin `SkyTcp`, `android/app/src/main/java/uk/co/sonor/skyremote/SkyTcpPlugin.java`), so on site there's **no Pi or laptop needed**: join the site Wi-Fi, open the app, press Find boxes.

The page detects the app (`public/native.js`) and runs discovery and key sending on the phone. Boxes are saved on the phone.

## Build the APK (Mac, one time setup)

1. Install Android Studio (it brings the Android SDK and Java).
2. In this folder: `npm install`
3. `npm run apk`: copies `../public` into the app, syncs, builds a debug APK at `android/app/build/outputs/apk/debug/app-debug.apk`.
4. Copy the APK to the phone (AirDrop doesn't do Android: use Google Drive, email or USB) and open it. Allow "install unknown apps" once.

Or `npm run android` to open it in Android Studio and press Run with the phone plugged in.

## iPhone

Not set up yet. Same approach (`npx cap add ios` + a Swift version of `SkyTcp`), but it needs Xcode and an Apple Developer account to put it on phones through TestFlight.

## Tested

- The Java key protocol was compiled and run against a simulated Sky Q (exact bytes checked) and refuses a VNC host.
- `native.js` was run in a browser with the plugin mocked: scan found the simulated Sky Q, channel entry sent the right keys.
- The APK itself hasn't been built yet (the Android SDK isn't available in the cloud). First build happens on the Mac.
