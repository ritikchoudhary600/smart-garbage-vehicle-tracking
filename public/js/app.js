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
  function setHTML(sel, val, root = document) {
    const el = qs(sel, root); if (el) el.innerHTML = val;
  }
  function byId(id) { return document.getElementById(id); }

  function relTime(iso) {
    if (!iso) return '';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  /* ════════════════════════════════════════════════════════════════════════
     SmartWasteApp
  ════════════════════════════════════════════════════════════════════════ */
  class SmartWasteApp {
    constructor() {
      this.currentRole       = 'resident';
      this.selectedHouseNo   = '125';
      this.soundEnabled      = true;
      this.hasUserInteracted = false;
      this.maps              = {};            // containerId → MapInstance
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

      // Populate resident switcher
      this._populateResidentSwitcher();

      // Initial full render
      this._updateUI();

      // Switch to hash role
      const hash = window.location.hash.replace('#', '');
      this._switchRole(['resident', 'driver', 'admin', 'split'].includes(hash) ? hash : 'resident');

      // Maps need DOM to be painted
      setTimeout(() => this._initMaps(), 400);
    }

    /* ────────────────────────────────────────────────────────────────────
       AUDIO UNLOCK (Web Audio needs user gesture first)
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
      // Top nav buttons (class: role-tab nav-btn, data-role)
      qsa('.role-tab').forEach(btn => {
        btn.addEventListener('click', () => this._switchRole(btn.dataset.role));
      });
    }

    _switchRole(role) {
      this.currentRole = role;

      // Toggle active class on nav buttons
      qsa('.role-tab').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.role === role));

      // Show/hide view panels — panels have id="resident-view" etc.
      qsa('.view-panel').forEach(panel => {
        const panelRole = panel.id.replace('-view', '');
        panel.classList.toggle('active', panelRole === role);
      });

      window.location.hash = role;
      this._updateUI();

      // Invalidate Leaflet map size after transition
      setTimeout(() => {
        const mapId = {
          resident: 'resident-map-container',
          driver:   'driver-map-container',
          admin:    'admin-map-container',
          split:    'split-map-container',
        }[role];
        if (mapId && this.maps[mapId]) this.maps[mapId].invalidateSize();
      }, 160);
    }

    /* ────────────────────────────────────────────────────────────────────
       SIMULATION CONTROLS
    ──────────────────────────────────────────────────────────────────── */
    _setupSimControls() {
      const btnPlay  = byId('btn-sim-play');
      const btnFwd   = byId('btn-sim-step-fwd');
      const btnBack  = byId('btn-sim-step-back');
      const btnReset = byId('btn-sim-reset');
      const speedSel = byId('sim-speed-select');

      if (btnPlay) {
        btnPlay.addEventListener('click', () => {
          if (this.state.simulation.isRunning) {
            window.AppSimulatorEngine.stop();
          } else {
            window.AppSimulatorEngine.start(Number(speedSel ? speedSel.value : 1));
          }
        });
      }
      if (speedSel) {
        speedSel.addEventListener('change', () => {
          if (this.state.simulation.isRunning)
            window.AppSimulatorEngine.start(Number(speedSel.value));
        });
      }
      if (btnFwd)   btnFwd.addEventListener('click',   () => window.AppSimulatorEngine.stepForward());
      if (btnBack)  btnBack.addEventListener('click',  () => window.AppSimulatorEngine.stepBackward());
      if (btnReset) btnReset.addEventListener('click', () => window.AppSimulatorEngine.reset());

      // Quick-jump chips (data-index)
      qsa('.shortcut-chip').forEach(chip => {
        chip.addEventListener('click', () =>
          window.AppSimulatorEngine.teleport(Number(chip.dataset.index)));
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       MODALS
    ──────────────────────────────────────────────────────────────────── */
    _setupModals() {
      // ── Pickup Request Modal ──────────────────────────────────────────
      const pickupModal = byId('pickup-modal');
      qsa('.btn-open-pickup-modal').forEach(b =>
        b.addEventListener('click', () => pickupModal && pickupModal.classList.add('open')));
      qsa('.btn-close-pickup-modal').forEach(b =>
        b.addEventListener('click', () => pickupModal && pickupModal.classList.remove('open')));

      const pickupForm = byId('pickup-request-form');
      if (pickupForm) {
        pickupForm.addEventListener('submit', (e) => {
          e.preventDefault();
          window.AppDataStore.createPickupRequest({
            houseNo:      (byId('req-house-no')      || {}).value || this.selectedHouseNo,
            residentName: (byId('req-resident-name') || {}).value || 'Resident',
            ward:         (byId('req-ward')          || {}).value || 'Ward 4',
            landmark:     (byId('req-landmark')      || {}).value || '',
            note:         (byId('req-note')          || {}).value || '',
            wasteType:    (byId('req-waste-type')    || {}).value || 'Mixed Waste',
          });
          pickupModal && pickupModal.classList.remove('open');
          pickupForm.reset();
        });
      }

      // ── Emergency Modal ───────────────────────────────────────────────
      const emergModal  = byId('emergency-modal');
      const btnEmerg    = byId('btn-open-emergency-modal');
      if (btnEmerg) btnEmerg.addEventListener('click', () => emergModal && emergModal.classList.add('open'));
      qsa('.btn-close-emergency-modal').forEach(b =>
        b.addEventListener('click', () => emergModal && emergModal.classList.remove('open')));

      const emergForm = byId('emergency-form');
      if (emergForm) {
        emergForm.addEventListener('submit', (e) => {
          e.preventDefault();
          window.AppDataStore.reportEmergency({
            vehicleId: 'GV-04',
            type:    (byId('emerg-type') || {}).value || 'Other',
            message: (byId('emerg-msg')  || {}).value || '',
          });
          emergModal && emergModal.classList.remove('open');
          emergForm.reset();
        });
      }

      // ── Register Household Modal ──────────────────────────────────────
      const regModal = byId('register-modal');
      const btnReg   = byId('btn-open-register-modal');
      if (btnReg) btnReg.addEventListener('click', () => regModal && regModal.classList.add('open'));
      qsa('.btn-close-register-modal').forEach(b =>
        b.addEventListener('click', () => regModal && regModal.classList.remove('open')));

      const regForm = byId('register-household-form');
      if (regForm) {
        regForm.addEventListener('submit', (e) => {
          e.preventDefault();
          // Add the new house to AppDataStore
          const houseNo = (byId('new-house-no') || {}).value || '';
          const name    = (byId('new-resident-name') || {}).value || 'Resident';
          const ward    = (byId('new-ward') || {}).value || 'Ward 4';
          const newHouse = {
            id: `H${String(Date.now()).slice(-4)}`,
            houseNo, residentName: name, ward,
            address: `House ${houseNo}, ${ward}`,
            lat: 12.9415 + (Math.random() - 0.5) * 0.005,
            lon: 77.6290 + (Math.random() - 0.5) * 0.005,
            garbageReady: false, isInGeofence: false,
            distanceToVehicle: null, bearing: null, direction: null, eta: null,
            notifiedAt: null, phone: '',
          };
          window.AppDataStore.houses.push(newHouse);
          this._populateResidentSwitcher();
          this._showToast('🏠 Household Registered', `House #${houseNo} added to Ward 4.`, 'success');
          regModal && regModal.classList.remove('open');
          regForm.reset();
        });
      }
    }

    /* ────────────────────────────────────────────────────────────────────
       SOUND TOGGLE
    ──────────────────────────────────────────────────────────────────── */
    _setupSoundToggle() {
      const btn = byId('btn-sound-toggle');
      if (!btn) return;
      btn.addEventListener('click', () => {
        this.soundEnabled = !this.soundEnabled;
        btn.textContent   = this.soundEnabled ? '🔔 Audio Alert On' : '🔕 Audio Alert Off';
        btn.title         = this.soundEnabled ? 'Click to mute digital chime' : 'Click to unmute digital chime';
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       RESIDENT CONTROLS
    ──────────────────────────────────────────────────────────────────── */
    _setupResidentControls() {
      // Resident account switcher (dropdown)
      const acctSel = byId('resident-account-select');
      if (acctSel) {
        acctSel.addEventListener('change', () => {
          this.selectedHouseNo = acctSel.value;
          this._updateResidentView();
        });
      }

      // Garbage-ready button (main resident view)
      const grBtn = byId('btn-garbage-ready');
      if (grBtn) {
        grBtn.addEventListener('click', () => {
          const house = this.state.houses.find(h => h.houseNo === this.selectedHouseNo);
          if (!house) return;
          window.AppDataStore.setGarbageReady(this.selectedHouseNo, !house.garbageReady);
        });
      }
    }

    _populateResidentSwitcher() {
      const sel = byId('resident-account-select');
      if (!sel) return;
      sel.innerHTML = this.state.houses.map(h =>
        `<option value="${h.houseNo}" ${h.houseNo === this.selectedHouseNo ? 'selected' : ''}>
          House #${h.houseNo} — ${h.residentName}
        </option>`
      ).join('');
    }

    /* ────────────────────────────────────────────────────────────────────
       DRIVER CONTROLS (delegated)
    ──────────────────────────────────────────────────────────────────── */
    _setupDriverControls() {
      document.addEventListener('click', (e) => {
        if (e.target.matches('[data-action="accept-pickup"]'))
          window.AppDataStore.updatePickupStatus(e.target.dataset.id, 'Accepted');
        else if (e.target.matches('[data-action="collect-pickup"]'))
          window.AppDataStore.updatePickupStatus(e.target.dataset.id, 'Collected');
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       CUSTOM-EVENT LISTENERS (replaces SSE EventSource)
    ──────────────────────────────────────────────────────────────────── */
    _connectEvents() {
      window.addEventListener('telemetry_update', (e) => {
        const { vehicle, houses, analytics } = e.detail;
        if (vehicle) {
          const idx = this.state.vehicles.findIndex(v => v.id === vehicle.id);
          if (idx >= 0) this.state.vehicles[idx] = vehicle; else this.state.vehicles.push(vehicle);
        }
        if (houses)    this.state.houses    = houses;
        if (analytics) this.state.analytics = analytics;
        this._updateUI();
      });

      window.addEventListener('geofence_alert', (e) => {
        const notif = e.detail;
        this.state.notifications.unshift(notif);
        this._showToast('🚨 500m Geofence Alert!', notif.message, 'success');
        if (this.soundEnabled && window.audioChime) window.audioChime.playChime('geofence');
        this._updateUI();
      });

      window.addEventListener('pickup_request_created', (e) => {
        const { request, pickupRequests } = e.detail;
        this.state.pickupRequests = pickupRequests;
        this._showToast('📦 Pickup Requested', `House #${request.houseNo} — ${request.wasteType}`, 'info');
        this._updateUI();
      });

      window.addEventListener('pickup_status_updated', (e) => {
        const { request, pickupRequests, analytics } = e.detail;
        this.state.pickupRequests = pickupRequests;
        if (analytics) this.state.analytics = analytics;
        if (request.status === 'Collected') {
          this._showToast('✅ Garbage Collected!', `House #${request.houseNo} marked as collected.`, 'success');
          if (this.soundEnabled && window.audioChime) window.audioChime.playChime('pickup_collected');
        } else {
          this._showToast('🔄 Request Updated', `#${request.id} → ${request.status}`, 'info');
        }
        this._updateUI();
      });

      window.addEventListener('garbage_ready_updated', (e) => {
        const { houseNo, garbageReady } = e.detail;
        const house = this.state.houses.find(h => h.houseNo === String(houseNo));
        if (house) house.garbageReady = garbageReady;
        this._showToast(garbageReady ? '✅ Garbage Marked Ready' : '↩️ Status Reset',
          `House #${houseNo} garbage ready: ${garbageReady}`, 'info');
        this._updateUI();
      });

      window.addEventListener('emergency_reported', (e) => {
        const { report } = e.detail;
        this._showToast('⚠️ Emergency Reported', `${report.type}: ${report.message}`, 'warning');
      });

      window.addEventListener('simulation_status', (e) => {
        const { isRunning, currentIndex, speedMultiplier } = e.detail;
        this.state.simulation.isRunning       = isRunning;
        this.state.simulation.currentIndex    = currentIndex;
        this.state.simulation.speedMultiplier = speedMultiplier;
        this._updateSimBar();
      });

      window.addEventListener('simulation_step', (e) => {
        this.state.simulation.currentIndex = e.detail.currentIndex;
        this._updateSimBar();
      });

      window.addEventListener('simulation_reset', () => {
        this.state.simulation.currentIndex = 0;
        this.state.simulation.isRunning    = false;
        this._updateSimBar();
        this._showToast('⏮️ Simulation Reset', 'Vehicle returned to depot start.', 'info');
      });
    }

    /* ────────────────────────────────────────────────────────────────────
       MASTER UI UPDATE
    ──────────────────────────────────────────────────────────────────── */
    _updateUI() {
      this._updateResidentView();
      this._updateDriverView();
      this._updateAdminView();
      this._updateSplitView();
      this._updateMaps();
    }

    /* ── Resident view ─────────────────────────────────────────────────── */
    _updateResidentView() {
      const vehicle = this.state.vehicles[0];
      const house   = this.state.houses.find(h => h.houseNo === this.selectedHouseNo)
                   || this.state.houses[0];
      if (!vehicle || !house) return;

      const dist = house.distanceToVehicle;
      const dir  = house.direction || {};
      const eta  = house.eta || {};

      // Update all elements with class val-res-distance (resident view + split view)
      setText('.val-res-distance', dist ? `${Math.round(dist)} m` : '—');
      setText('.val-res-direction', dir.label || '—');
      setText('.val-res-eta', eta.formatted || '—');
      setText('.val-res-locality', vehicle.locality || '—');

      // Geofence alert box — show/hide
      const alertBox = byId('resident-geofence-alert');
      if (alertBox) {
        alertBox.style.display = house.isInGeofence ? 'block' : 'none';
        // Update distance inside alert
        const distSpan = alertBox.querySelector('.val-res-distance');
        if (distSpan && dist) distSpan.textContent = `${Math.round(dist)} m`;
      }

      // Garbage Ready button
      const grBtn = byId('btn-garbage-ready');
      if (grBtn) {
        grBtn.querySelector('span:last-child').textContent =
          house.garbageReady ? 'Garbage Ready ✅ (Tap to Undo)' : 'Mark Garbage Ready';
        grBtn.classList.toggle('active', house.garbageReady);
      }

      // Distance progress bar
      const MAX_DIST = 1400;
      const pct = dist ? Math.max(0, Math.min(100, ((MAX_DIST - dist) / MAX_DIST) * 100)) : 0;
      qsa('.distance-progress').forEach(bar => { bar.style.width = `${pct}%`; });

      // Notification history list (class: resident-notifications-list)
      const notifHtml = this.state.notifications.length
        ? this.state.notifications.slice(0, 8).map(n => `
            <div class="notif-item">
              <div style="display:flex;align-items:center;gap:6px;">
                <span>${n.type === 'geofence_alert' ? '🚨' : '📋'}</span>
                <span style="font-size:0.82rem;color:var(--text-main);flex:1;">${n.message}</span>
              </div>
              <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px;">${relTime(n.timestamp)}</div>
            </div>`).join('')
        : '<div style="color:var(--text-muted);font-size:0.82rem;padding:8px 0;">No notifications yet. Start the simulation! ▶</div>';
      qsa('.resident-notifications-list').forEach(el => { el.innerHTML = notifHtml; });

      // Pickup tracker (class: resident-pickup-tracker-wrapper)
      const myPickups = this.state.pickupRequests.filter(r => r.houseNo === this.selectedHouseNo);
      const pickupHtml = myPickups.length
        ? myPickups.map(r => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:0.82rem;">
              <span>📦 ${r.id} — ${r.wasteType}</span>
              <span class="badge status-${r.status.toLowerCase()}" style="font-size:0.72rem;padding:2px 8px;border-radius:4px;background:${r.status==='Collected'?'#ecfdf5':r.status==='Accepted'?'#eff6ff':'#fef9c3'};color:${r.status==='Collected'?'#065f46':r.status==='Accepted'?'#1e40af':'#713f12'};">
                ${r.status}
              </span>
            </div>`).join('')
        : '<div style="color:var(--text-muted);font-size:0.8rem;">No pickup requests for this house.</div>';
      qsa('.resident-pickup-tracker-wrapper').forEach(el => { el.innerHTML = pickupHtml; });
    }

    /* ── Driver view ───────────────────────────────────────────────────── */
    _updateDriverView() {
      const vehicle = this.state.vehicles[0];
      if (!vehicle) return;

      const { speed = 0, direction = {}, locality = '', status = 'active' } = vehicle;
      const sim = this.state.simulation;
      const total = (sim.route || []).length;
      const cur   = sim.currentIndex || 0;
      const pct   = total > 1 ? Math.round((cur / (total - 1)) * 100) : 0;

      // Driver header telemetry badges
      setText('.val-drv-speed',   `${Math.round(speed)} km/h`);
      setText('.val-drv-heading', direction.label || '—');
      setText('.val-drv-locality', locality || '—');

      // Route progress bar
      const routeBar = byId('drv-route-progress-bar');
      if (routeBar) routeBar.style.width = `${pct}%`;
      const routeStep = byId('drv-route-step');
      if (routeStep) routeStep.textContent = `Waypoint ${cur + 1} of ${total}`;
      const routePct = byId('drv-route-pct');
      if (routePct) routePct.textContent = `${pct}% Completed`;

      // Pending pickups queue (class: pickup-queue-container)
      const pending = this.state.pickupRequests.filter(r => r.status !== 'Collected');
      const pickupQueueHtml = pending.length
        ? pending.map(r => `
            <div style="border:1px solid var(--border);border-radius:var(--radius-md);padding:12px;margin-bottom:10px;background:${r.status==='Accepted'?'#f0fdf4':'#fff'};">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
                <strong style="font-size:0.88rem;color:var(--text-main);">📍 House #${r.houseNo} — ${r.wasteType}</strong>
                <span style="font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:4px;background:${r.status==='Accepted'?'#d1fae5':'#fef3c7'};color:${r.status==='Accepted'?'#065f46':'#92400e'};">
                  ${r.status}
                </span>
              </div>
              <p style="font-size:0.8rem;color:var(--text-muted);margin:2px 0;">${r.address}</p>
              ${r.landmark ? `<p style="font-size:0.78rem;color:var(--text-muted);">📌 ${r.landmark}</p>` : ''}
              ${r.note ? `<p style="font-size:0.78rem;color:var(--text-muted);">📝 "${r.note}"</p>` : ''}
              <p style="font-size:0.75rem;color:var(--text-muted);">Resident: ${r.residentName} | ${relTime(r.createdAt)}</p>
              <div style="display:flex;gap:8px;margin-top:8px;">
                ${r.status === 'Pending'  ? `<button class="sim-btn primary" style="font-size:0.78rem;padding:4px 12px;" data-action="accept-pickup"  data-id="${r.id}">✅ Accept</button>` : ''}
                ${r.status === 'Accepted' ? `<button class="sim-btn" style="font-size:0.78rem;padding:4px 12px;background:#10b981;color:white;" data-action="collect-pickup" data-id="${r.id}">🗑️ Mark Collected</button>` : ''}
              </div>
            </div>`).join('')
        : '<div style="text-align:center;color:var(--text-muted);padding:24px 0;font-size:0.88rem;">🎉 No pending pickup requests!</div>';
      qsa('.pickup-queue-container').forEach(el => { el.innerHTML = pickupQueueHtml; });
      qsa('.pickup-queue-list').forEach(el => { el.innerHTML = pickupQueueHtml; });
    }

    /* ── Admin view ────────────────────────────────────────────────────── */
    _updateAdminView() {
      const vehicle = this.state.vehicles[0];
      if (!vehicle) return;

      const { id, driverName, locality, speed = 0, direction = {}, status = 'active', lat, lon } = vehicle;

      // KPI stat cards
      const setText1 = (eid, v) => { const el = byId(eid); if (el) el.textContent = v; };
      setText1('adm-announcements', this.state.analytics.noiseReductionEvents + 138);
      setText1('adm-decibels',      `${((this.state.analytics.noiseReductionEvents + 138) * 0.5).toFixed(1)} dB·h`);
      setText1('adm-pickups',       this.state.analytics.collectionsToday);
      setText1('adm-missed',        this.state.analytics.missedPickups);

      // Fleet table (#admin-vehicles-tbody)
      const sim = this.state.simulation;
      const total = (sim.route || []).length;
      const pct   = total > 1 ? Math.round(((sim.currentIndex || 0) / (total - 1)) * 100) : 0;
      const vtbody = byId('admin-vehicles-tbody');
      if (vtbody) {
        vtbody.innerHTML = `
          <tr>
            <td><strong>${id}</strong></td>
            <td>${driverName}</td>
            <td>${vehicle.plateNumber || 'KA-01-GC-4521'}</td>
            <td>${locality || '—'}</td>
            <td>${Math.round(speed)} km/h</td>
            <td>${direction.label || '—'}</td>
            <td>
              <div style="display:flex;align-items:center;gap:6px;">
                <div style="flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;">
                  <div style="width:${pct}%;height:100%;background:#10b981;"></div>
                </div>
                <span style="font-size:0.75rem;font-weight:700;color:#065f46;">${pct}%</span>
              </div>
            </td>
            <td><span style="color:#10b981;font-weight:700;">● ${status}</span></td>
          </tr>`;
      }

      // Houses table (#admin-houses-tbody)
      const htbody = byId('admin-houses-tbody');
      if (htbody) {
        htbody.innerHTML = this.state.houses.map(h => `
          <tr>
            <td><strong>#${h.houseNo}</strong></td>
            <td>${h.residentName}</td>
            <td>${h.ward}</td>
            <td>${h.distanceToVehicle ? Math.round(h.distanceToVehicle) + ' m' : '—'}</td>
            <td>
              <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:700;background:${h.isInGeofence?'#fef2f2':'#f0fdf4'};color:${h.isInGeofence?'#dc2626':'#166534'};">
                ${h.isInGeofence ? '🚨 Inside!' : 'Outside'}
              </span>
            </td>
            <td>${h.garbageReady ? '✅ Ready' : '<span style="color:var(--text-muted);">Waiting</span>'}</td>
          </tr>`).join('');
      }

      // Pickups table (#admin-pickups-tbody)
      const ptbody = byId('admin-pickups-tbody');
      if (ptbody) {
        ptbody.innerHTML = this.state.pickupRequests.map(r => `
          <tr>
            <td><strong>${r.id}</strong></td>
            <td>#${r.houseNo}</td>
            <td>${r.residentName}</td>
            <td>${r.ward}</td>
            <td>${r.landmark || '—'}</td>
            <td style="max-width:200px;font-size:0.8rem;">${r.note || '—'}</td>
            <td>
              <span style="padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:700;background:${r.status==='Collected'?'#ecfdf5':r.status==='Accepted'?'#eff6ff':'#fef9c3'};color:${r.status==='Collected'?'#065f46':r.status==='Accepted'?'#1e40af':'#713f12'};">
                ${r.status}
              </span>
            </td>
          </tr>`).join('');
      }
    }

    /* ── Split view ────────────────────────────────────────────────────── */
    _updateSplitView() {
      // Split view reuses the same CSS classes as main views — already updated by
      // _updateResidentView() (setText('.val-res-distance', ...) hits both) and
      // _updateDriverView() (setText('.val-drv-speed', ...) hits both).
      // Nothing extra to do.
    }

    /* ────────────────────────────────────────────────────────────────────
       SIMULATION BAR
    ──────────────────────────────────────────────────────────────────── */
    _updateSimBar() {
      const sim    = this.state.simulation;
      const route  = sim.route || [];
      const total  = route.length;
      const cur    = sim.currentIndex || 0;
      const wp     = route[cur] || {};

      const btnPlay = byId('btn-sim-play');
      if (btnPlay) btnPlay.textContent = sim.isRunning ? '⏸ Pause Simulation' : '▶️ Play Simulation';

      const pct = total > 1 ? (cur / (total - 1)) * 100 : 0;
      // Route progress indicators updated in driver view
      const routeBar = byId('drv-route-progress-bar');
      if (routeBar) routeBar.style.width = `${Math.round(pct)}%`;
    }

    /* ────────────────────────────────────────────────────────────────────
       LEAFLET MAPS
    ──────────────────────────────────────────────────────────────────── */
    _initMaps() {
      const mapConfigs = [
        { id: 'resident-map-container', lat: 12.938, lon: 77.627, zoom: 15 },
        { id: 'driver-map-container',   lat: 12.938, lon: 77.627, zoom: 15 },
        { id: 'admin-map-container',    lat: 12.938, lon: 77.627, zoom: 14 },
        { id: 'split-map-container',    lat: 12.938, lon: 77.627, zoom: 15 },
      ];

      for (const cfg of mapConfigs) {
        if (!byId(cfg.id) || this.maps[cfg.id]) continue;
        try {
          const inst = window.MapManager.createMap(cfg.id, { lat: cfg.lat, lon: cfg.lon }, cfg.zoom);
          this.maps[cfg.id] = inst;
          // Draw the planned route on all maps
          inst.drawRoute(this.state.simulation.route || []);
        } catch (err) {
          console.warn(`Map init failed for ${cfg.id}:`, err);
        }
      }

      this._updateMaps();
    }

    _updateMaps() {
      if (!window.MapManager || !window.MapManager.ready) return;
      const vehicle = this.state.vehicles[0];
      if (!vehicle) return;

      for (const [, inst] of Object.entries(this.maps)) {
        window.MapManager.updateVehicleMarker(inst, vehicle);
        window.MapManager.updateHouseMarkers(inst, this.state.houses);
        window.MapManager.updatePickupMarkers(inst, this.state.pickupRequests);
        window.MapManager.updateTrail(inst, vehicle.trail || []);
      }
    }

    /* ────────────────────────────────────────────────────────────────────
       TOAST NOTIFICATIONS
    ──────────────────────────────────────────────────────────────────── */
    _showToast(title, message, type = 'info') {
      const container = byId('toast-container');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.style.cssText = `
        background: ${type === 'success' ? '#ecfdf5' : type === 'warning' ? '#fffbeb' : type === 'error' ? '#fef2f2' : '#eff6ff'};
        border-left: 4px solid ${type === 'success' ? '#10b981' : type === 'warning' ? '#f59e0b' : type === 'error' ? '#ef4444' : '#3b82f6'};
        border-radius: 8px; padding: 12px 16px; margin-bottom: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.12); min-width: 280px; max-width: 360px;
        opacity: 0; transform: translateX(20px); transition: all 0.3s ease;
        pointer-events: none;
      `;
      toast.innerHTML = `
        <div style="font-weight:700;font-size:0.88rem;color:#1e293b;margin-bottom:3px;">${title}</div>
        <div style="font-size:0.8rem;color:#475569;line-height:1.4;">${message}</div>
      `;
      container.appendChild(toast);

      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
      });

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 350);
      }, 4500);
    }
  }

  /* ── Bootstrap ───────────────────────────────────────────────────────── */
  window.addEventListener('DOMContentLoaded', () => {
    window.app = new SmartWasteApp();
    window.app.init();
  });
})();
