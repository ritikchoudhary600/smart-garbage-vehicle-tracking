/**
 * app.js — Main frontend controller
 * Works identically on localhost (Node server) and on a static host (Vercel).
 * Talks to window.AppDataStore, which is either the offline demo store
 * (dataStore.js) or the Supabase store (supabaseStore.js); both broadcast
 * the same window CustomEvents. auth.js creates the app after sign-in.
 */
(function () {
  'use strict';

  /* ── Utility helpers ─────────────────────────────────────────────────── */
  function qs(sel, root = document)  { return root.querySelector(sel); }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
  function setText(sel, val, root = document) {
    qsa(sel, root).forEach(el => { el.textContent = val; });
  }
  function byId(id) { return document.getElementById(id); }
  function val(id)  { const el = byId(id); return el ? el.value.trim() : ''; }

  // Escapes user-entered text before it goes into innerHTML templates
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function relTime(iso) {
    if (!iso) return '';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 10)    return 'just now';
    if (diff < 60)    return `${diff}s ago`;
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // Returns [number, unit] so the hero metric can style them separately
  function distParts(m) {
    if (m == null) return ['—', ''];
    return m >= 1000 ? [(m / 1000).toFixed(2), 'km'] : [String(Math.round(m)), 'm'];
  }
  function fmtDist(m) {
    const [n, u] = distParts(m);
    return u ? `${n} ${u}` : n;
  }

  function statusPill(status) {
    return `<span class="status s-${esc(String(status).toLowerCase())}">${esc(status)}</span>`;
  }

  function initials(name, email) {
    const src = (name || email || '?').trim();
    const parts = src.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + ((parts[1] || '')[0] || '')).toUpperCase();
  }

  function avatarHtml(person, cls = 'avatar') {
    if (person && person.avatarUrl) {
      return `<span class="${cls}"><img src="${esc(person.avatarUrl)}" alt="" referrerpolicy="no-referrer"></span>`;
    }
    return `<span class="${cls}">${esc(initials(person && person.fullName, person && person.email))}</span>`;
  }

  const ARRIVED_M = 30;
  const MIN_TRACK_M = 1400;
  const TRUCK_M_PER_MIN = 300;   // ~18 km/h, a collection truck's typical pace

  // The distance track spans at least 1.4 km and always leaves room beyond the alert
  function trackMaxFor(radius) { return Math.max(MIN_TRACK_M, Math.ceil((radius * 1.4) / 100) * 100); }
  function warningText(radius) {
    const mins = radius / TRUCK_M_PER_MIN;
    return mins < 1 ? 'under a minute before it reaches your gate' : `about ${Math.round(mins)} min before it reaches your gate`;
  }
  const { effectiveAlertRadius, formatMeters, computeZoneStatus } = window.GeoUtils;

  const ROLE_VIEWS = {
    admin:    ['resident', 'driver', 'admin', 'split', 'control'],
    demo:     ['resident', 'driver', 'split'],
    driver:   ['driver'],
    resident: ['resident'],
  };
  const ROLE_LABELS = { admin: 'Admin', demo: 'Demo', driver: 'Driver', resident: 'Resident', pending: 'Waiting for approval' };

  const ICONS = {
    notifications: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
    location: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><path d="M5 9v6h4l5 4V5L9 9z"/><path d="M17.5 8.5a5 5 0 0 1 0 7"/></svg>',
    wakeLock: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/><path d="M12 7v4l2 1.5"/></svg>',
  };

  /* ════════════════════════════════════════════════════════════════════════
     SmartWasteApp
  ════════════════════════════════════════════════════════════════════════ */
  class SmartWasteApp {
    constructor(profile) {
      this.profile         = profile;
      this.role            = profile.role;
      this.views           = ROLE_VIEWS[this.role] || ['resident'];
      this.currentRole     = this.views[0];
      this.selectedHouseNo = null;
      this.soundEnabled    = true;
      this.speed           = 1;
      this.maps            = {};            // containerId → MapInstance
      this._lastMapIndex   = null;
      this._lastLivePos    = null;
      this.liveGps         = false;
      this._gpsState       = null;
      this._modals         = {};
    }

    get store()  { return window.AppDataStore; }
    get state()  { return this.store.getState(); }
    get isDemo() { return this.store.mode === 'demo'; }

    // Admins and demo visitors can drive the simulated vehicle; drivers only the one assigned to them
    get canDrive() {
      const v = this.state.vehicles[0];
      if (!v) return false;
      if (this.role === 'admin' || this.isDemo) return true;
      return this.role === 'driver' && v.driverId === this.profile.id;
    }

    /* ────────────────────────────────────────────────────────────────────
       INIT
    ──────────────────────────────────────────────────────────────────── */
    init() {
      this._applyRole();
      this._setupNavigation();
      this._setupSimControls();
      this._setupModals();
      this._setupSoundToggle();
      this._setupResidentControls();
      this._setupDriverControls();
      this._setupUserMenu();
      this._setupPermissions();
      this._setupLiveGps();
      this._setupAlertRange();
      this._connectEvents();
      if (window.ControlPanel && this.role === 'admin') window.ControlPanel.init(this);

      this._pickDefaultHouse();
      this._populateResidentSwitcher();
      this._populateDriverSelect();
      this._applySettings();
      this._updateUI();
      this._updateSimBar();

      const hash = window.location.hash.replace('#', '');
      this._switchRole(this.views.includes(hash) ? hash : this.views[0]);

      // Maps need the DOM painted first
      setTimeout(() => this._initMaps(), 300);

      // Keep relative timestamps fresh
      setInterval(() => this._updateUI(), 30000);

      // Offer the permissions sheet once per person per browser
      setTimeout(() => this._maybeOfferPermissions(), 1600);
    }

    /* ── Role: which portals, tabs and controls this person gets ───────── */
    _applyRole() {
      qsa('.role-tab').forEach(btn => { btn.hidden = !this.views.includes(btn.dataset.role); });
      document.body.classList.toggle('single-view', this.views.length === 1);
      document.body.classList.toggle('no-sim', this.role === 'resident');
      document.body.classList.toggle('is-demo', this.isDemo);
      document.body.dataset.role = this.role;
      qs('.brand').setAttribute('href', `#${this.views[0]}`);
    }

    /* ────────────────────────────────────────────────────────────────────
       SHARED UI: async actions, modals, confirm
    ──────────────────────────────────────────────────────────────────── */
    // Runs a store call; shows its error as a toast. Resolves to the result, or null on failure.
    async _act(fn, errorTitle, button) {
      if (button) button.disabled = true;
      try {
        const result = await fn();
        return result === undefined ? true : result;
      } catch (err) {
        console.error(err);
        this._showToast(errorTitle, esc(err.message || String(err)), 'error');
        return null;
      } finally {
        if (button) button.disabled = false;
      }
    }

    _bindModal(modalId, openSel, closeSel, onOpen) {
      const modal = byId(modalId);
      if (!modal) return { open() {}, close() {} };
      const open  = (...args) => { if (onOpen) onOpen(...args); modal.classList.add('open'); };
      const close = () => modal.classList.remove('open');
      if (openSel) qsa(openSel).forEach(b => b.addEventListener('click', () => open()));
      qsa(closeSel).forEach(b => b.addEventListener('click', close));
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      this._modals[modalId] = { open, close };
      return this._modals[modalId];
    }

    _confirm({ title, message, confirmLabel = 'Remove' }) {
      const modal = byId('confirm-modal');
      byId('confirm-title').textContent = title;
      byId('confirm-message').textContent = message;
      byId('confirm-ok').textContent = confirmLabel;
      modal.classList.add('open');
      byId('confirm-cancel').focus();
      return new Promise((resolve) => {
        const done = (answer) => {
          modal.classList.remove('open');
          byId('confirm-ok').removeEventListener('click', yes);
          byId('confirm-cancel').removeEventListener('click', no);
          modal.removeEventListener('click', backdrop);
          resolve(answer);
        };
        const yes = () => done(true);
        const no  = () => done(false);
        const backdrop = (e) => { if (e.target === modal) done(false); };
        byId('confirm-ok').addEventListener('click', yes);
        byId('confirm-cancel').addEventListener('click', no);
        modal.addEventListener('click', backdrop);
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       NAVIGATION
    ──────────────────────────────────────────────────────────────────── */
    _setupNavigation() {
      qsa('.role-tab').forEach(btn => {
        btn.addEventListener('click', () => this._switchRole(btn.dataset.role));
      });
      window.addEventListener('hashchange', () => {
        const hash = window.location.hash.replace('#', '');
        if (hash && hash !== this.currentRole) this._switchRole(hash);
      });
    }

    _switchRole(role) {
      if (role === 'admin-login' || ((role === 'admin' || role === 'control') && this.role !== 'admin')) {
        if (this.isDemo) {
          if (window.Auth && window.Auth.openAdminLogin) {
            window.Auth.openAdminLogin();
            return;
          }
        } else {
          this._showToast('Admin access required', 'Residents and drivers cannot access the Municipal Admin Dashboard.', 'error');
          role = this.views[0];
        }
      }
      if (!this.views.includes(role)) role = this.views[0];
      this.currentRole = role;
      qsa('.role-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.role === role));
      qsa('.view').forEach(panel => panel.classList.toggle('active', panel.id === `${role}-view`));
      document.body.dataset.view = role;
      history.replaceState(null, '', `#${role}`);
      this._updateUI();
      if (role === 'control' && window.ControlPanel) window.ControlPanel.render(true);

      // MapLibre needs a size refresh once a hidden map becomes visible
      setTimeout(() => Object.values(this.maps).forEach(m => m.invalidateSize()), 60);
    }

    /* ────────────────────────────────────────────────────────────────────
       SIMULATION CONTROLS
    ──────────────────────────────────────────────────────────────────── */
    _simAllowed() {
      if (this.liveGps) {
        this._showToast('Live GPS is on', 'Stop sharing your live location to use the route simulator.', 'warning');
        return false;
      }
      if (!this.canDrive) {
        this._showToast('No vehicle to drive', 'Ask an admin to assign you a vehicle in Control › Fleet.', 'warning');
        return false;
      }
      return true;
    }

    _setupSimControls() {
      const sim = window.AppSimulatorEngine;

      byId('btn-sim-play').addEventListener('click', () => {
        if (this.state.simulation.isRunning) {
          sim.stop();
        } else {
          if (!this._simAllowed()) return;
          // Restart from the beginning if the previous run reached the end
          const s = this.state.simulation;
          if (s.currentIndex >= s.route.length - 1) sim.reset();
          sim.start(this.speed);
        }
      });

      qsa('.speed-opt').forEach(btn => {
        btn.addEventListener('click', () => {
          this.speed = Number(btn.dataset.speed);
          qsa('.speed-opt').forEach(b => b.classList.toggle('active', b === btn));
          if (this.state.simulation.isRunning) sim.start(this.speed);
        });
      });

      byId('btn-sim-step-fwd').addEventListener('click',  () => { if (this._simAllowed()) sim.stepForward(); });
      byId('btn-sim-step-back').addEventListener('click', () => { if (this._simAllowed()) sim.stepBackward(); });
      byId('btn-sim-reset').addEventListener('click',     () => { if (this._simAllowed()) sim.reset(); });

      qsa('.shortcut-chip').forEach(chip => {
        chip.addEventListener('click', () => { if (this._simAllowed()) sim.teleport(Number(chip.dataset.index)); });
      });

      this._setupDockToggle();
    }

    // Collapsible simulator dock; the choice is remembered per browser
    _setupDockToggle() {
      const KEY = 'sgt.dockCollapsed';
      let saved = null;
      try { saved = localStorage.getItem(KEY); } catch (e) { /* storage unavailable */ }
      const startCollapsed = saved != null ? saved === '1' : window.innerWidth < 880;

      const DURATION = 420;
      const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const apply = (collapsed, animate) => {
        const dock = qs('.dock');
        const btn  = byId('btn-dock-toggle');
        const from = dock.getBoundingClientRect();
        const fromRadius = getComputedStyle(dock).borderRadius;

        dock.classList.toggle('is-collapsed', collapsed);
        document.body.classList.toggle('dock-collapsed', collapsed);
        const label = collapsed ? 'Show simulator controls' : 'Hide simulator controls';
        btn.setAttribute('aria-expanded', String(!collapsed));
        btn.title = label;
        btn.setAttribute('aria-label', label);

        if (animate && !reduceMotion && dock.animate) {
          // FLIP: CSS can't transition to width:auto, so tween between measured sizes
          const to = dock.getBoundingClientRect();
          const toRadius = getComputedStyle(dock).borderRadius;
          dock.animate([
            { width: `${from.width}px`, height: `${from.height}px`, borderRadius: fromRadius, overflow: 'hidden' },
            { width: `${to.width}px`,   height: `${to.height}px`,   borderRadius: toRadius,   overflow: 'hidden' },
          ], { duration: DURATION, easing: EASE });

          if (!collapsed) {
            const revealed = qsa('.dock-chips, .speed-seg, .dock-group .icon-btn', dock);
            revealed.forEach(el => el.animate(
              [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
              { duration: DURATION - 80, delay: 120, easing: EASE, fill: 'backwards' }));
          }
        }

        // Workspace height changes with --dock-h, so maps re-measure once it settles
        setTimeout(() => Object.values(this.maps).forEach(m => m.invalidateSize()), animate ? DURATION + 40 : 50);
      };

      apply(startCollapsed, false);
      byId('btn-dock-toggle').addEventListener('click', () => {
        const collapsed = !qs('.dock').classList.contains('is-collapsed');
        apply(collapsed, true);
        try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e) { /* storage unavailable */ }
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       MODALS
    ──────────────────────────────────────────────────────────────────── */
    _setupModals() {
      // ── Pickup request ────────────────────────────────────────────────
      const pickupForm = byId('pickup-request-form');
      const pickup = this._bindModal('pickup-modal', '.btn-open-pickup-modal', '.btn-close-pickup-modal', () => {
        // Prefill from the household currently selected
        const house = this._selectedHouse();
        pickupForm.reset();
        if (house) {
          byId('req-house-no').value      = house.houseNo;
          byId('req-resident-name').value = house.residentName;
          byId('req-ward').value          = house.ward;
          byId('req-address').value       = house.address;
          byId('req-landmark').value      = house.landmark || '';
        }
        byId('req-house-no').readOnly = this.role === 'resident';
      });
      pickupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = await this._act(() => this.store.createPickupRequest({
          houseNo:      val('req-house-no') || this.selectedHouseNo,
          residentName: val('req-resident-name'),
          ward:         val('req-ward'),
          address:      val('req-address'),
          landmark:     val('req-landmark'),
          note:         val('req-note'),
          wasteType:    val('req-waste-type'),
        }), 'Pickup request failed', e.submitter);
        if (ok) { pickup.close(); pickupForm.reset(); }
      });

      // ── Driver issue ──────────────────────────────────────────────────
      const emergForm = byId('emergency-form');
      const emerg = this._bindModal('emergency-modal', '#btn-open-emergency-modal', '.btn-close-emergency-modal');
      emergForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const vehicle = this.state.vehicles[0];
        const ok = await this._act(() => this.store.reportEmergency({
          vehicleId: vehicle ? vehicle.id : null,
          type:    val('emerg-type') || 'Other',
          message: val('emerg-msg'),
        }), 'Could not send the delay notice', e.submitter);
        if (ok) { emerg.close(); emergForm.reset(); }
      });

      // ── Register household ────────────────────────────────────────────
      const regForm = byId('register-house-form');
      this.regPicker = window.LocationPicker.create({
        mapId: 'reg-pick-map', latId: 'reg-lat', lonId: 'reg-lon', hintId: 'reg-location-hint', locateId: 'reg-locate',
      });
      const reg = this._bindModal('register-modal', '.btn-open-register', '.btn-close-register-modal', () => {
        if (this.role === 'resident' && !byId('reg-resident-name').value) {
          byId('reg-resident-name').value = this.profile.fullName || '';
        }
        byId('reg-ward').value = byId('reg-ward').value || this.state.settings.wardName;
        // Starts on the device's current location; the map is sized once the dialog shows
        setTimeout(() => this.regPicker.open({ fallback: this._locationFallback() }), 30);
      });
      regForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!this.regPicker.hasPin()) {
          this._showToast('Pin your home first', 'Use your current location, or tap the map at your gate.', 'warning');
          return;
        }
        const house = await this._act(() => this.store.registerHouse({
          houseNo:      val('reg-house-no'),
          residentName: val('reg-resident-name'),
          ward:         val('reg-ward'),
          address:      val('reg-address'),
          landmark:     val('reg-landmark'),
          phone:        val('reg-contact'),
          lat:          val('reg-lat'),
          lon:          val('reg-lon'),
        }), 'Registration failed', e.submitter);
        if (!house) return;
        this.selectedHouseNo = house.houseNo;
        this._populateResidentSwitcher();
        this._updateUI();
        reg.close();
        regForm.reset();
      });

      this._bindModal('permissions-modal', null, '.btn-close-permissions-modal');

      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (byId('confirm-modal').classList.contains('open')) { byId('confirm-cancel').click(); return; }
        Object.values(this._modals).forEach(m => m.close());
        this._closeUserMenu();
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       SOUND TOGGLE
    ──────────────────────────────────────────────────────────────────── */
    _setupSoundToggle() {
      const btn = byId('btn-sound-toggle');
      btn.addEventListener('click', () => {
        this.soundEnabled = !this.soundEnabled;
        btn.setAttribute('aria-pressed', String(this.soundEnabled));
        btn.title = this.soundEnabled ? 'Mute arrival chime' : 'Unmute arrival chime';
      });
    }

    _chime(type) {
      if (this.soundEnabled && window.audioChime) window.audioChime.playChime(type);
    }

    /* ────────────────────────────────────────────────────────────────────
       USER MENU
    ──────────────────────────────────────────────────────────────────── */
    _setupUserMenu() {
      const p = this.profile;
      byId('user-avatar').innerHTML = p.avatarUrl
        ? `<img src="${esc(p.avatarUrl)}" alt="" referrerpolicy="no-referrer">`
        : esc(initials(p.fullName, p.email));
      setText('#user-name', p.fullName || p.email);
      setText('#user-email', this.isDemo ? 'Offline demo · nothing is saved' : p.email);
      const badge = byId('user-role');
      badge.textContent = ROLE_LABELS[p.role] || p.role;
      badge.dataset.role = p.role;
      setText('#sign-out-label', this.isDemo ? 'Leave demo' : 'Sign out');

      const btn = byId('btn-user-menu');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = byId('user-menu');
        const open = menu.hidden;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.user-menu')) this._closeUserMenu();
      });
      byId('btn-sign-out').addEventListener('click', () => window.Auth.signOut());
      byId('btn-demo-pill').addEventListener('click', () => window.Auth.signOut());   // leave the demo
      const topbarAdminBtn = byId('btn-topbar-admin-login');
      if (topbarAdminBtn) topbarAdminBtn.addEventListener('click', () => window.Auth.openAdminLogin());
      const adminLogoutBtn = byId('btn-admin-logout');
      if (adminLogoutBtn) adminLogoutBtn.addEventListener('click', () => window.Auth.signOut());
      byId('btn-open-permissions').addEventListener('click', () => {
        this._closeUserMenu();
        this._openPermissions();
      });
    }

    _closeUserMenu() {
      byId('user-menu').hidden = true;
      byId('btn-user-menu').setAttribute('aria-expanded', 'false');
    }

    /* ────────────────────────────────────────────────────────────────────
       DEVICE PERMISSIONS
    ──────────────────────────────────────────────────────────────────── */
    _permItems() {
      const r = this.role;
      const radius = formatMeters(this._houseRadius(this._selectedHouse()));
      const items = [{
        kind: 'notifications', title: 'Notifications',
        text: r === 'driver'   ? 'New pickup requests, even while the app is in the background.'
            : r === 'admin'    ? 'New pickup requests and driver issue reports, even while this tab is in the background.'
            :                    `The ${radius} alert, pickup updates and delay notices, even while this tab is in the background.`,
      }, {
        kind: 'location', title: 'Location', optional: r === 'resident',
        text: r === 'driver' ? 'Shares the truck\'s real position while "Share live location" is on, so residents see where it actually is. Never in the background.'
            : r === 'admin'  ? 'Pin a household at your current spot, or drive a vehicle with live GPS.'
            :                  'Pins your home on the map with one tap when you register. Used once, never tracked.',
      }, {
        kind: 'sound', title: 'Arrival chime',
        text: 'A soft 25 dB chime instead of an 85 dB loudspeaker. Browsers keep sound off until you allow it.',
      }];
      if (r !== 'resident') {
        items.push({
          kind: 'wakeLock', title: 'Keep screen on',
          text: 'Stops your phone sleeping while you share live GPS, so the position keeps updating.',
        });
      }
      return items;
    }

    _setupPermissions() {
      byId('perm-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-perm]');
        if (!btn) return;
        const kind = btn.dataset.perm;
        btn.disabled = true;
        try {
          if (kind === 'wakeLock' && btn.dataset.state === 'granted') {
            try { localStorage.setItem('sgt.wakeLock', '0'); } catch (err) { /* storage unavailable */ }
          } else {
            const result = await window.DeviceAccess.request(kind);
            if (result === 'denied') {
              this._showToast('Blocked by the browser', 'Allow it in your browser\'s site settings (the icon left of the address bar), then reopen this sheet.', 'warning');
            }
          }
        } catch (err) {
          this._showToast('Permission not granted', esc(err.message), 'warning');
        }
        this._renderPermissions();
      });
      window.DeviceAccess.onChange(() => {
        if (byId('permissions-modal').classList.contains('open')) this._renderPermissions();
      });
    }

    async _renderPermissions() {
      const rows = await Promise.all(this._permItems().map(async item => ({ ...item, state: await window.DeviceAccess.status(item.kind) })));
      byId('perm-list').innerHTML = rows.map(item => {
        let action;
        if (item.state === 'unsupported') {
          action = '<span class="perm-state perm-off">Not available here</span>';
        } else if (item.kind === 'wakeLock') {
          action = item.state === 'granted'
            ? `<span class="perm-state perm-on">On while sharing GPS</span><button class="btn btn-quiet btn-xs" data-perm="wakeLock" data-state="granted">Turn off</button>`
            : '<button class="btn btn-outline btn-xs" data-perm="wakeLock" data-state="prompt">Turn on</button>';
        } else if (item.state === 'granted') {
          action = '<span class="perm-state perm-on">Allowed</span>';
        } else if (item.state === 'denied') {
          action = '<span class="perm-state perm-blocked">Blocked in browser settings</span>';
        } else {
          action = `<button class="btn btn-primary btn-xs" data-perm="${item.kind}">${item.kind === 'sound' ? 'Turn on' : 'Allow'}</button>`;
        }
        return `
          <div class="perm-row" data-state="${item.state}">
            <span class="perm-icon">${ICONS[item.kind]}</span>
            <div class="perm-copy">
              <div class="perm-title">${item.title}${item.optional ? ' <em>optional</em>' : ''}</div>
              <div class="perm-text">${esc(item.text)}</div>
            </div>
            <div class="perm-action">${action}</div>
          </div>`;
      }).join('');
    }

    async _openPermissions() {
      await this._renderPermissions();
      this._modals['permissions-modal'].open();
    }

    async _maybeOfferPermissions() {
      const key = `sgt.permsOffered.${this.profile.id}`;
      try { if (localStorage.getItem(key)) return; } catch (e) { return; }
      const states = await Promise.all(['notifications', 'location', 'sound'].map(k => window.DeviceAccess.status(k)));
      if (!states.includes('prompt')) return;
      try { localStorage.setItem(key, String(Date.now())); } catch (e) { /* storage unavailable */ }
      this._openPermissions();
    }

    // Where a location pin starts if the device can't say where it is: the
    // ward's own households, never the demo route
    _locationFallback() {
      const own = this._selectedHouse();
      if (own) return [own.lat, own.lon];
      const houses = this._mapHouses();
      if (!houses.length) return null;
      return [houses.reduce((s, h) => s + h.lat, 0) / houses.length, houses.reduce((s, h) => s + h.lon, 0) / houses.length];
    }

    /* ────────────────────────────────────────────────────────────────────
       LIVE GPS (drivers)
    ──────────────────────────────────────────────────────────────────── */
    _setupLiveGps() {
      byId('btn-live-gps').addEventListener('click', () => this._toggleLiveGps());
      setInterval(() => { if (this.liveGps) this._renderGps(); }, 5000);
      this._renderGps();
    }

    _toggleLiveGps() {
      if (this.liveGps) {
        window.DeviceAccess.stopLiveTracking();
        this.liveGps = false;
        this._renderGps();
        this._updateSimBar();
        this._showToast('Live GPS off', 'The route simulator can drive the truck again.', 'info');
        return;
      }
      if (!this.canDrive) {
        this._showToast('No vehicle to drive', 'Ask an admin to assign you a vehicle in Control › Fleet.', 'warning');
        return;
      }
      if (this.state.simulation.isRunning) window.AppSimulatorEngine.stop();
      let announced = false;
      try {
        window.DeviceAccess.startLiveTracking({
          onFix: (fix) => {
            const v = this.state.vehicles[0];
            if (!v || !this.canDrive) return;
            this.store.updateVehicleLocation(v.id, fix.lat, fix.lon, Math.round(fix.speedKmh || 0), { mode: 'live_gps' });
            if (!announced) {
              announced = true;
              this._showToast('Sharing live location', 'Residents now see the truck\'s real position.', 'success');
            }
          },
          onState: (s) => {
            const wasLive = this.liveGps;
            this._gpsState = s;
            this.liveGps = s.active;
            if (wasLive && !s.active && s.error) this._showToast('Live GPS stopped', esc(s.error.message), 'error');
            this._renderGps();
            this._updateSimBar();
          },
        });
        this.liveGps = true;
      } catch (err) {
        this._showToast('Live GPS unavailable', esc(err.message), 'error');
      }
      this._renderGps();
      this._updateSimBar();
    }

    _renderGps() {
      const card = byId('gps-card');
      const s = this._gpsState;
      let text;
      if (!this.liveGps) {
        text = s && s.error ? s.error.message : 'Off. The route simulator is driving the truck.';
      } else if (s && s.error) {
        text = s.error.message;
      } else if (s && s.last) {
        const parts = [`±${Math.round(s.last.accuracy)} m`, `updated ${relTime(new Date(s.last.at).toISOString())}`];
        if (s.inaccurate) parts.push('signal too weak to send');
        if (s.wakeLock) parts.push('screen kept on');
        text = `Sharing · ${parts.join(' · ')}`;
      } else {
        text = 'Waiting for the first GPS fix…';
      }
      card.classList.toggle('is-live', this.liveGps);
      card.classList.toggle('has-error', !!(s && s.error));
      byId('gps-status').textContent = text;
      byId('btn-live-gps').textContent = this.liveGps ? 'Stop sharing' : 'Share live location';
    }

    /* ────────────────────────────────────────────────────────────────────
       ALERT DISTANCE (each household chooses its own)
    ──────────────────────────────────────────────────────────────────── */
    _houseRadius(house) {
      return effectiveAlertRadius(house, this.state.settings);
    }

    _setupAlertRange() {
      const input = byId('alert-range-input');
      const save = (meters) => {
        const house = this._selectedHouse();
        if (!house) { this._rangeDragging = false; return; }
        this._act(() => this.store.setAlertRadius(house.houseNo, meters), 'Could not save the alert distance')
          .finally(() => { this._rangeDragging = false; this._renderAlertRange(); });
      };
      // Live preview while dragging; save once on release
      input.addEventListener('input', () => {
        this._rangeDragging = true;
        this._renderAlertRange(Number(input.value));
      });
      input.addEventListener('change', () => save(Number(input.value)));
      qsa('.range-presets [data-radius]').forEach(b => b.addEventListener('click', () => save(Number(b.dataset.radius))));
      byId('alert-range-reset').addEventListener('click', () => save(null));
    }

    // preview = a value being dragged (not saved yet)
    _renderAlertRange(preview) {
      const house = this._selectedHouse();
      if (!house) return;
      const s = this.state.settings;
      const radius = preview != null ? preview : this._houseRadius(house);
      const custom = preview != null ? preview !== s.geofenceRadiusM : house.alertRadiusM != null;
      const input = byId('alert-range-input');
      if (!this._rangeDragging) input.value = radius;
      const span = Math.max(1, s.alertRadiusMaxM - s.alertRadiusMinM);
      input.style.setProperty('--fill', `${((radius - s.alertRadiusMinM) / span) * 100}%`);
      input.setAttribute('aria-valuetext', formatMeters(radius));
      byId('alert-range-value').textContent = formatMeters(radius);
      byId('alert-range-source').textContent = custom ? 'Your choice' : 'Ward default';
      byId('alert-range-hint').textContent = `One quiet alert when the truck is ${formatMeters(radius)} away, ${warningText(radius)}.`;
      const reset = byId('alert-range-reset');
      reset.hidden = !custom;
      reset.textContent = `Use the ward default (${formatMeters(s.geofenceRadiusM)})`;
      qsa('.range-presets [data-radius]').forEach(b => b.classList.toggle('active', Number(b.dataset.radius) === radius));
    }

    /* ────────────────────────────────────────────────────────────────────
       RESIDENT CONTROLS
    ──────────────────────────────────────────────────────────────────── */
    _selectedHouse() {
      const houses = this.state.houses;
      return houses.find(h => h.houseNo === this.selectedHouseNo) || null;
    }

    _pickDefaultHouse() {
      // Only people with a resident view follow a household (drivers get no resident alerts)
      if (!this.views.includes('resident')) { this.selectedHouseNo = null; return; }
      const houses = this.state.houses;
      const own = houses.find(h => h.ownerId === this.profile.id);
      const pick = own || (this.role !== 'resident' && (houses.find(h => h.houseNo === '125') || houses[0]));
      this.selectedHouseNo = pick ? pick.houseNo : null;
    }

    _setupResidentControls() {
      const acctSel = byId('resident-account-select');
      acctSel.addEventListener('change', () => {
        this.selectedHouseNo = acctSel.value;
        this._updateUI();
      });

      // Garbage-ready buttons exist in both the resident and split views
      qsa('.btn-garbage-ready').forEach(btn => {
        btn.addEventListener('click', () => {
          const house = this._selectedHouse();
          if (house) this._act(() => this.store.setGarbageReady(house.houseNo, !house.garbageReady), 'Could not update your bins', btn);
        });
      });
    }

    _populateResidentSwitcher() {
      if (!this.views.includes('resident')) return;
      const sel = byId('resident-account-select');
      let houses = this.state.houses;
      if (this.role === 'resident') houses = houses.filter(h => h.ownerId === this.profile.id);
      if (!this._selectedHouse() || (this.role === 'resident' && !houses.some(h => h.houseNo === this.selectedHouseNo))) {
        this.selectedHouseNo = houses[0] ? houses[0].houseNo : null;
      }
      sel.innerHTML = houses.map(h =>
        `<option value="${esc(h.houseNo)}" ${h.houseNo === this.selectedHouseNo ? 'selected' : ''}>#${esc(h.houseNo)} · ${esc(h.residentName)}</option>`
      ).join('');
      sel.hidden = houses.length < 2 && this.role === 'resident';
    }

    /* ────────────────────────────────────────────────────────────────────
       DRIVER CONTROLS (delegated)
    ──────────────────────────────────────────────────────────────────── */
    _setupDriverControls() {
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const status = {
          'accept-pickup':  'Accepted',
          'collect-pickup': 'Collected',
          'miss-pickup':    'Missed',
        }[btn.dataset.action];
        if (status) this._act(() => this.store.updatePickupStatus(btn.dataset.id, status), 'Could not update the pickup', btn);
      });

      const driverSel = byId('driver-profile-select');
      driverSel.addEventListener('change', () => {
        const v = this.state.vehicles[0];
        if (!v || !driverSel.value) return;
        this._act(() => this.store.assignDriver(v.id, driverSel.value), 'Could not change the driver', driverSel);
      });
    }

    // Admins and demo visitors pick the driver on duty; drivers just see their own name
    _populateDriverSelect() {
      const sel = byId('driver-profile-select');
      const v = this.state.vehicles[0];
      sel.hidden = (this.role !== 'admin' && !this.isDemo) || !v;
      if (sel.hidden) return;
      const drivers = this.state.profiles.filter(p => p.role === 'driver' && p.status === 'active');
      const opts = [];
      if (!v.driverId) opts.push(`<option value="" selected>${esc(v.driverName ? `${v.driverName} (no account)` : 'No driver assigned')}</option>`);
      for (const d of drivers) {
        opts.push(`<option value="${esc(d.id)}" ${d.id === v.driverId ? 'selected' : ''}>${esc(d.fullName || d.email)}</option>`);
      }
      if (!drivers.length && v.driverId == null && !opts.length) opts.push('<option value="">No drivers yet</option>');
      sel.innerHTML = opts.join('');
    }

    /* ────────────────────────────────────────────────────────────────────
       SETTINGS → labels, geofence ring
    ──────────────────────────────────────────────────────────────────── */
    _applySettings() {
      const s = this.state.settings;
      setText('.val-ward-name', s.wardName);
      setText('.val-radius', formatMeters(s.geofenceRadiusM));
      const input = byId('alert-range-input');
      input.min = s.alertRadiusMinM;
      input.max = s.alertRadiusMaxM;
      qsa('.range-presets [data-radius]').forEach(b => {
        const m = Number(b.dataset.radius);
        b.hidden = m < s.alertRadiusMinM || m > s.alertRadiusMaxM;
      });
      if (window.MapManager) window.MapManager.setZoneRadius(s.geofenceRadiusM);
    }

    /* ────────────────────────────────────────────────────────────────────
       STORE EVENTS
       Handlers add feedback (toasts, chimes, system notifications) and re-render.
    ──────────────────────────────────────────────────────────────────── */
    _connectEvents() {
      const rerender = () => this._updateUI();
      const notify = (title, body, opts) => window.DeviceAccess && window.DeviceAccess.notify(title, body, opts);

      window.addEventListener('telemetry_update', rerender);
      window.addEventListener('analytics_updated', rerender);
      window.addEventListener('notification_added', rerender);

      window.addEventListener('geofence_alert', (e) => {
        const notif = e.detail;
        // Only the household that entered the zone hears the chime
        if (notif.houseNo === this.selectedHouseNo) {
          this._showToast('Collection vehicle approaching', esc(notif.message), 'success');
          this._chime('geofence');
          notify('Collection vehicle approaching', notif.message, { tag: 'geofence', vibrate: true });
        }
        rerender();
      });

      window.addEventListener('pickup_request_created', (e) => {
        const { request } = e.detail;
        this._showToast('Pickup requested', `House #${esc(request.houseNo)} · ${esc(request.wasteType)}`, 'info');
        if (this.role !== 'resident') notify('New pickup request', `House #${request.houseNo} · ${request.wasteType}`, { tag: `pickup-${request.id}` });
        rerender();
      });

      window.addEventListener('pickup_status_updated', (e) => {
        const { request } = e.detail;
        const mine = request.houseNo === this.selectedHouseNo;
        if (request.status === 'Collected') {
          this._showToast('Garbage collected', `House #${esc(request.houseNo)} has been collected.`, 'success');
          this._chime('pickup_collected');
          if (mine) notify('Garbage collected', `Your pickup ${request.id} has been collected.`, { tag: `pickup-${request.id}` });
        } else if (request.status === 'Missed') {
          this._showToast('Pickup missed', `House #${esc(request.houseNo)} could not be collected.`, 'warning');
          if (mine) notify('Pickup missed', 'The driver could not reach your bins. Check the gate and request again.', { tag: `pickup-${request.id}` });
        } else {
          this._showToast('Request updated', `${esc(request.id)} is now ${esc(request.status.toLowerCase())}.`, 'info');
          if (mine) notify('Pickup accepted', `The driver is on the way for ${request.id}.`, { tag: `pickup-${request.id}` });
        }
        rerender();
      });

      window.addEventListener('garbage_ready_updated', (e) => {
        const { houseNo, garbageReady } = e.detail;
        this._showToast(garbageReady ? 'Driver notified' : 'Ready status cleared',
          garbageReady ? `Bins are outside House #${esc(houseNo)}.`
                       : `House #${esc(houseNo)} is no longer marked ready.`, 'info');
        rerender();
      });

      window.addEventListener('house_registered', (e) => {
        const { house, isNew } = e.detail;
        this._showToast(isNew ? 'Household registered' : 'Household updated',
          `House #${esc(house.houseNo)} · ${esc(house.residentName)}`, 'success');
        if (!this.selectedHouseNo && this.views.includes('resident')) this.selectedHouseNo = house.houseNo;
        this._populateResidentSwitcher();
        rerender();
      });

      window.addEventListener('driver_switched', (e) => {
        const v = e.detail.vehicle;
        if (v.driverName) this._showToast('Driver changed', `${esc(v.driverName)} is now driving ${esc(v.id)}.`, 'info');
        this._populateDriverSelect();
        rerender();
      });

      window.addEventListener('emergency_reported', (e) => {
        const { report } = e.detail;
        this._showToast('Delay notice sent', `${esc(report.type)} · ${esc(report.message)}`, 'warning');
        if (this.role !== 'driver') notify(`Delay: ${report.type}`, report.message, { tag: 'delay' });
        rerender();
      });

      window.addEventListener('alert_radius_updated', (e) => {
        const { house } = e.detail;
        const radius = this._houseRadius(house);
        this._showToast('Alert distance saved', `House #${esc(house.houseNo)} gets its quiet alert at ${esc(formatMeters(radius))}.`, 'success');
        rerender();
      });

      window.addEventListener('settings_updated', () => {
        this._applySettings();
        rerender();
      });

      window.addEventListener('control_updated', (e) => {
        const table = e.detail && e.detail.table;
        if (table === 'profiles' || table === 'vehicles') this._populateDriverSelect();
        if (table === 'households') this._populateResidentSwitcher();
        if (table === 'profiles' && e.detail.isNew && e.detail.profile && e.detail.profile.role === 'pending') {
          this._showToast('New sign-in waiting', `${esc(e.detail.profile.email)} is waiting for approval.`, 'info');
        }
        if (table !== 'audit_log') rerender();
      });

      window.addEventListener('store_error', (e) => {
        this._showToast(esc(e.detail.title), esc(e.detail.message), 'error');
      });

      window.addEventListener('my_profile_changed', (e) => {
        const { profile } = e.detail;
        const msg = profile.status === 'suspended' ? 'An admin paused your access.'
          : `You are now ${ROLE_LABELS[profile.role] ? `a ${ROLE_LABELS[profile.role].toLowerCase()}` : profile.role}. Reloading…`;
        this._showToast('Your access changed', esc(msg), 'warning');
        setTimeout(() => window.location.reload(), 2200);
      });

      let lostConnection = false;
      window.addEventListener('connection_status', (e) => {
        const { status } = e.detail;
        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !lostConnection) {
          lostConnection = true;
          this._showToast('Live updates paused', 'Reconnecting to the server…', 'warning');
        } else if (status === 'SUBSCRIBED' && lostConnection) {
          lostConnection = false;
          this._showToast('Live updates back', 'Everything is in sync again.', 'success');
        }
      });

      window.addEventListener('simulation_status', () => this._updateSimBar());
      window.addEventListener('simulation_step',   () => { this._updateSimBar(); rerender(); });
      window.addEventListener('simulation_reset',  () => {
        this._updateSimBar();
        this._showToast('Simulation reset', 'The vehicle is back at the start of the route.', 'info');
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       MASTER UI UPDATE
    ──────────────────────────────────────────────────────────────────── */
    _updateUI() {
      setText('#badge-announcements-spared', this.state.analytics.announcementsAvoided);
      const v = this.state.vehicles[0];
      setText('.val-vehicle-id', v ? v.id : '—');
      this._updateResidentView();
      this._updateDriverView();
      this._updateAdminView();
      this._updateMaps();
    }

    /* ── Resident view (also feeds the split view) ─────────────────────── */
    _updateResidentView() {
      const vehicle = this.state.vehicles[0];
      const house   = this._selectedHouse();
      qsa('#resident-view, #split-view').forEach(v => v.classList.toggle('no-house', !house));

      // Activity — this household's events plus ward-wide broadcasts
      const mine = this.state.notifications.filter(n => n.houseNo === 'ALL' || (house && n.houseNo === house.houseNo));
      const notifHtml = mine.length
        ? mine.slice(0, 12).map(n => `
            <div class="n-item">
              <span class="n-dot t-${esc(n.type)}"></span>
              <div>
                <div class="n-title">${esc(n.title || '')}</div>
                <div class="n-msg">${esc(n.message)}</div>
                <div class="n-time">${relTime(n.timestamp)}</div>
              </div>
            </div>`).join('')
        : `<div class="empty">${house ? 'Nothing yet. You\'ll see the quiet alert here when the truck is close.' : 'Ward-wide notices will appear here.'}</div>`;
      qsa('.resident-notifications-list').forEach(el => { el.innerHTML = notifHtml; });

      if (!house) {
        qsa('.geofence-alert-box').forEach(box => box.classList.remove('visible'));
        qsa('.val-zone-status').forEach(el => {
          el.textContent = 'Outside Zone';
          el.dataset.status = 'outside';
        });
        return;
      }

      const dist = vehicle && vehicle.lat != null ? house.distanceToVehicle : null;
      const arrived = dist != null && dist < ARRIVED_M;
      const [num, unit] = arrived ? ['0', 'm'] : distParts(dist);
      const zoneStatus = computeZoneStatus(house, this.state.settings);

      setText('.val-res-name', house.residentName);
      setText('.val-res-house', `#${house.houseNo}`);
      setText('.val-res-address', house.address);
      setText('.val-res-distance', fmtDist(dist));
      setText('.val-res-distance-num', num);
      setText('.val-res-distance-unit', unit);
      setText('.val-res-direction', (vehicle && vehicle.direction && vehicle.direction.label) || '—');
      setText('.val-res-eta', arrived ? 'At your gate' : ((dist != null && house.eta && house.eta.formatted) || '—'));
      setText('.val-res-locality', (vehicle && vehicle.locality) || '—');

      qsa('.val-zone-status').forEach(el => {
        el.textContent = zoneStatus.label;
        el.dataset.status = zoneStatus.code;
      });
      qsa('.geofence-alert-box').forEach(box => box.classList.toggle('visible', !!house.isInGeofence));

      // This household's own alert distance drives the track, legend and ring
      const radius = this._houseRadius(house);
      const trackMax = trackMaxFor(radius);
      setText('.val-house-radius', formatMeters(radius));
      setText('.val-track-max', formatMeters(trackMax));
      qsa('.geofence-mark').forEach(el => {
        el.style.left = `${Math.max(0, Math.min(100, ((trackMax - radius) / trackMax) * 100))}%`;
        el.title = `Alert at ${formatMeters(radius)}`;
      });
      if (!this._rangeDragging) this._renderAlertRange();

      qsa('.btn-garbage-ready').forEach(btn => {
        btn.querySelector('.btn-label').textContent = house.garbageReady ? 'Garbage is ready' : 'Mark garbage ready';
        btn.classList.toggle('ready', !!house.garbageReady);
      });

      // Distance track fills as the vehicle closes in
      const pct = dist != null ? Math.max(0, Math.min(100, ((trackMax - dist) / trackMax) * 100)) : 0;
      qsa('.distance-progress').forEach(bar => { bar.style.width = `${pct}%`; });

      const myPickups = this.state.pickupRequests.filter(r => r.houseNo === house.houseNo);
      const pickupHtml = myPickups.length
        ? myPickups.slice(0, 3).map(r => this._renderStageTracker(r)).join('')
        : '<div class="empty">No pickup requests. Away from home? Request one above.</div>';
      qsa('.resident-pickup-tracker-wrapper').forEach(el => { el.innerHTML = pickupHtml; });
    }

    _renderStageTracker(r) {
      const missed = r.status === 'Missed';
      const stages = [
        { key: 'Pending',  at: r.createdAt },
        { key: 'Accepted', at: r.acceptedAt },
        missed ? { key: 'Missed', at: r.missedAt } : { key: 'Collected', at: r.collectedAt },
      ];
      const reached = stages.findIndex(s => s.key === r.status);

      const steps = stages.map((s, i) => {
        const state = i < reached ? 'done' : i === reached ? 'current' : 'todo';
        const finished = state === 'done' || (state === 'current' && i === 2);
        return `
          <div class="stage-step ${state}${s.key === 'Missed' ? ' missed' : ''}">
            <div class="stage-dot">${finished ? (s.key === 'Missed' ? '✕' : '✓') : i + 1}</div>
            <div class="stage-label">${s.key}</div>
            <div class="stage-time">${s.at && i <= reached ? relTime(s.at) : ''}</div>
          </div>`;
      }).join('<div class="stage-line"></div>');

      return `
        <div class="stage-card">
          <div class="stage-card-head">
            <div class="stage-card-title"><span class="mono">${esc(r.id)}</span>${esc(r.wasteType)}</div>
            ${statusPill(r.status)}
          </div>
          <div class="stage-tracker">${steps}</div>
        </div>`;
    }

    /* ── Driver view ───────────────────────────────────────────────────── */
    _updateDriverView() {
      const vehicle = this.state.vehicles[0];
      const canDrive = this.canDrive;
      byId('drv-no-vehicle').hidden = !(this.role === 'driver' && !canDrive);
      byId('gps-card').hidden = !canDrive;
      byId('btn-open-emergency-modal').hidden = !canDrive;

      if (!vehicle) {
        setText('#drv-display-name', this.role === 'driver' ? (this.profile.fullName || 'Driver') : 'No vehicles yet');
        setText('#drv-plate', 'add one in Control › Fleet');
        setText('.val-drv-speed', '—');
        setText('.val-drv-heading', '—');
        setText('.val-drv-locality', '—');
      } else {
        const { speed = 0, direction = {}, bearing = 0, locality = '' } = vehicle;
        const shownName = this.role === 'driver' && !canDrive ? (this.profile.fullName || 'Driver') : (vehicle.driverName || 'No driver assigned');
        setText('#drv-display-name', shownName);
        setText('#drv-plate', vehicle.plateNumber || '—');
        setText('.val-drv-speed',    `${Math.round(speed)} km/h`);
        setText('.val-drv-heading',  direction.name ? `${direction.name} ${Math.round(bearing)}°` : '—');
        setText('.val-drv-locality', locality || '—');
      }

      const sim   = this.state.simulation;
      const total = sim.route.length;
      const cur   = sim.currentIndex || 0;
      const live  = vehicle && vehicle.trackingMode === 'live_gps';
      const pct   = total > 1 ? Math.round((cur / (total - 1)) * 100) : 0;
      byId('drv-route-progress-bar').style.width = live ? '0%' : `${pct}%`;
      setText('#drv-route-step', live ? 'Live GPS' : `Waypoint ${cur + 1} of ${total}`);
      setText('#drv-route-pct',  live ? '—' : `${pct}%`);

      // Open pickup queue, nearest first
      const canWork = this.role === 'admin' || this.role === 'driver' || this.isDemo;
      const open = this.state.pickupRequests
        .filter(r => r.status === 'Pending' || r.status === 'Accepted')
        .sort((a, b) => (a.distanceToVehicle || 0) - (b.distanceToVehicle || 0));
      const queueHtml = open.length
        ? open.map(r => `
            <div class="q-item${r.status === 'Accepted' ? ' is-accepted' : ''}">
              <div class="q-head">
                <div>
                  <div class="q-title">House #${esc(r.houseNo)} · ${esc(r.residentName)}</div>
                  <div class="q-dist">${r.distanceToVehicle != null ? `${fmtDist(r.distanceToVehicle)} away` : 'Distance unknown'}</div>
                </div>
                ${statusPill(r.status)}
              </div>
              <div class="q-meta">
                <div>${esc(r.address)}</div>
                ${r.landmark ? `<div><span class="q-k">Landmark</span> ${esc(r.landmark)}</div>` : ''}
                <div><span class="q-k">Waste</span> ${esc(r.wasteType)}</div>
              </div>
              ${r.note ? `<div class="q-note">${esc(r.note)}</div>` : ''}
              <div class="q-foot">Requested ${relTime(r.createdAt)}</div>
              ${canWork ? `
              <div class="q-actions">
                <button class="btn btn-accent btn-xs" data-action="collect-pickup" data-id="${esc(r.id)}">Mark as collected</button>
                ${r.status === 'Pending' ? `<button class="btn btn-outline btn-xs" data-action="accept-pickup" data-id="${esc(r.id)}">Accept</button>` : ''}
                <button class="btn btn-danger-quiet btn-xs" data-action="miss-pickup" data-id="${esc(r.id)}">Missed</button>
              </div>` : ''}
            </div>`).join('')
        : '<div class="empty">No open pickup requests.</div>';
      qsa('.pickup-queue-container').forEach(el => { el.innerHTML = queueHtml; });

      // Households that pressed "Garbage ready", nearest first
      const ready = this.state.houses
        .filter(h => h.garbageReady)
        .sort((a, b) => (a.distanceToVehicle || 0) - (b.distanceToVehicle || 0));
      const readyHtml = ready.length
        ? ready.map(h => `
            <div class="ready-item">
              <div>
                <div class="ready-item-name">House #${esc(h.houseNo)} · ${esc(h.residentName)}</div>
                <div class="ready-item-sub">${esc(h.landmark || h.address)}</div>
              </div>
              <span class="ready-item-dist">${fmtDist(h.distanceToVehicle)}</span>
            </div>`).join('')
        : '<div class="empty">No households have marked bins ready yet.</div>';
      qsa('.driver-ready-bins').forEach(el => { el.innerHTML = readyHtml; });
    }

    /* ── Admin view ────────────────────────────────────────────────────── */
    _updateAdminView() {
      if (!this.views.includes('admin')) return;
      const a = this.state.analytics;

      setText('#adm-announcements', a.announcementsAvoided);
      setText('#adm-decibels',      Number(a.decibelHoursSaved || 0).toFixed(1));
      setText('#adm-efficiency',    `${Number(a.collectionEfficiencyPct || 0).toFixed(1)}%`);
      setText('#adm-schedule',      a.delayNotices
        ? `${a.delayNotices} delay notice${a.delayNotices > 1 ? 's' : ''} today`
        : 'Route running on schedule');
      setText('#adm-pickups',       a.collectionsToday);
      setText('#adm-missed',        a.missedPickups);

      const sim   = this.state.simulation;
      const total = sim.route.length;
      const pct   = total > 1 ? Math.round(((sim.currentIndex || 0) / (total - 1)) * 100) : 0;
      const delayed = a.delayNotices > 0;
      const vehicles = this.state.vehicles;
      byId('admin-vehicles-tbody').innerHTML = vehicles.length ? vehicles.map((v, i) => {
        const tracked = i === 0;
        const live = v.trackingMode === 'live_gps';
        const route = !tracked || v.lat == null ? '<span class="sub">—</span>'
          : live ? '<span class="state state-ok">Live GPS</span>'
          : `<div class="mini-track"><div class="track"><div class="track-fill" style="width:${pct}%"></div></div><span class="mono">${pct}%</span></div>`;
        const state = v.status !== 'active'
          ? `<span class="state state-out">${v.status === 'maintenance' ? 'In maintenance' : 'Retired'}</span>`
          : `<span class="state ${delayed ? 'state-warn' : 'state-ok'}">${delayed ? 'Delayed' : 'Active'}</span>`;
        return `
        <tr>
          <td><strong>${esc(v.id)}</strong></td>
          <td>${esc(v.driverName || '—')}</td>
          <td class="num">${esc(v.plateNumber || '—')}</td>
          <td>${esc(v.locality || '—')}</td>
          <td class="num">${v.lat != null ? `${Math.round(v.speed || 0)} km/h` : '—'}</td>
          <td>${esc(v.lat != null && v.direction ? v.direction.label : '—')}</td>
          <td>${route}</td>
          <td>${state}</td>
        </tr>`;
      }).join('') : '<tr class="empty-row"><td colspan="8">No vehicles yet. Add one in Control › Fleet.</td></tr>';

      byId('admin-houses-tbody').innerHTML = this.state.houses.length ? this.state.houses.map(h => `
        <tr>
          <td><strong>#${esc(h.houseNo)}</strong></td>
          <td>${esc(h.residentName)}</td>
          <td>${esc(h.ward)}</td>
          <td class="num">${fmtDist(h.distanceToVehicle)}</td>
          <td><span class="state ${h.isInGeofence ? 'state-in' : 'state-out'}">${h.isInGeofence ? 'Inside · alerted' : 'Outside'}</span></td>
          <td>${h.garbageReady ? '<span class="state state-ok">Ready</span>' : '<span class="state state-out">Waiting</span>'}</td>
        </tr>`).join('') : '<tr class="empty-row"><td colspan="6">No households registered yet.</td></tr>';

      byId('admin-pickups-tbody').innerHTML = this.state.pickupRequests.length ? this.state.pickupRequests.map(r => `
        <tr>
          <td class="num">${esc(r.id)}</td>
          <td><strong>#${esc(r.houseNo)}</strong></td>
          <td>${esc(r.residentName)}</td>
          <td>${esc(r.address)}<div class="sub">${esc(r.ward)}</div></td>
          <td>${esc(r.landmark || '—')}</td>
          <td class="cell-note">${esc(r.note || '—')}</td>
          <td>${statusPill(r.status)}</td>
        </tr>`).join('') : '<tr class="empty-row"><td colspan="7">No pickup requests yet.</td></tr>';

      byId('admin-emergency-tbody').innerHTML = this.state.emergencyReports.length
        ? this.state.emergencyReports.map(r => `
          <tr>
            <td class="num">${esc(r.id)}</td>
            <td>${esc(r.vehicleId)}</td>
            <td>${esc(r.driverName)}</td>
            <td>${esc(r.type)}</td>
            <td class="cell-note">${esc(r.message)}</td>
            <td>${esc(r.locality)}</td>
            <td class="num">${relTime(r.reportedAt)}</td>
          </tr>`).join('')
        : '<tr class="empty-row"><td colspan="7">No issues reported today.</td></tr>';
    }

    /* ────────────────────────────────────────────────────────────────────
       SIMULATOR DOCK
    ──────────────────────────────────────────────────────────────────── */
    _updateSimBar() {
      const sim   = this.state.simulation;
      const total = sim.route.length;
      const cur   = sim.currentIndex || 0;
      const wp    = sim.route[cur] || {};

      const btnPlay = byId('btn-sim-play');
      btnPlay.classList.toggle('is-playing', sim.isRunning);
      btnPlay.setAttribute('aria-label', sim.isRunning ? 'Pause simulation' : 'Play simulation');

      const dock = qs('.dock');
      const locked = this.liveGps || !this.canDrive;
      dock.classList.toggle('is-locked', locked);

      setText('#sim-step-count', `${String(cur + 1).padStart(2, '0')}/${total}`);
      setText('#sim-waypoint-label', this.liveGps ? 'Live GPS is driving the truck'
        : !this.canDrive ? 'No vehicle assigned to you'
        : (wp.label || ''));
      qsa('.shortcut-chip').forEach(chip =>
        chip.classList.toggle('active', Number(chip.dataset.index) === cur));
    }

    /* ────────────────────────────────────────────────────────────────────
       MAPS
    ──────────────────────────────────────────────────────────────────── */
    // Road geometry from the route start up to waypoint `upTo`
    _roadLine(upTo) {
      const route = this.state.simulation.route;
      const line = [[route[0].lat, route[0].lon]];
      for (let i = 1; i <= upTo && i < route.length; i++) {
        const seg = route[i].path || [[route[i].lat, route[i].lon]];
        line.push(...seg.slice(route[i].path ? 1 : 0));
      }
      return line;
    }

    _mapHouses() {
      return this.role === 'resident'
        ? this.state.houses.filter(h => h.ownerId === this.profile.id)
        : this.state.houses;
    }

    // What each map frames: what matters to this viewer (their household and a
    // nearby truck, the driver's truck and stops, or the whole fleet), never the
    // demo route unless there is nothing else. The key changes only when that
    // set changes, so maps don't jump while someone pans.
    _residentZoneAnchor() {
      const house = this._selectedHouse();
      if (house && Number.isFinite(house.lat) && Number.isFinite(house.lon)) {
        return {
          center: [house.lat, house.lon],
          radius: this._houseRadius(house),
          isAlert: Boolean(house.isInGeofence),
          key: `h:${house.id}:${house.lat},${house.lon}`,
        };
      }
      // Fallback: if resident hasn't registered a home yet, center on their open pickup request
      const pickup = this.state.pickupRequests.find(r =>
        (r.status === 'Pending' || r.status === 'Accepted') && Number.isFinite(r.lat) && Number.isFinite(r.lon));
      if (pickup) {
        return {
          center: [pickup.lat, pickup.lon],
          radius: this.state.settings.geofenceRadiusM || 500,
          isAlert: false,
          key: `p:${pickup.id}:${pickup.lat},${pickup.lon}`,
        };
      }
      return null;
    }

    _circleExtents([lat, lon], radiusM) {
      const dLat = radiusM / 111320;
      const dLon = radiusM / (111320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
      return [[lat + dLat, lon], [lat - dLat, lon], [lat, lon + dLon], [lat, lon - dLon]];
    }

    _mapFocus(id) {
      const NEAR_M = 5000;
      const near = (a, b, m) => window.GeoUtils.calculateHaversineDistance(a[0], a[1], b[0], b[1]) <= m;
      const v = this.state.vehicles[0];
      const truck = v && v.lat != null ? [v.lat, v.lon] : null;

      if (id === 'resident-map-container' || id === 'split-map-container') {
        const anchor = this._residentZoneAnchor();
        if (anchor) {
          const home = anchor.center;
          const withTruck = !!truck && near(home, truck, NEAR_M);
          const pts = [...this._circleExtents(home, anchor.radius), home];
          if (withTruck) pts.push(truck);
          return { points: pts, key: `${anchor.key}:${anchor.radius}:${withTruck}` };
        }
      }
      if (id === 'driver-map-container' && truck) {
        const stops = this.state.pickupRequests
          .filter(r => (r.status === 'Pending' || r.status === 'Accepted') && near(truck, [r.lat, r.lon], NEAR_M))
          .map(r => [r.lat, r.lon]);
        return { points: [truck, ...stops], key: `truck:${v.id}:${stops.length}` };
      }

      // Fleet view and fallbacks: households, plus trucks working near them
      const homes = this._mapHouses().map(h => [h.lat, h.lon]);
      const trucks = this.state.vehicles.filter(x => x.lat != null).map(x => [x.lat, x.lon])
        .filter(p => !homes.length || homes.some(hm => near(hm, p, 20000)));
      if (homes.length || trucks.length) {
        return { points: [...homes, ...trucks], key: `fleet:${homes.length}:${trucks.length}` };
      }
      return { points: this.state.simulation.route.map(w => [w.lat, w.lon]), key: 'route' };
    }

    _initMaps() {
      const ids = ['resident-map-container', 'driver-map-container', 'admin-map-container', 'split-map-container'];
      const fullRoute = this._roadLine(this.state.simulation.route.length - 1);

      for (const id of ids) {
        const el = byId(id);
        if (!el || this.maps[id] || !this.views.includes(el.closest('.view').id.replace('-view', ''))) continue;
        try {
          const [lat, lon] = this._mapFocus(id).points[0];
          const inst = window.MapManager.createMap(id, { lat, lon }, 15);
          inst.drawRoute(fullRoute);
          this.maps[id] = inst;
        } catch (err) {
          console.warn(`Map init failed for ${id}:`, err);
        }
      }
      this._updateMaps();
    }

    _updateMaps() {
      if (!Object.keys(this.maps).length) return;
      const vehicle = this.state.vehicles[0];
      const hasPos = vehicle && vehicle.lat != null;
      const houses = this._mapHouses();

      let opts = null;
      if (hasPos && vehicle.trackingMode === 'live_gps') {
        // Real GPS: straight glide between fixes, trail from recent positions
        const here = [vehicle.lat, vehicle.lon];
        const trail = (vehicle.trail || []).map(p => [p.lat, p.lon]).concat([here]);
        const prev = this._lastLivePos;
        opts = { trail, follow: true };
        if (prev && (prev[0] !== here[0] || prev[1] !== here[1])) {
          Object.assign(opts, { path: [prev, here], forward: true, duration: 1200, linear: false });
        }
        this._lastLivePos = here;
        this._lastMapIndex = null;
      } else if (hasPos) {
        this._lastLivePos = null;
        const sim  = this.state.simulation;
        const cur  = sim.currentIndex || 0;
        const last = this._lastMapIndex;
        opts = { trail: this._roadLine(cur) };

        // Adjacent waypoint → glide along the road; anything else jumps
        if (last != null && cur !== last) {
          // While playing, glide for the whole tick at constant speed so segments
          // chain into one continuous drive; manual steps ease in and out
          const interval = Math.max(200, 2500 / (sim.speedMultiplier || 1));
          const duration = sim.isRunning ? interval : 900;
          const linear   = sim.isRunning;
          if (cur === last + 1 && sim.route[cur].path) {
            Object.assign(opts, { path: sim.route[cur].path, forward: true, duration, linear });
          } else if (cur === last - 1 && sim.route[last].path) {
            Object.assign(opts, { path: sim.route[last].path.slice().reverse(), forward: false, duration, linear });
          }
        }
        this._lastMapIndex = cur;
      }

      const anchor = this._residentZoneAnchor();
      const house = this._selectedHouse();
      const ownRadius = house ? this._houseRadius(house) : null;
      for (const [id, inst] of Object.entries(this.maps)) {
        const isResidentMap = id === 'resident-map-container' || id === 'split-map-container';
        const focus = this._mapFocus(id);
        inst.setFocus(focus.points, focus.key);
        inst.setZoneRadius(isResidentMap ? ownRadius : null);
        if (isResidentMap) {
          inst.setHomeZone(anchor ? anchor.center : null, anchor ? anchor.radius : 500, anchor ? anchor.isAlert : false);
        }
        if (opts) inst.updateVehicle(vehicle, opts);
        else inst.hideVehicle();
        inst.updateHouses(houses, this.selectedHouseNo);
        inst.updatePickups(this.state.pickupRequests);
      }
    }

    /* ────────────────────────────────────────────────────────────────────
       TOASTS (title/message must already be escaped)
    ──────────────────────────────────────────────────────────────────── */
    _showToast(title, message, type = 'info') {
      const container = byId('toast-container');
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
      toast.innerHTML = `
        <span class="toast-bar"></span>
        <div>
          <div class="toast-title">${title}</div>
          <div class="toast-msg">${message}</div>
        </div>`;
      container.appendChild(toast);
      while (container.children.length > 4) container.firstElementChild.remove();

      setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 300);
      }, type === 'error' ? 7000 : 4200);
    }
  }

  // Shared helpers for controlPanel.js
  window.UI = { esc, relTime, fmtDist, statusPill, avatarHtml, initials, ROLE_LABELS };
  window.SmartWasteApp = SmartWasteApp;
})();
