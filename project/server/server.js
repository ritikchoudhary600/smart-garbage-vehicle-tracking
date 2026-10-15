/**
 * server.js - Native Node.js HTTP & Server-Sent Events (SSE) server
 * for Smart Garbage Vehicle Tracking & Waste Management System
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const dataStore = require('./dataStore');
const simulatorEngine = require('./simulatorEngine');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json'
};

/**
 * Parses incoming JSON body from HTTP request
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Sends a JSON response with status and CORS headers
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

/**
 * Serves static files from the public directory
 */
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security check to prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for client-side routing
      const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallbackPath, (fallbackErr, content) => {
        if (fallbackErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('500 Internal Server Error');
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // Real-Time Server-Sent Events (SSE)
  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Send immediate greeting and initial state snapshot
    res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', time: new Date().toISOString() })}\n\n`);
    res.write(`event: initial_state\ndata: ${JSON.stringify(dataStore.getState())}\n\n`);

    dataStore.subscribe(res);

    // Keep-alive heartbeat every 20s
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      dataStore.unsubscribe(res);
    });
    return;
  }

  // --- API Endpoints ---

  // GET /api/health
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { status: 'healthy', timestamp: new Date().toISOString() });
  }

  // GET /api/state
  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, dataStore.getState());
  }

  // POST /api/telemetry/location
  if (pathname === '/api/telemetry/location' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { vehicleId = 'GV-04', lat, lon, speedKmh = 20 } = body;
      if (lat == null || lon == null) {
        return sendJson(res, 400, { error: 'lat and lon are required' });
      }
      const updated = dataStore.updateVehicleLocation(vehicleId, Number(lat), Number(lon), Number(speedKmh));
      return sendJson(res, 200, { success: true, updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/resident/garbage-ready
  if (pathname === '/api/resident/garbage-ready' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { houseNo = '125', isReady = true } = body;
      const updated = dataStore.setGarbageReady(houseNo, Boolean(isReady));
      return sendJson(res, 200, { success: true, house: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/resident/pickup-request
  if (pathname === '/api/resident/pickup-request' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const newRequest = dataStore.createPickupRequest(body);
      return sendJson(res, 201, { success: true, request: newRequest });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/driver/pickup/status
  if (pathname === '/api/driver/pickup/status' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const { requestId, status, driverName } = body;
      if (!requestId || !status) {
        return sendJson(res, 400, { error: 'requestId and status are required' });
      }
      const updated = dataStore.updatePickupStatus(requestId, status, driverName);
      if (!updated) {
        return sendJson(res, 404, { error: 'Pickup request not found' });
      }
      return sendJson(res, 200, { success: true, request: updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/resident/register
  if (pathname === '/api/resident/register' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const house = dataStore.registerOrUpdateHouse(body);
      return sendJson(res, 200, { success: true, house });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/driver/switch
  if (pathname === '/api/driver/switch' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const vehicle = dataStore.switchDriver(body.vehicleId, body.driverName, body.driverContact);
      return sendJson(res, 200, { success: true, vehicle });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/driver/emergency
  if (pathname === '/api/driver/emergency' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const report = dataStore.reportEmergency(body);
      return sendJson(res, 200, { success: true, report });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/simulation/start
  if (pathname === '/api/simulation/start' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const speed = Number(body.speedMultiplier) || 1;
      const result = simulatorEngine.start(speed);
      return sendJson(res, 200, { success: true, simulation: result });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/simulation/stop
  if (pathname === '/api/simulation/stop' && method === 'POST') {
    const result = simulatorEngine.stop();
    return sendJson(res, 200, { success: true, simulation: result });
  }

  // POST /api/simulation/step
  if (pathname === '/api/simulation/step' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const result = body.direction === 'backward'
        ? simulatorEngine.stepBackward()
        : simulatorEngine.stepForward();
      return sendJson(res, 200, { success: true, step: result });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // POST /api/simulation/reset
  if (pathname === '/api/simulation/reset' && method === 'POST') {
    const result = simulatorEngine.reset();
    return sendJson(res, 200, { success: true, reset: result });
  }

  // POST /api/simulation/teleport
  if (pathname === '/api/simulation/teleport' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const result = body.index !== undefined
        ? simulatorEngine.teleport(Number(body.index))
        : simulatorEngine.teleport(body);
      return sendJson(res, 200, { success: true, teleport: result });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // If request starts with /api/ and wasn't handled
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'API endpoint not found' });
  }

  // Otherwise, serve static front-end assets
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`🌿 SMART GARBAGE VEHICLE TRACKING & WASTE COLLECTION SYSTEM 🚛`);
  console.log(`================================================================`);
  console.log(`📡 Server running at: http://localhost:${PORT}`);
  console.log(`📱 Resident App:      http://localhost:${PORT}#resident`);
  console.log(`🚛 Driver App:        http://localhost:${PORT}#driver`);
  console.log(`🏛️ Admin Dashboard:   http://localhost:${PORT}#admin`);
  console.log(`🔀 Split Demo Mode:   http://localhost:${PORT}#split`);
  console.log(`================================================================`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  simulatorEngine.stop();
  server.close(() => {
    console.log('Server terminated cleanly.');
    process.exit(0);
  });
});
