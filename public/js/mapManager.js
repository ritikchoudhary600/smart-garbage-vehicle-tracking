/**
 * mapManager.js - Leaflet OpenStreetMap Controller for Smart Garbage Vehicle System
 * Renders custom truck marker with rotating direction arrow, 500m geofence radius,
 * registered houses with status, and pickup request locations.
 */

class MapManager {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.options = options;
    this.map = null;
    this.vehicleMarker = null;
    this.geofenceCircle = null;
    this.houseMarkers = new Map();
    this.pickupMarkers = new Map();
    this.routePolyline = null;
    this.breadcrumbPolyline = null;
  }

  init(center = [12.93950, 77.62780], zoom = 15) {
    const container = document.getElementById(this.containerId);
    if (!container || this.map) return;

    // Check if Leaflet is loaded
    if (typeof L === 'undefined') {
      console.error('Leaflet is not loaded yet');
      return;
    }

    this.map = L.map(this.containerId, {
      center,
      zoom,
      zoomControl: true,
      attributionControl: true
    });

    // Clean OpenStreetMap tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors | EcoTrack Smart Waste'
    }).addTo(this.map);

    // Invalidate map size after a moment to avoid rendering artifacts
    setTimeout(() => {
      this.map.invalidateSize();
    }, 200);
  }

  /**
   * Draws or updates the 500m geofence circle around the vehicle or house
   */
  setGeofenceCircle(lat, lon, radius = 500, color = '#10b981') {
    if (!this.map) return;

    if (!this.geofenceCircle) {
      this.geofenceCircle = L.circle([lat, lon], {
        radius,
        color,
        fillColor: color,
        fillOpacity: 0.12,
        weight: 2,
        dashArray: '6, 6'
      }).addTo(this.map);
    } else {
      this.geofenceCircle.setLatLng([lat, lon]);
      this.geofenceCircle.setStyle({ color, fillColor: color });
    }
  }

  /**
   * Updates vehicle marker with dynamic bearing angle & direction arrow
   */
  updateVehicle(vehicle) {
    if (!this.map || !vehicle) return;

    const lat = vehicle.lat;
    const lon = vehicle.lon;
    const bearing = vehicle.bearing || 0;
    const octant = vehicle.bearingOctant ? vehicle.bearingOctant.label : 'North ↑';

    const customHtml = `
      <div class="truck-marker-wrap" style="transform: rotate(${bearing}deg);">
        <div class="truck-marker-body">
          <div class="truck-heading-pointer"></div>
          <span style="transform: rotate(-${bearing}deg); font-size: 20px;">🚛</span>
        </div>
      </div>
    `;

    const icon = L.divIcon({
      html: customHtml,
      className: 'custom-vehicle-div-icon',
      iconSize: [44, 44],
      iconAnchor: [22, 22]
    });

    if (!this.vehicleMarker) {
      this.vehicleMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(this.map);
      this.vehicleMarker.bindTooltip(`
        <strong>${vehicle.id} (${vehicle.vehicleNumber})</strong><br>
        Driver: ${vehicle.driverName}<br>
        Speed: ${vehicle.speedKmh} km/h | Heading: ${octant} (${bearing}°)<br>
        Locality: ${vehicle.currentLocality}
      `, { offset: [0, -20] });
    } else {
      this.vehicleMarker.setLatLng([lat, lon]);
      this.vehicleMarker.setIcon(icon);
      this.vehicleMarker.setTooltipContent(`
        <strong>${vehicle.id} (${vehicle.vehicleNumber})</strong><br>
        Driver: ${vehicle.driverName}<br>
        Speed: ${vehicle.speedKmh} km/h | Heading: ${octant} (${bearing}°)<br>
        Locality: ${vehicle.currentLocality}
      `);
    }

    // Update 500m geofence circle around vehicle
    this.setGeofenceCircle(lat, lon, 500);

    // Update breadcrumb history trail
    if (vehicle.history && vehicle.history.length > 1) {
      const latlngs = vehicle.history.map(h => [h.lat, h.lon]);
      if (!this.breadcrumbPolyline) {
        this.breadcrumbPolyline = L.polyline(latlngs, {
          color: '#10b981',
          weight: 3,
          opacity: 0.7,
          dashArray: '4, 6'
        }).addTo(this.map);
      } else {
        this.breadcrumbPolyline.setLatLngs(latlngs);
      }
    }
  }

  /**
   * Draws the planned municipal route polyline
   */
  drawPlannedRoute(waypoints) {
    if (!this.map || !waypoints || waypoints.length === 0) return;

    const latlngs = waypoints.map(w => [w.lat, w.lon]);
    if (!this.routePolyline) {
      this.routePolyline = L.polyline(latlngs, {
        color: '#6366f1',
        weight: 4,
        opacity: 0.45
      }).addTo(this.map);
    } else {
      this.routePolyline.setLatLngs(latlngs);
    }
  }

  /**
   * Updates registered houses markers on the map
   */
  updateHouses(houses, featuredHouseNo = '125') {
    if (!this.map || !houses) return;

    for (const house of houses) {
      const isFeatured = house.houseNo === featuredHouseNo;
      const isReady = house.garbageReady;
      const isGeofence = house.isInGeofence;

      let markerClass = 'house-marker-body';
      if (isFeatured) markerClass += ' featured';
      if (isReady) markerClass += ' ready';

      const iconHtml = `
        <div class="${markerClass}" title="House #${house.houseNo}">
          ${isReady ? '✅' : '🏠'}
        </div>
      `;

      const icon = L.divIcon({
        html: iconHtml,
        className: 'custom-house-div-icon',
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      });

      if (!this.houseMarkers.has(house.id)) {
        const marker = L.marker([house.lat, house.lon], { icon, zIndexOffset: 500 }).addTo(this.map);
        marker.bindTooltip(`
          <strong>House #${house.houseNo} (${house.residentName})</strong><br>
          ${house.address}<br>
          Distance: ${Math.round(house.distanceMeters || 0)} m<br>
          Status: ${isReady ? '🟢 Garbage Ready' : '⚪ Waiting'}<br>
          ${isGeofence ? '🚨 Inside 500m Geofence!' : 'Outside 500m'}
        `);
        this.houseMarkers.set(house.id, marker);
      } else {
        const marker = this.houseMarkers.get(house.id);
        marker.setIcon(icon);
        marker.setTooltipContent(`
          <strong>House #${house.houseNo} (${house.residentName})</strong><br>
          ${house.address}<br>
          Distance: ${Math.round(house.distanceMeters || 0)} m<br>
          Status: ${isReady ? '🟢 Garbage Ready' : '⚪ Waiting'}<br>
          ${isGeofence ? '🚨 Inside 500m Geofence!' : 'Outside 500m'}
        `);
      }
    }
  }

  /**
   * Updates pickup request markers on the map
   */
  updatePickups(requests) {
    if (!this.map || !requests) return;

    // Track active request IDs
    const activeIds = new Set(requests.map(r => r.id));

    // Remove any markers no longer in requests
    for (const [id, marker] of this.pickupMarkers.entries()) {
      if (!activeIds.has(id)) {
        this.map.removeLayer(marker);
        this.pickupMarkers.delete(id);
      }
    }

    for (const req of requests) {
      const isCollected = req.status === 'Collected';
      const iconHtml = `
        <div class="pickup-marker-body ${isCollected ? 'collected' : ''}" title="Pickup: House #${req.houseNo}">
          ${isCollected ? '✔' : '📦'}
        </div>
      `;

      const icon = L.divIcon({
        html: iconHtml,
        className: 'custom-pickup-div-icon',
        iconSize: [36, 36],
        iconAnchor: [18, 18]
      });

      if (!this.pickupMarkers.has(req.id)) {
        const marker = L.marker([req.lat, req.lon], { icon, zIndexOffset: 700 }).addTo(this.map);
        marker.bindTooltip(`
          <strong>Pickup Request #${req.id}</strong><br>
          House #${req.houseNo} (${req.residentName})<br>
          Status: <strong>${req.status}</strong><br>
          Note: "${req.note}"
        `);
        this.pickupMarkers.set(req.id, marker);
      } else {
        const marker = this.pickupMarkers.get(req.id);
        marker.setIcon(icon);
        marker.setTooltipContent(`
          <strong>Pickup Request #${req.id}</strong><br>
          House #${req.houseNo} (${req.residentName})<br>
          Status: <strong>${req.status}</strong><br>
          Note: "${req.note}"
        `);
      }
    }
  }

  /**
   * Centers the map on vehicle and house
   */
  fitVehicleAndHouse(vehicleLat, vehicleLon, houseLat, houseLon) {
    if (!this.map) return;
    const bounds = L.latLngBounds([
      [vehicleLat, vehicleLon],
      [houseLat, houseLon]
    ]);
    this.map.fitBounds(bounds.pad(0.3));
  }

  /**
   * Enables clicking on map to place or teleport the simulated vehicle
   */
  enableMapClickTeleport(onLocationClicked) {
    if (!this.map) return;
    this.map.on('click', (e) => {
      if (typeof onLocationClicked === 'function') {
        onLocationClicked(e.latlng.lat, e.latlng.lng);
      }
    });
  }
}

window.MapManager = MapManager;
