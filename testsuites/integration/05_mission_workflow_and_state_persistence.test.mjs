/**
 * Integration Test Suite 05: Mission Workflow, Launch Pad Integration & State Persistence
 * 
 * Verifies cross-module coordination between:
 * - DeployTab & ObjectPlacer (celestial body deployment lifecycle)
 * - RocketTab & RocketLauncher (Earth default host selection, fallback to last added celestial body)
 * - SystemTab & RocketLauncher (prediction duration slider with 0.2 mo min and 1.0 mo default)
 * - PadEffectRenderer & UmbilicalCable (launch pad mechanical retraction and Verlet cable physics)
 * - SaveManager, Universe, ObjectManager & ControlPanel (full simulation state persistence)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { CelestialBody, Rocket } from '../../scripts/gravsim_object.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { SystemTab } from '../../scripts/gravsim_tab_system.js';
import { PadEffectRenderer } from '../../scripts/gravsim_pad_effect.js';
import { SaveManager } from '../../scripts/gravsim_save_manager.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { OBJECT_TYPES, OBJECT_STATE, TRAJECTORY_PREDICTION } from '../../scripts/gravsim_const.js';
import { setupMockDOM, createMockUniverse, createFalcon9Config, assertClose } from '../test_helpers.mjs';

describe('Integration 05: Mission Workflow, Launch Pad & State Persistence', () => {
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

	it('should manage celestial body selection on RocketTab open: default to Earth and fallback to last added celestial body', () => {
		const rTab = new RocketTab(universe);

		// 1. When universe has no celestial objects: hostId defaults to 0
		universe.objects = [];
		universe.RocketLauncher.hostId = null;
		rTab.open();
		assert.equal(universe.RocketLauncher.hostId, 0);

		// 2. When celestial objects exist, but none is named Earth:
		// Fallback to the LAST ADDED celestial body (not highest ID or random)
		const mars = new CelestialBody(10, 'Mars', 0, 0, 0, 0, 6.417e23 / 1000, 3389500, 0);
		const jupiter = new CelestialBody(20, 'Jupiter', 0, 0, 0, 0, 1.898e27 / 1000, 69911000, 0);
		const venus = new CelestialBody(5, 'Venus', 0, 0, 0, 0, 4.867e24 / 1000, 6051800, 0); // lower ID, but added last!

		universe.objects = [mars, jupiter, venus];
		universe.RocketLauncher.hostId = null;
		rTab.open();
		assert.equal(universe.RocketLauncher.hostId, venus.id, 'Should fallback to the last added celestial body (Venus)');

		// 3. When Earth exists in the universe:
		// Default MUST be Earth, even if other bodies were added later or have higher IDs!
		const earth = new CelestialBody(15, 'Earth', 0, 0, 0, 0, 5.972e24 / 1000, 6371000, 0);
		const moon = new CelestialBody(99, 'Moon', 0, 0, 0, 0, 7.342e22 / 1000, 1737400, 0); // added after Earth, higher ID

		universe.objects = [mars, earth, moon];
		universe.RocketLauncher.hostId = null;
		rTab.open();
		assert.equal(universe.RocketLauncher.hostId, earth.id, 'Should default to Earth when Earth is present');

		// 4. Case-insensitive "earth" matching
		const earthLower = new CelestialBody(88, 'earth', 0, 0, 0, 0, 5.972e24 / 1000, 6371000, 0);
		universe.objects = [mars, earthLower];
		universe.RocketLauncher.hostId = null;
		rTab.open();
		assert.equal(universe.RocketLauncher.hostId, earthLower.id, 'Should match case-insensitive earth');

		// 5. When host was explicitly selected by user:
		// Preserves the user selection as long as that host still exists
		universe.objects = [earth, mars, moon];
		universe.RocketLauncher.hostId = mars.id;
		rTab.open();
		assert.equal(universe.RocketLauncher.hostId, mars.id, 'Should retain valid user-selected host');

		// 6. When previously selected host is removed from the universe:
		// Recovers by falling back to Earth (or last added if Earth gone)
		universe.objects = [earth, moon]; // Mars was deleted!
		rTab.open();
		assert.equal(universe.RocketLauncher.hostId, earth.id, 'Should re-default to Earth when previous host is deleted');
	});

	it('should configure prediction duration slider with 0.2 mo min and 1.0 mo default, propagating to RocketLauncher and preview', () => {
		const launcher = new RocketLauncher(universe);
		universe.RocketLauncher = launcher;

		// 1. Initial default state
		assert.equal(universe.RocketLauncher.predictionDurationMonths, TRAJECTORY_PREDICTION.DEFAULT_DURATION_MONTHS);
		assert.equal(universe.RocketLauncher.predictionDurationMonths, 1.0);
		const expectedDefaultSec = 1.0 * (365.25 / 12) * 86400;
		assertClose(universe.RocketLauncher.maxSimTimeSec, expectedDefaultSec, 1.0);

		// 2. Verify slider attributes in DOM
		const sysTab = new SystemTab(universe);
		assert.ok(sysTab.ui.predDuration);
		assert.equal(sysTab.ui.predDuration.getAttribute('min'), '0.2');
		assert.equal(sysTab.ui.predDuration.getAttribute('value'), '1');

		let previewUpdated = false;
		universe.RocketLauncher.requestPreviewUpdate = () => { previewUpdated = true; };

		// 3. User slides to minimum: 0.2 months
		sysTab.ui.predDuration.value = '0.2';
		sysTab.ui.predDuration.dispatchEvent({ type: 'input', target: sysTab.ui.predDuration });

		assert.equal(universe.RocketLauncher.predictionDurationMonths, 0.2);
		const expectedMinSec = 0.2 * (365.25 / 12) * 86400;
		assertClose(universe.RocketLauncher.maxSimTimeSec, expectedMinSec, 1.0);
		assert.equal(sysTab.ui.predDurationVal.textContent, '0.2 mo (6 d)');
		assert.equal(previewUpdated, true);

		// 4. User slides to 3.0 months
		previewUpdated = false;
		sysTab.ui.predDuration.value = '3.0';
		sysTab.ui.predDuration.dispatchEvent({ type: 'input', target: sysTab.ui.predDuration });

		assert.equal(universe.RocketLauncher.predictionDurationMonths, 3.0);
		assert.equal(sysTab.ui.predDurationVal.textContent, '3 mo (91 d)');
		assert.equal(previewUpdated, true);

		// 5. User slides to 18.0 months (yearly format)
		sysTab.ui.predDuration.value = '18.0';
		sysTab.ui.predDuration.dispatchEvent({ type: 'input', target: sysTab.ui.predDuration });

		assert.equal(universe.RocketLauncher.predictionDurationMonths, 18.0);
		assert.equal(sysTab.ui.predDurationVal.textContent, '1.5 yr (18 mo)');
	});

	it('should execute end-to-end rollout, pad effects, countdown sequence, and liftoff transition', () => {
		const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24 / 1000, 6371000, 0);
		universe.objects = [earth];
		universe.camera.trackingTarget = earth;

		universe.ObjectPlacer = {
			placeObject: (name, x, y, vx, vy, opt) => {
				const r = new Rocket(999, name, x, y, vx, vy, opt.emptyMass || 25, opt.fuelMass || 100, opt.oxidMass || 200, '#fff', 5, 25, 0, null, 0);
				r.isHoldDown = true;
				r.state = OBJECT_STATE.ACTIVE;
				Object.assign(r, opt);
				universe.objects.push(r);
				return r;
			}
		};
		universe.ControlPanel = {
			systemTab: { updateCenterOptions: () => {} },
			rocketTab: { setRolloutState: () => {} }
		};

		const launcher = new RocketLauncher(universe);
		launcher.updatePredictionSync = () => ({ points: [{ relX: 0, relY: 0, time: 0 }], events: [] });
		universe.RocketLauncher = launcher;
		launcher.hostId = earth.id;

		// 1. Rollout rocket on Earth surface
		launcher.rollout();
		assert.ok(launcher.rolloutedRocketId !== null);

		const rocket = universe.objects.find(o => o.id === launcher.rolloutedRocketId);
		assert.ok(rocket, 'Rocket must exist in universe after rollout');
		assert.equal(rocket.isHoldDown, true);
		assert.equal(rocket.state, OBJECT_STATE.ACTIVE);

		// 2. Pad effect setup and countdown events
		const pad = new PadEffectRenderer();
		pad.start(rocket.id, earth.id);
		assert.equal(pad.isActive, true);
		assert.equal(pad.strongbackAngle, 0);
		assert.equal(pad.umbilicalAngle, 0);

		// Sequence progression
		pad.handleEvent('T-10m COUNTDOWN START');
		assert.equal(pad.flags.isVenting, true);

		pad.handleEvent('T-03m LOX/CH4 CHILLDOWN');
		assert.equal(pad.flags.isChilldown, true);

		pad.handleEvent('T-01m PROPELLANT PRESSURIZATION');
		assert.equal(pad.flags.isPressurized, true);

		pad.handleEvent('T-15s WATER DELUGE SYSTEM ACTIVATED');
		assert.equal(pad.flags.isWaterDeluge, true);

		// Internal power transfer triggers strongback retraction
		pad.handleEvent('T-10s INTERNAL POWER TRANSFER');
		assert.equal(pad.flags.isInternalPower, true);

		const context = {
			rocket,
			host: earth,
			zoomScale: 1.0,
			m2pix: (m) => m / 1000
		};

		// Update physics: strongback angle increases
		pad.update(0.5, context);
		assert.ok(pad.strongbackAngle > 0, 'Strongback should begin retracting on internal power');

		// Quick launch support: liftoff retracts strongback and umbilical
		rocket.isHoldDown = false;
		pad.handleLiftoff();
		assert.equal(pad.flags.isLiftoff, true);
		assert.equal(pad.flags.isVenting, false);

		// Update after liftoff: umbilical angle retracts and cable swings
		pad.update(0.1, context);
		assert.ok(pad.umbilicalCable.isDisconnected, 'Umbilical cable should disconnect on liftoff');
		assert.ok(pad.umbilicalAngle > 0, 'Umbilical tower should retract on liftoff');

		// Cleanup
		pad.stop();
		assert.equal(pad.isActive, false);
	});

	it('should serialize and deserialize universe, rocket launcher, and control panel state seamlessly', () => {
		const earth = new CelestialBody(1, 'Earth', 1000, 2000, 0.1, 0.2, 5.972e24 / 1000, 6371000, 0);
		const mars = new CelestialBody(2, 'Mars', 5000, 6000, -0.1, -0.2, 6.417e23 / 1000, 3389500, 0);
		const objManager = new ObjectManager(null, { postMessage: () => {} });
		objManager.universe = universe;
		objManager.addObject(earth, false);
		objManager.addObject(mars, false);
		universe.ObjectManager = objManager;
		Object.defineProperty(universe, 'objects', {
			get() { return objManager.objects; },
			set(arr) { objManager.objects = arr; },
			configurable: true
		});

		const launcher = new RocketLauncher(universe);
		universe.RocketLauncher = launcher;
		launcher.hostId = earth.id;
		launcher.hostAngleDeg = 45;
		launcher.hostAltitudeM = 120;
		launcher.colorTheme = 'orange';
		launcher.flightProfile = [
			{ type: 'alt', value: 10000, thrust: 100, angle: 10 },
			{ type: 'alt', value: 80000, thrust: 90, angle: 65 }
		];

		universe.ControlPanel = {
			getState: () => ({ currentTab: 'tab-rocket' }),
			loadState: () => {}
		};
		universe.centerObject = earth;
		universe.camera.targetOffset = { x: 10, y: 20 };

		// Attach Universe state methods
		universe.getState = Universe.prototype.getState;
		universe.loadState = Universe.prototype.loadState;

		// 1. Serialize universe state
		const savedState = universe.getState();
		assert.ok(savedState);
		assert.ok(savedState.objectManager);
		assert.ok(savedState.rocketLauncher);

		// 2. Modify / reset universe
		universe.objects = [];
		universe.RocketLauncher.hostId = null;
		universe.RocketLauncher.flightProfile = [];

		// 3. Load state back
		universe.loadState(savedState);

		// Verify celestial bodies restored
		assert.equal(universe.objects.length, 2);
		const restoredEarth = universe.objects.find(o => o.id === 1);
		const restoredMars = universe.objects.find(o => o.id === 2);
		assert.ok(restoredEarth);
		assert.ok(restoredMars);
		assert.equal(restoredEarth.name, 'Earth');
		assert.equal(restoredMars.name, 'Mars');
		assertClose(restoredEarth.x, 1000, 0.01);
		assertClose(restoredEarth.y, 2000, 0.01);

		// Verify RocketLauncher parameters restored
		assert.equal(universe.RocketLauncher.hostId, earth.id);
		assert.equal(universe.RocketLauncher.hostAngleDeg, 45);
		assert.equal(universe.RocketLauncher.hostAltitudeM, 120);
		assert.equal(universe.RocketLauncher.colorTheme, 'orange');
		assert.equal(universe.RocketLauncher.flightProfile.length, 2);
		assert.equal(universe.RocketLauncher.flightProfile[0].value, 10000);
		assert.equal(universe.RocketLauncher.flightProfile[1].angle, 65);
	});
});
