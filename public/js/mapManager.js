/**
 * mapManager.js — MapLibre GL map controller
 * Open-source vector maps from OpenFreeMap (OpenStreetMap data, no API key),
 * with the vehicle animated along OpenStreetMap road geometry.
 * Exposes window.MapManager; one MapInstance per map container.
 * Coordinates are passed in as [lat, lon]; MapLibre wants [lon, lat].
 */

// Tooltips are HTML, so escape resident-entered text
function escMapText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MAP_STYLES = {
  minimal:  { label: 'Minimal',  url: 'https://tiles.openfreemap.org/styles/positron' },
  detailed: { label: 'Detailed', url: 'https://tiles.openfreemap.org/styles/liberty' },
};

const COLORS = { ink: '#111110', accent: '#1F4D3A', accent2: '#2E6B52' };
const ZONE_RADIUS_M = 500;

const toLngLat = ([lat, lon]) => [lon, lat];
const easeInOut = t => 0.5 - Math.cos(Math.PI * t) / 2;

function haversine(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingBetween(a, b) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
            Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function lineFeature(latlngs) {
  if (!latlngs || latlngs.length < 2) return { type: 'FeatureCollection', features: [] };
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: latlngs.map(toLngLat) } };
}

// Point `meters` due east of [lat, lon] (small-distance approximation)
function offsetEast([lat, lon], meters) {
  return [lat, lon + meters / (111320 * Math.cos(lat * Math.PI / 180))];
}

const HEADING_LOOKAHEAD_M = 15;   // aim the arrow this far ahead so tiny road kinks don't twitch it
const HEADING_SMOOTH_MS   = 140;  // time constant for easing the arrow toward its target heading

/* ── Minimal / Detailed style switch (MapLibre IControl) ─────────────── */
class StyleSwitchControl {
  constructor(inst) { this.inst = inst; }
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl map-style-switch';
    this.el.innerHTML = Object.entries(MAP_STYLES).map(([key, s]) =>
      `<button type="button" data-style="${key}" class="${key === this.inst.styleKey ? 'active' : ''}">${s.label}</button>`).join('');
    this.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-style]');
      if (!btn) return;
      this.inst.setStyle(btn.dataset.style);
      this.el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    });
    return this.el;
  }
  onRemove() { this.el.remove(); }
}

class MapInstance {
  constructor(containerId, center, zoom) {
    this.containerId = containerId;
    this.center      = center;
    this.zoom        = zoom;
    this.styleKey    = 'minimal';
    this.map         = null;
    this.popup       = null;

    // Latest data — kept even before the map exists so it can render on first show
    this.route    = [];
    this.trail    = [];
    this.pos      = null;       // [lat, lon] currently displayed
    this.bearing  = 0;
    this.vehicle  = null;
    this.houses   = [];
    this.selected = null;
    this.pickups  = [];

    this.vehicleMarker = null;
    this.zoneMarker    = null;        // 500 m ring, a DOM marker so it moves in lockstep with the vehicle
    this.houseMarkers  = new Map();   // id → { marker, key }
    this.pickupMarkers = new Map();   // id → marker
    this._target = null;
    this._anim   = null;
    this._fitted = false;
  }

  /* ── Lifecycle: the WebGL map is created the first time its view is visible */
  _container() { return document.getElementById(this.containerId); }

  _ensureMap() {
    if (this.map) return true;
    const el = this._container();
    if (!el || el.clientWidth === 0 || typeof maplibregl === 'undefined') return false;

    this.map = new maplibregl.Map({
      container: el,
      style: MAP_STYLES[this.styleKey].url,
      center: [this.center.lon, this.center.lat],
      zoom: this.zoom,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new StyleSwitchControl(this), 'top-right');
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    // Maps embedded in a scrolling page only take the wheel once clicked
    if (el.closest('.map-shell-card')) {
      this.map.scrollZoom.disable();
      this.map.on('click', () => this.map.scrollZoom.enable());
      el.addEventListener('mouseleave', () => this.map.scrollZoom.disable());
    }

    this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, className: 'tip', maxWidth: '260px' });
    this.map.on('style.load', () => this._installLayers());

    this._fit();
    this._renderVehicle();
    this._renderHouses();
    this._renderPickups();
    return true;
  }

  setStyle(key) {
    if (!MAP_STYLES[key] || key === this.styleKey) return;
    this.styleKey = key;
    // A full (non-diff) reload fires style.load, which re-adds our layers
    if (this.map) this.map.setStyle(MAP_STYLES[key].url, { diff: false });
  }

  // Route, trail and geofence layers sit above every road/building layer but
  // under the labels that follow them
  _installLayers() {
    const map = this.map;
    if (!map || map.getSource('route')) return;
    const layers = map.getStyle().layers;
    let lastShape = -1;
    layers.forEach((l, i) => { if (l.type !== 'symbol') lastShape = i; });
    const firstSymbol = (layers[lastShape + 1] || {}).id;

    map.addSource('route', { type: 'geojson', data: lineFeature(this.route) });
    map.addSource('trail', { type: 'geojson', data: lineFeature(this.trail) });

    map.addLayer({ id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.ink, 'line-width': 4, 'line-opacity': 0.2 } }, firstSymbol);
    map.addLayer({ id: 'trail-line', type: 'line', source: 'trail',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.accent, 'line-width': 4.5, 'line-opacity': 0.95 } }, firstSymbol);
  }

  _setSource(name, data) {
    const src = this.map && this.map.getSource(name);
    if (src) src.setData(data);
  }

  _fit() {
    const el = this._container();
    if (this._fitted || !this.map || this.route.length < 2 || !el || el.clientWidth === 0) return;
    const lats = this.route.map(p => p[0]), lons = this.route.map(p => p[1]);
    this.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 56, duration: 0 });
    this._fitted = true;
  }

  invalidateSize() {
    if (!this._ensureMap()) return;
    this.map.resize();
    this._fit();
  }

  /* ── Hover tooltips ─────────────────────────────────────────────────── */
  _bindTip(marker) {
    const el = marker.getElement();
    el.addEventListener('mouseenter', () => {
      if (!marker._tipHtml) return;
      this.popup.setLngLat(marker.getLngLat()).setHTML(marker._tipHtml).addTo(this.map);
    });
    el.addEventListener('mouseleave', () => this.popup.remove());
  }

  /* ── Route ──────────────────────────────────────────────────────────── */
  drawRoute(latlngs) {
    this.route = latlngs || [];
    this._setSource('route', lineFeature(this.route));
    this._fit();
  }

  _setTrail(latlngs) {
    this.trail = latlngs || [];
    this._setSource('trail', lineFeature(this.trail));
  }

  /* ── Vehicle ────────────────────────────────────────────────────────── */
  _tooltipHtml(v) {
    const dir = (v.direction && v.direction.label) || '—';
    return `<strong>${escMapText(v.id)}</strong> · ${escMapText(v.driverName)}<br>` +
      `<span class="tip-muted">${Math.round(v.speed || 0)} km/h · ${escMapText(dir)}</span><br>` +
      `<span class="tip-muted">${escMapText(v.locality || '')}</span>`;
  }

  _renderVehicle() {
    if (!this.map || !this.pos) return;
    if (!this.vehicleMarker) {
      // Ring first so it sits beneath every other marker
      const ring = document.createElement('div');
      ring.className = 'zone-ring';
      this.zoneMarker = new maplibregl.Marker({ element: ring, subpixelPositioning: true })
        .setLngLat(toLngLat(this.pos)).addTo(this.map);
      this.map.on('zoom', () => this._sizeZone());

      const el = document.createElement('div');
      el.className = 'mk mk-vehicle';
      el.innerHTML = '<div class="veh"><svg viewBox="0 0 24 24"><path d="M12 4.5l5.5 14-5.5-3.2-5.5 3.2z" style="fill:#fff"/></svg></div>';
      // Sub-pixel positioning: without it MapLibre rounds to whole pixels and slow motion judders
      this.vehicleMarker = new maplibregl.Marker({ element: el, subpixelPositioning: true })
        .setLngLat(toLngLat(this.pos)).addTo(this.map);
      this._bindTip(this.vehicleMarker);
    }
    if (this.vehicle) this.vehicleMarker._tipHtml = this._tooltipHtml(this.vehicle);
    this._place(this.pos);
    this._sizeZone();
    this._rotate(this.bearing);
  }

  // Ring diameter in pixels for 500 m at the current zoom
  _sizeZone() {
    if (!this.zoneMarker || !this.pos) return;
    const c = this.map.project(toLngLat(this.pos));
    const e = this.map.project(toLngLat(offsetEast(this.pos, ZONE_RADIUS_M)));
    const d = 2 * Math.hypot(e.x - c.x, e.y - c.y);
    const el = this.zoneMarker.getElement();
    el.style.width = el.style.height = `${d}px`;
  }

  _rotate(deg) {
    this.bearing = deg;
    const svg = this.vehicleMarker && this.vehicleMarker.getElement().querySelector('svg');
    if (svg) svg.style.transform = `rotate(${deg}deg)`;
  }

  // Ease the arrow toward `target` along the shortest turn
  _steer(target, dt) {
    const delta = ((target - this.bearing + 540) % 360) - 180;
    this._rotate(this.bearing + delta * (1 - Math.exp(-dt / HEADING_SMOOTH_MS)));
  }

  _place(pos) {
    this.pos = pos;
    if (this.vehicleMarker) this.vehicleMarker.setLngLat(toLngLat(pos));
    if (this.zoneMarker) this.zoneMarker.setLngLat(toLngLat(pos));
  }

  /**
   * Moves the vehicle. With opts.path the marker glides along the road
   * geometry; opts.trail is the full travelled road line up to the target.
   */
  updateVehicle(vehicle, opts = {}) {
    if (!vehicle) return;
    this.vehicle = vehicle;
    const target = [vehicle.lat, vehicle.lon];
    if (this.vehicleMarker) this.vehicleMarker._tipHtml = this._tooltipHtml(vehicle);

    const moved = !this._target || this._target[0] !== target[0] || this._target[1] !== target[1];
    if (!moved) return; // re-render without movement — leave any running animation alone

    this._cancelAnim();
    this._target = target;

    const path = opts.path;
    const visible = this.map && this._container().clientWidth > 0;
    if (!visible || !path || path.length < 2 || !opts.duration) {
      this.pos = target;
      this.bearing = vehicle.bearing || 0;
      this._setTrail(opts.trail || []);
      this._renderVehicle();
      return;
    }

    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
    const total = cum[cum.length - 1] || 1;
    const trailBase = opts.forward && opts.trail
      ? opts.trail.slice(0, Math.max(1, opts.trail.length - path.length + 1))
      : null;
    if (!opts.forward) this._setTrail(opts.trail || []);
    if (!this.vehicleMarker) { this.pos = path[0]; this._renderVehicle(); }

    // Position at distance d along the path, plus the index of its segment end
    const pointAt = (d) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const segT = Math.min(1, (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]));
      const a = path[i - 1], b = path[i];
      return { pos: [a[0] + (b[0] - a[0]) * segT, a[1] + (b[1] - a[1]) * segT], i };
    };
    const n = path.length;
    const finalHeading = bearingBetween(path[n - 2], path[n - 1]);
    // While playing, hold a constant speed so the truck doesn't stop at every waypoint
    const ease = opts.linear ? (t => t) : easeInOut;

    const start = performance.now();
    let last = start;
    const step = (now) => {
      const t = Math.min(1, (now - start) / opts.duration);
      const d = ease(t) * total;
      const { pos, i } = pointAt(d);

      this._place(pos);
      const ahead = d + HEADING_LOOKAHEAD_M;
      this._steer(ahead < total ? bearingBetween(pos, pointAt(ahead).pos) : finalHeading, now - last);
      last = now;
      if (trailBase) this._setTrail([...trailBase, ...path.slice(1, i), pos]);

      if (t < 1) {
        this._anim = requestAnimationFrame(step);
      } else {
        this._anim = null;
        this._place(target);
        this._setTrail(opts.trail || []);
      }
    };
    this._anim = requestAnimationFrame(step);
  }

  _cancelAnim() {
    if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
  }

  /* ── House markers ──────────────────────────────────────────────────── */
  updateHouses(houses, selectedHouseNo) {
    this.houses = houses || [];
    this.selected = selectedHouseNo;
    this._renderHouses();
  }

  _renderHouses() {
    if (!this.map) return;
    for (const house of this.houses) {
      const { id, houseNo, residentName, address, lat, lon,
              garbageReady, isInGeofence, distanceToVehicle } = house;
      const selected = houseNo === this.selected;
      const key = `${garbageReady}|${isInGeofence}|${selected}`;

      let entry = this.houseMarkers.get(id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'mk mk-house';
        const marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(this.map);
        this._bindTip(marker);
        entry = { marker, key: null };
        this.houseMarkers.set(id, entry);
      }
      if (entry.key !== key) {
        const cls = ['house-pin', garbageReady && 'is-ready', isInGeofence && 'is-alert', selected && 'is-selected']
          .filter(Boolean).join(' ');
        const el = entry.marker.getElement();
        el.innerHTML = `<div class="${cls}"></div>${selected ? `<span class="house-tag">#${escMapText(houseNo)}</span>` : ''}`;
        el.style.zIndex = selected ? 2 : 1;
        entry.key = key;
      }
      entry.marker._tipHtml = `<strong>House #${escMapText(houseNo)}</strong> · ${escMapText(residentName)}<br>` +
        `<span class="tip-muted">${escMapText(address)}</span><br>` +
        `<span class="tip-muted">${distanceToVehicle != null ? Math.round(distanceToVehicle) + ' m from vehicle' : ''}` +
        `${garbageReady ? ' · bins ready' : ''}${isInGeofence ? ' · alerted' : ''}</span>`;
    }
  }

  /* ── Pickup request markers (open requests only) ────────────────────── */
  updatePickups(requests) {
    this.pickups = requests || [];
    this._renderPickups();
  }

  _renderPickups() {
    if (!this.map) return;
    const open = this.pickups.filter(r => r.status === 'Pending' || r.status === 'Accepted');
    const openIds = new Set(open.map(r => r.id));
    for (const [id, marker] of this.pickupMarkers.entries()) {
      if (!openIds.has(id)) { marker.remove(); this.pickupMarkers.delete(id); }
    }

    for (const req of open) {
      let marker = this.pickupMarkers.get(req.id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'mk mk-pickup';
        el.innerHTML = '<div class="pickup-pin"></div>';
        // Offset slightly so the pickup marker doesn't sit exactly on its house pin
        marker = new maplibregl.Marker({ element: el }).setLngLat([req.lon + 0.00012, req.lat + 0.00012]).addTo(this.map);
        this._bindTip(marker);
        this.pickupMarkers.set(req.id, marker);
      }
      marker._tipHtml = `<strong>Pickup ${escMapText(req.id)}</strong> · ${escMapText(req.status)}<br>` +
        `<span class="tip-muted">House #${escMapText(req.houseNo)} · ${escMapText(req.residentName)}</span><br>` +
        `<span class="tip-muted">${escMapText(req.wasteType)}</span>`;
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════
   window.MapManager — owns all MapInstance objects
════════════════════════════════════════════════════════════════════════ */
window.MapManager = {
  _instances: {},
  ready: true,

  createMap(containerId, center = {}, zoom = 15) {
    if (this._instances[containerId]) return this._instances[containerId];
    const inst = new MapInstance(containerId, { lat: center.lat || 12.939, lon: center.lon || 77.628 }, zoom);
    inst._ensureMap();
    this._instances[containerId] = inst;
    return inst;
  },
};
