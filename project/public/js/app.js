/**
 * app.js - Main Application Controller for Smart Garbage Vehicle System
 * Manages SSE live streaming, view switching (Resident, Driver, Admin, Split),
 * simulation playback, and interactive pickup flows.
 */

class SmartWasteApp {
  constructor() {
    this.currentRole = 'resident'; // 'resident', 'driver', 'admin', 'split'
    this.selectedHouseNo = '125';
    this.state = {
      vehicles: [],
      houses: [],
      pickupRequests: [],
      notifications: [],
      analytics: {},
      simulation: { isRunning: false, currentIndex: 0, speedMultiplier: 1, routeWaypoints: [] }
    };

    this.eventSource = null;
    this.maps = {}; // Maps by view ID
    this.hasUserInteracted = false;
  }

  init() {
    this.setupNavigation();
    this.setupSimulationControls();
    this.setupModals();
    this.setupHouseholdSwitcher();
    this.setupSoundControls();
    this.connectEventStream();

    // Unlock audio on first user click
    window.addEventListener('click', () => {
      if (!this.hasUserInteracted) {
        this.hasUserInteracted = true;
        if (window.audioChime) window.audioChime.init();
      }
    }, { once: true });

    // Handle initial route/hash
    const hash = window.location.hash.replace('#', '');
    if (['resident', 'driver', 'admin', 'split'].includes(hash)) {
      this.switchRole(hash);
    } else {
      this.switchRole('resident');
    }
  }

  /**
   * Establishes real-time Server-Sent Events connection
   */
  connectEventStream() {
    if (this.eventSource) {
      this.eventSource.close();
    }

    this.eventSource = new EventSource('/api/events');

    this.eventSource.addEventListener('connected', (e) => {
      console.log('📡 Connected to Real-time Smart Waste Telemetry Stream');
    });

    this.eventSource.addEventListener('initial_state', (e) => {
      const data = JSON.parse(e.data);
      this.handleStateUpdate(data);
      this.initializeMaps();
    });

    this.eventSource.addEventListener('telemetry_update', (e) => {
      const data = JSON.parse(e.data);
      if (data.vehicle) {
        const idx = this.state.vehicles.findIndex(v => v.id === data.vehicle.id);
        if (idx >= 0) this.state.vehicles[idx] = data.vehicle;
        else this.state.vehicles.push(data.vehicle);
      }
      if (data.houses) this.state.houses = data.houses;
      if (data.analytics) this.state.analytics = data.analytics;

      this.updateUI();
    });

    this.eventSource.addEventListener('geofence_alert', (e) => {
      const notif = JSON.parse(e.data);
      this.state.notifications.unshift(notif);

      // Play pleasant audio chime
      if (window.audioChime) {
        window.audioChime.playChime('geofence');
      }

      this.showToast('🚨 500m Geofence Alert!', notif.message, 'success');
      this.updateUI();
    });

    this.eventSource.addEventListener('pickup_request_created', (e) => {
      const data = JSON.parse(e.data);
      this.state.pickupRequests = data.pickupRequests;
      this.showToast('📦 New Pickup Request', `Request for House #${data.request.houseNo} logged.`, 'info');
      this.updateUI();
    });

    this.eventSource.addEventListener('pickup_status_updated', (e) => {
      const data = JSON.parse(e.data);
      this.state.pickupRequests = data.pickupRequests;
      if (data.analytics) this.state.analytics = data.analytics;

      if (data.request.status === 'Accepted') {
        this.showToast('🚛 Pickup Accepted', `Driver accepted pickup #${data.request.id} for House #${data.request.houseNo}.`, 'info');
      } else if (data.request.status === 'Collected') {
        if (window.audioChime) {
          window.audioChime.playChime('pickup_collected');
        }
        this.showToast('✅ Garbage Collected', `House #${data.request.houseNo} collected successfully!`, 'success');
      } else if (data.request.status === 'Missed') {
        this.showToast('⚠️ Pickup Inaccessible', `Driver reported House #${data.request.houseNo} missed: ${data.request.missedReason}`, 'warning');
      }
      this.updateUI();
    });

    this.eventSource.addEventListener('house_registered', (e) => {
      const data = JSON.parse(e.data);
      this.state.houses = data.houses;
      if (data.analytics) this.state.analytics = data.analytics;
      this.showToast('🏠 Household Registered', `House #${data.house.houseNo} (${data.house.residentName}) added to quiet network.`, 'success');
      this.updateUI();
    });

    this.eventSource.addEventListener('driver_switched', (e) => {
      const data = JSON.parse(e.data);
      const idx = this.state.vehicles.findIndex(v => v.id === data.vehicle.id);
      if (idx >= 0) this.state.vehicles[idx] = data.vehicle;
      this.showToast('🚛 Driver Switched', `Active Driver: ${data.vehicle.driverName}`, 'info');
      this.updateUI();
    });

    this.eventSource.addEventListener('garbage_ready_updated', (e) => {
      const data = JSON.parse(e.data);
      const house = this.state.houses.find(h => h.houseNo === String(data.houseNo));
      if (house) house.garbageReady = data.garbageReady;
      this.showToast('🗑️ Garbage Ready Update', `House #${data.houseNo} status updated.`, 'info');
      this.updateUI();
    });

    this.eventSource.addEventListener('emergency_reported', (e) => {
      const data = JSON.parse(e.data);
      this.showToast('⚠️ Driver Alert', `${data.report.type}: ${data.report.message}`, 'warning');
      this.updateUI();
    });

    this.eventSource.addEventListener('simulation_status', (e) => {
      const data = JSON.parse(e.data);
      this.state.simulation.isRunning = data.isRunning;
      this.state.simulation.currentIndex = data.currentIndex;
      this.state.simulation.speedMultiplier = data.speedMultiplier;
      this.updateSimulationUI();
    });

    this.eventSource.addEventListener('simulation_step', (e) => {
      const data = JSON.parse(e.data);
      this.state.simulation.currentIndex = data.currentIndex;
      this.updateSimulationUI();
    });

    this.eventSource.addEventListener('simulation_reset', (e) => {
      const data = JSON.parse(e.data);
      this.state.simulation.currentIndex = data.currentIndex;
      this.state.simulation.isRunning = false;
      this.updateSimulationUI();
      this.showToast('⏮️ Simulation Reset', 'Vehicle returned to route starting waypoint.', 'info');
    });

    this.eventSource.onerror = (err) => {
      console.warn('SSE stream lost, retrying in 3s...', err);
    };
  }

  handleStateUpdate(newState) {
    this.state = { ...this.state, ...newState };
    this.updateUI();
  }

  setupNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const role = btn.dataset.role;
        this.switchRole(role);
      });
    });
  }

  switchRole(role) {
    this.currentRole = role;
    window.location.hash = role;

    // Update active navbar button
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.role === role);
    });

    // Update visible view panels
    document.querySelectorAll('.view-panel').forEach(p => {
      p.classList.toggle('active', p.id === `${role}-view`);
    });

    // Invalidate map sizes in the newly visible tab
    setTimeout(() => {
      this.initializeMaps();
      for (const key in this.maps) {
        if (this.maps[key] && this.maps[key].map) {
          this.maps[key].map.invalidateSize();
        }
      }
    }, 150);
  }

  /**
   * Initializes Leaflet maps for active views
   */
  initializeMaps() {
    const waypoints = this.state.simulation.routeWaypoints || [];

    // Resident Map
    if (document.getElementById('resident-map-container') && !this.maps.resident) {
      this.maps.resident = new MapManager('resident-map-container');
      this.maps.resident.init([12.94180, 77.62950], 15);
      this.maps.resident.drawPlannedRoute(waypoints);
    }

    // Driver Map
    if (document.getElementById('driver-map-container') && !this.maps.driver) {
      this.maps.driver = new MapManager('driver-map-container');
      this.maps.driver.init([12.93950, 77.62780], 15);
      this.maps.driver.drawPlannedRoute(waypoints);
    }

    // Admin Map
    if (document.getElementById('admin-map-container') && !this.maps.admin) {
      this.maps.admin = new MapManager('admin-map-container');
      this.maps.admin.init([12.93950, 77.62780], 15);
      this.maps.admin.drawPlannedRoute(waypoints);
      this.maps.admin.enableMapClickTeleport(async (lat, lon) => {
        await fetch('/api/simulation/teleport', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lon })
        });
        this.showToast('📍 Simulation Teleport', `Vehicle moved to ${lat.toFixed(4)}, ${lon.toFixed(4)}`, 'info');
      });
    }

    // Split Map (Driver screen in split view)
    if (document.getElementById('split-map-container') && !this.maps.split) {
      this.maps.split = new MapManager('split-map-container');
      this.maps.split.init([12.93950, 77.62780], 15);
      this.maps.split.drawPlannedRoute(waypoints);
    }

    this.renderMapEntities();
  }

  renderMapEntities() {
    const vehicle = this.state.vehicles[0];
    const houses = this.state.houses;
    const pickups = this.state.pickupRequests;

    for (const key in this.maps) {
      const mapMgr = this.maps[key];
      if (mapMgr && mapMgr.map) {
        if (vehicle) mapMgr.updateVehicle(vehicle);
        if (houses) mapMgr.updateHouses(houses, this.selectedHouseNo);
        if (pickups) mapMgr.updatePickups(pickups);
      }
    }
  }

  setupSimulationControls() {
    const btnPlay = document.getElementById('btn-sim-play');
    const btnStepFwd = document.getElementById('btn-sim-step-fwd');
    const btnStepBack = document.getElementById('btn-sim-step-back');
    const btnReset = document.getElementById('btn-sim-reset');
    const speedSelect = document.getElementById('sim-speed-select');

    if (btnPlay) {
      btnPlay.addEventListener('click', async () => {
        if (this.state.simulation.isRunning) {
          await fetch('/api/simulation/stop', { method: 'POST' });
        } else {
          const speed = Number(speedSelect ? speedSelect.value : 1);
          await fetch('/api/simulation/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speedMultiplier: speed })
          });
        }
      });
    }

    if (speedSelect) {
      speedSelect.addEventListener('change', async () => {
        if (this.state.simulation.isRunning) {
          await fetch('/api/simulation/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speedMultiplier: Number(speedSelect.value) })
          });
        }
      });
    }

    if (btnStepFwd) {
      btnStepFwd.addEventListener('click', () => {
        fetch('/api/simulation/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: 'forward' })
        });
      });
    }

    if (btnStepBack) {
      btnStepBack.addEventListener('click', () => {
        fetch('/api/simulation/step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: 'backward' })
        });
      });
    }

    if (btnReset) {
      btnReset.addEventListener('click', () => {
        fetch('/api/simulation/reset', { method: 'POST' });
      });
    }

    // Scenario shortcut chips
    document.querySelectorAll('.shortcut-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const idx = Number(chip.dataset.index);
        fetch('/api/simulation/teleport', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: idx })
        });
      });
    });
  }

  updateSimulationUI() {
    const btnPlay = document.getElementById('btn-sim-play');
    if (btnPlay) {
      btnPlay.innerHTML = this.state.simulation.isRunning ? '⏸️ Pause' : '▶️ Play Simulation';
      btnPlay.classList.toggle('danger', this.state.simulation.isRunning);
      btnPlay.classList.toggle('primary', !this.state.simulation.isRunning);
    }

    const curIdx = this.state.simulation.currentIndex;
    document.querySelectorAll('.shortcut-chip').forEach(chip => {
      const chipIdx = Number(chip.dataset.index);
      chip.classList.toggle('highlight', chipIdx === curIdx);
    });
  }

  setupModals() {
    // Pickup Request Modal
    const pickupModal = document.getElementById('pickup-modal');
    const btnOpenPickup = document.querySelectorAll('.btn-open-pickup-modal');
    const btnClosePickup = document.querySelectorAll('.btn-close-pickup-modal');
    const pickupForm = document.getElementById('pickup-request-form');

    btnOpenPickup.forEach(btn => {
      btn.addEventListener('click', () => {
        if (pickupModal) pickupModal.classList.add('open');
      });
    });

    btnClosePickup.forEach(btn => {
      btn.addEventListener('click', () => {
        if (pickupModal) pickupModal.classList.remove('open');
      });
    });

    if (pickupForm) {
      pickupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          houseNo: document.getElementById('req-house-no').value,
          residentName: document.getElementById('req-resident-name').value,
          ward: document.getElementById('req-ward').value,
          landmark: document.getElementById('req-landmark').value,
          note: document.getElementById('req-note').value,
          wasteType: document.getElementById('req-waste-type').value
        };

        const res = await fetch('/api/resident/pickup-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          if (pickupModal) pickupModal.classList.remove('open');
          pickupForm.reset();
        }
      });
    }

    // Emergency Modal
    const emergencyModal = document.getElementById('emergency-modal');
    const btnOpenEmerg = document.getElementById('btn-open-emergency-modal');
    const btnCloseEmerg = document.querySelectorAll('.btn-close-emergency-modal');
    const emergForm = document.getElementById('emergency-form');

    if (btnOpenEmerg) {
      btnOpenEmerg.addEventListener('click', () => {
        if (emergencyModal) emergencyModal.classList.add('open');
      });
    }

    btnCloseEmerg.forEach(btn => {
      btn.addEventListener('click', () => {
        if (emergencyModal) emergencyModal.classList.remove('open');
      });
    });

    if (emergForm) {
      emergForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          vehicleId: 'GV-04',
          type: document.getElementById('emerg-type').value,
          message: document.getElementById('emerg-msg').value
        };

        const res = await fetch('/api/driver/emergency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          if (emergencyModal) emergencyModal.classList.remove('open');
          emergForm.reset();
        }
      });
    }

    // Registration Modal
    const registerModal = document.getElementById('register-modal');
    const btnOpenRegister = document.getElementById('btn-open-register-modal');
    const btnCloseRegister = document.querySelectorAll('.btn-close-register-modal');
    const registerForm = document.getElementById('register-house-form');

    if (btnOpenRegister) {
      btnOpenRegister.addEventListener('click', () => {
        if (registerModal) registerModal.classList.add('open');
      });
    }

    btnCloseRegister.forEach(btn => {
      btn.addEventListener('click', () => {
        if (registerModal) registerModal.classList.remove('open');
      });
    });

    if (registerForm) {
      registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          houseNo: document.getElementById('reg-house-no').value,
          residentName: document.getElementById('reg-resident-name').value,
          ward: document.getElementById('reg-ward').value,
          address: document.getElementById('reg-address').value,
          landmark: document.getElementById('reg-landmark').value,
          contact: document.getElementById('reg-contact').value,
          lat: Number(document.getElementById('reg-lat').value) || 12.94150,
          lon: Number(document.getElementById('reg-lon').value) || 77.62900
        };

        const res = await fetch('/api/resident/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          this.selectedHouseNo = payload.houseNo;
          if (registerModal) registerModal.classList.remove('open');
          registerForm.reset();
        }
      });
    }
  }

  setupHouseholdSwitcher() {
    const selector = document.getElementById('resident-account-select');
    if (selector) {
      selector.addEventListener('change', (e) => {
        this.selectedHouseNo = e.target.value;
        this.updateUI();
        const house = this.state.houses.find(h => h.houseNo === this.selectedHouseNo);
        if (house && this.maps.resident) {
          const v = this.state.vehicles[0];
          if (v) this.maps.resident.fitVehicleAndHouse(v.lat, v.lon, house.lat, house.lon);
        }
      });
    }

    const driverSelector = document.getElementById('driver-profile-select');
    if (driverSelector) {
      driverSelector.addEventListener('change', async (e) => {
        await fetch('/api/driver/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ driverName: e.target.value })
        });
      });
    }
  }

  setupSoundControls() {
    const btnSound = document.getElementById('btn-sound-toggle');
    if (btnSound) {
      btnSound.addEventListener('click', () => {
        if (window.audioChime) {
          const isMuted = window.audioChime.toggleMute();
          btnSound.innerHTML = isMuted ? '🔇 Audio Muted' : '🔔 Audio Alert On';
          if (!isMuted) {
            window.audioChime.playChime('geofence');
          }
        }
      });
    }
  }

  /**
   * Main UI render loop triggered on any telemetry or state change
   */
  updateUI() {
    this.renderHeaderBadges();
    this.renderResidentView();
    this.renderDriverView();
    this.renderAdminView();
    this.renderMapEntities();
    this.updateSimulationUI();
  }

  renderHeaderBadges() {
    const announcementsSpared = this.state.analytics.announcementsAvoided || 138;
    const sparedEl = document.getElementById('badge-announcements-spared');
    if (sparedEl) {
      sparedEl.textContent = `🌿 ${announcementsSpared} Loudspeaker Blasts Spared`;
    }
  }

  renderResidentView() {
    const vehicle = this.state.vehicles[0];
    const house = this.state.houses.find(h => h.houseNo === this.selectedHouseNo) || this.state.houses[0];
    if (!vehicle || !house) return;

    // Update Profile Header
    const profileNameEl = document.getElementById('res-profile-name');
    const profileBadgeEl = document.getElementById('res-profile-badge');
    const profileAddrEl = document.getElementById('res-profile-address');
    if (profileNameEl) profileNameEl.textContent = house.residentName;
    if (profileBadgeEl) profileBadgeEl.textContent = `House #${house.houseNo}`;
    if (profileAddrEl) profileAddrEl.textContent = `${house.ward} - ${house.address}`;

    // Populate Account Switcher Dropdown
    const accSelect = document.getElementById('resident-account-select');
    if (accSelect && this.state.houses.length > 0) {
      const currentOptionsCount = accSelect.options.length;
      if (currentOptionsCount !== this.state.houses.length) {
        accSelect.innerHTML = this.state.houses.map(h => `
          <option value="${h.houseNo}" ${h.houseNo === this.selectedHouseNo ? 'selected' : ''}>
            #${h.houseNo} - ${h.residentName} (${h.ward})
          </option>
        `).join('');
      } else if (accSelect.value !== this.selectedHouseNo) {
        accSelect.value = this.selectedHouseNo;
      }
    }

    const distMeters = Math.round(house.distanceMeters || 0);
    const etaText = house.eta ? house.eta.formatted : '~3 min';
    const octant = vehicle.bearingOctant ? `${vehicle.bearingOctant.name} ${vehicle.bearingOctant.arrow}` : 'Northeast ↗';

    // Update Distance & Metric Pills (both single & split view)
    document.querySelectorAll('.val-res-distance').forEach(el => {
      el.textContent = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(1)} km` : `${distMeters} m`;
    });

    document.querySelectorAll('.val-res-direction').forEach(el => {
      el.textContent = octant;
    });

    document.querySelectorAll('.val-res-eta').forEach(el => {
      el.textContent = etaText;
    });

    document.querySelectorAll('.val-res-locality').forEach(el => {
      el.textContent = vehicle.currentLocality || 'Ward 4';
    });

    // Distance progress bar (0m to 1400m range)
    const progressPct = Math.max(0, Math.min(100, Math.round(((1400 - distMeters) / 1400) * 100)));
    document.querySelectorAll('.distance-progress').forEach(el => {
      el.style.width = `${progressPct}%`;
    });

    // 500m Geofence Alert Banner
    const isInside500m = distMeters <= 500;
    document.querySelectorAll('.geofence-alert-box').forEach(el => {
      el.classList.toggle('visible', isInside500m);
    });

    // Garbage Ready button toggle
    document.querySelectorAll('.btn-garbage-ready').forEach(btn => {
      btn.classList.toggle('ready', house.garbageReady);
      btn.innerHTML = house.garbageReady
        ? '<span>✅</span><span>Garbage Ready Outside!</span>'
        : '<span>🗑️</span><span>Mark Garbage Ready</span>';

      btn.onclick = async () => {
        await fetch('/api/resident/garbage-ready', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            houseNo: house.houseNo,
            isReady: !house.garbageReady
          })
        });
      };
    });

    // Pickup Request Status Tracker in Resident View
    const residentReq = this.state.pickupRequests.find(r => r.houseNo === house.houseNo);
    document.querySelectorAll('.resident-pickup-tracker-wrapper').forEach(wrapper => {
      if (!residentReq) {
        wrapper.innerHTML = `
          <div style="font-size: 0.82rem; color: var(--text-muted); text-align: center; padding: 6px;">
            No active away-from-home pickup request.
          </div>
        `;
      } else {
        const badgeClass = residentReq.status.toLowerCase();
        let statusMessage = '';
        if (residentReq.status === 'Accepted') {
          statusMessage = `<div style="margin-top: 8px; font-size: 0.75rem; color: #1e40af; font-weight: 600; background: #dbeafe; padding: 4px 8px; border-radius: 4px;">
            🚛 Driver accepted your request and is en route!
          </div>`;
        } else if (residentReq.status === 'Collected') {
          statusMessage = `<div style="margin-top: 8px; font-size: 0.75rem; color: #065f46; font-weight: 600; background: #ecfdf5; padding: 4px 8px; border-radius: 4px;">
            🎉 Collected by Driver ${residentReq.collectedBy || 'Ramesh Kumar'}
          </div>`;
        } else if (residentReq.status === 'Missed') {
          statusMessage = `<div style="margin-top: 8px; font-size: 0.75rem; color: #991b1b; font-weight: 600; background: #fee2e2; padding: 4px 8px; border-radius: 4px;">
            ⚠️ Inaccessible / Missed (${residentReq.missedReason || 'Gate locked'})
          </div>`;
        }

        wrapper.innerHTML = `
          <div class="pickup-tracker-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="font-weight: 700; font-size: 0.88rem;">Pickup #${residentReq.id}</span>
              <span class="tracker-badge ${badgeClass}">${residentReq.status}</span>
            </div>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">
              📍 ${residentReq.landmark || 'Outside front gate'}
            </p>
            <p style="font-size: 0.78rem; font-style: italic; color: #475569;">
              "${residentReq.note}"
            </p>
            ${statusMessage}
          </div>
        `;
      }
    });

    // Notifications history list
    document.querySelectorAll('.resident-notifications-list').forEach(list => {
      const houseNotifs = this.state.notifications.filter(n => n.houseNo === house.houseNo || n.houseNo === 'ALL').slice(0, 6);
      if (houseNotifs.length === 0) {
        list.innerHTML = '<div style="font-size: 0.8rem; color: #94a3b8; padding: 4px;">No notifications yet.</div>';
        return;
      }

      list.innerHTML = houseNotifs.map(n => {
        const timeStr = new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
          <div class="notif-item">
            <div style="font-weight: 600; color: var(--text-main);">${n.title || 'System Notification'}</div>
            <div style="color: #475569; margin-top: 2px;">${n.message}</div>
            <div class="notif-meta">
              <span>${timeStr}</span>
              <span style="color: var(--primary); font-weight: 600;">Quiet Alert</span>
            </div>
          </div>
        `;
      }).join('');
    });
  }

  renderDriverView() {
    const vehicle = this.state.vehicles[0];
    if (!vehicle) return;

    // Driver name & selector sync
    const drvNameEl = document.getElementById('drv-display-name');
    if (drvNameEl) drvNameEl.textContent = vehicle.driverName;

    const drvSelect = document.getElementById('driver-profile-select');
    if (drvSelect && drvSelect.value !== vehicle.driverName) {
      drvSelect.value = vehicle.driverName;
    }

    // Driver telemetry badges
    document.querySelectorAll('.val-drv-speed').forEach(el => el.textContent = `${vehicle.speedKmh} km/h`);
    document.querySelectorAll('.val-drv-locality').forEach(el => el.textContent = vehicle.currentLocality || 'Ward 4');
    document.querySelectorAll('.val-drv-heading').forEach(el => {
      const oct = vehicle.bearingOctant ? `${vehicle.bearingOctant.label}` : 'North ↑';
      el.textContent = `${oct} (${vehicle.bearing}°)`;
    });

    // Driver route progress bar
    const sim = this.state.simulation;
    const progress = vehicle.routeProgress || { percent: 0, formatted: '0%' };
    const routeStepEl = document.getElementById('drv-route-step');
    const routePctEl = document.getElementById('drv-route-pct');
    const progressBarEl = document.getElementById('drv-route-progress-bar');

    if (routeStepEl) {
      routeStepEl.textContent = `Waypoint ${sim.currentIndex + 1} of ${sim.totalWaypoints || 14}`;
    }
    if (routePctEl) {
      routePctEl.textContent = `${progress.formatted} Completed`;
    }
    if (progressBarEl) {
      progressBarEl.style.width = `${progress.percent}%`;
    }

    // Pickup Queue
    document.querySelectorAll('.pickup-queue-container').forEach(container => {
      const requests = this.state.pickupRequests;
      if (!requests || requests.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 20px;">No pending pickups.</div>';
        return;
      }

      container.innerHTML = requests.map(req => {
        const isCollected = req.status === 'Collected';
        const isAccepted = req.status === 'Accepted';
        const isMissed = req.status === 'Missed';

        return `
          <div class="pickup-queue-item ${isCollected ? 'collected' : ''} ${isMissed ? 'missed' : ''}">
            <div class="pickup-queue-header">
              <div>
                <span style="font-weight: 700; font-size: 0.92rem; color: var(--text-main);">
                  House #${req.houseNo} - ${req.residentName}
                </span>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                  ${req.ward} • ${req.address}
                </div>
              </div>
              <span class="tracker-badge ${req.status.toLowerCase()}">${req.status}</span>
            </div>
            <div style="background: #f8fafc; padding: 8px; border-radius: 6px; font-size: 0.8rem; margin: 6px 0;">
              <div><strong>📌 Landmark:</strong> ${req.landmark || 'None'}</div>
              <div style="margin-top: 3px;"><strong>📝 Instructions:</strong> "${req.note}"</div>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px;">
              ${req.status === 'Pending' ? `
                <button class="btn-action-sm btn-accept" data-request-id="${req.id}" style="background: #3b82f6; color: white; padding: 6px 12px; border-radius: 6px; border: none; font-size: 0.8rem; font-weight: 600; cursor: pointer;">
                  Accept Pickup
                </button>
              ` : ''}
              ${!isCollected ? `
                <button class="btn-collect ${isCollected ? 'collected' : ''}" 
                        data-request-id="${req.id}"
                        style="background: #10b981; color: white; padding: 6px 12px; border-radius: 6px; border: none; font-size: 0.8rem; font-weight: 600; cursor: pointer;">
                  Mark as Collected
                </button>
                <button class="btn-action-sm btn-missed" data-request-id="${req.id}" style="background: #f8fafc; color: #ef4444; border: 1px solid #fca5a5; padding: 6px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer;">
                  Report Missed
                </button>
              ` : `
                <span style="background: #ecfdf5; color: #065f46; padding: 6px 12px; border-radius: 6px; font-size: 0.8rem; font-weight: 700;">
                  ✅ Garbage Collected
                </span>
              `}
            </div>
          </div>
        `;
      }).join('');

      // Attach button click handlers
      container.querySelectorAll('.btn-accept').forEach(btn => {
        btn.onclick = async () => {
          const reqId = btn.dataset.requestId;
          await fetch('/api/driver/pickup/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId: reqId,
              status: 'Accepted',
              driverName: vehicle.driverName
            })
          });
        };
      });

      container.querySelectorAll('.btn-collect:not(.collected)').forEach(btn => {
        btn.onclick = async () => {
          const reqId = btn.dataset.requestId;
          await fetch('/api/driver/pickup/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId: reqId,
              status: 'Collected',
              driverName: vehicle.driverName
            })
          });
        };
      });

      container.querySelectorAll('.btn-missed').forEach(btn => {
        btn.onclick = async () => {
          const reqId = btn.dataset.requestId;
          await fetch('/api/driver/pickup/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId: reqId,
              status: 'Missed',
              driverName: 'Inaccessible / Gate locked'
            })
          });
        };
      });
    });
  }

  renderAdminView() {
    const analytics = this.state.analytics;
    const vehicle = this.state.vehicles[0];

    // Big Stat Cards
    const elAnnouncements = document.getElementById('adm-announcements');
    const elDecibels = document.getElementById('adm-decibels');
    const elEfficiency = document.getElementById('adm-efficiency');
    const elPickups = document.getElementById('adm-pickups');
    const elMissed = document.getElementById('adm-missed');

    if (elAnnouncements) elAnnouncements.textContent = analytics.announcementsAvoided || 138;
    if (elDecibels) elDecibels.textContent = `${analytics.decibelHoursSaved || 69.0} dB·h`;
    if (elEfficiency) elEfficiency.textContent = `${analytics.collectionEfficiencyPct || 92.5}%`;
    if (elPickups) elPickups.textContent = `${analytics.totalCollectionsToday || 19}`;
    if (elMissed) elMissed.textContent = `${analytics.missedPickups || 0}`;

    // Admin Vehicle Telemetry Table
    const vehicleTbody = document.getElementById('admin-vehicles-tbody');
    if (vehicleTbody && vehicle) {
      vehicleTbody.innerHTML = `
        <tr>
          <td><strong>${vehicle.id}</strong></td>
          <td>${vehicle.driverName}</td>
          <td>${vehicle.vehicleNumber}</td>
          <td>${vehicle.currentLocality}</td>
          <td>${vehicle.speedKmh} km/h</td>
          <td>
            <span style="font-weight: 700; color: var(--primary);">
              ${vehicle.bearingOctant ? vehicle.bearingOctant.label : 'N/A'}
            </span>
          </td>
          <td>
            <span style="font-weight: 600; color: var(--info);">
              ${vehicle.routeProgress ? vehicle.routeProgress.formatted : '0%'}
            </span>
          </td>
          <td>
            <span style="background: #ecfdf5; color: #065f46; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 0.78rem;">
              ${vehicle.status}
            </span>
          </td>
        </tr>
      `;
    }

    // Admin Houses Table
    const housesTbody = document.getElementById('admin-houses-tbody');
    if (housesTbody) {
      housesTbody.innerHTML = this.state.houses.map(h => `
        <tr>
          <td><strong>#${h.houseNo}</strong></td>
          <td>${h.residentName}</td>
          <td>${h.ward}</td>
          <td>${Math.round(h.distanceMeters || 0)} m</td>
          <td>
            ${h.isInGeofence 
              ? '<span style="color: #059669; font-weight: 700;">🚨 Inside 500m</span>' 
              : '<span style="color: #64748b;">Outside</span>'}
          </td>
          <td>
            ${h.garbageReady 
              ? '<span style="color: #10b981; font-weight: 700;">🟢 Ready</span>' 
              : '<span style="color: #94a3b8;">⚪ Waiting</span>'}
          </td>
        </tr>
      `).join('');
    }

    // Admin Pickups Table
    const pickupsTbody = document.getElementById('admin-pickups-tbody');
    if (pickupsTbody) {
      if (this.state.pickupRequests.length === 0) {
        pickupsTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #94a3b8; padding: 12px;">No pickup requests logged.</td></tr>';
      } else {
        pickupsTbody.innerHTML = this.state.pickupRequests.map(r => `
          <tr>
            <td><strong>${r.id}</strong></td>
            <td><strong>#${r.houseNo}</strong></td>
            <td>${r.residentName}</td>
            <td>${r.address || r.ward}</td>
            <td>${r.landmark || '—'}</td>
            <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">"${r.note}"</td>
            <td>
              <span class="tracker-badge ${r.status.toLowerCase()}">${r.status}</span>
            </td>
          </tr>
        `).join('');
      }
    }
  }

  showToast(title, desc, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '🔔';
    if (type === 'warning') icon = '⚠️';

    toast.innerHTML = `
      <div class="toast-icon">${icon}</div>
      <div class="toast-content">
        <div class="toast-title">${title}</div>
        <div class="toast-desc">${desc}</div>
      </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(50px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }
}

// Instantiate and initialize when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  window.app = new SmartWasteApp();
  window.app.init();
});
