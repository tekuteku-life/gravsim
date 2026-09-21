import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse, createMockCelestialBody, createMockElement, createFalcon9Config } from '../test_helpers.mjs';

// Setup DOM mocks before module imports
setupMockDOM();

import { GravSimObject, CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { Trajectory } from '../../scripts/gravsim_trajectory.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { DebrisGenerator } from '../../scripts/gravsim_debris_generator.js';
import { SaveManager } from '../../scripts/gravsim_save_manager.js';
import { ObjectPlacer } from '../../scripts/gravsim_object_placer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { PHYSICS, OBJECT_TYPES, OBJECT_STATE, TRAIL_MODE, DEPLOY_PROFILES, MULTISTAGE_PRESETS } from '../../scripts/gravsim_const.js';

test('GravSimObject hierarchy - CelestialBody, Rocket, and Debris creation', () => {
	const body = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, '#ffffff', 1, false);
	assert.equal(body.id, 1);
	assert.equal(body.name, 'Earth');
	assert.equal(body.type, OBJECT_TYPES.CELESTIAL);
	assert.equal(body.mass, 5.972e24);
	assert.equal(body.radius, 6371000);
	assert.equal(body.isDebris, false);

	const rocket = new Rocket(2, 'Falcon9', 0, -6371000, 0, 0, 30, 400, 100, '#ffffff', 2, 20, 0, null, 0);
	assert.equal(rocket.id, 2);
	assert.equal(rocket.name, 'Falcon9');
	assert.equal(rocket.type, OBJECT_TYPES.ROCKET);
	assert.equal(rocket.dryMass, 30);
	assert.equal(rocket.fuelMass, 400);
	assert.equal(rocket.oxidMass, 100);
	assert.equal(rocket.mass, 530); // dry + fuel + oxid

	const debris = new Debris(3, 'Debris#3', 10, 20, 1, 2, 50, '#888888', 1, 5, 1, null, 0);
	assert.equal(debris.id, 3);
	assert.equal(debris.type, OBJECT_TYPES.DEBRIS);
	assert.equal(debris.isDebris, true);
	assert.equal(debris.generation, 1);
	assert.equal(debris.mass, 50);
});

test('GravSimObject - Trajectory history updating and clearing', () => {
	const body = new CelestialBody(1, 'Earth', 100, 200, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0, false);
	assert.equal(body.trajectory.count, 0);

	// Add point in normal space
	body.updateHistory(1, []);
	assert.equal(body.trajectory.count, 1);

	// Add point with atmosphere mode
	body.inAtmosphere = true;
	body.updateHistory(2, []);
	assert.equal(body.trajectory.count, 2);

	// Clear history
	body.clearHistory();
	assert.equal(body.trajectory.count, 0);
});

test('ObjectManager - Add and Remove objects with Worker payload sync', () => {
	const sentMessages = [];
	const mockWorkerManager = {
		postMessage: (msg) => sentMessages.push(msg)
	};
	const mockRenderer = {};

	const objMgr = new ObjectManager(mockRenderer, mockWorkerManager);

	const earth = new CelestialBody(10, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0, false);
	objMgr.addObject(earth);

	assert.equal(objMgr.objects.length, 1);
	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].cmd, 'add');
	assert.equal(sentMessages[0].id, 10);
	assert.equal(sentMessages[0].type, OBJECT_TYPES.CELESTIAL);
	assert.equal(sentMessages[0].mass, 5.972e24 * 1000); // Converted to kg

	// Add Rocket
	const rocket = new Rocket(20, 'Starship', 0, 100, 0, 0, 100, 1000, 200, '#fff', 3, 25, 0, null, 0);
	rocket.stages = [{ stageNumber: 1, fuelMassT: 800 }];
	objMgr.addObject(rocket);

	assert.equal(objMgr.objects.length, 2);
	assert.equal(sentMessages.length, 2);
	assert.equal(sentMessages[1].cmd, 'add');
	assert.equal(sentMessages[1].id, 20);
	assert.equal(sentMessages[1].type, OBJECT_TYPES.ROCKET);

	// Remove Rocket
	objMgr.removeObject(rocket);
	assert.equal(sentMessages.length, 3);
	assert.equal(sentMessages[2].cmd, 'remove');
	assert.equal(sentMessages[2].id, 20);
	assert.equal(rocket.state, OBJECT_STATE.REMOVED);
});

test('DebrisGenerator - generateFromImpact creates debris fragments and shockwave', () => {
	const loser = {
		id: 5,
		name: 'Asteroid',
		x: 100,
		y: 200,
		color: '#ff4444',
		mass: 5000,
		radius: 50,
		generation: 0
	};

	let nextIdCounter = 100;
	const getNextId = () => nextIdCounter++;
	const m2pix = (m) => m / 1000;

	const result = DebrisGenerator.generateFromImpact(
		loser,
		2000, // total debris mass
		10, 20, // base velocities
		0, 0, // winner position
		100, // winner radius px
		m2pix,
		getNextId
	);

	assert.ok(result.shockwave, 'Shockwave data should exist');
	assert.equal(result.shockwave.x, 100);
	assert.equal(result.shockwave.y, 200);

	assert.ok(result.debrisList.length > 0, 'Debris list should have fragments');
	const firstDebris = result.debrisList[0];
	assert.ok(firstDebris instanceof Debris);
	assert.equal(firstDebris.generation, 1);
	assert.ok(firstDebris.mass > 0);
});

test('DebrisGenerator - generateFromShatter generates fragments on tidal disruption', () => {
	const shatteredBody = {
		id: 7,
		name: 'Comet',
		x: 500,
		y: 500,
		vx: 5,
		vy: -5,
		color: '#44aa44',
		mass: 1e12,
		radius: 2000,
		generation: 0
	};

	let nextIdCounter = 200;
	const getNextId = () => nextIdCounter++;
	const m2pix = (m) => m / 1000;

	const result = DebrisGenerator.generateFromShatter(shatteredBody, m2pix, getNextId);

	assert.ok(result.debrisList.length >= 2, 'Should generate multiple shatter fragments');
	for (const frag of result.debrisList) {
		assert.equal(frag.generation, 1);
		assert.ok(frag.mass < shatteredBody.mass);
	}
});

test('SaveManager - Serializes universe state and prepares downloadable JSON', () => {
	let stateRequested = false;
	const universe = createMockUniverse({
		getState: () => {
			stateRequested = true;
			return {
				timeScale: 1.5,
				objects: [
					{ id: 1, name: 'Sun', mass: 1.989e30 }
				]
			};
		},
		loadState: (state) => {}
	});

	// Mock URL.createObjectURL and revokeObjectURL
	globalThis.URL.createObjectURL = (blob) => 'blob:http://localhost/dummy-uuid';
	globalThis.URL.revokeObjectURL = (url) => {};

	const saveManager = new SaveManager(universe);
	saveManager.save();

	assert.equal(stateRequested, true, 'Universe state should be queried during save()');
});

test('ObjectPlacer - Instantiates predefined celestial body presets', () => {
	const universe = createMockUniverse();
	universe.ObjectManager = {
		_nextId: 50,
		getNextId() { return this._nextId++; },
		addObject(obj) { universe.objects.push(obj); }
	};

	const placer = new ObjectPlacer(universe);
	const earthObj = placer.placeObject('Earth', 1000, 2000, 0, 10);

	assert.ok(earthObj instanceof CelestialBody);
	assert.equal(earthObj.name, 'Earth');
	assert.equal(earthObj.x, 1000);
	assert.equal(earthObj.y, 2000);
	assert.equal(earthObj.vy, 10);
	placer.destroy();
});

test('ObjectManager - updateObjectParams synchronizes positions and spawns stage debris', () => {
	const mockWorkerManager = { postMessage: () => {} };
	const objMgr = new ObjectManager({}, mockWorkerManager);

	const rocket = new Rocket(101, 'Falcon 9', 0, -6371000, 0, 0, 30, 400, 100, '#fff', 3, 20, 0, null, 0);
	objMgr.addObject(rocket, false);

	// Create buffer update for rocket and a newly spawned Stage 1 booster debris (debrisSubType: 1)
	const mockBufferObjs = [
		{
			id: 101,
			type: OBJECT_TYPES.ROCKET,
			x: 50000, // 50 km in meters
			y: -6421000,
			vx: 800,
			vy: -1500,
			ax: 10,
			ay: -25,
			mass: 500,
			radius: 20,
			fuelMass: 350,
			oxidMass: 80,
			flightComputer: {
				getTelemetry: () => ({ status: 1, remDv: 3000, twr: 1.5 })
			},
			isCollided: false,
			isShattered: false
		},
		{
			id: 102,
			type: OBJECT_TYPES.DEBRIS,
			debrisSubType: 1, // Stage 1 Booster
			x: 45000,
			y: -6410000,
			vx: 780,
			vy: -1400,
			ax: 0,
			ay: -9.8,
			mass: 25.0, // 25 t
			radius: 1.85,
			isCollided: false,
			isShattered: false
		}
	];

	const buffer = WorkerBridge.formatWorkerToMain(mockBufferObjs);
	objMgr.updateObjectParams({
		objectsData: buffer,
		validLength: buffer.length
	});

	// Rocket should have updated position
	assert.ok(rocket.x !== 0, 'Rocket position should be updated from worker buffer');
	assert.ok(rocket.vx !== 0, 'Rocket velocity should be updated');

	// Debris 102 should have been automatically spawned into objects list
	assert.equal(objMgr.objects.length, 2, 'Booster debris must be automatically added to objects list');
	const booster = objMgr.objects.find(o => o.id === 102);
	assert.ok(booster, 'Booster debris object must exist');
	assert.equal(booster.name, 'Stage 1 Booster');
	assert.equal(booster.mass, 25.0);

	// Test getNextId
	const nextId1 = objMgr.getNextId();
	const nextId2 = objMgr.getNextId();
	assert.equal(nextId2, nextId1 + 1);

	// Test rocket:update-state EventBus
	EventBus.emit('rocket:update-state', rocket.id, true, false);
	assert.equal(rocket.isIgnited, true);
	assert.equal(rocket.isHoldDown, false);

	// Test payload separation renaming & fallback debris spec
	rocket.payload = { name: 'Dragon Payload' };
	const mockBufferObjs2 = [
		{
			id: 101,
			type: OBJECT_TYPES.ROCKET,
			x: 100, y: 200, vx: 10, vy: 20, ax: 0, ay: 0,
			mass: 10.0, radius: 1.5,
			isCollided: false, isShattered: false,
			isPayloadSeparated: true,
			payloadName: 'Dragon Payload'
		},
		{
			id: 103,
			type: OBJECT_TYPES.DEBRIS,
			debrisSubType: 99, // unknown subtype triggers fallback spec
			parentRocketId: 101,
			x: 50, y: 100, vx: 5, vy: 10, ax: 0, ay: 0,
			mass: 1.0, radius: 0.5,
			isCollided: false, isShattered: false
		}
	];
	const buffer2 = WorkerBridge.formatWorkerToMain(mockBufferObjs2);
	objMgr.updateObjectParams({
		objectsData: buffer2,
		validLength: buffer2.length
	});
	assert.equal(rocket.name, 'Dragon Payload');
	assert.ok(objMgr.objects.find(o => o.id === 103));

	// Test shattering in worker
	let shatteredEventFired = false;
	EventBus.on('object:shattered', () => { shatteredEventFired = true; });
	const shatterObjs = [
		{
			id: 101,
			type: OBJECT_TYPES.ROCKET,
			x: 100, y: 200, vx: 0, vy: 0, ax: 0, ay: 0,
			mass: 10.0, radius: 1.5,
			isCollided: false, isShattered: true
		}
	];
	const buffer3 = WorkerBridge.formatWorkerToMain(shatterObjs);
	objMgr.updateObjectParams({
		objectsData: buffer3,
		validLength: buffer3.length
	});
	assert.ok(shatteredEventFired, 'object:shattered event must be emitted');
});

test('ObjectPlacer - Orbital placement around Sun and host body', () => {
	const universe = createMockUniverse();
	universe.ObjectManager = {
		_nextId: 1,
		getNextId() { return this._nextId++; },
		addObject(obj) { universe.objects.push(obj); }
	};

	const sun = createMockCelestialBody({
		id: 1,
		name: 'Sun',
		x: 0,
		y: 0,
		mass: 1.989e30,
		radius: 6.9634e8
	});
	universe.objects.push(sun);

	const placer = new ObjectPlacer(universe);

	// Place Earth in orbit around Sun
	const earth = placer.placeAtOrbitAroundSun('Earth');
	assert.ok(earth, 'Earth must be placed in orbit');
	assert.equal(earth.name, 'Earth');
	// Earth distance from Sun in canvas pixels should be ~180 px (1 AU at DISTANCE_SCALE = 180)
	const distPx = Math.hypot(earth.x - sun.x, earth.y - sun.y);
	assert.ok(distPx > 150 && distPx < 200, `Earth orbital radius in pixels should be ~180 (was ${distPx})`);
	assert.ok(earth.vx !== 0 || earth.vy !== 0, 'Orbital velocity must be non-zero');

	// Place Moon around Earth
	const moon = placer.placeAtOrbitAroundHost('Earth', 'Moon');
	assert.ok(moon, 'Moon must be placed around Earth');
	assert.equal(moon.name, 'Moon');
	placer.destroy();
});

test('ObjectPlacer - Deploy profiles, slingshot dragging, and Rocket placement', () => {
	const universe = createMockUniverse();
	universe.ObjectManager = {
		_nextId: 10,
		getNextId() { return this._nextId++; },
		addObject: () => {}
	};

	const placer = new ObjectPlacer(universe);

	// 1. Deploy profiles
	universe.objects = [createMockCelestialBody({ id: 1, name: 'Sun', x: 0, y: 0 })];
	placer.deployProfile('SOLAR_SYSTEM');
	assert.ok(universe.objects.length >= 8, 'Solar system profile should deploy multiple planets');

	universe.objects = [];
	placer.deployProfile('BINARY_SYSTEM');
	assert.ok(universe.objects.length >= 2, 'Binary system profile should deploy multiple stars/planets');

	universe.objects = [];
	placer.deployProfile('THREE_BODY');
	assert.ok(universe.objects.length >= 3, 'Three body profile should deploy at least 3 bodies');

	universe.objects = [];
	placer.deployProfile('GALACTIC_CENTER');
	assert.ok(universe.objects.length > 5, 'Galactic center profile should deploy central mass and orbiters');

	// 2. Slingshot launch sequence
	const sunObj = createMockCelestialBody({ id: 1, name: 'Sun', x: 0, y: 0 });
	universe.objects = [sunObj];
	universe.camera.toWorldX = (sx) => sx;
	universe.camera.toWorldY = (sy) => sy;
	universe.camera.trackingTarget = sunObj;
	universe.camera.getRenderState = () => ({
		zoomScale: 1.0,
		basis: sunObj,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	});

	placer.setReadyForLaunch(100, 100);
	assert.equal(placer.isSlingshotting, true);

	placer.updateDrag(150, 120);
	assert.equal(placer.screenCursorX, 150);
	assert.equal(placer.screenCursorY, 120);

	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	placer.drawPreview(ctx, universe.objects[0], 1.0);

	const initialCount = universe.objects.length;
	placer.goLaunch(150, 120);
	assert.equal(placer.isSlingshotting, false);
	assert.equal(universe.objects.length, initialCount + 1, 'Slingshot launch must spawn a new object');

	// 3. placeObject for Rocket
	const rocketObj = placer.placeObject('Rocket', 0, 50, 0, 0, { emptyMass: 20, fuelMass: 80, oxidMass: 160 });
	assert.ok(rocketObj instanceof Rocket);
	assert.equal(rocketObj.dryMass, 20);
	placer.destroy();
});

test('GravSimObject hierarchy - Canvas drawing and lifecycle completion', () => {
	const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 10, 6371000, 0, '#ffffff', 1, false);
	const rocket = new Rocket(2, 'Falcon9', 0, -6371000, 0, 0, 30, 400, 100, '#ffffff', 2, 20, 0, null, 0);
	const debris = new Debris(3, 'Booster', 10, -6371000, 0, 0, 25, '#d0d8e0', 3, 5, 1, '#00ffff', 1);

	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const renderContext = {
		name: 'main',
		ctx: ctx,
		basis: earth,
		zoomScale: 1.0,
		centerObjectId: 1
	};

	// Test draw on all 3 types
	earth.draw(renderContext);
	rocket.draw(renderContext);
	debris.draw(renderContext);

	// Test lifecycle completion (finished)
	debris.setCollided();
	assert.equal(debris.state, OBJECT_STATE.REMOVED);

	debris.clearHistory();
	assert.equal(debris.finished(), true, 'Object should finish when all trail points are empty');
});

test('SaveManager - Import and deserialize universe state', () => {
	let loadedUniverseState = null;
	const universe = createMockUniverse();
	universe.loadState = (st) => { loadedUniverseState = st; };
	const saveMgr = new SaveManager(universe);

	// Mock FileReader
	globalThis.FileReader = class MockFileReader {
		readAsText(file) {
			this.onload({ target: { result: JSON.stringify({ universe: { timeScale: 5 } }) } });
		}
	};

	const fakeEvent = { target: { files: [{ name: 'save.json' }], value: 'test' } };
	saveMgr.load(fakeEvent);
	assert.ok(loadedUniverseState, 'Universe state should be loaded from file');
	assert.equal(loadedUniverseState.timeScale, 5);
});

test('Trajectory - Ring buffer points, shrink, binary search interpolation, and draw', () => {
	const traj = new Trajectory(1);
	assert.equal(traj.count, 0);

	// Add points
	traj.addPoint(10, 20, 1, 0);
	traj.addPoint(20, 40, 2, 0);
	traj.addPoint(30, 60, 3, 0);
	assert.equal(traj.count, 3);

	// Test shrink
	traj.shrink(10);
	assert.ok(traj.count < 3);

	// Add more points to test interpolation
	traj.clear();
	traj.addPoint(100, 100, 10, 0);
	traj.addPoint(200, 200, 20, 0);
	traj.addPoint(300, 300, 30, 0);

	const exact = traj.getInterpolatedPos(20);
	assert.equal(exact.x, 200);
	assert.equal(exact.y, 200);

	const interpolated = traj.getInterpolatedPos(15);
	assert.equal(interpolated.x, 150);
	assert.equal(interpolated.y, 150);

	// Boundary cases
	const beforeFirst = traj.getInterpolatedPos(5);
	assert.equal(beforeFirst.x, 100);
	const afterLast = traj.getInterpolatedPos(35);
	assert.equal(afterLast.x, 300);

	// Draw
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	traj.draw({ ctx, basis: { x: 0, y: 0 }, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 } });
});

test('ObjectManager - Update commands, escape pruning, and state serialization', () => {
	const sun = new CelestialBody(1, 'Sun', 0, 0, 0, 0, 1.989e30, '#ffff00', 10, 6.9634e8, 0, null, 0, true);
	const earth = new CelestialBody(2, 'Earth', 1000, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
	const rocket = new Rocket(3, 'Falcon9', 1000, -6371000, 0, 0, 30, 400, 100, '#ffffff', 2, 20, 0, null, 0);
	const debris = new Debris(4, 'Debris#1', 2000, 2000, 10, 10, 10, '#888888', 1, 5, 1, null, 0);

	const universe = createMockUniverse();
	const objMgr = new ObjectManager(universe.renderer, universe.workerManager);
	objMgr.addObject(sun);
	objMgr.addObject(earth);
	objMgr.addObject(rocket);
	objMgr.addObject(debris);

	// Test updateObject
	objMgr.updateObject(earth);

	// Test updateRocketState
	objMgr.updateRocketState(3, true, false);
	assert.equal(rocket.isIgnited, true);
	assert.equal(rocket.isHoldDown, false);

	// Test escape pruning
	earth.isEscaping = true;
	earth.x = 1e18; // Very far away (beyond SIMULATION.REMOVE_DISTANCE_AU)
	objMgr._checkEscapeAndRemove();
	assert.equal(earth.state, OBJECT_STATE.REMOVED);

	// Test getState
	const serialized = objMgr.getState();
	assert.equal(serialized.length, 4);

	// Test loadState
	objMgr.loadState(serialized);
	assert.equal(objMgr.objects.length, 4);
});

test('Rocket - Atmospheric flame effect, effect trail, and flight drawing', () => {
	const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
	const rocket = new Rocket(2, 'Falcon9', 0, -6371000, 0, 0, 30, 400, 100, '#ffffff', 2, 20, 0, null, 0);
	rocket.dominantBodyId = 1;
	rocket.isIgnited = true;
	rocket.burnTime = 100;
	rocket.thrustAngle = -Math.PI / 2;
	rocket.inAtmosphere = true;
	rocket.isHoldDown = false;

	// Update history creates effect trail in atmosphere
	rocket.updateHistory(1, [earth, rocket]);
	assert.ok(rocket.effectTrail.count > 0);

	// Draw while flying with flame
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	const renderContext = {
		ctx,
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	};

	rocket.predictedTrajectory = {
		hostId: 1,
		points: [{ relX: 0, relY: -6371000, time: 0, altM: 0 }],
		events: []
	};
	rocket.actualFlightPath = [{ worldX: 0, worldY: -6371000, relX: 0, relY: -6371000 }];

	rocket.draw(renderContext);
});

test('ObjectPlacer - Deploy profiles, drag gestures, and preview drawing', () => {
	const sun = new CelestialBody(1, 'Sun', 0, 0, 0, 0, 1.989e30, '#ffff00', 10, 6.9634e8, 0, null, 0, true);
	const earth = new CelestialBody(2, 'Earth', 1000, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
	const universe = createMockUniverse({ objects: [sun, earth] });
	universe.camera.getRenderState = () => ({ zoomScale: 1.0, basis: sun, cameraOffset: { x: 0, y: 0 }, rotation: 0 });
	const placer = new ObjectPlacer(universe);

	// 1. Deploy profiles
	placer.deployProfile('SOLAR_SYSTEM');
	placer.deployProfile('BINARY_SYSTEM');
	placer.deployProfile('THREE_BODY');
	placer.deployProfile('GALACTIC_CENTER');
	placer.deployProfile('DEBUG_STRESS_TEST');

	// 2. Orbital placements
	sun.name = 'Sun';
	earth.name = 'Earth';
	universe.objects.length = 0;
	universe.objects.push(sun, earth);
	placer.placeAtOrbitAroundSun('Earth');
	placer.placeAtOrbitAroundHost('Earth', 'Moon');

	// 3. Drag gesture interaction
	EventBus.emit('input:drag-start', 100, 100);
	assert.equal(placer.isSlingshotting, true);
	EventBus.emit('input:drag-move', 110, 110);
	EventBus.emit('input:drag-cancel');
	assert.equal(placer.isSlingshotting, false);

	EventBus.emit('input:drag-start', 100, 100);
	EventBus.emit('input:drag-end', 120, 120);
	assert.equal(placer.isSlingshotting, false);

	// 4. Place active rocket with engine options
	const activeRocket = placer.placeObject('Rocket', 0, 0, 0, 0, {
		time: 150,
		force: 5000000,
		lossRate: 500,
		maxGLimit: 4.0,
		autoControl: true,
		angle: Math.PI / 4,
		ofRatio: 2.5
	});
	assert.equal(activeRocket.type, OBJECT_TYPES.ROCKET);
	assert.equal(activeRocket.thrustForce, 5000000);

	// 5. Draw preview & destroy
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	placer.drawPreview(ctx, sun, 1.0);
	placer.destroy();
});

test('GravSimObject - Geometric state manipulation, multi-stage mass, and polygon debris drawing', () => {
	const earth = new CelestialBody(1, 'Earth', 100, 200, 1, 2, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
	
	// State manipulation
	assert.equal(earth.isCenterObject({ centerObjectId: 1 }), true);
	assert.equal(earth.isCenterObject({ centerObjectId: 2 }), false);
	earth.setPosition(300, 400);
	assert.equal(earth.x, 300);
	assert.equal(earth.y, 400);
	earth.setVelocity(5, -5);
	assert.equal(earth.vx, 5);
	assert.equal(earth.vy, -5);
	earth.resetGravity();
	assert.equal(earth.ax, 0);
	assert.equal(earth.ay, 0);
	assert.equal(earth.getRelativeX({ x: 100 }), 200);
	assert.equal(earth.getRelativeY({ y: 150 }), 250);

	// Finished removal check
	earth.setCollided();
	assert.equal(earth.finished(), true);

	// CelestialBody draw with thick atmosphere (radial gradient)
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	earth.state = OBJECT_STATE.ACTIVE;
	earth.draw({ ctx, basis: earth, zoomScale: 1000.0, cameraOffset: { x: 0, y: 0 }, rotation: 0 });

	// Multi-stage rocket mass
	const msRocket = new Rocket(2, 'MultiStage', 0, 0, 0, 0, 10, 50, 100, '#ffffff', 2, 2, 0, null, 0);
	msRocket.stages = [
		{ stageNumber: 1, dryMassT: 10, fuelMassT: 50, oxidMassT: 100 },
		{ stageNumber: 2, dryMassT: 4, fuelMassT: 20, oxidMassT: 40 }
	];
	msRocket.currentStageIndex = 0;
	msRocket.payload = { massT: 3 };
	msRocket.fairing = { enabled: true, massT: 1 };
	// Mass = payload(3) + fairing(1) + currentStage(160) + stage2(64) = 228
	assert.equal(msRocket.mass, 228);

	// Internal power shadow glow in rocket draw
	msRocket.isInternalPower = true;
	msRocket.draw({ ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 }, rotation: 0 });

	// Debris drawing with and without polygon vertices
	const polyDebris = new Debris(3, 'Frag', 0, 0, 0, 0, 10, '#888888', 2, 2, 1, null, 0);
	polyDebris.polygonVertices = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
	polyDebris.draw({ ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 }, rotation: 0 });

	polyDebris.polygonVertices = null;
	polyDebris.draw({ ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 }, rotation: 0 });
});

test('ObjectManager - Impact/shatter buffer parsing and dead objects removal', () => {
	const universe = createMockUniverse();
	const objMgr = new ObjectManager(universe.renderer, universe.workerManager);

	const victim = new CelestialBody(1, 'Target', 0, 0, 0, 0, 1e12, '#ffffff', 2, 100, 0, null, 0);
	objMgr.addObject(victim);

	// 1. Impact and shatter via WorkerBridge buffer in updateObjectParams
	const impactMock = {
		id: 1,
		type: OBJECT_TYPES.CELESTIAL,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		mass: 1e12,
		radius: 100,
		collided: true,
		isImpact: true,
		shattered: true,
		debrisMass: 5e11,
		impactVx: 10,
		impactVy: 10,
		impactWinnerX: 50,
		impactWinnerY: 50,
		impactWinnerRadius: 100
	};

	// Also include newly spawned debris 1, 2, 3
	const deb1 = { id: 10, type: OBJECT_TYPES.DEBRIS, debrisSubType: 1, mass: 10, x: 10, y: 10, vx: 1, vy: 1, radius: 2 };
	const deb2 = { id: 11, type: OBJECT_TYPES.DEBRIS, debrisSubType: 2, mass: 5, x: 20, y: 20, vx: 2, vy: 2, radius: 1.5 };
	const deb3 = { id: 12, type: OBJECT_TYPES.DEBRIS, debrisSubType: 3, mass: 1, x: 30, y: 30, vx: 3, vy: 3, radius: 1.0 };

	const buf = WorkerBridge.formatWorkerToMain([impactMock, deb1, deb2, deb3]);
	objMgr.updateObjectParams({ objectsData: buf.buffer, validLength: buf.length });

	assert.equal(victim.state, OBJECT_STATE.REMOVED);
	assert.ok(objMgr.objects.some(o => o.id === 10 && o.name === 'Stage 1 Booster'));
	assert.ok(objMgr.objects.some(o => o.id === 11 && o.name === 'Stage 2 Upper Stage'));
	assert.ok(objMgr.objects.some(o => o.id === 12 && o.name === 'Fairing Half'));

	// 2. Remove dead objects and destroy
	victim.setCollided();
	victim.clearHistory();
	objMgr.cleanupObjects();
	assert.ok(!objMgr.objects.includes(victim));

	objMgr.destroy();
	assert.equal(objMgr.objects.length, 0);
});

test('ObjectPlacer - Deep branch coverage: error throws, rotation transform, slingshot preview, and options', () => {
	EventBus.clearAll();
	const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
	const universe = createMockUniverse({ objects: [earth] });
	const placer = new ObjectPlacer(universe);
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');

	// 1. placeAtOrbitAroundHost error branch when host missing
	assert.throws(() => {
		placer.placeAtOrbitAroundHost('NonExistentHost', 'Earth');
	}, /not found in the universe/);

	// 2. placeAtOrbitAroundSun error branch when Sun and camera target missing
	universe.objects = [];
	universe.camera.trackingTarget = null;
	assert.throws(() => {
		placer.placeAtOrbitAroundSun('Earth');
	}, /Sun object not found/);

	// Restore earth
	universe.objects = [earth];
	universe.camera.trackingTarget = earth;

	// 3. deployProfile with invalid profileId (lines 212-214)
	placer.deployProfile('UNKNOWN_PROFILE_XYZ');

	// 4. placeObject with flightProfile option and emptyMass/fuelMass options
	const rocketObj = placer.placeObject('Rocket', 0, -6371000, 0, 0, {
		flightProfile: [{ type: 'time', value: 10, thrust: 100, angle: 0 }],
		time: 100,
		force: 7600000,
		lossRate: 200,
		maxGLimit: 4.5,
		ofRatio: 2.5,
		oxidMass: 150,
		fuelMass: 75,
		emptyMass: 25
	});
	assert.equal(rocketObj.burnTime, 100);
	assert.equal(rocketObj.ofRatio, 2.5);

	// placeObject without engine burn (time: 0)
	const inertRocket = placer.placeObject('Rocket', 100, 100, 0, 0, { time: 0 });
	assert.equal(inertRocket.burnTime, 0);

	// placeObject unknown template fallback to Earth
	const fallbackObj = placer.placeObject('UnknownPlanetType', 200, 200);
	assert.ok(fallbackObj !== null);

	// placeAtOrbit for Rocket around non-Sun host
	const orbitRocket = placer.placeAtOrbit('Rocket', earth);
	assert.ok(orbitRocket !== null);

	// 5. deployProfile('THREE_BODY') with stars = null fallback (lines 440-442) and empty universe
	universe.objects = []; // existingObj = null branch (lines 434-437)
	const origStars = DEPLOY_PROFILES.THREE_BODY.generators[0].stars;
	DEPLOY_PROFILES.THREE_BODY.generators[0].stars = null;
	placer.deployProfile('THREE_BODY');
	DEPLOY_PROFILES.THREE_BODY.generators[0].stars = origStars;

	// deployProfile('BINARY_SYSTEM') on empty universe -> primaryObj else branch (lines 368-374)
	universe.objects = [];
	placer.deployProfile('BINARY_SYSTEM');

	// deployProfile('THREE_BODY') with includePlanet = false
	universe.objects = [];
	const origInclude = DEPLOY_PROFILES.THREE_BODY.generators[0].includePlanet;
	DEPLOY_PROFILES.THREE_BODY.generators[0].includePlanet = false;
	placer.deployProfile('THREE_BODY');
	DEPLOY_PROFILES.THREE_BODY.generators[0].includePlanet = origInclude;

	// Restore earth
	universe.objects = [earth];
	universe.camera.trackingTarget = earth;

	// 5. getLaunchPosition with camera rotation: 0 and rotation: 0.5 (lines 544-550)
	universe.camera.getRenderState = () => ({
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	});
	const unrotPos = placer.getLaunchPosition(500, 300);
	assert.ok(unrotPos.x !== 0);

	universe.camera.getRenderState = () => ({
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0.5
	});
	const rotPos = placer.getLaunchPosition(500, 300);
	assert.ok(rotPos.x !== 0);

	// 6. getLaunchObjectName with and without massSelect element
	const massSelect = document.getElementById('mass-select');
	massSelect.value = 'Earth';
	assert.equal(placer.getLaunchObjectName(), 'Earth');
	massSelect.value = '';
	assert.equal(placer.getLaunchObjectName(), 'Rocket');

	const origGetElementById = document.getElementById;
	document.getElementById = () => null;
	assert.equal(placer.getLaunchObjectName(), 'Rocket');
	document.getElementById = origGetElementById;

	// 7. setReadyForLaunch with free rocket launcher mode (lines 580-585)
	universe.RocketLauncher.isActive = true;
	universe.RocketLauncher.mode = 'free';
	let freePosSet = false;
	universe.RocketLauncher.setFreePosition = (x, y) => { freePosSet = true; };
	placer.setReadyForLaunch(200, 200);
	assert.equal(freePosSet, true);

	// 8. updateDrag and drawPreview early returns when not slingshotting (lines 605, 641)
	placer.isSlingshotting = false;
	placer.updateDrag(100, 100); // returns safely
	placer.drawPreview(ctx, earth, 1.0); // returns safely
	placer.isSlingshotting = true;
	placer.startRelX = null;
	placer.drawPreview(ctx, earth, 1.0); // returns safely when startRelX is null
	placer.isSlingshotting = false;
	placer.goLaunch(300, 300); // returns safely

	// 9. setReadyForLaunch when RocketLauncher is null or inactive or not free
	const origLauncher = universe.RocketLauncher;
	universe.RocketLauncher = null;
	placer.setReadyForLaunch(100, 100);
	placer.isSlingshotting = false;
	universe.RocketLauncher = origLauncher;
	universe.RocketLauncher.isActive = false;
	placer.setReadyForLaunch(100, 100);
	placer.isSlingshotting = false;
	universe.RocketLauncher.isActive = true;
	universe.RocketLauncher.mode = 'host';
	placer.setReadyForLaunch(100, 100);
	placer.isSlingshotting = false;

	// 10. placeObject with custom border and angle options
	const borderedObj = placer.placeObject('Earth', 500, 500, 0, 0, {
		angle: Math.PI / 3,
		borderColor: '#ffffff',
		borderWidth: 2
	});
	assert.ok(borderedObj !== null);

	// 11. drawPreview with rotation: 0 and rotation: 0.5 (lines 660-666)
	universe.RocketLauncher.mode = 'host';
	universe.RocketLauncher.isActive = false;
	placer.setReadyForLaunch(400, 400); // starts slingshotting
	placer.updateDrag(450, 450);

	// Draw with rotation = 0
	universe.camera.getRenderState = () => ({
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	});
	placer.drawPreview(ctx, earth, 1.0);

	// Draw with rotation = 0.5
	universe.camera.getRenderState = () => ({
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0.5
	});
	placer.drawPreview(ctx, earth, 1.0);

	// DrawAfter event hook triggers drawPreview on main vs secondary (lines 58-60)
	EventBus.emitDrawAfter(ctx, { name: 'secondary', basis: earth, zoomScale: 1.0 });
	EventBus.emitDrawAfter(ctx, { name: 'main', basis: earth, zoomScale: 1.0 });

	// Short drag preview (lineLength <= conf.ARROW_MIN_LEN) (lines 709)
	placer.updateDrag(401, 401);
	placer.drawPreview(ctx, earth, 1.0);

	// 12. EventBus deploy commands and drag-cancel (lines 35-42, 51-55)
	placer.setReadyForLaunch(100, 100);
	assert.equal(placer.isSlingshotting, true);
	EventBus.emit('input:drag-cancel');
	assert.equal(placer.isSlingshotting, false);

	// EventBus deploy listeners
	const sun = new CelestialBody(10, 'Sun', 0, 0, 0, 0, 1.989e30, '#ffcc00', 10, 696340000, 0, null, 0);
	universe.objects = [sun, earth];
	EventBus.emit('object:deploy-orbit-sun', 'Earth');
	EventBus.emit('object:deploy-orbit-host', 'Earth', 'Moon');
	EventBus.emit('object:deploy-profile', 'SOLAR_SYSTEM');

	// placeObject Rocket with all remaining options
	placer.placeObject('Rocket', 0, 0, 0, 0, {
		hostId: 1,
		hostAngleRad: 0.1,
		hostAltM: 500,
		isHoldDown: true,
		isIgnited: false,
		stages: [{ stageNumber: 1 }],
		payload: { name: 'P' },
		fairing: { enabled: true }
	});

	// deployProfile with existing host for swarms
	const origStress = DEPLOY_PROFILES.DEBUG_STRESS_TEST.generators;
	// Use small counts for fast test execution
	DEPLOY_PROFILES.DEBUG_STRESS_TEST.generators = [
		{ ...origStress[0], count: 2 },
		{ ...origStress[1], count: 2 }
	];
	universe.objects = [sun];
	placer.deployProfile('DEBUG_STRESS_TEST');
	DEPLOY_PROFILES.DEBUG_STRESS_TEST.generators = origStress;

	// deployProfile with missing swarm host (!hostObj return branch line 246)
	universe.objects = []; // no Sun in universe
	placer.deployProfile('DEBUG_STRESS_TEST');

	// EventBus lifecycle methods for full coverage
	let updateCalled = false;
	const updateCb = () => { updateCalled = true; };
	EventBus.onUpdate(updateCb);
	EventBus.emitUpdate(16, 16);
	assert.equal(updateCalled, true);

	let drawBeforeCalled = false;
	EventBus.onDrawBefore(() => { drawBeforeCalled = true; });
	EventBus.emitDrawBefore(ctx, { name: 'main' });
	assert.equal(drawBeforeCalled, true);

	let drawOverlayCalled = false;
	EventBus.onDrawOverlay(() => { drawOverlayCalled = true; });
	EventBus.emitDrawOverlay(ctx, { name: 'main' });
	assert.equal(drawOverlayCalled, true);

	let intervalCalled = false;
	EventBus.registerInterval(100, () => { intervalCalled = true; });
	EventBus.tickIntervals(200);
	assert.equal(intervalCalled, true);

	const dummyHandler = () => {};
	EventBus.on('test:dummy', dummyHandler);
	EventBus.off('test:dummy', dummyHandler);
	EventBus.off('nonexistent', dummyHandler);

	placer.destroy();
	EventBus.clearAll();
});

test('CelestialBody & Rocket - Escape trails, rotating atmosphere, actual flight path culling, and draw branches', () => {
	const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
	earth.rotationAngle = 0.5;

	// 1. CelestialBody escaping trail (lines 57-58) and rotating atmosphere follow (lines 82-88)
	const escapeBody = new CelestialBody(2, 'Escaper', 100, 200, 10, 20, 1000, '#ffffff', 2, 10, 0, null, 0);
	escapeBody.isEscaping = true;
	escapeBody.dominantBodyId = earth.id;
	escapeBody.updateHistory(1, [earth]);
	assert.equal(escapeBody.trajectory.getPoint(0).mode, TRAIL_MODE.ESCAPE);

	escapeBody.isEscaping = false;
	escapeBody.inAtmosphere = true;
	escapeBody.updateHistory(2, [earth]);
	assert.equal(escapeBody.trajectory.getPoint(1).mode, TRAIL_MODE.ATMOSPHERE);

	// 2. High zoom CelestialBody atmosphere gradient rendering (lines 214-228)
	const mockCanvas = createMockElement('canvas');
	const ctx = mockCanvas.getContext('2d');
	earth.draw({ ctx, basis: earth, zoomScale: 10.0, cameraOffset: { x: 0, y: 0 }, rotation: 0 });

	// 3. Rocket unignited hold-down updateHistory early return (lines 318-319)
	const rocket = new Rocket(101, 'Falcon', 0, -6371000, 0, 0, 25, 100, 200, '#ffffff', 3, 2, 0, null, 0);
	rocket.isHoldDown = true;
	rocket.isIgnited = false;
	rocket.updateHistory(1, [earth]);
	assert.equal(rocket.trajectory.count, 0); // ignored

	// 4. Rocket escaping and atmosphere rotation follow (lines 325-326, 363-369)
	rocket.isHoldDown = false;
	rocket.isIgnited = true;
	rocket.burnTime = 100;
	rocket.isEscaping = true;
	rocket.dominantBodyId = earth.id;
	rocket.updateHistory(2, [earth]);
	assert.equal(rocket.trajectory.getPoint(0).mode, TRAIL_MODE.ESCAPE);

	rocket.isEscaping = false;
	rocket.inAtmosphere = true;
	rocket.updateHistory(3, [earth]);
	assert.equal(rocket.trajectory.getPoint(1).mode, TRAIL_MODE.ATMOSPHERE);

	// 5. Rocket _recordActualFlightPath: holdDown early return (lines 437-438) & decimation (>6000 pts)
	rocket.isHoldDown = true;
	rocket._recordActualFlightPath([earth]);

	rocket.isHoldDown = false;
	rocket.hostId = earth.id;
	rocket.actualFlightPath = [];
	for (let i = 0; i < 6005; i++) {
		rocket.actualFlightPath.push({ worldX: i, worldY: i, relX: i, relY: i });
	}
	rocket.x = 70000;
	rocket.y = 70000;
	rocket._recordActualFlightPath([earth]);
	assert.ok(rocket.actualFlightPath.length <= 3005, 'Should decimate when points exceed 6000');

	// 6. Rocket.draw hostId complement (lines 483-484)
	rocket.predictedTrajectory = { points: [{ relX: 0, relY: 0 }] };
	rocket.hostId = earth.id;
	rocket.draw({ ctx, basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 }, objects: [earth] });
	assert.equal(rocket.predictedTrajectory.hostId, earth.id);
});

test('ObjectManager, ObjectPlacer, and RocketLauncher deep branch coverage', () => {
	const earth = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0 });
	const universe = createMockUniverse({ objects: [earth] });
	const workerManager = { postMessage: () => {} };
	const objMgr = new ObjectManager(universe.renderer, workerManager);
	universe.ObjectManager = objMgr;

	// 1. ObjectManager error throws
	assert.throws(() => objMgr.removeObject({}), /Invalid object type/);
	assert.throws(() => objMgr.updateObject({}), /Invalid object type/);

	// updateRocketState with non-existent id
	objMgr.updateRocketState(9999, true, false);

	// Autonomous debris spawn with subtypes 1, 2, 3, 99
	const rocket = new Rocket(10, 'Falcon 9', 0, 0, 0, 0, 25, 100, 200, '#fff', 5, 3.7, 0, null, 0);
	rocket.colorTheme = 'classic';
	objMgr.addObject(rocket, false);

	objMgr.updateObjectParams({
		id: 101, type: OBJECT_TYPES.DEBRIS, debrisSubType: 1,
		x: 100, y: 100, vx: 10, vy: 0, mass: 20, radius: 3.7
	});
	objMgr.updateObjectParams({
		id: 102, type: OBJECT_TYPES.DEBRIS, debrisSubType: 2,
		x: 200, y: 100, vx: 20, vy: 0, mass: 5, radius: 3.7
	});
	objMgr.updateObjectParams({
		id: 103, type: OBJECT_TYPES.DEBRIS, debrisSubType: 3,
		x: 300, y: 100, vx: 30, vy: 0, mass: 1, radius: 3.7
	});
	objMgr.updateObjectParams({
		id: 104, type: OBJECT_TYPES.DEBRIS, debrisSubType: 99,
		x: 400, y: 100, vx: 40, vy: 0, mass: 2, radius: 3.7
	});

	// Debris spawn when no active rocket in manager (fallback theme)
	objMgr.objects = objMgr.objects.filter(o => o.id !== 10);
	objMgr.updateObjectParams({
		id: 105, type: OBJECT_TYPES.DEBRIS, debrisSubType: 1,
		x: 500, y: 100, vx: 50, vy: 0, mass: 20, radius: 3.7
	});

	// Rocket payload separation name update
	rocket.payload = { name: 'Dragon V2' };
	rocket.name = 'Falcon 9';
	objMgr.objects.push(rocket);
	let listChangedEmitted = false;
	EventBus.on('object-list-changed', () => { listChangedEmitted = true; });
	objMgr._applyRocketState(rocket, {
		mass: 10, fuelMass: 0, oxidMass: 0, burnTime: 0, thrustRatio: 0,
		isHoldDown: false, isIgnited: false, isPayloadSeparated: true,
		radius: 3.7, tmTankPresFuel: 0, tmTankPresOxid: 0,
		tmStatus: 0, tmQAxial: 0, tmQLateral: 0, tmStructRatio: 0,
		tmAoaDeg: 0, tmProgradeAngle: 0, tmGravityAngle: 0,
		tmRemDv: 0, tmTwr: 0, tmAltM: 200000, tmVv: 0, tmVh: 7800,
		tmAv: 0, tmAh: 0, tmCurrentG: 1, tmFlightTime: 500,
		isAntiStall: false, isQLimitNear: false, isGLimitNear: false,
		tmStageIndex: 1, tmTotalStages: 2, tmStgSepActive: false,
		tmFairingSeparated: true, thrustAngle: 0
	});
	assert.equal(rocket.name, 'Dragon V2');
	assert.equal(listChangedEmitted, true);

	// loadState with rocket state having undefined flightProfile (lines 385-386)
	objMgr.loadState([
		{
			type: OBJECT_TYPES.ROCKET,
			id: 201, name: 'SSTO', x: 0, y: 0, vx: 0, vy: 0,
			dryMass: 10, fuelMass: 50, oxidMass: 100, color: '#fff',
			size: 5, radius: 2, generation: 0,
			flightProfile: undefined // hits lines 385-386!
		}
	]);
	const loadedRocket = objMgr.objects.find(o => o.id === 201);
	assert.deepEqual(loadedRocket.flightProfile, []);

	// 2. ObjectPlacer cancel drag & drawPreview with rotation
	universe.camera.getRenderState = () => ({
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	});
	const placer = new ObjectPlacer(universe);
	placer.setReadyForLaunch(100, 100);
	assert.equal(placer.isSlingshotting, true);
	EventBus.emit('input:drag-cancel');
	assert.equal(placer.isSlingshotting, false);

	// drawPreview with slingshot active and rotation !== 0
	placer.setReadyForLaunch(100, 100);
	placer.updateDrag(150, 150);
	universe.camera.getRenderState = () => ({
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0.8
	});
	const mockCtx = createMockElement('canvas').getContext('2d');
	placer.drawPreview(mockCtx, earth, 1.0);
	placer.destroy();

	// 3. RocketLauncher presets, lengths, and zero burn-time computation
	const origFP = MULTISTAGE_PRESETS.H3.flightProfile;
	MULTISTAGE_PRESETS.H3.flightProfile = null;
	const rl = new RocketLauncher(universe);
	MULTISTAGE_PRESETS.H3.flightProfile = origFP;
	assert.ok(rl.flightProfile.length >= 8); // hits default flightProfile fallback lines 54-61!

	// getBaseRadiusM fallback to stages[0].rocketLengthM (lines 176-178)
	rl.currentPresetId = 'NON_EXISTENT_PRESET';
	rl.stages = [{ rocketLengthM: 45 }];
	assert.equal(rl.getBaseRadiusM(), 45);
	assert.equal(rl.getRocketLengthM(), 45);

	// Fallback to DEFAULT_OBJECT_PARAMS['Rocket'] radius
	rl.stages = [];
	assert.equal(rl.getBaseRadiusM(), 63);

	// getBottomOffsetM for single, two, and three stage
	rl.stages = [{ rocketLengthM: 50 }];
	const offsetSingle = rl.getBottomOffsetM();
	assert.ok(offsetSingle > 0);

	rl.stages = [{ rocketLengthM: 50 }, { rocketLengthM: 50 }];
	const offsetTwo = rl.getBottomOffsetM();
	assert.ok(offsetTwo > 0);

	rl.stages = [{ rocketLengthM: 50 }, { rocketLengthM: 50 }, { rocketLengthM: 50 }];
	const offsetThree = rl.getBottomOffsetM();
	assert.ok(offsetThree > 0);

	// _calculateTransform with burnTime = 0 calculates burnTime from thrust & mass flow
	rl.stages = [{ burnTime: 0, rocketLengthM: 50 }];
	rl.thrustKN = 7000;
	rl.fuelMassT = 100;
	rl.oxidMassT = 200;
	rl._calculateTransform();
	assert.ok(rl.calculatedBurnTime > 0);
});

test('ObjectManager - Full branch coverage: errors, worker payloads, debris types, and escape pruning', () => {
	// 1. Single argument constructor fallback (lines 15-18)
	const mockRendererWorker = {
		renderer: {},
		calcWorkerManager: { postMessage: () => {} }
	};
	const objMgrSingle = new ObjectManager(mockRendererWorker);
	assert.ok(objMgrSingle.workerManager);

	const mockWorker = { postMessage: () => {} };
	const objMgr = new ObjectManager(null, mockWorker);

	// 2. Type validation throws
	assert.throws(() => objMgr.addObject({}), /Invalid object type/);
	assert.throws(() => objMgr.removeObject({}), /Invalid object type/);
	assert.throws(() => objMgr.updateObject({}), /Invalid object type/);

	// 3. addObject with Debris (lines 68-70)
	const debris = new Debris(10, 'Stage Debris', 0, 0, 0, 0, 5.0, '#fff', 5, 2.0);
	objMgr.addObject(debris);

	// 4. updateRocketState edge cases
	objMgr.updateRocketState(9999, undefined, undefined); // non-existent rocket
	objMgr.updateRocketState(10, true, false); // debris target (type !== ROCKET)

	// 5. updateObjectParams with shattered and impact on dead target
	const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000);
	objMgr.addObject(earth);
	earth.state = OBJECT_STATE.REMOVED; // dead target
	objMgr.updateObjectParams({ id: 1, type: OBJECT_TYPES.CELESTIAL, isImpact: true, isCollided: true });
	objMgr.updateObjectParams({ id: 1, type: OBJECT_TYPES.CELESTIAL, isShattered: true, isCollided: true });

	// 6. updateObjectParams autonomous debris generation: subtype 1, 2, 3, and 0
	[1, 2, 3, 0].forEach(subType => {
		objMgr.updateObjectParams({
			id: 500 + subType,
			type: OBJECT_TYPES.DEBRIS,
			debrisSubType: subType,
			x: 1000, y: 1000, vx: 10, vy: 10, mass: 2.0, radius: 2.0,
			isCollided: false, isShattered: false
		});
	});

	// 7. Rocket payload rename on payload separation (lines 271-276)
	const rocket = new Rocket(200, 'Rocket', 0, 0, 0, 0, 10, 50, 50, '#fff', 5, 20);
	rocket.payload = { name: 'JamesWebb' };
	objMgr.addObject(rocket);
	objMgr.updateObjectParams({
		id: 200,
		type: OBJECT_TYPES.ROCKET,
		mass: 10, fuelMass: 0, oxidMass: 0, burnTime: 0, thrustRatio: 0,
		isPayloadSeparated: true,
		radius: 5, tmTankPresFuel: 200, tmTankPresOxid: 200,
		tmStatus: 5, tmAltM: 500000, tmStageIndex: 2, tmTotalStages: 2
	});
	assert.equal(rocket.name, 'JamesWebb');

	// 8. _checkEscapeAndRemove edge cases
	objMgr.objects = []; // no massive bodies
	objMgr._checkEscapeAndRemove(); // hits massiveBodies.length === 0

	const sun = new CelestialBody(0, 'Sun', 0, 0, 0, 0, 1.989e30, '#ff0', 10, 6.96e8);
	const escapingObj = new CelestialBody(99, 'EscapingAsteroid', 1e15, 1e15, 1000, 1000, 1e12, '#aaa', 5, 1000);
	escapingObj.isEscaping = true;
	objMgr.objects = [sun, escapingObj];
	objMgr._checkEscapeAndRemove(); // removes escaping object

	// 9. loadState non-array & rocket without flightProfile
	objMgr.loadState(null); // ignores non-array
	objMgr.loadState([
		{ id: 1, type: OBJECT_TYPES.CELESTIAL, name: 'Sun', x: 0, y: 0, vx: 0, vy: 0, mass: 1e30, color: '#ff0', size: 10, radius: 100 },
		{ id: 2, type: OBJECT_TYPES.ROCKET, name: 'Rocket', x: 10, y: 10, vx: 0, vy: 0, dryMass: 10, fuelMass: 50, color: '#fff', size: 5, radius: 10 }
	]);
	assert.equal(objMgr.objects.length, 2);
});

test('ObjectPlacer - Full branch coverage: options, throws, custom profiles, and input states', () => {
	const sun = new CelestialBody(1, 'Sun', 0, 0, 0, 0, 1.989e30, '#ffff00', 10, 6.9634e8, 0, null, 0, true);
	const earth = new CelestialBody(2, 'Earth', 1000, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
	const universe = createMockUniverse({ objects: [sun, earth] });
	universe.canvas = { width: 800, height: 600 };
	universe.camera.getRenderState = () => ({ zoomScale: 1.0, basis: sun, cameraOffset: { x: 0, y: 0 }, rotation: 0.5 });
	universe.RocketLauncher = {
		isActive: true,
		mode: 'free',
		stages: [{ rocketLengthM: 50 }],
		payload: { name: 'Sat', massT: 2 },
		setFreePosition: () => {}
	};
	const placer = new ObjectPlacer(universe);

	// 1. placeObject Rocket with time <= 0, disableStaging, no stages
	const coldRocket = placer.placeObject('Rocket', 0, 0, 0, 0, {
		time: 0,
		disableStaging: true,
		stages: []
	});
	assert.ok(coldRocket.fairing.enabled);
	assert.ok(coldRocket.stages.length > 0);

	// 2. placeObject CelestialBody with full custom options (lines 164-180)
	const customPlanet = placer.placeObject('Earth', 500, 500, 10, -10, {
		name: 'CustomMars',
		mass: 6.4e23,
		color: '#ff3300',
		radius: 3389000,
		minDrawSize: 4.5
	});
	assert.equal(customPlanet.name, 'CustomMars');

	// 3. placeAtOrbitAroundHost & placeAtOrbitAroundSun missing body errors
	assert.throws(() => placer.placeAtOrbitAroundHost('NonExistentPlanet', 'Rocket'), /not found in the universe/);
	const emptyUniverse = createMockUniverse({ objects: [] });
	const emptyPlacer = new ObjectPlacer(emptyUniverse);
	assert.throws(() => emptyPlacer.placeAtOrbitAroundSun('Rocket'), /Sun object not found/);

	// 4. deployProfile edge cases: unknown profile
	placer.deployProfile('UNKNOWN_PROFILE_KEY');

	// 5. _deployBinarySystem without existing objects (canvas centering lines 401-406)
	const cleanUniverse = createMockUniverse({ objects: [] });
	cleanUniverse.canvas = { width: 1000, height: 1000 };
	const cleanPlacer = new ObjectPlacer(cleanUniverse);
	cleanPlacer._deployBinarySystem({
		primary: { template: 'Sun', name: 'Primary' },
		secondary: { template: 'Sun', name: 'Secondary' },
		planets: [
			{ host: 'primary', template: 'Earth', distanceAu: 0.5, hasMoon: true },
			{ host: 'barycenter', template: 'Jupiter', distanceAu: 5.0 }
		]
	});
	assert.ok(cleanUniverse.objects.length >= 4);

	// 6. _deployThreeBody without existing objects & with planet (lines 532-557)
	const threeBodyUniverse = createMockUniverse({ objects: [] });
	threeBodyUniverse.canvas = { width: 1000, height: 1000 };
	const threeBodyPlacer = new ObjectPlacer(threeBodyUniverse);
	threeBodyPlacer._deployThreeBody({
		radiusAu: 2.0,
		includePlanet: true,
		planetDistanceAu: 0.4
	});
	assert.ok(threeBodyUniverse.objects.length >= 4);

	// 7. setReadyForLaunch when RocketLauncher is active & mode === 'free' (lines 621-626)
	placer.setReadyForLaunch(200, 200);

	// 8. Slingshot dragging and preview with small arrow (lines 759-770)
	universe.RocketLauncher.isActive = false;
	placer.setReadyForLaunch(300, 300);
	placer.updateDrag(301, 301); // very small movement -> lineLength <= ARROW_MIN_LEN
	const ctx = createMockElement('canvas').getContext('2d');
	placer.drawPreview(ctx, sun, 1.0);
	placer.goLaunch(301, 301);
	assert.equal(placer.isSlingshotting, false);

	placer.destroy();
});

test('GravSimObject & Rocket - In-atmosphere flame, LOD drawing, and stage separation polygons', () => {
	const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#3366cc', 5, 6371000);
	const rocket = new Rocket(2, 'Falcon9', 0, -6371000, 0, 0, 30, 400, 100, '#ffffff', 2, 20);
	rocket.dominantBodyId = 1;
	rocket.isIgnited = true;
	rocket.burnTime = 100;
	rocket.thrustAngle = -Math.PI / 2;
	rocket.inAtmosphere = true;
	rocket.isHoldDown = false;
	rocket.isInternalPower = true;

	const ctx = createMockElement('canvas').getContext('2d');
	const renderContext = {
		ctx,
		basis: earth,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0.5
	};

	// Draw high detail with internal power glow
	rocket.draw(renderContext);

	// Draw low detail with flame (LOD threshold < 25)
	const lowDetailRenderCtx = {
		ctx,
		basis: earth,
		zoomScale: 0.1,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	};
	rocket.draw(lowDetailRenderCtx);

	// Debris polygon drawing with stage 1 and 2 subTypes
	const deb1 = new Debris(10, 'Stage 1', 0, 0, 0, 0, 5.0, '#fff', 5, 20, 1, null, 0, 1);
	deb1.draw(renderContext);
	const deb2 = new Debris(11, 'Stage 2', 0, 0, 0, 0, 3.0, '#fff', 5, 15, 1, null, 0, 2);
	deb2.draw(renderContext);
	const debFairing = new Debris(12, 'Fairing', 0, 0, 0, 0, 1.0, '#fff', 5, 10, 1, null, 0, 3);
	debFairing.draw(renderContext);

	// 1. Atmosphere radial gradient drawing (lines 214-229)
	const zoomedRenderCtx = {
		ctx,
		basis: earth,
		zoomScale: 500, // triggers screenThicknessPx >= 1
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	};
	earth.draw(zoomedRenderCtx);

	// 2. Rocket.draw atmospheric flame with 1-stage, 2-stage upper, and 3-stage (lines 382, 384-385, 394-395, 401-403, 405-415)
	const flameRenderCtx = {
		ctx,
		basis: earth,
		zoomScale: 2.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0
	};

	// Single Stage (SSTO) flame
	rocket.totalStages = 1;
	rocket.currentStageIndex = 0;
	rocket.draw(flameRenderCtx);

	// Two-Stage Upper flame
	rocket.totalStages = 2;
	rocket.currentStageIndex = 1;
	rocket.draw(flameRenderCtx);

	// Three-Stage: Stage 1, Stage 2, Stage 3 flames
	rocket.totalStages = 3;
	rocket.currentStageIndex = 0;
	rocket.draw(flameRenderCtx);
	rocket.currentStageIndex = 1;
	rocket.draw(flameRenderCtx);
	rocket.currentStageIndex = 2;
	rocket.draw(flameRenderCtx);

	// 3. _recordActualFlightPath when actualFlightPath is null (lines 479-480)
	rocket.actualFlightPath = null;
	rocket._recordActualFlightPath([earth, rocket]);
	assert.ok(rocket.actualFlightPath.length > 0);
});

test('ObjectPlacer and ObjectManager - Additional deep branches', () => {
	// ObjectManager single argument constructor with renderer.workerManager (line 17)
	const mockRenderer = {
		renderer: {},
		workerManager: { postMessage: () => {} }
	};
	const mgr = new ObjectManager(mockRenderer);
	assert.ok(mgr.workerManager);

	// updateObject on Debris (non-celestial path lines 111-120)
	const deb = new Debris(99, 'Debris', 10, 10, 0, 0, 2.0, '#fff', 5, 2.0);
	mgr.addObject(deb, false);
	mgr.updateObject(deb);

	// updateObjectParams with single object data (data.objectsData undefined lines 228-230)
	mgr.updateObjectParams({
		id: 99,
		type: OBJECT_TYPES.DEBRIS,
		x: 20, y: 20, vx: 0, vy: 0, ax: 0, ay: 0, mass: 2.0, radius: 2.0
	});

	// ObjectPlacer placeObject options coverage
	const universe = createMockUniverse({ objects: [] });
	universe.canvas = { width: 800, height: 600 };
	universe.camera.getRenderState = () => ({ zoomScale: 1.0, basis: { x: 0, y: 0, vx: 0, vy: 0 }, cameraOffset: { x: 0, y: 0 }, rotation: 0 });
	universe.RocketLauncher = null;
	const placer = new ObjectPlacer(universe);

	// Rocket without fuelMass option (calculated from options.mass - emptyMass lines 88-89)
	const r1 = placer.placeObject('Rocket', 0, 0, 0, 0, {
		mass: 500,
		emptyMass: 50,
		ofRatio: 2.5,
		angle: 1.57,
		flightProfile: [{ type: 'alt', value: 1000, thrust: 100, angle: 10 }],
		time: 120,
		force: 7000000,
		lossRate: 3.5,
		maxGLimit: 4.0,
		autoControl: true,
		hostId: 1,
		hostAngleRad: 1.57,
		hostAltM: 100,
		bottomOffsetM: 30,
		baseRadiusM: 60,
		isHoldDown: false,
		isIgnited: true,
		stages: [{ fuelType: 'liquid' }],
		payload: { name: 'Sat' },
		fairing: { enabled: true, isSeparated: false },
		disableStaging: false
	});
	assert.equal(r1.fuelMass, 450);

	// Slingshot drag cancel
	EventBus.emit('input:drag-cancel');
	assert.equal(placer.isSlingshotting, false);

	// Swarm generators and launch object name branches
	const sun = new CelestialBody(1, 'Sun', 0, 0, 0, 0, 1.989e30, '#ff0', 10, 6.96e8);
	universe.objects = [sun];

	placer._deployEllipticalSwarm(sun, {
		template: 'Earth',
		count: 2,
		perihelionAuMin: 0.8,
		perihelionAuMax: 1.2,
		aphelionAuMin: 1.5,
		aphelionAuMax: 2.0
	});

	placer._deployCircularSwarm(sun, {
		templates: ['Earth', 'Moon'],
		count: 2,
		radiusAuMin: 1.0,
		radiusAuMax: 1.5
	});

	// getLaunchObjectName with mass-select DOM
	const massSel = document.getElementById('mass-select');
	massSel.value = 'Sun';
	assert.equal(placer.getLaunchObjectName(), 'Sun');
	massSel.value = 'UnknownObject';
	assert.equal(placer.getLaunchObjectName(), 'Rocket');

	// goLaunch early return when not slingshotting
	placer.isSlingshotting = false;
	placer.goLaunch(100, 100);

	// drawPreview & updateDrag early returns
	const mockCtx = createMockElement('canvas').getContext('2d');
	placer.drawPreview(mockCtx, sun, 1.0); // isSlingshotting = false
	placer.isSlingshotting = true;
	placer.startRelX = null;
	placer.drawPreview(mockCtx, sun, 1.0); // startRelX = null
	placer.isSlingshotting = false;
	placer.updateDrag(200, 200); // isSlingshotting = false

	// placeAtOrbit with unknown object fallback to Earth (line 188)
	const orbitObj = placer.placeAtOrbit('UnknownSatellite', sun);
	assert.ok(orbitObj);

	// placeObject with disableStaging, empty stages, and null RocketLauncher payload (lines 157-158)
	universe.RocketLauncher = {
		isActive: false,
		stages: [{ rocketLengthM: 50 }],
		payload: null // triggers default payload object { name: 'Payload', massT: 5.0, radius: 1.0 }
	};
	const noPayloadRocket = placer.placeObject('Rocket', 0, 0, 0, 0, {
		disableStaging: true,
		stages: []
	});
	assert.equal(noPayloadRocket.payload.name, 'Payload');

	// placeObject with disableStaging, already has fairing, and empty RocketLauncher stages (lines 145 false & 155 false)
	universe.RocketLauncher.stages = [];
	const fairingRocket = placer.placeObject('Rocket', 0, 0, 0, 0, {
		disableStaging: true,
		fairing: { enabled: true, isSeparated: false, massT: 2.0 },
		stages: []
	});
	assert.equal(fairingRocket.fairing.massT, 2.0);

	// Slingshot preview with large drag (lineLength > ARROW_MIN_LEN arrow head drawing lines 759-770)
	// and camera rotation = 0 (line 604 & line 709)
	universe.camera.getRenderState = () => ({
		basis: sun,
		zoomScale: 1.0,
		cameraOffset: { x: 0, y: 0 },
		rotation: 0 // zero rotation branch!
	});
	placer.setReadyForLaunch(100, 100);
	placer.updateDrag(400, 400); // large drag distance > ARROW_MIN_LEN
	placer.drawPreview(mockCtx, sun, 1.0);
	placer.goLaunch(400, 400);

	// deployProfile with generator missing host (line 278) & static objects without host (line 261)
	DEPLOY_PROFILES.MOCK_TEST_PROFILE = {
		name: 'Mock Test Profile',
		clearPrevious: false,
		staticObjects: [
			{ template: 'Earth', x: 500, y: 500, vx: 0, vy: 10 }
		],
		generators: [
			{ type: 'circular_swarm', host: 'NonExistentHost', templates: ['Earth'], count: 1 }
		]
	};
	placer.deployProfile('MOCK_TEST_PROFILE');
	delete DEPLOY_PROFILES.MOCK_TEST_PROFILE;

	placer.destroy();
});






