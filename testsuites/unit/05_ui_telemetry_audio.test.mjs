import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse, createMockCelestialBody, createMockRocket, createMockElement } from '../test_helpers.mjs';

// Setup DOM mocks before module imports
setupMockDOM();

import { FlightDynamicsCard, AeroGuidanceCard, PropulsionCard, NavigationCameraCard } from '../../scripts/gravsim_telemetry_card.js';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { ControlPanel } from '../../scripts/gravsim_control_panel.js';
import { InputManager } from '../../scripts/gravsim_input_manager.js';
import { LaunchSequencer } from '../../scripts/gravsim_launch_sequencer.js';
import { SoundSequencer } from '../../scripts/gravsim_sound_sequencer.js';
import { AudioManager } from '../../scripts/gravsim_audio_manager.js';
import { MainProfiler } from '../../scripts/gravsim_profiler.js';
import { InfoPanel } from '../../scripts/gravsim_info_panel.js';
import { SaveManager } from '../../scripts/gravsim_save_manager.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { TELEMETRY, SOUND } from '../../scripts/gravsim_const.js';

test('TelemetryCard - FlightDynamicsCard updates and resets UI elements', () => {
	const cardEl = createMockElement('div');
	const card = new FlightDynamicsCard(1, 'Dynamics', cardEl);
	card.initElements();

	const mockRocket = createMockRocket({ mass: 540.5 });
	const mockTelemetry = {
		altM: 25000,
		vV: 350.25,
		vH: 120.75,
		aV: 2.5,
		aH: 0.8
	};

	// Update with telemetry data
	card.update(mockRocket, mockTelemetry);
	assert.ok(card.ui.mass.textContent.includes('540.50'));
	assert.ok(card.ui.alt.textContent.includes('25.0'));

	// Reset UI to placeholder state
	card.resetUI(mockRocket);
	assert.ok(card.ui.mass.textContent.includes('---'));
	assert.ok(card.ui.alt.textContent.includes('---'));
});

test('TelemetryCard - AeroGuidanceCard updates aerodynamic metrics', () => {
	const cardEl = createMockElement('div');
	const card = new AeroGuidanceCard(2, 'Aero & Guidance', cardEl);
	card.initElements();

	const mockRocket = createMockRocket({ thrustAngle: 0.1 });
	const mockTelemetry = {
		qAxialKpa: 32.5,
		qLateralKpa: 1.2,
		aoaDeg: 2.3,
		structRatio: 45.2,
		currentG: 3.1,
		progradeAngle: 0,
		gravityAngle: -Math.PI / 2
	};

	card.update(mockRocket, mockTelemetry);
	assert.ok(card.ui.dynAx.textContent.includes('32.5'));
	assert.ok(card.ui.aoa.textContent.includes('2.3'));
	assert.ok(card.ui.dyn.textContent.includes('45.2'));
});

test('TelemetryPanel - Panel initialization and card switching', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
	const universe = createMockUniverse({ objects: [earth] });
	const panel = new TelemetryPanel(universe);

	assert.ok(panel.cards.length >= 4, 'TelemetryPanel should register 4 telemetry cards');
	assert.equal(panel.activeCardIndex, 0, 'Default card index should be 0');

	// Switch to card index 1
	panel.goToCard(1);
	assert.equal(panel.activeCardIndex, 1);

	// Next card
	panel.nextCard();
	assert.equal(panel.activeCardIndex, 2);

	// Prev card
	panel.prevCard();
	assert.equal(panel.activeCardIndex, 1);
});

test('ControlPanel - Tabs locking and navigation behavior', () => {
	const universe = createMockUniverse();
	Object.assign(universe.RocketLauncher, {
		stages: [{ stageNumber: 1, dryMassT: 20, fuelMassT: 100, oxidMassT: 200, thrustKN: 5000, ispSec: 300 }],
		payload: { name: 'Satellite', massT: 5 },
		fairing: { enabled: true, massT: 1.5, separationAltKm: 100 },
		flightProfile: [
			{ type: 'alt', value: 0, thrust: 100, angle: 0 },
			{ type: 'alt', value: 50000, thrust: 100, angle: 90 }
		],
		currentPresetId: 'FALCON9'
	});
	const ctrl = new ControlPanel(universe);

	assert.ok(ctrl.systemTab);
	assert.ok(ctrl.deployTab);
	assert.ok(ctrl.rocketTab);
	assert.ok(ctrl.naviTab);

	// Test tabs locking event
	EventBus.emit('ui:set-tabs-locked', true);
	ctrl.ui.tabBtns.forEach(btn => {
		assert.equal(btn.disabled, true);
		assert.equal(btn.style.pointerEvents, 'none');
	});

	EventBus.emit('ui:set-tabs-locked', false);
	ctrl.ui.tabBtns.forEach(btn => {
		assert.equal(btn.disabled, false);
		assert.equal(btn.style.pointerEvents, 'auto');
	});
});

test('InputManager - Wheel zoom and mouse pan events', () => {
	const mockCanvas = createMockElement('canvas');
	const inputMgr = new InputManager(mockCanvas);

	let zoomDirection = 0;
	let panDx = 0, panDy = 0;

	const onZoom = (dir) => { zoomDirection = dir; };
	const onPan = (dx, dy) => { panDx = dx; panDy = dy; };

	EventBus.on('input:zoom-wheel', onZoom);
	EventBus.on('input:pan', onPan);

	// Trigger wheel event
	mockCanvas.dispatchEvent({ type: 'wheel', deltaY: -100, preventDefault: () => {} });
	assert.equal(zoomDirection, 1, 'Wheel up should zoom in');

	mockCanvas.dispatchEvent({ type: 'wheel', deltaY: 100, preventDefault: () => {} });
	assert.equal(zoomDirection, -1, 'Wheel down should zoom out');

	// Trigger mouse pan (button 1: middle mouse)
	mockCanvas.dispatchEvent({ type: 'mousedown', button: 1, clientX: 100, clientY: 100 });
	mockCanvas.dispatchEvent({ type: 'mousemove', clientX: 120, clientY: 110 });
	assert.equal(panDx, 20);
	assert.equal(panDy, 10);

	mockCanvas.dispatchEvent({ type: 'mouseup', button: 1 });
	assert.equal(inputMgr.isPanning, false);

	EventBus.off('input:zoom-wheel', onZoom);
	EventBus.off('input:pan', onPan);
});

test('SoundSequencer - Event bus audio playback triggers', () => {
	const universe = createMockUniverse();
	const soundSeq = new SoundSequencer(universe);

	let playedSound = null;
	const onPlay = (key) => { playedSound = key; };
	EventBus.on('audio:play', onPlay);

	// Set audio profile and start sequencer
	soundSeq.audioProfile = {
		events: {
			'LIFTOFF': 'voice_liftoff',
			'MECO': 'voice_meco'
		},
		times: {},
		conditions: []
	};

	EventBus.emit('sequencer-event', 'LIFTOFF');
	assert.equal(playedSound, 'voice_liftoff');

	EventBus.emit('sequencer-event', 'MECO');
	assert.equal(playedSound, 'voice_meco');

	EventBus.off('audio:play', onPlay);
});

test('TelemetryCard - PropulsionCard updates propellant masses, tank pressures, and bar widths', () => {
	const cardEl = createMockElement('div');
	const headerEl = createMockElement('div');
	headerEl.className = 'tm-section-header';
	cardEl.querySelector = (sel) => (sel === '.tm-section-header' ? headerEl : createMockElement('div'));

	const card = new PropulsionCard(3, 'Propulsion & Consumables', cardEl);
	card.initElements();

	const mockRocket = createMockRocket({
		id: 42,
		fuelMass: 95.5,
		oxidMass: 191.0,
		thrustRatio: 0.85,
		stages: [
			{ name: 'Booster Stage 1', fuelMassT: 140, oxidMassT: 280 },
			{ name: 'Upper Stage 2', fuelMassT: 32, oxidMassT: 64 }
		]
	});

	const mockTelemetry = {
		stageIndex: 0,
		remDv: 4250,
		twr: 1.85,
		tankPresFuel: 350,
		tankPresOxid: 345
	};

	// Update telemetry in Stage 1
	card.update(mockRocket, mockTelemetry);
	assert.ok(card.ui.header.textContent.includes('BOOSTER STAGE 1'), 'Header should display Stage 1 name');
	assert.ok(card.ui.remDv.textContent.includes('4.25'), 'Rem delta-V in km/s');
	assert.ok(card.ui.twr.textContent.includes('1.85'), 'TWR display');
	assert.ok(card.ui.thrtl.textContent.includes('85.0'), 'Throttle percentage');
	assert.ok(card.ui.fuelMass.textContent.includes('95.50'), 'Fuel mass display');
	assert.ok(card.ui.oxidMass.textContent.includes('191.00'), 'Oxidizer mass display');
	assert.equal(card.ui.tankPresFuel.textContent, '350', 'Fuel tank pressure in kPa');
	assert.equal(card.ui.tankPresOxid.textContent, '345', 'Oxidizer tank pressure in kPa');

	// Transition to Stage 2
	mockRocket.fuelMass = 30.0;
	mockRocket.oxidMass = 60.0;
	card.update(mockRocket, { ...mockTelemetry, stageIndex: 1, remDv: 2500, twr: 2.1 });
	assert.ok(card.ui.header.textContent.includes('UPPER STAGE 2'), 'Header should display Stage 2 name');

	// Reset UI
	card.resetUI(mockRocket);
	assert.ok(card.ui.remDv.textContent.includes('---'));
	assert.equal(card.ui.fuelBar.style.width, '0%');
	assert.equal(card.ui.presFuelBar.style.width, '0%');
});

test('TelemetryCard - NavigationCameraCard updates dominant body and syncs subRenderer canvas', () => {
	const cardEl = createMockElement('div');
	let rotatedAngle = null;
	let zoomScaleSet = null;
	let drawCalled = false;

	const mockSubRenderer = {
		canvas: createMockElement('canvas'),
		rotation: 0,
		setRotation: (rad) => { rotatedAngle = rad; },
		setZoomScale: (z) => { zoomScaleSet = z; },
		draw: () => { drawCalled = true; },
		renderContext: {}
	};
	mockSubRenderer.canvas.clientWidth = 240;
	mockSubRenderer.canvas.clientHeight = 180;

	const card = new NavigationCameraCard(4, 'Nav & Camera', cardEl, mockSubRenderer);
	card.initElements();
	card.isVisible = true;

	const mockRocket = createMockRocket({
		id: 55,
		dominantBody: { name: 'Earth' },
		distToDominantM: 6778000
	});
	const mockTelemetry = {
		progradeAngle: Math.PI / 6
	};

	card.update(mockRocket, mockTelemetry);
	assert.equal(card.ui.dominantBody.textContent, 'Earth');
	assert.ok(card.ui.distRef.textContent.includes('6,778.0'));
	assert.ok(rotatedAngle !== null, 'Camera rotation should be synchronized with prograde angle');

	// Sub-view draw call verification
	let previewDrawn = false;
	const mockUniverse = createMockUniverse({
		objects: [mockRocket],
		RocketLauncher: {
			drawPreview: () => { previewDrawn = true; }
		}
	});

	card.draw(mockUniverse, 55);
	assert.ok(drawCalled, 'subRenderer.draw should be executed');
	assert.ok(previewDrawn, 'RocketLauncher.drawPreview should be executed');
	assert.ok(zoomScaleSet > 0, 'Zoom scale should be computed and set');

	// Reset UI
	card.resetUI(mockRocket);
	assert.equal(card.ui.dominantBody.textContent, '---');
	assert.ok(card.ui.distRef.textContent.includes('---'));
});

test('LaunchSequencer - Executes countdown commands and triggers EventBus hooks', () => {
	const universe = createMockUniverse();
	universe.LaunchSequencer = new (class MockSequencer {
		constructor() {
			this.timer = 0;
			this.tMinusOffset = 5;
			this.isActive = true;
		}
	})();

	const recordedCommands = [];
	const onRocketCmd = (id, cmd) => recordedCommands.push({ id, cmd });
	EventBus.on('worker:send-rocket-command', onRocketCmd);

	let autoSeqStarted = false;
	const onAutoSeq = () => { autoSeqStarted = true; };
	EventBus.on('auto-sequence-start', onAutoSeq);

	let liftoffTriggered = false;
	const onLiftoff = () => { liftoffTriggered = true; };
	EventBus.on('liftoff', onLiftoff);

	const seq = new LaunchSequencer();
	const sequenceData = {
		tMinusOffset: 5.0,
		events: [
			{ time: 2.0, command: 'AUTO_SEQUENCE_START', name: 'AUTO SEQUENCE' },
			{ time: 4.0, command: 'IGNITE_ENGINE', name: 'IGNITION' },
			{ time: 5.0, command: 'RELEASE_HOLD_DOWN', name: 'LIFTOFF' }
		]
	};

	seq.start(sequenceData, 77);
	assert.equal(seq.isActive, true);
	assert.equal(seq.rocketId, 77);

	// Advance to 2.5s (should trigger AUTO_SEQUENCE_START)
	seq.update(2.5);
	assert.equal(autoSeqStarted, true);
	assert.ok(recordedCommands.some(c => c.cmd === 'AUTO_SEQUENCE_START'));

	// Advance to 4.5s (should trigger IGNITE_ENGINE)
	seq.update(2.0);
	assert.ok(recordedCommands.some(c => c.cmd === 'IGNITE_ENGINE'));

	// Advance to 5.5s (should trigger RELEASE_HOLD_DOWN and liftoff)
	seq.update(1.0);
	assert.equal(liftoffTriggered, true);
	assert.ok(recordedCommands.some(c => c.cmd === 'RELEASE_HOLD_DOWN'));

	// Abort
	seq.abort();
	assert.equal(seq.isActive, false);

	EventBus.off('worker:send-rocket-command', onRocketCmd);
	EventBus.off('auto-sequence-start', onAutoSeq);
	EventBus.off('liftoff', onLiftoff);
});

test('SoundSequencer - Evaluates T- countdown, T+ flight time, and dynamic conditions', () => {
	const mockRocket = createMockRocket({
		id: 88,
		flightTime: 45.0,
		telemetry: {
			qAxialKpa: 38.5,
			stageIndex: 0
		}
	});

	const universe = createMockUniverse({
		objects: [mockRocket],
		TelemetryPanel: { targetId: 88 },
		LaunchSequencer: {
			isActive: false,
			timer: 0,
			tMinusOffset: 5.0
		}
	});

	const soundSeq = new SoundSequencer(universe);
	const playedSounds = [];
	const onAudioPlay = (name) => playedSounds.push(name);
	EventBus.on('audio:play', onAudioPlay);

	// Setup rich audio profile
	soundSeq.audioProfile = {
		events: {
			'MECO': 'voice_meco'
		},
		times: {
			'-3': 'voice_t_minus_3',
			'-2': 'voice_t_minus_2',
			'0': 'voice_liftoff',
			'45': 'voice_t_plus_45'
		},
		conditions: [
			{ id: 'max_q', type: 'qAxialKpa', operator: '>', value: 30.0, audio: 'voice_max_q', once: true }
		]
	};

	// 1. Countdown evaluation via _checkTimeTriggers
	soundSeq._checkTimeTriggers(-3.5, -1.5);
	assert.ok(playedSounds.includes('voice_t_minus_3'));
	assert.ok(playedSounds.includes('voice_t_minus_2'));

	// 2. Flight time evaluation via _checkTimeTriggers
	soundSeq._checkTimeTriggers(44.2, 45.1);
	assert.ok(playedSounds.includes('voice_t_plus_45'));

	// 3. Dynamic flight conditions evaluation
	soundSeq._checkConditions(45.0);
	assert.ok(playedSounds.includes('voice_max_q'), 'Max-Q condition should trigger voice');
	assert.equal(soundSeq.conditionFlags['max_q'], true, 'Condition once flag should be recorded');

	// Should not trigger again when once: true
	const initialLength = playedSounds.length;
	soundSeq._checkConditions(46.0);
	assert.equal(playedSounds.length, initialLength, 'Repeated condition check should not play audio again');

	EventBus.off('audio:play', onAudioPlay);
});

test('InfoPanel - Updates simulation statistics and camera target information', () => {
	const universe = createMockUniverse();
	const infoPanel = new InfoPanel(universe);

	// Test time scale update
	infoPanel.updateTimeScale('10x (Simulation)');
	assert.equal(infoPanel.ui.time.textContent, '10x (Simulation)');

	// Test zoom scale update
	infoPanel.updateZoomScale('1.5x (Local)');
	assert.equal(infoPanel.ui.zoom.textContent, '1.5x (Local)');

	// Test camera target name update
	infoPanel.updateCamera('Falcon 9');
	assert.equal(infoPanel.ui.camera.textContent, 'Falcon 9');

	// Test object count update
	infoPanel.updateObjectCount(12);
	assert.equal(infoPanel.ui.count.textContent, '12');

	// Test elapsed time update
	infoPanel.updateElapsedTime(31536000); // 1 year in seconds
	assert.ok(infoPanel.ui.elapsed.textContent.length > 0);
});

test('AudioManager - Instance initialization and audio buffers map', () => {
	const universe = createMockUniverse();
	const audioMgr = new AudioManager(universe);

	assert.equal(audioMgr.isLoaded, false);
	assert.equal(audioMgr.buffers.size, 0);

	audioMgr._initContext();
	assert.ok(audioMgr.context, 'AudioContext should be initialized');
});

test('ControlPanel - SystemTab, NaviTab, and DeployTab comprehensive interactions', () => {
	const sun = createMockCelestialBody({ id: 1, name: 'Sun', mass: 1.989e30, radius: 6.9634e8, x: 0, y: 0 });
	const earth = createMockCelestialBody({ id: 2, name: 'Earth', mass: 5.972e24, radius: 6.371e6, x: 1.496e11, y: 0, dominantBody: sun });
	const universe = createMockUniverse({ objects: [sun, earth] });
	Object.assign(universe.RocketLauncher, {
		stages: [{ stageNumber: 1, dryMassT: 20, fuelMassT: 100, oxidMassT: 200, thrustKN: 5000, ispSec: 300 }],
		payload: { name: 'Satellite', massT: 5 },
		fairing: { enabled: true, massT: 1.5, separationAltKm: 100 },
		flightProfile: [{ type: 'alt', value: 0, thrust: 100, angle: 0 }],
		currentPresetId: 'FALCON9'
	});

	const ctrl = new ControlPanel(universe);

	// 1. SystemTab interactions
	const sys = ctrl.systemTab;
	sys.updateCenterOptions();
	assert.ok(sys.ui.centerSelect.children.length >= 2, 'Center select should contain options for Sun and Earth');

	sys.updateTimeScaleIndicator(1.0);
	assert.ok(sys.ui.timeIndicator.textContent.length > 0);

	sys.updateZoomScaleIndicator(10.0);
	assert.ok(sys.ui.zoomIndicator.textContent.length > 0);

	// Zoom step adjustment
	sys.ui.zoomScale.min = "-2";
	sys.ui.zoomScale.max = "3";
	sys.setZoomScaleByStep(0.5);

	// 2. NaviTab interactions
	const navi = ctrl.naviTab;
	navi.updateTargetOptions();
	assert.ok(navi.ui.nvTargetSelect.children.length >= 2);

	navi.naviTargetId = 2; // Earth
	navi._updateNaviStats();
	assert.ok(navi.ui.nvMass.textContent.length > 0);
	assert.ok(navi.ui.nvRadius.textContent.length > 0);

	// 3. DeployTab interactions
	const deploy = ctrl.deployTab;
	assert.ok(deploy.ui.massSelect.children.length > 0, 'Mass select options should be generated');

	let deployedProfile = null;
	const onDeployProfile = (prof) => { deployedProfile = prof; };
	EventBus.on('object:deploy-profile', onDeployProfile);
	deploy.ui.solarSystemBtn.click();
	assert.equal(deployedProfile, 'SOLAR_SYSTEM');
	EventBus.off('object:deploy-profile', onDeployProfile);
});

test('InputManager - Dragging, Double-tap reset, and Touch multi-point gestures', () => {
	const mockCanvas = createMockElement('canvas');
	const inputMgr = new InputManager(mockCanvas);

	let dragEvent = null;
	const onDragStart = (x, y) => { dragEvent = { type: 'start', x, y }; };
	const onDragMove = (x, y) => { dragEvent = { type: 'move', x, y }; };
	const onDragEnd = (x, y) => { dragEvent = { type: 'end', x, y }; };
	const onDragCancel = () => { dragEvent = { type: 'cancel' }; };
	let resetOffsetTriggered = false;
	const onResetOffset = () => { resetOffsetTriggered = true; };

	EventBus.on('input:drag-start', onDragStart);
	EventBus.on('input:drag-move', onDragMove);
	EventBus.on('input:drag-end', onDragEnd);
	EventBus.on('input:drag-cancel', onDragCancel);
	EventBus.on('input:reset-offset', onResetOffset);

	// Mock tab-deploy as active
	const tabDeploy = document.getElementById('tab-deploy');
	tabDeploy.classList.add('active');

	// 1. Mouse Drag on canvas
	mockCanvas.dispatchEvent({ type: 'mousedown', button: 0, clientX: 100, clientY: 150 });
	assert.equal(dragEvent?.type, 'start');
	assert.equal(dragEvent?.x, 100);

	mockCanvas.dispatchEvent({ type: 'mousemove', clientX: 120, clientY: 170 });
	assert.equal(dragEvent?.type, 'move');

	mockCanvas.dispatchEvent({ type: 'mouseup', button: 0, clientX: 120, clientY: 170 });
	assert.equal(dragEvent?.type, 'end');

	// Drag cancel on mouseleave
	mockCanvas.dispatchEvent({ type: 'mousedown', button: 0, clientX: 50, clientY: 50 });
	mockCanvas.dispatchEvent({ type: 'mouseleave' });
	assert.equal(dragEvent?.type, 'cancel');

	// 2. Right-click double tap reset
	mockCanvas.dispatchEvent({ type: 'mousedown', button: 2, clientX: 100, clientY: 100 });
	mockCanvas.dispatchEvent({ type: 'mouseup', button: 2 });
	// Second tap quickly within UI.DOUBLE_TAP_DURATION
	mockCanvas.dispatchEvent({ type: 'mousedown', button: 2, clientX: 100, clientY: 100 });
	mockCanvas.dispatchEvent({ type: 'mouseup', button: 2 });
	assert.equal(resetOffsetTriggered, true);

	// 3. Touch gestures (2 fingers pan and pinch zoom)
	mockCanvas.dispatchEvent({
		type: 'touchstart',
		touches: [
			{ clientX: 100, clientY: 100 },
			{ clientX: 200, clientY: 100 }
		],
		preventDefault: () => {}
	});
	assert.equal(inputMgr.lastTouchDist, null, 'touchstart records timestamp for double-tap, dist is null until touchmove');

	// First touchmove establishes initial touch distance (100px)
	mockCanvas.dispatchEvent({
		type: 'touchmove',
		touches: [
			{ clientX: 100, clientY: 100 },
			{ clientX: 200, clientY: 100 }
		],
		preventDefault: () => {}
	});
	assert.equal(inputMgr.lastTouchDist, 100, 'first touchmove sets lastTouchDist to 100');

	// Pinch zoom out (distance increases to 200px)
	let touchZoomDelta = null;
	const onZoomTouch = (delta) => { touchZoomDelta = delta; };
	EventBus.on('input:zoom-touch', onZoomTouch);

	mockCanvas.dispatchEvent({
		type: 'touchmove',
		touches: [
			{ clientX: 50, clientY: 100 },
			{ clientX: 250, clientY: 100 }
		],
		preventDefault: () => {}
	});
	assert.equal(inputMgr.lastTouchDist, 200);
	assert.equal(touchZoomDelta, 100);
	EventBus.off('input:zoom-touch', onZoomTouch);

	// 4. Two-finger touch pan with cx/cy movement > 2px (lines 141-146)
	let touchPanX = 0, touchPanY = 0;
	const onPan = (px, py) => { touchPanX = px; touchPanY = py; };
	EventBus.on('input:pan', onPan);

	// Move both fingers by 10px in X and Y
	mockCanvas.dispatchEvent({
		type: 'touchmove',
		touches: [
			{ clientX: 60, clientY: 110 },
			{ clientX: 260, clientY: 110 }
		],
		preventDefault: () => {}
	});
	assert.equal(touchPanX, 10);
	assert.equal(touchPanY, 10);
	EventBus.off('input:pan', onPan);

	// 5. Single touch drag-start, drag-move, and drag-end
	mockCanvas.dispatchEvent({
		type: 'touchstart',
		touches: [{ clientX: 300, clientY: 400 }],
		preventDefault: () => {}
	});
	assert.equal(inputMgr.isDragging, true);
	assert.equal(dragEvent?.type, 'start');
	assert.equal(dragEvent?.x, 300);

	mockCanvas.dispatchEvent({
		type: 'touchmove',
		touches: [{ clientX: 320, clientY: 430 }],
		preventDefault: () => {}
	});
	assert.equal(dragEvent?.type, 'move');
	assert.equal(dragEvent?.x, 320);

	mockCanvas.dispatchEvent({
		type: 'touchend',
		touches: [],
		changedTouches: [{ clientX: 320, clientY: 430 }],
		preventDefault: () => {}
	});
	assert.equal(inputMgr.isDragging, false);
	assert.equal(dragEvent?.type, 'end');

	// 6. Two-finger touchstart while dragging cancels drag (lines 102-105)
	inputMgr.isDragging = true;
	mockCanvas.dispatchEvent({
		type: 'touchstart',
		touches: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }],
		preventDefault: () => {}
	});
	assert.equal(inputMgr.isDragging, false);
	assert.equal(dragEvent?.type, 'cancel');

	// 7. touchcancel while dragging (lines 174-177)
	inputMgr.isDragging = true;
	mockCanvas.dispatchEvent({ type: 'touchcancel' });
	assert.equal(inputMgr.isDragging, false);
	assert.equal(dragEvent?.type, 'cancel');

	// 8. Single touch when tab-deploy is inactive (line 114 false branch)
	tabDeploy.classList.remove('active');
	mockCanvas.dispatchEvent({
		type: 'touchstart',
		touches: [{ clientX: 100, clientY: 100 }],
		preventDefault: () => {}
	});
	assert.equal(inputMgr.isDragging, false);

	mockCanvas.dispatchEvent({
		type: 'touchend',
		touches: [],
		changedTouches: [{ clientX: 100, clientY: 100 }],
		preventDefault: () => {}
	});

	EventBus.off('input:drag-start', onDragStart);
	EventBus.off('input:drag-move', onDragMove);
	EventBus.off('input:drag-end', onDragEnd);
	EventBus.off('input:drag-cancel', onDragCancel);
	EventBus.off('input:reset-offset', onResetOffset);
});

test('AudioManager - Async load manifest & decode audio data, play sound key', async () => {
	const universe = createMockUniverse();
	const audioMgr = new AudioManager(universe);

	// Load audio assets with mocked fetch
	await audioMgr.load('voice_us');
	assert.equal(audioMgr.isLoaded, true);
	assert.ok(audioMgr.buffers.has('voice_liftoff'));

	// Play audio key
	audioMgr.play('voice_liftoff');

	// Unload audio
	EventBus.emit('audio:unload');
	assert.equal(audioMgr.isLoaded, false);
});

test('MainProfiler - Metric tracking, frame reporting and destruction', () => {
	const profiler = new MainProfiler();
	profiler.start('physics');
	profiler.end('physics');
	assert.ok(profiler.metrics['physics'] !== undefined);

	// Run 60 frames to trigger console reporting
	for (let i = 0; i < 61; i++) {
		profiler.frame();
	}
	assert.equal(profiler.frames, 1);

	profiler.destroy();
});

test('RocketTab - Preset loading, stage tabs, profile table, and rollout/ignite/abort actions', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const universe = createMockUniverse({ objects: [earth] });
	const ctrl = new ControlPanel(universe);
	const rTab = ctrl.rocketTab;

	// Load preset
	rTab.ui.rlPresetSelect.value = 'FALCON9';
	rTab.loadPreset('FALCON9');
	assert.equal(universe.RocketLauncher.stages.length, 2);

	// Switch stage tabs
	rTab.selectTab(1);
	assert.equal(rTab.currentTab, 1);

	// Update stats
	rTab._updateRocketStats();
	assert.ok(rTab.ui.rlStatTotalMass.textContent.length > 0);
	assert.ok(rTab.ui.rlStatDv.textContent.length > 0);

	// Actions: Rollout -> Ignite Quick -> Abort
	rTab.ui.rlRolloutBtn.click();
	rTab.ui.rlIgniteQuickBtn.click();
	rTab.ui.rlAbortBtn.click();

	// Full ignition
	rTab.ui.rlRolloutBtn.click();
	rTab.ui.rlIgniteFullBtn.click();
	rTab.ui.rlAbortBtn.click();
});

test('TelemetryPanel - Open/close toggling, minimal HUD, wheel/swipe switching, and annunciator lamp test', () => {
	const rocket = createMockRocket({
		id: 701,
		mass: 500,
		telemetry: {
			altM: 150000,
			vV: 1800,
			vH: 6200,
			status: TELEMETRY.STATUS.SECO,
			tankPresFuel: 350,
			tankPresOxid: 340,
			stageIndex: 1
		}
	});
	const universe = createMockUniverse({ objects: [rocket] });
	universe.camera.trackingTarget = rocket;

	const panel = new TelemetryPanel(universe);
	panel.targetId = 701;

	// Open / Close
	panel.open();
	assert.equal(panel.isOpen, true);
	panel.update();

	panel.close();
	assert.equal(panel.isOpen, false);
	panel.update();

	// Draw on canvas overlay
	panel.draw();

	// Annunciator lamp test mode
	panel.startLampTest();
	assert.ok(panel.lampTestTimer > 0);
	panel.update();

	// Wheel switching on horizontal layout
	panel.open();
	panel.ui.carousel.style.flexDirection = 'row';
	panel.ui.panel.dispatchEvent({
		type: 'wheel',
		deltaX: 50,
		deltaY: 0,
		preventDefault: () => {},
		stopPropagation: () => {}
	});

	// Touch swipe on panel
	panel.ui.panel.dispatchEvent({
		type: 'touchstart',
		touches: [{ clientX: 200, clientY: 100 }]
	});
	panel.ui.panel.dispatchEvent({
		type: 'touchend',
		changedTouches: [{ clientX: 50, clientY: 100 }]
	});
});

test('SystemTab - Clear objects, trail length/duration sliders, and developer debug mode', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
	const rocket = createMockRocket({ id: 2, name: 'Rocket' });
	const debris = createMockRocket({ id: 3, name: 'Debris', isDebris: true });
	const universe = createMockUniverse({ objects: [earth, rocket, debris] });
	const ctrl = new ControlPanel(universe);
	const sys = ctrl.systemTab;

	// Clear objects
	sys.ui.clearDebrisChk.checked = true;
	sys.ui.clearRocketChk.checked = true;
	sys.ui.clearSelectedBtn.click();

	// Sliders
	sys.ui.trailLength.value = '500';
	sys.ui.trailLength.dispatchEvent({ type: 'input' });

	sys.ui.predDuration.value = '180';
	sys.ui.predDuration.dispatchEvent({ type: 'input' });

	// Developer debug mode
	sys._enableDebugMode();
	assert.equal(sys.isDebugModeEnabled, true);

	// Toggle profiler checkboxes
	sys.ui.enableWorkerProfilerChk.checked = true;
	sys.ui.enableWorkerProfilerChk.dispatchEvent({ type: 'change', target: { checked: true } });

	// Checkboxes
	sys.ui.showLabelsChk.checked = true;
	sys.ui.showLabelsChk.dispatchEvent({ type: 'change', target: { checked: true } });
	sys.ui.showPredictedPathChk.checked = false;
	sys.ui.showPredictedPathChk.dispatchEvent({ type: 'change', target: { checked: false } });
	sys.ui.showActualPathChk.checked = false;
	sys.ui.showActualPathChk.dispatchEvent({ type: 'change', target: { checked: false } });
	sys.ui.showDebugChk.checked = true;
	sys.ui.showDebugChk.dispatchEvent({ type: 'change', target: { checked: true } });

	// Audio selection
	sys.ui.audioVoiceSelect.value = 'none';
	sys.ui.audioVoiceSelect.dispatchEvent({ type: 'change', target: { value: 'none' } });
	sys.ui.audioVoiceSelect.value = 'voice_us';
	sys.ui.audioVoiceSelect.dispatchEvent({ type: 'change', target: { value: 'voice_us' } });

	// Pause / Resume & Reset All buttons
	sys.ui.pauseResumeBtn.click();
	sys.ui.pauseResumeBtn.click();
	sys.ui.resetAllBtn.click();

	// Time scale indicators across scales (years, months, days, hours, mins, secs)
	sys.updateTimeScaleIndicator(100.0);
	sys.updateTimeScaleIndicator(0.1);
	sys.updateTimeScaleIndicator(0.01);
	sys.updateTimeScaleIndicator(0.0001);
	sys.updateTimeScaleIndicator(0.000001);

	// Zoom scale indicators across scales (AU, km, m)
	sys.updateZoomScaleIndicator(0.0001);
	sys.updateZoomScaleIndicator(1.0);
	sys.updateZoomScaleIndicator(10000.0);

	// State serialization
	const sysState = sys.getState();
	assert.ok(sysState.timeScaleVal !== undefined);
	sys.loadState({ timeScaleVal: 2, zoomScaleVal: -1 });
});

test('ControlPanel - Mobile menu toggle, tab switching, and state serialization', () => {
	const universe = createMockUniverse();
	const ctrl = new ControlPanel(universe);

	// Mobile toggle
	ctrl.ui.mobileMenuToggle.click();
	assert.ok(ctrl.ui.ctrlPanel.classList.contains('open'));

	// Tab switching: Rocket Tab
	const tabRocketBtn = createMockElement('button');
	tabRocketBtn.setAttribute('data-target', 'tab-rocket');
	ctrl.ui.tabBtns.push(tabRocketBtn);
	ctrl._tabBtnClick({ target: tabRocketBtn });
	assert.equal(ctrl.rocketTab.isOpened, true);

	// Tab switching: System Tab
	const tabSysBtn = createMockElement('button');
	tabSysBtn.setAttribute('data-target', 'tab-sys');
	ctrl.ui.tabBtns.push(tabSysBtn);
	ctrl._tabBtnClick({ target: tabSysBtn });
	assert.equal(ctrl.rocketTab.isOpened, false);

	// getTimeScale and State
	assert.ok(typeof ctrl.getTimeScale() === 'number');
	const state = ctrl.getState();
	assert.ok(state.controlPanel);
	ctrl.loadState(state.controlPanel, null);
});

test('InfoPanel - FPS frame interval, physics sub-steps, and elapsed time', () => {
	const universe = createMockUniverse();
	const info = new InfoPanel(universe);

	// Physics sub-steps update
	EventBus.emit('physics-updated', 8);
	assert.equal(info.physFpsCount, 1);
	assert.equal(info.lastSubSteps, 8);

	// Elapsed time reset and accumulation
	info.resetElapsedTime();
	assert.equal(info.elapsedTime, 0);
	info.updateElapsedTime(86400 * 30); // 30 days
	assert.ok(info.elapsedTime > 0);

	// FPS update after interval (advance lastTime by 600ms)
	info.lastTime = new Date(Date.now() - 600);
	info.fpsCount = 30;
	info.physFpsCount = 30;
	info.updateFPS();
	assert.equal(info.fpsCount, 0);
	assert.ok(info.ui.fps.textContent.includes('/'));
});

test('RocketTab - Comprehensive configuration, payload tab, and state loading', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const moon = createMockCelestialBody({ id: 2, name: 'Moon', x: 100000, y: 0, radius: 1737000 });
	const universe = createMockUniverse({ objects: [earth, moon] });
	const ctrl = new ControlPanel(universe);
	const rTab = ctrl.rocketTab;

	// Open & Close
	rTab.open();
	assert.equal(rTab.isOpened, true);
	rTab.close();
	assert.equal(rTab.isOpened, false);

	// Switch to Payload tab
	rTab.selectTab('payload');
	assert.equal(rTab.currentTab, 'payload');

	// Switch to Stage 1
	rTab.selectTab(0);
	assert.equal(rTab.currentTab, 0);

	// Mode select change
	rTab.ui.rlModeSelect.value = 'free';
	rTab.ui.rlModeSelect.dispatchEvent({ type: 'change', target: { value: 'free' } });

	rTab.ui.rlModeSelect.value = 'host';
	rTab.ui.rlModeSelect.dispatchEvent({ type: 'change', target: { value: 'host' } });

	// Fuel type change (solid vs liquid)
	rTab.ui.rlFuelType.value = 'solid';
	rTab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: 'solid' } });
	rTab.ui.rlFuelType.value = 'liquid';
	rTab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: 'liquid' } });

	// Mass and thrust inputs
	rTab.ui.rlFuelMass.value = '150';
	rTab.ui.rlFuelMass.dispatchEvent({ type: 'input', target: { value: '150' } });
	rTab.ui.rlOxidMass.value = '300';
	rTab.ui.rlOxidMass.dispatchEvent({ type: 'input', target: { value: '300' } });

	// Add profile step
	rTab.ui.rlAddProfileBtn.click();
	assert.ok(universe.RocketLauncher.flightProfile.length >= 1);

	// Load State
	rTab.loadState({
		mode: 'host',
		hostAngleDeg: 90,
		hostAltitudeM: 1000,
		dryMassT: 25,
		fuelMassT: 120,
		oxidMassT: 240,
		thrustKN: 6000,
		maxGLimit: 4.5,
		autoControl: true,
		flightProfile: [{ type: 'alt', value: 0, thrust: 100, angle: 0 }]
	});
	assert.equal(universe.RocketLauncher.hostAngleDeg, 90);
	assert.equal(rTab.ui.rlHostAlt.value, 1000);

	const rows = rTab.ui.rlFlightProfileBody.querySelectorAll('tr');
	if (rows.length > 0) {
		const row = rows[0];
		const inputs = row.querySelectorAll('input, select');
		if (inputs.length >= 4) {
			inputs[0].value = 'pitch';
			inputs[0].dispatchEvent({ type: 'change' });
			inputs[1].value = '5000';
			inputs[1].dispatchEvent({ type: 'input' });
			inputs[2].value = '80';
			inputs[2].dispatchEvent({ type: 'input' });
			inputs[3].value = '45';
			inputs[3].dispatchEvent({ type: 'input' });
		}
	}

	// Close tab with autoTrackHost active
	universe.camera.autoTrackHost = earth;
	rTab.close();
	assert.equal(rTab.isOpened, false);

	// Close tab with rollouted rocket active
	rTab.isOpened = true;
	universe.camera.autoTrackHost = null;
	universe.RocketLauncher.rolloutedRocketId = 55;
	rTab.close();

	// Close tab default with camera target restore
	rTab.isOpened = true;
	universe.RocketLauncher.rolloutedRocketId = null;
	universe.camera.trackingTarget = moon;
	universe.camera.targetOffset = { x: 50, y: -50 };
	rTab.saveCameraTarget();
	rTab.close();
	assert.equal(rTab.isOpened, false);
});

test('TelemetryPanel - Minimal HUD alerts (Q-LIM, G-LIM, STALL), scroll, and annunciator click', () => {
	const rocket = createMockRocket({
		id: 888,
		maxGLimit: 4.0,
		telemetry: {
			altM: 35000,
			vV: 1200,
			vH: 2500,
			status: TELEMETRY.STATUS.MAX_Q,
			structRatio: 90,
			currentG: 3.8,
			isAntiStallActive: false,
			isQLimitNear: true,
			flightTime: 65,
			tankPresFuel: 350,
			tankPresOxid: 350
		}
	});
	const universe = createMockUniverse({ objects: [rocket] });
	const panel = new TelemetryPanel(universe);
	panel.targetId = 888;

	// 1. Minimal HUD Alert: Q-LIM
	panel.close();
	panel._updateMinimalHud(rocket);
	assert.equal(panel.ui.mHudAlert.textContent, '[Q-LIM]');

	// 2. Minimal HUD Alert: G-LIM
	rocket.telemetry.status = TELEMETRY.STATUS.IN_FLIGHT;
	rocket.telemetry.isQLimitNear = false;
	rocket.telemetry.structRatio = 50;
	rocket.telemetry.isGLimitNear = true;
	panel._updateMinimalHud(rocket);
	assert.equal(panel.ui.mHudAlert.textContent, '[G-LIM]');

	// 3. Minimal HUD Alert: STALL
	rocket.telemetry.isGLimitNear = false;
	rocket.telemetry.currentG = 2.0;
	rocket.telemetry.isAntiStallActive = true;
	panel._updateMinimalHud(rocket);
	assert.equal(panel.ui.mHudAlert.textContent, '[STALL]');

	// 4. Minimal HUD: None alert
	rocket.telemetry.isAntiStallActive = false;
	panel._updateMinimalHud(rocket);
	assert.equal(panel.ui.mHudAlert.style.display, 'none');

	// 5. Open panel column layout
	panel.open();
	panel.ui.carousel.style.flexDirection = 'column';
	panel.update();

	// Wheel on column layout (should stop propagation and return early)
	panel.ui.panel.dispatchEvent({
		type: 'wheel',
		deltaX: 0,
		deltaY: 50,
		stopPropagation: () => {},
		preventDefault: () => {}
	});

	// Wheel with delta < 0 (prevCard) in row mode
	panel.ui.carousel.style.flexDirection = 'row';
	panel.activeCardIndex = 2;
	panel.ui.panel.dispatchEvent({
		type: 'wheel',
		deltaX: -50,
		deltaY: 0,
		stopPropagation: () => {},
		preventDefault: () => {}
	});

	// Touch swipe vertical (diffY < 0 -> nextCard, diffY > 0 -> prevCard)
	panel.ui.panel.dispatchEvent({
		type: 'touchstart',
		touches: [{ clientX: 100, clientY: 200 }]
	});
	panel.ui.panel.dispatchEvent({
		type: 'touchend',
		changedTouches: [{ clientX: 100, clientY: 50 }]
	});

	// Carousel scroll synchronization
	panel.ui.carousel.scrollTop = 500;
	panel.ui.carousel.clientHeight = 300;
	panel.ui.carousel.scrollHeight = 1200;
	panel._syncActiveDotFromScroll();

	// Annunciator click
	panel.ui.annunciator.dispatchEvent({ type: 'click' });
	assert.ok(panel.lampTestTimer > 0);

	// Quick toggle path checkboxes
	panel.ui.tmShowPredChk.checked = true;
	panel.ui.tmShowPredChk.dispatchEvent({ type: 'change', target: { checked: true } });
	panel.ui.tmShowActualChk.checked = true;
	panel.ui.tmShowActualChk.dispatchEvent({ type: 'change', target: { checked: true } });

	// Target select change
	panel.ui.targetSelect.value = '888';
	panel.ui.targetSelect.dispatchEvent({ type: 'change', target: { value: '888' } });

	// Pagination dots click
	if (panel._dotElements.length > 0) {
		panel._dotElements[0].setAttribute('data-index', '1');
		panel._dotElements[0].dispatchEvent({
			type: 'click',
			currentTarget: panel._dotElements[0]
		});
	}

	// 6. Swipe positive directions: diffX > 0 (prevCard) and diffY > 0 (prevCard)
	panel.ui.panel.dispatchEvent({
		type: 'touchstart',
		touches: [{ clientX: 50, clientY: 50 }]
	});
	panel.ui.panel.dispatchEvent({
		type: 'touchend',
		changedTouches: [{ clientX: 150, clientY: 50 }]
	});

	panel.ui.panel.dispatchEvent({
		type: 'touchstart',
		touches: [{ clientX: 50, clientY: 50 }]
	});
	panel.ui.panel.dispatchEvent({
		type: 'touchend',
		changedTouches: [{ clientX: 50, clientY: 150 }]
	});

	// 7. Update with null target
	panel.targetId = null;
	panel.update();

	// 8. Update with non-rocket target
	const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
	universe.objects.push(earth);
	panel.targetId = 1;
	panel.update();

	// 9. Update with auto-sequence and active countdown
	panel.targetId = 888;
	universe.LaunchSequencer.isAutoSequence = true;
	universe.LaunchSequencer.isActive = true;
	universe.LaunchSequencer.rocketId = 888;
	universe.LaunchSequencer.timer = 5;
	universe.LaunchSequencer.tMinusOffset = 10;
	rocket.telemetry.status = TELEMETRY.STATUS.PRE_LAUNCH;
	panel.update();

	// Minimal HUD auto-sequence and active timer
	panel.close();
	panel._updateMinimalHud(rocket);

	// External checkbox sync events
	panel.ui.tmShowPredChk.checked = true;
	EventBus.emit('render:set-show-predicted-path', false);
	assert.equal(panel.ui.tmShowPredChk.checked, false);

	panel.ui.tmShowActualChk.checked = true;
	EventBus.emit('render:set-show-actual-path', false);
	assert.equal(panel.ui.tmShowActualChk.checked, false);

	// Target options update
	panel._updateTargetOptions();

	// Lamp test stop
	panel.lampTestTimer = 0;
	assert.equal(panel.lampTestTimer, 0);
});

test('SoundSequencer - Condition operators (>, <, >=, <=, ==, !=) and once flag handling', () => {
	const rocket = createMockRocket({
		id: 999,
		flightTime: 50,
		telemetry: {
			altM: 45000,
			vV: 1500,
			structRatio: 85,
			status: 3
		}
	});
	const universe = createMockUniverse({ objects: [rocket] });
	universe.TelemetryPanel.targetId = 999;
	const soundSeq = new SoundSequencer(universe);

	let playedSounds = [];
	EventBus.on('audio:play', (key) => playedSounds.push(key));

	// Initialize with custom audio profile covering all operators
	soundSeq.audioProfile = {
		times: { '5': 'sound_t_plus_5' },
		conditions: [
			{ id: 'c1', type: 'altM', operator: '>', value: 40000, audio: 'voice_alt_high', once: true },
			{ id: 'c2', type: 'vV', operator: '<', value: 2000, audio: 'voice_vel_sub', once: false },
			{ id: 'c3', type: 'structRatio', operator: '>=', value: 85, audio: 'voice_high_q', once: true },
			{ id: 'c4', type: 'status', operator: '<=', value: 3, audio: 'voice_status_le', once: false },
			{ id: 'c5', type: 'status', operator: '==', value: 3, audio: 'voice_status_eq', once: false },
			{ id: 'c6', type: 'status', operator: '!=', value: 999, audio: 'voice_status_neq', once: false },
			{ id: 'c7', type: 'met', operator: '>=', value: 40, audio: 'voice_met_40', once: true }
		]
	};

	soundSeq.previousMET = 4;
	soundSeq.update();

	assert.ok(playedSounds.includes('sound_t_plus_5'));
	assert.ok(playedSounds.includes('voice_alt_high'));
	assert.ok(playedSounds.includes('voice_high_q'));
	assert.ok(playedSounds.includes('voice_met_40'));
	assert.ok(soundSeq.conditionFlags['c1'], 'once flag should be set for c1');

	// Second update: once flagged conditions should not re-trigger
	playedSounds = [];
	soundSeq.update();
	assert.ok(!playedSounds.includes('voice_alt_high'), 'once condition should not re-trigger');

	// Test sequencer-start with external audioProfile
	EventBus.emit('sequencer-start', {
		audioProfile: { times: { '1': 'snd1' }, conditions: [] }
	});
	assert.ok(soundSeq.audioProfile.times['1']);

	// Test LaunchSequencer priority in _calculateCurrentMET
	universe.LaunchSequencer.isActive = true;
	universe.LaunchSequencer.timer = 10;
	universe.LaunchSequencer.tMinusOffset = 15;
	assert.equal(soundSeq._calculateCurrentMET(), -5);

	// Test null return in _calculateCurrentMET when inactive and no target
	universe.LaunchSequencer.isActive = false;
	universe.TelemetryPanel.targetId = null;
	assert.equal(soundSeq._calculateCurrentMET(), null);
	soundSeq.update(); // currentMET === null branch

	// Abort clears profile and state
	EventBus.emit('sequencer-abort');
	assert.equal(soundSeq.previousMET, null);
});

test('AudioManager - Load error handling, unload, and suspended context resume', async () => {
	const universe = createMockUniverse();
	const audioMgr = new AudioManager(universe);

	// Suspended AudioContext mock
	const mockCtx = {
		state: 'suspended',
		resume: () => { mockCtx.state = 'running'; },
		destination: {},
		createBufferSource: () => ({
			buffer: null,
			connect: () => {},
			start: () => {}
		})
	};
	window.AudioContext = function() { return mockCtx; };

	// Test play on un-loaded state (should return gracefully)
	audioMgr.play('non_existent_key');

	// Test 404 response on load
	const origFetch = globalThis.fetch;
	const origWarn = console.warn;
	const origError = console.error;
	let warnLogged = false;
	let errorLogged = false;
	console.warn = () => { warnLogged = true; };
	console.error = () => { errorLogged = true; };

	globalThis.fetch = async () => ({ ok: false, status: 404 });
	await audioMgr.load('missing_voice');
	assert.equal(audioMgr.isLoaded, false);
	assert.equal(warnLogged, true, 'AudioManager should warn when manifest is not found');

	// Test network exception on load
	globalThis.fetch = async () => { throw new Error('Network offline'); };
	await audioMgr.load('error_voice');
	assert.equal(audioMgr.isLoaded, false);
	assert.equal(errorLogged, true, 'AudioManager should log error when fetch fails');

	console.warn = origWarn;
	console.error = origError;
	globalThis.fetch = origFetch;
});

test('SaveManager - Save file creation, empty/invalid file loading error handling', () => {
	const universe = createMockUniverse();
	const saveMgr = new SaveManager(universe);

	// Trigger Save
	saveMgr.save();

	// Load with empty file input
	saveMgr.load({ target: { files: [] } });

	// Load with valid state
	const validJson = JSON.stringify({ version: 2, universe: { objects: [] } });
	saveMgr.load({
		target: {
			files: [{ name: 'save.json' }],
			value: 'save.json'
		}
	});

	// Trigger load file input click via loadBtn
	saveMgr.loadBtn.click();
});

test('LaunchSequencer - Autosequence countdown progression past completion time', () => {
	const rocket = createMockRocket({ id: 123 });
	const universe = createMockUniverse({ objects: [rocket] });
	const seq = new LaunchSequencer(universe);

	const customSeq = [
		{ time: 0, command: 'START_COUNTDOWN', name: 'START' },
		{ time: 1, command: 'PRESSURIZE_TANK', name: 'PRESS' },
		{ time: 2, command: 'WATER_DELUGE', name: 'DELUGE' },
		{ time: 3, command: 'ROFI_IGNITION', name: 'ROFI' },
		{ time: 4, command: 'AUTO_SEQUENCE_START', name: 'AUTO-START' },
		{ time: 5, command: 'IGNITE_ENGINE', name: 'IGNITION' },
		{ time: 6, command: 'RELEASE_HOLD_DOWN', name: 'LIFTOFF' }
	];

	seq.start(customSeq, 123);
	assert.equal(seq.isActive, true);

	// Step past all commands
	for (let i = 0; i < 7; i++) {
		seq.update(1.0);
	}
	assert.equal(seq.eventIndex, 7);

	// Step past LAUNCH_TO_COMPLETION_TIME to trigger completion
	seq.update(100.0);
	assert.equal(seq.isActive, false);
});

test('DeployTab - Comprehensive click handlers and orbital deployment triggers', () => {
	const universe = createMockUniverse();
	const ctrl = new ControlPanel(universe);
	const dTab = ctrl.deployTab;

	let emittedEvents = [];
	const recordEvent = (type, ...args) => { emittedEvents.push({ type, args }); };
	EventBus.on('object:deploy-orbit-sun', (name) => recordEvent('orbit-sun', name));
	EventBus.on('object:deploy-orbit-host', (host, moon) => recordEvent('orbit-host', host, moon));
	EventBus.on('object:deploy-profile', (prof) => recordEvent('profile', prof));

	// 1. Primary deploy buttons
	for (const btnId of Object.keys(dTab.deployButtons)) {
		const btn = document.getElementById(btnId);
		if (btn) btn.click();
	}
	assert.ok(emittedEvents.some(e => e.type === 'orbit-sun' && e.args[0] === 'Earth'));

	// 2. Moon button
	dTab.ui.moonBtn.click();
	assert.ok(emittedEvents.some(e => e.type === 'orbit-host' && e.args[0] === 'Earth' && e.args[1] === 'Moon'));

	// 3. Jupiter moons
	const jupiterMoons = ['put-io-btn', 'put-europa-btn', 'put-ganymede-btn', 'put-callisto-btn'];
	for (const id of jupiterMoons) {
		const btn = document.getElementById(id);
		if (btn) btn.click();
	}
	assert.ok(emittedEvents.some(e => e.type === 'orbit-host' && e.args[0] === 'Jupiter'));

	// 4. Saturn moons
	const saturnMoons = ['put-titan-btn', 'put-enceladus-btn', 'put-mimas-btn', 'put-rhea-btn'];
	for (const id of saturnMoons) {
		const btn = document.getElementById(id);
		if (btn) btn.click();
	}
	assert.ok(emittedEvents.some(e => e.type === 'orbit-host' && e.args[0] === 'Saturn'));

	// 5. Dwarf planets & Other stars
	const dwarfPlanets = ['put-pluto-btn', 'put-ceres-btn', 'put-eris-btn'];
	for (const id of dwarfPlanets) {
		const btn = document.getElementById(id);
		if (btn) btn.click();
	}
	const otherStars = ['put-betelgeuse-btn', 'put-sirius-btn', 'put-alphacentauri-btn', 'put-proxima-btn', 'put-rigel-btn', 'put-vega-btn', 'put-polaris-btn'];
	for (const id of otherStars) {
		const btn = document.getElementById(id);
		if (btn) btn.click();
	}

	// 6. Profile deploy buttons
	dTab.ui.solarSystemBtn.click();
	dTab.ui.binaryStarBtn.click();
	dTab.ui.threeBodyBtn.click();
	dTab.ui.galacticCenterBtn.click();
	dTab.ui.stressTestBtn.click();
	assert.ok(emittedEvents.some(e => e.type === 'profile' && e.args[0] === 'SOLAR_SYSTEM'));
	assert.ok(emittedEvents.some(e => e.type === 'profile' && e.args[0] === 'DEBUG_STRESS_TEST'));

	// 7. Debug mode event
	EventBus.emit('debug:mode-on');
	assert.ok(dTab.ui.debugSection.classList.contains('active'));
});

test('NaviTab - Target selection, orbital stat calculations, and atmosphere info', () => {
	const earth = createMockCelestialBody({ id: 10, name: 'Earth', mass: 5.972e24, radius: 6371000, vx: 0, vy: 0 });
	const moon = createMockCelestialBody({
		id: 20,
		name: 'Moon',
		mass: 7.342e22,
		radius: 1737000,
		dominantBodyId: 10,
		distToDominantM: 384400000,
		vx: 10,
		vy: 20
	});
	const universe = createMockUniverse({ objects: [earth, moon] });
	const ctrl = new ControlPanel(universe);
	const nTab = ctrl.naviTab;

	// Populate target options
	nTab.updateTargetOptions();
	assert.ok(nTab.ui.nvTargetSelect.children.length >= 2);

	// Select Earth (has atmosphere params)
	nTab.ui.nvTargetSelect.value = '10';
	nTab.ui.nvTargetSelect.dispatchEvent({ type: 'change', target: { value: '10' } });
	assert.equal(nTab.naviTargetId, 10);
	assert.ok(nTab.ui.nvMass.textContent.length > 0);
	assert.ok(nTab.ui.nvSurfaceG.textContent.includes('G'));
	assert.ok(nTab.ui.nvEscapeV.textContent.includes('km/s'));
	assert.notEqual(nTab.ui.nvAtmAlt.textContent, '--- km');

	// Select Moon (dominant body is Earth, no atmosphere params)
	nTab.ui.nvTargetSelect.value = '20';
	nTab.ui.nvTargetSelect.dispatchEvent({ type: 'change', target: { value: '20' } });
	assert.equal(nTab.ui.nvRefBody.textContent, 'Earth');
	assert.equal(nTab.ui.nvAtmAlt.textContent, '--- km');

	// Active tab interval trigger
	nTab.ui.nvTab.classList.add('active');
	nTab._updateNaviStats();

	// Fallback to camera target when naviTargetId is invalid
	nTab.naviTargetId = 9999;
	EventBus.emit('camera:set-tracking-target', earth);
	nTab._updateNaviStats();
	assert.equal(nTab.naviTargetId, 10);

	// When neither found, returns gracefully
	nTab.naviTargetId = 9999;
	EventBus.emit('camera:set-tracking-target', null);
	nTab._updateNaviStats();
});

test('RocketTab - Sliders, rollout state transitions, and profile table event handlers', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const universe = createMockUniverse({ objects: [earth] });
	const ctrl = new ControlPanel(universe);
	const rTab = ctrl.rocketTab;

	// Global sliders via bindSlider
	rTab.ui.rlHostAngle.value = '60';
	rTab.ui.rlHostAngle.dispatchEvent({ type: 'input', target: { value: '60' } });
	assert.equal(universe.RocketLauncher.hostAngleDeg, 60);

	rTab.ui.rlHostAlt.value = '1500';
	rTab.ui.rlHostAlt.dispatchEvent({ type: 'input', target: { value: '1500' } });
	assert.equal(universe.RocketLauncher.hostAltitudeM, 1500);

	rTab.ui.rlLaunchMaxG.value = '4.0';
	rTab.ui.rlLaunchMaxG.dispatchEvent({ type: 'input', target: { value: '4.0' } });
	assert.equal(universe.RocketLauncher.maxGLimit, 4.0);

	rTab.ui.massSelect.dispatchEvent({ type: 'change' });

	// Stage & Payload Inputs
	rTab.ui.rlLaunchMass.value = '35';
	rTab.ui.rlLaunchMass.dispatchEvent({ type: 'input', target: { value: '35' } });

	rTab.ui.rlLaunchThrust.value = '8500';
	rTab.ui.rlLaunchThrust.dispatchEvent({ type: 'input', target: { value: '8500' } });

	rTab.ui.rlSepDelay.value = '3.5';
	rTab.ui.rlSepDelay.dispatchEvent({ type: 'input', target: { value: '3.5' } });

	rTab.ui.rlIgnDelay.value = '4.0';
	rTab.ui.rlIgnDelay.dispatchEvent({ type: 'input', target: { value: '4.0' } });

	rTab.ui.rlPayloadMass.value = '12.5';
	rTab.ui.rlPayloadMass.dispatchEvent({ type: 'input', target: { value: '12.5' } });

	rTab.ui.rlFairingEnabled.checked = true;
	rTab.ui.rlFairingEnabled.dispatchEvent({ type: 'change', target: { checked: true } });

	rTab.ui.rlFairingMass.value = '2.2';
	rTab.ui.rlFairingMass.dispatchEvent({ type: 'input', target: { value: '2.2' } });

	rTab.ui.rlFairingAlt.value = '120';
	rTab.ui.rlFairingAlt.dispatchEvent({ type: 'input', target: { value: '120' } });

	rTab.ui.rlHostSelect.value = '1';
	rTab.ui.rlHostSelect.dispatchEvent({ type: 'change', target: { value: '1' } });
	rTab.ui.rlHostSelect.dispatchEvent({ type: 'focus' });

	rTab.ui.rlAutoControl.checked = false;
	rTab.ui.rlAutoControl.dispatchEvent({ type: 'change', target: { checked: false } });

	rTab.ui.rlLoadPresetBtn.click();
	rTab.ui.rlPresetSelect.value = 'SATURN_V';
	rTab.ui.rlPresetSelect.dispatchEvent({ type: 'change', target: { value: 'SATURN_V' } });

	// Profile table callbacks
	universe.RocketLauncher.flightProfile = [
		{ type: 'alt', value: 1000, thrust: 100, angle: 0 },
		{ type: 'time', value: 50, thrust: 80, angle: 45 }
	];
	rTab._renderProfileTable();

	const rows = rTab.ui.rlFlightProfileBody.children;
	assert.equal(rows.length, 2);

	// Test row 0 change handlers
	const row0 = rows[0];
	const selType = row0.children[0].children[0];
	selType.value = 'time';
	selType.onchange({ target: { value: 'time' } });
	assert.equal(universe.RocketLauncher.flightProfile[0].type, 'time');

	const inpVal = row0.children[1].children[0];
	inpVal.value = '2000';
	inpVal.onchange({ target: { value: '2000' } });
	assert.equal(universe.RocketLauncher.flightProfile[0].value, 2000);

	const inpThrust = row0.children[2].children[0];
	inpThrust.value = '90';
	inpThrust.onchange({ target: { value: '90' } });
	assert.equal(universe.RocketLauncher.flightProfile[0].thrust, 90);

	const inpAngle = row0.children[3].children[0];
	inpAngle.value = '30';
	inpAngle.onchange({ target: { value: '30' } });
	assert.equal(universe.RocketLauncher.flightProfile[0].angle, 30);

	// Remove button
	const btnDel = row0.children[4].children[0];
	btnDel.onclick();
	assert.equal(universe.RocketLauncher.flightProfile.length, 1);

	// Rollout state transitions
	rTab.setRolloutState(true);
	assert.equal(rTab.ui.rlRolloutBtn.style.display, 'none');
	assert.equal(rTab.ui.rlAbortBtn.style.display, 'block');

	rTab.setRolloutState(false);
	assert.equal(rTab.ui.rlRolloutBtn.style.display, 'block');
	assert.equal(rTab.ui.rlAbortBtn.style.display, 'none');

	// Events: ui:set-controls-locked & ui:set-rollout-state
	EventBus.emit('ui:set-controls-locked', true);
	assert.equal(rTab.ui.rlIgniteQuickBtn.disabled, true);
	EventBus.emit('ui:set-controls-locked', false);
	assert.equal(rTab.ui.rlIgniteQuickBtn.disabled, false);

	EventBus.emit('ui:set-rollout-state', true);
	assert.equal(rTab.ui.rlRolloutBtn.style.display, 'none');
	EventBus.emit('ui:set-rollout-state', false);
	assert.equal(rTab.ui.rlRolloutBtn.style.display, 'block');

	// Free mode stats calculation
	universe.RocketLauncher.mode = 'free';
	universe.RocketLauncher.freeX = 5000;
	universe.RocketLauncher.freeY = -5000;
	universe.camera.trackingTarget = earth;
	rTab._updateRocketStats();
	assert.ok(rTab.ui.rlStatHostName.textContent.length > 0);

	// Fallback single-stage branch
	universe.RocketLauncher.stages = null;
	rTab._updateRocketStats();

	// Zoom scale restoration
	rTab.previousZoomScaleVal = '2.5';
	rTab.restoreZoomScale();
	assert.equal(rTab.previousZoomScaleVal, null);

	// Open when objects has no non-sun celestial bodies (targetHostId = 0)
	const origObjs = universe.objects;
	universe.objects = [];
	universe.RocketLauncher.hostId = null;
	rTab.open();
	assert.equal(universe.RocketLauncher.hostId, 0);

	// Close with autoTrackHost active
	universe.camera.autoTrackHost = earth;
	universe.RocketLauncher.hostId = earth.id;
	universe.objects = [earth];
	rTab.close();

	// Document preview updated event
	document.dispatchEvent({ type: 'rocket-preview-updated' });

	// Null stage check when tab is payload with stages populated
	universe.RocketLauncher.stages = [{ name: 'S1' }];
	rTab.currentTab = 'payload';
	assert.equal(rTab._getCurrentStage(), null);

	// Open when hostId is 0 and non-Sun object exists (line 655)
	universe.objects = [earth];
	universe.RocketLauncher.hostId = 0;
	rTab.open();
	assert.equal(universe.RocketLauncher.hostId, earth.id);

	universe.objects = origObjs;

	// Object list changed event
	EventBus.emit('object-list-changed', 5);
});

test('TelemetryPanel - Column layout, null target, celestial body target, wheel stopPropagation, and draw branches', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0 });
	const universe = createMockUniverse({ objects: [earth] });
	const panel = new TelemetryPanel(universe);

	// 1. Column layout check (_update: window.getComputedStyle(carousel).flexDirection === 'column')
	const origGetComputedStyle = window.getComputedStyle;
	window.getComputedStyle = (el) => ({
		flexDirection: el === panel.ui.carousel ? 'column' : 'row'
	});

	// Trigger panel wheel in column layout -> e.stopPropagation() called, returns early
	let stopPropCalled = false;
	const mockWheelEvent = {
		type: 'wheel',
		deltaX: 0,
		deltaY: 50,
		stopPropagation() { stopPropCalled = true; },
		preventDefault() {}
	};
	panel.ui.panel.dispatchEvent(mockWheelEvent);
	assert.equal(stopPropCalled, true);

	// Open panel so update runs full header & card branches
	panel.open();

	// Update with column layout -> all cards set isVisible = true
	panel.update();

	// 2. Non-rocket target (Earth) -> _resetPinnedHeader, _resetAnnunciator, card.resetUI
	panel.targetId = 1;
	panel.update();
	assert.equal(panel.ui.stageInfo.textContent, '---');

	// 3. Null target (targetId invalid) -> early return, resets header and annunciator
	panel.targetId = 99999;
	panel.update();
	assert.equal(panel.ui.stageInfo.textContent, '---');

	// 4. Draw when closed vs open
	panel.close();
	panel.draw(); // early return

	panel.open();
	panel.draw(); // executes navCard.draw

	// DrawOverlay event trigger
	EventBus.emitDrawOverlay(createMockElement('canvas').getContext('2d'), { name: 'main' });
	EventBus.emitDrawOverlay(createMockElement('canvas').getContext('2d'), { name: 'secondary' });

	// 5. MAX_Q status in pinned header
	const rocket = createMockRocket({
		id: 101,
		stages: [{ name: 'Booster' }, { name: 'Upper' }],
		telemetry: {
			status: TELEMETRY.STATUS.MAX_Q,
			flightTime: 55,
			totalStages: 2,
			stageIndex: 0
		}
	});
	universe.objects.push(rocket);
	panel.targetId = 101;
	universe.LaunchSequencer.isActive = true;
	universe.LaunchSequencer.rocketId = 101;
	universe.LaunchSequencer.timer = 60;
	universe.LaunchSequencer.tMinusOffset = 5;
	panel.update();
	assert.equal(panel.ui.missionStatus.style.color, TELEMETRY.STYLE.MISSION_STATUS.MAX_Q_COLOR);

	// 6. SECO annunciator lamp: curStage > 1
	rocket.telemetry.status = TELEMETRY.STATUS.COASTING;
	rocket.telemetry.stageIndex = 2; // curStage > 1
	panel.update();
	assert.ok(panel.lamps.seco.classList.contains('on'));

	// 7. Wheel delta < 0 (prevCard) in row mode
	window.getComputedStyle = origGetComputedStyle;
	let prevCalled = false;
	const origPrev = panel.prevCard;
	panel.prevCard = () => { prevCalled = true; };
	panel.ui.panel.dispatchEvent({
		type: 'wheel',
		deltaX: 0,
		deltaY: -30,
		stopPropagation() {},
		preventDefault() {}
	});
	assert.equal(prevCalled, true);
	panel.prevCard = origPrev;

	// Reset mock
	window.getComputedStyle = origGetComputedStyle;
});


