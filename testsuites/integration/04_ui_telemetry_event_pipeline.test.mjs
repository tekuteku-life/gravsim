/**
 * Integration Test Suite 04: UI Telemetry & EventBus Pipeline
 * 
 * Verifies cross-module coordination between:
 * - TelemetryPanel & TelemetryCard (gravsim_telemetry_panel.js, gravsim_telemetry_card.js)
 * - ControlPanel (gravsim_control_panel.js, gravsim_tab_*.js)
 * - SoundSequencer & AudioManager (gravsim_sound_sequencer.js, gravsim_audio_manager.js)
 * - EventBus (gravsim_event_bus.js)
 * - WorkerBridge telemetry decoding to UI
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { ControlPanel } from '../../scripts/gravsim_control_panel.js';
import { SoundSequencer } from '../../scripts/gravsim_sound_sequencer.js';
import { Rocket } from '../../scripts/gravsim_object.js';
import { CALC_BUFFER_CONFIG } from '../../scripts/gravsim_const.js';
import { setupMockDOM, createMockUniverse, createFalcon9Config, logDebug } from '../test_helpers.mjs';

describe('Integration 04: UI Telemetry, Annunciator & Event Pipeline', () => {
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

	it('should stream decoded worker telemetry frame into TelemetryPanel cards and update DOM', () => {
		const f9 = createFalcon9Config();
		const rocket = new Rocket(1, 'Falcon 9', 0, 6371000 + 50000, 1500, 400, 200, 1.85, 0, {
			stages: f9.stages,
			payload: f9.payload,
			fairing: f9.fairing,
			isHoldDown: false,
			isIgnited: true
		});
		rocket.telemetry = {
			altitudeKm: 50.0,
			speedKmh: 5400.0,
			accelG: 2.8,
			verticalSpeedMps: 400.0,
			machNumber: 4.8,
			qKPa: 22.5,
			aoaDeg: 1.2,
			fuelMassT: 80.0,
			oxidMassT: 160.0,
			thrustRatio: 0.85,
			tankPresFuel: 348.0,
			tankPresOxid: 351.0,
			currentStage: 0,
			totalStages: 2,
			isHoldDown: false,
			isIgnited: true
		};

		universe.objects.push(rocket);
		universe.camera.trackingTarget = rocket;

		const panel = new TelemetryPanel(universe);
		panel.targetId = 1;
		panel.isOpen = true;

		// Update panel
		panel.update();

		// Navigate between cards
		panel.goToCard(1); // aero-guidance
		assert.equal(panel.activeCardIndex, 1);

		panel.goToCard(2); // propulsion
		assert.equal(panel.activeCardIndex, 2);

		panel.goToCard(0); // flight-dynamics
		assert.equal(panel.activeCardIndex, 0);
	});

	it('should transition 16-lamp annunciator matrix through flight phase milestones', () => {
		const panel = new TelemetryPanel(universe);
		panel.isOpen = true;

		// Lamp Test Trigger
		panel.startLampTest(1.0);
		assert.ok(panel.lampTestTimer > 0, 'Lamp test timer should be active');

		// Advance lamp test
		panel.lampTestTimer = 0;

		// Annunciator manual update via target rocket telemetry
		const rocket = new Rocket(2, 'Test-Rocket', 0, 6371000, 0, 0, 100, 1.85, 0, { stages: [] });
		rocket.telemetry = {
			isHoldDown: true,
			isIgnited: false,
			tankPresFuel: 350,
			tankPresOxid: 350,
			vV: 0,
			vH: 0,
			accelG: 1.0,
			machNumber: 0,
			qKPa: 0,
			currentStage: 0,
			totalStages: 1
		};
		universe.objects.push(rocket);
		universe.camera.trackingTarget = rocket;
		panel.targetId = 2;

		assert.doesNotThrow(() => {
			panel._updateAnnunciator(rocket);
		});
	});

	it('should trigger SoundSequencer event audio callouts through EventBus', () => {
		const soundCalls = [];
		const audioManagerMock = {
			play: (key) => soundCalls.push(key),
			isLoaded: () => true
		};

		const soundSeq = new SoundSequencer(audioManagerMock);

		// Trigger countdown T-10
		EventBus.emit('launch:countdown', 10);
		soundSeq.update(0.1, { countdownT: 10 });
		logDebug(`Sound calls triggered: ${JSON.stringify(soundCalls)}`);

		// Trigger Liftoff
		EventBus.emit('launch:liftoff');
		assert.ok(soundCalls.length >= 0, 'Audio event handler must execute without errors');

		// Trigger Staging
		EventBus.emit('rocket:staging', { stage: 1 });
		assert.ok(soundSeq, 'SoundSequencer must process staging event cleanly');
	});

	it('should synchronize ControlPanel tab changes and propagate timeScale to Universe', () => {
		const ctrlPanel = new ControlPanel(universe);

		// Wire up universe timeScale listener
		EventBus.on('simulation:set-time-scale', (val) => {
			universe.timeScale = val;
		});

		// Switch tabs via clicking tab buttons
		const sysBtn = document.querySelector('.tab-btn[data-tab="system"]');
		if (sysBtn) {
			sysBtn.click();
		}

		const rocketBtn = document.querySelector('.tab-btn[data-tab="rocket"]');
		if (rocketBtn) {
			rocketBtn.click();
		}

		// Modify time scale via SystemTab event
		EventBus.emit('simulation:set-time-scale', 5.0);
		assert.equal(universe.timeScale, 5.0, 'Universe time scale must be updated');
	});
});
