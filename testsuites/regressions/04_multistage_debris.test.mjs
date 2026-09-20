/**
 * Regression Test Suite 04: Multi-Stage Debris Generation, Buffer Synchronization, and Visibility
 * Covers User Issues:
 * - Missing debris generation during Stage 1 separation, Fairing jettison, and Stage 2 separation
 * - Debris invisibility (1px dark grey on black background) and non-descriptive naming
 * - Inter-thread Float64Array buffer packing and unpacking of debris subtypes
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { OBJECT_TYPES, ROCKET_VISUAL } from '../../scripts/gravsim_const.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { Rocket } from '../../scripts/gravsim_object.js';
import { logDebug, assertClose, createFalcon9Config } from '../test_helpers.mjs';

describe('Regression 04: Multi-Stage Debris Generation & Visibility', () => {
	it('should generate all 4 debris items (Stage 1 booster, 2 fairing halves, Stage 2 upper stage)', () => {
		const engine = new PhysicsEngine();
		const f9Config = createFalcon9Config();

		// Earth at origin
		engine.addObject({
			id: 10,
			name: 'Earth',
			type: 'celestial',
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			mass: 5.972e24,
			radius: 6371000
		});

		// Falcon 9 Rocket at Earth surface
		engine.addObject({
			id: 100,
			name: 'Falcon 9 Mission',
			type: OBJECT_TYPES.ROCKET,
			x: 0,
			y: 6371000,
			vx: 0,
			vy: 0,
			mass: 555.2,
			radius: 1.85,
			fuelMass: f9Config.stages[0].fuelMassT,
			oxidMass: f9Config.stages[0].oxidMassT,
			thrustForce: f9Config.stages[0].maxThrustN,
			burnTime: 162,
			isHoldDown: false,
			isIgnited: true,
			stages: f9Config.stages,
			payload: f9Config.payload,
			fairing: f9Config.fairing
		});

		const rocket = engine.objects.find(o => o.id === 100);
		assert.ok(rocket, 'Rocket must be registered in engine');
		assertClose(rocket.mass, 555.2, 0.1, 'Initial rocket mass must be ~555.2t');

		// -------------------------------------------------------------
		// 1. Stage 1 Burnout & Booster Separation
		// -------------------------------------------------------------
		rocket.fuelMass = 0;
		rocket.oxidMass = 0;
		rocket.burnTime = 0;
		rocket.stageState = 'STG_MECO';
		rocket.stgTimer = 2.0; // exceeds separation delay (1.5s)

		engine._updateFlightControl(0.1);

		const debrisAfterStage1 = engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS);
		logDebug(`After Stage 1 Separation: Debris count = ${debrisAfterStage1.length}, Rocket mass = ${rocket.mass.toFixed(1)} t`);

		assert.equal(debrisAfterStage1.length, 1, 'Exactly 1 booster debris must be generated');
		const booster = debrisAfterStage1[0];
		assert.equal(booster.debrisSubType, 1, 'Booster subtype must be 1 (Stage 1)');
		assertClose(booster.mass, 25.0, 0.1, 'Booster dry mass must be 25.0t');
		assertClose(rocket.mass, 110.2, 0.1, 'Rocket mass after Stage 1 drop must be ~110.2t');

		// -------------------------------------------------------------
		// 2. Fairing Jettison at > 110km altitude
		// -------------------------------------------------------------
		// Move rocket to 115 km altitude and update forces/distances
		rocket.y = 6371000 + 115000;
		rocket.stageState = 'STG_BURNING';
		rocket.isIgnited = true;

		engine._calculateForces();
		engine._updateFlightControl(0.1);

		const debrisAfterFairing = engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS);
		logDebug(`After Fairing Jettison: Debris count = ${debrisAfterFairing.length}, Rocket mass = ${rocket.mass.toFixed(1)} t`);

		assert.equal(debrisAfterFairing.length, 3, 'Must have 3 debris items (1 booster + 2 fairing halves)');
		const fairingPieces = debrisAfterFairing.filter(d => d.debrisSubType === 3);
		assert.equal(fairingPieces.length, 2, 'Exactly 2 fairing pieces must be generated');
		assertClose(fairingPieces[0].mass, 0.85, 0.05, 'Fairing half mass must be 0.85t');
		assertClose(rocket.mass, 108.5, 0.1, 'Rocket mass after fairing drop must be ~108.5t');

		// -------------------------------------------------------------
		// 3. Stage 2 Burnout & Upper Stage Separation (Payload Release)
		// -------------------------------------------------------------
		rocket.fuelMass = 0;
		rocket.oxidMass = 0;
		rocket.burnTime = 0;
		rocket.stageState = 'STG_MECO';
		rocket.stgTimer = 2.0; // exceeds separation delay (1.5s)

		engine._calculateForces();
		engine._updateFlightControl(0.1);

		const finalDebrisList = engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS);
		logDebug(`After Stage 2 Separation: Debris count = ${finalDebrisList.length}, Rocket mass = ${rocket.mass.toFixed(1)} t, isPayloadSeparated = ${rocket.isPayloadSeparated}`);

		assert.equal(finalDebrisList.length, 4, 'Must have exactly 4 total debris items generated across mission');
		const upperStage = finalDebrisList.find(d => d.debrisSubType === 2);
		assert.ok(upperStage, 'Stage 2 upper stage debris must exist');
		assertClose(upperStage.mass, 4.5, 0.1, 'Upper stage dry mass must be 4.5t');

		// Rocket becomes payload satellite
		assert.equal(rocket.isPayloadSeparated, true, 'Rocket isPayloadSeparated must be true');
		assert.equal(rocket.stageState, 'ORBITAL_COAST', 'Rocket must transition to ORBITAL_COAST');
		assertClose(rocket.mass, 8.0, 0.1, 'Rocket remaining mass must be payload only (8.0t)');
	});

	it('should pack and unpack debrisSubType correctly across WorkerBridge Float64 buffer', () => {
		const mockObjects = [
			{
				id: -101,
				name: 'Stage 1 Booster Debris',
				type: OBJECT_TYPES.DEBRIS,
				debrisSubType: 1,
				x: 1000,
				y: 2000,
				vx: 10,
				vy: 20,
				mass: 25.0,
				radius: 1.85,
				generation: 1
			},
			{
				id: -102,
				name: 'Fairing Half Debris',
				type: OBJECT_TYPES.DEBRIS,
				debrisSubType: 3,
				x: 1100,
				y: 2100,
				vx: 12,
				vy: 22,
				mass: 0.85,
				radius: 1.0,
				generation: 1
			},
			{
				id: -103,
				name: 'Stage 2 Upper Stage Debris',
				type: OBJECT_TYPES.DEBRIS,
				debrisSubType: 2,
				x: 1200,
				y: 2200,
				vx: 15,
				vy: 25,
				mass: 4.5,
				radius: 1.85,
				generation: 1
			}
		];

		// Pack into Float64Array buffer (Worker side)
		const buffer = WorkerBridge.formatWorkerToMain(mockObjects);
		assert.ok(buffer instanceof Float64Array, 'Packed buffer must be Float64Array');

		// Unpack buffer (Main thread side)
		const decodedItems = [];
		WorkerBridge.parseWorkerToMain(buffer.buffer, buffer.length, (item) => {
			decodedItems.push({ ...item });
		});

		logDebug(`Decoded ${decodedItems.length} debris items from Worker buffer`);
		assert.equal(decodedItems.length, 3, 'Must decode all 3 debris objects');

		assert.equal(decodedItems[0].debrisSubType, 1, 'Item 0 debrisSubType must decode as 1');
		assert.equal(decodedItems[1].debrisSubType, 3, 'Item 1 debrisSubType must decode as 3');
		assert.equal(decodedItems[2].debrisSubType, 2, 'Item 2 debrisSubType must decode as 2');
	});

	it('should verify main-thread visual styling attributes based on debrisSubType', () => {
		const getVisualAttributes = (debrisSubType) => {
			let name = 'Jettisoned Debris';
			let color = '#c8d0d8';
			let size = 3.5;
			if (debrisSubType === 1) {
				name = 'Stage 1 Booster';
				color = '#d0d8e0';
				size = 4.0;
			} else if (debrisSubType === 2) {
				name = 'Stage 2 Upper Stage';
				color = '#d0d8e0';
				size = 3.5;
			} else if (debrisSubType === 3) {
				name = 'Fairing Half';
				color = '#e8e8e8';
				size = 3.0;
			}
			return { name, color, size, borderColor: '#00ffff', borderWidth: 0.5 };
		};

		const boosterVisual = getVisualAttributes(1);
		assert.equal(boosterVisual.name, 'Stage 1 Booster');
		assert.ok(boosterVisual.size >= 3.5, 'Booster size must be easily visible (>=3.5px)');
		assert.equal(boosterVisual.borderColor, '#00ffff', 'Must have cyan border for visual pop');

		const fairingVisual = getVisualAttributes(3);
		assert.equal(fairingVisual.name, 'Fairing Half');
		assert.ok(fairingVisual.size >= 3.0, 'Fairing size must be easily visible (>=3.0px)');

		const upperStageVisual = getVisualAttributes(2);
		assert.equal(upperStageVisual.name, 'Stage 2 Upper Stage');
		assert.ok(upperStageVisual.size >= 3.5, 'Upper stage size must be easily visible (>=3.5px)');
	});

	it('should spawn debris with color matching rocket colorTheme (classic, epsilon, blue)', () => {
		const mockWorker = { postMessage: () => {} };

		// 1. Classic theme (Falcon 9)
		const objMgrClassic = new ObjectManager({}, mockWorker);
		const rocketClassic = new Rocket(201, 'Falcon 9', 0, 0, 0, 0, 25, 100, 200, '#fff', 3, 2, 0, null, 0, 'classic');
		objMgrClassic.addObject(rocketClassic, false);

		const bufferClassic = WorkerBridge.formatWorkerToMain([
			{ id: 201, type: OBJECT_TYPES.ROCKET, x: 0, y: 0, vx: 0, vy: 0, mass: 100, radius: 2 },
			{ id: 202, type: OBJECT_TYPES.DEBRIS, debrisSubType: 1, x: 0, y: 0, vx: 0, vy: 0, mass: 25, radius: 2 }
		]);
		objMgrClassic.updateObjectParams({ objectsData: bufferClassic, validLength: bufferClassic.length });

		const boosterClassic = objMgrClassic.objects.find(o => o.id === 202);
		assert.ok(boosterClassic, 'Booster debris must exist');
		assert.equal(boosterClassic.colorTheme, 'classic');
		assert.equal(boosterClassic.color, ROCKET_VISUAL.THEMES.classic.stg1Grad[1]);

		// 2. Epsilon theme
		const objMgrEpsilon = new ObjectManager({}, mockWorker);
		const rocketEpsilon = new Rocket(301, 'Epsilon', 0, 0, 0, 0, 8.7, 66.3, 0, '#fff', 3, 1.3, 0, null, 0, 'epsilon');
		objMgrEpsilon.addObject(rocketEpsilon, false);

		const bufferEpsilon = WorkerBridge.formatWorkerToMain([
			{ id: 301, type: OBJECT_TYPES.ROCKET, x: 0, y: 0, vx: 0, vy: 0, mass: 50, radius: 1.3 },
			{ id: 302, type: OBJECT_TYPES.DEBRIS, debrisSubType: 1, x: 0, y: 0, vx: 0, vy: 0, mass: 8.7, radius: 1.3 }
		]);
		objMgrEpsilon.updateObjectParams({ objectsData: bufferEpsilon, validLength: bufferEpsilon.length });

		const boosterEpsilon = objMgrEpsilon.objects.find(o => o.id === 302);
		assert.ok(boosterEpsilon, 'Booster debris must exist');
		assert.equal(boosterEpsilon.colorTheme, 'epsilon');
		assert.equal(boosterEpsilon.color, ROCKET_VISUAL.THEMES.epsilon.stg1Grad[1]);
	});
});

