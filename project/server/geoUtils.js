/**
 * geoUtils.js - Geospatial Calculations for Smart Garbage Vehicle Tracking
 * Handles Haversine distance, bearing/heading detection, compass octants, and locality mapping.
 */

// Earth radius in meters
const EARTH_RADIUS_METERS = 6371000;

/**
 * Converts degrees to radians
 */
function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Converts radians to degrees
 */
function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

/**
 * Calculates the great-circle distance between two points on Earth using the Haversine formula.
 * @param {number} lat1 - Latitude of point 1 in degrees
 * @param {number} lon1 - Longitude of point 1 in degrees
 * @param {number} lat2 - Latitude of point 2 in degrees
 * @param {number} lon2 - Longitude of point 2 in degrees
 * @returns {number} Distance in meters
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_METERS * c * 10) / 10; // Round to 1 decimal
}

/**
 * Calculates the forward azimuth / bearing from point 1 to point 2.
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Bearing in degrees [0, 360)
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaLambda = toRadians(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  let bearing = toDegrees(Math.atan2(y, x));
  bearing = (bearing + 360) % 360;

  return Math.round(bearing * 10) / 10;
}

/**
 * Converts a compass bearing in degrees to an octant direction with arrow symbol.
 * Directions: North ↑, Northeast ↗, East →, Southeast ↘, South ↓, Southwest ↙, West ←, Northwest ↖
 * @param {number} bearing - Bearing in degrees (0 - 360)
 * @returns {{ code: string, name: string, arrow: string, label: string }}
 */
function getBearingOctant(bearing) {
  const normalized = (bearing % 360 + 360) % 360;

  if (normalized >= 337.5 || normalized < 22.5) {
    return { code: 'N', name: 'North', arrow: '↑', label: 'North ↑' };
  } else if (normalized >= 22.5 && normalized < 67.5) {
    return { code: 'NE', name: 'Northeast', arrow: '↗', label: 'Northeast ↗' };
  } else if (normalized >= 67.5 && normalized < 112.5) {
    return { code: 'E', name: 'East', arrow: '→', label: 'East →' };
  } else if (normalized >= 112.5 && normalized < 157.5) {
    return { code: 'SE', name: 'Southeast', arrow: '↘', label: 'Southeast ↘' };
  } else if (normalized >= 157.5 && normalized < 202.5) {
    return { code: 'S', name: 'South', arrow: '↓', label: 'South ↓' };
  } else if (normalized >= 202.5 && normalized < 247.5) {
    return { code: 'SW', name: 'Southwest', arrow: '↙', label: 'Southwest ↙' };
  } else if (normalized >= 247.5 && normalized < 292.5) {
    return { code: 'W', name: 'West', arrow: '←', label: 'West ←' };
  } else {
    return { code: 'NW', name: 'Northwest', arrow: '↖', label: 'Northwest ↖' };
  }
}

/**
 * Predefined localities in the smart-city sector for locality detection
 */
const MUNICIPAL_LOCALITIES = [
  { name: 'Ward 4 - Green Glen Residential Sector', lat: 12.9415, lon: 77.6290, radius: 450 },
  { name: 'Ward 4 - Palm Avenue & Park View', lat: 12.9380, lon: 77.6265, radius: 350 },
  { name: 'Ward 4 - Sunshine Crossway', lat: 12.9430, lon: 77.6320, radius: 400 },
  { name: 'Ward 4 - South Gate Approach', lat: 12.9350, lon: 77.6240, radius: 400 },
  { name: 'Municipal Central Depot', lat: 12.9310, lon: 77.6210, radius: 500 }
];

/**
 * Detects the locality of the vehicle based on proximity to known sectors
 * @param {number} lat 
 * @param {number} lon 
 * @returns {string} Name of current locality
 */
function detectLocality(lat, lon) {
  let closestLocality = MUNICIPAL_LOCALITIES[0].name;
  let minDistance = Infinity;

  for (const loc of MUNICIPAL_LOCALITIES) {
    const dist = calculateHaversineDistance(lat, lon, loc.lat, loc.lon);
    if (dist <= loc.radius && dist < minDistance) {
      minDistance = dist;
      closestLocality = loc.name;
    }
  }

  return closestLocality;
}

/**
 * Estimates arrival time given distance in meters and current speed in km/h
 * @param {number} distanceMeters 
 * @param {number} speedKmh 
 * @returns {{ seconds: number, formatted: string }}
 */
function calculateETA(distanceMeters, speedKmh = 20) {
  // If vehicle is moving very slow or stopped, assume average residential route speed of 18 km/h
  const effectiveSpeedKmh = speedKmh < 3 ? 18 : speedKmh;
  const speedMetersPerSec = (effectiveSpeedKmh * 1000) / 3600;
  const seconds = Math.round(distanceMeters / speedMetersPerSec);

  if (seconds < 60) {
    return { seconds, formatted: `${seconds} sec` };
  }
  const minutes = Math.ceil(seconds / 60);
  return { seconds, formatted: `~${minutes} min` };
}

/**
 * Calculates progress percentage along a planned waypoint sequence
 * @param {number} currentIndex 
 * @param {number} totalWaypoints 
 * @returns {{ percent: number, formatted: string }}
 */
function calculateRouteProgress(currentIndex, totalWaypoints) {
  if (!totalWaypoints || totalWaypoints <= 1) return { percent: 0, formatted: '0%' };
  const pct = Math.round((currentIndex / (totalWaypoints - 1)) * 100);
  return { percent: pct, formatted: `${pct}%` };
}

module.exports = {
  calculateHaversineDistance,
  calculateBearing,
  getBearingOctant,
  detectLocality,
  calculateETA,
  calculateRouteProgress,
  MUNICIPAL_LOCALITIES
};
