import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse, createMockCelestialBody, createMockRocket, createMockElement } from '../test_helpers.mjs';

// Setup DOM mocks before module imports
setupMockDOM();

import { Camera } from '../../scripts/gravsim_camera.js';
import { Renderer } from '../../scripts/gravsim_renderer.js';
import { OverlayRenderer } from '../../scripts/gravsim_overlay_renderer.js';
import { PadEffectRenderer } from '../../scripts/gravsim_pad_effect.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { VisualEffectManager } from '../../scripts/gravsim_visual_effect_manager.js';
import { Debris, Rocket } from '../../scripts/gravsim_object.js';
import { TrailLineRenderer, EffectRenderer } from '../../scripts/gravsim_trail_renderer.js';
import { Trajectory } from '../../scripts/gravsim_trajectory.js';
import { EffectTrail } from '../../scripts/gravsim_effect_trail.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { ROCKET_LAUNCHER_CONFIG, TRAIL_MODE, RENDER, OBJECT_STATE, ROCKET_VISUAL, PAD_EFFECT } from '../../scripts/gravsim_const.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';

test('Camera - Viewport state, zooming limits, and pan translation', () => {
	const camera = new Camera();

	assert.equal(camera.minZoomExp, -2);
	assert.equal(camera.maxZoomExp, 9);
	assert.equal(camera.currentZoomExp, 0);

	// Pan without rotation
	camera.addPan(100, 50);
	assert.equal(camera.targetOffset.x, -100);
	assert.equal(camera.targetOffset.y, -50);

	// Reset offset
	camera.setTargetOffset(0, 0);
	assert.equal(camera.targetOffset.x, 0);
	assert.equal(camera.targetOffset.y, 0);

	// Zoom manipulation
	camera.addZoom(1.5);
	assert.equal(camera.targetZoomExp, 1.5);

	// Rotation manipulation
	camera.setTargetRotation(Math.PI / 4);
	assert.equal(camera.targetRotation, Math.PI / 4);

	// Lerp interpolation
	camera.update(0.1); // dt = 0.1s
	assert.ok(camera.currentZoomExp > 0, 'Current zoom should interpolate towards target');
	assert.ok(camera.currentZoomExp <= 1.5);
	assert.ok(camera.currentRotation > 0, 'Current rotation should interpolate towards target');

	const renderState = camera.getRenderState();
	assert.equal(renderState.zoomExp, camera.currentZoomExp);
	assert.equal(renderState.rotation, camera.currentRotation);
});

test('Camera - Tracking target transition prevents screen jump', () => {
	const camera = new Camera();
	const bodyA = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0 });
	const bodyB = createMockCelestialBody({ id: 2, name: 'Moon', x: 384400, y: 0 });

	// Initially track bodyA
	camera.setTrackingTarget(bodyA);
	assert.equal(camera.trackingTarget.id, 1);
	assert.equal(camera.currentOffset.x, 0);

	// Switch to bodyB: should adjust currentOffset by relative distance
	camera.setTrackingTarget(bodyB);
	assert.equal(camera.trackingTarget.id, 2);
	assert.equal(camera.currentOffset.x, -384400, 'Offset should compensate target position jump');
	assert.equal(camera.targetOffset.x, 0, 'Target offset should seek to center');

	// Setting same target again does nothing
	camera.setTrackingTarget(bodyB);
	assert.equal(camera.trackingTarget.id, 2);

	// Setting null target
	camera.setTrackingTarget(null);
	assert.equal(camera.trackingTarget, null);
});

test('Camera - Auto tracking calculates launch phase zoom, attitude lock, and limits', () => {
	const camera = new Camera();
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const earthRadiusPx = UnitConvertUtils.m2pix(earth.radius);
	const rocket = createMockRocket({ id: 2, x: 0, y: -earthRadiusPx });

	camera.setAutoTracking(rocket, earth);
	assert.equal(camera.autoTrackHost.id, 1);
	assert.equal(camera.trackingTarget.id, 2);

	// 1. Phase 1: Lift-off (alt <= 500m)
	rocket.x = 0;
	rocket.y = -(earthRadiusPx + UnitConvertUtils.m2pix(200));
	camera.update(0.016);
	assert.ok(camera.targetZoomExp !== 0);

	// 2. Phase 2: Ascending (500m < alt <= 15000m)
	rocket.y = -(earthRadiusPx + UnitConvertUtils.m2pix(5000));
	camera.update(0.016);
	assert.ok(camera.targetOffset.y > 0, 'Phase 2 offset should shift upward');

	// 3. Phase 3: Transition to Orbit (15000m < alt <= 100000m)
	// Offset x slightly so groundLockAngle is non-zero
	rocket.x = UnitConvertUtils.m2pix(5000);
	rocket.y = -(earthRadiusPx + UnitConvertUtils.m2pix(50000));
	camera.update(0.016);
	assert.ok(camera.targetRotation !== 0, 'Phase 3 rotation should blend groundLockAngle');

	// 4. Phase 4: Deep space (alt > 100000m)
	rocket.x = 0;
	rocket.y = -(earthRadiusPx + UnitConvertUtils.m2pix(150000));
	camera.update(0.016);
	assert.equal(camera.targetRotation, 0);

	// 5. Exceed tracking limit ratio -> stops auto tracking (alt > radius * 0.2)
	rocket.y = -(earthRadiusPx + UnitConvertUtils.m2pix(earth.radius * 0.3));
	camera.update(0.016);
	assert.equal(camera.autoTrackHost, null, 'Should stop auto tracking when altitude limit exceeded');
});

test('Camera - Pan interruption, fitToTarget, and EventBus listeners', () => {
	const camera = new Camera();
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000 });
	const rocket = createMockRocket({ id: 2, x: 0, y: -6371000 });

	// Pan interruption while auto tracking
	camera.setAutoTracking(rocket, earth);
	assert.ok(camera.autoTrackHost);
	camera.addPan(50, 50);
	assert.equal(camera.autoTrackHost, null, 'Pan should stop auto tracking');

	// fitToTarget
	camera.fitToTarget(null); // null guard
	camera.fitToTarget(earth);
	assert.equal(camera.trackingTarget.id, 1);
	assert.equal(camera.targetRotation, 0);

	// EventBus camera listeners
	EventBus.emit('input:pan', 10, 20);
	assert.ok(camera.targetOffset.x !== 0);

	EventBus.emit('input:reset-offset');
	assert.equal(camera.targetOffset.x, 0);
	assert.equal(camera.targetOffset.y, 0);

	EventBus.emit('camera:set-tracking-target', rocket);
	assert.equal(camera.trackingTarget.id, 2);

	EventBus.emit('camera:set-target-zoom-exp', 3.0);
	assert.equal(camera.targetZoomExp, 3.0);

	EventBus.emit('camera:set-target-offset', 15, -25);
	assert.equal(camera.targetOffset.x, 15);
	assert.equal(camera.targetOffset.y, -25);

	EventBus.emit('camera:set-auto-tracking', rocket, earth);
	assert.equal(camera.autoTrackHost.id, 1);

	EventBus.emit('camera:stop-auto-tracking');
	assert.equal(camera.autoTrackHost, null);

	EventBus.emit('camera:fit-to-target', earth);
	assert.equal(camera.trackingTarget.id, 1);
});

test('Renderer - Setup pipeline, coordinate transform, and draw pass dispatch', () => {
	const mockCanvas = createMockElement('canvas');
	const renderer = new Renderer(mockCanvas, 'main');

	assert.equal(renderer.name, 'main');
	assert.ok(renderer.ctx);

	renderer.setRotation(0.3);
	assert.equal(renderer.rotation, 0.3);

	renderer.setZoomScale(1.8);
	assert.equal(renderer.zoomScale, 1.8);

	let beforeDrawn = false;
	let afterDrawn = false;
	const onBefore = (ctx, rc) => { beforeDrawn = true; };
	const onAfter = (ctx, rc) => { afterDrawn = true; };

	EventBus.onDrawBefore(onBefore);
	EventBus.onDrawAfter(onAfter);

	const dummyObj = {
		id: 10,
		x: 0,
		y: 0,
		drawCalled: false,
		draw(rc) { this.drawCalled = true; }
	};

	// Draw with non-zero rotation and trajectory toggle flags
	const renderState = {
		basis: dummyObj,
		cameraOffset: { x: 10, y: 20 },
		zoomScale: 2.0,
		zoomExp: 0.3,
		rotation: 0.5,
		showPredictedTrajectory: false,
		showActualFlightPath: false
	};

	renderer.draw([dummyObj], renderState);

	assert.equal(beforeDrawn, true);
	assert.equal(dummyObj.drawCalled, true);
	assert.equal(afterDrawn, true);
	assert.equal(renderer.renderContext.zoomScale, 2.0);
	assert.equal(renderer.renderContext.rotation, 0.5);
	assert.equal(renderer.renderContext.showPredictedTrajectory, false);
	assert.equal(renderer.renderContext.showActualFlightPath, false);

	EventBus._drawBeforeListeners = EventBus._drawBeforeListeners.filter(l => l.callback !== onBefore);
	EventBus._drawAfterListeners = EventBus._drawAfterListeners.filter(l => l.callback !== onAfter);
});

test('OverlayRenderer - Visibility toggles, label culling, scale bars, and debug overlay', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, color: '#3366cc' });
	const deadObj = createMockCelestialBody({ id: 2, name: 'Dead', x: 10, y: 10, state: 1 });
	const offscreenObj = createMockCelestialBody({ id: 3, name: 'Far', x: 1e9, y: 1e9 });
	const universe = createMockUniverse({ objects: [earth, deadObj, offscreenObj] });
	const overlay = new OverlayRenderer(universe);

	assert.equal(overlay.showLabels, false);
	assert.equal(overlay.showDebugOverlay, false);

	EventBus.emit('render:set-labels-visible', true);
	assert.equal(overlay.showLabels, true);

	EventBus.emit('render:set-debug-visible', true);
	assert.equal(overlay.showDebugOverlay, true);

	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const renderContext = {
		name: 'main',
		basis: earth,
		zoomScale: 1.0
	};

	// Early return for secondary renderer
	overlay.drawAfter(ctx, { ...renderContext, name: 'secondary' });
	overlay.drawOverlay(ctx, { ...renderContext, name: 'secondary' });

	// Main draw execution: labels and debug circles
	overlay.drawAfter(ctx, renderContext);

	// Debug overlay with high zoom (oneAUPx > 500)
	overlay.drawAfter(ctx, { ...renderContext, zoomScale: 1000.0 });

	// Scale bar thresholds
	// 1. High zoom -> meters scale (< 1000m)
	overlay.drawOverlay(ctx, { ...renderContext, zoomScale: 50.0 });

	// 2. Medium zoom -> kilometers scale (with frac variations)
	overlay.drawOverlay(ctx, { ...renderContext, zoomScale: 0.05 });
	overlay.drawOverlay(ctx, { ...renderContext, zoomScale: 0.02 });
	overlay.drawOverlay(ctx, { ...renderContext, zoomScale: 0.008 });

	// 3. Low zoom -> AU scale
	overlay.drawOverlay(ctx, { ...renderContext, zoomScale: 0.00000001 });

	// 4. Large value formatted (niceVal >= 10000)
	overlay.drawOverlay(ctx, { ...renderContext, zoomScale: 0.0001 });
});

test('PadEffectRenderer - Lifecycle, sequence events, and Verlet cable swing physics', () => {
	const pad = new PadEffectRenderer();
	assert.equal(pad.isActive, false);

	pad.start(101, 1);
	assert.equal(pad.isActive, true);
	pad.rocketRadius = 2.0;
	pad.startLaunchAngle = -Math.PI / 2;

	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const rocket = createMockRocket({ id: 101, isHoldDown: true, thrustAngle: -Math.PI / 2, radius: 2.0 });
	const host = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0 });

	const mockRc = {
		name: 'main',
		basis: host,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 }
	};

	const mockContext = {
		rocket: rocket,
		host: host,
		m2pix: (m) => m * 10,
		zoomScale: 1.0,
		padX_px: 0,
		padY_px: 0,
		isHoldDown: true
	};

	// Advance physics with full suite of sequence events
	pad.handleEvent('T-10m COUNTDOWN START');
	pad.handleEvent('T-3m CHILLDOWN');
	pad.handleEvent('T-45s PRESSURIZATION');
	pad.handleEvent('T-30s INTERNAL POWER');
	pad.handleEvent('T-15s WATER DELUGE');
	pad.handleEvent('T-7s ROFI');
	pad.handleEvent('T-3s MAIN ENGINE START');
	pad.update(0.016, mockContext);

	// Exercise venting and chilldown emitter branches with predictable random
	const origRandom = Math.random;
	try {
		Math.random = () => 0.001;
		pad.flags.isVenting = true;
		pad.flags.isPressurized = true;
		pad.flags.isChilldown = true;
		for (let i = 0; i < 5; i++) {
			pad.update(0.016, mockContext);
		}
	} finally {
		Math.random = origRandom;
	}

	// Draw background structure & particles
	pad.drawBackground(ctx, mockRc, mockContext);

	// Liftoff and umbilical disconnect
	pad.handleLiftoff();
	mockContext.isHoldDown = false;
	rocket.isHoldDown = false;

	// Draw foreground while particles still exist (before expiration)
	pad.drawForeground(ctx, mockRc, mockContext);

	// Update with large dt to expire particles and trigger particle splice
	pad.update(10.0, mockContext);

	// Fallback position and layout tests
	const emptyContext = { m2pix: (m) => m * 10 };
	pad.drawBackground(ctx, mockRc, emptyContext);
	const fallbackLayout = pad.getTowerLayout({});
	assert.ok(fallbackLayout.groundXM < 0);

	// Update several steps with disconnected cable (exercises swing, gravity, damping, and constraints)
	for (let i = 0; i < 10; i++) {
		pad.update(0.016, mockContext);
	}

	// Draw foreground strongback & swinging umbilical
	pad.drawForeground(ctx, mockRc, mockContext);

	pad.stop();
	assert.equal(pad.isActive, false);

	// --- Edge cases & Branch Coverage Enhancements for PadEffectRenderer ---
	// 1. Inactive calls (early return)
	pad.update(0.016, mockContext);
	pad.drawBackground(ctx, mockRc, mockContext);
	pad.drawForeground(ctx, mockRc, mockContext);

	// 2. Liftoff when lastContext is null
	const freshPad = new PadEffectRenderer();
	freshPad.start(201, 1);
	freshPad.handleLiftoff(); // lastContext is null
	freshPad.handleEvent('UNKNOWN EVENT'); // eventName doesn't match any branch

	// 3. update() with rocket baseRadiusM, bottomOffsetM, and zoomScale <= 0
	freshPad.flags.isInternalPower = true;
	freshPad.flags.isVenting = true;
	freshPad.flags.isPressurized = false; // vent rate branch when not pressurized
	freshPad.flags.isWaterDeluge = true;
	freshPad.flags.isROFI = true;
	const rocketWithOffsets = createMockRocket({
		id: 201,
		isHoldDown: true,
		thrustAngle: 0,
		baseRadiusM: 3.0,
		bottomOffsetM: 9.0
	});
	const zeroZoomCtx = {
		rocket: rocketWithOffsets,
		host: host,
		m2pix: (m) => m * 10,
		zoomScale: 0
	};
	freshPad.update(0.016, zeroZoomCtx);

	// 4. Clamping strongback and umbilical angles when exceeding max
	freshPad.strongbackAngle = 999;
	freshPad.umbilicalAngle = 999;
	rocketWithOffsets.isHoldDown = false;
	freshPad.update(0.016, { rocket: rocketWithOffsets, host, m2pix: (m) => m * 10, zoomScale: 1.0 });
	assert.equal(freshPad.strongbackAngle, PAD_EFFECT.STRUCTURE.STRONGBACK_MAX_ANGLE);
	assert.equal(freshPad.umbilicalAngle, PAD_EFFECT.STRUCTURE.UMBILICAL_MAX_ANGLE);

	// 5. Host rotation update after liftoff (with hostParam and without hostParam)
	const unknownHost = { id: 99, name: 'UnknownBody', x: 0, y: 0 };
	freshPad.update(0.016, { rocket: rocketWithOffsets, host: unknownHost, m2pix: (m) => m * 10, zoomScale: 1.0 });

	// 6. update() when rocket is null
	freshPad.update(0.016, { rocket: null, host, m2pix: (m) => m * 10, zoomScale: 1.0 });

	// 7. _getAbsPadPosition when !rocket.isHoldDown but host exists
	const postLiftoffCtx = { rocket: null, host, m2pix: (m) => m * 10, zoomScale: 1.0 };
	freshPad.drawBackground(ctx, mockRc, postLiftoffCtx);

	// 8. Custom rocket with _getDrawRadius
	const customRadiusRocket = {
		...rocketWithOffsets,
		_getDrawRadius: () => 30
	};
	freshPad.drawBackground(ctx, mockRc, { rocket: customRadiusRocket, host, m2pix: (m) => m * 10, zoomScale: 1.0 });

	// 9. ctx without arc (fallback to fillRect)
	const ctxWithoutArc = {
		save: () => {},
		restore: () => {},
		translate: () => {},
		rotate: () => {},
		fillRect: () => {},
		beginPath: () => {},
		fill: () => {},
		stroke: () => {},
		moveTo: () => {},
		lineTo: () => {},
		ellipse: () => {},
		arc: null
	};
	freshPad.drawBackground(ctxWithoutArc, mockRc, mockContext);

	// 10. getTowerLayout edge cases & fallbacks
	freshPad.getTowerLayout(null);
	freshPad.getTowerLayout({ rocket: { baseRadiusM: 4.0, bottomOffsetM: 12.0 } });
	const origNozzleMult = PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT;
	const origBaseXMult = PAD_EFFECT.STRUCTURE.BASE_X_OFFSET_MULT;
	const origUmbY = PAD_EFFECT.STRUCTURE.UMBILICAL_OFFSET_Y;
	delete PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT;
	delete PAD_EFFECT.STRUCTURE.BASE_X_OFFSET_MULT;
	delete PAD_EFFECT.STRUCTURE.UMBILICAL_OFFSET_Y;
	try {
		freshPad.getTowerLayout({});
		freshPad.drawBackground(ctx, mockRc, mockContext);
	} finally {
		PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT = origNozzleMult;
		PAD_EFFECT.STRUCTURE.BASE_X_OFFSET_MULT = origBaseXMult;
		PAD_EFFECT.STRUCTURE.UMBILICAL_OFFSET_Y = origUmbY;
	}

	// 11. UmbilicalCable draw & constraint distance threshold edge cases
	const cable = freshPad.umbilicalCable;
	cable.isInitialized = false;
	cable.draw(ctx, 10, PAD_EFFECT.STRUCTURE); // uninitialized early return
	cable._initNodes(PAD_EFFECT.STRUCTURE);
	cable.nodes = [cable.nodes[0]]; // length < 2 early return
	cable.draw(ctx, 10, PAD_EFFECT.STRUCTURE);
	cable._initNodes(PAD_EFFECT.STRUCTURE);
	cable.nodes[1].x = cable.nodes[0].x; // dist < 1e-6 in constraint solver
	cable.nodes[1].y = cable.nodes[0].y;
	cable.update(0.016, PAD_EFFECT.STRUCTURE, 0, false);

	// 12. Particles drawing with square, stretch, and arc shapes
	freshPad.particles = [
		{ type: 'ice', x: 0, y: 0, vx: 1, vy: 1, life: 0.8, maxLife: 1.0 }, // SHAPE: square, no size
		{ type: 'deluge', x: 5, y: 5, vx: 10, vy: 10, life: 0.6, maxLife: 2.0, size: 0.4 }, // SHAPE: stretch, with size
		{ type: 'spark', x: -2, y: -2, vx: 0, vy: 0, life: 0.5, maxLife: 0.8 }, // SHAPE: circle, GRAVITY_MULT: 0
		{ type: 'smoke_white', x: 1, y: 1, vx: 2, vy: 2, life: 0.9, maxLife: 2.0, size: 0.2 } // SHAPE: circle, GRAVITY_MULT: 0.1
	];
	freshPad.drawForeground(ctx, mockRc, mockContext);
	freshPad.drawBackground(ctx, mockRc, mockContext);
	freshPad.update(0.016, mockContext); // exercises grow_speed, gravity mult, etc.

	// 13. Strongback retract on either INTERNAL POWER or LIFTOFF (QUICK launch verification)
	const quickLaunchPad = new PadEffectRenderer();
	quickLaunchPad.start(301, 1);
	assert.equal(quickLaunchPad.strongbackAngle, 0);
	assert.equal(quickLaunchPad.flags.isInternalPower, false);
	// In QUICK launch: no INTERNAL POWER event is emitted, only LIFTOFF happens
	quickLaunchPad.handleEvent('LIFTOFF');
	assert.equal(quickLaunchPad.flags.isLiftoff, true);
	const holdDownRocket = createMockRocket({ id: 301, isHoldDown: false });
	quickLaunchPad.update(0.5, { rocket: holdDownRocket, host, m2pix: (m) => m * 10, zoomScale: 1.0 });
	assert.ok(quickLaunchPad.strongbackAngle > 0, 'Strongback must retract on LIFTOFF during QUICK launch');
	assert.ok(quickLaunchPad.umbilicalAngle > 0, 'Umbilical tower must retract on LIFTOFF during QUICK launch');
});

test('VisualEffectManager - Shockwaves, pad lifecycle, and fallback hooks', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0 });
	const rocket = createMockRocket({ id: 101, x: 0, y: -6371, telemetry: { altM: 500 } });
	const universe = createMockUniverse({ objects: [earth, rocket] });
	const vfx = new VisualEffectManager(universe);

	// Shockwave event
	EventBus.emit('effect:shockwave', 150, 250, '#ffaa00');
	assert.equal(vfx.shockwaves.length, 1);

	// Pad start / sequence / liftoff
	EventBus.emit('effect:pad-start', 101, 1);
	assert.equal(vfx.padEffect.isActive, true);

	EventBus.emit('sequencer-event', 'T-10m COUNTDOWN START');
	EventBus.emit('liftoff');

	vfx.update(0.016);

	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const rc = { name: 'main', basis: earth, zoomScale: 1.0 };

	// drawShockwaves fallback without basis
	vfx.drawShockwaves(ctx, { basis: null, zoomScale: 1.0 });

	// drawShockwaves with basis
	vfx.drawShockwaves(ctx, rc);

	// EventBus draw hooks (main and secondary)
	EventBus.emitDrawBefore(ctx, { name: 'secondary', zoomScale: 1.0 });
	EventBus.emitDrawAfter(ctx, { name: 'secondary', zoomScale: 1.0 });
	EventBus.emitDrawBefore(ctx, rc);
	EventBus.emitDrawAfter(ctx, rc);

	// Pad stop event
	EventBus.emit('effect:pad-stop');
	assert.equal(vfx.padEffect.isActive, false);

	// Rocket destruction test: pad starts, but rocket is removed from universe
	EventBus.emit('effect:pad-start', 999, 1);
	assert.equal(vfx.padEffect.isActive, true);
	vfx.update(0.016);
	assert.equal(vfx.padEffect.isActive, false, 'Pad effect should stop if rocket object does not exist');

	vfx.destroy();
	assert.equal(vfx.shockwaves.length, 0);
});

test('Trajectory - Ring buffer, shrink, interpolation, and drawing', () => {
	const trajectory = new Trajectory(1, { color: '#00ffcc', baseSize: 2 });
	assert.equal(trajectory.count, 0);

	// getInterpolatedPos on empty
	assert.equal(trajectory.getInterpolatedPos(10), null);

	// shrink on empty
	trajectory.shrink(10);
	assert.equal(trajectory.count, 0);

	// getPoint out of bounds
	assert.equal(trajectory.getPoint(-1), null);
	assert.equal(trajectory.getPoint(0), null);

	// Add points up to and beyond capacity
	const cap = trajectory.capacity;
	for (let i = 0; i < cap + 5; i++) {
		trajectory.addPoint(i * 10, i * 20, i, TRAIL_MODE.NORMAL);
	}
	assert.equal(trajectory.count, cap);

	// shrink with points
	trajectory.shrink(50);
	assert.ok(trajectory.count < cap);

	// clear
	trajectory.clear();
	assert.equal(trajectory.count, 0);

	// Add known points for binary search interpolation
	trajectory.addPoint(100, 200, 10, TRAIL_MODE.NORMAL);
	trajectory.addPoint(200, 400, 20, TRAIL_MODE.NORMAL);
	trajectory.addPoint(300, 600, 30, TRAIL_MODE.NORMAL);
	trajectory.addPoint(400, 800, 40, TRAIL_MODE.NORMAL);

	// Interpolation edge cases:
	// 1. targetFrame <= oldest
	const posOld = trajectory.getInterpolatedPos(5);
	assert.equal(posOld.x, 100);
	assert.equal(posOld.y, 200);

	// 2. targetFrame >= newest
	const posNew = trajectory.getInterpolatedPos(50);
	assert.equal(posNew.x, 400);
	assert.equal(posNew.y, 800);

	// 3. exact hit
	const posMid = trajectory.getInterpolatedPos(20);
	assert.equal(posMid.x, 200);
	assert.equal(posMid.y, 400);

	// 4. interpolated between points
	const posInterp = trajectory.getInterpolatedPos(25);
	assert.equal(posInterp.x, 250);
	assert.equal(posInterp.y, 500);

	// Draw with < 2 points
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const singlePtTraj = new Trajectory(2);
	singlePtTraj.addPoint(0, 0, 1);
	singlePtTraj.draw({ ctx, name: 'main', zoomScale: 1.0 });

	// Draw with >= 2 points
	trajectory.draw({ ctx, name: 'main', zoomScale: 1.0, trailLengthAU: 1.0 });
});

test('EffectTrail - Ring buffer, shrink, and bounds check', () => {
	const effectTrail = new EffectTrail(1, { color: '#ffaa00', baseSize: 3 });
	assert.equal(effectTrail.count, 0);

	// shrink on empty
	effectTrail.shrink(10);
	assert.equal(effectTrail.count, 0);

	// getPoint bounds
	assert.equal(effectTrail.getPoint(-1), null);
	assert.equal(effectTrail.getPoint(0), null);

	// Ring buffer wrap
	const cap = effectTrail.capacity;
	for (let i = 0; i < cap + 10; i++) {
		effectTrail.addPoint(1, i * 2, i * 3, i, TRAIL_MODE.ATMOSPHERE);
	}
	assert.equal(effectTrail.count, cap);

	// shrink with points
	effectTrail.shrink(30);
	assert.ok(effectTrail.count < cap);

	// clear
	effectTrail.clear();
	assert.equal(effectTrail.count, 0);

	// Draw with < 2 points
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	effectTrail.draw({ ctx, name: 'main', zoomScale: 1.0 });

	// Draw with >= 2 points
	effectTrail.addPoint(1, 0, 0, 1, TRAIL_MODE.ATMOSPHERE);
	effectTrail.addPoint(1, 10, 20, 2, TRAIL_MODE.ATMOSPHERE);
	effectTrail.draw({ ctx, name: 'main', zoomScale: 1.0, objectsMap: new Map() });
});

test('TrailLineRenderer - Atmosphere gap, screen culling, distance limits, and interpolated basis', () => {
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');

	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0 });
	earth.trajectory = new Trajectory(1);
	earth.trajectory.addPoint(0, 0, 1);
	earth.trajectory.addPoint(0, 0, 100);

	const trajectory = new Trajectory(2, { color: '#ffffff', baseSize: 2 });

	// pointsToDraw < 2 early return
	TrailLineRenderer.draw(trajectory, { ctx, trailLengthAU: 1.0 });

	// trailLengthAU <= 0
	TrailLineRenderer.draw(trajectory, { ctx, trailLengthAU: 0 });

	// Add points: normal, atmosphere, out of screen, sharp turn
	trajectory.addPoint(0, 0, 10, TRAIL_MODE.NORMAL);
	trajectory.addPoint(100, 100, 20, TRAIL_MODE.ATMOSPHERE); // atmosphere break
	trajectory.addPoint(200, 200, 30, TRAIL_MODE.NORMAL);
	trajectory.addPoint(100000, 100000, 40, TRAIL_MODE.NORMAL); // out of screen
	trajectory.addPoint(250, 250, 50, TRAIL_MODE.NORMAL);
	trajectory.addPoint(260, 200, 60, TRAIL_MODE.NORMAL); // sharp turn
	trajectory.addPoint(270, 300, 70, TRAIL_MODE.NORMAL);

	const rc = {
		name: 'main',
		ctx: ctx,
		basis: earth,
		zoomScale: 1.0,
		trailLengthAU: 0.0000001, // extremely short target length to trigger distance break
		cameraOffset: { x: 0, y: 0 }
	};

	TrailLineRenderer.draw(trajectory, rc);
});

test('EffectRenderer & SparkEffectRenderer & SmokeEffectRenderer - Complete visual trail rendering', () => {
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');

	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, rotationAngle: 0.5 });
	const objectsMap = new Map();
	objectsMap.set(1, earth);

	const effectTrail = new EffectTrail(101, { color: '#ff6600', baseSize: 3 });

	// Empty trail early return
	EffectRenderer.draw(effectTrail, { ctx, basis: earth, objectsMap });

	// Add Escape spark points (in-screen and out-of-screen)
	for (let i = 0; i < 10; i++) {
		effectTrail.addPoint(1, i * 10, -i * 10, i, TRAIL_MODE.ESCAPE);
	}
	effectTrail.addPoint(1, 999999, 999999, 11, TRAIL_MODE.ESCAPE); // out-of-screen culled

	// Add Atmosphere smoke points (near nozzle, far, and out-of-screen)
	for (let i = 12; i < 30; i++) {
		effectTrail.addPoint(1, (i - 12) * 5, -(i - 12) * 5, i, TRAIL_MODE.ATMOSPHERE);
	}
	effectTrail.addPoint(1, 999999, 999999, 31, TRAIL_MODE.ATMOSPHERE); // out-of-screen culled

	const rc = {
		name: 'main',
		ctx: ctx,
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		objectsMap: objectsMap,
		bodyScreenRadius: 5.0
	};

	EffectRenderer.draw(effectTrail, rc);
});

test('RocketRenderer - Low detail and High detail rendering across flight phases and plume types', () => {
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');

	// 1. Low detail - Standard rocket firing stage 1
	const lowRocketStg1 = {
		thrustAngle: 0.5,
		isInternalPower: true,
		colorTheme: 'orange',
		currentStageIndex: 0,
		totalStages: 2,
		stages: [{ fuelType: 'liquid' }, { fuelType: 'liquid' }],
		isIgnited: true,
		burnTime: 10,
		thrustRatio: 1.0,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, lowRocketStg1, 100, 100, 10, 1.0);

	// 2. Low detail - Stage 2
	const lowRocketStg2 = {
		...lowRocketStg1,
		currentStageIndex: 1,
		telemetry: { stageIndex: 1 }
	};
	RocketRenderer.draw(ctx, lowRocketStg2, 100, 100, 12, 1.0);

	// 3. Low detail - Payload only
	const lowPayload = {
		...lowRocketStg1,
		isPayloadSeparated: true
	};
	RocketRenderer.draw(ctx, lowPayload, 100, 100, 8, 1.0);

	// 4. High detail - Complete vehicle with fairing and Stage 1 active (liquid plume)
	const highRocketF9 = {
		thrustAngle: 0.0,
		isInternalPower: false,
		colorTheme: 'white',
		currentStageIndex: 0,
		totalStages: 2,
		stages: [{ fuelType: 'liquid' }, { fuelType: 'liquid' }],
		fairing: { enabled: true, isSeparated: false },
		isIgnited: true,
		burnTime: 50,
		thrustRatio: 0.9,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, highRocketF9, 200, 200, 50, 1.0);

	// 5. High detail - Fairing separated, Stage 2 active (hydro plume)
	const highRocketHydro = {
		thrustAngle: 1.2,
		colorTheme: 'orange',
		currentStageIndex: 1,
		totalStages: 2,
		stages: [{ fuelType: 'liquid' }, { fuelType: 'hydro' }],
		fairing: { enabled: true, isSeparated: true },
		telemetry: { isFairingSeparated: true, stageIndex: 1 },
		isIgnited: true,
		burnTime: 40,
		thrustRatio: 1.0,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, highRocketHydro, 200, 200, 45, 1.0);

	// 6. High detail - Solid booster plume
	const highRocketSolid = {
		thrustAngle: 0.8,
		colorTheme: 'dark',
		currentStageIndex: 0,
		totalStages: 1,
		stages: [{ fuelType: 'solid' }],
		isIgnited: true,
		burnTime: 20,
		thrustRatio: 0.8,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, highRocketSolid, 200, 200, 60, 1.0);

	// 7. High detail - Ion plume
	const highRocketIon = {
		thrustAngle: -0.5,
		colorTheme: 'blue',
		currentStageIndex: 0,
		totalStages: 1,
		stages: [{ fuelType: 'ion' }],
		isIgnited: true,
		burnTime: 100,
		thrustRatio: 0.5,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, highRocketIon, 200, 200, 50, 1.0);

	// 8. High detail - Payload satellite only
	const highPayload = {
		thrustAngle: 0.0,
		isPayloadSeparated: true,
		currentStageIndex: 2,
		totalStages: 2,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, highPayload, 200, 200, 40, 1.0);

	// 9. Slingshot rocket: disableStaging preserves fairing and complete stack
	const slingshotRocket = {
		thrustAngle: 0.3,
		disableStaging: true,
		isPayloadSeparated: true, // ignored due to disableStaging
		currentStageIndex: 2,
		totalStages: 2,
		stages: [{ fuelType: 'liquid' }, { fuelType: 'liquid' }],
		fairing: { enabled: false } // ignored due to disableStaging
	};
	RocketRenderer.draw(ctx, slingshotRocket, 200, 200, 50, 1.0);
	RocketRenderer.draw(ctx, slingshotRocket, 200, 200, 10, 1.0);

	// 10. Single-stage (SSTO) - Fairing attached and firing
	const sstoRocketWithFairing = {
		thrustAngle: 0.2,
		colorTheme: 'blue',
		currentStageIndex: 0,
		totalStages: 1,
		stages: [{ fuelType: 'liquid' }],
		fairing: { enabled: true, isSeparated: false },
		isIgnited: true,
		burnTime: 80,
		thrustRatio: 1.0,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, sstoRocketWithFairing, 200, 200, 45, 1.0);

	// 11. Single-stage (SSTO) - Fairing separated (payload exposed)
	const sstoRocketExposed = {
		...sstoRocketWithFairing,
		fairing: { enabled: true, isSeparated: true },
		telemetry: { isFairingSeparated: true }
	};
	RocketRenderer.draw(ctx, sstoRocketExposed, 200, 200, 45, 1.0);

	// 12. 3-stage rocket (Epsilon) - Stage 1 active (solid plume)
	const epsilonStg1 = {
		thrustAngle: 0.1,
		colorTheme: 'classic',
		currentStageIndex: 0,
		totalStages: 3,
		stages: [{ fuelType: 'solid' }, { fuelType: 'solid' }, { fuelType: 'solid' }],
		fairing: { enabled: true, isSeparated: false },
		isIgnited: true,
		burnTime: 100,
		thrustRatio: 1.0,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, epsilonStg1, 200, 200, 50, 1.0);

	// 13. 3-stage rocket (Epsilon) - Stage 2 active with fairing separated
	const epsilonStg2 = {
		...epsilonStg1,
		currentStageIndex: 1,
		telemetry: { stageIndex: 1, isFairingSeparated: true },
		fairing: { enabled: true, isSeparated: true }
	};
	RocketRenderer.draw(ctx, epsilonStg2, 200, 200, 50, 1.0);

	// 14. 3-stage rocket (Epsilon) - Stage 3 active
	const epsilonStg3 = {
		...epsilonStg1,
		currentStageIndex: 2,
		telemetry: { stageIndex: 2, isFairingSeparated: true },
		fairing: { enabled: true, isSeparated: true }
	};
	RocketRenderer.draw(ctx, epsilonStg3, 200, 200, 50, 1.0);

	// 15. Epsilon color theme validation
	const epsilonThemeRocket = {
		...epsilonStg1,
		colorTheme: 'epsilon'
	};
	RocketRenderer.draw(ctx, epsilonThemeRocket, 200, 200, 40, 1.0);

	// 16. Payload Satellite: Stowed paddles (isDeployed=false) vs Deployed paddles (isDeployed=true)
	RocketRenderer._drawPayloadSatellite(ctx, 0, 0, 20, false);
	RocketRenderer._drawPayloadSatellite(ctx, 0, 0, 20, true);

	// 17. Boosters: H3-22 (2 SRBs) and H3-24L (4 SRBs) high & low detail, firing & non-firing
	const h3_22Rocket = {
		thrustAngle: 0.0,
		colorTheme: 'orange',
		currentStageIndex: 0,
		totalStages: 2,
		stages: [{ fuelType: 'hydro' }, { fuelType: 'hydro' }],
		boosters: {
			count: 2,
			name: 'SRB-3',
			radiusRatio: 0.26,
			lengthRatio: 1.70,
			offsetYRatio: 0.95,
			plumeFuel: 'solid',
			plumeScale: 0.55
		},
		isIgnited: true,
		burnTime: 100,
		thrustRatio: 1.0,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, h3_22Rocket, 200, 200, 50, 1.0); // high detail firing
	RocketRenderer.draw(ctx, h3_22Rocket, 200, 200, 10, 1.0); // low detail firing
	h3_22Rocket.isIgnited = false;
	h3_22Rocket.thrustRatio = 0;
	RocketRenderer.draw(ctx, h3_22Rocket, 200, 200, 50, 1.0); // high detail non-firing
	RocketRenderer.draw(ctx, h3_22Rocket, 200, 200, 10, 1.0); // low detail non-firing

	const h3_24Rocket = {
		thrustAngle: 0.5,
		colorTheme: 'orange',
		currentStageIndex: 0,
		totalStages: 2,
		stages: [{ fuelType: 'hydro' }, { fuelType: 'hydro' }],
		boosters: {
			count: 4,
			name: 'SRB-3',
			radiusRatio: 0.26,
			lengthRatio: 1.70,
			offsetYRatio: 0.95,
			pairSpacingRatio: 0.35,
			plumeFuel: 'solid',
			plumeScale: 0.55
		},
		isIgnited: true,
		burnTime: 100,
		thrustRatio: 0.9,
		disableStaging: false
	};
	RocketRenderer.draw(ctx, h3_24Rocket, 200, 200, 60, 1.0); // high detail firing with 4 boosters
	RocketRenderer.draw(ctx, h3_24Rocket, 200, 200, 12, 1.0); // low detail firing with 4 boosters
	h3_24Rocket.isIgnited = false;
	RocketRenderer.draw(ctx, h3_24Rocket, 200, 200, 60, 1.0); // high detail non-firing with 4 boosters

	// Direct _drawBoosters test for edge cases (N boosters > 4, empty boosters, null boosters)
	RocketRenderer._drawBoosters(ctx, {}, 0, 10, 50, -5, 5, ROCKET_VISUAL.THEMES.orange, false, 0, 20);
	RocketRenderer._drawBoosters(ctx, { boosters: { count: 0 } }, 0, 10, 50, -5, 5, ROCKET_VISUAL.THEMES.orange, false, 0, 20);
	RocketRenderer._drawBoosters(ctx, { boosters: { count: 6 } }, 0, 10, 50, -5, 5, ROCKET_VISUAL.THEMES.orange, true, 1.0, 20);

	// 18. Rocket._getDrawRadius across 1-stage, 2-stage, and 3-stage configs
	const rkt1 = new Rocket(501, 'SSTO', 0, 0, 0, 0, 10, 50, 100, '#fff', 5, 25, 0, null, 0);
	rkt1.stages = [{ stageNumber: 1 }];
	rkt1.bottomOffsetM = 25.0;
	assert.ok(rkt1._getDrawRadius(1.0) > 0);

	const rkt3 = new Rocket(502, 'Epsilon', 0, 0, 0, 0, 10, 50, 100, '#fff', 5, 13, 0, null, 0);
	rkt3.stages = [{ stageNumber: 1 }, { stageNumber: 2 }, { stageNumber: 3 }];
	rkt3.bottomOffsetM = 13.0;
	assert.ok(rkt3._getDrawRadius(1.0) > 0);
});

test('Debris - Stage debris LOD rendering, theme colors, and minimum drawing radius', () => {
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');

	// Create Stage 1 Booster Debris with epsilon theme
	const debBooster = new Debris(
		1001, 'Stage 1 Booster', 100, 100, 0, 0,
		8.7, '#ffffff', 1.8, 1.3, 1, '#00ffcc', 0,
		1, 'epsilon'
	);
	assert.ok(debBooster._getDrawRadius(0.0001) <= 2.0, 'Booster min radius must be <= 2.0');

	// Create Stage 2 Upper Stage Debris with classic theme
	const debUpper = new Debris(
		1002, 'Stage 2 Upper Stage', 200, 200, 0, 0,
		4.5, '#e2e6ea', 1.4, 1.0, 1, '#00ffcc', 0,
		2, 'classic'
	);
	assert.ok(debUpper._getDrawRadius(0.0001) <= 1.5, 'Upper stage min radius must be <= 1.5');

	// Create Fairing Debris with orange theme
	const debFairing = new Debris(
		1003, 'Fairing Half', 300, 300, 0, 0,
		1.0, '#ffffff', 1.0, 0.8, 1, '#00ffcc', 0,
		3, 'orange'
	);
	assert.ok(debFairing._getDrawRadius(0.0001) <= 1.2, 'Fairing min radius must be <= 1.2');

	// 1. Zoomed out LOD rendering (screenRadius < LOD_RADIUS_THRESHOLD)
	debBooster._drawBody(ctx, 100, 100, 1.8);
	debUpper._drawBody(ctx, 200, 200, 1.4);
	debFairing._drawBody(ctx, 300, 300, 1.0);

	// 2. Zoomed in High Detail hardware rendering (screenRadius >= LOD_RADIUS_THRESHOLD)
	debBooster._drawBody(ctx, 100, 100, 15.0);
	debUpper._drawBody(ctx, 200, 200, 12.0);
	debFairing._drawBody(ctx, 300, 300, 10.0);
});

test('PadEffectRenderer, RocketRenderer, and TrajectoryPredictor deep branch coverage', () => {
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, mass: 5.972e21, x: 0, y: 0 });
	const universe = createMockUniverse({ objects: [earth] });

	// 1. PadEffectRenderer particles & drawing shapes (square, stretch, circle)
	const pad = new PadEffectRenderer();
	pad.isActive = true;
	pad.targetRocketId = 101;
	pad.hostId = earth.id;
	pad.rocketRadius = 3.7;

	// Populate particles of various shapes
	pad.particles = [
		{ type: 'spark', x: 0, y: 0, vx: 50, vy: 50, life: 0.8, size: 0.2 }, // shape: stretch
		{ type: 'ice', x: 10, y: 10, vx: 0, vy: -5, life: 0.5, size: 0.3 }, // shape: square
		{ type: 'deluge', x: -10, y: 0, vx: 10, vy: 0, life: 0.9, size: 0.4 }, // shape: circle
		{ type: 'smoke_white', x: 0, y: 20, vx: 5, vy: 5, life: 0.7, size: 0.5 },
		{ type: 'chill', x: 0, y: -20, vx: 0, vy: -2, life: 0.6, size: 0.2 }
	];

	const renderContext = {
		basis: earth,
		zoomScale: 1.0,
		canvas: mockCanvas
	};
	const context = {
		rocket: { baseRadiusM: 3.7, bottomOffsetM: 10, _getDrawRadius: () => 20 },
		m2pix: (m) => m * 0.1,
		zoomScale: 1.0
	};

	pad.drawBackground(ctx, renderContext, context);
	pad.drawForeground(ctx, renderContext, context);

	// Test drawBackground without ctx.arc to cover fillRect fallback (lines 634-636, 673-675)
	const origArc = ctx.arc;
	delete ctx.arc;
	pad.drawBackground(ctx, renderContext, context);
	ctx.arc = origArc;

	// Update flags & particles spawn
	pad.flags.isVenting = true;
	pad.flags.isPressurized = true;
	pad.flags.isChilldown = true;
	pad.flags.isWaterDeluge = true;
	pad.flags.isROFI = true;
	pad.lastContext = context;
	pad.update(0.016, context);
	pad.handleLiftoff();
	pad.stop();
	assert.equal(pad.isActive, false);

	// 2. RocketRenderer: low detail payload-only & firing, high detail payload-only & 3-stage no-fairing
	const theme = ROCKET_VISUAL.THEMES.classic;

	// Low detail payload only (lines 39-50)
	const lowPayloadRocket = {
		isPayloadSeparated: true,
		disableStaging: false,
		stages: [{ stageNumber: 1 }],
		currentStageIndex: 1,
		totalStages: 1
	};
	RocketRenderer._drawLowDetail(ctx, lowPayloadRocket, 10, theme);

	// Low detail firing (lines 62-70)
	const lowFiringRocket = {
		isPayloadSeparated: false,
		isIgnited: true,
		burnTime: 10,
		thrustRatio: 1.0,
		stages: [{ stageNumber: 1 }],
		currentStageIndex: 0,
		totalStages: 1
	};
	RocketRenderer._drawLowDetail(ctx, lowFiringRocket, 10, theme);

	// High detail payload only (lines 98-100)
	const highPayloadRocket = {
		isPayloadSeparated: true,
		disableStaging: false,
		stages: [{ stageNumber: 1 }],
		currentStageIndex: 1,
		totalStages: 1
	};
	RocketRenderer._drawHighDetail(ctx, highPayloadRocket, 30, 1.0, theme);

	// 3-stage rocket with fairing separated on stage 1, stage 2, stage 3 (lines 150-151, 173-174, 191-193)
	const rkt3StageNoFairing = {
		currentStageIndex: 0,
		totalStages: 3,
		stages: [{ stageNumber: 1 }, { stageNumber: 2 }, { stageNumber: 3 }],
		isFairingSeparated: true,
		isPayloadSeparated: false,
		disableStaging: false,
		isIgnited: true,
		burnTime: 10,
		thrustRatio: 1.0
	};
	RocketRenderer._drawHighDetail(ctx, rkt3StageNoFairing, 30, 1.0, theme); // Stage 1, no fairing

	rkt3StageNoFairing.currentStageIndex = 1;
	RocketRenderer._drawHighDetail(ctx, rkt3StageNoFairing, 30, 1.0, theme); // Stage 2, no fairing

	rkt3StageNoFairing.currentStageIndex = 2;
	RocketRenderer._drawHighDetail(ctx, rkt3StageNoFairing, 30, 1.0, theme); // Stage 3, no fairing

	// 3. TrajectoryPredictor: orbit and impact events, render & culling
	const predRocket = createMockRocket({
		id: 201,
		x: UnitConvertUtils.m2pix(6371000 + 250000),
		y: 0,
		vx: 0,
		vy: UnitConvertUtils.m2pix(7800),
		hostId: earth.id,
		telemetry: {
			altM: 250000, // > ORBIT_MIN_ALT_M
			flightTime: 500,
			status: 5
		}
	});
	predRocket.predictedTrajectory = {
		events: [
			{ id: 'orb_1', type: 'orbit', name: 'Orbit Injection' },
			{ id: 'imp_1', type: 'impact', name: 'Ground Impact' }
		]
	};
	predRocket.passedEventIds = new Set();

	universe.objects = [earth, predRocket];
	const renderCtx = { basis: earth, objectsMap: new Map([[earth.id, earth]]) };
	TrajectoryPredictor.updateRocketFlightEvents(predRocket, renderCtx);
	assert.ok(predRocket.passedEventIds.has('orb_1'), 'Orbit event should pass at high speed & altitude');

	// Impact event
	predRocket.state = OBJECT_STATE.REMOVED;
	predRocket.telemetry.altM = 0;
	TrajectoryPredictor.updateRocketFlightEvents(predRocket, renderCtx);
	assert.ok(predRocket.passedEventIds.has('imp_1'), 'Impact event should pass when removed or alt <= 0');

	// Test handleEvent branches
	pad.handleEvent('COUNTDOWN START');
	pad.handleEvent('CHILLDOWN');
	pad.handleEvent('PRESSURIZATION');
	pad.handleEvent('INTERNAL POWER');
	pad.handleEvent('WATER DELUGE');
	pad.handleEvent('ROFI');
	pad.handleEvent('MAIN ENGINE START');

	// Umbilical retraction past max angle & particle life expiration
	const liftoffRocket = { isHoldDown: false };
	context.rocket = liftoffRocket;
	pad.umbilicalAngle = 100; // > UMBILICAL_MAX_ANGLE
	pad.particles.push({ type: 'smoke_white', x: 0, y: 0, vx: 0, vy: 0, life: -0.1, maxLife: 1.0, size: 0.1 });
	pad.update(1.0, context);

	// Early return when inactive
	pad.isActive = false;
	pad.drawBackground(ctx, renderContext, context);
	pad.drawForeground(ctx, renderContext, context);

	// 2. RocketRenderer: 3-stage rocket WITH fairing intact on stage 2 and stage 3 (lines 171, 190)
	const rkt3StageWithFairing = {
		currentStageIndex: 1,
		totalStages: 3,
		stages: [{ stageNumber: 1 }, { stageNumber: 2 }, { stageNumber: 3 }],
		fairing: { enabled: true, isSeparated: false },
		isPayloadSeparated: false,
		disableStaging: false,
		isIgnited: true,
		burnTime: 10,
		thrustRatio: 1.0
	};
	RocketRenderer._drawHighDetail(ctx, rkt3StageWithFairing, 30, 1.0, theme); // hits line 171!

	rkt3StageWithFairing.currentStageIndex = 2;
	RocketRenderer._drawHighDetail(ctx, rkt3StageWithFairing, 30, 1.0, theme); // hits line 190!

	// 3. TrajectoryPredictor: orbit, impact, worker catch, hostNotInBodies, and inSubpath = false
	// Worker catch block (lines 87-89)
	const origWorker = globalThis.Worker;
	globalThis.Worker = class FailingWorker {
		constructor() { throw new Error('Worker creation disabled in test'); }
	};
	const failingWorkerPredictor = new TrajectoryPredictor(universe);
	assert.equal(failingWorkerPredictor._worker, null);
	globalThis.Worker = origWorker;

	// _buildSimulationParams when host not in universe.objects (lines 199-210)
	const isolatedUniverse = createMockUniverse({ objects: [] });
	const isolatedPredictor = new TrajectoryPredictor(isolatedUniverse);
	const simParams = isolatedPredictor._buildSimulationParams({ host: earth });
	assert.ok(simParams.celestialBodies.some(b => b.id === earth.id));

	// TrajectoryPredictor.render with alternating onscreen-offscreen points to trigger inSubpath = false (lines 625-626)
	const cullingPredictor = new TrajectoryPredictor(universe);
	cullingPredictor.prediction = {
		hostId: earth.id,
		points: [
			{ relX: 0, relY: 0, altM: 100 },              // onscreen (inSubpath = true)
			{ relX: 10, relY: 10, altM: 100 },           // onscreen
			{ relX: 500000, relY: 500000, altM: 100 },   // offscreen (inSubpath = false, line 625-626!)
			{ relX: 500010, relY: 500010, altM: 100 },   // offscreen
			{ relX: 20, relY: 20, altM: 100 },           // onscreen again
			{ relX: 30, relY: 30, altM: 100 }            // onscreen again
		],
		events: []
	};
	cullingPredictor.render(ctx, {
		basis: earth,
		zoomScale: 1.0,
		canvas: { width: 400, height: 400 },
		showPredictedTrajectory: true,
		showActualFlightPath: false
	});
});

test('RocketRenderer - Exhaust plumes, multistage variations, and low/high detail branch coverage', () => {
	const ctx = createMockElement('canvas').getContext('2d');
	const theme = ROCKET_VISUAL.THEMES.classic;

	// 1. _drawPlume with all fuel types and default/unknown fallback
	RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, 'hydro', 50);
	RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, 'solid', 50);
	RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, 'ion', 50);
	RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, 'liquid', 50);
	RocketRenderer._drawPlume(ctx, 0, 0, 1.0, 1.0, 'metha_unknown', 50);

	// 2. _drawLowDetail variations: twr fallback, stage 1 vs 2, payload
	RocketRenderer._drawLowDetail(ctx, {
		disableStaging: false,
		isPayloadSeparated: false,
		currentStageIndex: 0,
		isIgnited: true,
		burnTime: 10,
		thrustRatio: 0,
		telemetry: { twr: 1.5 }
	}, 10, theme);

	RocketRenderer._drawLowDetail(ctx, {
		disableStaging: false,
		isPayloadSeparated: false,
		currentStageIndex: 1,
		isIgnited: false,
		burnTime: 0
	}, 10, theme);

	// 3. _drawHighDetail: 3-stage with fairing on Stage 1
	RocketRenderer._drawHighDetail(ctx, {
		currentStageIndex: 0,
		totalStages: 3,
		stages: [{ fuelType: 'liquid' }, { fuelType: 'hydro' }, { fuelType: 'solid' }],
		fairing: { enabled: true, isSeparated: false },
		isPayloadSeparated: false,
		disableStaging: false,
		isIgnited: true,
		burnTime: 50,
		thrustRatio: 1.0
	}, 35, 1.0, theme);

	// 4. _drawHighDetail: 2-stage without fairing (Stage 1 firing, Stage 2 firing, not firing)
	const stg2Rocket = {
		currentStageIndex: 0,
		totalStages: 2,
		stages: [{ fuelType: 'liquid' }, { fuelType: 'liquid' }],
		fairing: { enabled: false },
		isPayloadSeparated: false,
		disableStaging: false,
		isIgnited: true,
		burnTime: 40,
		thrustRatio: 1.0
	};
	RocketRenderer._drawHighDetail(ctx, stg2Rocket, 35, 1.0, theme); // Stage 1 firing
	stg2Rocket.currentStageIndex = 1;
	RocketRenderer._drawHighDetail(ctx, stg2Rocket, 35, 1.0, theme); // Stage 2 firing
	stg2Rocket.isIgnited = false;
	RocketRenderer._drawHighDetail(ctx, stg2Rocket, 35, 1.0, theme); // Not firing

	// 5. _drawHighDetail: Single Stage (SSTO) with and without fairing, firing & not firing
	const sstoRocket = {
		currentStageIndex: 0,
		totalStages: 1,
		stages: [{ fuelType: 'liquid' }],
		fairing: { enabled: false },
		isPayloadSeparated: false,
		disableStaging: false,
		isIgnited: false,
		burnTime: 0
	};
	RocketRenderer._drawHighDetail(ctx, sstoRocket, 35, 1.0, theme);
	sstoRocket.isIgnited = true;
	sstoRocket.burnTime = 20;
	sstoRocket.thrustRatio = 0.9;
	RocketRenderer._drawHighDetail(ctx, sstoRocket, 35, 1.0, theme);

	// 6. _drawHighDetail: Payload satellite only for 2-stage and 3-stage
	RocketRenderer._drawHighDetail(ctx, {
		disableStaging: false,
		isPayloadSeparated: true,
		totalStages: 2,
		stages: [{ fuelType: 'liquid' }, { fuelType: 'liquid' }]
	}, 35, 1.0, theme);

	RocketRenderer._drawHighDetail(ctx, {
		disableStaging: false,
		isPayloadSeparated: true,
		totalStages: 3,
		stages: [{ fuelType: 'solid' }, { fuelType: 'solid' }, { fuelType: 'solid' }]
	}, 35, 1.0, theme);
});

test('TrajectoryPredictor - Worker events, flight event detection, and rendering edge cases', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, mass: 5.972e24 });
	const universe = createMockUniverse({ objects: [earth] });
	const predictor = new TrajectoryPredictor(universe);

	// 1. Worker message handling (simulate worker response)
	let callbackInvoked = false;
	const dummyReqId = predictor.requestPrediction({ host: earth }, (res) => {
		callbackInvoked = true;
	});
	assert.ok(dummyReqId > 0);

	if (predictor._worker && predictor._worker.onmessage) {
		// Normal predictionResult
		predictor._worker.onmessage({
			data: {
				cmd: 'predictionResult',
				requestId: dummyReqId,
				hostId: earth.id,
				points: [{ relX: 0, relY: 0, time: 0 }, { relX: 100, relY: 100, time: 10 }],
				events: [{ id: 'liftoff', type: 'liftoff', relX: 0, relY: 0, passed: false }],
				isOrbital: false,
				maxSimTime: 1000,
				maxAltM: 50000,
				maxQ: 35
			}
		});
		assert.ok(callbackInvoked);

		// Worker error handler
		if (predictor._worker.onerror) {
			predictor._worker.onerror(new Error('Simulated worker test error'));
		}
	}

	// 2. Coalescing request while busy
	predictor._isBusy = true;
	const busyReqId = predictor.requestPrediction({ host: earth });
	assert.equal(predictor._nextPendingRequest !== null, true);
	predictor._isBusy = false;

	// 3. calculate() with cached prediction
	const cachedResult = predictor.calculate({ host: earth });
	assert.ok(cachedResult);

	// 4. calculateSync() without valid host
	const invalidSync = predictor.calculateSync({ host: null });
	assert.equal(invalidSync, null);

	// 5. updateRocketFlightEvents: test all unpassed branches
	const mockRocket = createMockRocket({
		id: 99,
		hostId: earth.id,
		isHoldDown: true,
		flightTime: 0.5,
		telemetry: {
			status: 1,
			altM: 10,
			vV: 5,
			flightTime: 0.5,
			stageIndex: 0,
			totalStages: 2
		},
		predictedTrajectory: {
			events: [
				{ id: 'liftoff', type: 'liftoff', passed: false },
				{ id: 'pitch', type: 'pitch', altM: 5000, time: 10, passed: false },
				{ id: 'maxq', type: 'maxq', altM: 15000, passed: false },
				{ id: 'seco_1', type: 'meco', time: 500, passed: false },
				{ id: 'meco_1', type: 'meco', time: 150, passed: false },
				{ id: 'stg_sep_1', type: 'staging', time: 155, passed: false },
				{ id: 'payload_sep', type: 'staging', time: 600, passed: false },
				{ id: 'custom_staging', type: 'staging', time: 200, passed: false },
				{ id: 'stg_meco_custom', type: 'stg_meco', time: 140, passed: false },
				{ id: 'custom_ign', type: 'ignition', time: 160, passed: false },
				{ id: 'custom_fairing', type: 'fairing', time: 180, passed: false },
				{ id: 'target_alt', type: 'alt', altM: 100000, passed: false },
				{ id: 'no_val_alt', type: 'alt', passed: false },
				{ id: 'target_time', type: 'time', time: 300, passed: false },
				{ id: 'no_val_time', type: 'time', passed: false },
				{ id: 'apoapsis', type: 'apoapsis', passed: false },
				{ id: 'orbit_evt', type: 'orbit', time: 800, passed: false },
				{ id: 'impact_evt', type: 'impact', passed: false }
			]
		}
	});
	mockRocket.totalStages = 2;
	mockRocket.currentStageIndex = 0;
	mockRocket.fuelMass = 50;
	mockRocket.burnTime = 100;
	mockRocket.isIgnited = false;
	mockRocket.state = OBJECT_STATE.ACTIVE;
	mockRocket.passedEventIds = new Set();

	TrajectoryPredictor.updateRocketFlightEvents(mockRocket, {
		objectsMap: new Map([[earth.id, earth]]),
		basis: earth
	});

	// Check that events remain unpassed under these initial conditions
	const liftoffEv = mockRocket.predictedTrajectory.events.find(e => e.id === 'liftoff');
	assert.equal(liftoffEv.passed, false);

	// Single stage rocket MECO unpassed branch
	const sstoRocket = {
		telemetry: { status: 1, altM: 2000, flightTime: 10 },
		totalStages: 1,
		currentStageIndex: 0,
		fuelMass: 10,
		burnTime: 50,
		passedEventIds: new Set(),
		predictedTrajectory: {
			events: [{ id: 'meco_ssto', type: 'meco', time: 100, passed: false }]
		}
	};
	TrajectoryPredictor.updateRocketFlightEvents(sstoRocket, null);
	assert.equal(sstoRocket.predictedTrajectory.events[0].passed, false);

	// 6. renderTrajectory edge cases: null prediction, points < 2, host not found, flight time >= maxTime
	const ctx = createMockElement('canvas').getContext('2d');
	const renderCtx = {
		basis: earth,
		zoomScale: 1.0,
		objectsMap: new Map([[earth.id, earth]]),
		cameraOffset: { x: 0, y: 0 }
	};
	TrajectoryPredictor.renderTrajectory(ctx, renderCtx, null);
	TrajectoryPredictor.renderTrajectory(ctx, renderCtx, { points: [{ relX: 0, relY: 0 }] });
	TrajectoryPredictor.renderTrajectory(ctx, { basis: earth, zoomScale: 1.0 }, { hostId: 9999, points: [{ relX: 0, relY: 0 }, { relX: 10, relY: 10 }] });

	// Flight mode expiration
	TrajectoryPredictor.renderTrajectory(ctx, renderCtx, {
		hostId: earth.id,
		maxSimTime: 100,
		points: [{ relX: 0, relY: 0, time: 0 }, { relX: 100, relY: 100, time: 100 }],
		events: []
	}, { mode: 'flight', currentFlightTime: 150 });

	// Actual flight path with rocket screen position and rotation
	TrajectoryPredictor.renderTrajectory(ctx, renderCtx, {
		hostId: earth.id,
		points: [
			{ r: 6500000, phiSurf: 0, time: 0 },
			{ r: 6600000, phiSurf: 0.1, time: 10 }
		],
		events: [
			{ id: 'imp', type: 'impact', r: 6371000, phiSurf: 0.2, name: 'Crash', passed: false },
			{ id: 'imp2', type: 'impact', relX: 50, relY: 50, name: 'Crash Passed', passed: true },
			{ id: 'norm', type: 'meco', r: 6500000, phiSurf: 0.05, name: 'MECO', passed: false },
			{ id: 'norm2', type: 'meco', relX: 30, relY: 30, name: 'MECO Passed', passed: true },
			{ id: 'off', type: 'meco', relX: 9999999, relY: 9999999, name: 'Offscreen', passed: false }
		]
	}, {
		mode: 'flight',
		rotationOffset: 0.5,
		actualFlightPath: [
			{ r: 6500000, phiSurf: 0 },
			{ relX: 20, relY: 20 }
		],
		rocketX: earth.x + 25,
		rocketY: earth.y + 25,
		passedEventIds: new Set(['imp2', 'norm2'])
	});

	// 7. rotatePrediction edge cases: null, 0 angle, with and without phiSurf
	assert.equal(TrajectoryPredictor.rotatePrediction(null, 1.0), null);
	const predSample = {
		points: [{ relX: 10, relY: 0, phiSurf: 0 }, { relX: 20, relY: 0 }],
		events: [{ relX: 10, relY: 0, phiSurf: 0 }]
	};
	const unrotated = TrajectoryPredictor.rotatePrediction(predSample, 0);
	assert.equal(unrotated.points.length, 2);
	const rotated = TrajectoryPredictor.rotatePrediction(predSample, Math.PI / 2);
	assert.ok(Math.abs(rotated.points[0].relY - 10) < 1e-4);
});

test('PadEffectRenderer - Deep coverage for umbilical cable, particles, and layout', () => {
	const pad = new PadEffectRenderer();
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, mass: 5.972e24 });
	const rocket = createMockRocket({ id: 2, x: 100, y: 100, radius: 10, isHoldDown: true });
	rocket.baseRadiusM = 63;
	rocket.bottomOffsetM = 195;

	pad.start(rocket.id, earth.id);

	// Test all handleEvent keywords
	pad.handleEvent('COUNTDOWN START (T-00:15)');
	assert.equal(pad.flags.isVenting, true);
	pad.handleEvent('LOX/CH4 CHILLDOWN');
	assert.equal(pad.flags.isChilldown, true);
	pad.handleEvent('PROPELLANT PRESSURIZATION');
	assert.equal(pad.flags.isPressurized, true);
	pad.handleEvent('INTERNAL POWER TRANSFER');
	assert.equal(pad.flags.isInternalPower, true);
	pad.handleEvent('WATER DELUGE SYSTEM ACTIVATED');
	assert.equal(pad.flags.isWaterDeluge, true);
	pad.handleEvent('RADIAL OUTWARD FIRING IGNITER (ROFI)');
	assert.equal(pad.flags.isROFI, true);
	pad.handleEvent('MAIN ENGINE START');
	assert.equal(pad.flags.isChilldown, false);

	// Context for update
	const context = {
		rocket: rocket,
		host: earth,
		zoomScale: 1.0,
		m2pix: (m) => m / 1000
	};

	// UmbilicalCable update while holddown then released
	pad.update(0.1, context);
	assert.ok(pad.particles.length > 0);

	// Test liftoff event
	pad.handleLiftoff();
	assert.equal(pad.flags.isVenting, false);
	assert.equal(pad.flags.isROFI, false);

	// Rocket after liftoff (isHoldDown = false)
	rocket.isHoldDown = false;
	pad.update(0.2, context);

	// Strongback and Umbilical max angle capping
	pad.strongbackAngle = 100;
	pad.umbilicalAngle = 100;
	pad.update(0.1, context);
	assert.ok(pad.strongbackAngle <= 25);
	assert.ok(pad.umbilicalAngle <= 30);

	// Particle types: square, stretch, circle, and particle death
	pad.particles.push(
		{ type: 'ice', x: 0, y: 0, vx: 10, vy: 10, life: 0.01, maxLife: 0.02, size: 0.1 },
		{ type: 'spark', x: 0, y: 0, vx: 50, vy: 50, life: 0.8, maxLife: 1.0 },
		{ type: 'deluge', x: 0, y: 0, vx: 20, vy: -30, life: 0.9, maxLife: 1.0, size: 0.2 }
	);
	pad.update(0.05, context);

	// Rendering
	const ctx = createMockElement('canvas').getContext('2d');
	const renderContext = {
		basis: earth,
		zoomScale: 1.0
	};

	pad.drawBackground(ctx, renderContext, context);
	pad.drawForeground(ctx, renderContext, context);

	// Visual multiplier edge cases: rPx <= 0
	pad.rocketRadius = 0;
	const mult = pad._getVisualMultiplier({ m2pix: () => 0, zoomScale: 0 });
	assert.equal(mult, 1.0);

	// Context without rocket (abs position uses host or (0,0))
	pad._getAbsPadPosition({ rocket: null, host: earth });
	pad._getAbsPadPosition({ rocket: null, host: null });

	// Background drawing fallback when ctx.arc is undefined (lines 634, 674)
	const rectCtx = createMockElement('canvas').getContext('2d');
	rectCtx.arc = undefined; // triggers ctx.fillRect fallback branch!
	pad.drawBackground(rectCtx, renderContext, context);

	// Inactive drawing and updates
	pad.stop();
	assert.equal(pad.isActive, false);
	pad.update(0.1, context); // early return
	pad.drawBackground(ctx, renderContext, context); // early return
	pad.drawForeground(ctx, renderContext, context); // early return

	// Fresh instance handleLiftoff without lastContext
	const freshPad = new PadEffectRenderer();
	freshPad.handleLiftoff(); // no lastContext

	// UmbilicalCable uninitialized draw & constraint dist < 1e-6
	const cable = freshPad.umbilicalCable;
	cable.draw(ctx, 10, {}); // uninitialized return
	cable._initNodes({}, 3.10); // default conf values
	cable.nodes = [{ x: 0, y: 0, prevX: 0, prevY: 0 }, { x: 0, y: 0, prevX: 0, prevY: 0 }];
	cable.restLengths = [10];
	cable.isInitialized = true;
	cable.update(0.01, {}, 0, false, 3.1); // hits dist < 1e-6 (line 138)

	// In-progress retraction without hitting max angles
	freshPad.start(rocket.id, earth.id);
	freshPad.flags.isInternalPower = true;
	freshPad.flags.isVenting = true;
	freshPad.flags.isPressurized = false; // unpressurized venting rate
	freshPad.flags.isChilldown = true;
	freshPad.flags.isWaterDeluge = true;
	freshPad.flags.isROFI = true;
	rocket.isHoldDown = false;
	freshPad.strongbackAngle = 0;
	freshPad.umbilicalAngle = 0;
	freshPad.update(0.001, context); // strongbackAngle and umbilicalAngle increase without reaching max!
	assert.ok(freshPad.strongbackAngle > 0 && freshPad.strongbackAngle < 10);
	assert.ok(freshPad.umbilicalAngle > 0 && freshPad.umbilicalAngle < 10);

	// Explicitly test _drawParticles for all shape branches (square, stretch, circle)
	freshPad._drawParticles(ctx, renderContext, context, ['deluge']); // deluge: stretch
	freshPad._drawParticles(ctx, renderContext, context, ['spark']);  // spark: square
	freshPad._drawParticles(ctx, renderContext, context, ['chill']);  // chill: circle

	// getAttachPos with empty config (lines 61 & 72 defaults)
	cable.getAttachPos({}, 0, 3.10);

	// Particles with size undefined and GRAVITY_MULT === 0 (lines 508 false & 512 false)
	freshPad.particles = [
		{ type: 'spark', x: 0, y: 0, vx: 5, vy: 5, life: 0.9, maxLife: 1.0 } // size undefined, GRAVITY_MULT === 0
	];
	freshPad.update(0.01, context);

	// Update with host without ROTATION_PERIOD (line 358 false)
	const hostNoRot = createMockCelestialBody({ id: 99, name: 'SunWithoutRotation', radius: 1000, mass: 1e20 });
	freshPad.update(0.01, { rocket: rocket, host: hostNoRot, zoomScale: 1.0, m2pix: () => 1 });

	// getTowerLayout with context without rocket
	const layoutNoRocket = freshPad.getTowerLayout(null);
	assert.ok(layoutNoRocket.strongback.isGrounded);
});

test('RocketLauncher - Preview, staging math, and rollout lifecycle deep branches', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, mass: 5.972e24 });
	const universe = createMockUniverse({ objects: [earth] });
	universe.camera.trackingTarget = earth;
	universe.ObjectPlacer = {
		placeObject: (name, x, y, vx, vy, opt) => {
			const obj = createMockRocket({ id: 88, name, x, y, vx, vy });
			Object.assign(obj, opt);
			universe.objects.push(obj);
			return obj;
		}
	};
	universe.ObjectManager = {
		removeObject: (obj) => {
			universe.objects = universe.objects.filter(o => o.id !== obj.id);
		}
	};
	universe.ControlPanel = {
		systemTab: { updateCenterOptions: () => {} },
		rocketTab: { setRolloutState: () => {} }
	};
	universe.InfoPanel = { updateCamera: () => {} };
	universe.TelemetryPanel = { open: () => {} };
	universe.LaunchSequencer = { start: () => {}, abort: () => {} };

	const launcher = new RocketLauncher(universe);
	launcher.hostId = earth.id;

	// 1. getBaseRadiusM and getBottomOffsetM for 1-stage, 2-stage, 3-stage
	launcher.currentPresetId = 'EPSILON'; // 3-stage
	assert.ok(launcher.getBottomOffsetM() > 0);

	launcher.currentPresetId = 'SSTO'; // 1-stage
	assert.ok(launcher.getBottomOffsetM() > 0);

	launcher.currentPresetId = 'FALCON9'; // 2-stage
	assert.ok(launcher.getBottomOffsetM() > 0);

	// 2. _calculateTransform with thrustKN <= 0 and burnTime > 0
	launcher.stages[0].burnTime = 120;
	let transform = launcher._calculateTransform();
	assert.equal(launcher.calculatedBurnTime, 120);

	launcher.stages[0].burnTime = 0;
	launcher.thrustKN = 0;
	transform = launcher._calculateTransform();
	assert.equal(launcher.calculatedBurnTime, 0);

	// 3. togglePreview free mode vs host mode
	launcher.mode = 'free';
	launcher.togglePreview(true);
	assert.equal(launcher.isActive, true);
	launcher.setFreePosition(500, 600);
	assert.equal(launcher.freeX, 500);

	launcher.togglePreview(false);
	assert.equal(launcher.isActive, false);

	launcher.mode = 'host';
	launcher.togglePreview(true);

	// 4. drawTargetMarker & drawPreview in host and free modes
	const ctx = createMockElement('canvas').getContext('2d');
	const renderCtx = { basis: earth, zoomScale: 1.0, name: 'main' };

	launcher.drawTargetMarker(ctx, earth, 1.0);
	launcher.drawPreview(ctx, earth, 1.0, renderCtx);

	launcher.mode = 'free';
	launcher.drawPreview(ctx, earth, 1.0, renderCtx);

	// 5. rollout, ignite, and abortRollout lifecycle
	launcher.mode = 'host';
	launcher.thrustKN = 7600;
	launcher.stages[0].burnTime = 160;
	launcher.rollout();
	assert.ok(launcher.rolloutedRocketId !== null);

	// Preview while rocket is rollouted on the pad
	launcher.drawPreview(ctx, earth, 1.0, renderCtx);

	// Ignite
	launcher.ignite('LEGACY_QUICK');

	// Abort rollout
	launcher.abortRollout();
	assert.equal(launcher.rolloutedRocketId, null);

	// 6. getState and loadState
	const state = launcher.getState();
	assert.equal(state.mode, 'host');
	assert.equal(state.hostId, earth.id);

	launcher.loadState(null); // safely ignores null
	launcher.loadState({
		mode: 'host',
		hostId: earth.id,
		hostAngleDeg: 45,
		hostAltitudeM: 20,
		thrustKN: 8000,
		maxGLimit: 3.5,
		autoControl: false,
		boosters: { count: 2 },
		rendering: { colorTheme: 'orange' }
	});
	assert.equal(launcher.hostAngleDeg, 45);
	assert.equal(launcher.thrustKN, 8000);
	assert.equal(launcher.autoControl, false);
	assert.equal(launcher.boosters.count, 2);

	// 7. requestPreviewUpdate immediate (delayMs <= 0)
	launcher.requestPreviewUpdate(0);

	// 8. Edge cases: getBaseRadiusM with rocketLengthM, transform without host, abort when null
	launcher.currentPresetId = 'CUSTOM_UNKNOWN';
	launcher.stages[0].rocketLengthM = 55;
	assert.equal(launcher.getBaseRadiusM(), 55);
	delete launcher.stages[0].rocketLengthM;
	assert.ok(launcher.getBaseRadiusM() > 0);

	launcher.hostId = 99999; // non-existent host
	const fallbackTransform = launcher._calculateTransform();
	assert.ok(fallbackTransform);
	assert.ok(typeof fallbackTransform.x === 'number');

	launcher.rolloutedRocketId = null;
	launcher.abortRollout(); // gracefully handles null
});



