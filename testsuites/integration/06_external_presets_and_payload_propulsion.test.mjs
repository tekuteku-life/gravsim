/**
 * Integration Test Suite 06: External Presets, H3 Variants & Payload On-Board Propulsion
 * 
 * Verifies:
 * 1. Physical JSON files integrity in presets/ (Vehicles, Payloads, Missions & Manifests)
 * 2. PresetManager async loading, progress tracking, and fallback capabilities
 * 3. Payload-driven mission auto-selection & orthogonal 3-way configuration
 * 4. H3 rocket variant dynamics (H3-30, H3-22, H3-24L)
 * 5. Upper stage coasting and engine restart without premature staging
 * 6. Autonomous payload on-board propulsion activation, acceleration, and burnout
 * 7. Fullscreen Bootstrap Loader DOM integration & UI lifecycle
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { PresetManager, presetManager } from '../../scripts/gravsim_preset_manager.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { CalcRocket, CalcDebris } from '../../scripts/gravsim_calc_object.js';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { OBJECT_TYPES, PHYSICS, MULTISTAGE_ROCKET } from '../../scripts/gravsim_const.js';
import { setupMockDOM, createMockUniverse, assertClose } from '../test_helpers.mjs';

describe('Integration 06: External Presets & Payload On-Board Propulsion', () => {
	let cleanupDOM;
	let universe;

	beforeEach(() => {
		cleanupDOM = setupMockDOM();
		EventBus.clearAll();
		universe = createMockUniverse();
	});

	afterEach(() => {
		EventBus.clearAll();
		if (cleanupDOM) cleanupDOM();
	});

	it('should verify all 18 JSON files in presets/ are present, valid JSON, and schema-compliant', () => {
		const expectedFiles = [
			'presets/vehicles/manifest.json',
			'presets/vehicles/h3_30.json',
			'presets/vehicles/h3_22.json',
			'presets/vehicles/h3_24.json',
			'presets/vehicles/falcon9.json',
			'presets/vehicles/epsilon.json',
			'presets/vehicles/ssto.json',
			'presets/payloads/manifest.json',
			'presets/payloads/earth_obs.json',
			'presets/payloads/htv_x.json',
			'presets/payloads/geo_sat.json',
			'presets/payloads/lunar_orbiter.json',
			'presets/payloads/mmx.json',
			'presets/missions/manifest.json',
			'presets/missions/leo_250km.json',
			'presets/missions/iss_rendezvous.json',
			'presets/missions/gto_insertion.json',
			'presets/missions/lunar_insertion.json',
			'presets/missions/mars_transfer.json',
			'presets/missions/jupiter_transfer.json',
			'presets/missions/solar_escape.json'
		];

		for (const relPath of expectedFiles) {
			const absPath = path.resolve(process.cwd(), relPath);
			assert.ok(fs.existsSync(absPath), `Preset file ${relPath} must exist on disk`);
			const content = fs.readFileSync(absPath, 'utf8');
			const json = JSON.parse(content);
			assert.ok(json, `File ${relPath} must parse into non-null JSON`);

			if (relPath.endsWith('manifest.json')) {
				assert.ok(Array.isArray(json), `Manifest ${relPath} must be an array`);
				assert.ok(json.length >= 3, `Manifest ${relPath} must contain at least 3 items`);
			} else {
				assert.ok(json.id, `Preset ${relPath} must have an "id" property`);
				assert.ok(json.name, `Preset ${relPath} must have a "name" property`);
			}
		}
	});

	it('should load presets via PresetManager with progress callback and query helpers', async () => {
		const pm = new PresetManager();
		const progressLog = [];

		const success = await pm.init((loaded, total, asset) => {
			progressLog.push({ loaded, total, asset });
		});

		assert.equal(success, true, 'PresetManager.init() should succeed');
		assert.ok(progressLog.length > 0, 'Progress callback should be invoked during asset loading');
		assert.equal(pm.isLoaded, true, 'PresetManager.isLoaded should be true');

		// Check Vehicle queries
		const vehicles = pm.getVehicles();
		assert.ok(vehicles.length >= 6, 'Should load at least 6 vehicles');
		const h3_22 = pm.getVehicle('h3_22');
		assert.ok(h3_22, 'h3_22 must be retrieved');
		assert.equal(h3_22.stages.length, 2);

		// Check Payload queries
		const payloads = pm.getPayloads();
		assert.ok(payloads.length >= 5, 'Should load at least 5 payloads');
		const geoSat = pm.getPayload('geo_sat');
		assert.ok(geoSat, 'geo_sat must be retrieved');
		assert.equal(geoSat.propulsion.enabled, true);

		// Check Mission queries
		const missions = pm.getMissions();
		assert.ok(missions.length >= 7, 'Should load at least 7 missions');
		const marsMission = pm.getMission('mars_transfer');
		assert.ok(marsMission, 'mars_transfer mission must be retrieved');
		assert.ok(marsMission.flightProfile.length >= 5);
	});

	it('should support payload-driven recommended mission selection and orthogonal vehicle swapping', () => {
		const pm = new PresetManager();
		const rTab = new RocketTab(universe);

		// 1. Verify recommendation mapping
		assert.equal(pm.getRecommendedMissionForPayload('earth_obs'), 'leo_250km');
		assert.equal(pm.getRecommendedMissionForPayload('htv_x'), 'iss_rendezvous');
		assert.equal(pm.getRecommendedMissionForPayload('geo_sat'), 'gto_insertion');
		assert.equal(pm.getRecommendedMissionForPayload('lunar_orbiter'), 'lunar_insertion');
		assert.equal(pm.getRecommendedMissionForPayload('mmx'), 'mars_transfer');

		// 2. Select GeoSat in RocketTab and check automatic mission update
		rTab.ui.rlPayloadSelect.value = 'geo_sat';
		rTab.ui.rlPayloadSelect.dispatchEvent(new Event('change'));

		assert.equal(rTab.ui.rlMissionSelect.value, 'gto_insertion', 'Selecting GeoSat should auto-select GTO insertion mission');
		assert.equal(universe.RocketLauncher.payload.id, 'geo_sat');
		assert.equal(universe.RocketLauncher.currentMissionId, 'gto_insertion');

		// 3. Swap vehicle to H3-24L independently without changing payload or mission
		rTab.ui.rlVehicleSelect.value = 'h3_24';
		rTab.ui.rlVehicleSelect.dispatchEvent(new Event('change'));

		assert.equal(universe.RocketLauncher.currentVehicleId, 'h3_24');
		assert.equal(universe.RocketLauncher.payload.id, 'geo_sat', 'Payload should remain GeoSat');
		assert.equal(universe.RocketLauncher.currentMissionId, 'gto_insertion', 'Mission should remain GTO');

		// 4. Swap vehicle to Falcon 9
		rTab.ui.rlVehicleSelect.value = 'falcon9';
		rTab.ui.rlVehicleSelect.dispatchEvent(new Event('change'));
		assert.equal(universe.RocketLauncher.currentVehicleId, 'falcon9');
		assert.equal(universe.RocketLauncher.payload.id, 'geo_sat');

		// 5. Test Apply button
		rTab.ui.rlPayloadSelect.value = 'lunar_orbiter';
		rTab.ui.rlMissionSelect.value = 'lunar_insertion';
		rTab.ui.rlVehicleSelect.value = 'h3_24';
		rTab.ui.rlApplyConfigBtn.click();

		assert.equal(universe.RocketLauncher.payload.id, 'lunar_orbiter');
		assert.equal(universe.RocketLauncher.currentMissionId, 'lunar_insertion');
		assert.equal(universe.RocketLauncher.currentVehicleId, 'h3_24');
	});

	it('should verify H3 rocket variants (H3-30, H3-22, H3-24L) mass, thrust and TWR calculations', () => {
		const pm = new PresetManager();
		const h3_30 = pm.getVehicle('h3_30');
		const h3_22 = pm.getVehicle('h3_22');
		const h3_24 = pm.getVehicle('h3_24');

		// Liftoff thrust comparisons
		assert.equal(h3_30.stages[0].thrustKN, 4410, 'H3-30 has 3x LE-9 (4410 kN)');
		assert.equal(h3_22.stages[0].thrustKN, 7250, 'H3-22 has 2x LE-9 + 2x SRB-3 (7250 kN)');
		assert.equal(h3_24.stages[0].thrustKN, 11500, 'H3-24L has 2x LE-9 + 4x SRB-3 (11500 kN)');

		// Total mass calculations
		const mass30 = (h3_30.stages[0].dryMassT + h3_30.stages[0].fuelMassT + h3_30.stages[0].oxidMassT) +
			(h3_30.stages[1].dryMassT + h3_30.stages[1].fuelMassT + h3_30.stages[1].oxidMassT);
		const mass22 = (h3_22.stages[0].dryMassT + h3_22.stages[0].fuelMassT + h3_22.stages[0].oxidMassT) +
			(h3_22.stages[1].dryMassT + h3_22.stages[1].fuelMassT + h3_22.stages[1].oxidMassT);
		const mass24 = (h3_24.stages[0].dryMassT + h3_24.stages[0].fuelMassT + h3_24.stages[0].oxidMassT) +
			(h3_24.stages[1].dryMassT + h3_24.stages[1].fuelMassT + h3_24.stages[1].oxidMassT);

		assert.ok(mass30 < mass22, 'H3-30 without SRBs must be lighter than H3-22');
		assert.ok(mass22 < mass24, 'H3-22 with 2 SRBs must be lighter than H3-24 with 4 SRBs');

		// Earth surface gravity TWR check
		const g0 = PHYSICS.G0;
		const twr30 = (h3_30.stages[0].thrustKN * 1000) / (mass30 * 1000 * g0);
		const twr22 = (h3_22.stages[0].thrustKN * 1000) / (mass22 * 1000 * g0);
		const twr24 = (h3_24.stages[0].thrustKN * 1000) / (mass24 * 1000 * g0);

		assert.ok(twr30 > 1.15, `H3-30 TWR must exceed 1.15 (actual: ${twr30.toFixed(2)})`);
		assert.ok(twr22 > 1.25, `H3-22 TWR must exceed 1.25 (actual: ${twr22.toFixed(2)})`);
		assert.ok(twr24 > 1.60, `H3-24L TWR must exceed 1.60 (actual: ${twr24.toFixed(2)})`);
	});

	it('should allow upper stage coasting and reignition without premature stage separation', () => {
		const pm = new PresetManager();
		const vehicle = pm.getVehicle('h3_22');

		// Configure rocket with 2-burn profile: burn -> coast at t=50s -> reignite at t=100s
		const twoBurnProfile = [
			{ type: 'time', value: 0, thrust: 100, angle: 0 },
			{ type: 'time', value: 50, thrust: 0, angle: 45 },
			{ type: 'time', value: 100, thrust: 100, angle: 90 }
		];

		const rocket = new CalcRocket(
			101, 'H3 Restart Test', 0, 0, 0, 0, 0, 0, 2.6, 0,
			vehicle.stages[0].dryMassT, vehicle.stages[0].fuelMassT, vehicle.stages[0].oxidMassT,
			{
				stages: vehicle.stages,
				flightProfile: twoBurnProfile,
				isHoldDown: false,
				isIgnited: true,
				autoControl: true,
				disableOrbitalCutoff: true
			}
		);

		// Advance time: rocket burns for 40 seconds
		for (let s = 0; s < 40; s++) {
			rocket.flightControl(1.0);
		}
		assert.equal(rocket.stageState, 'STG_BURNING', 'Rocket should be burning during initial phase');
		assert.ok(rocket.burnTime > 0, 'Fuel must remain');

		// Advance time past 50s: commanded coast
		for (let s = 0; s < 20; s++) {
			rocket.flightControl(1.0);
		}
		assert.equal(rocket.stageState, 'STG_COAST', 'Rocket must enter STG_COAST on throttle 0');
		assert.equal(rocket.isIgnited, false, 'Engines should be unignited during coast');
		assert.ok(rocket.burnTime > 50, 'Fuel must be preserved, not dumped');
		assert.equal(rocket.currentStageIndex, 0, 'Stage must not be jettisoned during planned coast');

		// Advance time past 100s: restart command
		for (let s = 0; s < 45; s++) {
			rocket.flightControl(1.0);
		}
		assert.equal(rocket.stageState, 'STG_BURNING', 'Rocket must re-ignite from STG_COAST');
		assert.equal(rocket.isIgnited, true, 'isIgnited must be true on reignition');
	});

	it('should activate autonomous payload on-board propulsion after final stage separation', () => {
		const pm = new PresetManager();
		const geoSat = pm.getPayload('geo_sat');

		// 1-stage rocket with GeoSat payload (which has Liquid Apogee Engine propulsion)
		const singleStage = [
			{
				stageNumber: 1,
				name: 'Booster',
				fuelType: 'liquid',
				thrustKN: 1000,
				dryMassT: 5.0,
				fuelMassT: 10.0,
				oxidMassT: 20.0,
				burnTime: 30.0,
				ofRatio: 2.0,
				radius: 2.0,
				separationDelaySec: 1.0,
				ignitionDelaySec: 1.0,
				jettisonSpeedM_S: 5.0
			}
		];

		const rocket = new CalcRocket(
			202, 'Launcher Craft', 0, 0, 0, 0, 0, 0, 2.0, 0,
			singleStage[0].dryMassT, singleStage[0].fuelMassT, singleStage[0].oxidMassT,
			{
				stages: singleStage,
				payload: geoSat,
				isHoldDown: false,
				isIgnited: true,
				autoControl: true,
				flightProfile: [
					{ type: 'time', value: 0, thrust: 100, angle: 90 }
				]
			}
		);

		assert.equal(rocket.isPayloadSeparated, false);
		assert.equal(rocket.hasPayloadPropulsion, undefined);

		// Burn booster to depletion (30 seconds)
		for (let s = 0; s < 30; s++) {
			rocket.flightControl(1.0);
		}
		assert.equal(rocket.stageState, 'STG_MECO', 'Booster burnout triggers STG_MECO');

		// Advance time past separation delay (1.0 sec)
		rocket.flightControl(1.5);

		// Verify final stage separated and craft transitioned to payload with propulsion!
		assert.equal(rocket.isPayloadSeparated, true, 'Craft is now separated payload');
		assert.equal(rocket.hasPayloadPropulsion, true, 'Craft now has payload propulsion enabled');
		assert.equal(rocket.dryMass, geoSat.propulsion.dryMassT, 'Dry mass must match payload engine dry mass');
		assert.equal(rocket.fuelMass, geoSat.propulsion.fuelMassT, 'Fuel mass must match payload propellant');
		assert.equal(rocket.oxidMass, geoSat.propulsion.oxidMassT, 'Oxidizer mass must match payload oxidizer');
		assert.equal(rocket.thrustForce, geoSat.propulsion.thrustKN * 1000, 'Thrust must match payload apogee engine');
		assertClose(rocket.mass, geoSat.massT, 0.01, 'Total craft mass must equal payload mass');

		// Test payload engine burn and acceleration
		rocket.flightControl(1.0);
		assert.equal(rocket.stageState, 'STG_BURNING', 'Payload engine fires on commanded thrust');
		assert.ok(rocket.burnTime > 0, 'Payload engine burn time active');

		const initialFuel = rocket.fuelMass;
		rocket.flightControl(5.0);
		assert.ok(rocket.fuelMass < initialFuel, 'Payload fuel is consumed during burn');

		// Test payload burnout transition to ORBITAL_COAST
		rocket.burnTime = 0.5;
		rocket.fuelMass = 0.001;
		rocket.flightControl(1.0);

		assert.equal(rocket.stageState, 'ORBITAL_COAST', 'Payload propellant depletion transitions to ORBITAL_COAST');
		assert.equal(rocket.thrustForce, 0, 'Thrust force zeroed after payload burnout');
	});

	it('should verify Bootstrap Loader element presence and progress bar animation in DOM', () => {
		const loader = document.getElementById('bootstrap-loader');
		const progressBar = document.getElementById('bootstrap-progress-bar');
		const statusText = document.getElementById('bootstrap-status-text');

		assert.ok(loader, '#bootstrap-loader must exist in DOM');
		assert.ok(progressBar, '#bootstrap-progress-bar must exist in DOM');
		assert.ok(statusText, '#bootstrap-status-text must exist in DOM');

		// Simulate progress callback
		const progressUpdates = [
			{ loaded: 3, total: 18, text: 'LOADING VEHICLES' },
			{ loaded: 10, total: 18, text: 'LOADING PAYLOADS' },
			{ loaded: 18, total: 18, text: 'INITIALIZATION COMPLETE' }
		];

		for (const update of progressUpdates) {
			const pct = Math.round((update.loaded / update.total) * 100);
			progressBar.style.width = `${pct}%`;
			statusText.textContent = update.text;

			assert.equal(progressBar.style.width, `${pct}%`);
		}

		// Simulate completion fade-out
		loader.classList.add('fade-out');
		assert.ok(loader.classList.contains('fade-out'), 'Loader must receive fade-out class upon completion');
	});

	it('should handle PresetManager network failures, null fetch responses, and default launcher application', async () => {
		const pm = new PresetManager();

		// 1. applyToLauncher with null launcher (graceful no-op)
		pm.applyToLauncher(null);

		// 2. applyToLauncher with payload only (auto-recommending mission)
		const mockLauncher = {
			requestPreviewUpdate: () => {}
		};
		pm.applyToLauncher(mockLauncher, { payloadId: 'geo_sat' });
		assert.equal(mockLauncher.currentPayloadId, 'geo_sat');
		assert.equal(mockLauncher.currentMissionId, 'gto_insertion', 'Should auto-suggest recommendedMissionId');

		// 3. applyToLauncher with vehicle only (with defaultFairing applied)
		pm.applyToLauncher(mockLauncher, { vehicleId: 'falcon9' });
		assert.equal(mockLauncher.currentVehicleId, 'falcon9');
		assert.equal(mockLauncher.colorTheme, 'classic');

		// 4. applyToLauncher with unknown IDs and launcher without requestPreviewUpdate
		const bareLauncher = {};
		pm.applyToLauncher(bareLauncher, { vehicleId: 'non_existent', payloadId: 'non_existent', missionId: 'non_existent' });
		assert.equal(bareLauncher.currentVehicleId, undefined);

		// 5. applyToLauncher with payload having fairing.enabled = false
		pm.payloads.set('custom_probe', {
			id: 'custom_probe',
			name: 'Bare Probe',
			massT: 1.0,
			fairing: { enabled: false }
		});
		pm.applyToLauncher(mockLauncher, { payloadId: 'custom_probe' });
		assert.equal(mockLauncher.fairing.enabled, false);

		// 6. Test _fetchJSON failure paths
		const origFetch = globalThis.fetch;
		try {
			// Mock 404 response
			globalThis.fetch = async () => ({ ok: false, status: 404 });
			const res404 = await pm._fetchJSON('http://invalid-url');
			assert.equal(res404, null, '_fetchJSON should return null on !res.ok');

			// Mock throwing fetch
			globalThis.fetch = async () => { throw new Error('Network offline'); };
			const resThrow = await pm._fetchJSON('http://throws');
			assert.equal(resThrow, null, '_fetchJSON should return null on throw');

			// Mock init failure causing catch fallback
			const failingPm = new PresetManager();
			failingPm._fetchJSON = async () => { throw new Error('Simulated IO exception'); };
			let fallbackReportCalled = false;
			await failingPm.init((info) => {
				if (info?.text && info.text.includes('built-in')) fallbackReportCalled = true;
			});
			assert.equal(failingPm.isLoaded, true);
			assert.equal(fallbackReportCalled, true);

			// Test init without callback and when manifests return null (falls back to map keys)
			const nullManifestPm = new PresetManager();
			nullManifestPm._fetchJSON = async (url) => {
				if (url.includes('manifest.json')) return null;
				return null; // individual items also null
			};
			await nullManifestPm.init(); // no onProgress callback
			assert.equal(nullManifestPm.isLoaded, true);
		} finally {
			globalThis.fetch = origFetch;
		}

		// 7. Test unknown ID fallbacks
		assert.equal(pm.getVehicle('non_existent'), null);
		assert.equal(pm.getPayload('non_existent'), null);
		assert.equal(pm.getMission('non_existent'), null);
		assert.equal(pm.getRecommendedMissionForPayload('non_existent'), 'leo_250km');
	});

	it('should verify rendering metadata, booster configuration, and legacy presets integration', async () => {
		const pm = new PresetManager();
		await pm.init();

		// 1. Verify getLegacyPresets keys and structures
		const legacyPresets = pm.getLegacyPresets();
		const expectedKeys = ['FALCON9', 'H3', 'H3_30', 'H3_22', 'H3_24', 'SSTO', 'EPSILON'];
		for (const key of expectedKeys) {
			assert.ok(legacyPresets[key], `Legacy preset ${key} must exist`);
			assert.ok(Array.isArray(legacyPresets[key].stages), `Preset ${key} must have stages`);
			assert.ok(legacyPresets[key].payload, `Preset ${key} must have payload`);
			assert.ok(legacyPresets[key].fairing, `Preset ${key} must have fairing`);
			assert.ok(Array.isArray(legacyPresets[key].flightProfile), `Preset ${key} must have flightProfile`);
		}

		// 2. Verify boosters on legacy presets
		assert.equal(pm.getLegacyPreset('h3_22').boosters.count, 2);
		assert.equal(pm.getLegacyPreset('h3_24').boosters.count, 4);
		assert.equal(pm.getLegacyPreset('h3_30').boosters.count, 0);
		assert.equal(pm.getLegacyPreset('unknown_key'), null);

		// 3. Verify const.js MULTISTAGE_PRESETS backward compatibility
		const { MULTISTAGE_PRESETS } = await import('../../scripts/gravsim_const.js');
		assert.ok(MULTISTAGE_PRESETS.FALCON9);
		assert.ok(MULTISTAGE_PRESETS.H3);
		assert.equal(MULTISTAGE_PRESETS.H3_22.boosters.count, 2);
		assert.equal(MULTISTAGE_PRESETS.H3_24.boosters.count, 4);
		assert.ok('FALCON9' in MULTISTAGE_PRESETS);
		assert.equal('NON_EXISTENT' in MULTISTAGE_PRESETS, false);
		assert.ok(Object.getOwnPropertyDescriptor(MULTISTAGE_PRESETS, 'FALCON9'));
		assert.equal(Object.getOwnPropertyDescriptor(MULTISTAGE_PRESETS, 'NON_EXISTENT'), undefined);

		// 4. Verify applyToLauncher propagates rendering & boosters
		const mockLauncher = { requestPreviewUpdate: () => {} };
		pm.applyToLauncher(mockLauncher, { vehicleId: 'h3_24', payloadId: 'geo_sat', missionId: 'gto_insertion' });
		assert.equal(mockLauncher.boosters.count, 4);
		assert.equal(mockLauncher.boosters.name, 'SRB-3');
		assert.ok(mockLauncher.rendering);
		assert.equal(mockLauncher.rendering.colorTheme, 'orange');
		assert.ok(mockLauncher.payload.rendering);
		assert.equal(mockLauncher.payload.rendering.busColor, '#d4af37');

		// 5. Verify payload and mission rendering metadata
		const earthObs = pm.getPayload('earth_obs');
		assert.ok(earthObs.rendering?.solarPanels);
		const leoMission = pm.getMission('leo_250km');
		assert.ok(leoMission.rendering?.trajectoryColor);
	});

	it('10. should cover PresetManager queries, edge cases, and init lifecycle', async () => {
		const pm = new PresetManager();

		// Edge cases in queries
		assert.ok(pm.getVehicles().length > 0);
		assert.ok(pm.getPayloads().length > 0);
		assert.ok(pm.getMissions().length > 0);
		assert.equal(pm.getLegacyPreset(null), null);
		assert.equal(pm.getVehicle(null), null);
		assert.equal(pm.getVehicle('non_existent'), null);
		assert.equal(pm.getPayload(null), null);
		assert.equal(pm.getPayload('non_existent'), null);
		assert.equal(pm.getMission(null), null);
		assert.equal(pm.getMission('non_existent'), null);
		assert.equal(pm.getRecommendedMissionForPayload('non_existent'), 'leo_250km');

		// applyToLauncher edge cases
		pm.applyToLauncher(null); // null launcher safe
		const launcher = { requestPreviewUpdate: () => {} };
		pm.applyToLauncher(launcher); // empty config safe
		pm.applyToLauncher(launcher, { vehicleId: 'non_existent', payloadId: 'non_existent', missionId: 'non_existent' });

		// Vehicle without payload applies defaultFairing
		pm.applyToLauncher(launcher, { vehicleId: 'h3_30' });
		assert.ok(launcher.fairing);
		assert.equal(launcher.fairing.enabled, true);

		// Payload without explicit mission applies recommendedMissionId, fairing disabled
		const customPm = new PresetManager();
		customPm.payloads.set('custom_sat', {
			id: 'custom_sat',
			name: 'No Fairing Sat',
			fairing: { enabled: false, massT: 0, separationAltKm: 0 }
		});
		customPm.applyToLauncher(launcher, { payloadId: 'custom_sat' });
		assert.equal(launcher.fairing.enabled, false);

		pm.applyToLauncher(launcher, { payloadId: 'mmx' });
		assert.equal(launcher.currentMissionId, 'mars_transfer');

		// init with fallback (built-in error handling when fetch fails or returns null)
		const progressEvents = [];
		const initResult = await pm.init(p => progressEvents.push(p));
		assert.equal(initResult, true);
		assert.ok(pm.isLoaded);
		assert.ok(progressEvents.length > 0);

		// Mock successful fetch for init
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async (url) => {
				if (url.endsWith('manifest.json')) {
					return { ok: true, json: async () => ['test_item'] };
				}
				if (url.endsWith('test_item.json')) {
					return { ok: true, json: async () => ({ id: 'test_item', name: 'Mock Item' }) };
				}
				return { ok: false };
			};

			const mockPm = new PresetManager();
			const mockProgress = [];
			const success = await mockPm.init(p => mockProgress.push(p));
			assert.equal(success, true);
			assert.ok(mockPm.vehicles.has('test_item'));
			assert.ok(mockPm.payloads.has('test_item'));
			assert.ok(mockPm.missions.has('test_item'));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('11. should hold strictly H3-30 vehicle, HTV-X payload, and ISS rendezvous mission as minimal offline fallback', () => {
		const fallbackPm = new PresetManager({ skipDiskLoad: true });

		// Exactly 1 vehicle, 1 payload, 1 mission in fallback
		assert.equal(fallbackPm.vehicles.size, 1, 'Fallback vehicles must contain strictly 1 vehicle');
		assert.equal(fallbackPm.payloads.size, 1, 'Fallback payloads must contain strictly 1 payload');
		assert.equal(fallbackPm.missions.size, 1, 'Fallback missions must contain strictly 1 mission');

		// Verify identity of fallback items
		assert.ok(fallbackPm.getVehicle('h3_30'), 'H3-30 must be the fallback vehicle');
		assert.ok(fallbackPm.getPayload('htv_x'), 'HTV-X must be the fallback payload');
		assert.ok(fallbackPm.getMission('iss_rendezvous'), 'ISS Rendezvous must be the fallback mission');

		// All other vehicles and payloads MUST NOT be hardcoded in fallback
		assert.equal(fallbackPm.getVehicle('falcon9'), null, 'Falcon 9 must not be in fallback');
		assert.equal(fallbackPm.getVehicle('h3_22'), null, 'H3-22 must not be in fallback');
		assert.equal(fallbackPm.getVehicle('h3_24'), null, 'H3-24 must not be in fallback');
		assert.equal(fallbackPm.getVehicle('ssto'), null, 'SSTO must not be in fallback');
		assert.equal(fallbackPm.getVehicle('epsilon'), null, 'Epsilon must not be in fallback');
		assert.equal(fallbackPm.getPayload('earth_obs'), null, 'Earth Obs must not be in fallback');
		assert.equal(fallbackPm.getPayload('geo_sat'), null, 'Geo Sat must not be in fallback');
		assert.equal(fallbackPm.getPayload('lunar_orbiter'), null, 'Lunar Orbiter must not be in fallback');
		assert.equal(fallbackPm.getPayload('mmx'), null, 'MMX must not be in fallback');
	});
});


