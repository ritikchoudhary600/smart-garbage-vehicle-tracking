-- =====================================================================
-- Customisable alert distance
--
-- Each household chooses how far away the truck should be when its one
-- quiet alert arrives (a third-floor flat may want 1 km of warning, a shop
-- at the gate 200 m). Admins set the ward default and the range residents
-- may choose from. The re-arm point becomes a buffer beyond each
-- household's own distance, so GPS jitter still never repeats an alert.
-- =====================================================================

alter table public.households
  add column alert_radius_m integer
  check (alert_radius_m is null or alert_radius_m between 50 and 5000);
comment on column public.households.alert_radius_m is
  'Alert distance this household chose, in metres. NULL = the ward default (app_settings.geofence_radius_m).';

alter table public.app_settings
  add column alert_radius_min_m integer not null default 100,
  add column alert_radius_max_m integer not null default 2000,
  add column rearm_buffer_m     integer not null default 50;

-- Keep the hysteresis the ward already had (old re-arm distance minus radius)
update public.app_settings
   set rearm_buffer_m = least(1000, greatest(10, geofence_exit_m - geofence_radius_m))
 where id;

-- An absolute re-arm distance can't work once every household has its own
-- radius; dropping the column also drops its checks.
alter table public.app_settings drop column geofence_exit_m;

alter table public.app_settings
  add constraint app_settings_rearm_buffer check (rearm_buffer_m between 10 and 1000),
  add constraint app_settings_alert_range check (
    alert_radius_min_m >= 50 and alert_radius_max_m <= 5000
    and alert_radius_min_m < alert_radius_max_m
    and geofence_radius_m between alert_radius_min_m and alert_radius_max_m);
comment on column public.app_settings.geofence_radius_m is
  'Default alert distance for households that have not chosen their own, in metres.';


-- The distance that applies to a household: its own choice, else the ward
-- default, kept inside the range admins allow (so narrowing the range later
-- applies straight away)
create or replace function private.effective_radius(p_house_radius integer, s public.app_settings)
returns integer language sql immutable set search_path = ''
as $$
  select least(s.alert_radius_max_m, greatest(s.alert_radius_min_m, coalesce(p_house_radius, s.geofence_radius_m)))
$$;


-- Same signature as before; now each household uses its own alert distance
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
           private.effective_radius(h.alert_radius_m, v_settings) as radius,
           (select min(private.distance_m(v.lat, v.lon, h.lat, h.lon))
              from public.vehicles v
             where v.lat is not null and (v.status = 'active' or v.id = p_vehicle_id)) as dist
      from public.households h
       for update of h
  loop
    continue when v_house.dist is null;
    if not v_house.is_in_geofence and v_house.dist <= v_house.radius then
      update public.households set is_in_geofence = true, notified_at = now() where id = v_house.id;
      perform private.notify(v_house.house_no, 'geofence_alert',
        format('Garbage vehicle approaching (%s m)', v_house.radius),
        format('Garbage collection vehicle is approximately %s m away. Please keep your garbage ready.',
               round(v_house.dist::numeric)),
        jsonb_build_object('distance', round(v_house.dist::numeric), 'radius', v_house.radius,
                           'vehicleId', p_vehicle_id, 'residentName', v_house.resident_name));
      v_alerts := v_alerts + 1;
    elsif v_house.is_in_geofence and v_house.dist > v_house.radius + v_settings.rearm_buffer_m then
      update public.households set is_in_geofence = false where id = v_house.id;
    end if;
  end loop;

  return jsonb_build_object('vehicleId', p_vehicle_id, 'alerts', v_alerts);
end $$;


-- A resident (or an admin) sets a household's alert distance. NULL goes
-- back to the ward default. Logged in the audit trail like any household edit.
create or replace function public.set_alert_radius(p_house_no text, p_radius_m integer)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  s     public.app_settings;
  v_row public.households;
begin
  perform private.require(private.is_admin() or (private.is_member() and private.owns_house(p_house_no)),
                          'You can only change the alert distance for your own household');
  select * into s from public.app_settings where id;
  if p_radius_m is not null and (p_radius_m < s.alert_radius_min_m or p_radius_m > s.alert_radius_max_m) then
    raise exception 'Choose an alert distance between % and % m', s.alert_radius_min_m, s.alert_radius_max_m
      using errcode = '22023';
  end if;

  update public.households set alert_radius_m = p_radius_m
   where house_no = p_house_no
  returning * into v_row;
  if not found then raise exception 'House #% not found', p_house_no using errcode = 'P0002'; end if;
  return to_jsonb(v_row);
end $$;


-- ── Privileges ───────────────────────────────────────────────────────
grant insert (alert_radius_m), update (alert_radius_m) on public.households to authenticated;
grant update (alert_radius_min_m, alert_radius_max_m, rearm_buffer_m) on public.app_settings to authenticated;

revoke execute on function public.set_alert_radius(text, integer) from public, anon;
grant  execute on function public.set_alert_radius(text, integer) to authenticated;
revoke execute on function private.effective_radius(integer, public.app_settings) from public, anon;
grant  execute on function private.effective_radius(integer, public.app_settings) to authenticated;
