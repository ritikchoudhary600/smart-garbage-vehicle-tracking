/**
 * simulatorEngine.js - Automated and manual GPS vehicle simulation along smart-city routes
 */

const dataStore = require('./dataStore');

class SimulatorEngine {
  constructor() {
    this.intervalHandle = null;
    this.baseIntervalMs = 2500; // 2.5 seconds per waypoint at 1x
  }

  get route() {
    return dataStore.simulation.route;
  }

  get currentIndex() {
    return dataStore.simulation.currentIndex;
  }

  set currentIndex(val) {
    dataStore.simulation.currentIndex = val;
  }

  /**
   * Starts or resumes automatic route simulation
   */
  start(speedMultiplier = 1) {
    this.stop();
    dataStore.simulation.isRunning = true;
    dataStore.simulation.speedMultiplier = speedMultiplier;

    const intervalMs = Math.max(400, Math.round(this.baseIntervalMs / speedMultiplier));

    this.intervalHandle = setInterval(() => {
      this.stepForward();
    }, intervalMs);

    dataStore.broadcast('simulation_status', {
      isRunning: true,
      currentIndex: this.currentIndex,
      speedMultiplier: dataStore.simulation.speedMultiplier
    });

    return { isRunning: true, currentIndex: this.currentIndex };
  }

  /**
   * Pauses the simulation
   */
  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    dataStore.simulation.isRunning = false;

    dataStore.broadcast('simulation_status', {
      isRunning: false,
      currentIndex: this.currentIndex,
      speedMultiplier: dataStore.simulation.speedMultiplier
    });

    return { isRunning: false, currentIndex: this.currentIndex };
  }

  /**
   * Changes playback speed on the fly
   */
  setSpeed(multiplier) {
    const wasRunning = dataStore.simulation.isRunning;
    if (wasRunning) {
      this.start(multiplier);
    } else {
      dataStore.simulation.speedMultiplier = multiplier;
    }
  }

  /**
   * Advances the vehicle to the next waypoint
   */
  stepForward() {
    const route = this.route;
    if (this.currentIndex >= route.length - 1) {
      // Loop back to index 0 or pause at end
      this.currentIndex = 0;
    } else {
      this.currentIndex += 1;
    }

    const pt = route[this.currentIndex];
    const speedKmh = 18 + Math.floor(Math.random() * 8); // 18-25 km/h
    dataStore.updateVehicleLocation('GV-04', pt.lat, pt.lon, speedKmh);

    dataStore.broadcast('simulation_step', {
      currentIndex: this.currentIndex,
      waypoint: pt,
      totalWaypoints: route.length
    });

    return { currentIndex: this.currentIndex, waypoint: pt };
  }

  /**
   * Moves vehicle to the previous waypoint
   */
  stepBackward() {
    const route = this.route;
    if (this.currentIndex <= 0) {
      this.currentIndex = route.length - 1;
    } else {
      this.currentIndex -= 1;
    }

    const pt = route[this.currentIndex];
    dataStore.updateVehicleLocation('GV-04', pt.lat, pt.lon, 20);

    dataStore.broadcast('simulation_step', {
      currentIndex: this.currentIndex,
      waypoint: pt,
      totalWaypoints: route.length
    });

    return { currentIndex: this.currentIndex, waypoint: pt };
  }

  /**
   * Resets vehicle to route starting point (~1.3km away from House 125)
   */
  reset() {
    this.stop();
    this.currentIndex = 0;
    const pt = this.route[0];
    dataStore.updateVehicleLocation('GV-04', pt.lat, pt.lon, 0);

    // Reset houses geofence state for fresh demo
    for (const h of dataStore.houses) {
      h.isInGeofence = false;
    }
    dataStore.recalculateDistances();

    dataStore.broadcast('simulation_reset', {
      currentIndex: 0,
      waypoint: pt
    });

    return { currentIndex: 0, waypoint: pt };
  }

  /**
   * Teleports vehicle to a specific waypoint index or arbitrary coordinate
   */
  teleport(indexOrCoords) {
    if (typeof indexOrCoords === 'number') {
      const idx = Math.max(0, Math.min(this.route.length - 1, indexOrCoords));
      this.currentIndex = idx;
      const pt = this.route[idx];
      dataStore.updateVehicleLocation('GV-04', pt.lat, pt.lon, 22);
      return { currentIndex: idx, waypoint: pt };
    } else if (indexOrCoords.lat && indexOrCoords.lon) {
      dataStore.updateVehicleLocation('GV-04', Number(indexOrCoords.lat), Number(indexOrCoords.lon), 22);
      return { lat: indexOrCoords.lat, lon: indexOrCoords.lon };
    }
  }
}

module.exports = new SimulatorEngine();
