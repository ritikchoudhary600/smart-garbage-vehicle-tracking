/**
 * locationPicker.js — put a household's pin exactly on its gate
 *
 * Used by "Register household" and Control › Households. Opens on the
 * device's current location, says how accurate that is, and lets people
 * drag the pin or tap the map to correct it.
 *
 * Why the correction matters: phones use GPS (a few metres), but a laptop's
 * browser often only knows roughly where it is from Wi-Fi or the internet
 * connection, sometimes placing you in a different city. The pin makes
 * that visible and fixable instead of silently saving a wrong location.
 * Exposes window.LocationPicker.
 */
(function () {
  'use strict';

  const STYLE   = 'https://tiles.openfreemap.org/styles/liberty';   // detailed streets help find a gate
  const ROUGH_M = 250;                                               // beyond this, ask people to check the pin
  const COUNTRY = [20.5937, 78.9629];                                // whole-India view when nothing else is known

  const byId = (id) => document.getElementById(id);
  const fmtAccuracy = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);

  class Picker {
    constructor({ mapId, latId, lonId, hintId, locateId }) {
      Object.assign(this, { mapId, latId, lonId, hintId, locateId });
      this.map = null;
      this.marker = null;
      byId(locateId).addEventListener('click', () => this.locate());
      for (const id of [latId, lonId]) {
        byId(id).addEventListener('change', () => {
          const p = this._fromInputs();
          if (p) this._place(p, { from: 'typed' });
        });
      }
    }

    _fromInputs() {
      const lat = parseFloat(byId(this.latId).value);
      const lon = parseFloat(byId(this.lonId).value);
      return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
    }

    hasPin() { return !!this._fromInputs(); }

    _hint(text, level = '') {
      const el = byId(this.hintId);
      el.textContent = text;
      el.classList.toggle('is-error', level === 'error');
      el.classList.toggle('is-warn', level === 'warn');
    }

    _ensureMap(center, zoom) {
      if (this.map) return;
      this.map = new maplibregl.Map({
        container: byId(this.mapId),
        style: STYLE,
        center: [center[1], center[0]],
        zoom,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
      this.map.touchZoomRotate.disableRotation();
      this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
      this.map.on('click', (e) => this._place([e.lngLat.lat, e.lngLat.lng], { from: 'tap' }));

      const pin = document.createElement('div');
      pin.className = 'pick-pin';
      pin.innerHTML = '<span></span>';
      this.marker = new maplibregl.Marker({ element: pin, draggable: true, anchor: 'bottom' });
      this.marker.on('dragend', () => {
        const ll = this.marker.getLngLat();
        this._place([ll.lat, ll.lng], { from: 'drag', move: false });
      });
    }

    /**
     * Call right after the dialog opens.
     * fallback: [lat, lon] to show while nothing is pinned (e.g. the ward's households)
     * autoLocate: ask the device for its location when there is no pin yet
     */
    open({ fallback = null, autoLocate = true } = {}) {
      const pinned = this._fromInputs();
      const start = pinned || fallback || COUNTRY;
      const zoom = pinned ? 17 : fallback ? 14 : 4;
      this._ensureMap(start, zoom);
      // The dialog only just became visible, so measure the map again
      setTimeout(() => {
        this.map.resize();
        if (pinned) {
          this._place(pinned, { from: 'existing' });
        } else {
          this.marker.remove();
          this.map.jumpTo({ center: [start[1], start[0]], zoom });
          if (autoLocate && window.DeviceAccess) this.locate();
          else this._hint('Tap the map at your gate, or use your current location.');
        }
      }, 0);
    }

    async locate() {
      const btn = byId(this.locateId);
      btn.disabled = true;
      this._hint('Finding your current location…');
      try {
        const fix = await window.DeviceAccess.getPosition({ maximumAge: 0, timeout: 20000 });
        this._place([fix.lat, fix.lon], { from: 'gps', accuracy: fix.accuracy });
      } catch (err) {
        this._hint(`${err.message} You can also tap the map at your gate.`, 'error');
      } finally {
        btn.disabled = false;
      }
    }

    _place([lat, lon], { from, accuracy = 0, move = true } = {}) {
      byId(this.latId).value = lat.toFixed(6);
      byId(this.lonId).value = lon.toFixed(6);
      if (!this.map) return;
      this.marker.setLngLat([lon, lat]).addTo(this.map);

      const rough = from === 'gps' && accuracy > ROUGH_M;
      if (move) {
        const zoom = from === 'tap' ? this.map.getZoom() : rough ? (accuracy > 5000 ? 11 : 14) : 17;
        this.map.easeTo({ center: [lon, lat], zoom, duration: from === 'existing' ? 0 : 700 });
      }

      const where = window.GeoUtils.formatCoords(lat, lon);
      if (from === 'gps' && rough) {
        this._hint(`Your browser only knows roughly where you are (within ${fmtAccuracy(accuracy)}), so this may not be your street. Drag the pin onto your gate, or do this on your phone for GPS accuracy.`, 'warn');
      } else if (from === 'gps') {
        this._hint(`Pinned at your current location (within ${fmtAccuracy(accuracy)}). Drag the pin if it isn't on your gate.`);
      } else if (from === 'existing') {
        this._hint(`Saved location ${where}. Drag the pin, tap the map, or use your current location to change it.`);
      } else {
        this._hint(`Pinned at ${where}.`);
      }
    }
  }

  window.LocationPicker = { create: (opts) => new Picker(opts) };
})();
