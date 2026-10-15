/**
 * mapManager.js — Leaflet map controller
 * Exposes window.MapManager as a static helper object.
 * Individual MapManager instances are created per map container.
 * Works identically on localhost (Node.js) and Vercel (static).
 */

class MapInstance {
  constructor(containerId) {
    this.containerId      = containerId;
    this.map              = null;
    this.vehicleMarker    = null;
    this.geofenceCircle   = null;
    this.houseMarkers     = new Map();
    this.pickupMarkers    = new Map();
    this.breadcrumb       = null;
    this.routeLine        = null;
  }

  init(centerLat = 12.939, centerLon = 77.628, zoom = 15) {
    const container = document.getElementById(this.containerId);
    if (!container || this.map) return;
    if (typeof L === 'undefined') { console.warn('Leaflet not loaded yet'); return; }

    this.map = L.map(this.containerId, {
      center: [centerLat, centerLon],
      zoom,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors | SmartWaste EcoTrack',
    }).addTo(this.map);

    setTimeout(() => this.map && this.map.invalidateSize(), 250);
  }

  /* ── Vehicle marker ─────────────────────────────────────────────────── */
  updateVehicle(vehicle) {
    if (!this.map || !vehicle) return;

    const { lat, lon, bearing = 0, direction = {}, driverName = '', id = '', speed = 0, locality = '' } = vehicle;
    const arrow = direction.label || 'North ↑';

    const html = `
      <div class="truck-marker-wrap" style="transform:rotate(${bearing}deg);">
        <div class="truck-marker-body">
          <div class="truck-heading-pointer"></div>
          <span style="transform:rotate(-${bearing}deg);font-size:20px;">🚛</span>
        </div>
      </div>`;

    const icon = L.divIcon({
      html,
      className: 'custom-vehicle-div-icon',
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });

    const tipHtml = `<strong>${id}</strong><br>Driver: ${driverName}<br>Speed: ${Math.round(speed)} km/h<br>Heading: ${arrow}<br>Locality: ${locality}`;

    if (!this.vehicleMarker) {
      this.vehicleMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(this.map);
      this.vehicleMarker.bindTooltip(tipHtml, { offset: [0, -20] });
    } else {
      this.vehicleMarker.setLatLng([lat, lon]);
      this.vehicleMarker.setIcon(icon);
      this.vehicleMarker.setTooltipContent(tipHtml);
    }

    // 500m geofence circle follows vehicle
    if (!this.geofenceCircle) {
      this.geofenceCircle = L.circle([lat, lon], {
        radius: 500, color: '#10b981', fillColor: '#10b981',
        fillOpacity: 0.10, weight: 2, dashArray: '6 6',
      }).addTo(this.map);
    } else {
      this.geofenceCircle.setLatLng([lat, lon]);
    }
  }

  /* ── Breadcrumb trail ───────────────────────────────────────────────── */
  updateTrail(trail) {
    if (!this.map || !trail || trail.length < 2) return;
    const latlngs = trail.map(p => [p.lat, p.lon]);
    if (!this.breadcrumb) {
      this.breadcrumb = L.polyline(latlngs, {
        color: '#10b981', weight: 3, opacity: 0.65, dashArray: '4 6',
      }).addTo(this.map);
    } else {
      this.breadcrumb.setLatLngs(latlngs);
    }
  }

  /* ── Route polyline ─────────────────────────────────────────────────── */
  drawRoute(waypoints) {
    if (!this.map || !waypoints || !waypoints.length) return;
    const latlngs = waypoints.map(w => [w.lat, w.lon]);
    if (!this.routeLine) {
      this.routeLine = L.polyline(latlngs, {
        color: '#6366f1', weight: 4, opacity: 0.45,
      }).addTo(this.map);
    } else {
      this.routeLine.setLatLngs(latlngs);
    }
  }

  /* ── House markers ──────────────────────────────────────────────────── */
  updateHouses(houses) {
    if (!this.map || !houses) return;

    for (const house of houses) {
      const { id, houseNo, residentName, address, lat, lon,
              garbageReady, isInGeofence, distanceToVehicle } = house;

      const emoji = garbageReady ? '✅' : '🏠';
      let cls = 'house-marker-body';
      if (isInGeofence) cls += ' alert';
      if (garbageReady)  cls += ' ready';

      const icon = L.divIcon({
        html: `<div class="${cls}" title="House #${houseNo}">${emoji}</div>`,
        className: 'custom-house-div-icon',
        iconSize: [36, 36], iconAnchor: [18, 18],
      });

      const tip = `<strong>House #${houseNo} — ${residentName}</strong><br>${address}<br>` +
        `Distance: ${distanceToVehicle ? Math.round(distanceToVehicle) + ' m' : '—'}<br>` +
        `${garbageReady  ? '🟢 Garbage Ready' : '⚪ Waiting'}<br>` +
        `${isInGeofence  ? '🚨 Inside 500m geofence!' : 'Outside 500m'}`;

      if (!this.houseMarkers.has(id)) {
        const m = L.marker([lat, lon], { icon, zIndexOffset: 500 }).addTo(this.map);
        m.bindTooltip(tip);
        this.houseMarkers.set(id, m);
      } else {
        const m = this.houseMarkers.get(id);
        m.setIcon(icon);
        m.setTooltipContent(tip);
      }
    }
  }

  /* ── Pickup request markers ─────────────────────────────────────────── */
  updatePickups(requests) {
    if (!this.map || !requests) return;

    const activeIds = new Set(requests.map(r => r.id));
    for (const [id, m] of this.pickupMarkers.entries()) {
      if (!activeIds.has(id)) { this.map.removeLayer(m); this.pickupMarkers.delete(id); }
    }

    for (const req of requests) {
      if (req.status === 'Collected') continue; // don't show collected on map
      const icon = L.divIcon({
        html: `<div class="pickup-marker-body" title="Pickup #${req.houseNo}">📦</div>`,
        className: 'custom-pickup-div-icon',
        iconSize: [36, 36], iconAnchor: [18, 18],
      });

      const tip = `<strong>Pickup ${req.id}</strong><br>House #${req.houseNo} — ${req.residentName}<br>` +
        `Status: <strong>${req.status}</strong><br>${req.wasteType}` +
        (req.note ? `<br>"${req.note}"` : '');

      if (!this.pickupMarkers.has(req.id)) {
        const m = L.marker([req.lat, req.lon], { icon, zIndexOffset: 700 }).addTo(this.map);
        m.bindTooltip(tip);
        this.pickupMarkers.set(req.id, m);
      } else {
        const m = this.pickupMarkers.get(req.id);
        m.setIcon(icon);
        m.setTooltipContent(tip);
      }
    }
  }

  invalidateSize() {
    if (this.map) this.map.invalidateSize();
  }
}

/* ════════════════════════════════════════════════════════════════════════
   window.MapManager — static helper that owns all MapInstance objects
════════════════════════════════════════════════════════════════════════ */
window.MapManager = {
  _instances: {},
  ready: true,

  /* Create (or get existing) MapInstance for a container ID */
  createMap(containerId, center = {}, zoom = 15) {
    if (this._instances[containerId]) return this._instances[containerId];
    const inst = new MapInstance(containerId);
    inst.init(center.lat || 12.939, center.lon || 77.628, zoom);
    this._instances[containerId] = inst;
    return inst;
  },

  /* Helpers that operate on a single MapInstance */
  updateVehicleMarker(inst, vehicle)     { inst && inst.updateVehicle(vehicle); },
  updateHouseMarkers(inst, houses)       { inst && inst.updateHouses(houses); },
  updatePickupMarkers(inst, requests)    { inst && inst.updatePickups(requests); },
  updateGeofenceCircle(inst)             { /* handled inside updateVehicle */ },
  updateTrail(inst, trail)              { inst && inst.updateTrail(trail); },
  drawRoute(inst, waypoints)            { inst && inst.drawRoute(waypoints); },
};
