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

import { PHYSICS, ROCKET_FUELS } from './gravsim_const.js';

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
				} catch (e) {
					console.warn('[PresetManager] onProgress callback error:', e);
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
				const fuelDef = ROCKET_FUELS[prop.fuelType || 'liquid'] || { isp: 320, ofRatio: 2.5 };
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
			const fuelDef = ROCKET_FUELS[stg.fuelType || 'liquid'] || { isp: 300, ofRatio: 0 };
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
}

// Global singleton instance
export const presetManager = new PresetManager();
