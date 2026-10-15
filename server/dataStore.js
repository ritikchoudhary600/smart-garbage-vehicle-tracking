/**
 * dataStore.js - Central in-memory state & event dispatch for the Smart Garbage Vehicle System
 */

const {
  calculateHaversineDistance,
  calculateBearing,
  getBearingOctant,
  detectLocality,
  calculateETA,
  calculateRouteProgress
} = require('./geoUtils');

// Predefined route waypoints for Ward 4 simulation
// Starts at South Gate Approach (~1.2km away from House 125), traverses towards House 125, triggers 500m alert, and completes the loop
const WARD_4_SIMULATION_ROUTE = [
  { lat: 12.93350, lon: 77.62250, locality: 'Ward 4 - South Gate Approach', desc: 'Starting point (1.3 km away)' },
  { lat: 12.93500, lon: 77.62400, locality: 'Ward 4 - South Gate Approach', desc: 'Approaching South Sector (~1.1 km)' },
  { lat: 12.93650, lon: 77.62530, locality: 'Ward 4 - Palm Avenue & Park View', desc: 'Entering Palm Avenue (~900 m)' },
  { lat: 12.93780, lon: 77.62650, locality: 'Ward 4 - Palm Avenue & Park View', desc: 'Near House 88 (~720 m)' },
  { lat: 12.93880, lon: 77.62720, locality: 'Ward 4 - Palm Avenue & Park View', desc: 'Palm Crossway (~580 m)' },
  // Crosses the 500m geofence around House 125!
  { lat: 12.93950, lon: 77.62780, locality: 'Ward 4 - Green Glen Residential Sector', desc: 'Geofence Entry! (~480 m from House 125)' },
  { lat: 12.94050, lon: 77.62850, locality: 'Ward 4 - Green Glen Residential Sector', desc: 'Near House 102 (~320 m)' },
  { lat: 12.94120, lon: 77.62910, locality: 'Ward 4 - Green Glen Residential Sector', desc: 'Approaching House 125 (~150 m)' },
  { lat: 12.94180, lon: 77.62950, locality: 'Ward 4 - Green Glen Residential Sector', desc: 'Arrived at House 125 (0 m)' },
  { lat: 12.94240, lon: 77.63030, locality: 'Ward 4 - Sunshine Crossway', desc: 'Heading towards House 144 (~180 m)' },
  { lat: 12.94310, lon: 77.63120, locality: 'Ward 4 - Sunshine Crossway', desc: 'Arrived at House 144' },
  { lat: 12.94220, lon: 77.63280, locality: 'Ward 4 - Sunshine Crossway', desc: 'East Sector Exit loop' },
  { lat: 12.94050, lon: 77.63200, locality: 'Ward 4 - Green Glen Residential Sector', desc: 'Returning along East Sector' },
  { lat: 12.93800, lon: 77.63000, locality: 'Ward 4 - Palm Avenue & Park View', desc: 'Completing Loop' }
];

class DataStore {
  constructor() {
    this.subscribers = new Set();

    // Active Garbage Vehicles
    this.vehicles = [
      {
        id: 'GV-04',
        vehicleNumber: 'KA-05-GV-2024',
        driverName: 'Ramesh Kumar',
        driverContact: '+91 98765 43210',
        routeId: 'ROUTE-W4',
        routeName: 'Ward 4 Residential Morning Circuit',
        status: 'Active', // Active, In Transit, Idle, Emergency
        lat: WARD_4_SIMULATION_ROUTE[0].lat,
        lon: WARD_4_SIMULATION_ROUTE[0].lon,
        prevLat: WARD_4_SIMULATION_ROUTE[0].lat - 0.0005,
        prevLon: WARD_4_SIMULATION_ROUTE[0].lon - 0.0005,
        bearing: 45,
        bearingOctant: { code: 'NE', name: 'Northeast', arrow: '↗', label: 'Northeast ↗' },
        speedKmh: 22,
        currentLocality: WARD_4_SIMULATION_ROUTE[0].locality,
        capacityFilledPct: 42,
        lastUpdated: new Date().toISOString(),
        history: []
      }
    ];

    // Registered Households
    this.houses = [
      {
        id: 'house-125',
        houseNo: '125',
        residentName: 'Priya Sharma',
        ward: 'Ward 4',
        address: 'House No. 125, 3rd Cross, Green Glen Sector',
        landmark: 'Opposite Palm Park',
        contact: '+91 98112 34567',
        lat: 12.94180,
        lon: 77.62950,
        isInGeofence: false,
        distanceMeters: 0,
        bearingFromVehicle: null,
        garbageReady: false,
        lastNotificationAt: null
      },
      {
        id: 'house-102',
        houseNo: '102',
        residentName: 'Anand Verma',
        ward: 'Ward 4',
        address: 'House No. 102, 2nd Cross, Green Glen Sector',
        landmark: 'Near Community Water Kiosk',
        contact: '+91 98223 45678',
        lat: 12.94050,
        lon: 77.62820,
        isInGeofence: false,
        distanceMeters: 0,
        bearingFromVehicle: null,
        garbageReady: true,
        lastNotificationAt: null
      },
      {
        id: 'house-144',
        houseNo: '144',
        residentName: 'Sneha Patel',
        ward: 'Ward 4',
        address: 'House No. 144, 4th Cross, Sunshine Crossway',
        landmark: 'Beside Lotus Bakery',
        contact: '+91 98334 56789',
        lat: 12.94310,
        lon: 77.63120,
        isInGeofence: false,
        distanceMeters: 0,
        bearingFromVehicle: null,
        garbageReady: false,
        lastNotificationAt: null
      },
      {
        id: 'house-88',
        houseNo: '88',
        residentName: 'Karthik Menon',
        ward: 'Ward 4',
        address: 'House No. 88, 1st Cross, Palm Avenue',
        landmark: 'Opposite Green Nursery',
        contact: '+91 98445 67890',
        lat: 12.93880,
        lon: 77.62680,
        isInGeofence: false,
        distanceMeters: 0,
        bearingFromVehicle: null,
        garbageReady: false,
        lastNotificationAt: null
      }
    ];

    // Pickup Requests (Away from Home)
    this.pickupRequests = [
      {
        id: 'REQ-125',
        houseNo: '125',
        residentName: 'Priya Sharma',
        ward: 'Ward 4',
        address: 'House No. 125, 3rd Cross, Green Glen Sector',
        lat: 12.94180,
        lon: 77.62950,
        landmark: 'Black iron gate, left porch',
        note: 'Not at home today. Please collect the 2 segregated bags placed beside the gate.',
        wasteType: 'Segregated (Wet & Dry)',
        status: 'Pending', // Pending, Accepted, Collected
        createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
        acceptedAt: null,
        collectedAt: null,
        collectedBy: null
      },
      {
        id: 'REQ-088',
        houseNo: '88',
        residentName: 'Karthik Menon',
        ward: 'Ward 4',
        address: 'House No. 88, 1st Cross, Palm Avenue',
        lat: 12.93880,
        lon: 77.62680,
        landmark: 'Near front garage door',
        note: 'Away on business trip. Box of cardboard packaging kept outside.',
        wasteType: 'Dry Recyclables',
        status: 'Pending',
        createdAt: new Date(Date.now() - 55 * 60 * 1000).toISOString(),
        acceptedAt: null,
        collectedAt: null,
        collectedBy: null
      }
    ];

    // Notification Feed / Audit History
    this.notifications = [
      {
        id: 'NOTIF-INIT-1',
        houseNo: '125',
        recipient: 'Priya Sharma',
        type: 'system_info',
        title: 'Route Commenced',
        message: 'Garbage collection vehicle GV-04 has started its morning route in Ward 4.',
        timestamp: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        read: true
      }
    ];

    // Municipal & Noise Reduction Analytics
    this.analytics = {
      announcementsAvoided: 138, // Loudspeaker announcements saved today
      decibelHoursSaved: 69.0,   // ~30 min of 85 dB loudspeaker broadcast replaced by digital alerts
      totalCollectionsToday: 19,
      missedPickups: 0,
      activeVehiclesCount: 1,
      totalRegisteredHouses: this.houses.length,
      collectionEfficiencyPct: 92.5
    };

    // Emergency / Issue Reports
    this.emergencyReports = [];

    // Simulation Controller State
    this.simulation = {
      isRunning: false,
      currentIndex: 0,
      speedMultiplier: 1,
      route: WARD_4_SIMULATION_ROUTE,
      timer: null
    };

    // Initialize distances for all houses
    this.recalculateDistances();
  }

  /**
   * Subscribe client to SSE updates
   */
  subscribe(res) {
    this.subscribers.add(res);
  }

  /**
   * Unsubscribe client from SSE updates
   */
  unsubscribe(res) {
    this.subscribers.delete(res);
  }

  /**
   * Broadcast real-time message to all SSE clients
   */
  broadcast(eventType, payload) {
    const data = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.subscribers) {
      try {
        client.write(data);
      } catch (err) {
        this.subscribers.delete(client);
      }
    }
  }

  /**
   * Recalculates distances, bearings, and ETAs from the active vehicle to all registered houses.
   * Handles the 500-metre Geofence alert trigger with hysteresis debounce!
   */
  recalculateDistances() {
    const vehicle = this.vehicles[0];
    if (!vehicle) return;

    const triggeredNotifications = [];

    for (const house of this.houses) {
      const dist = calculateHaversineDistance(vehicle.lat, vehicle.lon, house.lat, house.lon);
      house.distanceMeters = dist;
      house.eta = calculateETA(dist, vehicle.speedKmh);

      const bearing = calculateBearing(vehicle.lat, vehicle.lon, house.lat, house.lon);
      house.bearingFromVehicle = {
        degrees: bearing,
        octant: getBearingOctant(bearing)
      };

      // GEOFENCING LOGIC (500-Metre Radius)
      // When distance <= 500m and not already inside geofence:
      if (dist <= 500 && !house.isInGeofence) {
        house.isInGeofence = true;
        house.lastNotificationAt = new Date().toISOString();

        // Increment municipal noise-prevention metrics
        this.analytics.announcementsAvoided += 1;
        this.analytics.decibelHoursSaved = Math.round((this.analytics.announcementsAvoided * 0.5) * 10) / 10;

        const notif = {
          id: `NOTIF-${Date.now()}-${house.houseNo}`,
          houseNo: house.houseNo,
          recipient: house.residentName,
          type: 'geofence_500m',
          title: 'Garbage Vehicle Approaching (500m)',
          message: `Garbage collection vehicle is approximately ${Math.round(dist)} m away. Please keep your garbage ready.`,
          distance: Math.round(dist),
          timestamp: new Date().toISOString(),
          read: false
        };

        this.notifications.unshift(notif);
        triggeredNotifications.push(notif);
      }
      // Hysteresis exit: only reset geofence when vehicle moves beyond 550m
      else if (dist > 550 && house.isInGeofence) {
        house.isInGeofence = false;
      }
    }

    if (triggeredNotifications.length > 0) {
      for (const notif of triggeredNotifications) {
        this.broadcast('geofence_alert', notif);
      }
    }
  }

  /**
   * Updates vehicle GPS location, recalculates heading/bearing, and checks geofence
   */
  updateVehicleLocation(vehicleId, lat, lon, speedKmh = 20) {
    const vehicle = this.vehicles.find(v => v.id === vehicleId) || this.vehicles[0];
    if (!vehicle) return null;

    // Calculate heading/bearing from previous position to new position
    const bearing = calculateBearing(vehicle.lat, vehicle.lon, lat, lon);
    const bearingOctant = getBearingOctant(bearing);
    const locality = detectLocality(lat, lon);

    // Update vehicle properties
    vehicle.prevLat = vehicle.lat;
    vehicle.prevLon = vehicle.lon;
    vehicle.lat = lat;
    vehicle.lon = lon;
    vehicle.bearing = bearing;
    vehicle.bearingOctant = bearingOctant;
    vehicle.speedKmh = speedKmh;
    vehicle.currentLocality = locality;
    vehicle.lastUpdated = new Date().toISOString();

    // Store breadcrumb (keep last 50)
    vehicle.history.push({
      lat,
      lon,
      bearing,
      speedKmh,
      timestamp: vehicle.lastUpdated
    });
    if (vehicle.history.length > 50) {
      vehicle.history.shift();
    }

    vehicle.routeProgress = calculateRouteProgress(this.simulation.currentIndex, this.simulation.route.length);

    // Run geofencing and distance checks
    this.recalculateDistances();

    const payload = {
      vehicle,
      houses: this.houses,
      analytics: this.analytics
    };

    this.broadcast('telemetry_update', payload);
    return payload;
  }

  /**
   * Resident sets "Garbage Ready" status
   */
  setGarbageReady(houseNo, isReady) {
    const house = this.houses.find(h => h.houseNo === String(houseNo));
    if (!house) return null;

    house.garbageReady = isReady;

    const notif = {
      id: `NOTIF-${Date.now()}-RDY`,
      houseNo: house.houseNo,
      recipient: house.residentName,
      type: 'garbage_ready',
      title: isReady ? 'Garbage Marked as Ready' : 'Garbage Ready Cleared',
      message: isReady
        ? `House #${house.houseNo} reported garbage is outside and ready for pickup.`
        : `House #${house.houseNo} cleared ready status.`,
      timestamp: new Date().toISOString(),
      read: true
    };
    this.notifications.unshift(notif);

    this.broadcast('garbage_ready_updated', {
      houseNo: house.houseNo,
      garbageReady: house.garbageReady,
      house
    });

    return house;
  }

  /**
   * Register a new household or update an existing household profile
   */
  registerOrUpdateHouse(houseData) {
    const houseNo = String(houseData.houseNo || '').trim();
    if (!houseNo) {
      throw new Error('House number is required');
    }

    let house = this.houses.find(h => h.houseNo === houseNo);
    const isNew = !house;

    if (!house) {
      // Default coordinates near Ward 4 center if not specified
      const baseLat = 12.94100;
      const baseLon = 77.62900;
      const offsetLat = (Math.random() - 0.5) * 0.003;
      const offsetLon = (Math.random() - 0.5) * 0.003;

      house = {
        id: `house-${houseNo.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
        houseNo,
        residentName: houseData.residentName || `Resident of #${houseNo}`,
        ward: houseData.ward || 'Ward 4',
        address: houseData.address || `House No. ${houseNo}, Ward 4`,
        landmark: houseData.landmark || '',
        contact: houseData.contact || '+91 98000 00000',
        lat: Number(houseData.lat) || (baseLat + offsetLat),
        lon: Number(houseData.lon) || (baseLon + offsetLon),
        isInGeofence: false,
        distanceMeters: 0,
        bearingFromVehicle: null,
        garbageReady: false,
        lastNotificationAt: null
      };
      this.houses.push(house);
      this.analytics.totalRegisteredHouses = this.houses.length;
    } else {
      if (houseData.residentName) house.residentName = houseData.residentName;
      if (houseData.ward) house.ward = houseData.ward;
      if (houseData.address) house.address = houseData.address;
      if (houseData.landmark !== undefined) house.landmark = houseData.landmark;
      if (houseData.contact) house.contact = houseData.contact;
      if (houseData.lat != null && !isNaN(Number(houseData.lat))) house.lat = Number(houseData.lat);
      if (houseData.lon != null && !isNaN(Number(houseData.lon))) house.lon = Number(houseData.lon);
    }

    this.recalculateDistances();

    const notif = {
      id: `NOTIF-${Date.now()}-REG`,
      houseNo: house.houseNo,
      recipient: house.residentName,
      type: 'registration',
      title: isNew ? 'Household Registered' : 'Household Profile Updated',
      message: `House #${house.houseNo} (${house.residentName}) registered in ${house.ward}. Quiet geofence tracking active.`,
      timestamp: new Date().toISOString(),
      read: true
    };
    this.notifications.unshift(notif);

    this.broadcast('house_registered', {
      house,
      houses: this.houses,
      analytics: this.analytics
    });

    return house;
  }

  /**
   * Resident submits an away-from-home Pickup Request
   */
  createPickupRequest(requestData) {
    const id = `REQ-${Date.now().toString().slice(-4)}`;
    const houseNo = String(requestData.houseNo || '125');
    const matchedHouse = this.houses.find(h => h.houseNo === houseNo);

    const newRequest = {
      id,
      houseNo,
      residentName: requestData.residentName || (matchedHouse ? matchedHouse.residentName : 'Resident'),
      ward: requestData.ward || (matchedHouse ? matchedHouse.ward : 'Ward 4'),
      address: requestData.address || (matchedHouse ? matchedHouse.address : `House No. ${houseNo}, Ward 4`),
      lat: Number(requestData.lat) || (matchedHouse ? matchedHouse.lat : 12.94180),
      lon: Number(requestData.lon) || (matchedHouse ? matchedHouse.lon : 77.62950),
      landmark: requestData.landmark || (matchedHouse ? matchedHouse.landmark : 'Outside front gate'),
      note: requestData.note || 'Please collect the garbage kept outside my house.',
      wasteType: requestData.wasteType || 'Segregated (Dry & Wet)',
      status: 'Pending',
      createdAt: new Date().toISOString(),
      acceptedAt: null,
      collectedAt: null,
      collectedBy: null,
      missedAt: null,
      missedReason: null
    };

    this.pickupRequests.unshift(newRequest);

    // Also add to notifications
    const notif = {
      id: `NOTIF-${Date.now()}-REQ`,
      houseNo: newRequest.houseNo,
      recipient: newRequest.residentName,
      type: 'pickup_request_created',
      title: 'Pickup Request Logged',
      message: `Pickup request #${newRequest.id} for House #${newRequest.houseNo} has been forwarded to Driver ${this.vehicles[0].driverName}.`,
      timestamp: new Date().toISOString(),
      read: false
    };
    this.notifications.unshift(notif);

    this.broadcast('pickup_request_created', {
      request: newRequest,
      pickupRequests: this.pickupRequests
    });

    return newRequest;
  }

  /**
   * Driver updates Pickup Request status (Pending -> Accepted -> Collected / Missed)
   */
  updatePickupStatus(requestId, newStatus, driverName = 'Ramesh Kumar') {
    const req = this.pickupRequests.find(r => r.id === requestId);
    if (!req) return null;

    req.status = newStatus;
    if (newStatus === 'Accepted') {
      req.acceptedAt = new Date().toISOString();
      const notif = {
        id: `NOTIF-${Date.now()}-ACCEPTED`,
        houseNo: req.houseNo,
        recipient: req.residentName,
        type: 'pickup_accepted',
        title: 'Pickup Request Accepted',
        message: `Driver ${driverName} accepted pickup #${req.id} for House #${req.houseNo} and is heading towards your location.`,
        timestamp: new Date().toISOString(),
        read: false
      };
      this.notifications.unshift(notif);
    } else if (newStatus === 'Collected') {
      req.collectedAt = new Date().toISOString();
      req.collectedBy = driverName;

      // Increment municipal collection metrics
      this.analytics.totalCollectionsToday += 1;
      const totalAttempted = this.analytics.totalCollectionsToday + (this.analytics.missedPickups || 0);
      this.analytics.collectionEfficiencyPct = totalAttempted > 0
        ? Math.min(100, Math.round((this.analytics.totalCollectionsToday / totalAttempted) * 1000) / 10)
        : 100;

      // Notify resident that garbage was successfully collected!
      const notif = {
        id: `NOTIF-${Date.now()}-COLLECTED`,
        houseNo: req.houseNo,
        recipient: req.residentName,
        type: 'pickup_collected',
        title: 'Garbage Collected Successfully',
        message: `Your garbage has been collected successfully by Driver ${driverName}. Thank you for keeping your city clean!`,
        timestamp: new Date().toISOString(),
        read: false
      };
      this.notifications.unshift(notif);
    } else if (newStatus === 'Missed') {
      req.missedAt = new Date().toISOString();
      req.missedReason = driverName || 'Gate locked / No response';
      this.analytics.missedPickups = (this.analytics.missedPickups || 0) + 1;
      const totalAttempted = this.analytics.totalCollectionsToday + this.analytics.missedPickups;
      this.analytics.collectionEfficiencyPct = totalAttempted > 0
        ? Math.min(100, Math.round((this.analytics.totalCollectionsToday / totalAttempted) * 1000) / 10)
        : 90;

      const notif = {
        id: `NOTIF-${Date.now()}-MISSED`,
        houseNo: req.houseNo,
        recipient: req.residentName,
        type: 'pickup_missed',
        title: 'Pickup Inaccessible / Missed',
        message: `Driver reported missed collection for House #${req.houseNo}: Bins were inaccessible or gate was locked.`,
        timestamp: new Date().toISOString(),
        read: false
      };
      this.notifications.unshift(notif);
    }

    this.broadcast('pickup_status_updated', {
      request: req,
      pickupRequests: this.pickupRequests,
      analytics: this.analytics
    });

    return req;
  }

  /**
   * Driver profile switcher
   */
  switchDriver(vehicleId = 'GV-04', driverName = 'Ramesh Kumar', driverContact = '+91 98765 43210') {
    const vehicle = this.vehicles.find(v => v.id === vehicleId) || this.vehicles[0];
    if (vehicle) {
      vehicle.driverName = driverName;
      vehicle.driverContact = driverContact;
      this.broadcast('driver_switched', { vehicle });
    }
    return vehicle;
  }

  /**
   * Driver reports an emergency or road issue
   */
  reportEmergency(report) {
    const id = `EMERG-${Date.now().toString().slice(-4)}`;
    const record = {
      id,
      vehicleId: report.vehicleId || 'GV-04',
      type: report.type || 'Traffic Jam / Road Blocked',
      message: report.message || 'Encountered unexpected delay.',
      locality: this.vehicles[0].currentLocality,
      reportedAt: new Date().toISOString()
    };

    this.emergencyReports.unshift(record);

    const notif = {
      id: `NOTIF-${Date.now()}-EMERG`,
      houseNo: 'ALL',
      recipient: 'All Residents',
      type: 'emergency_alert',
      title: `Driver Alert: ${record.type}`,
      message: `Vehicle ${record.vehicleId} reported: ${record.message}. Expected delay ~10-15 mins.`,
      timestamp: record.reportedAt,
      read: false
    };
    this.notifications.unshift(notif);

    this.broadcast('emergency_reported', {
      report: record,
      emergencyReports: this.emergencyReports
    });

    return record;
  }

  /**
   * Returns complete snapshot of the system state
   */
  getState() {
    this.recalculateDistances();
    return {
      vehicles: this.vehicles,
      houses: this.houses,
      pickupRequests: this.pickupRequests,
      notifications: this.notifications,
      analytics: this.analytics,
      emergencyReports: this.emergencyReports,
      simulation: {
        isRunning: this.simulation.isRunning,
        currentIndex: this.simulation.currentIndex,
        speedMultiplier: this.simulation.speedMultiplier,
        totalWaypoints: this.simulation.route.length,
        routeWaypoints: this.simulation.route,
        routeProgress: calculateRouteProgress(this.simulation.currentIndex, this.simulation.route.length)
      }
    };
  }
}

// Export singleton instance
module.exports = new DataStore();
