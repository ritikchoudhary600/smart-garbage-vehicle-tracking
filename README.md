# Smart Garbage Vehicle Tracking & Automated Waste Collection Management System

A quiet smart-city prototype that **replaces loudspeaker announcements from garbage trucks** with GPS-based **500-metre geofenced notifications**, live vehicle tracking on real streets, away-from-home **pickup requests**, and a **municipal dashboard** that measures the noise saved.

---

## 1. Problem

Municipal garbage trucks broadcast announcements over loudspeakers (around 85 dB) every few dozen metres to tell residents to bring out their bins. This disturbs infants, senior citizens, students, patients and night-shift workers.

Residents also have no visibility into:

1. Where the truck is right now.
2. Which locality it is in and which way it is heading.
3. When it will arrive, so they can put bins out without waiting on the street.
4. How to get their waste collected when nobody is home.

---

## 2. Solution

Three portals share one live state: residents get a single quiet alert when the truck is 500 m away, drivers get a pickup queue, and the municipality gets fleet tracking and noise analytics.

```
┌──────────────────────────────────────────────┐
│  GPS route simulator (real OSM road route)   │
└──────────────────────┬───────────────────────┘
                       │ lat, lon, speed, bearing
                       ▼
┌──────────────────────────────────────────────┐
│          Telemetry & state engine            │
├──────────────────────────────────────────────┤
│  • Haversine distance → 500 m geofence       │
│  • Bearing → 8-point compass direction       │
│  • Hysteresis debounce (re-arm beyond 550 m) │
│  • Pickup state machine                      │
│    Pending → Accepted → Collected / Missed   │
│  • Noise-pollution & collection analytics    │
└───────┬───────────────┬───────────────┬──────┘
        ▼               ▼               ▼
┌──────────────┐ ┌─────────────┐ ┌──────────────┐
│   Resident   │ │   Driver    │ │  Municipal   │
└──────────────┘ └─────────────┘ └──────────────┘
```

### How the code is split

- **The web app runs entirely in the browser.** The engine above lives in `public/js/` (`dataStore.js`, `simulatorEngine.js`, `geoUtils.js`), and the views update through browser events. This is why the same `public/` folder works from the Node server or as a static site on Vercel.
- **The Node server** (`server/`) serves the web app and also exposes the same engine as a REST + Server-Sent Events API (see [section 9](#9-rest--sse-api)). The automated tests run against it. The browser app does not call this API yet, so two open tabs each run their own simulation.

---

## 3. Algorithms

### A. 500-metre geofence (Haversine formula)

Great-circle distance between the vehicle $(\phi_1, \lambda_1)$ and a household $(\phi_2, \lambda_2)$:

$$a = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)$$
$$d = 2R \cdot \text{atan2}\left(\sqrt{a}, \sqrt{1-a}\right) \quad (R = 6{,}371{,}000\text{ m})$$

- **Alert:** when $d \le 500\text{ m}$, the household receives:
  > *"Garbage collection vehicle is approximately 480 m away. Please keep your garbage ready."*
- **Hysteresis debounce:** the alert fires once per approach. It re-arms only after the vehicle moves beyond $550\text{ m}$, so GPS jitter around the boundary never causes repeat alerts.

### B. Heading and direction

Bearing from consecutive GPS points, relative to true north:

$$\theta = \text{atan2}\left(\sin(\Delta\lambda)\cos(\phi_2),\; \cos(\phi_1)\sin(\phi_2) - \sin(\phi_1)\cos(\phi_2)\cos(\Delta\lambda)\right)$$
$$\text{bearing} = (\theta \cdot 180 / \pi + 360) \bmod 360$$

| Direction | Range |
|---|---|
| North ↑ | 337.5° – 22.5° |
| Northeast ↗ | 22.5° – 67.5° |
| East → | 67.5° – 112.5° |
| Southeast ↘ | 112.5° – 157.5° |
| South ↓ | 157.5° – 202.5° |
| Southwest ↙ | 202.5° – 247.5° |
| West ← | 247.5° – 292.5° |
| Northwest ↖ | 292.5° – 337.5° |

### C. Analytics

- **Loudspeaker announcements avoided:** +1 for every geofence alert sent instead of a broadcast.
- **Decibel-hours saved:** 0.5 dB·h per avoided announcement.
- **Collection efficiency:** collected ÷ (collected + missed).

---

## 4. Features

### Resident
- Live distance to the household, vehicle heading, ETA and current locality, with a progress track marking the 500 m zone.
- **500 m alert:** a banner plus a soft three-note chime (C–E–G, synthesised with the Web Audio API). It plays once per approach, only for the household selected, and can be muted with the bell in the top bar.
- **Mark garbage ready:** tells the driver the bins are outside the gate.
- **Request pickup (away from home):** house number, name, ward, address, landmark, waste type and instructions; prefilled from the selected household.
- **Pickup tracker:** a visual `Pending → Accepted → Collected` stepper (or `Missed`) with timestamps.
- **Activity feed:** this household's alerts and status updates, plus ward-wide delay notices.
- **Household switcher and registration:** switch between households or register a new one with its own coordinates.

### Driver
- Driver on duty (switchable), vehicle `GV-04`, speed, heading in degrees, locality and route progress.
- In-cab map with the route, registered households and open pickup requests.
- **Pickup queue, nearest first:** address, landmark, waste type, resident instructions and live distance. One click **Mark as collected** notifies the resident and updates the municipal metrics; **Accept** and **Missed** are also available.
- **Bins ready at gate:** households that pressed "Mark garbage ready", nearest first.
- **Report issue:** broadcasts a delay notice (traffic, compactor full, breakdown, diversion) to every resident.

### Municipal
- Announcements avoided, decibel-hours saved, collection efficiency (with on-schedule status), collections today and missed pickups.
- Fleet map, plus a 85 dB loudspeaker vs. 25 dB chime comparison.
- Tables for fleet telemetry, households (distance, geofence state, bins), away-from-home pickups and driver issue reports.

### Split demo
- The resident panel and the driver's live map and pickup queue side by side, so one click shows the truck moving and the resident being alerted at the same time.

### GPS route simulator
- A floating control bar: play/pause, step back/forward, reset and `1×` / `2×` / `4×` speed.
- Quick jumps, each exactly the labelled straight-line distance from House 125:
  `1.3 km Start` · `900 m Palm Ave` · `720 m House 88` · `480 m · Geofence trigger` · `150 m Approach` · `House 125 Arrival`
- Folds into a compact pill (play/pause and current step) with a smooth animation, and the page reclaims the space. The choice is remembered per browser; phone-width screens start folded.

---

## 5. Maps and the route

- **Open-source maps, no API key.** Vector tiles from [OpenFreeMap](https://openfreemap.org) (OpenStreetMap data, OpenMapTiles schema) rendered with [MapLibre GL JS](https://maplibre.org). Each map has a **Minimal** (Positron) and **Detailed** (Liberty) style switch.
- **Real roads.** The Ward 4 route in Koramangala, Bengaluru follows actual streets. It was generated once from the public [OSRM](https://project-osrm.org) routing service and saved in `public/js/routeData.js`, so the app works without contacting OSRM. Each waypoint carries the road geometry that leads to it.
- **Smooth motion.** The truck glides along the road geometry between waypoints at constant speed while playing, with sub-pixel positioning and a heading arrow that eases toward the road 15 m ahead. A green trail marks the distance covered, and the dashed 500 m ring moves with the truck.
- Each map is created the first time its view opens. The Municipal fleet map only zooms with the scroll wheel after it is clicked, so scrolling the page isn't hijacked.

---

## 6. Design and brand

A minimalist, light interface: one side panel next to a full-height map, no device mock-ups, and line icons instead of emoji.

### Logo

A white dot inside a dashed ring on a deep forest-green tile: the vehicle inside its quiet 500 m zone. The dashed ring is the same shape used for the geofence on the maps, so the brand and the product read as one. The ring turns slightly on hover. `public/favicon.svg` uses the same mark for the browser tab.

### Typography

| Font | Used for |
|---|---|
| **Instrument Serif** | Wordmark, page and resident names, large figures (distance, dashboard numbers) |
| **Geist** | Interface text, buttons, forms, tables |
| **Geist Mono** | Data and labels: step counter, distances in lists, timestamps, the tagline |

### Colour

All colours are CSS variables in `:root` at the top of `public/css/styles.css`.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#F6F5F1` | Warm off-white page background |
| `--surface` | `#FFFFFF` | Panels and cards |
| `--ink` | `#111110` | Text, the vehicle marker, the simulator bar |
| `--muted` | `#6E6D66` | Secondary labels (at least 4.5:1 contrast on both backgrounds) |
| `--accent` / `--accent-2` | `#1F4D3A` / `#2E6B52` | The single brand colour: alerts, trail, geofence, primary actions |
| `--amber` · `--blue` · `--danger` | `#B7791F` · `#2C4A7A` · `#B42318` | Pickup status: pending · accepted · missed |

### Responsive behaviour

- **Above 1180 px:** the navigation is centred in the header, and the panel and map sit side by side.
- **880–1180 px:** a slightly narrower panel; the header sizes its columns to the wordmark so nothing overlaps.
- **Below 880 px:** the navigation moves to its own row, the panel and map stack, and the simulator bar starts folded (unless the visitor already chose otherwise).
- **Below 520 px:** a smaller wordmark and headline figures; the simulator bar shows only the essentials.
- Animations are disabled when the system asks for reduced motion.

---

## 7. Getting started

### Prerequisites
- Node.js 18 or newer. There are no npm dependencies to install.
- An internet connection for map tiles, fonts and the MapLibre library (loaded from CDNs).

### Run locally

```bash
npm start
```

On Windows you can also double-click `start.bat`. Then open http://localhost:3000. Set the `PORT` environment variable to use a different port.

| Portal | URL |
|---|---|
| Resident | http://localhost:3000/#resident |
| Driver | http://localhost:3000/#driver |
| Municipal | http://localhost:3000/#admin |
| Split demo | http://localhost:3000/#split |

### Deploy to Vercel

The project is ready to deploy as a static site. Because the engine runs in the browser, the deployed app is fully functional without the Node server.

1. Import the repository in Vercel (or run `vercel` from this folder). If the repository contains other folders, set **Root Directory** to the folder holding `vercel.json`.
2. Leave the other settings alone; `vercel.json` already defines them:
   - **No build step.** The `public/` folder is published as-is, and `server/` and `test/` are not served.
   - **Security headers** on every response:

     | Header | Purpose |
     |---|---|
     | `Content-Security-Policy` | Only loads code, styles, fonts and map data from this site, `unpkg.com` (MapLibre), Google Fonts and `tiles.openfreemap.org`; allows MapLibre's `blob:` workers; blocks framing and plugins |
     | `X-Content-Type-Options: nosniff` | Stops MIME-type guessing |
     | `X-Frame-Options: DENY` | Blocks clickjacking in older browsers |
     | `Referrer-Policy` | Sends only the origin to other sites |
     | `Permissions-Policy` | Turns off camera, microphone, location, payment and USB access |

3. The MapLibre script and stylesheet carry Subresource Integrity hashes, so the browser refuses them if the CDN ever serves different files.

If you add a new external service (another tile server, analytics, fonts), add its host to the matching directive in `Content-Security-Policy` in `vercel.json`, or the browser will block it. If you upgrade MapLibre, update both the version and the `integrity` hashes in `public/index.html`.

---

## 8. Project structure

```
project/
├── public/                    Web app (served as-is)
│   ├── index.html             All four portals, the simulator bar and modals
│   ├── favicon.svg            Logo mark for the browser tab
│   ├── css/styles.css         Design system: colour tokens, typography, layout (see section 6)
│   └── js/
│       ├── geoUtils.js        Haversine, bearing, compass octants, locality, ETA
│       ├── routeData.js       Road-snapped Ward 4 route (generated from OSRM)
│       ├── dataStore.js       Browser state engine: geofence, pickups, analytics, notifications
│       ├── simulatorEngine.js Play / step / reset / teleport along the route
│       ├── audioChime.js      Web Audio arrival and collection chimes
│       ├── mapManager.js      MapLibre maps, markers, route/trail layers, vehicle animation
│       └── app.js             UI controller: views, forms, rendering, simulator bar
├── server/
│   ├── server.js              Static file server + REST + Server-Sent Events API
│   ├── dataStore.js           Server-side state engine (same rules as the browser)
│   ├── geoUtils.js            Geospatial maths
│   └── simulatorEngine.js     Server-side route simulator
├── test/runTests.js           Automated test suite (runs against server/)
├── start.bat                  Windows launcher
└── vercel.json                Static deployment config
```

The route and household coordinates in `server/dataStore.js` are kept in sync with `public/js/routeData.js`.

---

## 9. REST + SSE API

Served by `server/server.js`. All bodies are JSON.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/state` | Full snapshot: vehicles, houses, pickups, notifications, analytics, simulation |
| GET | `/api/events` | Server-Sent Events stream (`telemetry_update`, `geofence_alert`, `pickup_status_updated`, …) |
| POST | `/api/telemetry/location` | Push a GPS fix: `{ vehicleId, lat, lon, speedKmh }` |
| POST | `/api/resident/garbage-ready` | `{ houseNo, isReady }` |
| POST | `/api/resident/pickup-request` | `{ houseNo, residentName, address, landmark, note, wasteType }` |
| POST | `/api/resident/register` | Register or update a household: `{ houseNo, residentName, ward, address, landmark, contact, lat, lon }` |
| POST | `/api/driver/pickup/status` | `{ requestId, status: "Accepted" \| "Collected" \| "Missed", driverName }` |
| POST | `/api/driver/switch` | `{ vehicleId, driverName, driverContact }` |
| POST | `/api/driver/emergency` | `{ vehicleId, type, message }` |
| POST | `/api/simulation/start` | `{ speedMultiplier }` |
| POST | `/api/simulation/stop` | Pause |
| POST | `/api/simulation/step` | `{ direction: "forward" \| "backward" }` |
| POST | `/api/simulation/reset` | Back to the route start |
| POST | `/api/simulation/teleport` | `{ index }` or `{ lat, lon }` |

---

## 10. Tests

```bash
npm test
```

The suite covers Haversine distance, bearing and compass octants, locality detection, the 500 m geofence and its debounce, pickup requests (accept, collect, miss), garbage-ready, household registration, driver switching and simulator controls. Expected result:

```
Test Results: 13 / 13 passed.
🎉 ALL TESTS PASSED SUCCESSFULLY!
```

---

## 11. Demo script

1. **Open the split view:** http://localhost:3000/#split. Click anywhere once so the browser allows sound.
2. **Start far away:** in the simulator bar click **1.3 km Start**. The resident panel shows 1.30 km, the heading and an ETA.
3. **Approach:** click **900 m Palm Ave**, then **720 m House 88**, or press play and watch the truck drive along real streets with its trail.
4. **Trigger the geofence:** click **480 m · Geofence trigger**.
   - The resident panel shows *"Collection vehicle approaching"* with the exact distance.
   - A soft three-note chime plays instead of a loudspeaker.
   - The *blasts spared* counter in the top bar goes up by one for every household now inside the zone (Houses 88 and 102 are alerted on the way too).
5. **Away-from-home pickup:** click **Request pickup**, add instructions and submit. The request appears at once in the driver queue with its distance.
6. **Collect it:** in the driver queue click **Mark as collected**. A confirmation ding plays, the resident's tracker moves to *Collected*, and the activity feed confirms it.
7. **Bins ready:** click **Mark garbage ready**. The household appears under *Bins ready at gate* in the Driver view.
8. **Delay notice:** in the Driver view click **Report issue** and broadcast it. Every resident's activity feed shows the notice, and the Municipal view marks the route as delayed.
9. **Municipal dashboard:** open **Municipal** to review announcements avoided, decibel-hours saved, efficiency, the fleet map and the tables.
10. **Households:** switch households from the dropdown in the Resident view, or click **Register** to add one with its own coordinates.

---

## 12. Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors; tiles by [OpenFreeMap](https://openfreemap.org) using the [OpenMapTiles](https://openmaptiles.org) schema.
- Map rendering by [MapLibre GL JS](https://maplibre.org); route geometry from [OSRM](https://project-osrm.org).
- Fonts: [Geist](https://vercel.com/font) and [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif), via Google Fonts.
