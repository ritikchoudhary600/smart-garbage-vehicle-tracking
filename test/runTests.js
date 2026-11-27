/**
 * runTests.js - Verification and Test Suite for Smart Garbage Vehicle Tracking System
 */

const assert = require('node:assert');
const {
  calculateHaversineDistance,
  calculateBearing,
  getBearingOctant,
  detectLocality,
  calculateETA
} = require('../server/geoUtils');
const dataStore = require('../server/dataStore');
const simulatorEngine = require('../server/simulatorEngine');

console.log('🧪 Starting Automated Test Suite for Smart Garbage Vehicle System...\n');

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
  }
}

// 1. Haversine Distance Tests
test('Haversine distance returns accurate distance in meters', () => {
  // Lat/Lon from waypoint 0 to House 125
  const dist = calculateHaversineDistance(12.93350, 77.62250, 12.94180, 77.62950);
  assert.ok(dist > 1100 && dist < 1300, `Expected distance ~1200m, got ${dist}`);
});

test('Haversine distance between identical points is zero', () => {
  const dist = calculateHaversineDistance(12.94180, 77.62950, 12.94180, 77.62950);
  assert.strictEqual(dist, 0);
});

// 2. Bearing and Direction Detection Tests
test('Bearing calculation correctly identifies Northeast direction', () => {
  const bearing = calculateBearing(12.93500, 77.62400, 12.94180, 77.62950);
  assert.ok(bearing >= 22.5 && bearing < 67.5, `Expected NE bearing [22.5, 67.5], got ${bearing}`);
  const octant = getBearingOctant(bearing);
  assert.strictEqual(octant.code, 'NE');
  assert.strictEqual(octant.arrow, '↗');
});

test('Bearing octants map all 8 cardinal & ordinal directions accurately', () => {
  assert.strictEqual(getBearingOctant(0).code, 'N');
  assert.strictEqual(getBearingOctant(45).code, 'NE');
  assert.strictEqual(getBearingOctant(90).code, 'E');
  assert.strictEqual(getBearingOctant(135).code, 'SE');
  assert.strictEqual(getBearingOctant(180).code, 'S');
  assert.strictEqual(getBearingOctant(225).code, 'SW');
  assert.strictEqual(getBearingOctant(270).code, 'W');
  assert.strictEqual(getBearingOctant(315).code, 'NW');
});

// 3. Locality Detection Tests
test('Locality detection identifies Green Glen Residential Sector', () => {
  const locality = detectLocality(12.94180, 77.62950);
  assert.strictEqual(locality, 'Ward 4 - Green Glen Residential Sector');
});

// 4. Geofencing 500m Logic & Debouncing Tests
test('500-metre geofencing triggers alert only when distance <= 500m', () => {
  // Reset vehicle to start (~1.2 km away)
  simulatorEngine.reset();
  const house125 = dataStore.houses.find(h => h.houseNo === '125');
  assert.strictEqual(house125.isInGeofence, false, 'House 125 should initially be outside geofence');

  // Move vehicle to waypoint 5 (~480m from House 125)
  simulatorEngine.teleport(5);
  assert.strictEqual(house125.isInGeofence, true, 'House 125 should be inside 500m geofence at waypoint 5');
  assert.ok(house125.distanceMeters <= 500, `Distance should be <= 500m, got ${house125.distanceMeters}`);

  // Test debounce: vehicle moves closer to waypoint 6 (~180m)
  const notifsBefore = dataStore.notifications.filter(n => n.houseNo === '125').length;
  simulatorEngine.teleport(6);
  assert.strictEqual(house125.isInGeofence, true, 'House 125 remains inside geofence');
  const notifsAfter = dataStore.notifications.filter(n => n.houseNo === '125').length;
  assert.strictEqual(
    notifsAfter,
    notifsBefore,
    'Debounce must prevent duplicate notification for House 125 while remaining inside 500m'
  );
});

// 5. Away-From-Home Pickup Request Workflow Tests
test('Resident can create away-from-home pickup request and driver can collect it', () => {
  const req = dataStore.createPickupRequest({
    houseNo: '125',
    residentName: 'Priya Sharma',
    ward: 'Ward 4',
    landmark: 'Behind Blue Gate',
    note: 'Please collect segregated bins',
    wasteType: 'Segregated (Wet & Dry)'
  });

  assert.ok(req.id, 'Request must have an ID');
  assert.strictEqual(req.status, 'Pending');

  // Driver marks as collected
  const collected = dataStore.updatePickupStatus(req.id, 'Collected', 'Ramesh Kumar');
  assert.strictEqual(collected.status, 'Collected');
  assert.strictEqual(collected.collectedBy, 'Ramesh Kumar');
  assert.ok(collected.collectedAt);
});

// 6. Garbage Ready Status Toggle Tests
test('Resident can mark garbage ready outside gate', () => {
  dataStore.setGarbageReady('125', true);
  const house125 = dataStore.houses.find(h => h.houseNo === '125');
  assert.strictEqual(house125.garbageReady, true);

  dataStore.setGarbageReady('125', false);
  assert.strictEqual(house125.garbageReady, false);
});

// 7. Simulation Playback Controls Tests
test('Simulation playback advances waypoints correctly', () => {
  simulatorEngine.reset();
  assert.strictEqual(simulatorEngine.currentIndex, 0);

  simulatorEngine.stepForward();
  assert.strictEqual(simulatorEngine.currentIndex, 1);

  simulatorEngine.stepBackward();
  assert.strictEqual(simulatorEngine.currentIndex, 0);
});

// 8. Household Registration and Profile Update Tests
test('Resident can register a new household or update profile', () => {
  const registered = dataStore.registerOrUpdateHouse({
    houseNo: '201',
    residentName: 'Vikram Mehta',
    ward: 'Ward 4',
    address: 'House No. 201, 5th Main, Green Glen',
    landmark: 'Beside Mango Grove',
    contact: '+91 98999 11223',
    lat: 12.94200,
    lon: 77.63000
  });

  assert.strictEqual(registered.houseNo, '201');
  assert.strictEqual(registered.residentName, 'Vikram Mehta');
  const found = dataStore.houses.find(h => h.houseNo === '201');
  assert.ok(found, 'New house should be present in dataStore.houses');

  // Test profile update
  const updated = dataStore.registerOrUpdateHouse({
    houseNo: '201',
    residentName: 'Vikram & Meera Mehta'
  });
  assert.strictEqual(updated.residentName, 'Vikram & Meera Mehta');
});

// 9. Pickup Request Multi-State Workflow (Accepted, Collected, Missed)
test('Pickup request supports Accepted and Missed status flows', () => {
  const req1 = dataStore.createPickupRequest({
    houseNo: '102',
    residentName: 'Anand Verma',
    ward: 'Ward 4',
    note: 'Bins outside gate'
  });

  // Accept request
  const accepted = dataStore.updatePickupStatus(req1.id, 'Accepted', 'Ramesh Kumar');
  assert.strictEqual(accepted.status, 'Accepted');
  assert.ok(accepted.acceptedAt);

  // Mark missed request
  const req2 = dataStore.createPickupRequest({
    houseNo: '144',
    residentName: 'Sneha Patel',
    ward: 'Ward 4',
    note: 'Cardboard box outside'
  });
  const missed = dataStore.updatePickupStatus(req2.id, 'Missed', 'Gate locked');
  assert.strictEqual(missed.status, 'Missed');
  assert.strictEqual(missed.missedReason, 'Gate locked');
  assert.ok(dataStore.analytics.missedPickups > 0);
});

// 10. Driver Switching Tests
test('Driver profile can be switched on active vehicle', () => {
  const switched = dataStore.switchDriver('GV-04', 'Sunita Rao', '+91 98111 22334');
  assert.strictEqual(switched.driverName, 'Sunita Rao');
  assert.strictEqual(switched.driverContact, '+91 98111 22334');

  // Reset back to Ramesh Kumar
  dataStore.switchDriver('GV-04', 'Ramesh Kumar', '+91 98765 43210');
  assert.strictEqual(dataStore.vehicles[0].driverName, 'Ramesh Kumar');
});

// 11. Route Progress & Coordinates Teleportation Tests
test('Simulator can teleport by coordinates and calculates route progress', () => {
  const customPos = simulatorEngine.teleport({ lat: 12.94000, lon: 77.62800 });
  assert.strictEqual(customPos.lat, 12.94000);
  assert.strictEqual(customPos.lon, 77.62800);
  assert.strictEqual(dataStore.vehicles[0].lat, 12.94000);

  const { calculateRouteProgress } = require('../server/geoUtils');
  const prog = calculateRouteProgress(7, 14);
  assert.strictEqual(prog.percent, 54);
  assert.strictEqual(prog.formatted, '54%');
});

// 12. Browser Geofence 500m Zone States, Exact Alert Text & Reset Tests
test('Browser geofence transitions Outside Zone -> Approaching -> Alert Triggered -> Vehicle Passed and resets on exit', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');

  const events = [];
  const sandbox = {
    window: {
      dispatchEvent: (ev) => events.push(ev),
    },
    CustomEvent: function (type, opts) { return { type, detail: opts && opts.detail }; },
    Date, Math, Number, String, Boolean, Array, Object, Set, Map, JSON, console,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);

  for (const f of ['public/js/geoUtils.js', 'public/js/routeData.js', 'public/js/dataStore.js', 'public/js/simulatorEngine.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  }

  const store = sandbox.window.AppDataStore;
  const sim = sandbox.window.AppSimulatorEngine;
  const { computeZoneStatus } = sandbox.window.GeoUtils;
  const h125 = () => store.houses.find(h => h.houseNo === '125');

  // WP 0 (~1300m): Outside Zone
  sim.reset();
  assert.strictEqual(computeZoneStatus(h125(), store.settings).label, 'Outside Zone');

  // WP 3 (~720m): Approaching
  sim.teleport(3);
  assert.strictEqual(computeZoneStatus(h125(), store.settings).label, 'Approaching');

  // WP 5 (~480m <= 500m): Alert Triggered + exact notification text
  events.length = 0;
  sim.teleport(5);
  assert.strictEqual(h125().isInGeofence, true);
  assert.strictEqual(computeZoneStatus(h125(), store.settings).label, 'Alert Triggered');
  const alertEv = events.find(e => e.type === 'geofence_alert' && e.detail.houseNo === '125');
  assert.ok(alertEv, 'Expected geofence_alert event for House 125 at WP 5');
  assert.strictEqual(
    alertEv.detail.message,
    'Garbage collection vehicle is approximately 500 metres away. Please keep your garbage ready.'
  );

  // WP 6 (~320m): stays inside -> no duplicate alert
  events.length = 0;
  sim.teleport(6);
  assert.strictEqual(computeZoneStatus(h125(), store.settings).label, 'Alert Triggered');
  assert.strictEqual(
    events.filter(e => e.type === 'geofence_alert' && e.detail.houseNo === '125').length,
    0,
    'Must not re-alert while vehicle remains inside 500m circle'
  );

  // WP 8 (at gate ~0m) -> WP 9 (moving away ~466m): Vehicle Passed
  sim.teleport(8);
  sim.teleport(9);
  assert.strictEqual(computeZoneStatus(h125(), store.settings).label, 'Vehicle Passed');

  // Leave zone (> 550m, WP 0 ~1300m) -> resets alert latch; re-entry at WP 5 triggers again
  sim.teleport(0);
  assert.strictEqual(h125().isInGeofence, false, 'Alert latch must reset after vehicle leaves the 500m zone');
  events.length = 0;
  sim.teleport(5);
  assert.strictEqual(
    events.filter(e => e.type === 'geofence_alert' && e.detail.houseNo === '125').length,
    1,
    'Future approach into 500m zone must trigger notification again'
  );
});

// 13. Admin Login & Protected Route Static Guards
test('Frontend auth blocks demo/resident/driver from Admin Dashboard and exposes no plain-text passwords', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const authCode = fs.readFileSync(path.join(__dirname, '..', 'public/js/auth.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  const htmlCode = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');

  // Demo profile must not have role: 'admin'
  assert.ok(!/launchDemo[\s\S]*role:\s*['"]admin['"]/.test(authCode), 'Demo mode must not launch with admin role');
  assert.ok(/signInWithPassword/.test(authCode), 'Admin login must use Supabase Auth signInWithPassword');
  assert.ok(/profile\.role\s*!==\s*['"]admin['"]/.test(authCode), 'Admin login must verify admin role');
  assert.ok(/demo:\s*\[\s*['"]resident['"],\s*['"]driver['"],\s*['"]split['"]\s*\]/.test(appCode), 'Demo views must exclude admin & control');
  assert.ok(/id="admin-login-form"/.test(htmlCode) && /id="btn-toggle-admin-password"/.test(htmlCode), 'Admin login form and show/hide password toggle must exist');
  assert.ok(!/admin-signup|admin-register/i.test(htmlCode), 'Public admin registration must not exist');
});

console.log(`\n------------------------------------------------------------`);
console.log(`Test Results: ${passedTests} / ${totalTests} passed.`);
if (passedTests === totalTests) {
  console.log(`🎉 ALL TESTS PASSED SUCCESSFULLY!`);
  process.exit(0);
} else {
  console.error(`⚠️ Some tests failed.`);
  process.exit(1);
}
