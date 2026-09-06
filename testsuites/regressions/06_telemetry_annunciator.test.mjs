/**
 * Regression Test Suite 06: 16-Lamp Telemetry Annunciator State Machine
 * Covers User Issues:
 * - Missing annunciator lamps for multi-stage sequencing: SECO, 1-SEP, 2-ENG, 2-SEP, P-SEP
 * - Full flight phase verification: Pre-Launch -> Stage 1 -> MECO -> Stage 2 -> SECO -> Payload Sep -> Orbit
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse } from '../test_helpers.mjs';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { TELEMETRY } from '../../scripts/gravsim_const.js';

describe('Regression 06: Telemetry Annunciator 16-Lamp Panel', () => {
	let panel;
	let mockUniverse;

	before(() => {
		setupMockDOM();
		mockUniverse = createMockUniverse({
			LaunchSequencer: { isActive: false, isAutoSequence: false },
			objects: []
		});
		panel = new TelemetryPanel(mockUniverse);
	});

	const getLampState = (lampKey) => {
		const lamp = panel.lamps[lampKey];
		if (!lamp) return false;
		return lamp.classList.contains('on');
	};

	it('should illuminate all 16 lamps during LAMP TEST mode', () => {
		panel.startLampTest(2.0);
		panel._updateAnnunciator({}, {});

		const lampKeys = [
			'qlim', 'glim', 'stall', 'warn', 'auto', 'twr', 'pitch', 'orbit',
			'press', '1eng', 'meco', '1sep', '2eng', 'seco', '2sep', 'psep'
		];

		for (const key of lampKeys) {
			assert.ok(getLampState(key), `Lamp ${key.toUpperCase()} must be ON during Lamp Test`);
		}
		panel.lampTestTimer = 0; // Reset test mode
	});

	it('should verify Stage 1 active burn state (1-ENG ON, MECO OFF, 1-SEP OFF)', () => {
		const target = {
			currentStageIndex: 0,
			totalStages: 2,
			thrustRatio: 1.0,
			fuelMass: 100.0,
			burnTime: 120.0,
			isIgnited: true,
			autoControl: true,
			presState: 'NOMINAL',
			stgSepLampTimer: 0
		};

		const tm = {
			status: TELEMETRY.STATUS.ASCENT,
			stageIndex: 0,
			totalStages: 2,
			altM: 5000,
			vV: 400,
			vH: 50,
			tankPresFuel: 350,
			tankPresOxid: 350
		};

		panel._updateAnnunciator(target, tm);

		assert.equal(getLampState('1eng'), true, '1-ENG lamp must be ON during Stage 1 burn');
		assert.equal(getLampState('meco'), false, 'MECO lamp must be OFF during Stage 1 burn');
		assert.equal(getLampState('1sep'), false, '1-SEP lamp must be OFF before Stage 1 separation');
		assert.equal(getLampState('2eng'), false, '2-ENG lamp must be OFF during Stage 1');
		assert.equal(getLampState('seco'), false, 'SECO lamp must be OFF');
		assert.equal(getLampState('press'), true, 'PRESS lamp must be ON during nominal burn');
		assert.equal(getLampState('twr'), true, 'TWR lamp must be ON after clearing 1000m');
	});

	it('should verify Stage 1 MECO and separation (MECO ON, 1-SEP ON, 1-ENG OFF)', () => {
		const target = {
			currentStageIndex: 0,
			totalStages: 2,
			thrustRatio: 0,
			fuelMass: 0,
			burnTime: 0,
			isIgnited: false,
			autoControl: true,
			presState: 'POST_MECO_HOLD',
			stgSepLampTimer: 1.5 // Separation active
		};

		const tm = {
			status: TELEMETRY.STATUS.COASTING,
			stageIndex: 0,
			totalStages: 2,
			altM: 75000,
			vV: 1800,
			vH: 1200,
			isStgSepActive: true
		};

		panel._updateAnnunciator(target, tm);

		assert.equal(getLampState('1eng'), false, '1-ENG lamp must turn OFF at MECO');
		assert.equal(getLampState('meco'), true, 'MECO lamp must turn ON at Stage 1 cutoff');
		assert.equal(getLampState('1sep'), true, '1-SEP lamp must illuminate during separation');
		assert.equal(getLampState('2eng'), false, '2-ENG lamp must remain OFF before ignition');
	});

	it('should verify Stage 2 active burn (2-ENG ON, 1-SEP ON, SECO OFF)', () => {
		const target = {
			currentStageIndex: 1,
			totalStages: 2,
			thrustRatio: 1.0,
			fuelMass: 25.0,
			burnTime: 300.0,
			isIgnited: true,
			autoControl: true,
			stgSepLampTimer: 0
		};

		const tm = {
			status: TELEMETRY.STATUS.ASCENT,
			stageIndex: 1,
			totalStages: 2,
			altM: 120000,
			vV: 500,
			vH: 4500
		};

		panel._updateAnnunciator(target, tm);

		assert.equal(getLampState('1eng'), false, '1-ENG lamp must be OFF');
		assert.equal(getLampState('meco'), true, 'MECO lamp remains ON (Stage 1 is complete)');
		assert.equal(getLampState('1sep'), true, '1-SEP lamp remains ON (Stage 1 is jettisoned)');
		assert.equal(getLampState('2eng'), true, '2-ENG lamp must be ON during Stage 2 burn');
		assert.equal(getLampState('seco'), false, 'SECO lamp must be OFF during Stage 2 burn');
		assert.equal(getLampState('2sep'), false, '2-SEP lamp must be OFF during Stage 2 burn');
	});

	it('should verify Stage 2 SECO, Upper Stage Separation, and Payload Release (SECO ON, 2-SEP ON, P-SEP ON)', () => {
		const target = {
			currentStageIndex: 2,
			totalStages: 2,
			thrustRatio: 0,
			fuelMass: 0,
			burnTime: 0,
			isIgnited: false,
			isPayloadSeparated: true,
			stageState: 'ORBITAL_COAST',
			autoControl: true,
			stgSepLampTimer: 0
		};

		const tm = {
			status: TELEMETRY.STATUS.COASTING,
			stageIndex: 2,
			totalStages: 2,
			isPayloadSeparated: true,
			altM: 220000,
			vV: 5,
			vH: 7800 // Orbital velocity (> 7.5 km/s)
		};

		panel._updateAnnunciator(target, tm);

		assert.equal(getLampState('2eng'), false, '2-ENG lamp must be OFF after SECO');
		assert.equal(getLampState('seco'), true, 'SECO lamp must turn ON after Stage 2 burnout');
		assert.equal(getLampState('2sep'), true, '2-SEP lamp must be ON after Stage 2 upper booster separation');
		assert.equal(getLampState('psep'), true, 'P-SEP lamp must be ON upon payload release');
		assert.equal(getLampState('orbit'), true, 'ORBIT lamp must be ON with > 7.5 km/s velocity at 220 km altitude');
	});
});

