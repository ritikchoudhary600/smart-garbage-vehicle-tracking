/**
 * dataStore.js — Browser-side demo state manager (offline demo mode)
 * Ported from server/dataStore.js. Used when Supabase is not configured;
 * supabaseStore.js implements the same API against the real database.
 * Exposes window.AppDataStore and broadcasts changes as window CustomEvents.
 */
(function () {
  'use strict';

  const {
    calculateHaversineDistance,
    calculateBearing,
    getBearingOctant,
    detectLocality,
    calculateETA,
    effectiveAlertRadius,
  } = window.GeoUtils;

  /* ─── Simulation Route Waypoints (Ward 4, Bangalore) ─────────────────── */
  // Waypoints come from routeData.js (snapped to real roads). Waypoints 0–7 sit
  // at exactly the labelled distances from House 125, so the quick-jump chips
  // match what the resident view shows; each carries the road path that leads to it.
  const WAYPOINT_LABELS = [
    'Route start · 1.3 km from House 125',
    'South Gate approach · 1.1 km',
    'Entering Palm Avenue · 900 m',
    'Passing House 88 · 720 m',
    'Palm Crossway · 580 m',
    'Entering 500 m geofence · 480 m',
    'Passing House 102 · 320 m',
    'Approaching House 125 · 150 m',
    'Arrived at House 125',
    'Heading towards House 144',
    'Arrived at House 144',
    'East Sector loop',
    'Returning along East Sector',
    'Completing loop',
  ];
  const SIMULATION_ROUTE = window.ROUTE_DATA.waypoints.map(([lat, lon], i) => ({
    lat, lon,
    label: WAYPOINT_LABELS[i] || `Waypoint ${i + 1}`,
    path: window.ROUTE_DATA.paths[i] || null,
  }));
  const [H88_LAT, H88_LON]   = window.ROUTE_DATA.houses.h88;
  const [H102_LAT, H102_LON] = window.ROUTE_DATA.houses.h102;

  const DEMO_ADMIN_ID    = 'demo-admin';
  const DEMO_ADMIN_EMAIL = 'admin@demo.local';

  /* ─── Initial Houses ──────────────────────────────────────────────────── */
  function makeHouse(h) {
    return {
      garbageReady: false, isInGeofence: false,
      hasPassed: false, prevDistanceToVehicle: null, minDistanceInZone: null,
      distanceToVehicle: null, bearing: null, direction: null, eta: null,
      notifiedAt: null, ownerId: null, phone: '', landmark: '', alertRadiusM: null,
      ...h,
    };
  }

  function makeInitialHouses() {
    return [
      makeHouse({
        id: 'H125', houseNo: '125', residentName: 'Priya Sharma', ward: 'Ward 4',
        address: 'House No. 125, 3rd Cross, Green Glen Sector', landmark: 'Opposite Palm Park',
        lat: 12.94180, lon: 77.62950, phone: '+91 98112 34567', ownerId: 'p-priya',
      }),
      makeHouse({
        id: 'H102', houseNo: '102', residentName: 'Anand Verma', ward: 'Ward 4',
        address: 'House No. 102, 2nd Cross, Green Glen Sector', landmark: 'Near Community Water Kiosk',
        lat: H102_LAT, lon: H102_LON, phone: '+91 98223 45678', garbageReady: true,
      }),
      makeHouse({
        id: 'H144', houseNo: '144', residentName: 'Sneha Patel', ward: 'Ward 4',
        address: 'House No. 144, 4th Cross, Sunshine Crossway', landmark: 'Beside Lotus Bakery',
        lat: 12.94310, lon: 77.63120, phone: '+91 98334 56789',
      }),
      makeHouse({
        id: 'H088', houseNo: '88', residentName: 'Karthik Menon', ward: 'Ward 4',
        address: 'House No. 88, 1st Cross, Palm Avenue', landmark: 'Opposite Green Nursery',
        lat: H88_LAT, lon: H88_LON, phone: '+91 98445 67890',
      }),
    ];
  }

  // Demo people, so the Control panel has someone to manage without Supabase
  function makeInitialProfiles() {
    const ago = m => new Date(Date.now() - m * 60000).toISOString();
    const p = (id, fullName, email, role, extra = {}) => ({
      id, fullName, email, role, status: 'active', phone: '', avatarUrl: null,
      createdAt: ago(60 * 24 * 12), lastSeenAt: ago(30), ...extra,
    });
    return [
      p(DEMO_ADMIN_ID, 'Demo administrator', DEMO_ADMIN_EMAIL, 'admin', { lastSeenAt: new Date().toISOString() }),
      p('p-priya',  'Priya Sharma', 'priya.sharma@example.com', 'resident', { phone: '+91 98112 34567' }),
      p('p-ramesh', 'Ramesh Kumar', 'ramesh.kumar@example.com', 'driver',   { phone: '+91 98765 43210', lastSeenAt: ago(2) }),
      p('p-sunita', 'Sunita Rao',   'sunita.rao@example.com',   'driver',   { phone: '+91 98771 22334', lastSeenAt: ago(300) }),
      p('p-rajesh', 'Rajesh Singh', 'rajesh.singh@example.com', 'driver',   { phone: '+91 98773 55667', lastSeenAt: ago(1500) }),
      p('p-arjun',  'Arjun Nair',   'arjun.nair@example.com',   'pending',  { createdAt: ago(12), lastSeenAt: ago(12) }),
    ];
  }

  const SETTING_LIMITS = {
    geofenceRadiusM: [50, 5000], rearmBufferM: [10, 1000],
    alertRadiusMinM: [50, 5000], alertRadiusMaxM: [50, 5000],
    baselineAnnouncements: [0, 1e7], baselineCollections: [0, 1e7], baselineMissed: [0, 1e7],
    dbHoursPerAnnouncement: [0, 100],
  };

  function diff(before, after, keys) {
    const changes = {};
    for (const k of keys) {
      if (after[k] !== undefined && String(after[k] ?? '') !== String(before[k] ?? '')) {
        changes[k] = { from: before[k] ?? null, to: after[k] };
      }
    }
    return changes;
  }

  /* ─── AppDataStore class ──────────────────────────────────────────────── */
  class AppDataStore {
    constructor() {
      this.mode = 'demo';

      this.settings = {
        wardName: 'Ward 4',
        timezone: 'Asia/Kolkata',
        geofenceRadiusM: 500,        // default alert distance
        alertRadiusMinM: 100,        // range residents may choose from
        alertRadiusMaxM: 2000,
        rearmBufferM: 50,            // re-arm this far beyond each household's distance
        autoApproveResidents: true,
        baselineAnnouncements: 138,
        baselineCollections: 19,
        baselineMissed: 1,
        dbHoursPerAnnouncement: 0.5,
        updatedAt: new Date().toISOString(),
      };

      this.profiles = makeInitialProfiles();
      this.auditLog = [];
      this._auditSeq = 0;

      this.vehicles = [
        {
          id: 'GV-04', driverId: 'p-ramesh', driverName: 'Ramesh Kumar', driverPhone: '+91 98765 43210',
          plateNumber: 'KA-05-GV-2024', capacity: '2 tonnes',
          lat: SIMULATION_ROUTE[0].lat, lon: SIMULATION_ROUTE[0].lon,
          speed: 0, bearing: 45, direction: getBearingOctant(45),
          locality: detectLocality(SIMULATION_ROUTE[0].lat, SIMULATION_ROUTE[0].lon),
          status: 'active', trackingMode: 'simulator', routeIndex: 0,
          lastUpdated: new Date().toISOString(),
          trail: [],
        },
        {
          id: 'GV-07', driverId: null, driverName: '', driverPhone: '',
          plateNumber: 'KA-05-GV-2031', capacity: '3 tonnes',
          lat: null, lon: null, speed: 0, bearing: 0, direction: getBearingOctant(0), locality: '',
          status: 'maintenance', trackingMode: 'simulator', routeIndex: 0,
          lastUpdated: null, trail: [],
        },
      ];

      this.houses = makeInitialHouses();

      this.pickupRequests = [
        {
          id: 'REQ-125', houseNo: '125', residentName: 'Priya Sharma', ward: 'Ward 4',
          address: 'House No. 125, 3rd Cross, Green Glen Sector',
          landmark: 'Black iron gate, left porch',
          note: 'Not at home today. Please collect the 2 segregated bags placed beside the gate.',
          wasteType: 'Segregated (Wet & Dry)', status: 'Pending',
          lat: 12.94180, lon: 77.62950, distanceToVehicle: null,
          createdAt: new Date(Date.now() - 35 * 60000).toISOString(),
          acceptedAt: null, collectedAt: null, missedAt: null,
          updatedAt: new Date(Date.now() - 35 * 60000).toISOString(),
          assignedDriver: null,
        },
        {
          id: 'REQ-088', houseNo: '88', residentName: 'Karthik Menon', ward: 'Ward 4',
          address: 'House No. 88, 1st Cross, Palm Avenue',
          landmark: 'Near front garage door',
          note: 'Away on business trip. Box of cardboard packaging kept outside.',
          wasteType: 'Dry Recyclables', status: 'Accepted',
          lat: H88_LAT, lon: H88_LON, distanceToVehicle: null,
          createdAt: new Date(Date.now() - 55 * 60000).toISOString(),
          acceptedAt: new Date(Date.now() - 10 * 60000).toISOString(),
          collectedAt: null, missedAt: null,
          updatedAt: new Date(Date.now() - 10 * 60000).toISOString(),
          assignedDriver: 'Ramesh Kumar',
        },
      ];

      this.notifications = [
        {
          id: 'NOTIF-INIT-1', houseNo: 'ALL', type: 'system_info',
          title: 'Route Commenced',
          message: 'Garbage collection vehicle GV-04 has started its morning route in Ward 4.',
          timestamp: new Date(Date.now() - 40 * 60000).toISOString(),
        },
      ];
      this.emergencyReports = [];

      this.analytics = {
        announcementsAvoided: this.settings.baselineAnnouncements,
        decibelHoursSaved:    0,
        geofenceAlertsFired:  0,
        collectionsToday:     this.settings.baselineCollections,
        missedPickups:        this.settings.baselineMissed,
        collectionEfficiencyPct: 0,
        pendingPickups:       0,
        delayNotices:         0,
        activeVehicles:       1,
      };

      this.simulation = {
        isRunning: false,
        currentIndex: 0,
        speedMultiplier: 1,
        route: SIMULATION_ROUTE,
      };

      this._recalcAnalytics();
      this.recalculateDistances();
    }

    /* The demo store is ready immediately; supabaseStore loads asynchronously */
    async load() { return this; }

    /* ── Broadcast as CustomEvent on window ─────────────────────────────── */
    broadcast(eventType, payload) {
      window.dispatchEvent(new CustomEvent(eventType, { detail: payload }));
    }

    /* ── Append to the notification history (houseNo 'ALL' = every resident) */
    _notify(houseNo, type, title, message, extra = {}) {
      const notif = {
        id: `NOTIF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        houseNo: String(houseNo), type, title, message,
        timestamp: new Date().toISOString(),
        ...extra,
      };
      this.notifications.unshift(notif);
      if (this.notifications.length > 100) this.notifications.pop();
      return notif;
    }

    _audit(action, tableName, recordLabel, changes = {}) {
      const actor = (window.Auth && window.Auth.profile) || {};
      this.auditLog.unshift({
        id: `AUD-${++this._auditSeq}`,
        actorEmail: actor.email || DEMO_ADMIN_EMAIL,
        action, tableName, recordId: recordLabel, recordLabel, changes,
        createdAt: new Date().toISOString(),
      });
      if (this.auditLog.length > 300) this.auditLog.pop();
      this.broadcast('control_updated', { table: 'audit_log' });
    }

    _recalcAnalytics() {
      const a = this.analytics;
      const attempted = a.collectionsToday + a.missedPickups;
      a.collectionEfficiencyPct = attempted > 0
        ? Math.round((a.collectionsToday / attempted) * 1000) / 10
        : 100;
      a.decibelHoursSaved = Math.round(a.announcementsAvoided * this.settings.dbHoursPerAnnouncement * 10) / 10;
      a.pendingPickups = this.pickupRequests.filter(r => r.status === 'Pending' || r.status === 'Accepted').length;
      a.activeVehicles = this.vehicles.filter(v => v.status === 'active').length;
    }

    /* ── Recalculate distances/bearings for all houses & pickups ────────── */
    recalculateDistances() {
      const vehicle = this.vehicles[0];
      if (!vehicle || vehicle.lat == null) return;

      for (const house of this.houses) {
        const dist = calculateHaversineDistance(vehicle.lat, vehicle.lon, house.lat, house.lon);
        const bear = calculateBearing(vehicle.lat, vehicle.lon, house.lat, house.lon);
        const prevDist = house.distanceToVehicle;

        house.prevDistanceToVehicle = prevDist;
        house.distanceToVehicle = dist;
        house.bearing           = Math.round(bear);
        house.direction         = getBearingOctant(bear);
        house.eta               = calculateETA(dist, vehicle.speed || 20);

        /* Geofence hysteresis: alert within the household's own distance,
           re-arm only once the truck leaves beyond the buffer */
        const radius = effectiveAlertRadius(house, this.settings);
        const approachMax = Math.max(radius * 1.6, radius + 300);

        if (!house.isInGeofence && dist <= radius) {
          house.isInGeofence      = true;
          house.hasPassed         = false;
          house.minDistanceInZone = dist;
          house.notifiedAt        = new Date().toISOString();
          this.analytics.geofenceAlertsFired++;
          this.analytics.announcementsAvoided++;
          this._recalcAnalytics();
          const msg = radius === 500
            ? 'Garbage collection vehicle is approximately 500 metres away. Please keep your garbage ready.'
            : `Garbage collection vehicle is approximately ${radius} metres away. Please keep your garbage ready.`;
          const notif = this._notify(house.houseNo, 'geofence_alert', `Garbage Vehicle Approaching (${radius} m)`,
            msg,
            { residentName: house.residentName, distance: Math.round(dist), radius, direction: vehicle.direction });
          this.broadcast('geofence_alert', notif);
        } else if (house.isInGeofence) {
          if (house.minDistanceInZone == null || dist < house.minDistanceInZone) {
            house.minDistanceInZone = dist;
          }
          // If the truck got close to the gate and is now moving away, mark Vehicle Passed
          if (house.minDistanceInZone <= Math.min(120, radius * 0.35) &&
              dist > house.minDistanceInZone + 80 &&
              prevDist != null && dist > prevDist + 5) {
            house.hasPassed = true;
          }
          // Left the 500m geofence zone (with hysteresis buffer) -> reset alert state
          if (dist > radius + this.settings.rearmBufferM) {
            house.isInGeofence = false;
            if (prevDist != null && dist > house.minDistanceInZone + 50) {
              house.hasPassed = true;
            }
            house.minDistanceInZone = null;
          }
        } else if (house.hasPassed && prevDist != null && dist < prevDist - 15 && dist <= approachMax) {
          // Vehicle is approaching again on a future loop
          house.hasPassed = false;
        }
      }

      for (const req of this.pickupRequests) {
        req.distanceToVehicle = calculateHaversineDistance(vehicle.lat, vehicle.lon, req.lat, req.lon);
      }
    }

    /* ── Clear geofence latches so a fresh demo run re-triggers alerts ──── */
    resetGeofences() {
      for (const house of this.houses) {
        house.isInGeofence = false;
        house.hasPassed = false;
        house.prevDistanceToVehicle = null;
        house.minDistanceInZone = null;
      }
    }

    /* ── Update vehicle GPS location (simulator or live GPS) ─────────────── */
    updateVehicleLocation(vehicleId, lat, lon, speedKmh = 20, opts = {}) {
      const vehicle = this.vehicles.find(v => v.id === vehicleId);
      if (!vehicle) return null;

      const prevLat = vehicle.lat, prevLon = vehicle.lon;
      const hasPrev = prevLat != null && prevLon != null;
      const bearing = hasPrev && (prevLat !== lat || prevLon !== lon)
        ? calculateBearing(prevLat, prevLon, lat, lon)
        : vehicle.bearing;

      /* Maintain breadcrumb trail (max 50 points) */
      if (hasPrev) vehicle.trail.push({ lat: prevLat, lon: prevLon });
      if (vehicle.trail.length > 50) vehicle.trail.shift();

      vehicle.lat          = lat;
      vehicle.lon          = lon;
      vehicle.speed        = speedKmh;
      vehicle.bearing      = Math.round(bearing);
      vehicle.direction    = getBearingOctant(bearing);
      vehicle.locality     = detectLocality(lat, lon);
      vehicle.lastUpdated  = new Date().toISOString();
      vehicle.trackingMode = opts.mode || 'simulator';
      if (opts.routeIndex != null) vehicle.routeIndex = opts.routeIndex;

      this.recalculateDistances();

      this.broadcast('telemetry_update', {
        vehicle,
        houses:    this.houses,
        analytics: this.analytics,
      });

      return vehicle;
    }

    /* ── Resident: register a new household or update an existing one ──── */
    registerHouse(data) {
      const houseNo = String(data.houseNo || '').trim();
      if (!houseNo) throw new Error('House number is required');

      let house = this.houses.find(h => h.houseNo === houseNo);
      const isNew = !house;
      const lat = Number(data.lat), lon = Number(data.lon);

      if (isNew) {
        house = makeHouse({
          id: `H${houseNo.replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`,
          houseNo,
          residentName: data.residentName || `Resident of #${houseNo}`,
          ward:     data.ward || this.settings.wardName,
          address:  data.address || `House No. ${houseNo}, ${this.settings.wardName}`,
          landmark: data.landmark || '',
          phone:    data.phone || '',
          lat: Number.isFinite(lat) && lat ? lat : 12.9415 + (Math.random() - 0.5) * 0.003,
          lon: Number.isFinite(lon) && lon ? lon : 77.6290 + (Math.random() - 0.5) * 0.003,
        });
        this.houses.push(house);
      } else {
        for (const k of ['residentName', 'ward', 'address', 'landmark', 'phone']) {
          if (data[k]) house[k] = data[k];
        }
        if (Number.isFinite(lat) && lat) house.lat = lat;
        if (Number.isFinite(lon) && lon) house.lon = lon;
      }

      this.recalculateDistances();
      this._notify(houseNo, 'registration', isNew ? 'Household Registered' : 'Household Profile Updated',
        `House #${houseNo} (${house.residentName}) registered in ${house.ward}. Quiet geofence alerts are active.`);
      this._audit(isNew ? 'insert' : 'update', 'households', `House #${houseNo}`,
        { resident_name: { from: null, to: house.residentName }, address: { from: null, to: house.address } });
      this.broadcast('house_registered', { house, isNew, houses: this.houses });
      return house;
    }

    /* ── Resident: mark garbage ready ────────────────────────────────────── */
    setGarbageReady(houseNo, isReady) {
      const house = this.houses.find(h => h.houseNo === String(houseNo));
      if (!house) return null;
      house.garbageReady = isReady;
      this._notify(house.houseNo, 'garbage_ready',
        isReady ? 'Garbage Marked Ready' : 'Garbage Ready Cleared',
        isReady
          ? `House #${house.houseNo} told the driver that bins are outside the gate.`
          : `House #${house.houseNo} cleared the garbage-ready status.`);
      this._audit('update', 'households', `House #${house.houseNo}`, { garbage_ready: { from: !isReady, to: isReady } });
      this.broadcast('garbage_ready_updated', { houseNo: house.houseNo, garbageReady: isReady, house });
      return house;
    }

    /* ── Resident: choose how far away the truck is when the alert arrives ─ */
    setAlertRadius(houseNo, meters) {
      const house = this.houses.find(h => h.houseNo === String(houseNo));
      if (!house) throw new Error(`House #${houseNo} not found`);
      const value = this._checkAlertRadius(meters);
      if (value === house.alertRadiusM) return house;
      const before = house.alertRadiusM;
      house.alertRadiusM = value;
      this.recalculateDistances();
      this._audit('update', 'households', `House #${house.houseNo}`, { alertRadiusM: { from: before, to: value } });
      this.broadcast('alert_radius_updated', { house });
      return house;
    }

    // null = ward default; otherwise a whole number inside the allowed range
    _checkAlertRadius(meters) {
      if (meters === null || meters === undefined || meters === '') return null;
      const m = Math.round(Number(meters));
      const { alertRadiusMinM: min, alertRadiusMaxM: max } = this.settings;
      if (!Number.isFinite(m) || m < min || m > max) throw new Error(`Choose an alert distance between ${min} and ${max} m`);
      return m;
    }

    /* ── Resident: create pickup request ─────────────────────────────────── */
    createPickupRequest(data) {
      const houseNo = String(data.houseNo || '').trim() || 'N/A';
      const house   = this.houses.find(h => h.houseNo === houseNo);
      const now     = new Date().toISOString();
      const vehicle = this.vehicles[0];
      const req = {
        id:            `REQ-${Date.now().toString().slice(-5)}`,
        houseNo,
        residentName:  data.residentName || (house ? house.residentName : 'Resident'),
        ward:          data.ward || (house ? house.ward : this.settings.wardName),
        address:       data.address || (house ? house.address : `House No. ${houseNo}, ${this.settings.wardName}`),
        landmark:      data.landmark || '',
        note:          data.note || '',
        wasteType:     data.wasteType || 'Mixed Waste',
        status:        'Pending',
        lat:           house ? house.lat : 12.9415,
        lon:           house ? house.lon : 77.6290,
        distanceToVehicle: null,
        createdAt:     now, acceptedAt: null, collectedAt: null, missedAt: null,
        updatedAt:     now,
        assignedDriver: null,
      };
      this.pickupRequests.unshift(req);
      this.recalculateDistances();
      this._recalcAnalytics();
      this._notify(houseNo, 'pickup_request_created', 'Pickup Request Logged',
        `Pickup request ${req.id} for House #${houseNo} was sent to ${vehicle && vehicle.driverName ? `Driver ${vehicle.driverName}` : 'the collection team'}.`);
      this._audit('insert', 'pickup_requests', req.id, { house_no: { from: null, to: houseNo }, waste_type: { from: null, to: req.wasteType } });
      this.broadcast('pickup_request_created', { request: req, pickupRequests: this.pickupRequests });
      return req;
    }

    /* ── Driver: update pickup request status (Accepted / Collected / Missed) */
    updatePickupStatus(requestId, newStatus, driverName) {
      const req = this.pickupRequests.find(r => r.id === requestId);
      if (!req) return null;
      const driver = driverName || (this.vehicles[0] && this.vehicles[0].driverName) || 'Collection team';
      const now    = new Date().toISOString();
      const prevStatus = req.status;

      req.status         = newStatus;
      req.updatedAt      = now;
      req.assignedDriver = driver;

      if (newStatus === 'Accepted') {
        req.acceptedAt = now;
        this._notify(req.houseNo, 'pickup_accepted', 'Pickup Request Accepted',
          `Driver ${driver} accepted pickup ${req.id} for House #${req.houseNo} and is heading to your location.`);
      } else if (newStatus === 'Collected') {
        if (!req.acceptedAt) req.acceptedAt = now;
        req.collectedAt = now;
        this.analytics.collectionsToday++;
        const house = this.houses.find(h => h.houseNo === req.houseNo);
        if (house) house.garbageReady = false;
        this._notify(req.houseNo, 'pickup_collected', 'Garbage Collected Successfully',
          `Your garbage has been collected by Driver ${driver}. Thank you for keeping your city clean!`);
      } else if (newStatus === 'Missed') {
        req.missedAt = now;
        this.analytics.missedPickups++;
        this._notify(req.houseNo, 'pickup_missed', 'Pickup Missed',
          `Driver ${driver} could not collect from House #${req.houseNo}: bins were inaccessible or the gate was locked.`);
      }

      this._recalcAnalytics();
      this._audit('update', 'pickup_requests', req.id, { status: { from: prevStatus, to: newStatus } });
      this.broadcast('pickup_status_updated', {
        request:        req,
        pickupRequests: this.pickupRequests,
        analytics:      this.analytics,
      });
      return req;
    }

    /* ── Driver: report emergency / delay — broadcast to every resident ──── */
    reportEmergency(report) {
      const vehicle = this.vehicles.find(v => v.id === report.vehicleId) || this.vehicles[0];
      if (!vehicle) throw new Error('There is no vehicle to report for');
      const entry = {
        id: `ER-${Date.now().toString().slice(-5)}`,
        vehicleId:  vehicle.id,
        driverName: vehicle.driverName,
        type:       report.type || 'Other',
        message:    report.message || 'Encountered an unexpected delay.',
        locality:   vehicle.locality,
        reportedAt: new Date().toISOString(),
      };
      this.emergencyReports.unshift(entry);
      this.analytics.delayNotices++;
      this._notify('ALL', 'emergency_alert', `Driver Alert: ${entry.type}`,
        `Vehicle ${entry.vehicleId} reported: ${entry.message}`);
      this._audit('insert', 'emergency_reports', entry.id, { type: { from: null, to: entry.type } });
      this.broadcast('emergency_reported', { report: entry, emergencyReports: this.emergencyReports });
      return entry;
    }

    /* ════════════════════════════════════════════════════════════════════
       Control management (admin)
    ════════════════════════════════════════════════════════════════════ */

    /* ── People: role, status, name, phone ───────────────────────────────── */
    updateProfile(id, patch) {
      const p = this.profiles.find(x => x.id === id);
      if (!p) throw new Error('Person not found');
      const next = { ...p };
      for (const k of ['fullName', 'phone', 'role', 'status']) if (patch[k] !== undefined) next[k] = patch[k];

      const otherAdmins = this.profiles.filter(x => x.id !== id && x.role === 'admin' && x.status === 'active');
      if (p.role === 'admin' && p.status === 'active' && (next.role !== 'admin' || next.status !== 'active') && !otherAdmins.length) {
        throw new Error('At least one active admin is required. Promote someone else first.');
      }

      const changes = diff(p, next, ['fullName', 'phone', 'role', 'status']);
      if (!Object.keys(changes).length) return p;
      Object.assign(p, next);

      for (const v of this.vehicles) {
        if (v.driverId !== id) continue;
        if (p.role !== 'driver') { v.driverId = null; }
        else { v.driverName = p.fullName; if (p.phone) v.driverPhone = p.phone; }
      }
      this._audit('update', 'profiles', p.email, changes);
      this.broadcast('control_updated', { table: 'profiles' });
      return p;
    }

    /* ── Fleet ───────────────────────────────────────────────────────────── */
    assignDriver(vehicleId, profileId) {
      const v = this.vehicles.find(x => x.id === vehicleId);
      if (!v) throw new Error(`Vehicle ${vehicleId} not found`);
      const before = { driverId: v.driverId, driverName: v.driverName };
      if (!profileId) {
        v.driverId = null;
      } else {
        const p = this.profiles.find(x => x.id === profileId);
        if (!p || p.role !== 'driver') throw new Error('Only people with the driver role can be assigned to a vehicle');
        for (const other of this.vehicles) if (other !== v && other.driverId === profileId) other.driverId = null;
        v.driverId = p.id;
        v.driverName = p.fullName;
        if (p.phone) v.driverPhone = p.phone;
      }
      const changes = diff(before, v, ['driverId', 'driverName']);
      if (Object.keys(changes).length) {
        this._audit('update', 'vehicles', v.id, changes);
        this.broadcast('driver_switched', { vehicle: v });
      }
      return v;
    }

    saveVehicle(data, isNew) {
      const id = String(data.id || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{2,20}$/.test(id)) throw new Error('Vehicle ID: 2–20 letters, numbers or dashes');
      if (!String(data.plateNumber || '').trim()) throw new Error('Registration number is required');
      let v = this.vehicles.find(x => x.id === id);

      if (isNew) {
        if (v) throw new Error(`Vehicle ${id} already exists`);
        v = {
          id, driverId: null, driverName: '', driverPhone: '',
          plateNumber: data.plateNumber.trim(), capacity: (data.capacity || '').trim(),
          lat: null, lon: null, speed: 0, bearing: 0, direction: getBearingOctant(0), locality: '',
          status: data.status || 'active', trackingMode: 'simulator', routeIndex: 0, lastUpdated: null, trail: [],
        };
        this.vehicles.push(v);
        this._audit('insert', 'vehicles', id, { plate_number: { from: null, to: v.plateNumber }, status: { from: null, to: v.status } });
      } else {
        if (!v) throw new Error(`Vehicle ${id} not found`);
        const next = { plateNumber: data.plateNumber.trim(), capacity: (data.capacity || '').trim(), status: data.status || v.status };
        const changes = diff(v, next, ['plateNumber', 'capacity', 'status']);
        Object.assign(v, next);
        if (Object.keys(changes).length) this._audit('update', 'vehicles', id, changes);
      }
      if (data.driverId !== undefined && (data.driverId || null) !== (v.driverId || null)) this.assignDriver(id, data.driverId || null);
      this._recalcAnalytics();
      this.broadcast('control_updated', { table: 'vehicles' });
      return v;
    }

    deleteVehicle(id) {
      const i = this.vehicles.findIndex(v => v.id === id);
      if (i < 0) throw new Error(`Vehicle ${id} not found`);
      this.vehicles.splice(i, 1);
      this._recalcAnalytics();
      this._audit('delete', 'vehicles', id);
      this.broadcast('control_updated', { table: 'vehicles' });
      this.broadcast('telemetry_update', { vehicle: this.vehicles[0] || null });
    }

    /* ── Households ──────────────────────────────────────────────────────── */
    saveHousehold(data, existingId) {
      const houseNo = String(data.houseNo || '').trim();
      const lat = Number(data.lat), lon = Number(data.lon);
      if (!houseNo) throw new Error('House number is required');
      if (!String(data.residentName || '').trim()) throw new Error('Resident name is required');
      if (!String(data.address || '').trim()) throw new Error('Address is required');
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new Error('A valid latitude and longitude are required');
      }
      const clash = this.houses.find(h => h.houseNo === houseNo && h.id !== existingId);
      if (clash) throw new Error(`House #${houseNo} is already registered`);

      const fields = {
        houseNo, residentName: data.residentName.trim(), ward: (data.ward || '').trim(),
        address: data.address.trim(), landmark: (data.landmark || '').trim(), phone: (data.phone || '').trim(),
        lat, lon, ownerId: data.ownerId || null,
        alertRadiusM: this._checkAlertRadius(data.alertRadiusM),
      };
      let house;
      if (existingId) {
        house = this.houses.find(h => h.id === existingId);
        if (!house) throw new Error('Household not found');
        const changes = diff(house, fields, Object.keys(fields));
        Object.assign(house, fields);
        if (Object.keys(changes).length) this._audit('update', 'households', `House #${houseNo}`, changes);
      } else {
        house = makeHouse({ id: `H${houseNo.replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`, ...fields });
        this.houses.push(house);
        this._audit('insert', 'households', `House #${houseNo}`, { resident_name: { from: null, to: house.residentName } });
      }
      this.recalculateDistances();
      this.broadcast('control_updated', { table: 'households' });
      return house;
    }

    deleteHousehold(id) {
      const i = this.houses.findIndex(h => h.id === id);
      if (i < 0) throw new Error('Household not found');
      const [house] = this.houses.splice(i, 1);
      this.pickupRequests = this.pickupRequests.filter(r => r.houseNo !== house.houseNo);
      this._recalcAnalytics();
      this._audit('delete', 'households', `House #${house.houseNo}`);
      this.broadcast('control_updated', { table: 'households' });
    }

    deletePickup(id) {
      const i = this.pickupRequests.findIndex(r => r.id === id);
      if (i < 0) throw new Error('Pickup not found');
      this.pickupRequests.splice(i, 1);
      this._recalcAnalytics();
      this._audit('delete', 'pickup_requests', id);
      this.broadcast('control_updated', { table: 'pickup_requests' });
    }

    /* ── Settings ────────────────────────────────────────────────────────── */
    updateSettings(patch) {
      const next = { ...this.settings, ...patch };
      for (const [k, [min, max]] of Object.entries(SETTING_LIMITS)) {
        const n = Number(next[k]);
        if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${k} must be between ${min} and ${max}`);
        next[k] = n;
      }
      if (next.alertRadiusMinM >= next.alertRadiusMaxM) throw new Error('The smallest alert distance must be below the largest');
      if (next.geofenceRadiusM < next.alertRadiusMinM || next.geofenceRadiusM > next.alertRadiusMaxM) {
        throw new Error('The default alert distance must sit inside the range residents can choose from');
      }
      if (!String(next.wardName || '').trim()) throw new Error('Ward name is required');
      try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); }
      catch (e) { throw new Error(`Unknown time zone "${next.timezone}"`); }

      const keys = Object.keys(this.settings).filter(k => k !== 'updatedAt');
      const changes = diff(this.settings, next, keys);
      if (!Object.keys(changes).length) return this.settings;

      // Baselines feed the running counters
      this.analytics.announcementsAvoided += next.baselineAnnouncements - this.settings.baselineAnnouncements;
      this.analytics.collectionsToday     += next.baselineCollections   - this.settings.baselineCollections;
      this.analytics.missedPickups        += next.baselineMissed        - this.settings.baselineMissed;

      Object.assign(this.settings, next, { updatedAt: new Date().toISOString() });
      this._recalcAnalytics();
      this._audit('update', 'app_settings', 'Settings', changes);
      this.broadcast('settings_updated', { settings: this.settings });
      return this.settings;
    }

    /* ── Full state snapshot ─────────────────────────────────────────────── */
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

  window.AppDataStore = new AppDataStore();
  window.AppDataStore.SIMULATION_ROUTE = SIMULATION_ROUTE;
})();
