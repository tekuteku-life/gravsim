// gravsim_preset_manager.js
/**
 * PresetManager
 * 
 * Manages external JSON preset definitions for:
 * - Vehicles (Launch platforms: stages, engines, propellants, dimensions, rendering)
 * - Payloads (Satellites/probes: mass, dimensions, on-board propulsion, recommended missions)
 * - Missions (Flight plans: pitch schedules, throttle, coasting, and restart profiles)
 * 
 * Supports asynchronous HTTP/fetch loading with progress reporting,
 * and robust embedded fallbacks for zero-dependency offline/test environments.
 */

import { PHYSICS } from './gravsim_const.js';

export class PresetManager {
	constructor(options = {}) {
		this.vehicles = new Map();
		this.payloads = new Map();
		this.missions = new Map();
		this.celestials = new Map();
		this.celestialKeyMap = new Map();
		this.fuels = new Map();
		this.themes = new Map();
		this.visuals = new Map();
		this.isLoaded = false;
		this.basePath = './presets';

		// Seed strictly with minimum fallback (H3-30 vehicle + HTV-X cargo + ISS mission + basic celestials)
		this._seedFallbacks();

		// In Node.js environment (e.g. tests), load all external JSON definitions synchronously from disk
		if (!options.skipDiskLoad && typeof process !== 'undefined' && process?.versions?.node) {
			try {
				const fs = process.getBuiltinModule ? process.getBuiltinModule('fs') : null;
				const path = process.getBuiltinModule ? process.getBuiltinModule('path') : null;
				if (fs && path) {
					this._loadFromDiskSync(fs, path);
				}
			} catch (_) {}
		}
	}

	_normalizeCelestial(data) {
		if (!data) return null;
		const d = { ...data };
		d.NAME = d.name ?? d.NAME ?? d.key ?? d.id;
		d.name = d.NAME;
		d.MASS = d.mass ?? d.MASS ?? 1;
		d.mass = d.MASS;
		d.COLOR = d.color ?? d.COLOR ?? '#888888';
		d.color = d.COLOR;
		d.RADIUS = d.radius ?? d.RADIUS ?? 1000;
		d.radius = d.RADIUS;
		if (d.a !== undefined || d.A !== undefined) { d.A = d.a = (d.a ?? d.A); }
		if (d.e !== undefined || d.E !== undefined) { d.E = d.e = (d.e ?? d.E); }
		if (d.perihelionDeg !== undefined || d.PERIHELION_DEG !== undefined) { d.PERIHELION_DEG = d.perihelionDeg = (d.perihelionDeg ?? d.PERIHELION_DEG); }
		if (d.atmColor !== undefined || d.ATM_COLOR !== undefined) { d.ATM_COLOR = d.atmColor = (d.atmColor ?? d.ATM_COLOR); }
		if (d.atmLimitAlt !== undefined || d.ATM_LIMIT_ALT !== undefined) { d.ATM_LIMIT_ALT = d.atmLimitAlt = (d.atmLimitAlt ?? d.ATM_LIMIT_ALT); }
		if (d.atmDensity0 !== undefined || d.ATM_DENSITY_0 !== undefined) { d.ATM_DENSITY_0 = d.atmDensity0 = (d.atmDensity0 ?? d.ATM_DENSITY_0); }
		if (d.atmScaleHeight !== undefined || d.ATM_SCALE_HEIGHT !== undefined) { d.ATM_SCALE_HEIGHT = d.atmScaleHeight = (d.atmScaleHeight ?? d.ATM_SCALE_HEIGHT); }
		if (d.rotationPeriod !== undefined || d.ROTATION_PERIOD !== undefined) { d.ROTATION_PERIOD = d.rotationPeriod = (d.rotationPeriod ?? d.ROTATION_PERIOD); }
		if (d.borderColor !== undefined || d.BORDER_COLOR !== undefined) { d.BORDER_COLOR = d.borderColor = (d.borderColor ?? d.BORDER_COLOR); }
		if (d.borderWidth !== undefined || d.BORDER_WIDTH !== undefined) { d.BORDER_WIDTH = d.borderWidth = (d.borderWidth ?? d.BORDER_WIDTH); }
		if (d.minDrawSize !== undefined || d.MIN_DRAW_SIZE !== undefined) { d.MIN_DRAW_SIZE = d.minDrawSize = (d.minDrawSize ?? d.MIN_DRAW_SIZE); }
		if (d.maxDynamicPressure !== undefined || d.MAX_DYNAMIC_PRESSURE !== undefined) { d.MAX_DYNAMIC_PRESSURE = d.maxDynamicPressure = (d.maxDynamicPressure ?? d.MAX_DYNAMIC_PRESSURE); }
		if (d.maxQAxial !== undefined || d.MAX_Q_AXIAL !== undefined) { d.MAX_Q_AXIAL = d.maxQAxial = (d.maxQAxial ?? d.MAX_Q_AXIAL); }
		if (d.maxQLateral !== undefined || d.MAX_Q_LATERAL !== undefined) { d.MAX_Q_LATERAL = d.maxQLateral = (d.maxQLateral ?? d.MAX_Q_LATERAL); }
		if (d.aeroAreaFront !== undefined || d.AERO_AREA_FRONT !== undefined) { d.AERO_AREA_FRONT = d.aeroAreaFront = (d.aeroAreaFront ?? d.AERO_AREA_FRONT); }
		if (d.aeroAreaSide !== undefined || d.AERO_AREA_SIDE !== undefined) { d.AERO_AREA_SIDE = d.aeroAreaSide = (d.aeroAreaSide ?? d.AERO_AREA_SIDE); }
		if (d.dragCoef !== undefined || d.DRAG_COEF !== undefined) { d.DRAG_COEF = d.dragCoef = (d.dragCoef ?? d.DRAG_COEF); }
		return d;
	}

	_registerCelestial(id, rawData) {
		const norm = this._normalizeCelestial(rawData);
		if (!norm) return;
		this.celestials.set(id, norm);
		if (norm.key) { this.celestialKeyMap.set(norm.key, norm); }
		if (norm.name) { this.celestialKeyMap.set(norm.name, norm); }
		if (norm.NAME) { this.celestialKeyMap.set(norm.NAME, norm); }
	}

	_loadFromDiskSync(fs, path) {
		const baseDir = path.resolve(process.cwd(), 'presets');
		if (!fs.existsSync(baseDir)) return;

		const loadDir = (subDir, map, isCelestial = false) => {
			const dirPath = path.join(baseDir, subDir);
			if (!fs.existsSync(dirPath)) return;
			const manifestPath = path.join(dirPath, 'manifest.json');
			if (fs.existsSync(manifestPath)) {
				try {
					const ids = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
					if (Array.isArray(ids)) {
						for (const id of ids) {
							const file = path.join(dirPath, `${id}.json`);
							if (fs.existsSync(file)) {
								const data = JSON.parse(fs.readFileSync(file, 'utf8'));
								if (isCelestial) {
									this._registerCelestial(id, data);
								} else {
									map.set(id, data);
								}
							}
						}
					}
				} catch (_) {}
			}
		};

		loadDir('vehicles', this.vehicles);
		loadDir('payloads', this.payloads);
		loadDir('missions', this.missions);
		loadDir('celestials', this.celestials, true);
		loadDir('fuels', this.fuels);
		loadDir('visuals', this.visuals);

		// Register vehicle themes
		for (const v of this.vehicles.values()) {
			const theme = v.rendering?.theme || v.theme;
			if (theme) {
				if (v.colorTheme) this.themes.set(v.colorTheme, theme);
				if (v.id) this.themes.set(v.id, theme);
			}
		}

		this.isLoaded = true;
		this._legacyPresets = null;
	}

	_seedFallbacks() {
		// Minimum offline fallback: Only H3-30, HTV-X, and ISS rendezvous mission
		const fallbackVehicle = {
			id: 'h3_30',
			name: 'H3-30 (LE-9 x 3, No SRB)',
			description: 'Two-stage cryogenic launch vehicle with 3x LE-9 main engines and no solid rocket boosters',
			lengthM: 63.0,
			colorTheme: 'orange',
			stages: [
				{
					stageNumber: 1,
					name: '1st Stage (LE-9 x 3 Core)',
					fuelType: 'hydro',
					thrustKN: 4410,
					dryMassT: 25.0,
					fuelMassT: 34.0,
					oxidMassT: 206.0,
					burnTime: 240.0,
					ofRatio: 6.0,
					radius: 2.6,
					separationDelaySec: 3.0,
					ignitionDelaySec: 2.0,
					jettisonSpeedM_S: 18.0
				},
				{
					stageNumber: 2,
					name: '2nd Stage (LE-5B-3 Upper)',
					fuelType: 'hydro',
					thrustKN: 150,
					dryMassT: 3.5,
					fuelMassT: 4.0,
					oxidMassT: 24.0,
					burnTime: 618.0,
					ofRatio: 6.0,
					radius: 2.6,
					separationDelaySec: 3.0,
					ignitionDelaySec: 2.0,
					jettisonSpeedM_S: 5.0
				}
			],
			defaultFairing: { enabled: true, massT: 2.0, separationAltKm: 115 },
			rendering: {
				colorTheme: 'orange',
				lengthM: 63.0,
				boosters: { count: 0 }
			},
			boosters: { count: 0 }
		};

		const fallbackPayload = {
			id: 'htv_x',
			name: 'HTV-X Space Station Cargo Transfer',
			description: 'Uncrewed space station resupply vehicle with autonomous orbital maneuvering RCS thrusters for ISS rendezvous',
			massT: 6.0,
			radius: 2.2,
			recommendedMissionId: 'iss_rendezvous',
			fairing: { enabled: true, massT: 2.2, separationAltKm: 120 },
			propulsion: {
				enabled: true,
				name: 'HTV-X Orbital Maneuvering RCS',
				fuelType: 'liquid',
				thrustKN: 20.0,
				dryMassT: 4.5,
				fuelMassT: 0.5,
				oxidMassT: 1.0,
				burnTime: 220.0,
				ofRatio: 2.0
			},
			rendering: {
				busColor: '#e5e7eb',
				busShape: 'cylinder',
				solarPanels: { count: 2, widthM: 6.0, heightM: 2.2, color: '#1e3a8a' }
			}
		};

		const fallbackMission = {
			id: 'iss_rendezvous',
			name: 'ISS Orbital Insertion (400km Rendezvous)',
			description: 'High-altitude direct ascent profile targeting 400 km circular orbit for International Space Station rendezvous',
			targetOrbit: 'LEO 400 km',
			predictionDurationMonths: 0.3,
			flightProfile: [
				{ type: 'alt', value: 0, thrust: 100, angle: 0 },
				{ type: 'alt', value: 2000, thrust: 100, angle: 8 },
				{ type: 'alt', value: 18000, thrust: 100, angle: 22 },
				{ type: 'alt', value: 50000, thrust: 100, angle: 42 },
				{ type: 'alt', value: 100000, thrust: 100, angle: 62 },
				{ type: 'alt', value: 200000, thrust: 100, angle: 76 },
				{ type: 'alt', value: 320000, thrust: 100, angle: 85 },
				{ type: 'alt', value: 400000, thrust: 100, angle: 90 }
			],
			rendering: {
				trajectoryColor: '#38bdf8',
				accentColor: '#0284c7'
			}
		};

		this.vehicles.set(fallbackVehicle.id, fallbackVehicle);
		this.payloads.set(fallbackPayload.id, fallbackPayload);
		this.missions.set(fallbackMission.id, fallbackMission);

		const fallbackSun = {
			id: 'sun', key: 'Sun', name: 'Sun', mass: 1.9891e27, color: '#FF4500', radius: 6.96340e8, a: 1000, e: 0.05, perihelionDeg: 0
		};
		const fallbackEarth = {
			id: 'earth', key: 'Earth', name: 'Earth', mass: 5.972e21, color: '#1E90FF', radius: 6.378e6, a: 1.000, e: 0.0167, perihelionDeg: 102.95,
			atmColor: 'rgba(100, 150, 255, 0.5)', atmLimitAlt: 100000, atmDensity0: 1.225, atmScaleHeight: 8500, rotationPeriod: 86164
		};
		const fallbackMoon = {
			id: 'moon', key: 'Moon', name: 'Moon', mass: 7.34767309e19, color: '#C0C0C0', radius: 1.7374e6, a: 0.00257, e: 0.0549, perihelionDeg: 0
		};
		const fallbackRocket = {
			id: 'rocket', key: 'Rocket', name: 'Rocket', mass: 57.5, color: '#32CD32', radius: 63, minDrawSize: 2,
			aeroAreaFront: 10, aeroAreaSide: 126, dragCoef: 0.2, maxQAxial: 50000, maxQLateral: 5000
		};
		this._registerCelestial('sun', fallbackSun);
		this._registerCelestial('earth', fallbackEarth);
		this._registerCelestial('moon', fallbackMoon);
		this._registerCelestial('rocket', fallbackRocket);

		// Seed fallback fuels & plumes
		const fallbackFuels = [
			{
				id: 'liquid', name: 'Liquid', isp: 320, density: 1.0, ofRatio: 2.5,
				plume: {
					flickerFreq: 35, noiseAmp: 0.12, lenMult: 8.0, widthMult: 1.8,
					curveLenRatio: 0.35, curveWidthRatio: 0.75, coreLenRatio: 0.4, coreWidthRatio: 0.28,
					coreFillStart: '#ffffff', coreFillEnd: 'rgba(255, 230, 150, 0)',
					colors: [
						[0, '#ffffff'], [0.15, '#ffea77'], [0.45, '#ff6600'],
						[0.85, 'rgba(200, 30, 0, 0.4)'], [1, 'rgba(100, 10, 0, 0)']
					]
				}
			},
		];
		for (const f of fallbackFuels) {
			this.fuels.set(f.id, f);
		}

		// Seed fallback themes
		const fallbackThemes = {
			orange: {
				stg1Grad: ['#e67e3a', '#c85a1a', '#78320a'],
				stg2Grad: ['#ffffff', '#e2e6ea', '#8a94a0'],
				interstage: '#1e2227',
				fairingGrad: ['#ffffff', '#e8ebed', '#8a94a0'],
				fairingLine: 'rgba(0, 0, 0, 0.45)',
				fins: '#994614',
				nozzle: '#1c2024',
				accentBand: '#ffffff'
			}
		};
		for (const [k, v] of Object.entries(fallbackThemes)) {
			this.themes.set(k, v);
		}

		// Seed fallback visual dimensions
		const fallbackVisual = {
			MIN_SCREEN_RADIUS: 3.5,
			LOD_RADIUS_THRESHOLD: 4.0,
			PAYLOAD_ZOOM_MAGNIFICATION: 1.0,
			LOW_DETAIL: {
				STAGE1_LEN_RATIO: 4.2,
				STAGE2_LEN_RATIO: 2.2,
				WIDTH_RATIO: 0.9,
				PLUME_LEN_RATIO: 2.8,
				PLUME_WIDTH_RATIO: 0.35,
				PLUME_COLOR: '#ffaa00',
				SATELLITE_BUS_W_RATIO: 1.5,
				SATELLITE_BUS_H_RATIO: 1.0,
				SATELLITE_BUS_COLOR: '#d4af37',
				SOLAR_PADDLE_COLOR: '#0066cc',
				PADDLE_OFFSET_X_RATIO: 0.4,
				PADDLE_OFFSET_Y_RATIO: 0.6,
				PADDLE_W_RATIO: 0.8,
				PADDLE_H_RATIO: 0.5,
				PADDLE_GAP_RATIO: 0.1
			},
			ALIGNMENT: {
				BASE_X_STAGE1_RATIO: 0.4,
				BASE_X_UPPER_RATIO: -0.6,
				BASE_X_SINGLE_STAGE_RATIO: -1.5,
				BASE_X_3STG_STAGE1_RATIO: -3.1,
				BASE_X_3STG_STAGE2_RATIO: -1.6,
				BASE_X_3STG_STAGE3_RATIO: -0.9,
				PAYLOAD_OFFSET_RATIO: 0.35,
				UPPER_PLUME_SCALE: 0.65,
				STAGE3_PLUME_SCALE: 0.50,
				MAIN_PLUME_SCALE: 1.0,
				NOZZLE_BOTTOM_OFFSET: {
					SINGLE_STAGE: 1.85,
					TWO_STAGE: 3.10,
					THREE_STAGE: 3.45
				}
			},
			MODULES: {
				STAGE1_RADIUS_RATIO: 0.7,
				STAGE1_LENGTH_RATIO: 2.8,
				STAGE2_RADIUS_RATIO: 0.65,
				STAGE2_LENGTH_RATIO: 1.2,
				STAGE3_RADIUS_RATIO: 0.55,
				STAGE3_LENGTH_RATIO: 0.9,
				INTERSTAGE_LENGTH_RATIO: 0.35,
				INTERSTAGE2_LENGTH_RATIO: 0.25,
				FAIRING_LENGTH_RATIO: 1.1,
				NOZZLE1_LENGTH_RATIO: 0.35,
				NOZZLE2_LENGTH_RATIO: 0.32,
				NOZZLE3_LENGTH_RATIO: 0.28,
				FIN_BASE_RATIO: 0.2,
				FIN_SPAN_RATIO: 0.65,
				FIN_ROOT_RATIO: 0.25,
				FAIRING_CURVE_X_RATIO: 0.7,
				FAIRING_CURVE_Y_RATIO: 0.9,
				FAIRING_TIP_MARGIN: 2,
				FAIRING_BAND_MIN_W: 1.5,
				FAIRING_BAND_W_RATIO: 0.15,
				STAGE2_BORDER_COLOR: 'rgba(0, 0, 0, 0.15)',
				STAGE2_NOZZLE_BASE_RATIO: 0.35,
				STAGE2_NOZZLE_BELL_RATIO: 0.75,
				STAGE3_NOZZLE_BASE_RATIO: 0.30,
				STAGE3_NOZZLE_BELL_RATIO: 0.70,
				INTERSTAGE_BORDER_COLOR: 'rgba(255, 255, 255, 0.15)',
				STAGE1_BAND_MIN_W: 2,
				STAGE1_BAND_W_RATIO: 0.04,
				STAGE1_NOZZLE_BASE_RATIO: 0.6,
				STAGE1_NOZZLE_BELL_RATIO: 0.95,
				SATELLITE_BUS_W_RATIO: 1.40,
				SATELLITE_BUS_H_RATIO: 1.70,
				SATELLITE_PANEL_W_RATIO: 0.80,
				SATELLITE_PANEL_H_RATIO: 0.85,
				SATELLITE_PANEL_FOLDED_H_RATIO: 0.12,
				SATELLITE_PANEL_BOOM_W_RATIO: 0.15,
				SATELLITE_DISH_R_RATIO: 0.35,
				SATELLITE_DISH_OFFSET_RATIO: 0.65,
				SATELLITE_DISH_COLOR: '#ffffff',
				SATELLITE_BUS_FILL: '#d4af37',
				SATELLITE_BUS_STROKE: '#ffee88',
				SATELLITE_PANEL_FILL: '#004488',
				SATELLITE_PANEL_STROKE: '#00aaff',
				SATELLITE_PANEL_MARGIN: 2
			}
		};
		this.visuals.set('rocket', fallbackVisual);
	}

	async init(onProgress) {
		const report = (current, total, text) => {
			if (typeof onProgress === 'function') {
				const percent = total > 0 ? Math.round((current / total) * 100) : 100;
				const progressObj = { current, total, text, percent, loaded: current, name: text };
				try {
					if (onProgress.length > 1) {
						onProgress(current, total, text, percent);
					} else {
						onProgress(progressObj);
					}
				} catch (e) {
					console.warn('[PresetManager] onProgress callback error:', e);
				}
			}
		};

		try {
			report(0, 10, 'Fetching preset manifests...');
			const [vManifest, pManifest, mManifest, cManifest, fManifest, visManifest] = await Promise.all([
				this._fetchJSON(`${this.basePath}/vehicles/manifest.json`),
				this._fetchJSON(`${this.basePath}/payloads/manifest.json`),
				this._fetchJSON(`${this.basePath}/missions/manifest.json`),
				this._fetchJSON(`${this.basePath}/celestials/manifest.json`),
				this._fetchJSON(`${this.basePath}/fuels/manifest.json`),
				this._fetchJSON(`${this.basePath}/visuals/manifest.json`)
			]);

			const vehicleIds = Array.isArray(vManifest) ? vManifest : Array.from(this.vehicles.keys());
			const payloadIds = Array.isArray(pManifest) ? pManifest : Array.from(this.payloads.keys());
			const missionIds = Array.isArray(mManifest) ? mManifest : Array.from(this.missions.keys());
			const celestialIds = Array.isArray(cManifest) ? cManifest : Array.from(this.celestials.keys());
			const fuelIds = Array.isArray(fManifest) ? fManifest : Array.from(this.fuels.keys());
			const visualIds = Array.isArray(visManifest) ? visManifest : Array.from(this.visuals.keys());

			const totalTasks = vehicleIds.length + payloadIds.length + missionIds.length + celestialIds.length + fuelIds.length + visualIds.length;
			let completed = 0;

			// Fetch vehicles
			for (const id of vehicleIds) {
				report(completed, totalTasks, `Loading vehicle: ${id}...`);
				const data = await this._fetchJSON(`${this.basePath}/vehicles/${id}.json`);
				if (data) {
					this.vehicles.set(id, data);
					const theme = data.rendering?.theme || data.theme;
					if (theme) {
						if (data.colorTheme) this.themes.set(data.colorTheme, theme);
						this.themes.set(id, theme);
					}
				}
				completed++;
				report(completed, totalTasks, `Loaded vehicle: ${id}`);
			}

			// Fetch payloads
			for (const id of payloadIds) {
				report(completed, totalTasks, `Loading payload: ${id}...`);
				const data = await this._fetchJSON(`${this.basePath}/payloads/${id}.json`);
				if (data) this.payloads.set(id, data);
				completed++;
				report(completed, totalTasks, `Loaded payload: ${id}`);
			}

			// Fetch missions
			for (const id of missionIds) {
				report(completed, totalTasks, `Loading mission: ${id}...`);
				const data = await this._fetchJSON(`${this.basePath}/missions/${id}.json`);
				if (data) this.missions.set(id, data);
				completed++;
				report(completed, totalTasks, `Loaded mission: ${id}`);
			}

			// Fetch celestials
			for (const id of celestialIds) {
				report(completed, totalTasks, `Loading celestial: ${id}...`);
				const data = await this._fetchJSON(`${this.basePath}/celestials/${id}.json`);
				if (data) this._registerCelestial(id, data);
				completed++;
				report(completed, totalTasks, `Loaded celestial: ${id}`);
			}

			// Fetch fuels
			for (const id of fuelIds) {
				report(completed, totalTasks, `Loading fuel: ${id}...`);
				const data = await this._fetchJSON(`${this.basePath}/fuels/${id}.json`);
				if (data) this.fuels.set(id, data);
				completed++;
				report(completed, totalTasks, `Loaded fuel: ${id}`);
			}

			// Fetch visuals
			for (const id of visualIds) {
				report(completed, totalTasks, `Loading visual: ${id}...`);
				const data = await this._fetchJSON(`${this.basePath}/visuals/${id}.json`);
				if (data) this.visuals.set(id, data);
				completed++;
				report(completed, totalTasks, `Loaded visual: ${id}`);
			}

			this.isLoaded = true;
			this._legacyPresets = null;
			report(totalTasks, totalTasks, 'All presets loaded successfully.');
			return true;
		} catch (err) {
			// Gracefully use fallbacks in case of network or filesystem error
			this.isLoaded = true;
			this._legacyPresets = null;
			report(10, 10, 'Presets loaded using built-in definitions.');
			return true;
		}
	}

	async _fetchJSON(url) {
		try {
			const res = await fetch(url);
			if (!res || !res.ok) {
				return null;
			}
			return await res.json();
		} catch (_) {
			return null;
		}
	}

	// ----------------------------------------------------
	// Queries
	// ----------------------------------------------------

	getVehicles() {
		return Array.from(this.vehicles.values()).map(v => ({
			id: v.id,
			name: v.name,
			description: v.description
		}));
	}

	getVehicle(id) {
		const key = String(id || '').toLowerCase();
		const v = this.vehicles.get(key) || this.vehicles.get(id);
		return v ? JSON.parse(JSON.stringify(v)) : null;
	}

	getPayloads() {
		return Array.from(this.payloads.values()).map(p => ({
			id: p.id,
			name: p.name,
			description: p.description,
			recommendedMissionId: p.recommendedMissionId
		}));
	}

	getPayload(id) {
		const key = String(id || '').toLowerCase();
		const p = this.payloads.get(key) || this.payloads.get(id);
		return p ? JSON.parse(JSON.stringify(p)) : null;
	}

	getMissions() {
		return Array.from(this.missions.values()).map(m => ({
			id: m.id,
			name: m.name,
			description: m.description,
			targetOrbit: m.targetOrbit
		}));
	}

	getMission(id) {
		const key = String(id || '').toLowerCase();
		const m = this.missions.get(key) || this.missions.get(id);
		return m ? JSON.parse(JSON.stringify(m)) : null;
	}

	getRecommendedMissionForPayload(payloadId) {
		const p = this.getPayload(payloadId);
		return p?.recommendedMissionId || 'leo_250km';
	}

	/**
	 * Dynamically calculate optimal propellant loads and burn times for Rocket A + Payload B + Mission C
	 */
	calculateMissionFlightPlan({ vehicle, payload, mission } = {}) {
		if (!vehicle) return null;

		const stages = JSON.parse(JSON.stringify(vehicle.stages || []));
		const boosters = (vehicle.boosters || vehicle.rendering?.boosters) ? {
			...(vehicle.rendering?.boosters || {}),
			...(vehicle.boosters || {})
		} : null;

		// 1. Sizing Payload Propellant (if self-propelled)
		let payloadObj = null;
		if (payload) {
			let payloadMass = payload.massT || 3.0;
			let payloadPropulsion = { enabled: false };

			if (payload.propulsion?.enabled) {
				const prop = JSON.parse(JSON.stringify(payload.propulsion));
				const fuelDef = this.getFuel(prop.fuelType || 'liquid') || { isp: 320, ofRatio: 2.5 };
				const isp = prop.isp || fuelDef.isp;
				const ofRatio = prop.ofRatio !== undefined ? prop.ofRatio : fuelDef.ofRatio;
				const dryMass = prop.dryMassT || (payload.massT * 0.6);
				const maxCapacity = (prop.fuelMassT || 0.5) + (prop.oxidMassT || 1.0);

				// Required delta-V for payload orbital maneuvers (e.g. LAE circularization, LOI, Mars capture, Rendezvous)
				const reqDeltaV = mission?.payloadDeltaVM_S || 0;
				let propNeeded = maxCapacity;
				if (reqDeltaV > 0 && reqDeltaV < 2500) {
					const dv = reqDeltaV * 1.15; // 15% safety margin
					propNeeded = dryMass * (Math.exp(dv / (isp * PHYSICS.G0)) - 1);
				}
				const propMass = Math.max(0.1, Math.min(maxCapacity, propNeeded));

				let oxidMass = 0;
				let fuelMass = propMass;
				if (ofRatio > 0) {
					oxidMass = Math.round((propMass * ofRatio / (1 + ofRatio)) * 100) / 100;
					fuelMass = Math.round((propMass / (1 + ofRatio)) * 100) / 100;
				}

				const thrustN = (prop.thrustKN || 10) * 1000;
				const totalPropKg = (fuelMass + oxidMass) * 1000;
				const burnTime = thrustN > 0 ? Math.round(((totalPropKg * isp * PHYSICS.G0) / thrustN) * 10) / 10 : 0;

				payloadPropulsion = {
					...prop,
					fuelMassT: fuelMass,
					oxidMassT: oxidMass,
					burnTime: burnTime,
					dryMassT: dryMass
				};
				payloadMass = Math.round((dryMass + fuelMass + oxidMass) * 100) / 100;
			}

			payloadObj = {
				id: payload.id,
				name: payload.name,
				massT: payloadMass,
				radius: payload.radius || 2.0,
				propulsion: payloadPropulsion,
				rendering: payload.rendering ? JSON.parse(JSON.stringify(payload.rendering)) : null
			};
		}

		// 2. Sizing Rocket Stage Propellant
		const targetDeltaV = (mission?.targetDeltaVM_S || 9300) * 1.12;

		for (let i = 0; i < stages.length; i++) {
			const stg = stages[i];
			const fuelDef = this.getFuel(stg.fuelType || 'liquid') || { isp: 300, ofRatio: 0 };
			const isp = stg.isp || fuelDef.isp;
			const ofRatio = stg.ofRatio !== undefined ? stg.ofRatio : fuelDef.ofRatio;

			const capFuel = stg.capacityFuelMassT ?? stg.fuelMassT;
			const capOxid = stg.capacityOxidMassT ?? stg.oxidMassT;
			const capProp = capFuel + capOxid;

			let propMass = capProp;
			// Scale propellant if single stage rocket is oversized for low-energy orbit
			if (targetDeltaV < 10500 && capProp > 100 && stages.length === 1) {
				propMass = Math.max(capProp * 0.75, capProp * (targetDeltaV / 12000));
			}

			if (ofRatio > 0) {
				stg.oxidMassT = Math.round((propMass * ofRatio / (1 + ofRatio)) * 10) / 10;
				stg.fuelMassT = Math.round((propMass / (1 + ofRatio)) * 10) / 10;
			} else {
				stg.fuelMassT = Math.round(propMass * 10) / 10;
				stg.oxidMassT = 0;
			}

			const totalPropT = stg.fuelMassT + stg.oxidMassT;
			if (propMass === capProp && stg.burnTime > 0) {
				// Keep designed burn time when propellant is at nominal full capacity
			} else {
				const effectiveThrustKN = (i === 0 && boosters?.coreThrustKN) ? boosters.coreThrustKN : stg.thrustKN;
				if (effectiveThrustKN > 0 && totalPropT > 0) {
					stg.burnTime = Math.round(((totalPropT * 1000 * isp * PHYSICS.G0) / (effectiveThrustKN * 1000)) * 10) / 10;
				}
			}
		}

		const adaptedFlightProfile = (mission && Array.isArray(mission.flightProfile))
			? this._adaptFlightProfileForVehicle(mission.flightProfile, vehicle, stages)
			: null;

		return {
			stages,
			boosters,
			payload: payloadObj,
			fairing: payload?.fairing ? {
				enabled: payload.fairing.enabled !== false,
				massT: payload.fairing.massT || 1.5,
				separationAltKm: payload.fairing.separationAltKm || 110
			} : (vehicle.defaultFairing ? JSON.parse(JSON.stringify(vehicle.defaultFairing)) : null),
			flightProfile: adaptedFlightProfile,
			disableOrbitalCutoff: !!mission?.disableOrbitalCutoff,
			targetApogeeKm: mission?.targetApogeeKm || 0,
			targetPerigeeKm: mission?.targetPerigeeKm || 0,
			predictionDurationMonths: mission?.predictionDurationMonths
		};
	}

	_adaptFlightProfileForVehicle(profile, vehicle, stages) {
		if (!profile || !Array.isArray(profile)) return profile;

		const isSolid = stages && stages.every(s => s.fuelType === 'solid');
		const isSSTO = stages && stages.length === 1;
		const isLowUpperTwr = stages && stages.length > 1 && (stages[1].thrustKN / ((stages[1].dryMassT || 3.5) + (stages[1].fuelMassT || 4) + (stages[1].oxidMassT || 24) + 4) < 6.0);

		let altScale = 1.0;
		if (isSolid) {
			altScale = 0.62;
		} else if (isSSTO) {
			altScale = 0.58;
		} else if (isLowUpperTwr) {
			altScale = 1.08;
		} else {
			altScale = 0.85;
		}

		return profile.map(step => ({
			...step,
			value: step.type === 'alt' ? Math.round(step.value * altScale) : step.value
		}));
	}

	/**
	 * Configure RocketLauncher instance with selected vehicle, payload, and mission
	 */
	applyToLauncher(launcher, { vehicleId, payloadId, missionId } = {}) {
		if (!launcher) return;

		const effectiveVehicleId = vehicleId || launcher.currentVehicleId || 'h3_30';
		const vehicle = this.getVehicle(effectiveVehicleId);

		let effectivePayloadId = payloadId !== undefined ? payloadId : launcher.currentPayloadId;
		if (!effectivePayloadId) {
			effectivePayloadId = (String(effectiveVehicleId).toLowerCase() === 'epsilon') ? 'asnaro_2' : 'earth_obs';
		}
		const payload = effectivePayloadId ? this.getPayload(effectivePayloadId) : null;

		let effectiveMissionId = missionId;
		if (!effectiveMissionId && payload?.recommendedMissionId) {
			effectiveMissionId = payload.recommendedMissionId;
		}
		if (!effectiveMissionId) {
			effectiveMissionId = launcher.currentMissionId || 'leo_250km';
		}
		const mission = effectiveMissionId ? this.getMission(effectiveMissionId) : null;

		if (!vehicle) return;

		// 1. Vehicle Platform
		launcher.currentVehicleId = vehicle.id;
		launcher.currentPresetId = vehicle.id.toUpperCase();
		launcher.colorTheme = vehicle.colorTheme || 'classic';
		launcher.lengthM = vehicle.lengthM || 60.0;
		launcher.rendering = vehicle.rendering ? JSON.parse(JSON.stringify(vehicle.rendering)) : null;

		if (payload) {
			launcher.currentPayloadId = payload.id;
		}
		if (mission) {
			launcher.currentMissionId = mission.id;
		}

		// 2. Dynamic Flight Plan Calculation (Stages, Propellant, Boosters, Payload, Profile)
		const plan = this.calculateMissionFlightPlan({ vehicle, payload, mission });
		if (plan) {
			launcher.stages = plan.stages;
			launcher.boosters = plan.boosters || null;
			launcher.targetApogeeKm = plan.targetApogeeKm || null;
			launcher.targetPerigeeKm = plan.targetPerigeeKm || null;
			if (plan.payload) {
				launcher.payload = plan.payload;
			}
			if (plan.fairing) {
				launcher.fairing = plan.fairing;
			}
			if (plan.flightProfile) {
				launcher.flightProfile = plan.flightProfile;
			}
			if (plan.disableOrbitalCutoff !== undefined) {
				launcher.disableOrbitalCutoff = plan.disableOrbitalCutoff;
			}
			if (plan.predictionDurationMonths) {
				launcher.predictionDurationMonths = plan.predictionDurationMonths;
				launcher.maxSimTimeSec = plan.predictionDurationMonths * (365.25 / 12) * 86400;
			}

			// Sync Stage 0 to Launcher base properties
			if (launcher.stages && launcher.stages[0]) {
				const stg0 = launcher.stages[0];
				launcher.dryMassT = stg0.dryMassT;
				launcher.fuelMassT = stg0.fuelMassT;
				launcher.oxidMassT = stg0.oxidMassT;
				launcher.thrustKN = stg0.thrustKN;
				launcher.fuelType = stg0.fuelType;
				launcher.calculatedBurnTime = stg0.burnTime;
			}
		}

		if (typeof launcher.requestPreviewUpdate === 'function') {
			launcher.requestPreviewUpdate();
		}
	}

	/**
	 * Build legacy monolithic MULTISTAGE_PRESETS object for full backward compatibility
	 * Retains only the minimum baseline (H3-30 + HTV-X cargo) as fallback.
	 */
	_buildLegacyPresets() {
		const h3Vehicle = this.getVehicle('h3_30') || this.vehicles.get('h3_30') || {};
		const htvxPayload = this.getPayload('htv_x') || this.payloads.get('htv_x') || {};
		const issMission = this.getMission('iss_rendezvous') || this.missions.get('iss_rendezvous') || {};

		const fallbackStages = h3Vehicle.stages ? JSON.parse(JSON.stringify(h3Vehicle.stages)) : [];
		if (fallbackStages[0]) {
			fallbackStages[0].thrustKN = 4500;
		}
		if (fallbackStages[1]) {
			fallbackStages[1].thrustKN = 200;
		}

		const fallbackPayload = {
			name: htvxPayload.name || "HTV-X Cargo",
			massT: 4.0,
			radius: 2.0,
			propulsion: null
		};

		const fallbackFairing = {
			enabled: true,
			massT: 2.0,
			separationAltKm: 115
		};

		const fallbackProfile = issMission.flightProfile ? JSON.parse(JSON.stringify(issMission.flightProfile)) : [];

		return {
			H3: {
				id: "H3",
				name: h3Vehicle.name || "H3-30 (LE-9 x 3, No SRB)",
				lengthM: h3Vehicle.lengthM || 63.0,
				colorTheme: h3Vehicle.colorTheme || "orange",
				description: h3Vehicle.description || "Two-stage cryogenic launch vehicle with HTV-X Cargo",
				stages: fallbackStages,
				payload: fallbackPayload,
				fairing: fallbackFairing,
				flightProfile: fallbackProfile,
				rendering: h3Vehicle.rendering ? JSON.parse(JSON.stringify(h3Vehicle.rendering)) : null,
				boosters: { count: 0 }
			}
		};
	}

	_buildLegacyPresetFromVehicle(vehicle, key) {
		if (!vehicle) return null;
		const upperKey = String(key).toUpperCase();
		let defaultPayload = null;
		if (upperKey === 'FALCON9') {
			defaultPayload = { id: 'satellite', name: 'Satellite Payload', massT: 8.0, radius: 2.0, propulsion: null };
		} else if (upperKey === 'EPSILON') {
			defaultPayload = { id: 'asnaro_2', name: 'ASNARO-2', massT: 0.6, radius: 1.2, propulsion: null };
		} else if (upperKey === 'SSTO') {
			defaultPayload = { id: 'capsule', name: 'Orbital Capsule', massT: 2.0, radius: 1.8, propulsion: null };
		} else {
			defaultPayload = { id: 'htv_x', name: 'HTV-X Cargo', massT: 4.0, radius: 2.0, propulsion: null };
		}
		const defaultMission = this.getMission('leo_250km') || {};

		const plan = this.calculateMissionFlightPlan({
			vehicle,
			payload: defaultPayload,
			mission: defaultMission
		});

		return {
			id: key,
			name: vehicle.name || key,
			lengthM: vehicle.lengthM || 63.0,
			colorTheme: vehicle.colorTheme || 'classic',
			description: vehicle.description || '',
			stages: plan?.stages || (vehicle.stages ? JSON.parse(JSON.stringify(vehicle.stages)) : []),
			payload: plan?.payload || defaultPayload,
			fairing: plan?.fairing || vehicle.defaultFairing || null,
			flightProfile: plan?.flightProfile || (defaultMission.flightProfile ? JSON.parse(JSON.stringify(defaultMission.flightProfile)) : []),
			rendering: vehicle.rendering ? JSON.parse(JSON.stringify(vehicle.rendering)) : null,
			boosters: plan?.boosters || vehicle.boosters || vehicle.rendering?.boosters || { count: 0 }
		};
	}

	getLegacyPresets() {
		const base = this._buildLegacyPresets();
		base.H3_30 = base.H3;
		for (const [id, vehicle] of this.vehicles.entries()) {
			const upperKey = String(id).toUpperCase();
			if (!base[upperKey]) {
				base[upperKey] = this._buildLegacyPresetFromVehicle(vehicle, upperKey);
			}
		}
		return base;
	}

	getLegacyPreset(presetId) {
		const key = String(presetId || '').toUpperCase();
		const legacyPresets = this.getLegacyPresets();
		if (legacyPresets[key]) return legacyPresets[key];

		const vehicle = this.getVehicle(key.toLowerCase()) || this.getVehicle(presetId);
		return this._buildLegacyPresetFromVehicle(vehicle, key);
	}

	getCelestials() {
		const list = [];
		const seen = new Set();
		for (const c of this.celestials.values()) {
			if (!seen.has(c.id)) {
				seen.add(c.id);
				list.push(JSON.parse(JSON.stringify(c)));
			}
		}
		return list;
	}

	getCelestial(idOrName) {
		if (!idOrName) { return null; }
		const query = String(idOrName).trim();
		const lower = query.toLowerCase();
		const found = this.celestials.get(query)
			|| this.celestials.get(lower)
			|| this.celestialKeyMap.get(query)
			|| Array.from(this.celestials.values()).find(c => c.name?.toLowerCase() === lower || c.key?.toLowerCase() === lower)
			|| null;
		return found ? JSON.parse(JSON.stringify(found)) : null;
	}

	getObjectParam(name) {
		return this.getCelestial(name);
	}

	getObjectParamsMap() {
		const map = {};
		for (const c of this.celestials.values()) {
			const key = c.key || c.NAME || c.name || c.id;
			if (!map[key]) {
				map[key] = JSON.parse(JSON.stringify(c));
			}
		}
		return map;
	}

	getFuel(id) {
		if (!id) { return null; }
		const query = String(id).toLowerCase();
		const found = this.fuels.get(query) || Array.from(this.fuels.values()).find(f => f.name?.toLowerCase() === query);
		return found ? JSON.parse(JSON.stringify(found)) : null;
	}

	getFuels() {
		return Array.from(this.fuels.values()).map(f => JSON.parse(JSON.stringify(f)));
	}

	getFuelsMap() {
		const map = {};
		for (const [k, v] of this.fuels.entries()) {
			map[k] = JSON.parse(JSON.stringify(v));
		}
		return map;
	}

	getPlume(fuelType) {
		const fuel = this.getFuel(fuelType) || this.getFuel('liquid');
		return fuel?.plume || null;
	}

	getPlumesMap() {
		const map = { THRUST_THRESHOLD: 0.01 };
		for (const [k, v] of this.fuels.entries()) {
			if (v.plume) {
				map[k] = JSON.parse(JSON.stringify(v.plume));
			}
		}
		return map;
	}

	getTheme(themeNameOrVehicle) {
		if (!themeNameOrVehicle) {
			return this.themes.get('orange') || this.themes.get('classic');
		}
		if (typeof themeNameOrVehicle === 'object') {
			if (themeNameOrVehicle.theme) return themeNameOrVehicle.theme;
			if (themeNameOrVehicle.rendering?.theme) return themeNameOrVehicle.rendering.theme;
			if (themeNameOrVehicle.colorTheme) return this.themes.get(themeNameOrVehicle.colorTheme) || this.themes.get('orange');
		}
		const query = String(themeNameOrVehicle).toLowerCase();
		return this.themes.get(query) || this.themes.get('orange') || this.themes.get('classic');
	}

	getThemesMap() {
		const map = {};
		for (const [k, v] of this.themes.entries()) {
			map[k] = JSON.parse(JSON.stringify(v));
		}
		return map;
	}

	getRocketVisual() {
		const base = this.visuals.get('rocket') || {};
		return {
			...JSON.parse(JSON.stringify(base)),
			PLUMES: this.getPlumesMap(),
			THEMES: this.getThemesMap()
		};
	}
}

// Global singleton instance
export const presetManager = new PresetManager();

if (typeof globalThis !== 'undefined') {
	globalThis.__presetManager = presetManager;
}

export const MULTISTAGE_PRESETS = new Proxy({}, {
	get(target, prop) {
		if (typeof prop === 'symbol' || prop === 'inspect' || prop === 'prototype') {
			return target[prop];
		}
		const presets = presetManager.getLegacyPresets();
		return presets[prop] || presetManager.getLegacyPreset(prop);
	},
	has(target, prop) {
		const presets = presetManager.getLegacyPresets();
		if (prop in presets) { return true; }
		return !!presetManager.getLegacyPreset(prop);
	},
	ownKeys() {
		const keys = new Set(Object.keys(presetManager.getLegacyPresets()));
		if (typeof presetManager.getVehicles === 'function') {
			for (const v of presetManager.getVehicles()) {
				keys.add(String(v.id).toUpperCase());
			}
		}
		return Array.from(keys);
	},
	getOwnPropertyDescriptor(target, prop) {
		const val = presetManager.getLegacyPreset(prop);
		if (val !== null && val !== undefined) {
			return { configurable: true, enumerable: true, writable: false, value: val };
		}
		return undefined;
	}
});

export const ROCKET_FUELS = new Proxy({}, {
	get(target, prop) {
		if (typeof prop === 'symbol' || prop === 'inspect' || prop === 'prototype') {
			return target[prop];
		}
		const fuels = presetManager.getFuelsMap();
		return fuels[prop] || presetManager.getFuel(prop);
	},
	has(target, prop) {
		const fuels = presetManager.getFuelsMap();
		return prop in fuels;
	},
	ownKeys() {
		return Object.keys(presetManager.getFuelsMap());
	},
	getOwnPropertyDescriptor(target, prop) {
		const fuels = presetManager.getFuelsMap();
		const val = fuels[prop];
		if (val !== undefined && val !== null) {
			return { configurable: true, enumerable: true, writable: false, value: val };
		}
		return undefined;
	}
});

export const ROCKET_VISUAL = new Proxy({}, {
	get(target, prop) {
		if (typeof prop === 'symbol' || prop === 'inspect' || prop === 'prototype') {
			return target[prop];
		}
		const vis = presetManager.getRocketVisual();
		return vis[prop];
	},
	has(target, prop) {
		const vis = presetManager.getRocketVisual();
		return prop in vis;
	},
	ownKeys() {
		return Object.keys(presetManager.getRocketVisual());
	},
	getOwnPropertyDescriptor(target, prop) {
		const vis = presetManager.getRocketVisual();
		if (prop in vis) {
			return { configurable: true, enumerable: true, writable: false, value: vis[prop] };
		}
		return undefined;
	}
});
