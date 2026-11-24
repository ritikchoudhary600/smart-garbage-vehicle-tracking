/**
 * supabaseRls.test.js — checks the database rules through Supabase's real APIs
 * (Auth + PostgREST + RPC): roles, row-level security, the geofence and each
 * household's alert distance, pickups, settings, the last-admin guard and the
 * audit log.
 *
 * Runs only against a LOCAL Supabase stack because it creates and deletes
 * users. Start one with `npm run db:start`, then:
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<ANON_KEY from `npx supabase status`> \
 *   SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from `npx supabase status`> \
 *   npm run test:supabase
 *
 * No dependencies: Node 18+ fetch only.
 */
'use strict';

const BASE = (process.env.SUPABASE_URL || 'http://127.0.0.1:54321').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: this test creates and deletes users. Use the local stack.`);
  process.exit(2);
}
if (!ANON || !SERVICE) {
  console.error('Set SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (from `npx supabase status`).');
  process.exit(2);
}

/* ── Tiny HTTP + assertion helpers ───────────────────────────────────── */
async function call(method, path, { token, key = ANON, body, prefer = 'return=representation' } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token || key}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, ok: res.ok, data };
}
const rpc = (fn, token, body = {}) => call('POST', `/rest/v1/rpc/${fn}`, { token, body });
const get = (path, token) => call('GET', `/rest/v1/${path}`, { token });
const patch = (path, token, body) => call('PATCH', `/rest/v1/${path}`, { token, body });
const service = (method, path, body) => call(method, path, { key: SERVICE, body });

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}
const errMsg = (r) => (r.data && (r.data.message || r.data.msg || r.data.error_description)) || '';

/* ── Users ───────────────────────────────────────────────────────────── */
const RUN = Date.now().toString(36);
const created = [];
async function createUser(label, fullName) {
  const email = `${label}-${RUN}@test.local`;
  const password = `pw-${RUN}-${Math.random().toString(36).slice(2)}`;
  const r = await service('POST', '/auth/v1/admin/users', {
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (!r.ok) throw new Error(`create ${label}: ${JSON.stringify(r.data)}`);
  created.push(r.data.id);
  const s = await call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
  if (!s.ok) throw new Error(`sign in ${label}: ${JSON.stringify(s.data)}`);
  return { id: r.data.id, email, token: s.data.access_token };
}

// Positions: a test house far from the seeded Ward 4 houses
const HOUSE = { lat: 12.9500, lon: 77.6500 };
const NEAR  = { lat: 12.9509, lon: 77.6500 };   // ~100 m
const MID   = { lat: 12.9581, lon: 77.6500 };   // ~900 m
const FAR   = { lat: 12.9600, lon: 77.6500 };   // ~1.1 km
const FAR2  = { lat: 12.9680, lon: 77.6500 };   // ~2 km
const ROUTE_START = { lat: 12.934602, lon: 77.620047 };
const HOUSE_NO = `T${RUN.slice(-6)}`;

async function main() {
  console.log(`\nSupabase rules test against ${BASE}\n`);

  // ── Sign-up creates profiles ────────────────────────────────────────
  console.log('Profiles and roles');
  const admin = await createUser('admin', 'Test Admin');
  const resident = await createUser('resident', 'Test Resident');
  const other = await createUser('other', 'Other Resident');
  const driver = await createUser('driver', 'Test Driver');

  const promoted = await service('PATCH', `/rest/v1/profiles?id=eq.${admin.id}`, { role: 'admin' });
  check('service role (SQL editor path) can promote the first admin', promoted.ok && promoted.data[0].role === 'admin', promoted.data);

  const me = await rpc('me', resident.token);
  check('new Google-style sign-up becomes an active resident', me.ok && me.data.role === 'resident' && me.data.status === 'active', me.data);
  check('profile takes the name from sign-in metadata', me.data && me.data.full_name === 'Test Resident', me.data);
  check('me() records last activity', me.data && me.data.last_seen_at, me.data);

  const anon = await get('households?select=id');
  check('signed-out visitors cannot read households', !anon.ok || (Array.isArray(anon.data) && anon.data.length === 0), anon);

  const escalate = await patch(`profiles?id=eq.${resident.id}`, resident.token, { role: 'admin' });
  const after = await rpc('me', resident.token);
  check('a resident cannot make themselves admin', after.data.role === 'resident', { escalate, after: after.data });

  const peek = await get('profiles?select=id', resident.token);
  check('residents only see their own profile', peek.ok && peek.data.length === 1 && peek.data[0].id === resident.id, peek.data);

  const everyone = await get('profiles?select=id', admin.token);
  check('admins see every profile', everyone.ok && everyone.data.length >= 4, everyone.data && everyone.data.length);

  // ── Households ──────────────────────────────────────────────────────
  console.log('\nHouseholds');
  let houses = await get('households?select=id', resident.token);
  check('a new resident sees no households', houses.ok && houses.data.length === 0, houses.data);

  const reg = await rpc('register_household', resident.token, {
    p_house_no: HOUSE_NO, p_resident_name: 'Test Resident', p_ward: 'Ward 4', p_address: 'Test street 1',
    p_landmark: 'Blue gate', p_phone: '', p_lat: HOUSE.lat, p_lon: HOUSE.lon,
  });
  check('a resident registers their own household', reg.ok && reg.data.owner_id === resident.id, reg.data);

  houses = await get('households?select=house_no', resident.token);
  check('...and then sees exactly that household', houses.ok && houses.data.length === 1 && houses.data[0].house_no === HOUSE_NO, houses.data);

  const steal = await rpc('register_household', other.token, {
    p_house_no: HOUSE_NO, p_resident_name: 'Intruder', p_ward: 'Ward 4', p_address: 'x', p_lat: 1, p_lon: 1,
  });
  check('another resident cannot take over a registered house number', !steal.ok && /already registered/.test(errMsg(steal)), steal.data);

  const seeded = await rpc('register_household', resident.token, {
    p_house_no: '125', p_resident_name: 'Intruder', p_ward: 'Ward 4', p_address: 'x', p_lat: 1, p_lon: 1,
  });
  check('a resident cannot claim a seeded house', !seeded.ok, seeded.data);

  const othersView = await get(`households?house_no=eq.${HOUSE_NO}&select=id`, other.token);
  check("residents cannot see each other's households", othersView.ok && othersView.data.length === 0, othersView.data);

  const ready = await rpc('set_garbage_ready', other.token, { p_house_no: HOUSE_NO, p_ready: true });
  check("residents cannot mark someone else's bins ready", !ready.ok, ready.data);

  const ownReady = await rpc('set_garbage_ready', resident.token, { p_house_no: HOUSE_NO, p_ready: true });
  check('residents mark their own bins ready', ownReady.ok && ownReady.data.garbage_ready === true, ownReady.data);

  const directEdit = await patch(`households?house_no=eq.${HOUSE_NO}`, resident.token, { resident_name: 'Hacked' });
  check('residents cannot edit household rows directly (only through checked functions)',
    !directEdit.ok || directEdit.data.length === 0, directEdit.data);

  // ── Pickups ─────────────────────────────────────────────────────────
  console.log('\nPickup requests');
  const pickup = await rpc('create_pickup_request', resident.token, {
    p_house_no: HOUSE_NO, p_note: 'Two bags by the gate', p_waste_type: 'Dry Recyclables',
  });
  check('a resident requests a pickup for their household', pickup.ok && /^REQ-/.test(pickup.data.id), pickup.data);
  const pickupId = pickup.data && pickup.data.id;

  const forged = await rpc('create_pickup_request', other.token, { p_house_no: HOUSE_NO, p_note: 'x' });
  check("residents cannot request pickups for someone else's house", !forged.ok, forged.data);

  const hidden = await get(`pickup_requests?id=eq.${pickupId}&select=id`, other.token);
  check("residents cannot see each other's pickups", hidden.ok && hidden.data.length === 0, hidden.data);

  const selfCollect = await rpc('set_pickup_status', resident.token, { p_request_id: pickupId, p_status: 'Collected' });
  check('residents cannot mark pickups as collected', !selfCollect.ok, selfCollect.data);

  // ── Drivers and the geofence ────────────────────────────────────────
  console.log('\nDrivers, vehicles and the geofence');
  const notDriver = await patch('vehicles?id=eq.GV-04', admin.token, { driver_id: resident.id });
  check('only people with the driver role can be assigned a vehicle', !notDriver.ok && /driver role/.test(errMsg(notDriver)), notDriver.data);

  const makeDriver = await patch(`profiles?id=eq.${driver.id}`, admin.token, { role: 'driver' });
  check('an admin makes someone a driver', makeDriver.ok && makeDriver.data[0].role === 'driver', makeDriver.data);

  const unassigned = await rpc('report_vehicle_position', driver.token, { p_vehicle_id: 'GV-04', p_lat: NEAR.lat, p_lon: NEAR.lon });
  check('an unassigned driver cannot move a vehicle', !unassigned.ok, unassigned.data);

  const assign = await patch('vehicles?id=eq.GV-04', admin.token, { driver_id: driver.id });
  check('an admin assigns the driver to GV-04 (name copied over)', assign.ok && assign.data[0].driver_name === 'Test Driver', assign.data);

  await rpc('report_vehicle_position', driver.token, { p_vehicle_id: 'GV-04', p_lat: FAR.lat, p_lon: FAR.lon });
  const enter = await rpc('report_vehicle_position', driver.token, { p_vehicle_id: 'GV-04', p_lat: NEAR.lat, p_lon: NEAR.lon, p_speed_kmh: 18 });
  check('entering the radius raises one geofence alert', enter.ok && enter.data.alerts === 1, enter.data);

  const alerts = () => get(`notifications?house_no=eq.${HOUSE_NO}&type=eq.geofence_alert&select=id,title,message&order=created_at.desc,id.desc`, resident.token);
  const drive = (pos) => rpc('report_vehicle_position', driver.token, { p_vehicle_id: 'GV-04', p_lat: pos.lat, p_lon: pos.lon });
  let a = await alerts();
  check('the resident sees their alert, with the distance', a.ok && a.data.length === 1 && /approximately 100 m away/.test(a.data[0].message), a.data);

  await rpc('report_vehicle_position', driver.token, { p_vehicle_id: 'GV-04', p_lat: NEAR.lat + 0.0001, p_lon: NEAR.lon });
  a = await alerts();
  check('GPS jitter inside the zone does not repeat the alert', a.data.length === 1, a.data);

  await rpc('report_vehicle_position', driver.token, { p_vehicle_id: 'GV-04', p_lat: FAR.lat, p_lon: FAR.lon });
  await rpc('report_vehicle_position', driver.token, { p_vehicle_id: 'GV-04', p_lat: NEAR.lat, p_lon: NEAR.lon });
  a = await alerts();
  check('leaving beyond the re-arm distance and returning alerts again', a.data.length === 2, a.data);

  const otherAlerts = await get(`notifications?house_no=eq.${HOUSE_NO}&select=id`, other.token);
  check("residents do not see other households' alerts", otherAlerts.ok && otherAlerts.data.length === 0, otherAlerts.data);

  // ── Each household's own alert distance ────────────────────────────
  console.log('\nCustom alert distance');
  const setOwn = await rpc('set_alert_radius', resident.token, { p_house_no: HOUSE_NO, p_radius_m: 1000 });
  check('a resident sets their own alert distance', setOwn.ok && setOwn.data.alert_radius_m === 1000, setOwn.data);
  const tooFar = await rpc('set_alert_radius', resident.token, { p_house_no: HOUSE_NO, p_radius_m: 3000 });
  check('distances outside the range admins allow are refused', !tooFar.ok && /between 100 and 2000/.test(errMsg(tooFar)), tooFar.data);
  const notMine = await rpc('set_alert_radius', other.token, { p_house_no: HOUSE_NO, p_radius_m: 200 });
  check("residents cannot change someone else's alert distance", !notMine.ok, notMine.data);

  await drive(FAR2);
  let before = (await alerts()).data.length;
  await drive(MID);
  a = await alerts();
  check('the alert comes at the chosen distance (900 m away with 1 km chosen)',
    a.data.length === before + 1 && /approximately 90\d m/.test(a.data[0].message) && /1000 m/.test(a.data[0].title), a.data[0]);

  await drive(FAR2);
  const narrow = await patch('app_settings?id=eq.true', admin.token, { alert_radius_max_m: 800 });
  before = (await alerts()).data.length;
  await drive(MID);
  a = await alerts();
  check('narrowing the allowed range applies at once (capped at 800 m: no alert at 900 m)', narrow.ok && a.data.length === before, { narrow: narrow.data, count: a.data.length, before });
  await patch('app_settings?id=eq.true', admin.token, { alert_radius_max_m: 2000 });

  const backToDefault = await rpc('set_alert_radius', resident.token, { p_house_no: HOUSE_NO, p_radius_m: null });
  check('a resident can go back to the ward default', backToDefault.ok && backToDefault.data.alert_radius_m === null, backToDefault.data);

  const residentMoves = await rpc('report_vehicle_position', resident.token, { p_vehicle_id: 'GV-04', p_lat: 1, p_lon: 1 });
  check('residents cannot move vehicles', !residentMoves.ok, residentMoves.data);

  const accept = await rpc('set_pickup_status', driver.token, { p_request_id: pickupId, p_status: 'Accepted' });
  const collect = await rpc('set_pickup_status', driver.token, { p_request_id: pickupId, p_status: 'Collected' });
  check('the driver accepts and collects the pickup', accept.ok && collect.ok && collect.data.status === 'Collected' && collect.data.assigned_driver === 'Test Driver', collect.data);
  const again = await rpc('set_pickup_status', driver.token, { p_request_id: pickupId, p_status: 'Missed' });
  check('a closed pickup cannot be changed again', !again.ok, again.data);
  const binsAfter = await get(`households?house_no=eq.${HOUSE_NO}&select=garbage_ready`, resident.token);
  check('collecting clears the bins-ready flag', binsAfter.data[0].garbage_ready === false, binsAfter.data);

  const issue = await rpc('report_issue', driver.token, { p_vehicle_id: 'GV-04', p_type: 'Traffic', p_message: `Test delay ${RUN}` });
  check('the driver broadcasts a delay notice', issue.ok && /^ER-/.test(issue.data.id), issue.data);
  const ward = await get(`notifications?house_no=eq.ALL&type=eq.emergency_alert&message=like.*${RUN}*&select=id`, other.token);
  check('every resident sees ward-wide delay notices', ward.ok && ward.data.length === 1, ward.data);

  // ── Analytics, settings, pending and suspended accounts ────────────
  console.log('\nSettings, approval and suspension');
  const stats = await rpc('get_analytics', resident.token);
  check('members can read the dashboard numbers', stats.ok && typeof stats.data.announcementsAvoided === 'number', stats.data);

  const residentSettings = await patch('app_settings?id=eq.true', resident.token, { geofence_radius_m: 900 });
  check('residents cannot change settings', !residentSettings.ok || residentSettings.data.length === 0, residentSettings.data);

  const badRadius = await patch('app_settings?id=eq.true', admin.token, { geofence_radius_m: 3000 });
  check('the default alert distance must sit inside the allowed range', !badRadius.ok, badRadius.data);
  const badBuffer = await patch('app_settings?id=eq.true', admin.token, { rearm_buffer_m: 5 });
  check('the re-arm buffer cannot be too small to absorb GPS jitter', !badBuffer.ok, badBuffer.data);
  const range = await patch('app_settings?id=eq.true', admin.token, { alert_radius_min_m: 150, alert_radius_max_m: 2500, rearm_buffer_m: 80 });
  check('admins change the range residents choose from and the re-arm buffer',
    range.ok && range.data[0].alert_radius_min_m === 150 && range.data[0].alert_radius_max_m === 2500 && range.data[0].rearm_buffer_m === 80, range.data);
  const adminSets = await patch(`households?house_no=eq.${HOUSE_NO}`, admin.token, { alert_radius_m: 750 });
  check("admins set a household's alert distance from the Control room", adminSets.ok && adminSets.data[0].alert_radius_m === 750, adminSets.data);
  await patch('app_settings?id=eq.true', admin.token, { alert_radius_min_m: 100, alert_radius_max_m: 2000, rearm_buffer_m: 50 });

  const badTz = await patch('app_settings?id=eq.true', admin.token, { timezone: 'Mars/Olympus' });
  check('unknown time zones are rejected', !badTz.ok, badTz.data);

  const manual = await patch('app_settings?id=eq.true', admin.token, { auto_approve_residents: false });
  check('an admin switches new sign-ins to "wait for approval"', manual.ok && manual.data[0].auto_approve_residents === false, manual.data);
  const newcomer = await createUser('newcomer', 'New Person');
  const pendingMe = await rpc('me', newcomer.token);
  check('the next sign-up waits for approval', pendingMe.data.role === 'pending', pendingMe.data);
  const pendingVehicles = await get('vehicles?select=id', newcomer.token);
  check('pending accounts see no data', pendingVehicles.ok && pendingVehicles.data.length === 0, pendingVehicles.data);
  const pendingStats = await rpc('get_analytics', newcomer.token);
  check('pending accounts cannot read analytics', !pendingStats.ok, pendingStats.data);
  await patch('app_settings?id=eq.true', admin.token, { auto_approve_residents: true });

  const suspend = await patch(`profiles?id=eq.${other.id}`, admin.token, { status: 'suspended' });
  check('an admin suspends an account', suspend.ok && suspend.data[0].status === 'suspended', suspend.data);
  const suspendedView = await get('vehicles?select=id', other.token);
  check('suspended accounts see nothing', suspendedView.ok && suspendedView.data.length === 0, suspendedView.data);

  // ── Admin guard rails and the audit log ─────────────────────────────
  console.log('\nGuard rails and audit log');
  const admins = await get('profiles?role=eq.admin&status=eq.active&select=id', admin.token);
  if (admins.data.length === 1) {
    const demote = await patch(`profiles?id=eq.${admin.id}`, admin.token, { role: 'resident' });
    check('the last active admin cannot demote themselves', !demote.ok && /At least one active admin/.test(errMsg(demote)), demote.data);
  } else {
    console.log('  - skipped last-admin check (other admins exist)');
  }

  const offDuty = await patch(`profiles?id=eq.${driver.id}`, admin.token, { role: 'resident' });
  const gv04 = await get('vehicles?id=eq.GV-04&select=driver_id', admin.token);
  check('changing a driver to another role takes them off their vehicle', offDuty.ok && gv04.data[0].driver_id === null, gv04.data);

  const truck = await call('POST', '/rest/v1/vehicles', { token: admin.token, body: { id: `T-${RUN.slice(-6).toUpperCase()}`, plate_number: 'TEST-1', status: 'maintenance' } });
  check('admins add vehicles', truck.ok, truck.data);
  const residentTruck = await call('POST', '/rest/v1/vehicles', { token: resident.token, body: { id: 'X-1', plate_number: 'X' } });
  check('residents cannot add vehicles', !residentTruck.ok, residentTruck.data);

  const log = await get(`audit_log?actor_email=eq.${encodeURIComponent(admin.email)}&select=table_name,action,changes`, admin.token);
  const roleChange = log.data.find(e => e.table_name === 'profiles' && e.changes.role && e.changes.role.to === 'driver');
  check('the audit log records who changed a role, from and to', !!roleChange && roleChange.changes.role.from === 'resident', log.data);
  check('vehicle movements are not written to the audit log',
    !log.data.some(e => e.table_name === 'vehicles' && e.changes.lat), log.data.filter(e => e.table_name === 'vehicles'));
  const residentLog = await get('audit_log?select=id', resident.token);
  check('non-admins cannot read the audit log', residentLog.ok && residentLog.data.length === 0, residentLog.data);
}

async function cleanup() {
  // Put GV-04 back where the demo expects it, then remove everything this run created
  await service('PATCH', '/rest/v1/vehicles?id=eq.GV-04', {
    driver_id: null, driver_name: 'Ramesh Kumar', driver_phone: '+91 98765 43210',
    lat: ROUTE_START.lat, lon: ROUTE_START.lon, route_index: 0, speed_kmh: 0, tracking_mode: 'simulator',
  });
  await service('PATCH', '/rest/v1/households?is_in_geofence=eq.true', { is_in_geofence: false });
  await service('PATCH', '/rest/v1/app_settings?id=eq.true', {
    auto_approve_residents: true, geofence_radius_m: 500, rearm_buffer_m: 50, alert_radius_min_m: 100, alert_radius_max_m: 2000,
  });
  await service('DELETE', `/rest/v1/vehicles?id=eq.T-${RUN.slice(-6).toUpperCase()}`);
  await service('DELETE', `/rest/v1/notifications?house_no=eq.${HOUSE_NO}`);
  await service('DELETE', `/rest/v1/notifications?message=like.*${RUN}*`);
  await service('DELETE', `/rest/v1/emergency_reports?message=like.*${RUN}*`);
  await service('DELETE', `/rest/v1/households?house_no=eq.${HOUSE_NO}`);
  for (const id of created) await service('DELETE', `/auth/v1/admin/users/${id}`);
}

main()
  .catch(err => { failed++; console.error('\nTest run crashed:', err); })
  .finally(async () => {
    try { await cleanup(); } catch (e) { console.error('Cleanup failed:', e.message); }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
