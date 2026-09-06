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
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { PHYSICS, OBJECT_TYPES, OBJECT_STATE, TRAIL_MODE, DEPLOY_PROFILES } from '../../scripts/gravsim_const.js';

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
		validLength: 2 * 46
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


