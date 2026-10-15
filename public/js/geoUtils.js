/**
 * geoUtils.js — Browser-side geospatial utilities
 * Ported from server/geoUtils.js for Vercel static deployment.
 * Exposes window.GeoUtils global.
 */
(function () {
  'use strict';

  const EARTH_RADIUS_METERS = 6371000;

  function toRadians(deg) { return (deg * Math.PI) / 180; }
  function toDegrees(rad) { return (rad * 180) / Math.PI; }

  function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const phi1 = toRadians(lat1);
    const phi2 = toRadians(lat2);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(EARTH_RADIUS_METERS * c * 10) / 10;
  }

  function calculateBearing(lat1, lon1, lat2, lon2) {
    const phi1 = toRadians(lat1), phi2 = toRadians(lat2);
    const dL = toRadians(lon2 - lon1);
    const y = Math.sin(dL) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(dL);
    return (toDegrees(Math.atan2(y, x)) + 360) % 360;
  }

  function getBearingOctant(bearing) {
    const n = ((bearing % 360) + 360) % 360;
    if (n >= 337.5 || n < 22.5)   return { code: 'N',  name: 'North',     arrow: '↑', label: 'North ↑' };
    if (n >= 22.5  && n < 67.5)   return { code: 'NE', name: 'Northeast', arrow: '↗', label: 'Northeast ↗' };
    if (n >= 67.5  && n < 112.5)  return { code: 'E',  name: 'East',      arrow: '→', label: 'East →' };
    if (n >= 112.5 && n < 157.5)  return { code: 'SE', name: 'Southeast', arrow: '↘', label: 'Southeast ↘' };
    if (n >= 157.5 && n < 202.5)  return { code: 'S',  name: 'South',     arrow: '↓', label: 'South ↓' };
    if (n >= 202.5 && n < 247.5)  return { code: 'SW', name: 'Southwest', arrow: '↙', label: 'Southwest ↙' };
    if (n >= 247.5 && n < 292.5)  return { code: 'W',  name: 'West',      arrow: '←', label: 'West ←' };
    return                               { code: 'NW', name: 'Northwest', arrow: '↖', label: 'Northwest ↖' };
  }

  const MUNICIPAL_LOCALITIES = [
    { name: 'Ward 4 – Green Glen Residential Sector', lat: 12.9415, lon: 77.6290, radius: 450 },
    { name: 'Ward 4 – Palm Avenue & Park View',       lat: 12.9380, lon: 77.6265, radius: 350 },
    { name: 'Ward 4 – Sunshine Crossway',             lat: 12.9430, lon: 77.6320, radius: 400 },
    { name: 'Ward 4 – South Gate Approach',           lat: 12.9350, lon: 77.6240, radius: 400 },
    { name: 'Municipal Central Depot',                lat: 12.9310, lon: 77.6210, radius: 500 },
  ];

  function detectLocality(lat, lon) {
    let closest = MUNICIPAL_LOCALITIES[0].name;
    let minDist = Infinity;
    for (const loc of MUNICIPAL_LOCALITIES) {
      const d = calculateHaversineDistance(lat, lon, loc.lat, loc.lon);
      if (d <= loc.radius && d < minDist) { minDist = d; closest = loc.name; }
    }
    if (minDist === Infinity) {
      // fallback: nearest regardless of radius
      for (const loc of MUNICIPAL_LOCALITIES) {
        const d = calculateHaversineDistance(lat, lon, loc.lat, loc.lon);
        if (d < minDist) { minDist = d; closest = loc.name; }
      }
    }
    return closest;
  }

  function calculateETA(distanceMeters, speedKmh = 20) {
    const eff = speedKmh < 3 ? 18 : speedKmh;
    const mps = (eff * 1000) / 3600;
    const sec = Math.round(distanceMeters / mps);
    return sec < 60
      ? { seconds: sec, formatted: `${sec} sec` }
      : { seconds: sec, formatted: `~${Math.ceil(sec / 60)} min` };
  }

  window.GeoUtils = {
    calculateHaversineDistance,
    calculateBearing,
    getBearingOctant,
    detectLocality,
    calculateETA,
    MUNICIPAL_LOCALITIES,
  };
})();
