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
import { VisualEffectManager } from '../../scripts/gravsim_visual_effect_manager.js';
import { TrailLineRenderer, EffectRenderer } from '../../scripts/gravsim_trail_renderer.js';
import { Trajectory } from '../../scripts/gravsim_trajectory.js';
import { EffectTrail } from '../../scripts/gravsim_effect_trail.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { ROCKET_LAUNCHER_CONFIG, TRAIL_MODE, RENDER } from '../../scripts/gravsim_const.js';
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

	// Draw background structure & particles
	pad.drawBackground(ctx, mockRc, mockContext);

	// Liftoff and umbilical disconnect
	pad.handleLiftoff();
	mockContext.isHoldDown = false;
	rocket.isHoldDown = false;

	// Update several steps with disconnected cable (exercises swing, gravity, damping, and constraints)
	for (let i = 0; i < 10; i++) {
		pad.update(0.016, mockContext);
	}

	// Draw foreground strongback & swinging umbilical
	pad.drawForeground(ctx, mockRc, mockContext);

	pad.stop();
	assert.equal(pad.isActive, false);
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
});

