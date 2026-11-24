/**
 * dataStore.js — Browser-side central state manager
 * Ported from server/dataStore.js for Vercel static deployment.
 * Exposes window.AppDataStore singleton.
 * Broadcasts state changes via window CustomEvents instead of SSE.
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

  const GEOFENCE_ENTER_M = 500;
  const GEOFENCE_EXIT_M  = 550;
  const BASE_ANNOUNCEMENTS_AVOIDED = 138;
  const DB_HOURS_PER_ANNOUNCEMENT  = 0.5;

  /* ─── Initial Houses ──────────────────────────────────────────────────── */
  function makeHouse(h) {
    return {
      garbageReady: false, isInGeofence: false,
      distanceToVehicle: null, bearing: null, direction: null, eta: null,
      notifiedAt: null,
      ...h,
    };
  }

  function makeInitialHouses() {
    return [
      makeHouse({
        id: 'H125', houseNo: '125', residentName: 'Priya Sharma', ward: 'Ward 4',
        address: 'House No. 125, 3rd Cross, Green Glen Sector', landmark: 'Opposite Palm Park',
        lat: 12.94180, lon: 77.62950, phone: '+91 98112 34567',
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

  /* ─── AppDataStore class ──────────────────────────────────────────────── */
  class AppDataStore {
    constructor() {
      this.vehicles = [
        {
          id: 'GV-04', driverName: 'Ramesh Kumar', driverPhone: '+91 98765 43210',
          plateNumber: 'KA-05-GV-2024', capacity: '2 tonnes',
          lat: SIMULATION_ROUTE[0].lat, lon: SIMULATION_ROUTE[0].lon,
          speed: 0, bearing: 45, direction: getBearingOctant(45),
          locality: detectLocality(SIMULATION_ROUTE[0].lat, SIMULATION_ROUTE[0].lon),
          status: 'active',
          lastUpdated: new Date().toISOString(),
          trail: [],
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
        announcementsAvoided: BASE_ANNOUNCEMENTS_AVOIDED,
        decibelHoursSaved:    BASE_ANNOUNCEMENTS_AVOIDED * DB_HOURS_PER_ANNOUNCEMENT,
        geofenceAlertsFired:  0,
        collectionsToday:     19,
        missedPickups:        1,
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

    _recalcAnalytics() {
      const a = this.analytics;
      const attempted = a.collectionsToday + a.missedPickups;
      a.collectionEfficiencyPct = attempted > 0
        ? Math.round((a.collectionsToday / attempted) * 1000) / 10
        : 100;
      a.decibelHoursSaved = Math.round(a.announcementsAvoided * DB_HOURS_PER_ANNOUNCEMENT * 10) / 10;
      a.pendingPickups = this.pickupRequests.filter(r => r.status === 'Pending' || r.status === 'Accepted').length;
    }

    /* ── Recalculate distances/bearings for all houses & pickups ────────── */
    recalculateDistances() {
      const vehicle = this.vehicles[0];
      if (!vehicle) return;

      for (const house of this.houses) {
        const dist = calculateHaversineDistance(vehicle.lat, vehicle.lon, house.lat, house.lon);
        const bear = calculateBearing(vehicle.lat, vehicle.lon, house.lat, house.lon);

        house.distanceToVehicle = dist;
        house.bearing           = Math.round(bear);
        house.direction         = getBearingOctant(bear);
        house.eta               = calculateETA(dist, vehicle.speed || 20);

        /* Geofence hysteresis: enter ≤500m, exit >550m */
        if (!house.isInGeofence && dist <= GEOFENCE_ENTER_M) {
          house.isInGeofence = true;
          house.notifiedAt   = new Date().toISOString();
          this.analytics.geofenceAlertsFired++;
          this.analytics.announcementsAvoided++;
          this._recalcAnalytics();
          const notif = this._notify(house.houseNo, 'geofence_alert', 'Garbage Vehicle Approaching (500m)',
            `Garbage collection vehicle is approximately ${Math.round(dist)} m away. Please keep your garbage ready.`,
            { residentName: house.residentName, distance: Math.round(dist), direction: vehicle.direction });
          this.broadcast('geofence_alert', notif);
        } else if (house.isInGeofence && dist > GEOFENCE_EXIT_M) {
          house.isInGeofence = false;
        }
      }

      for (const req of this.pickupRequests) {
        req.distanceToVehicle = calculateHaversineDistance(vehicle.lat, vehicle.lon, req.lat, req.lon);
      }
    }

    /* ── Clear geofence latches so a fresh demo run re-triggers alerts ──── */
    resetGeofences() {
      for (const house of this.houses) house.isInGeofence = false;
    }

    /* ── Update vehicle GPS location ─────────────────────────────────────── */
    updateVehicleLocation(vehicleId, lat, lon, speedKmh = 20) {
      const vehicle = this.vehicles.find(v => v.id === vehicleId);
      if (!vehicle) return null;

      const prevLat = vehicle.lat, prevLon = vehicle.lon;
      const bearing = (prevLat !== lat || prevLon !== lon)
        ? calculateBearing(prevLat, prevLon, lat, lon)
        : vehicle.bearing;

      /* Maintain breadcrumb trail (max 50 points) */
      vehicle.trail.push({ lat: prevLat, lon: prevLon });
      if (vehicle.trail.length > 50) vehicle.trail.shift();

      vehicle.lat         = lat;
      vehicle.lon         = lon;
      vehicle.speed       = speedKmh;
      vehicle.bearing     = Math.round(bearing);
      vehicle.direction   = getBearingOctant(bearing);
      vehicle.locality    = detectLocality(lat, lon);
      vehicle.lastUpdated = new Date().toISOString();

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
          ward:     data.ward || 'Ward 4',
          address:  data.address || `House No. ${houseNo}, Ward 4`,
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
        `House #${houseNo} (${house.residentName}) registered in ${house.ward}. Quiet 500 m geofence alerts are active.`);
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
      this.broadcast('garbage_ready_updated', { houseNo: house.houseNo, garbageReady: isReady, house });
      return house;
    }

    /* ── Resident: create pickup request ─────────────────────────────────── */
    createPickupRequest(data) {
      const houseNo = String(data.houseNo || '').trim() || 'N/A';
      const house   = this.houses.find(h => h.houseNo === houseNo);
      const now     = new Date().toISOString();
      const req = {
        id:            `REQ-${Date.now().toString().slice(-5)}`,
        houseNo,
        residentName:  data.residentName || (house ? house.residentName : 'Resident'),
        ward:          data.ward || (house ? house.ward : 'Ward 4'),
        address:       data.address || (house ? house.address : `House No. ${houseNo}, Ward 4`),
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
        `Pickup request ${req.id} for House #${houseNo} was sent to Driver ${this.vehicles[0].driverName}.`);
      this.broadcast('pickup_request_created', { request: req, pickupRequests: this.pickupRequests });
      return req;
    }

    /* ── Driver: update pickup request status (Accepted / Collected / Missed) */
    updatePickupStatus(requestId, newStatus, driverName) {
      const req = this.pickupRequests.find(r => r.id === requestId);
      if (!req) return null;
      const driver = driverName || this.vehicles[0].driverName;
      const now    = new Date().toISOString();

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
      this.broadcast('pickup_status_updated', {
        request:        req,
        pickupRequests: this.pickupRequests,
        analytics:      this.analytics,
      });
      return req;
    }

    /* ── Driver: switch the driver on duty ───────────────────────────────── */
    switchDriver(driverName, vehicleId = 'GV-04') {
      const vehicle = this.vehicles.find(v => v.id === vehicleId);
      if (!vehicle || !driverName) return null;
      vehicle.driverName = driverName;
      this.broadcast('driver_switched', { vehicle });
      return vehicle;
    }

    /* ── Driver: report emergency / delay — broadcast to every resident ──── */
    reportEmergency(report) {
      const vehicle = this.vehicles[0];
      const entry = {
        id: `ER-${Date.now().toString().slice(-5)}`,
        vehicleId:  report.vehicleId || vehicle.id,
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
      this.broadcast('emergency_reported', { report: entry, emergencyReports: this.emergencyReports });
      return entry;
    }

    /* ── Full state snapshot ─────────────────────────────────────────────── */
    getState() {
      return {
        vehicles:        this.vehicles,
        houses:          this.houses,
        pickupRequests:  this.pickupRequests,
        notifications:   this.notifications,
        analytics:       this.analytics,
        simulation:      this.simulation,
        emergencyReports: this.emergencyReports,
      };
    }
  }

  window.AppDataStore = new AppDataStore();
})();
