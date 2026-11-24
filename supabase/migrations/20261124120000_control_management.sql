-- =====================================================================
-- Smart Garbage Vehicle Tracking: Supabase schema
--
-- Google sign-in profiles with roles, households, the fleet, pickup
-- requests, notifications, settings and an audit log. Every table is
-- behind row-level security; the web app only ever uses the publishable
-- (anon) key plus the signed-in user's JWT. Anything that changes more
-- than one row, or must not be forged by a client (geofence alerts,
-- pickup status, analytics), goes through the SECURITY DEFINER
-- functions at the bottom of this file.
--
-- Roles
--   pending   signed in, waiting for an admin to approve (no data access)
--   resident  sees and manages only their own household(s)
--   driver    drives their assigned vehicle, works the pickup queue
--   admin     everything, including the Control panel
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;   -- RLS policies call private.* helpers


-- ── Enums ────────────────────────────────────────────────────────────
create type public.app_role       as enum ('pending', 'resident', 'driver', 'admin');
create type public.account_status as enum ('active', 'suspended');
create type public.vehicle_status as enum ('active', 'maintenance', 'retired');
create type public.pickup_status  as enum ('Pending', 'Accepted', 'Collected', 'Missed');
create type public.tracking_mode  as enum ('simulator', 'live_gps');


-- ── Settings (exactly one row) ───────────────────────────────────────
create table public.app_settings (
  id                        boolean primary key default true check (id),
  ward_name                 text    not null default 'Ward 4' check (char_length(ward_name) between 1 and 60),
  timezone                  text    not null default 'Asia/Kolkata',
  geofence_radius_m         integer not null default 500 check (geofence_radius_m between 50 and 5000),
  geofence_exit_m           integer not null default 550 check (geofence_exit_m between 60 and 6000),
  auto_approve_residents    boolean not null default true,
  baseline_announcements    integer not null default 0 check (baseline_announcements >= 0),
  baseline_collections      integer not null default 0 check (baseline_collections >= 0),
  baseline_missed           integer not null default 0 check (baseline_missed >= 0),
  db_hours_per_announcement numeric(5,2) not null default 0.5 check (db_hours_per_announcement >= 0),
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  constraint app_settings_exit_beyond_radius check (geofence_exit_m > geofence_radius_m)
);
insert into public.app_settings (id) values (true);


-- ── People ───────────────────────────────────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null default '',
  full_name    text not null default '' check (char_length(full_name) <= 120),
  avatar_url   text,
  phone        text not null default '' check (char_length(phone) <= 30),
  role         public.app_role not null default 'pending',
  status       public.account_status not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz
);
create index profiles_role_idx on public.profiles (role);


-- ── Fleet ────────────────────────────────────────────────────────────
create table public.vehicles (
  id               text primary key check (id ~ '^[A-Za-z0-9-]{2,20}$'),
  plate_number     text not null check (char_length(plate_number) between 1 and 20),
  capacity         text not null default '' check (char_length(capacity) <= 30),
  status           public.vehicle_status not null default 'active',
  driver_id        uuid references public.profiles (id) on delete set null,
  driver_name      text not null default '' check (char_length(driver_name) <= 120),
  driver_phone     text not null default '' check (char_length(driver_phone) <= 30),
  lat              double precision check (lat between -90 and 90),
  lon              double precision check (lon between -180 and 180),
  speed_kmh        double precision not null default 0,
  bearing          double precision not null default 0,
  route_index      integer not null default 0,
  tracking_mode    public.tracking_mode not null default 'simulator',
  last_position_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- A driver is on duty in at most one vehicle
create unique index vehicles_driver_id_key on public.vehicles (driver_id) where driver_id is not null;


-- ── Households ───────────────────────────────────────────────────────
create table public.households (
  id             uuid primary key default gen_random_uuid(),
  house_no       text not null unique check (char_length(btrim(house_no)) between 1 and 20),
  resident_name  text not null check (char_length(resident_name) between 1 and 120),
  ward           text not null default '' check (char_length(ward) <= 80),
  address        text not null check (char_length(address) between 1 and 200),
  landmark       text not null default '' check (char_length(landmark) <= 120),
  phone          text not null default '' check (char_length(phone) <= 30),
  lat            double precision not null check (lat between -90 and 90),
  lon            double precision not null check (lon between -180 and 180),
  owner_id       uuid references public.profiles (id) on delete set null,
  garbage_ready  boolean not null default false,
  is_in_geofence boolean not null default false,
  notified_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index households_owner_id_idx on public.households (owner_id);


-- ── Away-from-home pickup requests ───────────────────────────────────
create sequence public.pickup_request_seq start 10001;
create table public.pickup_requests (
  id              text primary key default ('REQ-' || nextval('public.pickup_request_seq')),
  household_id    uuid references public.households (id) on delete cascade,
  house_no        text not null,
  resident_name   text not null,
  ward            text not null default '',
  address         text not null,
  landmark        text not null default '',
  note            text not null default '' check (char_length(note) <= 500),
  waste_type      text not null default 'Mixed Waste' check (char_length(waste_type) <= 60),
  status          public.pickup_status not null default 'Pending',
  lat             double precision not null,
  lon             double precision not null,
  created_by      uuid references public.profiles (id) on delete set null,
  assigned_driver text,
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  collected_at    timestamptz,
  missed_at       timestamptz,
  updated_at      timestamptz not null default now()
);
create index pickup_requests_household_idx on public.pickup_requests (household_id);
create index pickup_requests_status_idx on public.pickup_requests (status);


-- ── Notifications ('ALL' = every resident) ───────────────────────────
create table public.notifications (
  id         bigint generated always as identity primary key,
  house_no   text not null,
  type       text not null,
  title      text not null,
  message    text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index notifications_house_created_idx on public.notifications (house_no, created_at desc);


-- ── Driver issue / delay reports ─────────────────────────────────────
create sequence public.emergency_report_seq start 1001;
create table public.emergency_reports (
  id          text primary key default ('ER-' || nextval('public.emergency_report_seq')),
  vehicle_id  text references public.vehicles (id) on delete set null,
  driver_name text not null default '',
  type        text not null check (char_length(type) between 1 and 80),
  message     text not null check (char_length(message) between 1 and 500),
  locality    text not null default '',
  reported_by uuid references public.profiles (id) on delete set null,
  reported_at timestamptz not null default now()
);


-- ── Audit log (written only by triggers) ─────────────────────────────
create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid,
  actor_email  text not null default 'system',
  action       text not null,              -- insert | update | delete
  table_name   text not null,
  record_id    text,
  record_label text,
  changes      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);


-- =====================================================================
-- Helpers (private schema: not reachable through the Data API)
-- =====================================================================

-- Role of the signed-in user, or NULL when signed out or suspended
create or replace function private.my_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p
  where p.id = auth.uid() and p.status = 'active'
$$;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() = 'admin', false) $$;

create or replace function private.is_staff()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() in ('driver', 'admin'), false) $$;

-- Approved and active (resident, driver or admin)
create or replace function private.is_member()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() in ('resident', 'driver', 'admin'), false) $$;

create or replace function private.owns_house(p_house_no text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.households h
                 where h.house_no = p_house_no and h.owner_id = auth.uid())
$$;

create or replace function private.owns_household(p_household_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.households h
                 where h.id = p_household_id and h.owner_id = auth.uid())
$$;

create or replace function private.require(p_ok boolean, p_message text)
returns void language plpgsql set search_path = ''
as $$
begin
  if not coalesce(p_ok, false) then
    raise exception '%', p_message using errcode = '42501';
  end if;
end $$;

-- Great-circle distance in metres (Haversine)
create or replace function private.distance_m(lat1 double precision, lon1 double precision,
                                               lat2 double precision, lon2 double precision)
returns double precision language sql immutable set search_path = ''
as $$
  select 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  )))
$$;

-- Initial bearing in degrees from point 1 to point 2, relative to true north
create or replace function private.bearing_deg(lat1 double precision, lon1 double precision,
                                                lat2 double precision, lon2 double precision)
returns double precision language sql immutable set search_path = ''
as $$
  select mod((degrees(atan2(
    sin(radians(lon2 - lon1)) * cos(radians(lat2)),
    cos(radians(lat1)) * sin(radians(lat2)) - sin(radians(lat1)) * cos(radians(lat2)) * cos(radians(lon2 - lon1))
  )) + 360)::numeric, 360)::double precision
$$;

create or replace function private.notify(p_house_no text, p_type text, p_title text,
                                          p_message text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = ''
as $$
  insert into public.notifications (house_no, type, title, message, data)
  values (p_house_no, p_type, p_title, p_message, coalesce(p_data, '{}'::jsonb))
$$;


-- =====================================================================
-- Triggers
-- =====================================================================

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger households_updated_at      before update on public.households      for each row execute function private.set_updated_at();
create trigger vehicles_updated_at        before update on public.vehicles        for each row execute function private.set_updated_at();
create trigger pickup_requests_updated_at before update on public.pickup_requests for each row execute function private.set_updated_at();
create trigger app_settings_updated_at    before update on public.app_settings    for each row execute function private.set_updated_at();


-- Create the profile for a user (Google sign-in fills name and picture)
create or replace function private.ensure_profile(p_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_auto boolean;
begin
  select s.auto_approve_residents into v_auto from public.app_settings s where s.id;

  insert into public.profiles (id, email, full_name, avatar_url, role)
  select u.id,
         coalesce(u.email, ''),
         left(coalesce(u.raw_user_meta_data ->> 'full_name',
                       u.raw_user_meta_data ->> 'name',
                       split_part(coalesce(u.email, ''), '@', 1)), 120),
         coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture'),
         case when coalesce(v_auto, true) then 'resident' else 'pending' end::public.app_role
  from auth.users u
  where u.id = p_user_id
  on conflict (id) do nothing;
end $$;

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform private.ensure_profile(new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();


-- Only admins change roles or account status, and one active admin always remains.
-- The SQL editor and service role (no auth.uid()) may promote the first admin.
create or replace function private.guard_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (new.role is distinct from old.role or new.status is distinct from old.status
      or new.email is distinct from old.email or new.id is distinct from old.id)
     and auth.uid() is not null and not private.is_admin() then
    raise exception 'Only an admin can change roles or account status' using errcode = '42501';
  end if;

  if old.role = 'admin' and old.status = 'active'
     and (new.role <> 'admin' or new.status <> 'active')
     and not exists (select 1 from public.profiles p
                     where p.role = 'admin' and p.status = 'active' and p.id <> old.id) then
    raise exception 'At least one active admin is required. Promote someone else first.' using errcode = '42501';
  end if;

  if new.full_name is distinct from old.full_name or new.phone is distinct from old.phone
     or new.role is distinct from old.role or new.status is distinct from old.status then
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function private.guard_profile();


-- Keep vehicles in step with their drivers' profiles
create or replace function private.profile_after_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'driver' and new.role <> 'driver' then
    update public.vehicles set driver_id = null where driver_id = new.id;
  elsif new.role = 'driver' and (new.full_name is distinct from old.full_name or new.phone is distinct from old.phone) then
    update public.vehicles
       set driver_name = new.full_name,
           driver_phone = coalesce(nullif(new.phone, ''), driver_phone)
     where driver_id = new.id;
  end if;
  return null;
end $$;

create trigger profiles_after_update after update on public.profiles
  for each row execute function private.profile_after_update();


-- Assigning a driver copies their name and phone, and moves them off any other vehicle
create or replace function private.vehicle_before_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_driver public.profiles;
begin
  if new.driver_id is not null
     and (tg_op = 'INSERT' or new.driver_id is distinct from old.driver_id) then
    select * into v_driver from public.profiles p where p.id = new.driver_id;
    if not found or v_driver.role <> 'driver' then
      raise exception 'Only people with the driver role can be assigned to a vehicle' using errcode = '22023';
    end if;
    update public.vehicles set driver_id = null where driver_id = new.driver_id and id <> new.id;
    new.driver_name := v_driver.full_name;
    if v_driver.phone <> '' then new.driver_phone := v_driver.phone; end if;
  end if;
  return new;
end $$;

create trigger vehicles_before_write before insert or update on public.vehicles
  for each row execute function private.vehicle_before_write();


create or replace function private.settings_before_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform now() at time zone new.timezone;   -- raises on an unknown time zone
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger app_settings_before_update before update on public.app_settings
  for each row execute function private.settings_before_update();


-- Generic audit trail. Trigger arguments name columns to ignore (telemetry
-- and bookkeeping), so a moving truck does not flood the log.
create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_ignore  text[] := array['updated_at']::text[] || coalesce(tg_argv::text[], '{}'::text[]);
  v_old     jsonb;
  v_new     jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key     text;
  v_label   text;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if not (v_key = any (v_ignore)) and (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_changes := v_changes || jsonb_build_object(v_key,
                       jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return null; end if;
  else
    v_changes := coalesce(v_new, v_old) - v_ignore;
  end if;

  v_label := case tg_table_name
    when 'households'   then 'House #' || coalesce(v_new ->> 'house_no', v_old ->> 'house_no')
    when 'profiles'     then coalesce(nullif(v_new ->> 'email', ''), v_old ->> 'email')
    when 'app_settings' then 'Settings'
    else coalesce(v_new ->> 'id', v_old ->> 'id')
  end;

  insert into public.audit_log (actor_id, actor_email, action, table_name, record_id, record_label, changes)
  values (auth.uid(),
          coalesce((select p.email from public.profiles p where p.id = auth.uid()),
                   auth.jwt() ->> 'email', 'system'),
          lower(tg_op), tg_table_name, coalesce(v_new ->> 'id', v_old ->> 'id'), v_label, v_changes);
  return null;
end $$;

create trigger audit_profiles after insert or update or delete on public.profiles
  for each row execute function private.audit_row('last_seen_at', 'avatar_url');
create trigger audit_households after insert or update or delete on public.households
  for each row execute function private.audit_row('is_in_geofence', 'notified_at');
create trigger audit_vehicles after insert or update or delete on public.vehicles
  for each row execute function private.audit_row('lat', 'lon', 'speed_kmh', 'bearing', 'route_index',
                                                  'tracking_mode', 'last_position_at');
create trigger audit_pickup_requests after insert or update or delete on public.pickup_requests
  for each row execute function private.audit_row();
create trigger audit_emergency_reports after insert or delete on public.emergency_reports
  for each row execute function private.audit_row();
create trigger audit_app_settings after update on public.app_settings
  for each row execute function private.audit_row('updated_by');


-- =====================================================================
-- Row-level security
-- =====================================================================

alter table public.app_settings      enable row level security;
alter table public.profiles          enable row level security;
alter table public.vehicles          enable row level security;
alter table public.households        enable row level security;
alter table public.pickup_requests   enable row level security;
alter table public.notifications     enable row level security;
alter table public.emergency_reports enable row level security;
alter table public.audit_log         enable row level security;

-- Settings: anyone signed in can read them (ward name, geofence radius)
create policy "Signed-in users read settings" on public.app_settings
  for select to authenticated using (true);
create policy "Admins change settings" on public.app_settings
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Profiles
create policy "People read their own profile, admins read all" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));
create policy "Admins update profiles" on public.profiles
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Vehicles: every approved member sees the fleet (residents track the truck)
create policy "Members read vehicles" on public.vehicles
  for select to authenticated using ((select private.is_member()));
create policy "Admins add vehicles" on public.vehicles
  for insert to authenticated with check ((select private.is_admin()));
create policy "Admins edit vehicles" on public.vehicles
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "Admins remove vehicles" on public.vehicles
  for delete to authenticated using ((select private.is_admin()));

-- Households: staff see all, residents only their own
create policy "Staff read households, residents read their own" on public.households
  for select to authenticated
  using ((select private.is_staff())
         or (owner_id = (select auth.uid()) and (select private.is_member())));
create policy "Admins add households" on public.households
  for insert to authenticated with check ((select private.is_admin()));
create policy "Admins edit households" on public.households
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "Admins remove households" on public.households
  for delete to authenticated using ((select private.is_admin()));

-- Pickup requests
create policy "Staff read pickups, residents read their own" on public.pickup_requests
  for select to authenticated
  using ((select private.is_staff())
         or ((select private.is_member()) and private.owns_household(household_id)));
create policy "Admins remove pickups" on public.pickup_requests
  for delete to authenticated using ((select private.is_admin()));

-- Notifications: residents see their household's and ward-wide ones
create policy "Staff read notifications, residents read theirs" on public.notifications
  for select to authenticated
  using ((select private.is_staff())
         or ((select private.is_member()) and (house_no = 'ALL' or private.owns_house(house_no))));

-- Delay notices are ward-wide
create policy "Members read issue reports" on public.emergency_reports
  for select to authenticated using ((select private.is_member()));

-- Audit log
create policy "Admins read the audit log" on public.audit_log
  for select to authenticated using ((select private.is_admin()));


-- ── Table privileges (RLS still applies on top) ──────────────────────
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on all tables in schema public to authenticated;

grant update (full_name, phone, role, status) on public.profiles to authenticated;

grant insert (house_no, resident_name, ward, address, landmark, phone, lat, lon, owner_id)
  on public.households to authenticated;
grant update (house_no, resident_name, ward, address, landmark, phone, lat, lon, owner_id, garbage_ready)
  on public.households to authenticated;
grant delete on public.households to authenticated;

grant insert (id, plate_number, capacity, status, driver_id, driver_name, driver_phone, lat, lon)
  on public.vehicles to authenticated;
grant update (plate_number, capacity, status, driver_id, driver_name, driver_phone)
  on public.vehicles to authenticated;
grant delete on public.vehicles to authenticated;

grant delete on public.pickup_requests to authenticated;

grant update (ward_name, timezone, geofence_radius_m, geofence_exit_m, auto_approve_residents,
              baseline_announcements, baseline_collections, baseline_missed, db_hours_per_announcement)
  on public.app_settings to authenticated;


-- =====================================================================
-- RPC functions called by the web app (supabase.rpc(...))
-- =====================================================================

-- The signed-in user's profile; also records when they were last active
create or replace function public.me()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  perform private.ensure_profile(auth.uid());
  update public.profiles set last_seen_at = now() where id = auth.uid()
  returning * into v_profile;
  return to_jsonb(v_profile);
end $$;


-- Dashboard numbers. Collections and misses count from midnight in the ward's time zone.
create or replace function public.get_analytics()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  s             public.app_settings;
  v_day_start   timestamptz;
  v_alerts      integer;
  v_collected   integer;
  v_missed      integer;
  v_announce    integer;
  v_collections integer;
  v_missed_all  integer;
begin
  perform private.require(private.is_member(), 'Your account is not approved yet');
  select * into s from public.app_settings where id;
  v_day_start := date_trunc('day', now() at time zone s.timezone) at time zone s.timezone;

  select count(*) into v_alerts    from public.notifications   where type = 'geofence_alert';
  select count(*) into v_collected from public.pickup_requests where status = 'Collected' and collected_at >= v_day_start;
  select count(*) into v_missed    from public.pickup_requests where status = 'Missed'    and missed_at    >= v_day_start;

  v_announce    := s.baseline_announcements + v_alerts;
  v_collections := s.baseline_collections + v_collected;
  v_missed_all  := s.baseline_missed + v_missed;

  return jsonb_build_object(
    'announcementsAvoided',    v_announce,
    'decibelHoursSaved',       round(v_announce * s.db_hours_per_announcement, 1),
    'geofenceAlertsFired',     v_alerts,
    'collectionsToday',        v_collections,
    'missedPickups',           v_missed_all,
    'collectionEfficiencyPct', case when v_collections + v_missed_all > 0
                                    then round(v_collections * 100.0 / (v_collections + v_missed_all), 1)
                                    else 100 end,
    'pendingPickups',          (select count(*) from public.pickup_requests where status in ('Pending', 'Accepted')),
    'delayNotices',            (select count(*) from public.emergency_reports where reported_at >= v_day_start),
    'activeVehicles',          (select count(*) from public.vehicles where status = 'active')
  );
end $$;


-- GPS fix from the simulator or a driver's phone. Moves the vehicle, then runs
-- the geofence for every household against the nearest active vehicle:
-- one alert when it comes within the radius, re-armed only beyond the exit distance.
create or replace function public.report_vehicle_position(
  p_vehicle_id  text,
  p_lat         double precision,
  p_lon         double precision,
  p_speed_kmh   double precision default 20,
  p_route_index integer default null,
  p_mode        public.tracking_mode default 'simulator'
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_vehicle  public.vehicles;
  v_settings public.app_settings;
  v_house    record;
  v_bearing  double precision;
  v_alerts   integer := 0;
begin
  perform private.require(
    private.is_admin()
    or (private.my_role() = 'driver'
        and exists (select 1 from public.vehicles v where v.id = p_vehicle_id and v.driver_id = auth.uid())),
    'Only the assigned driver or an admin can move this vehicle');

  if p_lat is null or p_lon is null or abs(p_lat) > 90 or abs(p_lon) > 180 then
    raise exception 'Invalid coordinates' using errcode = '22023';
  end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id for update;
  if not found then
    raise exception 'Vehicle % not found', p_vehicle_id using errcode = 'P0002';
  end if;
  select * into v_settings from public.app_settings where id;

  v_bearing := case
    when v_vehicle.lat is null or (v_vehicle.lat = p_lat and v_vehicle.lon = p_lon) then v_vehicle.bearing
    else private.bearing_deg(v_vehicle.lat, v_vehicle.lon, p_lat, p_lon)
  end;

  update public.vehicles
     set lat = p_lat, lon = p_lon,
         speed_kmh = greatest(0, coalesce(p_speed_kmh, 0)),
         bearing = round(v_bearing::numeric)::double precision,
         route_index = coalesce(p_route_index, route_index),
         tracking_mode = coalesce(p_mode, 'simulator'),
         last_position_at = now()
   where id = p_vehicle_id;

  for v_house in
    select h.id, h.house_no, h.resident_name, h.is_in_geofence,
           (select min(private.distance_m(v.lat, v.lon, h.lat, h.lon))
              from public.vehicles v
             where v.lat is not null and (v.status = 'active' or v.id = p_vehicle_id)) as dist
      from public.households h
       for update of h
  loop
    continue when v_house.dist is null;
    if not v_house.is_in_geofence and v_house.dist <= v_settings.geofence_radius_m then
      update public.households set is_in_geofence = true, notified_at = now() where id = v_house.id;
      perform private.notify(v_house.house_no, 'geofence_alert',
        format('Garbage vehicle approaching (%s m)', v_settings.geofence_radius_m),
        format('Garbage collection vehicle is approximately %s m away. Please keep your garbage ready.',
               round(v_house.dist::numeric)),
        jsonb_build_object('distance', round(v_house.dist::numeric), 'vehicleId', p_vehicle_id,
                           'residentName', v_house.resident_name));
      v_alerts := v_alerts + 1;
    elsif v_house.is_in_geofence and v_house.dist > v_settings.geofence_exit_m then
      update public.households set is_in_geofence = false where id = v_house.id;
    end if;
  end loop;

  return jsonb_build_object('vehicleId', p_vehicle_id, 'alerts', v_alerts);
end $$;


-- Clear the geofence latches so a fresh demo run alerts again
create or replace function public.reset_geofences()
returns integer language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.require(private.is_staff(), 'Only drivers and admins can reset the route');
  update public.households set is_in_geofence = false where is_in_geofence;
  get diagnostics v_count = row_count;
  return v_count;
end $$;


-- Resident (or admin) registers a household. A resident becomes its owner;
-- a house number that already belongs to someone else is refused.
create or replace function public.register_household(
  p_house_no      text,
  p_resident_name text,
  p_ward          text,
  p_address       text,
  p_landmark      text default '',
  p_phone         text default '',
  p_lat           double precision default null,
  p_lon           double precision default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_house_no text := btrim(coalesce(p_house_no, ''));
  v_is_admin boolean := private.is_admin();
  v_existing public.households;
  v_row      public.households;
  v_is_new   boolean;
begin
  perform private.require(private.my_role() in ('resident', 'admin'),
                          'Only residents and admins can register a household');
  if v_house_no = '' then raise exception 'House number is required' using errcode = '22023'; end if;
  if p_lat is null or p_lon is null or abs(p_lat) > 90 or abs(p_lon) > 180 then
    raise exception 'A valid latitude and longitude are required' using errcode = '22023';
  end if;

  select * into v_existing from public.households where house_no = v_house_no for update;
  v_is_new := not found;

  if v_is_new then
    insert into public.households (house_no, resident_name, ward, address, landmark, phone, lat, lon, owner_id)
    values (v_house_no,
            coalesce(nullif(btrim(p_resident_name), ''), 'Resident of #' || v_house_no),
            coalesce(nullif(btrim(p_ward), ''), (select ward_name from public.app_settings where id)),
            coalesce(nullif(btrim(p_address), ''), 'House No. ' || v_house_no),
            coalesce(btrim(p_landmark), ''), coalesce(btrim(p_phone), ''),
            p_lat, p_lon,
            case when v_is_admin then null else auth.uid() end)
    returning * into v_row;
  else
    if not v_is_admin and v_existing.owner_id is distinct from auth.uid() then
      raise exception 'House #% is already registered. Ask the municipal office to link it to your account.', v_house_no
        using errcode = '42501';
    end if;
    update public.households
       set resident_name = coalesce(nullif(btrim(p_resident_name), ''), resident_name),
           ward          = coalesce(nullif(btrim(p_ward), ''), ward),
           address       = coalesce(nullif(btrim(p_address), ''), address),
           landmark      = coalesce(p_landmark, landmark),
           phone         = coalesce(p_phone, phone),
           lat           = p_lat,
           lon           = p_lon
     where id = v_existing.id
    returning * into v_row;
  end if;

  perform private.notify(v_row.house_no, 'registration',
    case when v_is_new then 'Household registered' else 'Household profile updated' end,
    format('House #%s (%s) registered in %s. Quiet geofence alerts are active.',
           v_row.house_no, v_row.resident_name, v_row.ward));

  return to_jsonb(v_row) || jsonb_build_object('is_new', v_is_new);
end $$;


create or replace function public.set_garbage_ready(p_house_no text, p_ready boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.households;
begin
  perform private.require(private.is_admin() or (private.is_member() and private.owns_house(p_house_no)),
                          'You can only update your own household');
  update public.households set garbage_ready = coalesce(p_ready, false)
   where house_no = p_house_no
  returning * into v_row;
  if not found then raise exception 'House #% not found', p_house_no using errcode = 'P0002'; end if;

  perform private.notify(v_row.house_no, 'garbage_ready',
    case when v_row.garbage_ready then 'Garbage marked ready' else 'Garbage ready cleared' end,
    case when v_row.garbage_ready
         then format('House #%s told the driver that bins are outside the gate.', v_row.house_no)
         else format('House #%s cleared the garbage-ready status.', v_row.house_no) end);
  return to_jsonb(v_row);
end $$;


create or replace function public.create_pickup_request(
  p_house_no      text,
  p_resident_name text default null,
  p_ward          text default null,
  p_address       text default null,
  p_landmark      text default '',
  p_note          text default '',
  p_waste_type    text default 'Mixed Waste'
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_house  public.households;
  v_row    public.pickup_requests;
  v_driver text;
begin
  perform private.require(private.is_admin() or (private.is_member() and private.owns_house(p_house_no)),
                          'You can only request pickups for your own household');
  select * into v_house from public.households where house_no = btrim(p_house_no);
  if not found then raise exception 'House #% is not registered', p_house_no using errcode = 'P0002'; end if;

  insert into public.pickup_requests (household_id, house_no, resident_name, ward, address, landmark,
                                      note, waste_type, lat, lon, created_by)
  values (v_house.id, v_house.house_no,
          left(coalesce(nullif(btrim(p_resident_name), ''), v_house.resident_name), 120),
          left(coalesce(nullif(btrim(p_ward), ''), v_house.ward), 80),
          left(coalesce(nullif(btrim(p_address), ''), v_house.address), 200),
          left(coalesce(btrim(p_landmark), ''), 120),
          left(coalesce(btrim(p_note), ''), 500),
          left(coalesce(nullif(btrim(p_waste_type), ''), 'Mixed Waste'), 60),
          v_house.lat, v_house.lon, auth.uid())
  returning * into v_row;

  select nullif(v.driver_name, '') into v_driver
    from public.vehicles v where v.status = 'active' order by v.id limit 1;

  perform private.notify(v_row.house_no, 'pickup_request_created', 'Pickup request logged',
    format('Pickup request %s for House #%s was sent to %s.', v_row.id, v_row.house_no,
           coalesce('Driver ' || v_driver, 'the collection team')));
  return to_jsonb(v_row);
end $$;


create or replace function public.set_pickup_status(p_request_id text, p_status public.pickup_status)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row    public.pickup_requests;
  v_driver text;
begin
  perform private.require(private.is_staff(), 'Only drivers and admins can update pickups');
  if p_status = 'Pending' then
    raise exception 'A pickup cannot be moved back to Pending' using errcode = '22023';
  end if;

  select * into v_row from public.pickup_requests where id = p_request_id for update;
  if not found then raise exception 'Pickup % not found', p_request_id using errcode = 'P0002'; end if;
  if v_row.status in ('Collected', 'Missed') then
    raise exception 'Pickup % is already %', p_request_id, lower(v_row.status::text) using errcode = '22023';
  end if;

  select coalesce(nullif(p.full_name, ''), p.email) into v_driver from public.profiles p where p.id = auth.uid();

  update public.pickup_requests
     set status          = p_status,
         assigned_driver = v_driver,
         accepted_at     = case when p_status in ('Accepted', 'Collected') then coalesce(accepted_at, now()) else accepted_at end,
         collected_at    = case when p_status = 'Collected' then now() else collected_at end,
         missed_at       = case when p_status = 'Missed'    then now() else missed_at end
   where id = p_request_id
  returning * into v_row;

  if p_status = 'Accepted' then
    perform private.notify(v_row.house_no, 'pickup_accepted', 'Pickup request accepted',
      format('Driver %s accepted pickup %s for House #%s and is heading to your location.', v_driver, v_row.id, v_row.house_no));
  elsif p_status = 'Collected' then
    update public.households set garbage_ready = false where id = v_row.household_id and garbage_ready;
    perform private.notify(v_row.house_no, 'pickup_collected', 'Garbage collected',
      format('Your garbage has been collected by Driver %s. Thank you for keeping your city clean!', v_driver));
  else
    perform private.notify(v_row.house_no, 'pickup_missed', 'Pickup missed',
      format('Driver %s could not collect from House #%s: bins were inaccessible or the gate was locked.', v_driver, v_row.house_no));
  end if;

  return to_jsonb(v_row);
end $$;


-- Driver delay notice, broadcast to every resident
create or replace function public.report_issue(
  p_vehicle_id text,
  p_type       text,
  p_message    text,
  p_locality   text default ''
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_vehicle public.vehicles;
  v_row     public.emergency_reports;
begin
  perform private.require(
    private.is_admin()
    or (private.my_role() = 'driver'
        and exists (select 1 from public.vehicles v where v.id = p_vehicle_id and v.driver_id = auth.uid())),
    'Only the assigned driver or an admin can report an issue for this vehicle');

  select * into v_vehicle from public.vehicles where id = p_vehicle_id;
  if not found then raise exception 'Vehicle % not found', p_vehicle_id using errcode = 'P0002'; end if;

  insert into public.emergency_reports (vehicle_id, driver_name, type, message, locality, reported_by)
  values (v_vehicle.id, v_vehicle.driver_name,
          left(coalesce(nullif(btrim(p_type), ''), 'Other'), 80),
          left(coalesce(nullif(btrim(p_message), ''), 'Encountered an unexpected delay.'), 500),
          left(coalesce(p_locality, ''), 120),
          auth.uid())
  returning * into v_row;

  perform private.notify('ALL', 'emergency_alert', 'Driver alert: ' || v_row.type,
    format('Vehicle %s reported: %s', v_row.vehicle_id, v_row.message));
  return to_jsonb(v_row);
end $$;


-- ── Function privileges: signed-in users only ────────────────────────
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;
grant  execute on all functions in schema private to authenticated;
grant  execute on function
  public.me(),
  public.get_analytics(),
  public.report_vehicle_position(text, double precision, double precision, double precision, integer, public.tracking_mode),
  public.reset_geofences(),
  public.register_household(text, text, text, text, text, text, double precision, double precision),
  public.set_garbage_ready(text, boolean),
  public.create_pickup_request(text, text, text, text, text, text, text),
  public.set_pickup_status(text, public.pickup_status),
  public.report_issue(text, text, text, text)
to authenticated;


-- ── Realtime: push row changes to every open app (RLS still applies) ─
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.app_settings, public.profiles, public.vehicles, public.households,
      public.pickup_requests, public.notifications, public.emergency_reports, public.audit_log;
  end if;
end $$;
