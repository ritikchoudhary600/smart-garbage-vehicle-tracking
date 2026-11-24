/**
 * controlPanel.js — Control management for municipal admins
 *
 *   People      approve sign-ins, set roles (resident / driver / admin),
 *               suspend access, link residents to houses and drivers to trucks
 *   Fleet       add, edit and retire vehicles; assign drivers
 *   Households  the household register and pickup requests
 *   Settings    ward name, time zone, geofence radius, sign-up policy, baselines
 *   Audit log   who changed what (written by the database in Supabase mode)
 *
 * Works on either store; the database enforces every rule again with RLS.
 * Exposes window.ControlPanel.
 */
(function () {
  'use strict';

  const { esc, relTime, statusPill, avatarHtml, ROLE_LABELS } = window.UI;
  const { effectiveAlertRadius, formatMeters } = window.GeoUtils;
  const byId = (id) => document.getElementById(id);
  const qsa  = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ROLE_ORDER = { pending: 0, admin: 1, driver: 2, resident: 3 };
  const ROLE_HINTS = {
    pending:  'Signed in but sees nothing until approved.',
    resident: 'Sees only their own household: the truck, the quiet alert, pickups.',
    driver:   'Works the pickup queue and drives the vehicle assigned to them.',
    admin:    'Sees every portal, including this Control room.',
  };
  const TABLE_LABELS = {
    profiles: 'Person', vehicles: 'Vehicle', households: 'Household',
    pickup_requests: 'Pickup', emergency_reports: 'Issue report', app_settings: 'Settings',
  };
  // Audit keys arrive as database columns (Supabase) or app fields (demo)
  const FIELD_LABELS = {
    role: 'role', status: 'status', full_name: 'name', fullName: 'name', phone: 'phone', email: 'email',
    driver_id: 'driver account', driverId: 'driver account', driver_name: 'driver', driverName: 'driver',
    driver_phone: 'driver phone', plate_number: 'registration', plateNumber: 'registration', capacity: 'capacity',
    house_no: 'house', houseNo: 'house', resident_name: 'resident', residentName: 'resident',
    address: 'address', landmark: 'landmark', ward: 'ward', lat: 'latitude', lon: 'longitude',
    owner_id: 'linked account', ownerId: 'linked account', garbage_ready: 'bins ready',
    waste_type: 'waste', note: 'instructions', assigned_driver: 'driver', type: 'issue', message: 'details',
    ward_name: 'ward name', wardName: 'ward name', timezone: 'time zone',
    geofence_radius_m: 'default alert distance', geofenceRadiusM: 'default alert distance',
    geofence_exit_m: 're-arm distance', geofenceExitM: 're-arm distance',
    alert_radius_m: 'alert distance', alertRadiusM: 'alert distance',
    alert_radius_min_m: 'smallest alert distance', alertRadiusMinM: 'smallest alert distance',
    alert_radius_max_m: 'largest alert distance', alertRadiusMaxM: 'largest alert distance',
    rearm_buffer_m: 're-arm buffer', rearmBufferM: 're-arm buffer',
    auto_approve_residents: 'auto-approve sign-ins', autoApproveResidents: 'auto-approve sign-ins',
    baseline_announcements: 'baseline announcements', baselineAnnouncements: 'baseline announcements',
    baseline_collections: 'baseline collections', baselineCollections: 'baseline collections',
    baseline_missed: 'baseline missed', baselineMissed: 'baseline missed',
    db_hours_per_announcement: 'dB·h per announcement', dbHoursPerAnnouncement: 'dB·h per announcement',
  };
  const HIDDEN_FIELDS = new Set(['id', 'created_at', 'createdAt', 'household_id', 'created_by', 'reported_by',
    'accepted_at', 'collected_at', 'missed_at', 'avatar_url', 'last_position_at', 'reported_at']);

  const CP = {
    app: null,
    pane: 'people',
    settingsDirty: false,
    _renderTimer: null,
    _deferred: false,
    editing: { personId: null, vehicleId: null, householdId: null },

    get store() { return window.AppDataStore; },
    get state() { return this.app.state; },
    get me() { return this.app.profile; },

    init(app) {
      this.app = app;
      this._bindTabs();
      this._bindPeople();
      this._bindFleet();
      this._bindHouseholds();
      this._bindSettings();
      byId('ctl-audit-filter').addEventListener('change', () => this.renderAudit());

      const schedule = () => {
        clearTimeout(this._renderTimer);
        this._renderTimer = setTimeout(() => this.render(), 120);
      };
      window.addEventListener('control_updated', schedule);
      window.addEventListener('settings_updated', schedule);
      window.addEventListener('pickup_request_created', schedule);
      window.addEventListener('pickup_status_updated', schedule);
      window.addEventListener('house_registered', schedule);
      window.addEventListener('garbage_ready_updated', schedule);
      window.addEventListener('driver_switched', schedule);

      // Never re-render a table under someone's open dropdown
      byId('control-view').addEventListener('focusout', () => {
        if (this._deferred) { this._deferred = false; setTimeout(() => this.render(), 0); }
      });
      this.renderCounts();
    },

    /* ── Rendering ─────────────────────────────────────────────────────── */
    render(force = false) {
      this.renderCounts();
      if (this.app.currentRole !== 'control' && !force) return;
      const active = document.activeElement;
      if (!force && active && active.closest('#control-view') && active.matches('select, input')) {
        this._deferred = true;
        if (this.pane !== 'settings') return;
      }
      if (this.pane === 'people') this.renderPeople();
      if (this.pane === 'fleet') this.renderFleet();
      if (this.pane === 'households') this.renderHouseholds();
      if (this.pane === 'settings') this.renderSettings();
      if (this.pane === 'audit') this.renderAudit();
    },

    renderCounts() {
      const s = this.state;
      const pending = s.profiles.filter(p => p.role === 'pending').length;
      byId('ctl-count-people').textContent = s.profiles.length;
      byId('ctl-count-people').classList.toggle('has-alert', pending > 0);
      byId('ctl-count-fleet').textContent = s.vehicles.length;
      byId('ctl-count-households').textContent = s.houses.length;

      const banner = byId('ctl-pending-banner');
      banner.hidden = pending === 0;
      byId('ctl-pending-text').textContent = pending === 1
        ? '1 person signed in and is waiting for approval.'
        : `${pending} people signed in and are waiting for approval.`;
    },

    _bindTabs() {
      qsa('.subtab').forEach(tab => tab.addEventListener('click', () => this.showPane(tab.dataset.pane)));
    },

    showPane(pane) {
      this.pane = pane;
      qsa('.subtab').forEach(t => t.classList.toggle('active', t.dataset.pane === pane));
      qsa('.ctl-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === pane));
      this.render(true);
    },

    /* ════════════════════════════════════════════════════════════════════
       PEOPLE
    ════════════════════════════════════════════════════════════════════ */
    _bindPeople() {
      byId('ctl-people-search').addEventListener('input', () => this.renderPeople());
      byId('ctl-people-role').addEventListener('change', () => this.renderPeople());
      byId('ctl-show-pending').addEventListener('click', () => {
        byId('ctl-people-role').value = 'pending';
        this.showPane('people');
      });

      const tbody = byId('ctl-people-tbody');
      tbody.addEventListener('change', (e) => {
        const sel = e.target.closest('select[data-field]');
        if (sel) this._changePersonField(sel.dataset.id, sel.dataset.field, sel.value, sel);
      });
      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ctl]');
        if (!btn) return;
        if (btn.dataset.ctl === 'approve') this._changePersonField(btn.dataset.id, 'role', 'resident', btn);
        if (btn.dataset.ctl === 'edit-person') this.openPerson(btn.dataset.id);
      });

      this.personModal = this.app._bindModal('person-modal', null, '.btn-close-person-modal');
      byId('person-role').addEventListener('change', () => this._syncPersonLinks());
      byId('person-form').addEventListener('submit', (e) => { e.preventDefault(); this._savePerson(e.submitter); });
    },

    _linkedLabel(p) {
      if (p.role === 'resident') {
        const houses = this.state.houses.filter(h => h.ownerId === p.id);
        return houses.length ? houses.map(h => `House #${esc(h.houseNo)}`).join(', ') : '<span class="sub">No household yet</span>';
      }
      if (p.role === 'driver') {
        const v = this.state.vehicles.find(x => x.driverId === p.id);
        return v ? `Vehicle ${esc(v.id)}` : '<span class="sub">No vehicle</span>';
      }
      return '<span class="sub">—</span>';
    },

    renderPeople() {
      const q = byId('ctl-people-search').value.trim().toLowerCase();
      const roleFilter = byId('ctl-people-role').value;
      const people = this.state.profiles
        .filter(p => !roleFilter || p.role === roleFilter)
        .filter(p => !q || `${p.fullName} ${p.email}`.toLowerCase().includes(q))
        .sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || (a.fullName || a.email).localeCompare(b.fullName || b.email));

      const roleOptions = (current) => ['pending', 'resident', 'driver', 'admin'].map(r =>
        `<option value="${r}" ${r === current ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');

      byId('ctl-people-tbody').innerHTML = people.length ? people.map(p => {
        const you = p.id === this.me.id;
        const name = p.fullName || p.email.split('@')[0];
        return `
          <tr class="${p.role === 'pending' ? 'row-pending' : ''}${p.status === 'suspended' ? ' row-muted' : ''}">
            <td>
              <div class="person">
                ${avatarHtml(p, 'avatar avatar-sm')}
                <div class="person-text">
                  <div class="person-name">${esc(name)}${you ? ' <span class="tag">you</span>' : ''}</div>
                  <div class="person-email">${esc(p.email)}</div>
                </div>
              </div>
            </td>
            <td><select class="select select-sm" data-field="role" data-id="${esc(p.id)}" aria-label="Role for ${esc(name)}">${roleOptions(p.role)}</select></td>
            <td>
              <select class="select select-sm select-status" data-field="status" data-id="${esc(p.id)}" data-status="${esc(p.status)}" aria-label="Access for ${esc(name)}">
                <option value="active" ${p.status === 'active' ? 'selected' : ''}>Active</option>
                <option value="suspended" ${p.status === 'suspended' ? 'selected' : ''}>Suspended</option>
              </select>
            </td>
            <td>${this._linkedLabel(p)}</td>
            <td class="num" title="${p.lastSeenAt ? esc(new Date(p.lastSeenAt).toLocaleString()) : ''}">${p.lastSeenAt ? relTime(p.lastSeenAt) : 'never'}</td>
            <td class="td-actions">
              ${p.role === 'pending' ? `<button class="btn btn-accent btn-xs" data-ctl="approve" data-id="${esc(p.id)}" type="button">Approve</button>` : ''}
              <button class="btn btn-quiet btn-xs" data-ctl="edit-person" data-id="${esc(p.id)}" type="button">Edit</button>
            </td>
          </tr>`;
      }).join('') : `<tr class="empty-row"><td colspan="6">${q || roleFilter ? 'Nobody matches this filter.' : 'Nobody has signed in yet.'}</td></tr>`;

      const auto = this.state.settings.autoApproveResidents;
      byId('ctl-people-foot').innerHTML = this.store.mode === 'demo'
        ? 'Demo people. With Supabase connected, everyone who signs in with Google appears here.'
        : `New Google sign-ins ${auto ? 'join as <strong>residents</strong>' : '<strong>wait for your approval</strong>'}. Change this under Settings.`;
    },

    async _changePersonField(id, field, value, control) {
      const p = this.state.profiles.find(x => x.id === id);
      if (!p || p[field] === value) return;
      const name = p.fullName || p.email;

      if (field === 'role' && value === 'admin') {
        const ok = await this.app._confirm({
          title: `Make ${name} an admin?`,
          message: 'Admins can see every household, change anyone\'s role and edit settings.',
          confirmLabel: 'Make admin',
        });
        if (!ok) return this.renderPeople();
      }
      if (field === 'status' && value === 'suspended') {
        const ok = await this.app._confirm({
          title: `Suspend ${name}?`,
          message: 'They stay signed in but see nothing until you set their access back to Active.',
          confirmLabel: 'Suspend',
        });
        if (!ok) return this.renderPeople();
      }

      const result = await this.app._act(() => this.store.updateProfile(id, { [field]: value }), 'Could not update this person', control);
      if (result) {
        const what = field === 'role' ? `is now ${ROLE_LABELS[value].toLowerCase()}` : value === 'active' ? 'has access again' : 'is suspended';
        this.app._showToast('Saved', `${esc(name)} ${what}.`, 'success');
      }
      this.renderPeople();
    },

    openPerson(id) {
      const p = this.state.profiles.find(x => x.id === id);
      if (!p) return;
      this.editing.personId = id;
      byId('person-modal-email').textContent = p.email;
      byId('person-modal-title').textContent = p.fullName || 'Edit person';
      byId('person-name').value = p.fullName || '';
      byId('person-phone').value = p.phone || '';
      byId('person-role').value = p.role;
      byId('person-status').value = p.status;

      const own = this.state.houses.find(h => h.ownerId === id);
      byId('person-household').innerHTML = '<option value="">No household</option>' + this.state.houses
        .slice().sort((a, b) => a.houseNo.localeCompare(b.houseNo, undefined, { numeric: true }))
        .map(h => {
          const owner = h.ownerId && h.ownerId !== id ? this.state.profiles.find(x => x.id === h.ownerId) : null;
          return `<option value="${esc(h.id)}" ${own && own.id === h.id ? 'selected' : ''}>#${esc(h.houseNo)} · ${esc(h.residentName)}${owner ? ` (linked to ${esc(owner.email)})` : ''}</option>`;
        }).join('');

      const veh = this.state.vehicles.find(v => v.driverId === id);
      byId('person-vehicle').innerHTML = '<option value="">No vehicle</option>' + this.state.vehicles.map(v =>
        `<option value="${esc(v.id)}" ${veh && veh.id === v.id ? 'selected' : ''}>${esc(v.id)} · ${esc(v.plateNumber)}${v.driverId && v.driverId !== id ? ` (now ${esc(v.driverName)})` : ''}</option>`).join('');

      this._syncPersonLinks();
      this.personModal.open();
    },

    _syncPersonLinks() {
      const role = byId('person-role').value;
      qsa('.person-link').forEach(el => { el.hidden = el.dataset.for !== role; });
      byId('person-role-hint').textContent = ROLE_HINTS[role] || '';
    },

    async _savePerson(button) {
      const id = this.editing.personId;
      const p = this.state.profiles.find(x => x.id === id);
      if (!p) return;
      const patch = {
        fullName: byId('person-name').value.trim(),
        phone: byId('person-phone').value.trim(),
        role: byId('person-role').value,
        status: byId('person-status').value,
      };
      if (!patch.fullName) { this.app._showToast('Name required', 'Enter a name for this person.', 'warning'); return; }

      const changed = Object.keys(patch).some(k => (p[k] || '') !== patch[k]);
      if (patch.role === 'admin' && p.role !== 'admin') {
        const ok = await this.app._confirm({
          title: `Make ${patch.fullName} an admin?`,
          message: 'Admins can see every household, change anyone\'s role and edit settings.',
          confirmLabel: 'Make admin',
        });
        if (!ok) return;
      }

      const ok = await this.app._act(async () => {
        // Role first: the database only lets drivers be assigned to vehicles
        if (changed) await this.store.updateProfile(id, patch);

        if (patch.role === 'resident') {
          const wanted = byId('person-household').value || null;
          const current = this.state.houses.find(h => h.ownerId === id);
          if ((current && current.id) !== wanted) {
            if (current) await this.store.saveHousehold({ ...current, ownerId: null }, current.id);
            const house = wanted && this.state.houses.find(h => h.id === wanted);
            if (house) await this.store.saveHousehold({ ...house, ownerId: id }, house.id);
          }
        }
        if (patch.role === 'driver') {
          const wanted = byId('person-vehicle').value || null;
          const current = this.state.vehicles.find(v => v.driverId === id);
          if ((current && current.id) !== wanted) {
            if (wanted) await this.store.assignDriver(wanted, id);
            else if (current) await this.store.assignDriver(current.id, null);
          }
        }
      }, 'Could not save this person', button);

      if (ok) {
        this.personModal.close();
        this.app._showToast('Saved', `${esc(patch.fullName)} is up to date.`, 'success');
        this.render(true);
      }
    },

    /* ════════════════════════════════════════════════════════════════════
       FLEET
    ════════════════════════════════════════════════════════════════════ */
    _bindFleet() {
      this.vehicleModal = this.app._bindModal('vehicle-modal', null, '.btn-close-vehicle-modal');
      byId('ctl-add-vehicle').addEventListener('click', () => this.openVehicle(null));
      byId('ctl-vehicles-tbody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ctl]');
        if (!btn) return;
        if (btn.dataset.ctl === 'edit-vehicle') this.openVehicle(btn.dataset.id);
        if (btn.dataset.ctl === 'remove-vehicle') this._removeVehicle(btn.dataset.id, btn);
      });
      byId('vehicle-form').addEventListener('submit', (e) => { e.preventDefault(); this._saveVehicle(e.submitter); });
    },

    renderFleet() {
      const vehicles = this.state.vehicles.slice().sort((a, b) => a.id.localeCompare(b.id));
      const statusLabel = { active: 'Active', maintenance: 'In maintenance', retired: 'Retired' };
      byId('ctl-vehicles-tbody').innerHTML = vehicles.length ? vehicles.map(v => `
        <tr class="${v.status === 'retired' ? 'row-muted' : ''}">
          <td><strong>${esc(v.id)}</strong></td>
          <td class="num">${esc(v.plateNumber)}</td>
          <td>${esc(v.capacity || '—')}</td>
          <td>${v.driverName ? esc(v.driverName) : '<span class="sub">Unassigned</span>'}${v.driverName && !v.driverId ? ' <span class="tag tag-muted">no account</span>' : ''}</td>
          <td><span class="state ${v.status === 'active' ? 'state-ok' : 'state-out'}">${statusLabel[v.status] || esc(v.status)}</span></td>
          <td class="num">${v.lastUpdated ? `${relTime(v.lastUpdated)} · ${v.trackingMode === 'live_gps' ? 'live GPS' : 'simulator'}` : '<span class="sub">never</span>'}</td>
          <td class="td-actions">
            <button class="btn btn-quiet btn-xs" data-ctl="edit-vehicle" data-id="${esc(v.id)}" type="button">Edit</button>
            <button class="btn btn-danger-quiet btn-xs" data-ctl="remove-vehicle" data-id="${esc(v.id)}" type="button">Remove</button>
          </td>
        </tr>`).join('') : '<tr class="empty-row"><td colspan="7">No vehicles yet. Add your first truck.</td></tr>';
    },

    openVehicle(id) {
      const v = id ? this.state.vehicles.find(x => x.id === id) : null;
      this.editing.vehicleId = id;
      byId('vehicle-modal-title').textContent = v ? `Edit ${v.id}` : 'Add vehicle';
      byId('vehicle-id').value = v ? v.id : '';
      byId('vehicle-id').readOnly = !!v;
      byId('vehicle-plate').value = v ? v.plateNumber : '';
      byId('vehicle-capacity').value = v ? v.capacity : '';
      byId('vehicle-status').value = v ? v.status : 'active';

      const drivers = this.state.profiles.filter(p => p.role === 'driver' && p.status === 'active');
      const noneLabel = v && v.driverName && !v.driverId ? `${v.driverName} (no account)` : 'Unassigned';
      byId('vehicle-driver').innerHTML = `<option value="">${esc(noneLabel)}</option>` + drivers.map(d => {
        const elsewhere = this.state.vehicles.find(x => x.driverId === d.id && (!v || x.id !== v.id));
        return `<option value="${esc(d.id)}" ${v && v.driverId === d.id ? 'selected' : ''}>${esc(d.fullName || d.email)}${elsewhere ? ` (moves off ${esc(elsewhere.id)})` : ''}</option>`;
      }).join('');
      this.vehicleModal.open();
    },

    async _saveVehicle(button) {
      const isNew = !this.editing.vehicleId;
      const data = {
        id: byId('vehicle-id').value.trim().toUpperCase(),
        plateNumber: byId('vehicle-plate').value.trim(),
        capacity: byId('vehicle-capacity').value.trim(),
        status: byId('vehicle-status').value,
        driverId: byId('vehicle-driver').value || null,
      };
      if (!/^[A-Z0-9-]{2,20}$/.test(data.id)) {
        this.app._showToast('Check the vehicle ID', 'Use 2–20 letters, numbers or dashes, like GV-09.', 'warning');
        return;
      }
      const v = await this.app._act(() => this.store.saveVehicle(data, isNew), 'Could not save the vehicle', button);
      if (v) {
        this.vehicleModal.close();
        this.app._showToast(isNew ? 'Vehicle added' : 'Vehicle updated', `${esc(v.id)} · ${esc(v.plateNumber)}`, 'success');
        this.render(true);
      }
    },

    async _removeVehicle(id, button) {
      const ok = await this.app._confirm({
        title: `Remove ${id}?`,
        message: 'It disappears from the maps and the fleet. Past issue reports stay. This cannot be undone.',
      });
      if (!ok) return;
      if (await this.app._act(() => this.store.deleteVehicle(id), 'Could not remove the vehicle', button)) {
        this.app._showToast('Vehicle removed', esc(id), 'success');
        this.render(true);
      }
    },

    /* ════════════════════════════════════════════════════════════════════
       HOUSEHOLDS & PICKUPS
    ════════════════════════════════════════════════════════════════════ */
    _bindHouseholds() {
      this.householdModal = this.app._bindModal('household-modal', null, '.btn-close-household-modal');
      this.householdPicker = window.LocationPicker.create({
        mapId: 'hh-pick-map', latId: 'hh-lat', lonId: 'hh-lon', hintId: 'hh-location-hint', locateId: 'hh-locate',
      });
      byId('ctl-add-household').addEventListener('click', () => this.openHousehold(null));
      byId('ctl-house-search').addEventListener('input', () => this.renderHouseholds());
      byId('ctl-households-tbody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ctl]');
        if (!btn) return;
        if (btn.dataset.ctl === 'edit-household') this.openHousehold(btn.dataset.id);
        if (btn.dataset.ctl === 'remove-household') this._removeHousehold(btn.dataset.id, btn);
      });
      byId('ctl-pickups-tbody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ctl="remove-pickup"]');
        if (btn) this._removePickup(btn.dataset.id, btn);
      });
      byId('household-form').addEventListener('submit', (e) => { e.preventDefault(); this._saveHousehold(e.submitter); });
    },

    renderHouseholds() {
      const q = byId('ctl-house-search').value.trim().toLowerCase();
      const houses = this.state.houses
        .filter(h => !q || `${h.houseNo} ${h.residentName} ${h.address} ${h.ward}`.toLowerCase().includes(q))
        .sort((a, b) => a.houseNo.localeCompare(b.houseNo, undefined, { numeric: true }));
      byId('ctl-households-tbody').innerHTML = houses.length ? houses.map(h => {
        const owner = h.ownerId && this.state.profiles.find(p => p.id === h.ownerId);
        return `
          <tr>
            <td><strong>#${esc(h.houseNo)}</strong></td>
            <td>${esc(h.residentName)}${h.phone ? `<div class="sub">${esc(h.phone)}</div>` : ''}</td>
            <td>${esc(h.address)}<div class="sub">${esc(h.ward)}${h.landmark ? ` · ${esc(h.landmark)}` : ''}</div></td>
            <td>${owner ? esc(owner.email) : h.ownerId ? '<span class="sub">Linked account</span>' : '<span class="sub">None</span>'}</td>
            <td class="num">${esc(formatMeters(effectiveAlertRadius(h, this.state.settings)))}${h.alertRadiusM == null ? '<div class="sub">default</div>' : ''}</td>
            <td>${h.garbageReady ? '<span class="state state-ok">Ready</span>' : '<span class="state state-out">Waiting</span>'}</td>
            <td class="td-actions">
              <button class="btn btn-quiet btn-xs" data-ctl="edit-household" data-id="${esc(h.id)}" type="button">Edit</button>
              <button class="btn btn-danger-quiet btn-xs" data-ctl="remove-household" data-id="${esc(h.id)}" type="button">Remove</button>
            </td>
          </tr>`;
      }).join('') : `<tr class="empty-row"><td colspan="7">${q ? 'No household matches.' : 'No households yet.'}</td></tr>`;

      const pickups = this.state.pickupRequests;
      byId('ctl-pickups-tbody').innerHTML = pickups.length ? pickups.map(r => `
        <tr>
          <td class="num">${esc(r.id)}</td>
          <td><strong>#${esc(r.houseNo)}</strong><div class="sub">${esc(r.residentName)}</div></td>
          <td>${esc(r.wasteType)}</td>
          <td class="num">${relTime(r.createdAt)}</td>
          <td>${statusPill(r.status)}</td>
          <td class="td-actions"><button class="btn btn-danger-quiet btn-xs" data-ctl="remove-pickup" data-id="${esc(r.id)}" type="button">Remove</button></td>
        </tr>`).join('') : '<tr class="empty-row"><td colspan="6">No pickup requests.</td></tr>';
    },

    openHousehold(id) {
      const h = id ? this.state.houses.find(x => x.id === id) : null;
      this.editing.householdId = id;
      byId('household-modal-title').textContent = h ? `Edit house #${h.houseNo}` : 'Add household';
      byId('hh-house-no').value = h ? h.houseNo : '';
      byId('hh-resident').value = h ? h.residentName : '';
      byId('hh-ward').value = h ? h.ward : this.state.settings.wardName;
      byId('hh-phone').value = h ? h.phone || '' : '';
      byId('hh-address').value = h ? h.address : '';
      byId('hh-landmark').value = h ? h.landmark || '' : '';
      byId('hh-lat').value = h ? h.lat : '';
      byId('hh-lon').value = h ? h.lon : '';
      byId('hh-location-hint').textContent = '';
      const st = this.state.settings;
      const alert = byId('hh-alert-radius');
      alert.min = st.alertRadiusMinM;
      alert.max = st.alertRadiusMaxM;
      alert.value = h && h.alertRadiusM != null ? h.alertRadiusM : '';
      alert.placeholder = `Default (${st.geofenceRadiusM})`;
      byId('hh-alert-hint').textContent = `The linked resident sees this household's alerts and can request pickups for it. Alert distance: ${st.alertRadiusMinM}–${st.alertRadiusMaxM} m, or leave it empty for the ward default (${formatMeters(st.geofenceRadiusM)}). Residents can also change it themselves.`;

      const residents = this.state.profiles.filter(p => p.role === 'resident' || (h && p.id === h.ownerId));
      byId('hh-owner').innerHTML = '<option value="">No linked account</option>' + residents.map(p =>
        `<option value="${esc(p.id)}" ${h && h.ownerId === p.id ? 'selected' : ''}>${esc(p.fullName || p.email)} · ${esc(p.email)}</option>`).join('');
      this.householdModal.open();
      // Editing keeps the saved pin; a new household starts on this device's location
      setTimeout(() => this.householdPicker.open({ fallback: this.app._locationFallback(), autoLocate: !h }), 30);
    },

    async _saveHousehold(button) {
      const id = this.editing.householdId;
      const data = {
        houseNo: byId('hh-house-no').value.trim(),
        residentName: byId('hh-resident').value.trim(),
        ward: byId('hh-ward').value.trim(),
        phone: byId('hh-phone').value.trim(),
        address: byId('hh-address').value.trim(),
        landmark: byId('hh-landmark').value.trim(),
        lat: byId('hh-lat').value,
        lon: byId('hh-lon').value,
        ownerId: byId('hh-owner').value || null,
        alertRadiusM: byId('hh-alert-radius').value === '' ? null : Number(byId('hh-alert-radius').value),
      };
      if (!this.householdPicker.hasPin()) {
        this.app._showToast('Pin the household', 'Use your current location, or tap the map at the gate.', 'warning');
        return;
      }
      const st = this.state.settings;
      if (data.alertRadiusM != null && !(data.alertRadiusM >= st.alertRadiusMinM && data.alertRadiusM <= st.alertRadiusMaxM)) {
        this.app._showToast('Check the alert distance', `Use ${st.alertRadiusMinM}–${st.alertRadiusMaxM} m, or leave it empty for the ward default.`, 'warning');
        return;
      }
      const h = await this.app._act(() => this.store.saveHousehold(data, id), 'Could not save the household', button);
      if (h) {
        this.householdModal.close();
        this.app._showToast(id ? 'Household updated' : 'Household added', `House #${esc(h.houseNo)} · ${esc(h.residentName)}`, 'success');
        this.app._populateResidentSwitcher();
        this.render(true);
      }
    },

    async _removeHousehold(id, button) {
      const h = this.state.houses.find(x => x.id === id);
      if (!h) return;
      const ok = await this.app._confirm({
        title: `Remove house #${h.houseNo}?`,
        message: 'Its pickup requests are removed too, and the linked resident stops getting alerts for it. This cannot be undone.',
      });
      if (!ok) return;
      if (await this.app._act(() => this.store.deleteHousehold(id), 'Could not remove the household', button)) {
        this.app._showToast('Household removed', `House #${esc(h.houseNo)}`, 'success');
        this.app._populateResidentSwitcher();
        this.render(true);
      }
    },

    async _removePickup(id, button) {
      const ok = await this.app._confirm({
        title: `Remove ${id}?`,
        message: 'Use this for duplicate or test requests. The resident\'s tracker for it disappears. This cannot be undone.',
      });
      if (!ok) return;
      if (await this.app._act(() => this.store.deletePickup(id), 'Could not remove the pickup', button)) {
        this.app._showToast('Pickup removed', esc(id), 'success');
        this.render(true);
      }
    },

    /* ════════════════════════════════════════════════════════════════════
       SETTINGS
    ════════════════════════════════════════════════════════════════════ */
    _bindSettings() {
      const form = byId('ctl-settings-form');
      form.addEventListener('input', () => this._setSettingsDirty(true));
      form.addEventListener('change', () => this._setSettingsDirty(true));
      byId('ctl-settings-reset').addEventListener('click', () => {
        this._setSettingsDirty(false);
        this.renderSettings();
      });
      form.addEventListener('submit', (e) => { e.preventDefault(); this._saveSettings(e.submitter); });
    },

    _setSettingsDirty(dirty) {
      this.settingsDirty = dirty;
      byId('ctl-settings-save').disabled = !dirty;
      byId('ctl-settings-reset').hidden = !dirty;
    },

    renderSettings() {
      const s = this.state.settings;
      const form = byId('ctl-settings-form');
      if (!this.settingsDirty) {
        for (const name of ['wardName', 'timezone', 'geofenceRadiusM', 'rearmBufferM', 'alertRadiusMinM', 'alertRadiusMaxM', 'baselineAnnouncements',
                            'baselineCollections', 'baselineMissed', 'dbHoursPerAnnouncement']) {
          form.elements[name].value = s[name];
        }
        qsa('input[name="autoApproveResidents"]', form).forEach(r => { r.checked = r.value === String(!!s.autoApproveResidents); });
        this._setSettingsDirty(false);
      }
      byId('ctl-settings-saved').textContent = s.updatedAt ? `Last saved ${relTime(s.updatedAt)}` : '';
    },

    async _saveSettings(button) {
      const form = byId('ctl-settings-form');
      const num = (name) => Number(form.elements[name].value);
      const patch = {
        wardName: form.elements.wardName.value.trim(),
        timezone: form.elements.timezone.value.trim(),
        geofenceRadiusM: num('geofenceRadiusM'),
        rearmBufferM: num('rearmBufferM'),
        alertRadiusMinM: num('alertRadiusMinM'),
        alertRadiusMaxM: num('alertRadiusMaxM'),
        autoApproveResidents: (qsa('input[name="autoApproveResidents"]', form).find(r => r.checked) || {}).value === 'true',
        baselineAnnouncements: num('baselineAnnouncements'),
        baselineCollections: num('baselineCollections'),
        baselineMissed: num('baselineMissed'),
        dbHoursPerAnnouncement: num('dbHoursPerAnnouncement'),
      };
      if (!patch.wardName) return this.app._showToast('Ward name required', 'Enter the ward name.', 'warning');
      if (!(patch.alertRadiusMinM >= 50 && patch.alertRadiusMaxM <= 5000 && patch.alertRadiusMinM < patch.alertRadiusMaxM)) {
        return this.app._showToast('Check the alert range', 'Residents choose between 50 and 5,000 m, and the smallest must be below the largest.', 'warning');
      }
      if (!(patch.geofenceRadiusM >= patch.alertRadiusMinM && patch.geofenceRadiusM <= patch.alertRadiusMaxM)) {
        return this.app._showToast('Check the default alert distance', `Keep it inside the range residents can choose from (${patch.alertRadiusMinM}–${patch.alertRadiusMaxM} m).`, 'warning');
      }
      if (!(patch.rearmBufferM >= 10 && patch.rearmBufferM <= 1000)) {
        return this.app._showToast('Check the re-arm buffer', 'Use 10 to 1,000 metres, so GPS jitter never repeats an alert.', 'warning');
      }
      for (const k of ['baselineAnnouncements', 'baselineCollections', 'baselineMissed']) {
        if (!Number.isInteger(patch[k]) || patch[k] < 0) return this.app._showToast('Check the baselines', 'Baselines are whole numbers, 0 or more.', 'warning');
      }

      const saved = await this.app._act(() => this.store.updateSettings(patch), 'Could not save settings', button);
      if (saved) {
        this._setSettingsDirty(false);
        this.renderSettings();
        this.app._showToast('Settings saved', 'Every open app picks up the change.', 'success');
      }
    },

    /* ════════════════════════════════════════════════════════════════════
       AUDIT LOG
    ════════════════════════════════════════════════════════════════════ */
    _fmtValue(key, v) {
      if (v == null || v === '') return '—';
      if (typeof v === 'boolean') return v ? 'yes' : 'no';
      if (/(_id|Id)$/.test(key)) {
        const p = this.state.profiles.find(x => x.id === v);
        if (p) return p.fullName || p.email;
      }
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return s.length > 40 ? `${s.slice(0, 39)}…` : s;
    },

    _summarise(entry) {
      const changes = entry.changes || {};
      if (entry.action === 'delete') return '<span class="sub">Removed</span>';
      const keys = Object.keys(changes).filter(k => !HIDDEN_FIELDS.has(k));
      if (entry.action === 'insert') {
        const shown = keys.filter(k => FIELD_LABELS[k]).slice(0, 3).map(k => {
          const v = changes[k] && typeof changes[k] === 'object' && 'to' in changes[k] ? changes[k].to : changes[k];
          return `${esc(FIELD_LABELS[k])}: <strong>${esc(this._fmtValue(k, v))}</strong>`;
        });
        return shown.length ? shown.join(' · ') : '<span class="sub">Created</span>';
      }
      const parts = keys.slice(0, 4).map(k => {
        const c = changes[k] || {};
        return `${esc(FIELD_LABELS[k] || k)}: ${esc(this._fmtValue(k, c.from))} → <strong>${esc(this._fmtValue(k, c.to))}</strong>`;
      });
      if (keys.length > 4) parts.push(`<span class="sub">+${keys.length - 4} more</span>`);
      return parts.join('<br>') || '<span class="sub">—</span>';
    },

    _recordCell(a) {
      const kind = TABLE_LABELS[a.tableName] || a.tableName;
      const label = a.recordLabel || a.recordId || '';
      return !label || label === kind ? `<strong>${esc(kind)}</strong>` : `${esc(kind)} <strong>${esc(label)}</strong>`;
    },

    renderAudit() {
      const filter = byId('ctl-audit-filter').value;
      const entries = this.state.auditLog.filter(a => !filter || a.tableName === filter).slice(0, 200);
      const actionLabel = { insert: 'Added', update: 'Changed', delete: 'Removed' };
      byId('ctl-audit-tbody').innerHTML = entries.length ? entries.map(a => `
        <tr>
          <td class="num" title="${esc(new Date(a.createdAt).toLocaleString())}">${relTime(a.createdAt)}</td>
          <td>${esc(a.actorEmail)}</td>
          <td><span class="audit-action a-${esc(a.action)}">${actionLabel[a.action] || esc(a.action)}</span></td>
          <td>${this._recordCell(a)}</td>
          <td class="cell-note">${this._summarise(a)}</td>
        </tr>`).join('') : `<tr class="empty-row"><td colspan="5">${filter ? 'Nothing recorded for this yet.' : 'No changes recorded yet. Edits in this Control room will show up here.'}</td></tr>`;
    },
  };

  window.ControlPanel = CP;
})();
