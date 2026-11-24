/**
 * auth.js — Sign-in gate and app start-up
 *
 * With Supabase configured: "Sign in with Google" (Supabase Auth, PKCE flow),
 * then the person's profile decides what they see:
 *   pending   → waiting-for-approval screen
 *   suspended → access-paused screen
 *   resident / driver / admin → the app, limited to their portals
 * Without Supabase: the same screen offers the offline demo (as an admin).
 * Exposes window.Auth.
 */
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);
  const DEMO_KEY = 'sgt.demoSession';

  const byId = (id) => document.getElementById(id);

  const Auth = {
    configured,
    client: null,
    session: null,
    profile: null,
    signInWithGoogle,
    signOut,
  };
  window.Auth = Auth;

  /* ── Gate screens ─────────────────────────────────────────────────────── */
  function showGate(state, { message = '', email = '' } = {}) {
    document.body.classList.add('is-gated');
    const gate = byId('auth-gate');
    gate.dataset.state = state;
    byId('gate-error').textContent = message;
    byId('gate-error').hidden = !message;
    document.querySelectorAll('.val-gate-email').forEach(el => { el.textContent = email; });
    setBusy(false);
  }

  function setBusy(busy) {
    const btn = byId('btn-google-signin');
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
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
  async function launch(profile, store) {
    Auth.profile = profile;
    window.AppDataStore = store;
    await store.load();
    document.body.classList.remove('is-gated');
    window.app = new window.SmartWasteApp(profile);
    window.app.init();
  }

  // The demo lasts for this tab only (a reload stays in it; a new visit shows
  // the sign-in page again), and never touches the real database
  function demoRemembered() {
    try { return sessionStorage.getItem(DEMO_KEY) === '1'; } catch (e) { return false; }
  }
  function forgetDemo() {
    try { sessionStorage.removeItem(DEMO_KEY); localStorage.removeItem(DEMO_KEY); } catch (e) { /* storage unavailable */ }
  }

  function launchDemo() {
    if (window.app) return;
    try { sessionStorage.setItem(DEMO_KEY, '1'); } catch (e) { /* storage unavailable */ }
    Auth.mode = 'demo';
    const store = window.AppDataStore;
    const profile = store.profiles.find(p => p.role === 'admin');
    return launch(profile, store);
  }

  let entering = false;
  async function enter() {
    if (entering) return;
    entering = true;
    showGate('loading');
    try {
      const { data, error } = await Auth.client.rpc('me');
      if (error) throw new Error(window.SupabaseStore.friendlyError(error));
      const profile = window.SupabaseStore.mapProfile(data);
      Auth.profile = profile;
      if (profile.status === 'suspended') { entering = false; return showGate('suspended', { email: profile.email }); }
      if (profile.role === 'pending')     { entering = false; return showGate('pending',   { email: profile.email }); }

      const route = window.AppDataStore.simulation.route;
      await launch(profile, new window.SupabaseStore(Auth.client, profile, route));
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
        message: 'Google sign-in turns on once Supabase is connected (see README, "Deploy on Supabase"). You can explore the offline demo meanwhile.',
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
    // On success the browser is already on its way to Google
    if (error) showGate('signin', { message: error.message });
  }

  async function signOut() {
    if (window.DeviceAccess) window.DeviceAccess.stopLiveTracking();
    if (window.AppSimulatorEngine) window.AppSimulatorEngine.stop();
    forgetDemo();
    // Leaving the demo doesn't sign anyone out of a real account
    if (Auth.mode !== 'demo' && configured && Auth.client) await Auth.client.auth.signOut();
    window.location.replace(window.location.pathname);
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */
  async function start() {
    byId('btn-google-signin').addEventListener('click', signInWithGoogle);
    byId('btn-demo').addEventListener('click', () => { launchDemo(); });
    document.querySelectorAll('.btn-gate-signout').forEach(b => b.addEventListener('click', signOut));
    byId('btn-gate-recheck').addEventListener('click', () => enter());

    const gate = byId('auth-gate');
    gate.classList.toggle('is-demo', !configured);
    try { localStorage.removeItem(DEMO_KEY); } catch (e) { /* older versions kept the demo flag here */ }

    if (!configured) {
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

    // Sign-outs (including from another tab) return to the gate. Supabase
    // calls must not run inside this callback, hence the setTimeout.
    Auth.client.auth.onAuthStateChange((event, session) => {
      if (Auth.mode === 'demo') return;   // a demo tab ignores sign-ins and sign-outs in other tabs
      if (event === 'SIGNED_OUT') {
        window.location.replace(window.location.pathname);
      } else if (event === 'SIGNED_IN' && session && !Auth.session) {
        Auth.session = session;
        setTimeout(enter, 0);
      }
    });

    // A real account wins over a remembered demo
    if (data.session) {
      forgetDemo();
      Auth.session = data.session;
      return enter();
    }
    return demoRemembered() ? launchDemo() : showGate('signin');
  }

  window.addEventListener('DOMContentLoaded', () => {
    start().catch(err => {
      console.error(err);
      showGate('signin', { message: err.message });
    });
  });
})();
