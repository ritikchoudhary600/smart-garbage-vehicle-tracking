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
│  • Hysteresis debounce (re-arm +50 m beyond) │
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

- **The web page is static** (`public/`), so any static host serves it. It is ready for **Vercel** (`vercel.json`).
- **Supabase is the backend**: Google sign-in (Supabase Auth), the database (households, fleet, pickups, notifications, settings, audit log) and live updates (Supabase Realtime). Everything is in `supabase/migrations/`. The geofence, pickup status changes and analytics run **inside the database**, so a browser can't fake them, and row-level security decides what each person can see.
- **Offline demo mode**: with no Supabase settings, the same page runs the original in-browser engine (`public/js/dataStore.js`) and keeps everything in the tab. That is what you get from `npm start` until you add a `.env`.
- **The Node server** (`server/`) is only for local development: it serves the page and the legacy REST + SSE demo API (see [section 12](#12-legacy-rest--sse-api)). It is not deployed.

```
 Browser (Vercel or localhost)                 Supabase
┌──────────────────────────────┐   HTTPS   ┌──────────────────────────────┐
│ index.html + public/js       │ ────────► │ Auth: Sign in with Google     │
│  auth.js       sign-in gate   │           │ Postgres + row-level security │
│  supabaseStore realtime data  │ ◄──────── │ RPC: geofence, pickups, stats │
│  app.js        portals        │ Realtime  │ Realtime: live table changes  │
│  controlPanel  Control room   │ (wss)     │ Audit log (database triggers) │
│  deviceAccess  GPS & alerts   │           └──────────────────────────────┘
└──────────────────────────────┘
```

Supabase can't serve the web page itself on its default domain (it only serves HTML through a paid custom domain, and doesn't support that for websites), so the page goes on Vercel.

---

## 3. Algorithms

### A. 500-metre geofence (Haversine formula)

Great-circle distance between the vehicle $(\phi_1, \lambda_1)$ and a household $(\phi_2, \lambda_2)$:

$$a = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)$$
$$d = 2R \cdot \text{atan2}\left(\sqrt{a}, \sqrt{1-a}\right) \quad (R = 6{,}371{,}000\text{ m})$$

- **Alert:** when $d \le 500\text{ m}$, the household receives:
  > *"Garbage collection vehicle is approximately 480 m away. Please keep your garbage ready."*
- **Each household's own distance:** 500 m is the ward default. A resident can choose their own alert distance $r$ (100 m to 2 km by default; admins set the range). A household that hasn't chosen uses the default.
- **Hysteresis debounce:** the alert fires once per approach. It re-arms only after the vehicle moves beyond $r + 50\text{ m}$ (the re-arm buffer, adjustable by admins), so GPS jitter around the boundary never causes repeat alerts.

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

### Sign in with Google and roles

Everyone signs in with Google. Their **role** decides what they see:

| Role | Sees | Can do |
|---|---|---|
| **Waiting for approval** | A "waiting for approval" screen | Nothing until an admin approves them (only when Settings › New sign-ins is "Wait for approval") |
| **Resident** | The Resident portal for **their own** household(s) only | Register their household, mark bins ready, request pickups, get the quiet alert |
| **Driver** | The Driver portal | Drive **the vehicle assigned to them** (simulator or live GPS), work the pickup queue, report delays |
| **Admin** | Every portal, plus the **Control** room | Everything below |

- New Google sign-ins join as residents by default; an admin can switch that to "wait for approval".
- A **suspended** account sees an "access paused" screen. A role or access change reaches an open app straight away, and the app reloads.
- The database enforces all of this with row-level security. Residents can't read each other's households, pickups or alerts, and nobody can promote themselves.

### Control room (admins)

| Section | What you can do |
|---|---|
| **People** | Everyone who has signed in, with search and a role filter. Approve sign-ins, change roles, suspend or restore access, edit name and phone, link a resident to a house and a driver to a vehicle. A banner appears when someone is waiting for approval. |
| **Fleet** | Add, edit and remove vehicles (ID, registration, capacity, status: active, in maintenance or retired) and assign the driver on duty. Assigning a driver moves them off any other vehicle. |
| **Households** | The household register: add, edit, remove, pin the location (optionally from your current position) and link the resident's account. Also lists pickup requests, so you can remove duplicate or test ones. |
| **Settings** | Ward name, time zone (when "today" starts on the dashboard), the **default alert distance**, the **range residents can choose their own distance from**, the **re-arm buffer**, the new sign-in policy, and dashboard baselines. Every open app picks up changes live. Narrowing the range applies at once: a household that chose more than the new maximum is capped at it. |
| **Audit log** | Who changed what and when, with before → after values, filterable by area. The database writes it with triggers, so nobody can edit it from the app, and truck movements are left out so the log stays readable. |

Guard rails: there is always at least one active admin, only people with the driver role can be assigned to a vehicle, the default alert distance must sit inside the range residents choose from, and removals ask for confirmation. Admins can also set any household's alert distance under **Households**, where an **Alert at** column shows each one.

### Device permissions

The app asks once after sign-in (and again from the account menu › **Device permissions**). Every prompt follows a tap, as browsers require.

| Permission | Who | Why |
|---|---|---|
| **Notifications** | Everyone | The 500 m alert, pickup updates and delay notices, as system notifications while the tab is in the background. A tiny service worker (`public/sw.js`) shows them, as Android Chrome requires. |
| **Location** | Drivers | **Share live location**: the truck follows the driver's phone GPS instead of the simulator. Fixes go out every 4 s or 15 m; fixes less accurate than 150 m are skipped. Only while sharing is on. |
| | Residents and admins (optional) | Registering a household opens a small map on your **current location** with a pin you can drag (or tap the map) onto your gate. Used once, never tracked. |
| **Sound** | Everyone | Browsers keep audio off until a tap; this switches on the soft arrival chime. |
| **Keep screen on** | Drivers | A screen wake lock while sharing GPS, because phones stop browser GPS updates when the screen locks. |

Camera and microphone are not used. A blocked permission shows how to allow it again in the browser's site settings.

> Limits of a web app: alerts reach a phone while the app is open (even in a background tab), but not after the browser is fully closed, and drivers have to keep the app open while sharing GPS. Delivery to a closed browser would need Web Push (VAPID keys plus a Supabase Edge Function); background GPS would need a native app.

### Resident
- Live distance to the household, vehicle heading, ETA and current locality, with a progress track marking the 500 m zone.
- **Quiet alert:** a banner plus a soft three-note chime (C–E–G, synthesised with the Web Audio API). It plays once per approach, only for the household selected, and can be muted with the bell in the top bar.
- **Alert me at (customisable):** each household picks how far away the truck should be when the alert arrives. Use the slider or the quick choices (200 m, 500 m, 1 km, 1.5 km); the panel shows the warning time at a truck's typical pace (e.g. 1 km ≈ 3 min). A link returns to the ward default. The distance track, map legend and the ring around the truck on the resident's map follow the chosen distance. It's saved per household, so it applies on every device.
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
- **Real roads (demo simulator).** The simulator's Ward 4 route in Koramangala, Bengaluru follows actual streets. In a real deployment elsewhere, trucks move from drivers' **live GPS** instead. It was generated once from the public [OSRM](https://project-osrm.org) routing service and saved in `public/js/routeData.js`, so the app works without contacting OSRM. Each waypoint carries the road geometry that leads to it.
- **Smooth motion.** The truck glides along the road geometry between waypoints at constant speed while playing, with sub-pixel positioning and a heading arrow that eases toward the road 15 m ahead. A green trail marks the distance covered, and the dashed 500 m ring moves with the truck.
- Each map is created the first time its view opens. The Municipal fleet map only zooms with the scroll wheel after it is clicked, so scrolling the page isn't hijacked.
- **Maps open where you are, not on the demo.** A resident's map frames their own household (plus the truck when it's within 5 km), the Driver map frames the truck and its nearby pickups, and the Municipal map frames every household and the trucks working near them. The Bengaluru demo route is shown only when there is nothing else to show. Every map has a **locate me** button (blue dot with its accuracy circle).
- **Pinning a household.** The register and edit dialogs open a street map on the device's current location, with a pin to drag or a tap to move. Phones use GPS (a few metres). A laptop's browser often only knows roughly where it is from Wi-Fi or the internet connection, sometimes a different city. When the fix is rougher than 250 m the dialog says so and asks you to drag the pin onto the gate. Coordinates can still be typed in.
- Area names (e.g. "Ward 4 – Palm Avenue") exist only for the demo ward; elsewhere the app shows coordinates rather than a wrong name.

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
- An internet connection for map tiles, fonts and the MapLibre and Supabase libraries (loaded from CDNs).
- For the database: a Supabase project, or Docker plus the Supabase CLI (`npx supabase`) for a local copy.

### Run locally: offline demo

```bash
npm start
```

On Windows you can also double-click `start.bat`. Then open http://localhost:3000 and choose **Explore the offline demo**: you are a demo admin with demo people, and nothing is saved. Set the `PORT` environment variable to use a different port.

| Portal | URL |
|---|---|
| Resident | http://localhost:3000/#resident |
| Driver | http://localhost:3000/#driver |
| Municipal | http://localhost:3000/#admin |
| Split demo | http://localhost:3000/#split |
| Control room | http://localhost:3000/#control |

### Run locally against Supabase

1. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (your hosted project, or the local stack below).
2. `npm start`. The server log shows `🔐 Supabase: … (Google sign-in on)`, and `/js/config.js` is served from `.env`.

**Local Supabase stack** (Docker):

```bash
npm run db:start        # first run downloads the Supabase images
npx supabase status     # prints API_URL and PUBLISHABLE_KEY for .env
npm run db:reset        # re-applies the migration and the demo seed
npm run db:stop
```

For Google sign-in against the local stack, copy `supabase/.env.example` to `supabase/.env`, add a Google OAuth client ID and secret, and add `http://127.0.0.1:54321/auth/v1/callback` as an authorized redirect URI on that Google client.

---

## 8. Deploy on Supabase

Supabase runs the backend. You don't deploy any server code: the migration creates everything.

### 1. Create the project
Create a project at [supabase.com/dashboard](https://supabase.com/dashboard). From **Connect** (or **Project Settings › API**), note:
- the **Project URL**: `https://<project-ref>.supabase.co`
- the **anon / publishable key**: this one goes in the browser
- *not* the service-role / secret key: never put it in the app (the build refuses it)

### 2. Create the database
Either with the CLI:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push            # applies supabase/migrations/*.sql
```

or in the dashboard's **SQL Editor**: paste and run each file in `supabase/migrations/` **in order** (`20261124120000_control_management.sql`, then `20261124130000_custom_alert_distance.sql`). If you already ran the first one, run only the second.

Optional demo data (Ward 4 houses, truck GV-04, two pickups): run `supabase/seed.sql` in the SQL Editor. Skip it for a real deployment and add your fleet and households in the Control room instead.

The migration also adds the tables to Realtime. Check that **Database › Publications › supabase_realtime** lists them.

### 3. Turn on Sign in with Google
1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials): **Create credentials › OAuth client ID › Web application**.
   - **Authorized JavaScript origins**: your site, e.g. `https://your-app.vercel.app` (and `http://localhost:3000` for local testing)
   - **Authorized redirect URIs**: `https://<project-ref>.supabase.co/auth/v1/callback`
   - Configure the OAuth consent screen (app name, support email, scopes `email`, `profile`, `openid`).
2. In Supabase: **Authentication › Sign In / Providers › Google**: enable it and paste the client ID and secret.
3. In Supabase: **Authentication › URL Configuration**:
   - **Site URL**: `https://your-app.vercel.app`
   - **Redirect URLs**: add `https://your-app.vercel.app/**`, `http://localhost:3000/**`, and for Vercel preview deployments `https://*-<your-vercel-team>.vercel.app/**`

### 4. Make yourself the first admin
Sign in once with Google (you'll land as a resident), then in the **SQL Editor**:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

Reload the app: the **Control** tab appears. From then on, manage everyone from **Control › People**.

### What the migration creates

| Object | Purpose |
|---|---|
| `profiles` | One row per Google sign-in: name, picture, phone, **role**, **status**. Created automatically by a trigger on `auth.users`. |
| `households`, `vehicles`, `pickup_requests`, `notifications`, `emergency_reports` | The app's data. |
| `app_settings` | One row of settings (ward, time zone, default alert distance, the range residents choose from, re-arm buffer, sign-up policy, baselines). |
| `audit_log` | Written only by triggers; readable only by admins. |
| RPC functions | `me`, `get_analytics`, `report_vehicle_position` (moves a truck and runs the geofence with each household's own distance), `reset_geofences`, `register_household`, `set_garbage_ready`, `set_alert_radius`, `create_pickup_request`, `set_pickup_status`, `report_issue`. Each checks the caller's role. |
| Row-level security | On every table. Admin-only writes are also limited to specific columns. |

---

## 9. Deploy to Vercel

The code is ready for Vercel; nothing in this repository is linked to a Vercel account.

1. Import the repository in Vercel (or run `vercel` from this folder). If the repository has other folders, set **Root Directory** to the folder holding `vercel.json`.
2. **Settings › Environment Variables**, for Production (and Preview if you use it):
   - `SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `SUPABASE_ANON_KEY` = the anon / publishable key

   Until both are set, the site deploys as the **offline demo** (the build log says so). Environment variables only reach new builds, so **redeploy** after adding or changing them.
3. Deploy. `vercel.json` already sets everything else:
   - **Build command** `node scripts/build-config.js` writes `public/js/config.js` from those two variables. It **fails the build** on a real mistake: only one of the two set, a malformed URL, or the service-role / secret key pasted instead of the anon key.
   - **Output directory** `public/` (`server/`, `supabase/` and `test/` are not served).
   - **Security headers** on every response:

     | Header | Purpose |
     |---|---|
     | `Content-Security-Policy` | Only loads code from this site and `unpkg.com` (MapLibre, Supabase JS), styles and fonts from Google Fonts, map data from `tiles.openfreemap.org`, profile pictures from `*.googleusercontent.com`; talks only to `*.supabase.co` (HTTPS + Realtime WebSocket); blocks framing and plugins |
     | `Permissions-Policy` | Allows **location** and **screen wake lock** for this site only; turns off camera, microphone, payment and USB |
     | `X-Content-Type-Options: nosniff` | Stops MIME-type guessing |
     | `X-Frame-Options: DENY` | Blocks clickjacking in older browsers |
     | `Referrer-Policy` | Sends only the origin to other sites |

4. Add the deployed URL to Supabase (**Authentication › URL Configuration**) and to the Google OAuth client, as in [section 8](#8-deploy-on-supabase).

If you use a **custom Supabase domain**, add it to `connect-src` (both `https://` and `wss://`) in `vercel.json`. If you add another external service, add its host to the matching CSP directive or the browser will block it. The MapLibre and Supabase scripts carry Subresource Integrity hashes; if you upgrade either, update the version and the `integrity` hash in `public/index.html`.

---

## 10. Project structure

```
project/
├── public/                    Web app (served as-is)
│   ├── index.html             Sign-in gate, five portals, simulator bar and dialogs
│   ├── sw.js                  Service worker: shows notifications only, caches nothing
│   ├── favicon.svg            Logo mark for the browser tab
│   ├── css/styles.css         Design system: colour tokens, typography, layout (see section 6)
│   └── js/
│       ├── config.js          Supabase URL + anon key (generated; empty = offline demo)
│       ├── auth.js            Google sign-in, approval / suspended screens, start-up
│       ├── supabaseStore.js   Data from Supabase + Realtime (same API as dataStore.js)
│       ├── dataStore.js       Offline demo engine: geofence, pickups, analytics, demo people
│       ├── controlPanel.js    Control room: people, fleet, households, settings, audit log
│       ├── deviceAccess.js    Location, notifications, sound, wake lock, live GPS
│       ├── locationPicker.js  Map pin for a household's gate (current location, drag, tap)
│       ├── app.js             UI controller: role-aware portals, forms, maps, simulator bar
│       ├── geoUtils.js        Haversine, bearing, compass octants, locality, ETA
│       ├── routeData.js       Road-snapped Ward 4 route (generated from OSRM)
│       ├── simulatorEngine.js Play / step / reset / teleport along the route
│       ├── audioChime.js      Web Audio arrival and collection chimes
│       └── mapManager.js      MapLibre maps, markers, route/trail layers, vehicle animation
├── supabase/
│   ├── config.toml            Supabase CLI config (local stack, Google provider, redirect URLs)
│   ├── migrations/            Schema, row-level security, RPC functions, audit triggers, Realtime
│   ├── seed.sql               Demo data (optional)
│   └── .env.example           Google OAuth client for the local stack
├── scripts/build-config.js    Writes public/js/config.js from env vars (Vercel build step)
├── server/                    Local dev server + legacy REST/SSE demo API
├── test/
│   ├── runTests.js            Engine tests (no database needed)
│   └── supabaseRls.test.js    Database rules tests against the local Supabase stack
├── .env.example               SUPABASE_URL / SUPABASE_ANON_KEY for npm start
├── start.bat                  Windows launcher
└── vercel.json                Build command, output folder, security headers
```

The route and household coordinates in `server/dataStore.js` and `supabase/seed.sql` are kept in sync with `public/js/routeData.js`.

---

## 11. Tests

```bash
npm test
```

Engine tests: Haversine distance, bearing and compass octants, locality detection, the 500 m geofence and its debounce, pickup requests, garbage-ready, household registration, driver switching and simulator controls (13 tests).

```bash
npm run db:start
# then, with the keys from `npx supabase status`:
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<ANON_KEY> SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY> npm run test:supabase
```

Database rules tests (62 checks) through the real Supabase APIs: profiles and roles, a resident can't promote themselves, residents can't see or change each other's households, pickups or alerts, the geofence alerts once and re-arms only past the buffer, each household's chosen alert distance (inside the admin's range, capped when the range narrows), drivers can only move their own truck, closed pickups stay closed, settings validation, approval and suspension, the last-admin guard, and the audit log. The test only runs against a local stack (it creates and deletes users).

---

## 12. Legacy REST + SSE API

Served by `server/server.js` for local experiments and used by `npm test`. It keeps its own in-memory state and is **not** connected to Supabase or deployed.

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

## 13. Demo script

1. **Open the split view:** http://localhost:3000/#split (in the offline demo, or signed in as an admin). Click anywhere once so the browser allows sound.
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
10. **Households:** switch households from the dropdown in the Resident view, or click **Register** to add one with its own coordinates. Under **Alert me at**, pick **1 km** and jump to **900 m Palm Ave**: House 125 is alerted there, which it wouldn't be at the default 500 m.
11. **Control room:** open **Control**. Approve the person waiting under **People**, assign a different driver to GV-04 under **Fleet**, change the default alert distance or the allowed range under **Settings** (the ring and labels update everywhere), then open **Audit log** to see each change with before → after values.
12. **Permissions:** open the account menu (your initials, top right) › **Device permissions** to allow notifications, location and the chime. In the Driver view, **Share live location** drives the truck from your device's GPS.

---

## 14. Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors; tiles by [OpenFreeMap](https://openfreemap.org) using the [OpenMapTiles](https://openmaptiles.org) schema.
- Map rendering by [MapLibre GL JS](https://maplibre.org); route geometry from [OSRM](https://project-osrm.org).
- Sign-in, database and live updates by [Supabase](https://supabase.com).
- Fonts: [Geist](https://vercel.com/font) and [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif), via Google Fonts.
