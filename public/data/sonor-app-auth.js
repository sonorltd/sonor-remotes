/* sonor-app-auth.js — site tablet apps sign in AS THE PERSON (v1.0.0, 2026-11-24)
 * Master: APP - Android Apps/shared/sonor-app-auth.js → copied to each app's public/data/ (bash shared/copy-shared.sh;
 * registry-check.sh flags a copy that drifts).
 * Bryn: "androind apps should sync with all data whereever it is done and logged in user tracking".
 *
 * On the web (apps.sonor.co.uk) the gateway already signs every call in, so this does nothing there.
 * In the Android app the page runs from the tablet (works offline), so:
 *   1. SonorAppAuth.signIn() opens https://apps.sonor.co.uk/__sonor/app-login?app=<key> in the tablet's browser;
 *      Cloudflare Access asks for the email code (same login as the Mac), the gateway hands the person's OWN
 *      Supabase session back through the app's link (<android id>://auth#access_token=…).
 *   2. The app passes that link to the page (window event 'sonorauth', or the SonorAuth plugin's takeAuth() on a cold start).
 *   3. Every Supabase call then carries the person's signed JWT (+ x-sonor-user / x-sonor-app like the gateway), so RLS,
 *      audit_log and "who scanned / who reviewed" are the same as on the Mac. The session refreshes itself.
 *
 *   SonorAppAuth.init({ app: 'net-scanner', label: 'Network Scanner' })
 *   SonorAppAuth.active   → true inside the Android app (false on the web: the gateway does it)
 *   SonorAppAuth.user()   → { email } | null
 *   await SonorAppAuth.headers() → { Authorization, x-sonor-user, x-sonor-app } (refreshed) or {} when signed out
 *   SonorAppAuth.signIn() · SonorAppAuth.signOut() · SonorAppAuth.onChange(fn)
 */
(function (root) {
  'use strict';
  var SB = 'https://ysmvklstkzodlocttspy.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzbXZrbHN0a3pvZGxvY3R0c3B5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3Njc0OTMsImV4cCI6MjA4OTM0MzQ5M30.08kRS_dtbwz0rSYezNGMJHnOU_st8GKZseQPefcMEMc';
  var GATE = 'https://apps.sonor.co.uk/__sonor/app-login';
  var KEY = 'sonor-app-session', app = '', subs = [], refreshing = null;
  var cap = root.Capacitor;
  var active = !!(cap && cap.isNativePlatform && cap.isNativePlatform()) && !/(^|\.)sonor\.co\.uk$/.test(root.location.hostname);
  function load() { try { return JSON.parse(root.localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(s) { try { if (s) root.localStorage.setItem(KEY, JSON.stringify(s)); else root.localStorage.removeItem(KEY); } catch (e) { } subs.forEach(function (f) { try { f(s ? { email: s.email } : null); } catch (e) { } }); }
  function fromLink(href) {
    var i = String(href || '').indexOf('#'); if (i < 0) return false;
    var q = new URLSearchParams(href.slice(i + 1)); var at = q.get('access_token'); if (!at) return false;
    save({ email: q.get('email') || '', access_token: at, refresh_token: q.get('refresh_token') || '', expires_at: Number(q.get('expires_at')) || 0 });
    return true;
  }
  async function refresh(s) {
    if (!s || !s.refresh_token) return null;
    var r = await fetch(SB + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
    if (r.status === 400 || r.status === 401) { save(null); return null; }   // refresh token gone (signed out / user disabled)
    if (!r.ok) return s;                                                   // offline or a hiccup: keep the old one, try again later
    var j = await r.json(); var n = { email: s.email, access_token: j.access_token, refresh_token: j.refresh_token || s.refresh_token, expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)) };
    save(n); return n;
  }
  async function current() {
    var s = load(); if (!s) return null;
    if (s.expires_at && s.expires_at - 120 < Date.now() / 1000) { if (!refreshing) refreshing = refresh(s).catch(function () { return s; }).finally(function () { refreshing = null; }); s = await refreshing; }
    return s;
  }
  var api = {
    get active() { return active; },
    init: function (o) {
      app = (o && o.app) || app;
      if (!active) return api;
      root.addEventListener('sonorauth', function (e) { if (fromLink(e && e.detail && e.detail.url)) root.dispatchEvent(new Event('sonorauth-done')); });
      var P = cap.Plugins || {}; var p = P.SonorAuth;   // a cold start by the sign-in link: the app kept the link for us
      if (p && p.takeAuth) p.takeAuth().then(function (r) { if (r && r.url) fromLink(r.url); }).catch(function () { });
      return api;
    },
    user: function () { var s = load(); return s ? { email: s.email } : null; },
    headers: async function () {
      if (!active) return {};
      var s = await current(); if (!s) return {};
      var h = { Authorization: 'Bearer ' + s.access_token }; if (s.email) h['x-sonor-user'] = s.email; if (app) h['x-sonor-app'] = app; return h;
    },
    signIn: function () { var u = GATE + '?app=' + encodeURIComponent(app); var P = (cap && cap.Plugins) || {}; var p = P.SonorAuth; if (p && p.openBrowser) p.openBrowser({ url: u }); else root.open(u, '_system'); },
    signOut: function () { save(null); },
    onChange: function (f) { subs.push(f); },
    _fromLink: fromLink,
  };
  root.SonorAppAuth = api;
})(typeof self !== 'undefined' ? self : this);
