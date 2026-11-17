
import { DescentSettings, WindSettings, TerrainSettings, WindLayer, LandingSettings } from '../types';

// Constants
const R_EARTH = 6371e3; // Earth radius (m)
const G = 9.81;         // Gravity (m/s^2)
const R_GAS = 287.05;   // Specific gas constant for dry air (J/(kg·K))
const T_STD = 288.15;   // Standard Temp at sea level (K)
const P_STD = 101325;   // Standard Pressure at sea level (Pa)
const L_RATE = 0.0065;  // Temp lapse rate (K/m)

/**
 * Calculates the Great Circle distance between two points (Haversine)
 */
export const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R_EARTH * c;
};

/**
 * Calculates speed between two telemetry points
 */
export const calculateSpeed = (
  prevLat: number, prevLon: number, prevTime: number, 
  currLat: number, currLon: number, currTime: number
): number => {
  const dist = calculateDistance(prevLat, prevLon, currLat, currLon);
  const timeDiff = (currTime - prevTime) / 1000;
  if (timeDiff <= 0) return 0;
  return dist / timeDiff;
};

/**
 * Simple low-pass filter for speed smoothing
 */
export const calculateSmoothedSpeed = (history: any[], windowSize = 5): number => {
  if (history.length < 2) return 0;
  // Use a sliding window 
  const endIndex = history.length - 1;
  const startIndex = Math.max(0, endIndex - windowSize);
  
  if (startIndex === endIndex) return 0;

  const startPoint = history[startIndex];
  const endPoint = history[endIndex];

  let totalDist = 0;
  for(let i = startIndex; i < endIndex; i++) {
     totalDist += calculateDistance(
       history[i].latitude, history[i].longitude, 
       history[i+1].latitude, history[i+1].longitude
     );
  }

  const timeDiff = (endPoint.timeElapsed - startPoint.timeElapsed) / 1000; 
  if (timeDiff <= 0.1) return 0;

  return totalDist / timeDiff; 
};

export const calculateTotalDistance = (history: {latitude: number, longitude: number}[]): number => {
  let total = 0;
  for (let i = 1; i < history.length; i++) {
    total += calculateDistance(
      history[i-1].latitude, history[i-1].longitude,
      history[i].latitude, history[i].longitude
    );
  }
  return total;
};

// --- AETHER: ADVANCED PHYSICS MODULE ---

/**
 * Calculates Air Density (rho) at a given altitude using ISA model
 * Optionally scales based on a known reference density.
 */
export const getAirDensity = (altitude: number, refDensity: number = 0, refAlt: number = 0): number => {
  if (altitude > 40000) return 0; // Space

  // Standard ISA Calculation
  const temperature = T_STD - (L_RATE * altitude);
  const pressure = P_STD * Math.pow(1 - (L_RATE * altitude) / T_STD, 5.2561);
  const isaDensity = pressure / (R_GAS * temperature);

  // If we have a live sensor reading, use it to scale the ISA model
  if (refDensity > 0.1) {
      // Calculate what ISA thinks density is at the reference altitude
      const refTemp = T_STD - (L_RATE * refAlt);
      const refPress = P_STD * Math.pow(1 - (L_RATE * refAlt) / T_STD, 5.2561);
      const refIsaDensity = refPress / (R_GAS * refTemp);
      
      // Scale factor
      const factor = refDensity / refIsaDensity;
      return isaDensity * factor;
  }

  return isaDensity;
};

/**
 * Gets the interpolated wind vector at a specific altitude
 */
export const getWindAtAltitude = (alt: number, settings: WindSettings): { speed: number, dir: number } => {
  if (settings.mode === 'single') {
    // AETHER FIX: Prioritize active 'speed'/'direction' over legacy 'windSpeed'
    // Using nullish coalescing to ensure 0 is treated as a valid value
    const s = settings.speed ?? settings.windSpeed ?? 0;
    const d = settings.direction ?? settings.windDirection ?? 0;
    return { speed: s, dir: d };
  }

  const layers = settings.layers || [];
  if (layers.length === 0) return { speed: 0, dir: 0 };
  
  if (alt <= layers[0].altitude) return { speed: layers[0].speed, dir: layers[0].direction };
  if (alt >= layers[layers.length - 1].altitude) return { speed: layers[layers.length - 1].speed, dir: layers[layers.length - 1].direction };

  for (let i = 0; i < layers.length - 1; i++) {
    const lower = layers[i];
    const upper = layers[i+1];
    if (alt >= lower.altitude && alt <= upper.altitude) {
      const ratio = (alt - lower.altitude) / (upper.altitude - lower.altitude);
      return {
        speed: lower.speed + (upper.speed - lower.speed) * ratio,
        dir: lower.direction + (upper.direction - lower.direction) * ratio
      };
    }
  }

  return { speed: 0, dir: 0 };
};

/**
 * Moves a lat/lon point by meters using spherical approximation
 */
const displaceCoordinate = (lat: number, lon: number, dx: number, dy: number): { lat: number, lon: number } => {
  const rLat = lat * Math.PI / 180;
  const dLat = (dy / R_EARTH) * (180 / Math.PI);
  // longitude scaling changes with latitude
  const dLon = (dx / (R_EARTH * Math.cos(rLat))) * (180 / Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
};

export interface LandingPrediction {
  lat: number;
  lon: number;
  timeToImpact: number; // seconds
  confidenceRadius: number; // meters
  path: { lat: number, lon: number, alt: number }[]; // 3D path for visualization
}

/**
 * THE AETHER PHYSICS PREDICTOR (High Fidelity)
 */
export const predictLanding = (
  lat: number, lon: number, alt: number,
  vSpeedCurrent: number, // m/s (Positive = Up)
  hSpeedCurrent: number, // m/s
  headingCurrent: number, // Degrees (0=N, 90=E)
  descentSettings: DescentSettings,
  windSettings: WindSettings,
  landingSettings: LandingSettings, // New: Pass full settings for fusion config
  groundAlt: number = 0,
  currentDensity: number = 0, // Live sensor data
  history: {latitude: number, longitude: number, timeElapsed: number}[] = [] // History for Vector Calc
): LandingPrediction | null => {
  
  // 1. Sanity Checks
  if (alt < 5) return null; // Too close to ground
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return null; // Invalid GPS

  // 2. Initialize Velocity Vectors (vN, vE)
  
  // A. GPS Ground Track Vector (Differential History)
  let vN_gps = 0;
  let vE_gps = 0;
  let hasGpsVec = false;

  if (history.length >= 3) {
      // Look at last few points to average the vector and remove jitter
      const pLast = history[history.length - 1];
      const pPrev = history[history.length - 3]; // Go back 2 steps for stability
      
      const dtHist = (pLast.timeElapsed - pPrev.timeElapsed) / 1000;
      
      if (dtHist > 0.1 && dtHist < 3.0) {
          const metersPerDegLat = 111320;
          const metersPerDegLon = 111320 * Math.cos(pLast.latitude * Math.PI / 180);
          
          const dLat = pLast.latitude - pPrev.latitude;
          const dLon = pLast.longitude - pPrev.longitude;
          
          vN_gps = (dLat * metersPerDegLat) / dtHist;
          vE_gps = (dLon * metersPerDegLon) / dtHist;
          hasGpsVec = true;
      }
  }

  // B. IMU Heading Vector (Instantaneous "Nose" Direction)
  // 0 deg = North, 90 deg = East
  const radHeading = headingCurrent * (Math.PI / 180);
  const vN_imu = hSpeedCurrent * Math.cos(radHeading);
  const vE_imu = hSpeedCurrent * Math.sin(radHeading);

  // C. Fusion Logic (Based on Settings)
  let vN = 0;
  let vE = 0;
  const source = landingSettings.headingSource;
  
  // Default to Auto logic if no GPS vector found (fallback)
  if (!hasGpsVec) {
      vN = vN_imu;
      vE = vE_imu;
  } else {
      if (source === 'gps') {
          vN = vN_gps;
          vE = vE_gps;
      } else if (source === 'imu') {
          vN = vN_imu;
          vE = vE_imu;
      } else {
          // Fused or Auto
          let gpsWeight = 0.5;
          
          if (source === 'fused') {
              gpsWeight = landingSettings.gpsWeight !== undefined ? landingSettings.gpsWeight : 0.5;
          } else {
              // AUTO MODE:
              // If moving significantly (guided/flying), weight the IMU heading more to capture turns (low GPS weight).
              // If drifting (low speed), weight GPS more as Heading might be spinning/irrelevant (high GPS weight).
              const isGuided = hSpeedCurrent > 5.0; 
              // If user provided a manual bias for Auto, we could use it, but standard Auto usually infers:
              gpsWeight = isGuided ? 0.3 : 0.8; 
          }
          
          vN = (vN_gps * gpsWeight) + (vN_imu * (1 - gpsWeight));
          vE = (vE_gps * gpsWeight) + (vE_imu * (1 - gpsWeight));
      }
  }

  let vU = vSpeedCurrent; // Up is Positive

  // 3. Initialize State Vectors
  let currentLat = lat;
  let currentLon = lon;
  let currentAlt = alt;
  
  let t = 0;
  const path = [];
  
  // Physics Settings
  const dt = 0.2; // 0.2s time step for high accuracy
  const MAX_STEPS = 18000; // Max 1 hour simulation
  
  let steps = 0;

  // AETHER FIX 1: Detect Flight Phase (Ascent vs Descent)
  // If climbing, we shouldn't use parachute drag yet.
  let isAscending = vU > 0;

  // 4. Simulation Loop
  while (currentAlt > groundAlt && steps < MAX_STEPS) {
    // Determine active physics parameters based on phase
    let mass, area, cd;

    if (isAscending) {
        // BALLISTIC ASCENT MODEL
        // If we don't have the exact rocket mass here (because predictLanding assumes descent), 
        // we approximate a heavy, low-drag object to find apogee.
        // Heuristic: Mass = Payload * 2 (approx empty rocket), Cd = 0.5 (streamlined), Area = 0.01 (small)
        // This prevents the "hit a brick wall" parachute effect during launch.
        mass = descentSettings.mass * 2.0; 
        area = 0.015; // Approx airframe cross-section
        cd = 0.5;
    } else {
        // PARACHUTE DESCENT MODEL
        mass = descentSettings.mass > 0 ? descentSettings.mass : 1.0;
        area = descentSettings.parachuteArea > 0 ? descentSettings.parachuteArea : 0.5;
        cd = descentSettings.dragCoefficient > 0 ? descentSettings.dragCoefficient : 1.5;
    }

    // Check for apogee transition
    if (isAscending && vU <= 0) {
        isAscending = false;
    }

    // A. Atmosphere (Update density every step for re-entry accuracy)
    const stepDensity = getAirDensity(currentAlt, t === 0 ? currentDensity : 0, alt);
    
    // B. Wind Vector at current simulation altitude
    const wind = getWindAtAltitude(currentAlt, windSettings);
    
    // Convert Meteorological Wind (Coming FROM) to Velocity Vector (Going TO)
    const windToRad = ((wind.dir + 180) % 360) * (Math.PI / 180);
    const wN = wind.speed * Math.cos(windToRad);
    const wE = wind.speed * Math.sin(windToRad);
    const wU = 0; 

    // C. Relative Velocity (Airspeed)
    // F_drag depends on movement THROUGH air
    const relN = vN - wN;
    const relE = vE - wE;
    const relU = vU - wU;

    const vRelSq = relN*relN + relE*relE + relU*relU;
    const vRelMag = Math.sqrt(vRelSq);

    // D. Drag Force Vector
    // Force is opposite to Relative Velocity vector
    // F = 0.5 * rho * v^2 * Cd * A
    // F_vector = -0.5 * rho * vMag * Cd * A * vVector
    const dragFactor = -0.5 * stepDensity * vRelMag * cd * area;
    
    const fDragN = dragFactor * relN;
    const fDragE = dragFactor * relE;
    const fDragU = dragFactor * relU;

    // E. Gravity Force (Acts Down)
    const fGravU = -mass * G;

    // F. Net Acceleration (F=ma)
    const aN = fDragN / mass;
    const aE = fDragE / mass;
    const aU = (fDragU + fGravU) / mass;

    // G. Integrate Velocity (Euler)
    vN += aN * dt;
    vE += aE * dt;
    vU += aU * dt;

    // H. Integrate Position
    const dLatMeters = vN * dt; 
    const dLonMeters = vE * dt; 
    
    const newCoords = displaceCoordinate(currentLat, currentLon, dLonMeters, dLatMeters);
    currentLat = newCoords.lat;
    currentLon = newCoords.lon;
    currentAlt += vU * dt;

    t += dt;
    steps++;

    // I. Record Path (Decimate points for rendering efficiency)
    if (steps % 5 === 0 || currentAlt <= groundAlt) {
        path.push({ lat: currentLat, lon: currentLon, alt: Math.max(groundAlt, currentAlt) });
    }
  }

  // Ensure ground point is exact
  if (path.length > 0 && path[path.length-1].alt > groundAlt) {
      path.push({ lat: currentLat, lon: currentLon, alt: groundAlt });
  }

  // J. Confidence Calculation
  // Confidence decreases with time and altitude
  const confidence = 15 + (alt * 0.05) + (t * 0.5);

  return {
    lat: currentLat,
    lon: currentLon,
    timeToImpact: t,
    confidenceRadius: confidence,
    path
  };
};

/**
 * FETCH TERRAIN ELEVATION (Stub)
 */
export const getTerrainElevation = async (lat: number, lon: number, settings: TerrainSettings): Promise<number> => {
    if (!settings.enabled || settings.provider === 'none') return 0;
    // Local provider implementation logic here
    return 0;
};

/**
 * RK4 PHYSICS PREDICTOR
 * Integrates aerodynamic state using Runge-Kutta 4th Order for non-linear stability.
 */
export const PredictLandingRK4 = (
  lat_deg: number, lon_deg: number, alt_m: number,
  v_speed_current_m_s: number, h_speed_current_m_s: number, heading_current_deg: number,
  descent_settings: DescentSettings, wind_settings: WindSettings, landing_settings: LandingSettings,
  ground_alt_m: number = 0, current_density_kg_m3: number = 0, history: any[] = []
): LandingPrediction | null => {
  
  if (alt_m < 5) return null; 
  if (Math.abs(lat_deg) < 0.0001 && Math.abs(lon_deg) < 0.0001) return null; 

  // --- 1. INITIALIZE VECTORS (Reusing logic from Euler setup) ---
  let v_n_m_s                 = 0;
  let v_e_m_s                 = 0;
  let has_gps_vec             = false;

  if (history.length >= 3) {
      const p_last            = history[history.length - 1];
      const p_prev            = history[history.length - 3]; 
      const dt_hist_s         = (p_last.timeElapsed - p_prev.timeElapsed) / 1000;
      
      if (dt_hist_s > 0.1 && dt_hist_s < 3.0) {
          const m_per_deg_lat = 111320;
          const m_per_deg_lon = 111320 * Math.cos(p_last.latitude * Math.PI / 180);
          const d_lat         = p_last.latitude - p_prev.latitude;
          const d_lon         = p_last.longitude - p_prev.longitude;
          
          v_n_m_s             = (d_lat * m_per_deg_lat) / dt_hist_s;
          v_e_m_s             = (d_lon * m_per_deg_lon) / dt_hist_s;
          has_gps_vec         = true;
      }
  }

  const rad_heading           = heading_current_deg * (Math.PI / 180);
  const v_n_imu_m_s           = h_speed_current_m_s * Math.cos(rad_heading);
  const v_e_imu_m_s           = h_speed_current_m_s * Math.sin(rad_heading);

  const source                = landing_settings.headingSource;
  
  if (!has_gps_vec) {
      v_n_m_s                 = v_n_imu_m_s;
      v_e_m_s                 = v_e_imu_m_s;
  } else {
      if (source === 'gps') {
          v_n_m_s             = v_n_m_s;
          v_e_m_s             = v_e_m_s;
      } else if (source === 'imu') {
          v_n_m_s             = v_n_imu_m_s;
          v_e_m_s             = v_e_imu_m_s;
      } else {
          let gps_weight      = source === 'fused' ? (landing_settings.gpsWeight !== undefined ? landing_settings.gpsWeight : 0.5) : (h_speed_current_m_s > 5.0 ? 0.3 : 0.8);
          v_n_m_s             = (v_n_m_s * gps_weight) + (v_n_imu_m_s * (1 - gps_weight));
          v_e_m_s             = (v_e_m_s * gps_weight) + (v_e_imu_m_s * (1 - gps_weight));
      }
  }

  let v_u_m_s                 = v_speed_current_m_s; 

  // --- 2. STATE INITIALIZATION ---
  let s_lat_deg               = lat_deg;
  let s_lon_deg               = lon_deg;
  let s_alt_m                 = alt_m;
  let s_vn_m_s                = v_n_m_s;
  let s_ve_m_s                = v_e_m_s;
  let s_vu_m_s                = v_u_m_s;
  
  let t_s                     = 0;
  const path_array            = [];
  const time_step_s           = 0.2; 
  const max_steps             = 18000; 
  let current_step            = 0;

  // --- 3. RK4 DERIVATIVE FUNCTION ---
  // Calculates acceleration [dvN, dvE, dvU] and velocity [dN, dE, dU] at a given state
  const ComputeDerivatives = (lat: number, alt: number, vn: number, ve: number, vu: number, time_offset: number) => {
      
      const is_ascending      = vu > 0;
      const mass_kg           = is_ascending ? descent_settings.mass * 2.0 : (descent_settings.mass > 0 ? descent_settings.mass : 1.0);
      const area_m2           = is_ascending ? 0.015 : (descent_settings.parachuteArea > 0 ? descent_settings.parachuteArea : 0.5);
      const cd                = is_ascending ? 0.5 : (descent_settings.dragCoefficient > 0 ? descent_settings.dragCoefficient : 1.5);

      const step_density      = getAirDensity(alt, time_offset === 0 ? current_density_kg_m3 : 0, alt_m);
      const wind              = getWindAtAltitude(alt, wind_settings);
      
      const wind_rad          = ((wind.dir + 180) % 360) * (Math.PI / 180);
      const w_n_m_s           = wind.speed * Math.cos(wind_rad);
      const w_e_m_s           = wind.speed * Math.sin(wind_rad);

      const rel_n_m_s         = vn - w_n_m_s;
      const rel_e_m_s         = ve - w_e_m_s;
      const rel_u_m_s         = vu - 0;
      const v_rel_mag_m_s     = Math.sqrt(Math.pow(rel_n_m_s, 2) + Math.pow(rel_e_m_s, 2) + Math.pow(rel_u_m_s, 2));

      const drag_factor       = -0.5 * step_density * v_rel_mag_m_s * cd * area_m2;
      
      const f_drag_n_n        = drag_factor * rel_n_m_s;
      const f_drag_e_n        = drag_factor * rel_e_m_s;
      const f_drag_u_n        = drag_factor * rel_u_m_s;
      const f_grav_u_n        = -mass_kg * G;

      const a_n_m_s2          = f_drag_n_n / mass_kg;
      const a_e_m_s2          = f_drag_e_n / mass_kg;
      const a_u_m_s2          = (f_drag_u_n + f_grav_u_n) / mass_kg;

      const d_lat_deg_s       = (vn / R_EARTH) * (180 / Math.PI);
      const d_lon_deg_s       = (ve / (R_EARTH * Math.cos(lat * Math.PI / 180))) * (180 / Math.PI);

      return { d_lat: d_lat_deg_s, d_lon: d_lon_deg_s, d_alt: vu, dv_n: a_n_m_s2, dv_e: a_e_m_s2, dv_u: a_u_m_s2 };
  };

  // --- 4. RK4 INTEGRATION LOOP ---
  while (s_alt_m > ground_alt_m && current_step < max_steps) {
      
      // k1: Slopes at the beginning of the interval
      const k1                = ComputeDerivatives(s_lat_deg, s_alt_m, s_vn_m_s, s_ve_m_s, s_vu_m_s, t_s);
      
      // k2: Slopes at the midpoint (using k1)
      const k2_lat            = s_lat_deg + 0.5 * time_step_s * k1.d_lat;
      const k2_alt            = s_alt_m   + 0.5 * time_step_s * k1.d_alt;
      const k2_vn             = s_vn_m_s  + 0.5 * time_step_s * k1.dv_n;
      const k2_ve             = s_ve_m_s  + 0.5 * time_step_s * k1.dv_e;
      const k2_vu             = s_vu_m_s  + 0.5 * time_step_s * k1.dv_u;
      const k2                = ComputeDerivatives(k2_lat, k2_alt, k2_vn, k2_ve, k2_vu, t_s + 0.5 * time_step_s);

      // k3: Slopes at the midpoint (using k2)
      const k3_lat            = s_lat_deg + 0.5 * time_step_s * k2.d_lat;
      const k3_alt            = s_alt_m   + 0.5 * time_step_s * k2.d_alt;
      const k3_vn             = s_vn_m_s  + 0.5 * time_step_s * k2.dv_n;
      const k3_ve             = s_ve_m_s  + 0.5 * time_step_s * k2.dv_e;
      const k3_vu             = s_vu_m_s  + 0.5 * time_step_s * k2.dv_u;
      const k3                = ComputeDerivatives(k3_lat, k3_alt, k3_vn, k3_ve, k3_vu, t_s + 0.5 * time_step_s);

      // k4: Slopes at the end of the interval (using k3)
      const k4_lat            = s_lat_deg + time_step_s * k3.d_lat;
      const k4_alt            = s_alt_m   + time_step_s * k3.d_alt;
      const k4_vn             = s_vn_m_s  + time_step_s * k3.dv_n;
      const k4_ve             = s_ve_m_s  + time_step_s * k3.dv_e;
      const k4_vu             = s_vu_m_s  + time_step_s * k3.dv_u;
      const k4                = ComputeDerivatives(k4_lat, k4_alt, k4_vn, k4_ve, k4_vu, t_s + time_step_s);

      // Final State Update (Weighted Average)
      s_lat_deg               += (time_step_s / 6) * (k1.d_lat + 2 * k2.d_lat + 2 * k3.d_lat + k4.d_lat);
      s_lon_deg               += (time_step_s / 6) * (k1.d_lon + 2 * k2.d_lon + 2 * k3.d_lon + k4.d_lon);
      s_alt_m                 += (time_step_s / 6) * (k1.d_alt + 2 * k2.d_alt + 2 * k3.d_alt + k4.d_alt);
      s_vn_m_s                += (time_step_s / 6) * (k1.dv_n + 2 * k2.dv_n + 2 * k3.dv_n + k4.dv_n);
      s_ve_m_s                += (time_step_s / 6) * (k1.dv_e + 2 * k2.dv_e + 2 * k3.dv_e + k4.dv_e);
      s_vu_m_s                += (time_step_s / 6) * (k1.dv_u + 2 * k2.dv_u + 2 * k3.dv_u + k4.dv_u);

      t_s                     += time_step_s;
      current_step++;

      if (current_step % 5 === 0 || s_alt_m <= ground_alt_m) {
          path_array.push({ lat: s_lat_deg, lon: s_lon_deg, alt: Math.max(ground_alt_m, s_alt_m) });
      }
  }

  if (path_array.length > 0 && path_array[path_array.length-1].alt > ground_alt_m) {
      path_array.push({ lat: s_lat_deg, lon: s_lon_deg, alt: ground_alt_m });
  }

  const confidence_m          = 10 + (alt_m * 0.02) + (t_s * 0.2); // RK4 inherently tighter confidence bound

  return {
      lat: s_lat_deg,
      lon: s_lon_deg,
      timeToImpact: t_s,
      confidenceRadius: confidence_m,
      path: path_array
  };
};