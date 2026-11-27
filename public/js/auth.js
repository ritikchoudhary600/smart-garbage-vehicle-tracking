/**
 * auth.js — Sign-in gate, Admin Login, and app start-up
 *
 * With Supabase configured:
 *   - "Sign in with Google" (Supabase Auth, PKCE flow) for Residents & Drivers
 *   - "Admin sign in" (Supabase Auth Email/Password + backend role check via `me()`)
 *     exclusively for active Admins; public admin registration is never allowed.
 * Without Supabase configured:
 *   - Resident, Driver & Split Demo remain accessible in offline demo mode (`role: 'demo'`).
 *   - Admin Dashboard stays protected: the Admin Login page explains the backend
 *     configuration required rather than storing plain-text credentials in frontend code.
 * Exposes window.Auth.
 */
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);
  const DEMO_KEY = 'sgt.demoSession';
  const ADMIN_HASHES = new Set(['#admin', '#control', '#admin-login']);

  const byId = (id) => document.getElementById(id);

  const Auth = {
    configured,
    client: null,
    session: null,
    profile: null,
    mode: null,
    signInWithGoogle,
    openAdminLogin,
    signOut,
  };
  window.Auth = Auth;

  let adminLoginInFlight = false;

  /* ── Gate screens ─────────────────────────────────────────────────────── */
  function showGate(state, { message = '', email = '' } = {}) {
    document.body.classList.add('is-gated');
    const gate = byId('auth-gate');
    gate.dataset.state = state;

    const gateErr = byId('gate-error');
    if (gateErr) {
      gateErr.textContent = message;
      gateErr.hidden = !message;
    }

    const adminErr = byId('admin-login-error');
    if (adminErr) {
      adminErr.textContent = state === 'admin-signin' ? message : '';
      adminErr.hidden = state !== 'admin-signin' || !message;
    }

    const setupNotice = byId('admin-backend-notice');
    if (setupNotice) {
      setupNotice.hidden = configured || state !== 'admin-signin';
    }

    document.querySelectorAll('.val-gate-email').forEach(el => { el.textContent = email; });
    setBusy(false);
    setAdminBusy(false);
  }

  function setBusy(busy) {
    const btn = byId('btn-google-signin');
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
  }

  function setAdminBusy(busy) {
    const btn = byId('btn-admin-login-submit');
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
    btn.textContent = busy ? 'Verifying credentials…' : 'Sign in to Admin Dashboard';
  }

  function clearAdminFieldErrors() {
    ['admin-login-email', 'admin-login-password'].forEach(id => {
      const el = byId(id);
      if (el) el.classList.remove('is-invalid');
    });
    ['admin-email-error', 'admin-password-error', 'admin-login-error'].forEach(id => {
      const el = byId(id);
      if (el) { el.textContent = ''; el.hidden = true; }
    });
  }

  function openAdminLogin(message = '') {
    clearAdminFieldErrors();
    showGate('admin-signin', { message });
    const emailEl = byId('admin-login-email');
    if (emailEl) setTimeout(() => emailEl.focus(), 50);
  }

  // Drop the OAuth ?code / ?error parameters once they have been handled
  function cleanUrl() {
    const url = new URL(window.location.href);
    let changed = false;
    for (const k of ['code', 'state', 'error', 'error_code', 'error_description']) {
      if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true; }
    }
    if (changed) history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  /* ── Start the app for a signed-in person ─────────────────────────────── */
  async function launch(profile, store, targetHash = '') {
    Auth.profile = profile;
    window.AppDataStore = store;
    await store.load();
    document.body.classList.remove('is-gated');
    if (targetHash) history.replaceState(null, '', targetHash);
    window.app = new window.SmartWasteApp(profile);
    window.app.init();
  }

  // The demo lasts for this tab only (a reload stays in it; a new visit shows
  // the sign-in page again), and never grants Admin access
  function demoRemembered() {
    try { return sessionStorage.getItem(DEMO_KEY) === '1'; } catch (e) { return false; }
  }
  function forgetDemo() {
    try { sessionStorage.removeItem(DEMO_KEY); localStorage.removeItem(DEMO_KEY); } catch (e) { /* storage unavailable */ }
  }

  function launchDemo() {
    if (window.app) {
      document.body.classList.remove('is-gated');
      return;
    }
    try { sessionStorage.setItem(DEMO_KEY, '1'); } catch (e) { /* storage unavailable */ }
    Auth.mode = 'demo';
    const store = window.AppDataStore;
    const demoProfile = {
      id: 'demo-visitor',
      fullName: 'Demo Visitor',
      email: 'demo@ward4.local',
      role: 'demo',
      status: 'active',
      avatarUrl: null,
    };
    return launch(demoProfile, store);
  }

  let entering = false;
  async function enter(targetHash = '') {
    if (entering) return;
    entering = true;
    showGate('loading');
    try {
      const { data, error } = await Auth.client.rpc('me');
      if (error) throw new Error(window.SupabaseStore.friendlyError(error));
      const profile = window.SupabaseStore.mapProfile(data);
      Auth.profile = profile;
      Auth.mode = 'supabase';
      if (profile.status === 'suspended') { entering = false; return showGate('suspended', { email: profile.email }); }
      if (profile.role === 'pending')     { entering = false; return showGate('pending',   { email: profile.email }); }

      // Protect #admin-login / #admin / #control from Resident & Driver sessions
      if (window.location.hash === '#admin-login' && profile.role !== 'admin') {
        await Auth.client.auth.signOut();
        Auth.session = null;
        Auth.profile = null;
        entering = false;
        return openAdminLogin(`Access denied: ${profile.email} has role "${profile.role}". Sign in with an Admin account.`);
      }

      const route = window.AppDataStore.simulation.route;
      await launch(profile, new window.SupabaseStore(Auth.client, profile, route), targetHash);
    } catch (err) {
      entering = false;
      console.error(err);
      showGate('signin', { message: `Could not open your account: ${err.message}` });
    }
  }

  /* ── Actions ──────────────────────────────────────────────────────────── */
  async function signInWithGoogle() {
    if (!configured) {
      showGate('signin', {
        message: 'Google sign-in turns on once Supabase is connected (see README, "Deploy on Supabase"). You can explore the Resident & Driver demo meanwhile.',
      });
      return;
    }
    setBusy(true);
    const { error } = await Auth.client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) showGate('signin', { message: error.message });
  }

  async function handleAdminLoginSubmit(e) {
    e.preventDefault();
    clearAdminFieldErrors();

    const emailEl = byId('admin-login-email');
    const passEl  = byId('admin-login-password');
    const email   = emailEl ? emailEl.value.trim() : '';
    const pass    = passEl ? passEl.value : '';

    let valid = true;
    if (!email) {
      byId('admin-email-error').textContent = 'Admin email is required.';
      byId('admin-email-error').hidden = false;
      emailEl.classList.add('is-invalid');
      valid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      byId('admin-email-error').textContent = 'Enter a valid email address.';
      byId('admin-email-error').hidden = false;
      emailEl.classList.add('is-invalid');
      valid = false;
    }

    if (!pass) {
      byId('admin-password-error').textContent = 'Password is required.';
      byId('admin-password-error').hidden = false;
      passEl.classList.add('is-invalid');
      valid = false;
    }
    if (!valid) return;

    if (!configured) {
      const errBox = byId('admin-login-error');
      errBox.textContent = 'Backend authentication is not configured. Configure Supabase environment variables and an Admin user first (see instructions above).';
      errBox.hidden = false;
      return;
    }

    setAdminBusy(true);
    adminLoginInFlight = true;
    try {
      const { data, error } = await Auth.client.auth.signInWithPassword({ email, password: pass });
      if (error) {
        const errBox = byId('admin-login-error');
        errBox.textContent = /invalid login credentials/i.test(error.message)
          ? 'Invalid admin email or password.'
          : error.message;
        errBox.hidden = false;
        return;
      }

      // Verify Admin role via backend RPC & RLS before opening dashboard
      const { data: meData, error: meError } = await Auth.client.rpc('me');
      if (meError) throw new Error(window.SupabaseStore.friendlyError(meError));
      const profile = window.SupabaseStore.mapProfile(meData);

      if (profile.status === 'suspended') {
        await Auth.client.auth.signOut();
        Auth.session = null;
        Auth.profile = null;
        const errBox = byId('admin-login-error');
        errBox.textContent = 'This account is suspended. Contact your municipal administrator.';
        errBox.hidden = false;
        return;
      }

      if (profile.role !== 'admin') {
        await Auth.client.auth.signOut();
        Auth.session = null;
        Auth.profile = null;
        const errBox = byId('admin-login-error');
        errBox.textContent = `Access denied: Account role is "${profile.role}". Only authorized Admins can access the Municipal Admin Dashboard.`;
        errBox.hidden = false;
        return;
      }

      forgetDemo();
      Auth.session = data.session;
      passEl.value = '';
      if (window.app) {
        // Reload cleanly into full Admin view if demo was previously mounted
        history.replaceState(null, '', '#admin');
        window.location.reload();
        return;
      }
      await enter('#admin');
    } catch (err) {
      console.error(err);
      const errBox = byId('admin-login-error');
      errBox.textContent = err.message || 'Could not complete admin sign-in.';
      errBox.hidden = false;
    } finally {
      adminLoginInFlight = false;
      setAdminBusy(false);
    }
  }

  async function signOut() {
    if (window.DeviceAccess) window.DeviceAccess.stopLiveTracking();
    if (window.AppSimulatorEngine) window.AppSimulatorEngine.stop();
    forgetDemo();
    if (Auth.mode !== 'demo' && configured && Auth.client) await Auth.client.auth.signOut();
    window.location.replace(window.location.pathname);
  }

  function wireAdminPaneControls() {
    const openBtn = byId('btn-open-admin-login');
    if (openBtn) openBtn.addEventListener('click', () => openAdminLogin());

    const backBtn = byId('btn-back-signin');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (window.app && Auth.mode === 'demo') {
          document.body.classList.remove('is-gated');
          if (ADMIN_HASHES.has(window.location.hash)) history.replaceState(null, '', '#resident');
        } else {
          showGate('signin');
        }
      });
    }

    const pwToggle = byId('btn-toggle-admin-password');
    const pwInput  = byId('admin-login-password');
    if (pwToggle && pwInput) {
      pwToggle.addEventListener('click', () => {
        const show = pwInput.type === 'password';
        pwInput.type = show ? 'text' : 'password';
        pwToggle.setAttribute('aria-pressed', String(show));
        pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        pwToggle.title = show ? 'Hide password' : 'Show password';
      });
    }

    const form = byId('admin-login-form');
    if (form) form.addEventListener('submit', handleAdminLoginSubmit);
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */
  async function start() {
    byId('btn-google-signin').addEventListener('click', signInWithGoogle);
    byId('btn-demo').addEventListener('click', () => { launchDemo(); });
    document.querySelectorAll('.btn-gate-signout').forEach(b => b.addEventListener('click', signOut));
    byId('btn-gate-recheck').addEventListener('click', () => enter());
    wireAdminPaneControls();

    const gate = byId('auth-gate');
    gate.classList.toggle('is-demo', !configured);
    try { localStorage.removeItem(DEMO_KEY); } catch (e) { /* older versions kept the demo flag here */ }

    const wantsAdminGate = ADMIN_HASHES.has(window.location.hash);

    if (!configured) {
      if (wantsAdminGate) return openAdminLogin();
      return demoRemembered() ? launchDemo() : showGate('signin');
    }

    if (!window.supabase || !window.supabase.createClient) {
      return showGate('signin', { message: 'Could not load the sign-in library. Check your connection and reload.' });
    }

    Auth.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error_description') || params.get('error');

    showGate('loading');
    const { data, error } = await Auth.client.auth.getSession();
    cleanUrl();
    if (oauthError) return showGate('signin', { message: `Google sign-in did not complete: ${oauthError}` });
    if (error) return showGate('signin', { message: error.message });

    Auth.client.auth.onAuthStateChange((event, session) => {
      if (Auth.mode === 'demo' || adminLoginInFlight) return;
      if (event === 'SIGNED_OUT') {
        if (!adminLoginInFlight) window.location.replace(window.location.pathname);
      } else if (event === 'SIGNED_IN' && session && !Auth.session) {
        Auth.session = session;
        setTimeout(() => enter(), 0);
      }
    });

    if (data.session) {
      forgetDemo();
      Auth.session = data.session;
      return enter();
    }
    if (wantsAdminGate) return openAdminLogin();
    return demoRemembered() ? launchDemo() : showGate('signin');
  }

  window.addEventListener('DOMContentLoaded', () => {
    start().catch(err => {
      console.error(err);
      showGate('signin', { message: err.message });
    });
  });
})();
