/**
 * supabaseStore.js — State manager backed by Supabase
 *
 * Same API and window events as dataStore.js (the offline demo), but every
 * read and write goes to the Supabase database, and Supabase Realtime pushes
 * other people's changes in as they happen: residents watch the truck move,
 * drivers see new pickups, admins see sign-ins and the audit trail.
 *
 * Row-level security decides what each signed-in person can read or change;
 * geofence alerts, pickup status and analytics are computed in the database
 * (see supabase/migrations), never trusted from the browser.
 * Exposes window.SupabaseStore (class).
 */
(function () {
  'use strict';

  const {
    calculateHaversineDistance,
    calculateBearing,
    getBearingOctant,
    detectLocality,
    calculateETA,
  } = window.GeoUtils;

  /* ── Row mappers: database snake_case → app camelCase ────────────────── */
  const SETTINGS_COLUMNS = {
    wardName: 'ward_name', timezone: 'timezone',
    geofenceRadiusM: 'geofence_radius_m', rearmBufferM: 'rearm_buffer_m',
    alertRadiusMinM: 'alert_radius_min_m', alertRadiusMaxM: 'alert_radius_max_m',
    autoApproveResidents: 'auto_approve_residents',
    baselineAnnouncements: 'baseline_announcements', baselineCollections: 'baseline_collections',
    baselineMissed: 'baseline_missed', dbHoursPerAnnouncement: 'db_hours_per_announcement',
  };

  function mapSettings(r) {
    if (!r) return null;
    const s = {};
    for (const [k, col] of Object.entries(SETTINGS_COLUMNS)) s[k] = r[col];
    s.dbHoursPerAnnouncement = Number(s.dbHoursPerAnnouncement);
    s.updatedAt = r.updated_at;
    return s;
  }

  function mapProfile(r) {
    return {
      id: r.id, email: r.email, fullName: r.full_name, avatarUrl: r.avatar_url, phone: r.phone,
      role: r.role, status: r.status, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
    };
  }

  function mapVehicle(r, prev) {
    const bearing = r.bearing || 0;
    return {
      id: r.id, plateNumber: r.plate_number, capacity: r.capacity, status: r.status,
      driverId: r.driver_id, driverName: r.driver_name, driverPhone: r.driver_phone,
      lat: r.lat, lon: r.lon, speed: r.speed_kmh || 0,
      bearing, direction: getBearingOctant(bearing),
      locality: r.lat != null ? detectLocality(r.lat, r.lon) : '',
      routeIndex: r.route_index, trackingMode: r.tracking_mode,
      lastUpdated: r.last_position_at,
      trail: prev ? prev.trail : [],
    };
  }

  function mapHouse(r) {
    return {
      id: r.id, houseNo: r.house_no, residentName: r.resident_name, ward: r.ward,
      address: r.address, landmark: r.landmark, phone: r.phone, lat: r.lat, lon: r.lon,
      ownerId: r.owner_id, garbageReady: r.garbage_ready, isInGeofence: r.is_in_geofence,
      alertRadiusM: r.alert_radius_m,
      notifiedAt: r.notified_at,
      distanceToVehicle: null, bearing: null, direction: null, eta: null,
    };
  }

  function mapPickup(r) {
    return {
      id: r.id, householdId: r.household_id, houseNo: r.house_no, residentName: r.resident_name,
      ward: r.ward, address: r.address, landmark: r.landmark, note: r.note, wasteType: r.waste_type,
      status: r.status, lat: r.lat, lon: r.lon, assignedDriver: r.assigned_driver,
      createdAt: r.created_at, acceptedAt: r.accepted_at, collectedAt: r.collected_at,
      missedAt: r.missed_at, updatedAt: r.updated_at, distanceToVehicle: null,
    };
  }

  function mapNotification(r) {
    return {
      id: String(r.id), houseNo: r.house_no, type: r.type, title: r.title,
      message: r.message, data: r.data || {}, timestamp: r.created_at,
    };
  }

  function mapReport(r) {
    return {
      id: r.id, vehicleId: r.vehicle_id, driverName: r.driver_name, type: r.type,
      message: r.message, locality: r.locality, reportedAt: r.reported_at,
    };
  }

  function mapAudit(r) {
    return {
      id: String(r.id), actorEmail: r.actor_email, action: r.action, tableName: r.table_name,
      recordId: r.record_id, recordLabel: r.record_label, changes: r.changes || {}, createdAt: r.created_at,
    };
  }

  /* ── Errors: turn PostgREST errors into sentences people can act on ──── */
  function friendlyError(error) {
    const msg = (error && (error.message || error.error_description)) || String(error);
    if (error && error.code === '23505') return 'That ID or house number is already in use.';
    if (error && error.code === '23503') return 'That record is still linked to something else.';
    if (/row-level security|permission denied/i.test(msg)) return 'You do not have permission to do that.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Cannot reach the server. Check your connection.';
    if (/JWT expired/i.test(msg)) return 'Your session expired. Reload the page to sign in again.';
    return msg;
  }

  function check({ data, error }) {
    if (error) {
      const e = new Error(friendlyError(error));
      e.cause = error;
      throw e;
    }
    return data;
  }

  const POSITION_FIELDS = ['lat', 'lon', 'speed', 'bearing', 'direction', 'locality', 'routeIndex', 'trackingMode', 'lastUpdated'];

  /* ════════════════════════════════════════════════════════════════════════
     SupabaseStore
  ════════════════════════════════════════════════════════════════════════ */
  class SupabaseStore {
    constructor(client, profile, route) {
      this.mode    = 'supabase';
      this.client  = client;
      this.profile = profile;

      this.vehicles = [];
      this.houses = [];
      this.pickupRequests = [];
      this.notifications = [];
      this.emergencyReports = [];
      this.profiles = [profile];
      this.auditLog = [];
      this.settings = {
        wardName: 'Ward 4', timezone: 'Asia/Kolkata', geofenceRadiusM: 500, rearmBufferM: 50,
        alertRadiusMinM: 100, alertRadiusMaxM: 2000,
        autoApproveResidents: true, baselineAnnouncements: 0, baselineCollections: 0,
        baselineMissed: 0, dbHoursPerAnnouncement: 0.5, updatedAt: null,
      };
      this.analytics = {
        announcementsAvoided: 0, decibelHoursSaved: 0, geofenceAlertsFired: 0,
        collectionsToday: 0, missedPickups: 0, collectionEfficiencyPct: 100,
        pendingPickups: 0, delayNotices: 0, activeVehicles: 0,
      };
      this.simulation = { isRunning: false, currentIndex: 0, speedMultiplier: 1, route };

      this.realtimeStatus = 'connecting';
      this._channel = null;
      this._chain = Promise.resolve();   // serialises position updates so fixes arrive in order
      this._drivingUntil = 0;            // while this tab drives, ignore echoes of our own positions
      this._analyticsTimer = null;
      this._analyticsAt = 0;
      this._errorShownAt = {};
    }

    get isAdmin() { return this.profile.role === 'admin'; }
    get isStaff() { return this.profile.role === 'admin' || this.profile.role === 'driver'; }

    broadcast(eventType, payload) {
      window.dispatchEvent(new CustomEvent(eventType, { detail: payload }));
    }

    _reportError(title, error) {
      const now = Date.now();
      if (now - (this._errorShownAt[title] || 0) < 6000) return;
      this._errorShownAt[title] = now;
      console.error(title, error);
      this.broadcast('store_error', { title, message: friendlyError(error) });
    }

    /* ── Initial load (also used to resync after a reconnect) ───────────── */
    async load() {
      const c = this.client;
      const [settings, vehicles, houses, pickups, notifs, reports, profiles, audit] = await Promise.all([
        c.from('app_settings').select('*').maybeSingle(),
        c.from('vehicles').select('*').order('id'),
        c.from('households').select('*').order('house_no'),
        c.from('pickup_requests').select('*').order('created_at', { ascending: false }).limit(200),
        c.from('notifications').select('*').order('created_at', { ascending: false }).limit(100),
        c.from('emergency_reports').select('*').order('reported_at', { ascending: false }).limit(50),
        this.isAdmin
          ? c.from('profiles').select('*').order('created_at')
          : c.from('profiles').select('*').eq('id', this.profile.id),
        this.isAdmin
          ? c.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200)
          : Promise.resolve({ data: [], error: null }),
      ]);

      this.settings = mapSettings(check(settings)) || this.settings;
      const prevById = new Map(this.vehicles.map(v => [v.id, v]));
      const driving = this._isDriving();
      this.vehicles = check(vehicles).map(r => {
        const prev = prevById.get(r.id);
        const v = mapVehicle(r, prev);
        if (driving && prev) for (const k of POSITION_FIELDS) v[k] = prev[k];
        return v;
      });
      this._sortVehicles();
      this.houses           = check(houses).map(mapHouse);
      this.pickupRequests   = check(pickups).map(mapPickup);
      this.notifications    = check(notifs).map(mapNotification);
      this.emergencyReports = check(reports).map(mapReport);
      this.profiles         = check(profiles).map(mapProfile);
      this.auditLog         = check(audit).map(mapAudit);

      const me = this.profiles.find(p => p.id === this.profile.id);
      if (me) this.profile = me;

      this._syncRouteIndex();
      this.recalculateDistances();
      await this.refreshAnalytics();
      if (!this._channel) this._subscribe();
      return this;
    }

    async refreshAnalytics() {
      this._analyticsAt = Date.now();
      const { data, error } = await this.client.rpc('get_analytics');
      if (error) { this._reportError('Could not load the dashboard numbers', error); return; }
      this.analytics = { ...this.analytics, ...data };
      this.broadcast('analytics_updated', { analytics: this.analytics });
    }

    _queueAnalytics() {
      clearTimeout(this._analyticsTimer);
      this._analyticsTimer = setTimeout(() => this.refreshAnalytics(), 700);
    }

    /* The tracked vehicle is vehicles[0]: a driver's own truck first, then
       active trucks that have reported a position */
    _sortVehicles() {
      const me = this.profile.id;
      const rank = v => (v.driverId === me ? 0
        : v.status === 'active' && v.lat != null ? 1
        : v.status === 'active' ? 2 : 3);
      this.vehicles.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    }

    _isDriving() { return this.simulation.isRunning || Date.now() < this._drivingUntil; }

    _syncRouteIndex() {
      const v = this.vehicles[0];
      if (!v || this._isDriving() || v.trackingMode !== 'simulator' || v.routeIndex == null) return false;
      const idx = Math.max(0, Math.min(v.routeIndex, this.simulation.route.length - 1));
      const changed = idx !== this.simulation.currentIndex;
      this.simulation.currentIndex = idx;
      return changed;
    }

    /* Distances are display-only; the database decides geofence alerts */
    recalculateDistances() {
      const vehicle = this.vehicles[0];
      if (!vehicle || vehicle.lat == null) {
        for (const h of this.houses) { h.distanceToVehicle = null; h.eta = null; }
        for (const r of this.pickupRequests) r.distanceToVehicle = null;
        return;
      }
      for (const house of this.houses) {
        const dist = calculateHaversineDistance(vehicle.lat, vehicle.lon, house.lat, house.lon);
        const bear = calculateBearing(vehicle.lat, vehicle.lon, house.lat, house.lon);
        house.distanceToVehicle = dist;
        house.bearing   = Math.round(bear);
        house.direction = getBearingOctant(bear);
        house.eta       = calculateETA(dist, vehicle.speed || 20);
      }
      for (const req of this.pickupRequests) {
        req.distanceToVehicle = calculateHaversineDistance(vehicle.lat, vehicle.lon, req.lat, req.lon);
      }
    }

    /* ── Realtime ───────────────────────────────────────────────────────── */
    _subscribe() {
      const ch = this.client.channel('sgt-live');
      const on = (table, handler) => ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        try { handler(payload); } catch (err) { console.error(`Realtime ${table} handler failed`, err); }
      });
      on('vehicles',          p => this._onVehicle(p));
      on('households',        p => this._onHouse(p));
      on('pickup_requests',   p => this._onPickup(p));
      on('notifications',     p => this._onNotification(p));
      on('emergency_reports', p => this._onReport(p));
      on('app_settings',      p => this._onSettings(p));
      on('profiles',          p => this._onProfile(p));
      if (this.isAdmin) on('audit_log', p => this._onAudit(p));

      let dropped = false;
      ch.subscribe((status) => {
        this.realtimeStatus = status;
        this.broadcast('connection_status', { status });
        if (status === 'SUBSCRIBED' && dropped) {
          dropped = false;
          this.load().then(() => this.broadcast('telemetry_update', {})).catch(() => {});
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') dropped = true;
      });
      this._channel = ch;

      // Phones pause background tabs; catch up when the app comes back
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        this.load().then(() => this.broadcast('telemetry_update', {})).catch(err => this._reportError('Could not refresh', err));
      });
    }

    _upsert(list, row) {
      const i = list.findIndex(x => x.id === row.id);
      const prev = i >= 0 ? list[i] : null;
      if (i >= 0) list[i] = row; else list.unshift(row);
      return prev;
    }

    _onVehicle({ eventType, new: n, old: o }) {
      if (eventType === 'DELETE') {
        this.vehicles = this.vehicles.filter(v => v.id !== o.id);
        this._sortVehicles();
        this.recalculateDistances();
        this.broadcast('control_updated', { table: 'vehicles' });
        this.broadcast('telemetry_update', {});
        return;
      }
      const prev = this.vehicles.find(v => v.id === n.id);
      const next = mapVehicle(n, prev);
      const ownEcho = prev && prev === this.vehicles[0] && this._isDriving();
      if (ownEcho) {
        for (const k of POSITION_FIELDS) next[k] = prev[k];
      } else if (prev && prev.lat != null && (prev.lat !== next.lat || prev.lon !== next.lon)) {
        next.trail = [...prev.trail, { lat: prev.lat, lon: prev.lon }].slice(-50);
      }
      this._upsert(this.vehicles, next);
      this._sortVehicles();
      const stepped = this._syncRouteIndex();
      this.recalculateDistances();

      if (prev && prev.driverId !== next.driverId) this.broadcast('driver_switched', { vehicle: next });
      if (!prev || ['plateNumber', 'capacity', 'status', 'driverId', 'driverName'].some(k => prev[k] !== next[k])) {
        this.broadcast('control_updated', { table: 'vehicles' });
      }
      if (stepped) this.broadcast('simulation_step', { currentIndex: this.simulation.currentIndex });
      this.broadcast('telemetry_update', { vehicle: next });

      // Alerts for other households are hidden from residents by RLS, so keep
      // the shared counters fresh while the truck moves (at most every 15 s)
      if (Date.now() - this._analyticsAt > 15000) this._queueAnalytics();
    }

    _onHouse({ eventType, new: n, old: o }) {
      if (eventType === 'DELETE') {
        this.houses = this.houses.filter(h => h.id !== o.id);
        this.broadcast('control_updated', { table: 'households' });
        this.broadcast('telemetry_update', {});
        return;
      }
      const next = mapHouse(n);
      const prev = this._upsert(this.houses, next);
      this.recalculateDistances();
      if (!prev) this.broadcast('house_registered', { house: next, isNew: true });
      else if (prev.alertRadiusM !== next.alertRadiusM) {
        this.broadcast('control_updated', { table: 'households' });
        this.broadcast('telemetry_update', {});
      } else if (prev.garbageReady !== next.garbageReady) {
        this.broadcast('garbage_ready_updated', { houseNo: next.houseNo, garbageReady: next.garbageReady, house: next });
      } else {
        this.broadcast('control_updated', { table: 'households' });
        this.broadcast('telemetry_update', {});
      }
    }

    _onPickup({ eventType, new: n, old: o }) {
      if (eventType === 'DELETE') {
        this.pickupRequests = this.pickupRequests.filter(r => r.id !== o.id);
        this._queueAnalytics();
        this.broadcast('control_updated', { table: 'pickup_requests' });
        this.broadcast('telemetry_update', {});
        return;
      }
      const next = mapPickup(n);
      const prev = this._upsert(this.pickupRequests, next);
      this.recalculateDistances();
      this._queueAnalytics();
      if (!prev) this.broadcast('pickup_request_created', { request: next });
      else if (prev.status !== next.status) this.broadcast('pickup_status_updated', { request: next });
      else this.broadcast('telemetry_update', {});
    }

    _onNotification({ eventType, new: n }) {
      if (eventType !== 'INSERT') return;
      const notif = mapNotification(n);
      if (this.notifications.some(x => x.id === notif.id)) return;
      this.notifications.unshift(notif);
      if (this.notifications.length > 100) this.notifications.pop();
      if (notif.type === 'geofence_alert') {
        this._queueAnalytics();
        this.broadcast('geofence_alert', notif);
      } else {
        this.broadcast('notification_added', { notification: notif });
      }
    }

    _onReport({ eventType, new: n }) {
      if (eventType !== 'INSERT') return;
      const report = mapReport(n);
      if (this._upsert(this.emergencyReports, report)) return;
      this._queueAnalytics();
      this.broadcast('emergency_reported', { report });
    }

    _onSettings({ new: n }) {
      const s = mapSettings(n);
      if (!s) return;
      this.settings = s;
      this._queueAnalytics();
      this.broadcast('settings_updated', { settings: s });
    }

    _onProfile({ eventType, new: n, old: o }) {
      if (eventType === 'DELETE') {
        this.profiles = this.profiles.filter(p => p.id !== o.id);
        this.broadcast('control_updated', { table: 'profiles' });
        return;
      }
      const next = mapProfile(n);
      const prev = this._upsert(this.profiles, next);
      if (next.id === this.profile.id) {
        const was = this.profile;
        this.profile = next;
        if (was.role !== next.role || was.status !== next.status) {
          this.broadcast('my_profile_changed', { profile: next, previous: was });
        }
      }
      if (this.isAdmin && (!prev || prev.role !== next.role || prev.status !== next.status
          || prev.fullName !== next.fullName || prev.phone !== next.phone || prev.lastSeenAt !== next.lastSeenAt)) {
        this.broadcast('control_updated', { table: 'profiles', isNew: !prev, profile: next });
      }
    }

    _onAudit({ eventType, new: n }) {
      if (eventType !== 'INSERT') return;
      const entry = mapAudit(n);
      if (this.auditLog.some(a => a.id === entry.id)) return;
      this.auditLog.unshift(entry);
      if (this.auditLog.length > 200) this.auditLog.pop();
      this.broadcast('control_updated', { table: 'audit_log' });
    }

    /* ── Serialised writes ──────────────────────────────────────────────── */
    _serial(fn) {
      const run = this._chain.then(fn);
      this._chain = run.catch(() => {});
      return run;
    }

    /* ── Vehicle position (simulator tick or live GPS fix) ──────────────── */
    updateVehicleLocation(vehicleId, lat, lon, speedKmh = 20, opts = {}) {
      const v = this.vehicles.find(x => x.id === vehicleId);
      if (!v) return null;
      this._drivingUntil = Date.now() + 10000;

      // Show the move immediately; the database confirms and runs the geofence
      const hasPrev = v.lat != null;
      const bearing = hasPrev && (v.lat !== lat || v.lon !== lon) ? calculateBearing(v.lat, v.lon, lat, lon) : v.bearing;
      if (hasPrev) { v.trail.push({ lat: v.lat, lon: v.lon }); if (v.trail.length > 50) v.trail.shift(); }
      Object.assign(v, {
        lat, lon, speed: speedKmh,
        bearing: Math.round(bearing), direction: getBearingOctant(bearing),
        locality: detectLocality(lat, lon),
        lastUpdated: new Date().toISOString(),
        trackingMode: opts.mode || 'simulator',
      });
      if (opts.routeIndex != null) v.routeIndex = opts.routeIndex;
      this.recalculateDistances();
      this.broadcast('telemetry_update', { vehicle: v });

      this._serial(async () => {
        const { error } = await this.client.rpc('report_vehicle_position', {
          p_vehicle_id: vehicleId, p_lat: lat, p_lon: lon,
          p_speed_kmh: Number(speedKmh) || 0,
          p_route_index: opts.routeIndex != null ? opts.routeIndex : null,
          p_mode: opts.mode || 'simulator',
        });
        if (error) {
          this._reportError('Could not send the vehicle position', error);
          if (window.AppSimulatorEngine && this.simulation.isRunning) window.AppSimulatorEngine.stop();
        }
      });
      return v;
    }

    resetGeofences() {
      for (const h of this.houses) h.isInGeofence = false;
      return this._serial(async () => {
        const { error } = await this.client.rpc('reset_geofences');
        if (error) this._reportError('Could not reset the geofence', error);
      });
    }

    /* ── Residents ──────────────────────────────────────────────────────── */
    async registerHouse(data) {
      const lat = Number(data.lat), lon = Number(data.lon);
      const row = check(await this.client.rpc('register_household', {
        p_house_no: data.houseNo, p_resident_name: data.residentName, p_ward: data.ward,
        p_address: data.address, p_landmark: data.landmark || '', p_phone: data.phone || '',
        p_lat: Number.isFinite(lat) ? lat : null, p_lon: Number.isFinite(lon) ? lon : null,
      }));
      const house = mapHouse(row);
      this._upsert(this.houses, house);
      this.recalculateDistances();
      this.broadcast('house_registered', { house, isNew: !!row.is_new });
      return house;
    }

    async setGarbageReady(houseNo, isReady) {
      const row = check(await this.client.rpc('set_garbage_ready', { p_house_no: houseNo, p_ready: !!isReady }));
      const house = mapHouse(row);
      const prev = this.houses.find(h => h.id === house.id);
      if (prev) Object.assign(prev, { garbageReady: house.garbageReady });
      else this._upsert(this.houses, house);
      this.recalculateDistances();
      this.broadcast('garbage_ready_updated', { houseNo: house.houseNo, garbageReady: house.garbageReady, house });
      return house;
    }

    async setAlertRadius(houseNo, meters) {
      const value = meters === null || meters === undefined || meters === '' ? null : Math.round(Number(meters));
      const row = check(await this.client.rpc('set_alert_radius', { p_house_no: houseNo, p_radius_m: value }));
      const house = mapHouse(row);
      const prev = this.houses.find(h => h.id === house.id);
      if (prev) prev.alertRadiusM = house.alertRadiusM;
      else this._upsert(this.houses, house);
      this.recalculateDistances();
      this.broadcast('alert_radius_updated', { house: prev || house });
      return prev || house;
    }

    async createPickupRequest(data) {
      const row = check(await this.client.rpc('create_pickup_request', {
        p_house_no: data.houseNo, p_resident_name: data.residentName, p_ward: data.ward,
        p_address: data.address, p_landmark: data.landmark || '', p_note: data.note || '',
        p_waste_type: data.wasteType || 'Mixed Waste',
      }));
      const req = mapPickup(row);
      if (!this._upsert(this.pickupRequests, req)) {
        this.recalculateDistances();
        this._queueAnalytics();
        this.broadcast('pickup_request_created', { request: req });
      }
      return req;
    }

    /* ── Drivers ────────────────────────────────────────────────────────── */
    async updatePickupStatus(requestId, newStatus) {
      const row = check(await this.client.rpc('set_pickup_status', { p_request_id: requestId, p_status: newStatus }));
      const req = mapPickup(row);
      const prev = this._upsert(this.pickupRequests, req);
      this.recalculateDistances();
      this._queueAnalytics();
      if (!prev || prev.status !== req.status) this.broadcast('pickup_status_updated', { request: req });
      return req;
    }

    async reportEmergency(report) {
      const vehicle = this.vehicles.find(v => v.id === report.vehicleId) || this.vehicles[0];
      if (!vehicle) throw new Error('There is no vehicle to report for');
      const row = check(await this.client.rpc('report_issue', {
        p_vehicle_id: vehicle.id, p_type: report.type, p_message: report.message, p_locality: vehicle.locality || '',
      }));
      const entry = mapReport(row);
      if (!this._upsert(this.emergencyReports, entry)) {
        this._queueAnalytics();
        this.broadcast('emergency_reported', { report: entry });
      }
      return entry;
    }

    /* ════════════════════════════════════════════════════════════════════
       Control management (admin). RLS rejects these for everyone else.
    ════════════════════════════════════════════════════════════════════ */
    async updateProfile(id, patch) {
      const cols = {};
      if (patch.fullName !== undefined) cols.full_name = String(patch.fullName).trim();
      if (patch.phone    !== undefined) cols.phone     = String(patch.phone).trim();
      if (patch.role     !== undefined) cols.role      = patch.role;
      if (patch.status   !== undefined) cols.status    = patch.status;
      const rows = check(await this.client.from('profiles').update(cols).eq('id', id).select());
      if (!rows.length) throw new Error('You do not have permission to change this person.');
      const p = mapProfile(rows[0]);
      this._upsert(this.profiles, p);
      if (p.id === this.profile.id) this.profile = p;
      this.broadcast('control_updated', { table: 'profiles' });
      return p;
    }

    async assignDriver(vehicleId, profileId) {
      const row = check(await this.client.from('vehicles').update({ driver_id: profileId || null })
        .eq('id', vehicleId).select().single());
      const prev = this.vehicles.find(v => v.id === vehicleId);
      const v = mapVehicle(row, prev);
      if (prev) for (const k of POSITION_FIELDS) v[k] = prev[k];
      this._upsert(this.vehicles, v);
      this._sortVehicles();
      this.broadcast('driver_switched', { vehicle: v });
      this.broadcast('control_updated', { table: 'vehicles' });
      return v;
    }

    async saveVehicle(data, isNew) {
      const id = String(data.id || '').trim().toUpperCase();
      const cols = {
        plate_number: String(data.plateNumber || '').trim(),
        capacity: String(data.capacity || '').trim(),
        status: data.status || 'active',
      };
      if (data.driverId !== undefined) cols.driver_id = data.driverId || null;
      const query = isNew
        ? this.client.from('vehicles').insert({ id, ...cols })
        : this.client.from('vehicles').update(cols).eq('id', id);
      const row = check(await query.select().single());
      const prev = this.vehicles.find(v => v.id === row.id);
      const v = mapVehicle(row, prev);
      this._upsert(this.vehicles, v);
      this._sortVehicles();
      this.recalculateDistances();
      this._queueAnalytics();
      this.broadcast('control_updated', { table: 'vehicles' });
      return v;
    }

    async deleteVehicle(id) {
      const rows = check(await this.client.from('vehicles').delete().eq('id', id).select('id'));
      if (!rows.length) throw new Error('That vehicle was not removed (it may already be gone).');
      this.vehicles = this.vehicles.filter(v => v.id !== id);
      this.recalculateDistances();
      this._queueAnalytics();
      this.broadcast('control_updated', { table: 'vehicles' });
      this.broadcast('telemetry_update', {});
    }

    async saveHousehold(data, existingId) {
      const lat = Number(data.lat), lon = Number(data.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('A valid latitude and longitude are required');
      const cols = {
        house_no: String(data.houseNo || '').trim(),
        resident_name: String(data.residentName || '').trim(),
        ward: String(data.ward || '').trim(),
        address: String(data.address || '').trim(),
        landmark: String(data.landmark || '').trim(),
        phone: String(data.phone || '').trim(),
        lat, lon,
        owner_id: data.ownerId || null,
        alert_radius_m: data.alertRadiusM === '' || data.alertRadiusM == null ? null : Math.round(Number(data.alertRadiusM)),
      };
      const query = existingId
        ? this.client.from('households').update(cols).eq('id', existingId)
        : this.client.from('households').insert(cols);
      const row = check(await query.select().single());
      const house = mapHouse(row);
      this._upsert(this.houses, house);
      this.recalculateDistances();
      this.broadcast('control_updated', { table: 'households' });
      return house;
    }

    async deleteHousehold(id) {
      const rows = check(await this.client.from('households').delete().eq('id', id).select('id'));
      if (!rows.length) throw new Error('That household was not removed (it may already be gone).');
      const house = this.houses.find(h => h.id === id);
      this.houses = this.houses.filter(h => h.id !== id);
      if (house) this.pickupRequests = this.pickupRequests.filter(r => r.householdId !== id);
      this._queueAnalytics();
      this.broadcast('control_updated', { table: 'households' });
    }

    async deletePickup(id) {
      const rows = check(await this.client.from('pickup_requests').delete().eq('id', id).select('id'));
      if (!rows.length) throw new Error('That pickup was not removed (it may already be gone).');
      this.pickupRequests = this.pickupRequests.filter(r => r.id !== id);
      this._queueAnalytics();
      this.broadcast('control_updated', { table: 'pickup_requests' });
    }

    async updateSettings(patch) {
      const cols = {};
      for (const [k, v] of Object.entries(patch)) if (SETTINGS_COLUMNS[k]) cols[SETTINGS_COLUMNS[k]] = v;
      const row = check(await this.client.from('app_settings').update(cols).eq('id', true).select().single());
      this.settings = mapSettings(row);
      this._queueAnalytics();
      this.broadcast('settings_updated', { settings: this.settings });
      return this.settings;
    }

    /* ── Snapshot (same shape as the demo store) ─────────────────────────── */
    getState() {
      return {
        vehicles:         this.vehicles,
        houses:           this.houses,
        pickupRequests:   this.pickupRequests,
        notifications:    this.notifications,
        analytics:        this.analytics,
        simulation:       this.simulation,
        emergencyReports: this.emergencyReports,
        profiles:         this.profiles,
        settings:         this.settings,
        auditLog:         this.auditLog,
      };
    }
  }

  SupabaseStore.mapProfile = mapProfile;
  SupabaseStore.friendlyError = friendlyError;
  window.SupabaseStore = SupabaseStore;
})();
