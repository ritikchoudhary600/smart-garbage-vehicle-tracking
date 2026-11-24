/**
 * deviceAccess.js — browser permissions the app relies on
 *
 *   location       Drivers share live GPS from their phone; residents pin their home.
 *   notifications  The 500 m alert, pickup updates and delay notices reach the user
 *                  even when this tab is in the background.
 *   sound          Browsers keep audio muted until the user taps something, so the
 *                  arrival chime has to be switched on once.
 *   wakeLock       Keeps a driver's screen on while sharing GPS (phones stop GPS
 *                  updates in the browser once the screen locks).
 *
 * Every prompt is triggered by a click, never on page load: browsers block or
 * auto-deny permission prompts that appear without a user gesture.
 * Exposes window.DeviceAccess.
 */
(function () {
  'use strict';

  const hasGeo    = 'geolocation' in navigator;
  const hasNotify = 'Notification' in window;
  const hasWake   = 'wakeLock' in navigator;
  const hasSW     = 'serviceWorker' in navigator && window.isSecureContext;

  const listeners = new Set();
  function emit() { listeners.forEach(fn => { try { fn(); } catch (e) { /* listener error */ } }); }

  let soundUnlocked = false;
  let wakeLock = null;
  let wakeWanted = false;
  let swReg = null;

  /* ── Service worker: shows notifications (required on Android Chrome) ── */
  async function registerServiceWorker() {
    if (!hasSW) return null;
    try {
      swReg = await navigator.serviceWorker.register('/sw.js');
      return swReg;
    } catch (err) {
      console.warn('Service worker registration failed:', err);
      return null;
    }
  }

  /* ── Watch permission changes made in the browser's site settings ───── */
  async function watchPermission(name) {
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      const status = await navigator.permissions.query({ name });
      status.addEventListener('change', emit);
    } catch (e) { /* not queryable in this browser */ }
  }
  watchPermission('geolocation');
  watchPermission('notifications');

  /* ── Status: 'granted' | 'denied' | 'prompt' | 'unsupported' ─────────── */
  async function status(kind) {
    switch (kind) {
      case 'location': {
        if (!hasGeo || !window.isSecureContext) return 'unsupported';
        if (!navigator.permissions || !navigator.permissions.query) return 'prompt';
        try { return (await navigator.permissions.query({ name: 'geolocation' })).state; }
        catch (e) { return 'prompt'; }
      }
      case 'notifications': {
        if (!hasNotify) return 'unsupported';
        const p = Notification.permission;
        return p === 'default' ? 'prompt' : p;
      }
      case 'sound':
        if (!(window.AudioContext || window.webkitAudioContext)) return 'unsupported';
        return soundUnlocked ? 'granted' : 'prompt';
      case 'wakeLock':
        if (!hasWake) return 'unsupported';
        return localStorage.getItem('sgt.wakeLock') === '0' ? 'prompt' : 'granted';
      default:
        return 'unsupported';
    }
  }

  /* ── Requests (call from a click handler) ─────────────────────────────── */
  async function request(kind) {
    switch (kind) {
      case 'location':
        await getPosition({ timeout: 15000 });
        break;
      case 'notifications':
        if (hasNotify) await Notification.requestPermission();
        if (Notification.permission === 'granted') await registerServiceWorker();
        break;
      case 'sound':
        unlockSound(true);
        break;
      case 'wakeLock':
        try { localStorage.setItem('sgt.wakeLock', '1'); } catch (e) { /* storage unavailable */ }
        break;
    }
    emit();
    return status(kind);
  }

  function unlockSound(withTestChime) {
    if (window.audioChime) {
      window.audioChime.init();
      const ctx = window.audioChime.audioCtx;
      if (ctx && ctx.state === 'suspended') ctx.resume();
      if (withTestChime) window.audioChime.playChime('pickup_collected');
    }
    soundUnlocked = true;
    emit();
  }
  // Any first tap on the page also unlocks the chime
  window.addEventListener('pointerdown', () => { if (!soundUnlocked) unlockSound(false); }, { once: true });

  /* ── Location ─────────────────────────────────────────────────────────── */
  function geoError(err) {
    const messages = {
      1: 'Location access is blocked. Allow it for this site in your browser settings, then try again.',
      2: 'Your device could not find its location. Check that location services are on.',
      3: 'Finding your location took too long. Try again outdoors or with Wi-Fi on.',
    };
    const e = new Error(messages[err && err.code] || (err && err.message) || 'Location unavailable');
    e.code = err && err.code;
    return e;
  }

  function getPosition(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!hasGeo) return reject(new Error('This browser does not support location.'));
      if (!window.isSecureContext) return reject(new Error('Location only works over HTTPS (or on localhost).'));
      navigator.geolocation.getCurrentPosition(
        pos => { emit(); resolve(toFix(pos)); },
        err => { emit(); reject(geoError(err)); },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000, ...opts });
    });
  }

  function toFix(pos) {
    const c = pos.coords;
    return {
      lat: c.latitude, lon: c.longitude,
      accuracy: c.accuracy,
      speedKmh: c.speed != null && c.speed >= 0 ? c.speed * 3.6 : null,
      heading: c.heading,
      at: pos.timestamp || Date.now(),
    };
  }

  /* ── Live GPS for drivers ─────────────────────────────────────────────
     Sends a fix at most every MIN_INTERVAL_MS unless the truck has moved
     MIN_MOVE_M; drops fixes too inaccurate to place the truck on a street. */
  const MIN_INTERVAL_MS = 4000;
  const MIN_MOVE_M      = 15;
  const MAX_ACCURACY_M  = 150;

  const live = { watchId: null, last: null, lastSent: null, onFix: null, onState: null, error: null };

  function startLiveTracking({ onFix, onState }) {
    stopLiveTracking();
    if (!hasGeo) throw new Error('This browser does not support location.');
    if (!window.isSecureContext) throw new Error('Live GPS needs HTTPS (or localhost).');
    Object.assign(live, { onFix, onState, last: null, lastSent: null, error: null });

    live.watchId = navigator.geolocation.watchPosition(
      pos => {
        const fix = toFix(pos);
        live.last = fix;
        live.error = null;
        if (fix.accuracy > MAX_ACCURACY_M) { notifyState(); return; }

        const prev = live.lastSent;
        const moved = prev ? window.GeoUtils.calculateHaversineDistance(prev.lat, prev.lon, fix.lat, fix.lon) : Infinity;
        if (prev && fix.at - prev.at < MIN_INTERVAL_MS && moved < MIN_MOVE_M) { notifyState(); return; }

        if (fix.speedKmh == null && prev) {
          const dt = (fix.at - prev.at) / 1000;
          fix.speedKmh = dt > 0 ? Math.min(90, (moved / dt) * 3.6) : 0;
        }
        live.lastSent = fix;
        if (live.onFix) live.onFix(fix);
        notifyState();
      },
      err => {
        live.error = geoError(err);
        notifyState();
        if (err.code === 1) stopLiveTracking();
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });

    acquireWakeLock();
    notifyState();
  }

  function stopLiveTracking() {
    if (live.watchId != null) navigator.geolocation.clearWatch(live.watchId);
    const wasOn = live.watchId != null;
    live.watchId = null;
    releaseWakeLock();
    if (wasOn) notifyState();
    emit();
  }

  function notifyState() {
    if (live.onState) live.onState(liveState());
  }

  function liveState() {
    return {
      active: live.watchId != null,
      last: live.last, lastSent: live.lastSent,
      error: live.error,
      wakeLock: !!wakeLock,
      inaccurate: !!(live.last && live.last.accuracy > MAX_ACCURACY_M),
    };
  }

  /* ── Screen wake lock (re-acquired when the tab becomes visible again) ── */
  async function acquireWakeLock() {
    wakeWanted = true;
    if (!hasWake || localStorage.getItem('sgt.wakeLock') === '0' || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; notifyState(); });
      notifyState();
    } catch (e) { /* denied (battery saver) or tab hidden */ }
  }
  function releaseWakeLock() {
    wakeWanted = false;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeWanted) acquireWakeLock();
  });

  /* ── System notifications (only while the tab is hidden; the page shows
        its own toast and chime when it is visible) ─────────────────────── */
  async function notify(title, body, { tag, force = false, vibrate = false } = {}) {
    if (vibrate && navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) { /* ignore */ } }
    if (!hasNotify || Notification.permission !== 'granted') return false;
    if (!force && document.visibilityState === 'visible') return false;
    const opts = { body, tag, icon: '/favicon.svg', badge: '/favicon.svg', renotify: !!tag };
    try {
      const reg = swReg || (hasSW ? await navigator.serviceWorker.getRegistration() : null);
      if (reg) { await reg.showNotification(title, opts); return true; }
      new Notification(title, opts);
      return true;
    } catch (e) {
      console.warn('Notification failed:', e);
      return false;
    }
  }

  // Re-use an existing registration so notifications work after a reload
  if (hasNotify && Notification.permission === 'granted') registerServiceWorker();

  window.DeviceAccess = {
    supported: { location: hasGeo, notifications: hasNotify, wakeLock: hasWake, serviceWorker: hasSW },
    status, request, getPosition, notify,
    startLiveTracking, stopLiveTracking, liveState,
    unlockSound,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
