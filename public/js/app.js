/**
 * app.js — Main frontend controller
 * Works identically on localhost (Node server) and Vercel (static).
 * Uses window.AppDataStore + window.AppSimulatorEngine (browser-side).
 * Reads state via CustomEvents on window — no SSE or fetch required.
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
    if (diff < 10)   return 'just now';
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
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

  const ARRIVED_M = 30;

  /* ════════════════════════════════════════════════════════════════════════
     SmartWasteApp
  ════════════════════════════════════════════════════════════════════════ */
  class SmartWasteApp {
    constructor() {
      this.currentRole       = 'resident';
      this.selectedHouseNo   = '125';
      this.soundEnabled      = true;
      this.speed             = 1;
      this.hasUserInteracted = false;
      this.maps              = {};            // containerId → MapInstance
      this._lastMapIndex     = null;
      this.state             = window.AppDataStore.getState();
    }

    /* ────────────────────────────────────────────────────────────────────
       INIT
    ──────────────────────────────────────────────────────────────────── */
    init() {
      this._unlockAudio();
      this._setupNavigation();
      this._setupSimControls();
      this._setupModals();
      this._setupSoundToggle();
      this._setupResidentControls();
      this._setupDriverControls();
      this._connectEvents();

      this._populateResidentSwitcher();
      this._updateUI();
      this._updateSimBar();

      const hash = window.location.hash.replace('#', '');
      this._switchRole(['resident', 'driver', 'admin', 'split'].includes(hash) ? hash : 'resident');

      // Maps need the DOM painted first
      setTimeout(() => this._initMaps(), 300);

      // Keep relative timestamps fresh
      setInterval(() => this._updateUI(), 30000);
    }

    /* ────────────────────────────────────────────────────────────────────
       AUDIO UNLOCK (Web Audio needs a user gesture first)
    ──────────────────────────────────────────────────────────────────── */
    _unlockAudio() {
      window.addEventListener('click', () => {
        if (!this.hasUserInteracted) {
          this.hasUserInteracted = true;
          if (window.audioChime) window.audioChime.init();
        }
      }, { once: true });
    }

    /* ────────────────────────────────────────────────────────────────────
       NAVIGATION
    ──────────────────────────────────────────────────────────────────── */
    _setupNavigation() {
      qsa('.role-tab').forEach(btn => {
        btn.addEventListener('click', () => this._switchRole(btn.dataset.role));
      });
    }

    _switchRole(role) {
      this.currentRole = role;
      qsa('.role-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.role === role));
      qsa('.view').forEach(panel => panel.classList.toggle('active', panel.id === `${role}-view`));
      history.replaceState(null, '', `#${role}`);
      this._updateUI();

      // Leaflet needs a size refresh once a hidden map becomes visible
      setTimeout(() => Object.values(this.maps).forEach(m => m.invalidateSize()), 60);
    }

    /* ────────────────────────────────────────────────────────────────────
       SIMULATION CONTROLS
    ──────────────────────────────────────────────────────────────────── */
    _setupSimControls() {
      const sim = window.AppSimulatorEngine;

      byId('btn-sim-play').addEventListener('click', () => {
        if (this.state.simulation.isRunning) {
          sim.stop();
        } else {
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

      byId('btn-sim-step-fwd').addEventListener('click',  () => sim.stepForward());
      byId('btn-sim-step-back').addEventListener('click', () => sim.stepBackward());
      byId('btn-sim-reset').addEventListener('click',     () => sim.reset());

      qsa('.shortcut-chip').forEach(chip => {
        chip.addEventListener('click', () => sim.teleport(Number(chip.dataset.index)));
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
    _bindModal(modalId, openSel, closeSel, onOpen) {
      const modal = byId(modalId);
      if (!modal) return null;
      const open  = () => { if (onOpen) onOpen(); modal.classList.add('open'); };
      const close = () => modal.classList.remove('open');
      qsa(openSel).forEach(b => b.addEventListener('click', open));
      qsa(closeSel).forEach(b => b.addEventListener('click', close));
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      return close;
    }

    _setupModals() {
      // ── Pickup request ────────────────────────────────────────────────
      const pickupForm = byId('pickup-request-form');
      const closePickup = this._bindModal('pickup-modal', '.btn-open-pickup-modal', '.btn-close-pickup-modal', () => {
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
      });
      pickupForm.addEventListener('submit', (e) => {
        e.preventDefault();
        window.AppDataStore.createPickupRequest({
          houseNo:      val('req-house-no') || this.selectedHouseNo,
          residentName: val('req-resident-name'),
          ward:         val('req-ward'),
          address:      val('req-address'),
          landmark:     val('req-landmark'),
          note:         val('req-note'),
          wasteType:    val('req-waste-type'),
        });
        closePickup();
        pickupForm.reset();
      });

      // ── Driver issue ──────────────────────────────────────────────────
      const emergForm = byId('emergency-form');
      const closeEmerg = this._bindModal('emergency-modal', '#btn-open-emergency-modal', '.btn-close-emergency-modal');
      emergForm.addEventListener('submit', (e) => {
        e.preventDefault();
        window.AppDataStore.reportEmergency({
          vehicleId: 'GV-04',
          type:    val('emerg-type') || 'Other',
          message: val('emerg-msg'),
        });
        closeEmerg();
        emergForm.reset();
      });

      // ── Register household ────────────────────────────────────────────
      const regForm = byId('register-house-form');
      const closeReg = this._bindModal('register-modal', '#btn-open-register-modal', '.btn-close-register-modal');
      regForm.addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          const house = window.AppDataStore.registerHouse({
            houseNo:      val('reg-house-no'),
            residentName: val('reg-resident-name'),
            ward:         val('reg-ward'),
            address:      val('reg-address'),
            landmark:     val('reg-landmark'),
            phone:        val('reg-contact'),
            lat:          val('reg-lat'),
            lon:          val('reg-lon'),
          });
          this.selectedHouseNo = house.houseNo;
          this._populateResidentSwitcher();
          this._updateUI();
          closeReg();
          regForm.reset();
        } catch (err) {
          this._showToast('Registration failed', esc(err.message), 'error');
        }
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

    /* ────────────────────────────────────────────────────────────────────
       RESIDENT CONTROLS
    ──────────────────────────────────────────────────────────────────── */
    _selectedHouse() {
      return this.state.houses.find(h => h.houseNo === this.selectedHouseNo) || this.state.houses[0];
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
          if (house) window.AppDataStore.setGarbageReady(house.houseNo, !house.garbageReady);
        });
      });
    }

    _populateResidentSwitcher() {
      const sel = byId('resident-account-select');
      sel.innerHTML = this.state.houses.map(h =>
        `<option value="${esc(h.houseNo)}" ${h.houseNo === this.selectedHouseNo ? 'selected' : ''}>#${esc(h.houseNo)} · ${esc(h.residentName)}</option>`
      ).join('');
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
        if (status) window.AppDataStore.updatePickupStatus(btn.dataset.id, status);
      });

      const driverSel = byId('driver-profile-select');
      driverSel.addEventListener('change', () => window.AppDataStore.switchDriver(driverSel.value));
    }

    /* ────────────────────────────────────────────────────────────────────
       CUSTOM-EVENT LISTENERS (replaces SSE EventSource)
       State arrays are shared with AppDataStore, so handlers only add
       feedback (toasts, chimes) and re-render.
    ──────────────────────────────────────────────────────────────────── */
    _connectEvents() {
      const rerender = () => this._updateUI();

      window.addEventListener('telemetry_update', rerender);

      window.addEventListener('geofence_alert', (e) => {
        const notif = e.detail;
        // Only the household that entered the zone hears the chime
        if (notif.houseNo === this.selectedHouseNo) {
          this._showToast('Collection vehicle approaching', esc(notif.message), 'success');
          if (this.soundEnabled && window.audioChime) window.audioChime.playChime('geofence');
        }
        rerender();
      });

      window.addEventListener('pickup_request_created', (e) => {
        const { request } = e.detail;
        this._showToast('Pickup requested', `House #${esc(request.houseNo)} · ${esc(request.wasteType)}`, 'info');
        rerender();
      });

      window.addEventListener('pickup_status_updated', (e) => {
        const { request } = e.detail;
        if (request.status === 'Collected') {
          this._showToast('Garbage collected', `House #${esc(request.houseNo)} has been collected.`, 'success');
          if (this.soundEnabled && window.audioChime) window.audioChime.playChime('pickup_collected');
        } else if (request.status === 'Missed') {
          this._showToast('Pickup missed', `House #${esc(request.houseNo)} could not be collected.`, 'warning');
        } else {
          this._showToast('Request updated', `${esc(request.id)} is now ${esc(request.status.toLowerCase())}.`, 'info');
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
        rerender();
      });

      window.addEventListener('driver_switched', (e) => {
        const v = e.detail.vehicle;
        this._showToast('Driver changed', `${esc(v.driverName)} is now driving ${esc(v.id)}.`, 'info');
        rerender();
      });

      window.addEventListener('emergency_reported', (e) => {
        const { report } = e.detail;
        this._showToast('Delay notice sent', `${esc(report.type)} · ${esc(report.message)}`, 'warning');
        rerender();
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
      this._updateResidentView();
      this._updateDriverView();
      this._updateAdminView();
      this._updateMaps();
    }

    /* ── Resident view (also feeds the split view) ─────────────────────── */
    _updateResidentView() {
      const vehicle = this.state.vehicles[0];
      const house   = this._selectedHouse();
      if (!vehicle || !house) return;

      const dist = house.distanceToVehicle;
      const arrived = dist != null && dist < ARRIVED_M;
      const [num, unit] = arrived ? ['0', 'm'] : distParts(dist);

      setText('.val-res-name', house.residentName);
      setText('.val-res-house', `#${house.houseNo}`);
      setText('.val-res-address', house.address);
      setText('.val-res-distance', fmtDist(dist));
      setText('.val-res-distance-num', num);
      setText('.val-res-distance-unit', unit);
      setText('.val-res-direction', (vehicle.direction && vehicle.direction.label) || '—');
      setText('.val-res-eta', arrived ? 'At your gate' : ((house.eta && house.eta.formatted) || '—'));
      setText('.val-res-locality', vehicle.locality || '—');

      qsa('.geofence-alert-box').forEach(box => box.classList.toggle('visible', !!house.isInGeofence));

      qsa('.btn-garbage-ready').forEach(btn => {
        btn.querySelector('.btn-label').textContent = house.garbageReady ? 'Garbage is ready' : 'Mark garbage ready';
        btn.classList.toggle('ready', !!house.garbageReady);
      });

      // Distance track fills as the vehicle closes in from 1.4 km
      const MAX_DIST = 1400;
      const pct = dist != null ? Math.max(0, Math.min(100, ((MAX_DIST - dist) / MAX_DIST) * 100)) : 0;
      qsa('.distance-progress').forEach(bar => { bar.style.width = `${pct}%`; });

      // Activity — this household's events plus ward-wide broadcasts
      const mine = this.state.notifications.filter(n => n.houseNo === house.houseNo || n.houseNo === 'ALL');
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
        : '<div class="empty">Nothing yet. Press play to start the route.</div>';
      qsa('.resident-notifications-list').forEach(el => { el.innerHTML = notifHtml; });

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
      if (!vehicle) return;

      const { speed = 0, direction = {}, bearing = 0, locality = '' } = vehicle;
      const sim   = this.state.simulation;
      const total = sim.route.length;
      const cur   = sim.currentIndex || 0;
      const pct   = total > 1 ? Math.round((cur / (total - 1)) * 100) : 0;

      setText('#drv-display-name', vehicle.driverName);
      const driverSel = byId('driver-profile-select');
      if (driverSel.value !== vehicle.driverName) driverSel.value = vehicle.driverName;

      setText('.val-drv-speed',    `${Math.round(speed)} km/h`);
      setText('.val-drv-heading',  direction.name ? `${direction.name} ${Math.round(bearing)}°` : '—');
      setText('.val-drv-locality', locality || '—');

      byId('drv-route-progress-bar').style.width = `${pct}%`;
      setText('#drv-route-step', `Waypoint ${cur + 1} of ${total}`);
      setText('#drv-route-pct',  `${pct}%`);

      // Open pickup queue, nearest first
      const open = this.state.pickupRequests
        .filter(r => r.status === 'Pending' || r.status === 'Accepted')
        .sort((a, b) => (a.distanceToVehicle || 0) - (b.distanceToVehicle || 0));
      const queueHtml = open.length
        ? open.map(r => `
            <div class="q-item${r.status === 'Accepted' ? ' is-accepted' : ''}">
              <div class="q-head">
                <div>
                  <div class="q-title">House #${esc(r.houseNo)} · ${esc(r.residentName)}</div>
                  <div class="q-dist">${fmtDist(r.distanceToVehicle)} away</div>
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
              <div class="q-actions">
                <button class="btn btn-accent btn-xs" data-action="collect-pickup" data-id="${esc(r.id)}">Mark as collected</button>
                ${r.status === 'Pending' ? `<button class="btn btn-outline btn-xs" data-action="accept-pickup" data-id="${esc(r.id)}">Accept</button>` : ''}
                <button class="btn btn-danger-quiet btn-xs" data-action="miss-pickup" data-id="${esc(r.id)}">Missed</button>
              </div>
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
      const vehicle = this.state.vehicles[0];
      if (!vehicle) return;
      const a = this.state.analytics;

      setText('#adm-announcements', a.announcementsAvoided);
      setText('#adm-decibels',      a.decibelHoursSaved.toFixed(1));
      setText('#adm-efficiency',    `${a.collectionEfficiencyPct.toFixed(1)}%`);
      setText('#adm-schedule',      a.delayNotices
        ? `${a.delayNotices} delay notice${a.delayNotices > 1 ? 's' : ''} today`
        : 'Route running on schedule');
      setText('#adm-pickups',       a.collectionsToday);
      setText('#adm-missed',        a.missedPickups);

      const sim   = this.state.simulation;
      const total = sim.route.length;
      const pct   = total > 1 ? Math.round(((sim.currentIndex || 0) / (total - 1)) * 100) : 0;
      const delayed = a.delayNotices > 0;
      byId('admin-vehicles-tbody').innerHTML = `
        <tr>
          <td><strong>${esc(vehicle.id)}</strong></td>
          <td>${esc(vehicle.driverName)}</td>
          <td class="num">${esc(vehicle.plateNumber || '—')}</td>
          <td>${esc(vehicle.locality || '—')}</td>
          <td class="num">${Math.round(vehicle.speed || 0)} km/h</td>
          <td>${esc((vehicle.direction && vehicle.direction.label) || '—')}</td>
          <td><div class="mini-track"><div class="track"><div class="track-fill" style="width:${pct}%"></div></div><span class="mono">${pct}%</span></div></td>
          <td><span class="state ${delayed ? 'state-warn' : 'state-ok'}">${delayed ? 'Delayed' : 'Active'}</span></td>
        </tr>`;

      byId('admin-houses-tbody').innerHTML = this.state.houses.map(h => `
        <tr>
          <td><strong>#${esc(h.houseNo)}</strong></td>
          <td>${esc(h.residentName)}</td>
          <td>${esc(h.ward)}</td>
          <td class="num">${fmtDist(h.distanceToVehicle)}</td>
          <td><span class="state ${h.isInGeofence ? 'state-in' : 'state-out'}">${h.isInGeofence ? 'Inside · alerted' : 'Outside'}</span></td>
          <td>${h.garbageReady ? '<span class="state state-ok">Ready</span>' : '<span class="state state-out">Waiting</span>'}</td>
        </tr>`).join('');

      byId('admin-pickups-tbody').innerHTML = this.state.pickupRequests.map(r => `
        <tr>
          <td class="num">${esc(r.id)}</td>
          <td><strong>#${esc(r.houseNo)}</strong></td>
          <td>${esc(r.residentName)}</td>
          <td>${esc(r.address)}<div class="sub">${esc(r.ward)}</div></td>
          <td>${esc(r.landmark || '—')}</td>
          <td class="cell-note">${esc(r.note || '—')}</td>
          <td>${statusPill(r.status)}</td>
        </tr>`).join('');

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

      setText('#sim-step-count', `${String(cur + 1).padStart(2, '0')}/${total}`);
      setText('#sim-waypoint-label', wp.label || '');
      qsa('.shortcut-chip').forEach(chip =>
        chip.classList.toggle('active', Number(chip.dataset.index) === cur));
    }

    /* ────────────────────────────────────────────────────────────────────
       LEAFLET MAPS
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

    _initMaps() {
      const ids = ['resident-map-container', 'driver-map-container', 'admin-map-container', 'split-map-container'];
      const fullRoute = this._roadLine(this.state.simulation.route.length - 1);

      for (const id of ids) {
        if (!byId(id) || this.maps[id]) continue;
        try {
          const inst = window.MapManager.createMap(id, { lat: 12.938, lon: 77.627 }, 15);
          inst.drawRoute(fullRoute);
          this.maps[id] = inst;
        } catch (err) {
          console.warn(`Map init failed for ${id}:`, err);
        }
      }
      this._updateMaps();
    }

    _updateMaps() {
      const vehicle = this.state.vehicles[0];
      if (!vehicle || !Object.keys(this.maps).length) return;

      const sim  = this.state.simulation;
      const cur  = sim.currentIndex || 0;
      const last = this._lastMapIndex;
      const opts = { trail: this._roadLine(cur) };

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

      for (const inst of Object.values(this.maps)) {
        inst.updateVehicle(vehicle, opts);
        inst.updateHouses(this.state.houses, this.selectedHouseNo);
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
      }, 4200);
    }
  }

  /* ── Bootstrap ───────────────────────────────────────────────────────── */
  window.addEventListener('DOMContentLoaded', () => {
    window.app = new SmartWasteApp();
    window.app.init();
  });
})();
