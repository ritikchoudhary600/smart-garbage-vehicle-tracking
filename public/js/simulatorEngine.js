/**
 * simulatorEngine.js — Browser-side GPS route simulator
 * Ported from server/simulatorEngine.js for Vercel static deployment.
 * Exposes window.AppSimulatorEngine singleton.
 * Uses setInterval for playback; drives AppDataStore.updateVehicleLocation().
 */
(function () {
  'use strict';

  const BASE_INTERVAL_MS = 2500; // base tick at 1× speed

  class AppSimulatorEngine {
    constructor() {
      this._intervalHandle = null;
    }

    /* ── Convenience accessors ─────────────────────────────────────────── */
    get route()        { return window.AppDataStore.simulation.route; }
    get currentIndex() { return window.AppDataStore.simulation.currentIndex; }
    set currentIndex(v){ window.AppDataStore.simulation.currentIndex = v; }
    get isRunning()    { return window.AppDataStore.simulation.isRunning; }

    /* ── Start/resume playback ─────────────────────────────────────────── */
    start(speedMultiplier = 1) {
      if (this._intervalHandle) clearInterval(this._intervalHandle);

      window.AppDataStore.simulation.isRunning       = true;
      window.AppDataStore.simulation.speedMultiplier = speedMultiplier;

      window.dispatchEvent(new CustomEvent('simulation_status', {
        detail: {
          isRunning:       true,
          currentIndex:    this.currentIndex,
          speedMultiplier: speedMultiplier,
          totalWaypoints:  this.route.length,
        },
      }));

      const intervalMs = Math.max(200, Math.round(BASE_INTERVAL_MS / speedMultiplier));

      this._intervalHandle = setInterval(() => {
        const next = this.currentIndex + 1;
        if (next >= this.route.length) {
          this.stop();
          return;
        }
        this._applyWaypoint(next, speedMultiplier);
      }, intervalMs);
    }

    /* ── Stop playback ─────────────────────────────────────────────────── */
    stop() {
      if (this._intervalHandle) { clearInterval(this._intervalHandle); this._intervalHandle = null; }
      window.AppDataStore.simulation.isRunning = false;

      window.dispatchEvent(new CustomEvent('simulation_status', {
        detail: {
          isRunning:       false,
          currentIndex:    this.currentIndex,
          speedMultiplier: window.AppDataStore.simulation.speedMultiplier,
          totalWaypoints:  this.route.length,
        },
      }));
    }

    /* ── Single step forward ───────────────────────────────────────────── */
    stepForward() {
      const next = this.currentIndex + 1;
      if (next >= this.route.length) return;
      if (this.isRunning) this.stop();
      this._applyWaypoint(next, 1);
    }

    /* ── Single step backward ──────────────────────────────────────────── */
    stepBackward() {
      const prev = this.currentIndex - 1;
      if (prev < 0) return;
      if (this.isRunning) this.stop();
      this._applyWaypoint(prev, 1);
    }

    /* ── Reset to first waypoint ───────────────────────────────────────── */
    reset() {
      this.stop();
      this._applyWaypoint(0, 0);
      window.dispatchEvent(new CustomEvent('simulation_reset', {
        detail: { currentIndex: 0, totalWaypoints: this.route.length },
      }));
    }

    /* ── Jump to a specific waypoint index ────────────────────────────── */
    teleport(index) {
      const idx = Math.max(0, Math.min(this.route.length - 1, Number(index)));
      const wasRunning = this.isRunning;
      const speed      = window.AppDataStore.simulation.speedMultiplier;
      if (wasRunning) this.stop();
      this._applyWaypoint(idx, speed);
      if (wasRunning) this.start(speed);
    }

    /* ── Internal: apply a waypoint and notify DataStore ──────────────── */
    _applyWaypoint(index, speedKmh) {
      const wp = this.route[index];
      if (!wp) return;

      this.currentIndex = index;

      // Dynamic speed: faster on open road, slower near stops
      const speed = speedKmh > 0 ? (speedKmh * 1 + 15) : 20; // scale nicely

      window.AppDataStore.updateVehicleLocation('GV-04', wp.lat, wp.lon, speed);

      window.dispatchEvent(new CustomEvent('simulation_step', {
        detail: {
          currentIndex:   index,
          totalWaypoints: this.route.length,
          waypoint:       wp,
        },
      }));
    }
  }

  window.AppSimulatorEngine = new AppSimulatorEngine();
})();
