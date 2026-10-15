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
  const SIMULATION_ROUTE = [
    { lat: 12.9310, lon: 77.6210, label: 'Depot Start' },
    { lat: 12.9325, lon: 77.6220, label: 'Route Segment 1' },
    { lat: 12.9338, lon: 77.6228, label: 'Route Segment 2' },
    { lat: 12.9350, lon: 77.6237, label: 'South Gate' },
    { lat: 12.9362, lon: 77.6248, label: 'Route Segment 4' },
    { lat: 12.9372, lon: 77.6258, label: 'Palm Avenue Start' },
    { lat: 12.9381, lon: 77.6265, label: 'Palm Avenue' },
    { lat: 12.9390, lon: 77.6272, label: 'Route Segment 7' },
    { lat: 12.9395, lon: 77.6278, label: '~500m from House 125' },
    { lat: 12.9401, lon: 77.6283, label: 'Approaching House 125' },
    { lat: 12.9408, lon: 77.6288, label: 'Near House 125' },
    { lat: 12.9415, lon: 77.6292, label: 'Green Glen Sector' },
    { lat: 12.9422, lon: 77.6300, label: 'Sunshine Crossway Approach' },
    { lat: 12.9430, lon: 77.6320, label: 'Sunshine Crossway' },
  ];

  /* ─── Initial Houses ──────────────────────────────────────────────────── */
  function makeInitialHouses() {
    return [
      {
        id: 'H001', houseNo: '125', residentName: 'Arjun Sharma',
        ward: 'Ward 4', address: 'House 125, Green Glen Residential Sector, Ward 4',
        lat: 12.94180, lon: 77.62950,
        garbageReady: false, isInGeofence: false,
        distanceToVehicle: null, bearing: null, direction: null, eta: null,
        notifiedAt: null, phone: '+91-9876543210',
      },
      {
        id: 'H002', houseNo: '102', residentName: 'Priya Reddy',
        ward: 'Ward 4', address: 'House 102, Palm Avenue, Ward 4',
        lat: 12.93820, lon: 77.62680,
        garbageReady: false, isInGeofence: false,
        distanceToVehicle: null, bearing: null, direction: null, eta: null,
        notifiedAt: null, phone: '+91-9876543211',
      },
      {
        id: 'H003', houseNo: '144', residentName: 'Mohammed Farooq',
        ward: 'Ward 4', address: 'House 144, Sunshine Crossway, Ward 4',
        lat: 12.94320, lon: 77.63150,
        garbageReady: true, isInGeofence: false,
        distanceToVehicle: null, bearing: null, direction: null, eta: null,
        notifiedAt: null, phone: '+91-9876543212',
      },
      {
        id: 'H004', houseNo: '88', residentName: 'Lakshmi Iyer',
        ward: 'Ward 4', address: 'House 88, South Gate Layout, Ward 4',
        lat: 12.93520, lon: 77.62420,
        garbageReady: false, isInGeofence: false,
        distanceToVehicle: null, bearing: null, direction: null, eta: null,
        notifiedAt: null, phone: '+91-9876543213',
      },
    ];
  }

  /* ─── AppDataStore class ──────────────────────────────────────────────── */
  class AppDataStore {
    constructor() {
      this.vehicles = [
        {
          id: 'GV-04', driverName: 'Ramesh Kumar', driverPhone: '+91-9876500001',
          plateNumber: 'KA-01-GC-4521', capacity: '2 tonnes',
          lat: SIMULATION_ROUTE[0].lat, lon: SIMULATION_ROUTE[0].lon,
          speed: 0, bearing: 0, direction: { code: 'N', name: 'North', arrow: '↑', label: 'North ↑' },
          locality: 'Municipal Central Depot', status: 'active',
          lastUpdated: new Date().toISOString(),
          trail: [],
        },
      ];

      this.houses = makeInitialHouses();

      this.pickupRequests = [
        {
          id: 'PR001', houseNo: '77', residentName: 'Deepa Nair',
          ward: 'Ward 4', address: 'House 77, Rose Garden Layout, Ward 4',
          landmark: 'Near blue water tank', note: 'Bulky waste — old furniture',
          wasteType: 'Bulky Waste', status: 'Pending',
          lat: 12.9400, lon: 77.6305,
          createdAt: new Date(Date.now() - 25 * 60000).toISOString(),
          updatedAt: new Date(Date.now() - 25 * 60000).toISOString(),
          assignedDriver: null,
        },
        {
          id: 'PR002', houseNo: '33', residentName: 'Suresh Babu',
          ward: 'Ward 4', address: 'House 33, Palm View Colony, Ward 4',
          landmark: 'Opposite primary school', note: 'Bio-medical waste — handle with care',
          wasteType: 'Hazardous', status: 'Accepted',
          lat: 12.9370, lon: 77.6260,
          createdAt: new Date(Date.now() - 55 * 60000).toISOString(),
          updatedAt: new Date(Date.now() - 10 * 60000).toISOString(),
          assignedDriver: 'Ramesh Kumar',
        },
      ];

      this.notifications = [];
      this.emergencyReports = [];

      this.analytics = {
        collectionsToday: 12,
        pendingPickups: 2,
        missedPickups: 1,
        noiseReductionEvents: 0,
        activeVehicles: 1,
        geofenceAlertsFired: 0,
      };

      this.simulation = {
        isRunning: false,
        currentIndex: 0,
        speedMultiplier: 1,
        route: SIMULATION_ROUTE,
      };

      this.requestCounter = 3;
      this.recalculateDistances();
    }

    /* ── Broadcast as CustomEvent on window ─────────────────────────────── */
    broadcast(eventType, payload) {
      window.dispatchEvent(new CustomEvent(eventType, { detail: payload }));
    }

    /* ── Recalculate distances/bearings for all houses ──────────────────── */
    recalculateDistances() {
      const vehicle = this.vehicles[0];
      if (!vehicle) return;

      for (const house of this.houses) {
        const dist = calculateHaversineDistance(vehicle.lat, vehicle.lon, house.lat, house.lon);
        const bear = calculateBearing(vehicle.lat, vehicle.lon, house.lat, house.lon);
        const dir  = getBearingOctant(bear);
        const eta  = calculateETA(dist, vehicle.speed || 20);

        house.distanceToVehicle = dist;
        house.bearing           = Math.round(bear);
        house.direction         = dir;
        house.eta               = eta;

        /* Geofence hysteresis: enter ≤500m, exit >550m */
        const ENTER_RADIUS = 500;
        const EXIT_RADIUS  = 550;
        const wasInside    = house.isInGeofence;

        if (!wasInside && dist <= ENTER_RADIUS) {
          house.isInGeofence = true;
          house.notifiedAt   = new Date().toISOString();
          this.analytics.geofenceAlertsFired++;
          this.analytics.noiseReductionEvents++;
          const notif = {
            id: `NOTIF-${Date.now()}-${house.houseNo}`,
            type: 'geofence_alert',
            houseNo: house.houseNo,
            residentName: house.residentName,
            message: `🚛 Garbage vehicle is ~${Math.round(dist)} m away from House #${house.houseNo}. Please keep your garbage ready!`,
            distance: Math.round(dist),
            direction: dir,
            timestamp: new Date().toISOString(),
          };
          this.notifications.unshift(notif);
          this.broadcast('geofence_alert', notif);
        } else if (wasInside && dist > EXIT_RADIUS) {
          house.isInGeofence = false;
        }
      }
    }

    /* ── Update vehicle GPS location ─────────────────────────────────────── */
    updateVehicleLocation(vehicleId, lat, lon, speedKmh = 20) {
      const vehicle = this.vehicles.find(v => v.id === vehicleId);
      if (!vehicle) return null;

      const prevLat = vehicle.lat, prevLon = vehicle.lon;
      const bearing = (prevLat !== lat || prevLon !== lon)
        ? calculateBearing(prevLat, prevLon, lat, lon)
        : vehicle.bearing;
      const direction = getBearingOctant(bearing);
      const locality  = detectLocality(lat, lon);

      /* Maintain breadcrumb trail (max 50 points) */
      vehicle.trail.push({ lat: prevLat, lon: prevLon });
      if (vehicle.trail.length > 50) vehicle.trail.shift();

      vehicle.lat         = lat;
      vehicle.lon         = lon;
      vehicle.speed       = speedKmh;
      vehicle.bearing     = Math.round(bearing);
      vehicle.direction   = direction;
      vehicle.locality    = locality;
      vehicle.lastUpdated = new Date().toISOString();

      this.recalculateDistances();

      this.broadcast('telemetry_update', {
        vehicle,
        houses:    this.houses,
        analytics: this.analytics,
      });

      return vehicle;
    }

    /* ── Resident: mark garbage ready ────────────────────────────────────── */
    setGarbageReady(houseNo, isReady) {
      const house = this.houses.find(h => h.houseNo === String(houseNo));
      if (!house) return null;
      house.garbageReady = isReady;
      this.broadcast('garbage_ready_updated', { houseNo, garbageReady: isReady });
      return house;
    }

    /* ── Resident: create pickup request ─────────────────────────────────── */
    createPickupRequest(data) {
      const req = {
        id:            `PR${String(this.requestCounter++).padStart(3, '0')}`,
        houseNo:       data.houseNo || 'N/A',
        residentName:  data.residentName || 'Resident',
        ward:          data.ward || 'Ward 4',
        address:       data.address || `House ${data.houseNo}, Ward 4`,
        landmark:      data.landmark || '',
        note:          data.note || '',
        wasteType:     data.wasteType || 'Mixed Waste',
        status:        'Pending',
        lat:           data.lat || 12.9415,
        lon:           data.lon || 77.6290,
        createdAt:     new Date().toISOString(),
        updatedAt:     new Date().toISOString(),
        assignedDriver: null,
      };
      this.pickupRequests.unshift(req);
      this.analytics.pendingPickups++;
      this.broadcast('pickup_request_created', { request: req, pickupRequests: this.pickupRequests });
      return req;
    }

    /* ── Driver: update pickup request status ────────────────────────────── */
    updatePickupStatus(requestId, newStatus, driverName = 'Ramesh Kumar') {
      const req = this.pickupRequests.find(r => r.id === requestId);
      if (!req) return null;
      const prev = req.status;
      req.status        = newStatus;
      req.updatedAt     = new Date().toISOString();
      req.assignedDriver = driverName;

      if (newStatus === 'Accepted' && prev === 'Pending') this.analytics.pendingPickups = Math.max(0, this.analytics.pendingPickups - 1);
      if (newStatus === 'Collected') { this.analytics.collectionsToday++; }

      this.broadcast('pickup_status_updated', {
        request:        req,
        pickupRequests: this.pickupRequests,
        analytics:      this.analytics,
      });
      return req;
    }

    /* ── Driver: report emergency ────────────────────────────────────────── */
    reportEmergency(report) {
      const entry = { ...report, id: `ER${Date.now()}`, reportedAt: new Date().toISOString(), resolved: false };
      this.emergencyReports.unshift(entry);
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
