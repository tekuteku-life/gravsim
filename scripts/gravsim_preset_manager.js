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

export class PresetManager {
	constructor(options = {}) {
		this.vehicles = new Map();
		this.payloads = new Map();
		this.missions = new Map();
		this.isLoaded = false;
		this.basePath = './presets';

		// Seed strictly with minimum fallback (H3-30 vehicle + HTV-X cargo + ISS mission)
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

	_loadFromDiskSync(fs, path) {
		const baseDir = path.resolve(process.cwd(), 'presets');
		if (!fs.existsSync(baseDir)) return;

		const loadDir = (subDir, map) => {
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
								map.set(id, data);
							}
						}
					}
				} catch (_) {}
			}
		};

		loadDir('vehicles', this.vehicles);
		loadDir('payloads', this.payloads);
		loadDir('missions', this.missions);
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
				} catch (_) {
					try {
						onProgress(progressObj);
					} catch (e) {
						console.warn('[PresetManager] onProgress callback error:', e);
					}
				}
			}
		};

		try {
			report(0, 10, 'Fetching preset manifests...');
			const [vManifest, pManifest, mManifest] = await Promise.all([
				this._fetchJSON(`${this.basePath}/vehicles/manifest.json`),
				this._fetchJSON(`${this.basePath}/payloads/manifest.json`),
				this._fetchJSON(`${this.basePath}/missions/manifest.json`)
			]);

			const vehicleIds = Array.isArray(vManifest) ? vManifest : Array.from(this.vehicles.keys());
			const payloadIds = Array.isArray(pManifest) ? pManifest : Array.from(this.payloads.keys());
			const missionIds = Array.isArray(mManifest) ? mManifest : Array.from(this.missions.keys());

			const totalTasks = vehicleIds.length + payloadIds.length + missionIds.length;
			let completed = 0;

			// Fetch vehicles
			for (const id of vehicleIds) {
				report(completed, totalTasks, `Loading vehicle: ${id}...`);
				const data = await this._fetchJSON(`${this.basePath}/vehicles/${id}.json`);
				if (data) this.vehicles.set(id, data);
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
	 * Configure RocketLauncher instance with selected vehicle, payload, and mission
	 */
	applyToLauncher(launcher, { vehicleId, payloadId, missionId } = {}) {
		if (!launcher) return;

		// 1. Vehicle Platform
		if (vehicleId) {
			const vehicle = this.getVehicle(vehicleId);
			if (vehicle) {
				launcher.currentVehicleId = vehicle.id;
				launcher.currentPresetId = vehicle.id.toUpperCase();
				launcher.colorTheme = vehicle.colorTheme || 'classic';
				launcher.lengthM = vehicle.lengthM || 60.0;
				launcher.stages = JSON.parse(JSON.stringify(vehicle.stages || []));
				launcher.rendering = vehicle.rendering ? JSON.parse(JSON.stringify(vehicle.rendering)) : null;
				launcher.boosters = (vehicle.boosters || vehicle.rendering?.boosters) ? JSON.parse(JSON.stringify(vehicle.boosters || vehicle.rendering.boosters)) : null;
				if (!payloadId && vehicle.defaultFairing) {
					launcher.fairing = JSON.parse(JSON.stringify(vehicle.defaultFairing));
				}
			}
		}

		// 2. Payload & Satellite
		let effectiveMissionId = missionId;
		if (payloadId) {
			const payload = this.getPayload(payloadId);
			if (payload) {
				launcher.currentPayloadId = payload.id;
				launcher.payload = {
					id: payload.id,
					name: payload.name,
					massT: payload.massT || 0,
					radius: payload.radius || 2.0,
					propulsion: payload.propulsion ? JSON.parse(JSON.stringify(payload.propulsion)) : { enabled: false },
					rendering: payload.rendering ? JSON.parse(JSON.stringify(payload.rendering)) : null
				};
				if (payload.fairing) {
					launcher.fairing = {
						enabled: payload.fairing.enabled !== false,
						massT: payload.fairing.massT || 1.5,
						separationAltKm: payload.fairing.separationAltKm || 110
					};
				}
				// Payload-driven automatic mission suggestion
				if (!effectiveMissionId && payload.recommendedMissionId) {
					effectiveMissionId = payload.recommendedMissionId;
				}
			}
		}

		// 3. Mission Profile
		if (effectiveMissionId) {
			const mission = this.getMission(effectiveMissionId);
			if (mission) {
				launcher.currentMissionId = mission.id;
				if (Array.isArray(mission.flightProfile)) {
					launcher.flightProfile = JSON.parse(JSON.stringify(mission.flightProfile));
				}
				if (mission.predictionDurationMonths) {
					launcher.predictionDurationMonths = mission.predictionDurationMonths;
					launcher.maxSimTimeSec = mission.predictionDurationMonths * (365.25 / 12) * 86400;
				}
			}
		}

		if (typeof launcher.requestPreviewUpdate === 'function') {
			launcher.requestPreviewUpdate();
		}
	}

	/**
	 * Build legacy monolithic MULTISTAGE_PRESETS object for full backward compatibility
	 */
	_buildLegacyPresets() {
		const h3Vehicle = this.getVehicle('h3_22') || {};
		const f9Vehicle = this.getVehicle('falcon9') || {};
		const h330Vehicle = this.getVehicle('h3_30') || {};
		const h324Vehicle = this.getVehicle('h3_24') || {};
		const sstoVehicle = this.getVehicle('ssto') || {};
		const epVehicle = this.getVehicle('epsilon') || {};

		const leoMission = this.getMission('leo_250km') || {};
		const issMission = this.getMission('iss_rendezvous') || {};
		const marsMission = this.getMission('mars_transfer') || {};

		return {
			FALCON9: {
				id: "FALCON9",
				name: "Falcon 9 Style (2-Stage)",
				lengthM: 70.0,
				colorTheme: "classic",
				description: "Two-stage orbital launch vehicle with liquid oxygen and kerosene propellants",
				stages: JSON.parse(JSON.stringify(f9Vehicle.stages || [])),
				payload: { name: "Satellite Payload", massT: 8.0, radius: 2.0 },
				fairing: { enabled: true, massT: 1.7, separationAltKm: 110 },
				flightProfile: JSON.parse(JSON.stringify(leoMission.flightProfile || [])),
				rendering: f9Vehicle.rendering ? JSON.parse(JSON.stringify(f9Vehicle.rendering)) : null,
				boosters: { count: 0 }
			},
			H3: {
				id: "H3",
				name: "H3 Style (2-Stage)",
				lengthM: 63.0,
				colorTheme: "orange",
				description: "Two-stage cryogenic launch vehicle with LE-9 and LE-5B-3 engines",
				stages: [
					{
						stageNumber: 1,
						name: "1st Stage (LE-9 x3 / Boosted)",
						fuelType: "hydro",
						thrustKN: 4500,
						dryMassT: 25.0,
						fuelMassT: 34.0,
						oxidMassT: 206.0,
						burnTime: 235.0,
						ofRatio: 6.0,
						radius: 2.6,
						separationDelaySec: 3.0,
						ignitionDelaySec: 2.0,
						jettisonSpeedM_S: 18.0
					},
					{
						stageNumber: 2,
						name: "2nd Stage (LE-5B-3)",
						fuelType: "hydro",
						thrustKN: 200,
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
				payload: { name: "HTV-X Cargo", massT: 4.0, radius: 2.0 },
				fairing: { enabled: true, massT: 2.0, separationAltKm: 115 },
				flightProfile: JSON.parse(JSON.stringify(issMission.flightProfile || [])),
				rendering: h3Vehicle.rendering ? JSON.parse(JSON.stringify(h3Vehicle.rendering)) : null,
				boosters: h3Vehicle.boosters || h3Vehicle.rendering?.boosters || null
			},
			H3_30: {
				id: "H3_30",
				name: "H3-30 (LE-9 x 3, No SRB)",
				lengthM: 63.0,
				colorTheme: "orange",
				description: "Two-stage cryogenic launch vehicle with 3x LE-9 main engines and no solid rocket boosters",
				stages: JSON.parse(JSON.stringify(h330Vehicle.stages || [])),
				payload: { name: "ALOS-4 Satellite", massT: 3.0, radius: 1.8 },
				fairing: { enabled: true, massT: 2.0, separationAltKm: 115 },
				flightProfile: JSON.parse(JSON.stringify(leoMission.flightProfile || [])),
				rendering: h330Vehicle.rendering ? JSON.parse(JSON.stringify(h330Vehicle.rendering)) : null,
				boosters: { count: 0 }
			},
			H3_22: {
				id: "H3_22",
				name: "H3-22 (SRB-3 x 2 + LE-9 x 2)",
				lengthM: 63.0,
				colorTheme: "orange",
				description: "Standard medium-lift launch vehicle with 2x LE-9 cryogenic core engines and 2x SRB-3 solid rocket boosters",
				stages: JSON.parse(JSON.stringify(h3Vehicle.stages || [])),
				payload: { name: "HTV-X Cargo", massT: 6.0, radius: 2.2 },
				fairing: { enabled: true, massT: 2.2, separationAltKm: 115 },
				flightProfile: JSON.parse(JSON.stringify(issMission.flightProfile || [])),
				rendering: h3Vehicle.rendering ? JSON.parse(JSON.stringify(h3Vehicle.rendering)) : null,
				boosters: h3Vehicle.boosters || h3Vehicle.rendering?.boosters || null
			},
			H3_24: {
				id: "H3_24",
				name: "H3-24L (Heavy: SRB-3 x 4 + LE-9 x 2)",
				lengthM: 65.0,
				colorTheme: "orange",
				description: "Heavy-lift cryogenic launch vehicle with 2x LE-9 main engines and 4x SRB-3 solid rocket boosters for high-energy missions",
				stages: JSON.parse(JSON.stringify(h324Vehicle.stages || [])),
				payload: { name: "MMX Probe", massT: 4.0, radius: 2.0 },
				fairing: { enabled: true, massT: 2.5, separationAltKm: 120 },
				flightProfile: JSON.parse(JSON.stringify(marsMission.flightProfile || [])),
				rendering: h324Vehicle.rendering ? JSON.parse(JSON.stringify(h324Vehicle.rendering)) : null,
				boosters: h324Vehicle.boosters || h324Vehicle.rendering?.boosters || null
			},
			SSTO: {
				id: "SSTO",
				name: "Single Stage (SSTO)",
				lengthM: 50.0,
				colorTheme: "blue",
				description: "Single-stage-to-orbit rocket (Legacy baseline)",
				stages: JSON.parse(JSON.stringify(sstoVehicle.stages || [])),
				payload: { name: "Orbital Capsule", massT: 2.0, radius: 1.8 },
				fairing: { enabled: true, massT: 1.0, separationAltKm: 110 },
				flightProfile: JSON.parse(JSON.stringify(sstoVehicle.flightProfile || leoMission.flightProfile || [])),
				rendering: sstoVehicle.rendering ? JSON.parse(JSON.stringify(sstoVehicle.rendering)) : null,
				boosters: { count: 0 }
			},
			EPSILON: {
				id: "EPSILON",
				name: "Epsilon S Style (3-Stage Solid)",
				lengthM: 26.0,
				colorTheme: "epsilon",
				description: "Three-stage solid propellant launch vehicle for small satellite orbital insertion",
				stages: JSON.parse(JSON.stringify(epVehicle.stages || [])),
				payload: { name: "ASNARO-2", massT: 0.6, radius: 1.2 },
				fairing: { enabled: true, massT: 0.8, separationAltKm: 115 },
				flightProfile: JSON.parse(JSON.stringify(epVehicle.flightProfile || leoMission.flightProfile || [])),
				rendering: epVehicle.rendering ? JSON.parse(JSON.stringify(epVehicle.rendering)) : null,
				boosters: { count: 0 }
			}
		};
	}

	getLegacyPresets() {
		if (!this._legacyPresets) {
			this._legacyPresets = this._buildLegacyPresets();
		}
		return this._legacyPresets;
	}

	getLegacyPreset(presetId) {
		const key = String(presetId || '').toUpperCase();
		return this.getLegacyPresets()[key] || null;
	}
}

// Global singleton instance
export const presetManager = new PresetManager();
