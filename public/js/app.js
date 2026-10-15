/**
 * app.js — Main frontend controller
 * Vercel/static version: no SSE, no fetch API calls.
 * All state lives in window.AppDataStore; events flow via CustomEvents.
 */
(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════════════════
     SmartWasteApp
  ════════════════════════════════════════════════════════════════════════ */
  class SmartWasteApp {
    constructor() {
      this.currentRole    = 'resident';
      this.selectedHouseNo = '125';
      this.state          = window.AppDataStore.getState();
      this.maps           = {};
      this.soundEnabled   = true;
      this.hasUserInteracted = false;
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  INIT                                                                 */
    /* ──────────────────────────────────────────────────────────────────── */
    init() {
      this._unlockAudio();
      this._setupNavigation();
      this._setupSimulationControls();
      this._setupModals();
      this._setupSoundToggle();
      this._setupResidentControls();
      this._setupDriverControls();
      this._connectEventListeners();

      // First render with initial state
      this._syncState();
      this._updateUI();

      // Switch to role from URL hash if any
      const hash = window.location.hash.replace('#', '');
      this._switchRole(['resident', 'driver', 'admin', 'split'].includes(hash) ? hash : 'resident');

      // Initialise maps after a short delay (DOM must be painted)
      setTimeout(() => this._initMaps(), 400);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  AUDIO UNLOCK                                                         */
    /* ──────────────────────────────────────────────────────────────────── */
    _unlockAudio() {
      window.addEventListener('click', () => {
        if (!this.hasUserInteracted) {
          this.hasUserInteracted = true;
          if (window.audioChime) window.audioChime.init();
        }
      }, { once: true });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  SYNC STATE FROM AppDataStore                                         */
    /* ──────────────────────────────────────────────────────────────────── */
    _syncState() {
      this.state = window.AppDataStore.getState();
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  CUSTOM-EVENT LISTENERS (replaces SSE EventSource)                   */
    /* ──────────────────────────────────────────────────────────────────── */
    _connectEventListeners() {
      /* Telemetry: vehicle moved */
      window.addEventListener('telemetry_update', (e) => {
        const { vehicle, houses, analytics } = e.detail;
        if (vehicle) {
          const idx = this.state.vehicles.findIndex(v => v.id === vehicle.id);
          if (idx >= 0) this.state.vehicles[idx] = vehicle;
          else this.state.vehicles.push(vehicle);
        }
        if (houses)    this.state.houses    = houses;
        if (analytics) this.state.analytics = analytics;
        this._updateUI();
      });

      /* Geofence entered */
      window.addEventListener('geofence_alert', (e) => {
        const notif = e.detail;
        this.state.notifications.unshift(notif);
        this._showToast('🚨 Geofence Alert!', notif.message, 'success');
        if (this.soundEnabled && window.audioChime) window.audioChime.playChime('geofence');
        this._updateUI();
      });

      /* New pickup request created */
      window.addEventListener('pickup_request_created', (e) => {
        const { request, pickupRequests } = e.detail;
        this.state.pickupRequests = pickupRequests;
        this._showToast('📦 Pickup Requested', `House #${request.houseNo} — ${request.wasteType}`, 'info');
        this._updateUI();
      });

      /* Pickup status changed */
      window.addEventListener('pickup_status_updated', (e) => {
        const { request, pickupRequests, analytics } = e.detail;
        this.state.pickupRequests = pickupRequests;
        if (analytics) this.state.analytics = analytics;
        if (request.status === 'Collected') {
          this._showToast('✅ Collected!', `House #${request.houseNo} — garbage collected.`, 'success');
          if (this.soundEnabled && window.audioChime) window.audioChime.playChime('pickup_collected');
        }
        this._updateUI();
      });

      /* Garbage-ready toggled */
      window.addEventListener('garbage_ready_updated', (e) => {
        const { houseNo, garbageReady } = e.detail;
        const house = this.state.houses.find(h => h.houseNo === String(houseNo));
        if (house) house.garbageReady = garbageReady;
        this._showToast('🗑️ Status Updated', `House #${houseNo} garbage ready: ${garbageReady}`, 'info');
        this._updateUI();
      });

      /* Emergency reported */
      window.addEventListener('emergency_reported', (e) => {
        const { report } = e.detail;
        this._showToast('⚠️ Emergency!', `${report.type}: ${report.message}`, 'warning');
        this._updateUI();
      });

      /* Simulation status changed */
      window.addEventListener('simulation_status', (e) => {
        const data = e.detail;
        this.state.simulation.isRunning       = data.isRunning;
        this.state.simulation.currentIndex    = data.currentIndex;
        this.state.simulation.speedMultiplier = data.speedMultiplier;
        this._updateSimulationUI();
      });

      /* Simulation step */
      window.addEventListener('simulation_step', (e) => {
        this.state.simulation.currentIndex = e.detail.currentIndex;
        this._updateSimulationUI();
      });

      /* Simulation reset */
      window.addEventListener('simulation_reset', (e) => {
        this.state.simulation.currentIndex = e.detail.currentIndex;
        this.state.simulation.isRunning    = false;
        this._updateSimulationUI();
        this._showToast('⏮️ Reset', 'Vehicle returned to depot.', 'info');
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  NAVIGATION                                                           */
    /* ──────────────────────────────────────────────────────────────────── */
    _setupNavigation() {
      document.querySelectorAll('.role-tab').forEach(tab => {
        tab.addEventListener('click', () => this._switchRole(tab.dataset.role));
      });
      document.querySelectorAll('.nav-role-btn').forEach(btn => {
        btn.addEventListener('click', () => this._switchRole(btn.dataset.role));
      });
    }

    _switchRole(role) {
      this.currentRole = role;
      document.querySelectorAll('.role-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.role === role));
      document.querySelectorAll('.view-panel').forEach(p =>
        p.classList.toggle('active', p.dataset.view === role));
      window.location.hash = role;
      this._updateUI();
      setTimeout(() => {
        if (this.maps[role]) this.maps[role].invalidateSize();
        if (role === 'split') {
          if (this.maps.splitResident) this.maps.splitResident.invalidateSize();
          if (this.maps.splitDriver)   this.maps.splitDriver.invalidateSize();
        }
      }, 150);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  SIMULATION CONTROLS                                                  */
    /* ──────────────────────────────────────────────────────────────────── */
    _setupSimulationControls() {
      const btnPlay    = document.getElementById('btn-sim-play');
      const btnFwd     = document.getElementById('btn-sim-step-fwd');
      const btnBack    = document.getElementById('btn-sim-step-back');
      const btnReset   = document.getElementById('btn-sim-reset');
      const speedSel   = document.getElementById('sim-speed-select');

      if (btnPlay) {
        btnPlay.addEventListener('click', () => {
          if (this.state.simulation.isRunning) {
            window.AppSimulatorEngine.stop();
          } else {
            const speed = Number(speedSel ? speedSel.value : 1);
            window.AppSimulatorEngine.start(speed);
          }
        });
      }

      if (speedSel) {
        speedSel.addEventListener('change', () => {
          if (this.state.simulation.isRunning) {
            window.AppSimulatorEngine.start(Number(speedSel.value));
          }
        });
      }

      if (btnFwd)   btnFwd.addEventListener('click',   () => window.AppSimulatorEngine.stepForward());
      if (btnBack)  btnBack.addEventListener('click',  () => window.AppSimulatorEngine.stepBackward());
      if (btnReset) btnReset.addEventListener('click', () => window.AppSimulatorEngine.reset());

      /* Scenario shortcut chips */
      document.querySelectorAll('.shortcut-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const idx = Number(chip.dataset.index);
          window.AppSimulatorEngine.teleport(idx);
        });
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  MODALS                                                               */
    /* ──────────────────────────────────────────────────────────────────── */
    _setupModals() {
      /* ── Pickup Request ── */
      const pickupModal = document.getElementById('pickup-modal');
      document.querySelectorAll('.btn-open-pickup-modal').forEach(btn =>
        btn.addEventListener('click', () => pickupModal && pickupModal.classList.add('open')));
      document.querySelectorAll('.btn-close-pickup-modal').forEach(btn =>
        btn.addEventListener('click', () => pickupModal && pickupModal.classList.remove('open')));

      const pickupForm = document.getElementById('pickup-request-form');
      if (pickupForm) {
        pickupForm.addEventListener('submit', (e) => {
          e.preventDefault();
          window.AppDataStore.createPickupRequest({
            houseNo:      (document.getElementById('req-house-no')      || {}).value || '',
            residentName: (document.getElementById('req-resident-name') || {}).value || 'Resident',
            ward:         (document.getElementById('req-ward')          || {}).value || 'Ward 4',
            landmark:     (document.getElementById('req-landmark')      || {}).value || '',
            note:         (document.getElementById('req-note')          || {}).value || '',
            wasteType:    (document.getElementById('req-waste-type')    || {}).value || 'Mixed Waste',
          });
          if (pickupModal) pickupModal.classList.remove('open');
          pickupForm.reset();
        });
      }

      /* ── Emergency ── */
      const emergModal = document.getElementById('emergency-modal');
      const btnOpenEmerg = document.getElementById('btn-open-emergency-modal');
      if (btnOpenEmerg) btnOpenEmerg.addEventListener('click', () => emergModal && emergModal.classList.add('open'));
      document.querySelectorAll('.btn-close-emergency-modal').forEach(btn =>
        btn.addEventListener('click', () => emergModal && emergModal.classList.remove('open')));

      const emergForm = document.getElementById('emergency-form');
      if (emergForm) {
        emergForm.addEventListener('submit', (e) => {
          e.preventDefault();
          window.AppDataStore.reportEmergency({
            vehicleId: 'GV-04',
            type:    (document.getElementById('emerg-type') || {}).value || 'Other',
            message: (document.getElementById('emerg-msg')  || {}).value || '',
          });
          if (emergModal) emergModal.classList.remove('open');
          emergForm.reset();
        });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  SOUND TOGGLE                                                         */
    /* ──────────────────────────────────────────────────────────────────── */
    _setupSoundToggle() {
      const btn = document.getElementById('btn-sound-toggle');
      if (!btn) return;
      btn.addEventListener('click', () => {
        this.soundEnabled = !this.soundEnabled;
        btn.textContent   = this.soundEnabled ? '🔔' : '🔕';
        btn.title         = this.soundEnabled ? 'Sound ON' : 'Sound OFF';
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  RESIDENT CONTROLS (house selector, garbage ready btn)                */
    /* ──────────────────────────────────────────────────────────────────── */
    _setupResidentControls() {
      /* House selector */
      document.querySelectorAll('.house-selector-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this.selectedHouseNo = btn.dataset.houseNo;
          document.querySelectorAll('.house-selector-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.houseNo === this.selectedHouseNo));
          this._updateResidentView();
        });
      });

      /* Garbage Ready button */
      const garbageReadyBtn = document.getElementById('btn-garbage-ready');
      if (garbageReadyBtn) {
        garbageReadyBtn.addEventListener('click', () => {
          const house = this.state.houses.find(h => h.houseNo === this.selectedHouseNo);
          if (!house) return;
          window.AppDataStore.setGarbageReady(this.selectedHouseNo, !house.garbageReady);
        });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  DRIVER CONTROLS (pickup status buttons)                              */
    /* ──────────────────────────────────────────────────────────────────── */
    _setupDriverControls() {
      document.addEventListener('click', (e) => {
        /* Accept / Collect buttons on pickup cards use data attributes */
        if (e.target.matches('[data-action="accept-pickup"]')) {
          window.AppDataStore.updatePickupStatus(e.target.dataset.id, 'Accepted');
        } else if (e.target.matches('[data-action="collect-pickup"]')) {
          window.AppDataStore.updatePickupStatus(e.target.dataset.id, 'Collected');
        }
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  MASTER UI UPDATE                                                     */
    /* ──────────────────────────────────────────────────────────────────── */
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
      const house   = this.state.houses.find(h => h.houseNo === this.selectedHouseNo);
      if (!vehicle || !house) return;

      const dist = house.distanceToVehicle;
      const dir  = house.direction || {};
      const eta  = house.eta || {};

      const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      const setHTML = (id, v) => { const el = document.getElementById(id); if (el) el.innerHTML  = v; };

      /* Status badge */
      const badge = document.getElementById('vehicle-status-badge');
      if (badge) {
        badge.className = `status-badge ${vehicle.status === 'active' ? 'active' : 'inactive'}`;
        badge.textContent = vehicle.status === 'active' ? '🟢 Active' : '🔴 Inactive';
      }

      /* Distance card */
      setText('res-distance-display', dist ? `${Math.round(dist)} m` : '—');
      setText('res-direction-display', dir.label || '—');
      setText('res-eta-display', eta.formatted || '—');
      setText('res-locality-display', vehicle.locality || '—');

      /* Geofence alert banner */
      const alertBanner = document.getElementById('geofence-alert-banner');
      if (alertBanner) {
        alertBanner.style.display = house.isInGeofence ? 'block' : 'none';
        if (house.isInGeofence) {
          alertBanner.textContent = `🚨 Vehicle is ~${Math.round(dist)} m away! Please bring your garbage outside.`;
        }
      }

      /* Garbage Ready button */
      const grBtn = document.getElementById('btn-garbage-ready');
      if (grBtn) {
        grBtn.textContent = house.garbageReady ? '✅ Garbage Ready (Tap to Undo)' : '🗑️ Mark Garbage Ready';
        grBtn.classList.toggle('active', house.garbageReady);
      }

      /* Notification list */
      const notifList = document.getElementById('notification-list');
      if (notifList) {
        if (!this.state.notifications.length) {
          notifList.innerHTML = '<li class="empty-state">No notifications yet. Start the simulation!</li>';
        } else {
          notifList.innerHTML = this.state.notifications.slice(0, 8).map(n => `
            <li class="notif-item ${n.type}">
              <span class="notif-icon">${n.type === 'geofence_alert' ? '🚨' : '📋'}</span>
              <span class="notif-msg">${n.message}</span>
              <span class="notif-time">${this._relTime(n.timestamp)}</span>
            </li>`).join('');
        }
      }

      /* My pickup requests */
      const myPickups = this.state.pickupRequests.filter(r => r.houseNo === this.selectedHouseNo);
      const myPickupEl = document.getElementById('my-pickup-list');
      if (myPickupEl) {
        myPickupEl.innerHTML = myPickups.length
          ? myPickups.map(r => `
              <div class="pickup-card status-${r.status.toLowerCase()}">
                <div class="pickup-card-header">
                  <strong>Request ${r.id}</strong>
                  <span class="status-chip">${r.status}</span>
                </div>
                <p>${r.wasteType} — ${r.ward}</p>
                <p class="text-muted">${this._relTime(r.createdAt)}</p>
              </div>`).join('')
          : '<p class="empty-state">No pickup requests for this house.</p>';
      }
    }

    /* ── Driver view ───────────────────────────────────────────────────── */
    _updateDriverView() {
      const vehicle = this.state.vehicles[0];
      if (!vehicle) return;

      const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

      setText('driver-speed',    vehicle.speed ? `${Math.round(vehicle.speed)} km/h` : '0 km/h');
      setText('driver-locality', vehicle.locality || '—');
      setText('driver-bearing',  vehicle.direction ? vehicle.direction.label : '—');
      setText('driver-status',   vehicle.status || 'Active');

      /* Pending pickup requests */
      const pendingEl = document.getElementById('driver-pickup-list');
      if (pendingEl) {
        const pending = this.state.pickupRequests.filter(r => r.status !== 'Collected');
        pendingEl.innerHTML = pending.length
          ? pending.map(r => `
              <div class="pickup-card driver-card status-${r.status.toLowerCase()}">
                <div class="pickup-card-header">
                  <strong>📍 House #${r.houseNo} — ${r.wasteType}</strong>
                  <span class="status-chip">${r.status}</span>
                </div>
                <p>${r.address}</p>
                ${r.landmark ? `<p class="text-muted">📌 ${r.landmark}</p>` : ''}
                ${r.note     ? `<p class="text-muted">📝 ${r.note}</p>`     : ''}
                <div class="card-actions">
                  ${r.status === 'Pending'  ? `<button class="btn btn-sm btn-primary" data-action="accept-pickup"  data-id="${r.id}">✅ Accept</button>` : ''}
                  ${r.status === 'Accepted' ? `<button class="btn btn-sm btn-success" data-action="collect-pickup" data-id="${r.id}">🗑️ Mark Collected</button>` : ''}
                </div>
              </div>`).join('')
          : '<p class="empty-state">No pending pickup requests. 🎉</p>';
      }

      /* Collections today badge */
      setText('driver-collections-today', this.state.analytics.collectionsToday);
    }

    /* ── Admin / dashboard view ────────────────────────────────────────── */
    _updateAdminView() {
      const vehicle = this.state.vehicles[0];
      if (!vehicle) return;

      const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

      setText('admin-vehicle-id',       vehicle.id);
      setText('admin-vehicle-driver',   vehicle.driverName);
      setText('admin-vehicle-locality', vehicle.locality);
      setText('admin-vehicle-speed',    vehicle.speed ? `${Math.round(vehicle.speed)} km/h` : '—');
      setText('admin-vehicle-bearing',  vehicle.direction ? vehicle.direction.label : '—');
      setText('admin-vehicle-status',   vehicle.status);
      setText('admin-vehicle-coords',   `${vehicle.lat.toFixed(5)}, ${vehicle.lon.toFixed(5)}`);

      /* Analytics */
      setText('analytics-collections',       this.state.analytics.collectionsToday);
      setText('analytics-pending',           this.state.analytics.pendingPickups);
      setText('analytics-missed',            this.state.analytics.missedPickups);
      setText('analytics-noise-reduction',   this.state.analytics.noiseReductionEvents);
      setText('analytics-geofence-alerts',   this.state.analytics.geofenceAlertsFired);
      setText('analytics-active-vehicles',   this.state.analytics.activeVehicles);

      /* Registered houses table */
      const houseTbl = document.getElementById('admin-houses-table-body');
      if (houseTbl) {
        houseTbl.innerHTML = this.state.houses.map(h => `
          <tr>
            <td>#${h.houseNo}</td>
            <td>${h.residentName}</td>
            <td>${h.ward}</td>
            <td>${h.distanceToVehicle ? Math.round(h.distanceToVehicle) + ' m' : '—'}</td>
            <td>${h.direction ? h.direction.label : '—'}</td>
            <td><span class="status-chip ${h.isInGeofence ? 'alert' : 'normal'}">${h.isInGeofence ? '🚨 Inside' : 'Outside'}</span></td>
            <td>${h.garbageReady ? '✅ Ready' : '—'}</td>
          </tr>`).join('');
      }

      /* Pickup requests table */
      const pickupTbl = document.getElementById('admin-pickups-table-body');
      if (pickupTbl) {
        pickupTbl.innerHTML = this.state.pickupRequests.map(r => `
          <tr>
            <td>${r.id}</td>
            <td>#${r.houseNo}</td>
            <td>${r.residentName}</td>
            <td>${r.wasteType}</td>
            <td><span class="status-chip ${r.status.toLowerCase()}">${r.status}</span></td>
            <td>${r.assignedDriver || '—'}</td>
            <td>${this._relTime(r.createdAt)}</td>
          </tr>`).join('');
      }
    }

    /* ── Split view ────────────────────────────────────────────────────── */
    _updateSplitView() {
      const vehicle = this.state.vehicles[0];
      const house   = this.state.houses.find(h => h.houseNo === this.selectedHouseNo);
      if (!vehicle || !house) return;

      const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

      setText('split-res-distance', house.distanceToVehicle ? `${Math.round(house.distanceToVehicle)} m` : '—');
      setText('split-res-direction', house.direction ? house.direction.label : '—');
      setText('split-res-eta', house.eta ? house.eta.formatted : '—');
      setText('split-driver-speed', vehicle.speed ? `${Math.round(vehicle.speed)} km/h` : '—');
      setText('split-driver-locality', vehicle.locality || '—');
      setText('split-pending-count', this.state.pickupRequests.filter(r => r.status !== 'Collected').length);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  SIMULATION UI                                                        */
    /* ──────────────────────────────────────────────────────────────────── */
    _updateSimulationUI() {
      const btnPlay  = document.getElementById('btn-sim-play');
      const progress = document.getElementById('sim-progress-bar');
      const label    = document.getElementById('sim-waypoint-label');
      const counter  = document.getElementById('sim-waypoint-counter');

      const sim    = this.state.simulation;
      const route  = sim.route || [];
      const total  = route.length;
      const cur    = sim.currentIndex;
      const wp     = route[cur] || {};

      if (btnPlay)  btnPlay.textContent = sim.isRunning ? '⏸ Pause' : '▶ Start Simulation';
      if (progress) progress.style.width = total > 1 ? `${(cur / (total - 1)) * 100}%` : '0%';
      if (label)    label.textContent    = wp.label || `Waypoint ${cur + 1}`;
      if (counter)  counter.textContent  = `${cur + 1} / ${total}`;
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  LEAFLET MAPS                                                         */
    /* ──────────────────────────────────────────────────────────────────── */
    _initMaps() {
      const mapIds = {
        resident: 'map-resident',
        driver:   'map-driver',
        admin:    'map-admin',
        splitResident: 'map-split-resident',
        splitDriver:   'map-split-driver',
      };

      for (const [key, domId] of Object.entries(mapIds)) {
        const el = document.getElementById(domId);
        if (!el || this.maps[key]) continue;
        try {
          const m = window.MapManager.createMap(domId, { lat: 12.938, lon: 77.627 }, 15, key);
          this.maps[key] = m;
        } catch (err) {
          console.warn(`Map ${key} init failed:`, err);
        }
      }

      this._updateMaps();
    }

    _updateMaps() {
      if (!window.MapManager || !window.MapManager.ready) return;
      const vehicle = this.state.vehicles[0];
      if (!vehicle) return;

      for (const [, map] of Object.entries(this.maps)) {
        window.MapManager.updateVehicleMarker(map, vehicle);
        window.MapManager.updateHouseMarkers(map, this.state.houses);
        window.MapManager.updatePickupMarkers(map, this.state.pickupRequests);
        window.MapManager.updateGeofenceCircle(map, this.state.houses);
        window.MapManager.updateTrail(map, vehicle.trail);
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  TOAST NOTIFICATIONS                                                  */
    /* ──────────────────────────────────────────────────────────────────── */
    _showToast(title, message, type = 'info') {
      const container = document.getElementById('toast-container');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.innerHTML = `<strong>${title}</strong><p>${message}</p>`;
      container.appendChild(toast);

      requestAnimationFrame(() => toast.classList.add('show'));
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
      }, 4500);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  HELPERS                                                              */
    /* ──────────────────────────────────────────────────────────────────── */
    _relTime(iso) {
      if (!iso) return '';
      const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (diff < 60)   return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      return `${Math.floor(diff / 3600)}h ago`;
    }
  }

  /* ── Bootstrap ──────────────────────────────────────────────────────── */
  window.addEventListener('DOMContentLoaded', () => {
    window.app = new SmartWasteApp();
    window.app.init();
  });
})();
