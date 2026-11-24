-- =====================================================================
-- Demo data: the Ward 4 households, truck GV-04 and two pickup requests
-- the browser demo starts with. `supabase db reset` loads it locally.
-- On a hosted project, paste it into the SQL editor once if you want
-- the demo data there too (it is safe to skip for a real deployment).
-- =====================================================================

update public.app_settings
   set ward_name = 'Ward 4',
       baseline_announcements = 138,
       baseline_collections   = 19,
       baseline_missed        = 1
 where id;

insert into public.vehicles (id, plate_number, capacity, status, driver_name, driver_phone, lat, lon, bearing, route_index)
values
  ('GV-04', 'KA-05-GV-2024', '2 tonnes', 'active',      'Ramesh Kumar', '+91 98765 43210', 12.934602, 77.620047, 45, 0),
  ('GV-07', 'KA-05-GV-2031', '3 tonnes', 'maintenance', '',             '',                null,      null,      0,  0)
on conflict (id) do nothing;

insert into public.households (house_no, resident_name, ward, address, landmark, phone, lat, lon, garbage_ready)
values
  ('125', 'Priya Sharma',  'Ward 4', 'House No. 125, 3rd Cross, Green Glen Sector', 'Opposite Palm Park',          '+91 98112 34567', 12.94180, 77.62950, false),
  ('102', 'Anand Verma',   'Ward 4', 'House No. 102, 2nd Cross, Green Glen Sector', 'Near Community Water Kiosk',  '+91 98223 45678', 12.93931, 77.63051, true),
  ('144', 'Sneha Patel',   'Ward 4', 'House No. 144, 4th Cross, Sunshine Crossway', 'Beside Lotus Bakery',         '+91 98334 56789', 12.94310, 77.63120, false),
  ('88',  'Karthik Menon', 'Ward 4', 'House No. 88, 1st Cross, Palm Avenue',        'Opposite Green Nursery',      '+91 98445 67890', 12.93627, 77.62593, false)
on conflict (house_no) do nothing;

insert into public.pickup_requests (id, household_id, house_no, resident_name, ward, address, landmark, note,
                                    waste_type, status, lat, lon, created_at, accepted_at, updated_at, assigned_driver)
select 'REQ-125', h.id, h.house_no, h.resident_name, h.ward, h.address, 'Black iron gate, left porch',
       'Not at home today. Please collect the 2 segregated bags placed beside the gate.',
       'Segregated (Wet & Dry)', 'Pending'::public.pickup_status, h.lat, h.lon,
       now() - interval '35 minutes', null::timestamptz, now() - interval '35 minutes', null::text
  from public.households h where h.house_no = '125'
union all
select 'REQ-088', h.id, h.house_no, h.resident_name, h.ward, h.address, 'Near front garage door',
       'Away on business trip. Box of cardboard packaging kept outside.',
       'Dry Recyclables', 'Accepted'::public.pickup_status, h.lat, h.lon,
       now() - interval '55 minutes', now() - interval '10 minutes', now() - interval '10 minutes', 'Ramesh Kumar'
  from public.households h where h.house_no = '88'
on conflict (id) do nothing;

insert into public.notifications (house_no, type, title, message, created_at)
values ('ALL', 'system_info', 'Route commenced',
        'Garbage collection vehicle GV-04 has started its morning route in Ward 4.',
        now() - interval '40 minutes');

-- Start the audit trail clean; seeding is not a user action
truncate public.audit_log;
