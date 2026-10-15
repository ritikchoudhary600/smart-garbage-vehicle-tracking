# Smart Garbage Vehicle Tracking & Automated Waste Collection Management System 🚛🌿

A full-stack, quiet smart-city prototype designed to **eliminate residential loudspeaker noise pollution** by replacing megaphone announcements with GPS-based **500-metre geofenced mobile notifications**, real-time **direction detection**, away-from-home **pickup requests**, and a **municipal monitoring dashboard**.

---

## 1. Problem Addressed

Traditional municipal garbage collection trucks repeatedly broadcast announcements over loudspeakers to alert residents to bring out their garbage. This causes severe **noise pollution** in residential neighborhoods, disturbing sleeping infants, senior citizens, students, and night-shift workers.

Furthermore, residents currently lack digital visibility into:
1. **Live GPS location** of the garbage truck.
2. **Current locality** and approaching direction.
3. **Accurate arrival timing (ETA)** to bring bins out without long waits on the street.
4. **Pickup requests when away from home**, resulting in missed collections and accumulating waste.

---

## 2. Solution Overview

This system provides a clean, modern digital ecosystem connecting residents, collection truck drivers, and municipal administrators:

```
┌──────────────────────────────────────────────┐
│  GPS Tracker / Interactive Route Simulator   │
└──────────────────────┬───────────────────────┘
                       │ (Lat, Lon, Speed, Bearing)
                       ▼
┌──────────────────────────────────────────────┐
│      Node.js REST & SSE Telemetry Engine     │
├──────────────────────────────────────────────┤
│  • Haversine Distance (d <= 500m Geofence)   │
│  • Bearing & Octant Direction (N, NE, E...)  │
│  • Hysteresis Debounce Filter (Exit > 550m)  │
│  • Away-From-Home Pickup State Machine       │
│  • Municipal Noise-Pollution Analytics       │
└──────────────┬───────────────┬───────────────┘
               │               │
       ┌───────┴──────┐ ┌──────┴────────┐
       ▼              ▼ ▼               ▼
┌──────────────┐ ┌─────────────┐ ┌──────────────┐
│ Resident App │ │ Driver App  │ │ Admin Portal │
└──────────────┘ └─────────────┘ └──────────────┘
```

---

## 3. Key Mathematical & Algorithmic Models

### A. 500-Metre Geofence (Haversine Formula)
Calculates the great-circle distance between the vehicle $(\phi_1, \lambda_1)$ and registered household $(\phi_2, \lambda_2)$:
$$a = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)$$
$$d = 2R \cdot \text{atan2}\left(\sqrt{a}, \sqrt{1-a}\right) \quad (R = 6,371,000\text{ m})$$

- **Automatic Alert**: When $d \le 500\text{ m}$, fires:
  > *“Garbage collection vehicle is approximately 500 m away. Please keep your garbage ready.”*
- **Hysteresis Debounce**: Once triggered, suppresses duplicate alerts while the vehicle remains within $500\text{ m}$. Re-triggering occurs only when the vehicle leaves the zone ($> 550\text{ m}$) and subsequently re-enters.

### B. Direction & Bearing Calculation
Calculates the vehicle's heading angle relative to true north from consecutive GPS points:
$$\theta = \text{atan2}\left(\sin(\Delta\lambda)\cos(\phi_2), \; \cos(\phi_1)\sin(\phi_2) - \sin(\phi_1)\cos(\phi_2)\cos(\Delta\lambda)\right)$$
$$\text{bearing} = (\theta \cdot 180 / \pi + 360) \pmod{360}$$

**Octant Compass Mapping:**
- **North (↑)**: $337.5^\circ - 22.5^\circ$
- **Northeast (↗)**: $22.5^\circ - 67.5^\circ$
- **East (→)**: $67.5^\circ - 112.5^\circ$
- **Southeast (↘)**: $112.5^\circ - 157.5^\circ$
- **South (↓)**: $157.5^\circ - 202.5^\circ$
- **Southwest (↙)**: $202.5^\circ - 247.5^\circ$
- **West (←)**: $247.5^\circ - 292.5^\circ$
- **Northwest (↖)**: $292.5^\circ - 337.5^\circ$

---

## 4. User Portals & Features

### 📱 1. Resident App
- **Live Vehicle Telemetry**: Real-time distance countdown, heading arrow, and dynamic ETA.
- **500m Geofence Notification**: Animated alert banner + melodic digital chime (synthesized via Web Audio API) replacing harsh loudspeakers.
- **[Garbage Ready]** button: Informs driver that bins are placed outside the gate.
- **[Pickup Request (When Away)]**: Allows resident to request garbage pickup when absent with address, landmark, and notes.
- **Pickup Request Status**: Visual stage tracker (`Pending` $\rightarrow$ `Accepted` $\rightarrow$ `Collected`).
- **Notification History**: Detailed log of past arrivals and status updates.

### 🚛 2. Driver / Vehicle In-Cab App
- **Driver Profile**: Driver name (Ramesh Kumar), Vehicle ID (`#GV-04`), current speed and locality.
- **In-Cab Navigation Map**: Displays vehicle path, registered houses, and pending pickup locations.
- **Pickup Requests Queue**:
  - Displays house number, landmark, resident notes, and distance.
  - One-click **"Mark as Collected"** button which immediately notifies the resident and increments municipal metrics.
- **Issue / Emergency Reporting**: One-tap delay notice broadcast (traffic block, puncture, compactor full).

### 🏛️ 3. Municipal / Admin Dashboard
- **Citywide Fleet Map**: Live tracking of active garbage trucks, route trails, and households.
- **Noise-Reduction Analytics**:
  - **Loudspeaker Announcements Avoided** counter (tracks every loud broadcast replaced by a digital notification).
  - **Decibel-Hours Saved** (estimates dB exposure spared across residential sectors).
  - **Collection Efficiency Rate (%)** and on-schedule performance.
- **Fleet Telemetry & Household Records**: Full tables with real-time status.

### 🔀 4. Split Demo Mode (Presentation View)
- Renders the **Resident App** (mobile phone frame) and **Driver Navigation App** side-by-side.
- Allows immediate demonstration where moving the simulated vehicle updates the driver map while simultaneously triggering the 500m geofence chime alert on the resident phone!

### 🎮 5. GPS Route Simulator
- Built-in simulation controller with:
  - Play / Pause simulation
  - Speed multipliers: `1x (Normal)`, `2x (Fast)`, `4x (Rapid)`
  - Manual Step Forward / Step Backward
  - **Quick-Jump Scenario Buttons**:
    * `1.3 km Start`
    * `900 m Palm Ave`
    * `720 m House 88`
    * `🚨 480 m (500m Geofence Trigger)`
    * `150 m Approach`
    * `🏠 House 125 Arrival`

---

## 5. Getting Started

### Prerequisites
- Node.js (v18+ or v24+)

### Running the Application

1. **Start the Server**:
   ```bash
   node server/server.js
   ```
   *Alternatively on Windows, double-click `start.bat`.*

2. **Open the Web Application**:
   Navigate to:
   ```
   http://localhost:3000
   ```

3. **Access Specific Portals**:
   - Resident App: `http://localhost:3000#resident`
   - Driver App: `http://localhost:3000#driver`
   - Municipal Admin Dashboard: `http://localhost:3000#admin`
   - Split Presentation Mode: `http://localhost:3000#split`

---

## 6. Running Automated Tests

Run the built-in test suite verifying Haversine calculations, bearing math, octant mapping, geofence debounce, away-from-home pickups, household registration, and simulation controls:

```bash
node test/runTests.js
```

Expected output:
```
🧪 Starting Automated Test Suite for Smart Garbage Vehicle System...

  ✅ PASS: Haversine distance returns accurate distance in meters
  ✅ PASS: Haversine distance between identical points is zero
  ✅ PASS: Bearing calculation correctly identifies Northeast direction
  ✅ PASS: Bearing octants map all 8 cardinal & ordinal directions accurately
  ✅ PASS: Locality detection identifies Green Glen Residential Sector
  ✅ PASS: 500-metre geofencing triggers alert only when distance <= 500m
  ✅ PASS: Resident can create away-from-home pickup request and driver can collect it
  ✅ PASS: Resident can mark garbage ready outside gate
  ✅ PASS: Simulation playback advances waypoints correctly
  ✅ PASS: Resident can register a new household or update profile
  ✅ PASS: Pickup request supports Accepted and Missed status flows
  ✅ PASS: Driver profile can be switched on active vehicle
  ✅ PASS: Simulator can teleport by coordinates and calculates route progress

------------------------------------------------------------
Test Results: 13 / 13 passed.
🎉 ALL TESTS PASSED SUCCESSFULLY!
```

---

## 7. Step-by-Step Demonstration Script

1. **Launch Split Presentation View**:
   Open `http://localhost:3000#split` in your web browser.
2. **Explore Initial State**:
   In the top simulator bar, click **"1.3 km Start"**. Notice on the resident phone that the vehicle is ~1.3 km away (`Northeast ↗`).
3. **Advance Vehicle Along Route**:
   Click **"900 m"** then **"720 m"**; observe the distance counter, dynamic ETA, and progress track moving closer.
4. **Trigger 500m Geofence Alert**:
   Click **"🚨 480 m (500m Trigger)"**:
   - The resident phone displays the glowing **"🚨 Garbage Vehicle Approaching (500m)"** banner:
     > *“Garbage collection vehicle is approximately 480 m away. Please keep your garbage ready.”*
   - A melodic 3-tone electronic chime sounds via the Web Audio API (completely replacing harsh loudspeakers).
   - A toast notification pops up.
   - The municipal metric increments: **+1 Loudspeaker Announcement Avoided**.
5. **Demonstrate Away-From-Home Pickup**:
   On the resident phone, click **"Request Pickup (Away)"**, enter instructions (*"Bags kept beside gate"*), and click **Submit**.
6. **Driver Navigation & Collection**:
   On the Driver screen, the pickup request appears instantly.
   - Click **"Accept Pickup"**: Resident is informed driver is heading towards them.
   - Click **"Mark as Collected"**:
     * Request turns green (`Collected`).
     * Confirmation ding plays.
     * Resident screen immediately updates with: *"Collected by Driver Ramesh Kumar"*.
7. **Switch Households & Register New House**:
   - Use the **Resident Account dropdown** to switch between House 125, House 102, House 88, or House 144.
   - Click **"+ Register"** to register a new household with custom address, landmark, and GPS coordinates.
8. **Inspect Municipal Admin Dashboard (`#admin`)**:
   - View the **Zero-Noise Municipal Geofence System** comparison widget (**85 dB Loudspeaker Blasts vs 25 dB Silent Push Alerts**).
   - View total decibel-hours saved and announcements avoided.
   - Review the active collection fleet, registered houses, and pickup requests table.
   - Click anywhere on the **Municipal Fleet Map** to directly teleport the simulated vehicle to custom coordinates!
