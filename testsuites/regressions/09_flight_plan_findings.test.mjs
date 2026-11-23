/**
 * Regression Suite 09: flight-plan findings of the implementation audit (Gate 2, Iteration 1)
 * docs/review/2026-11-20_trajectory_fx_flightplan.md
 *
 *  - G2-02: the launched rocket shared fairing/stages/payload/boosters/flightProfile/rendering with RocketLauncher,
 *           so the first launch's fairing separation leaked into the next rollout and post-liftoff edits leaked
 *           into the flying rocket's saved state (design §4.2).
 *  - G2-04: a `vel` re-ignition row after a commanded coast was not seen as a pending burn, turning the coast
 *           into a permanent MECO that discarded the propellant (design §4.5).
 *  - G2-05: the fuel-type change clamped stage-1 thrust to 10000 kN, lowering heavier vehicles (design §4.6).
 * Test-authoring (gate 3) findings, fixed in design Rev 6.10 (§3.4-1):
 *  - the FlightComputer constructor dropped targetApogeeKm / targetPerigeeKm / disableOrbitalCutoff from its config;
 *  - a null (or other non-object) flight-profile row from a corrupted save made FlightComputer._evaluateProfile throw.
 * Test-audit (Gate 3 Iteration 1) Watchpoint 5:
 *  - an object row without a finite value / thrust / angle (e.g. `{ type: 'time', value: 0 }`) commanded a NaN throttle.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { ObjectPlacer } from '../../scripts/gravsim_object_placer.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { CelestialBody } from '../../scripts/gravsim_object.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { OBJECT_TYPES, PHYSICS, SIMULATION } from '../../scripts/gravsim_const.js';

const DT = SIMULATION.SUB_STEPS.ROCKET_POWERED_MAX_DT;

beforeEach(() => {
	EventBus.clearAll();
});

// ---------------------------------------------------------------------------
// G2-02
// ---------------------------------------------------------------------------

/** Main thread (mock universe + real RocketLauncher/ObjectPlacer/ObjectManager) wired to an in-process Worker */
const createAppPath = ({ vehicleId, payloadId, missionId }) => {
	const controller = new SimulationController();
	const sent = [];
	const workerManager = {
		postMessage(msg) {
			if (msg.cmd === 'returnBuffer') return;
			const clone = structuredClone(msg); // the Worker boundary copies messages
			sent.push(clone);
			controller.handleMessage({ data: clone });
		}
	};
	const universe = createMockUniverse();
	const om = new ObjectManager(null, workerManager);
	universe.ObjectManager = om;
	universe.objects = om.objects;
	universe.addObject = (o) => om.addObject(o);
	universe.ObjectPlacer = new ObjectPlacer(universe);
	const earthParam = presetManager.getObjectParam('Earth');
	const earth = new CelestialBody(om.getNextId(), 'Earth', 0, 0, 0, 0, earthParam.MASS, '#1E90FF', 1, earthParam.RADIUS, 0, null, 0);
	earth.param = earthParam;
	om.addObject(earth);
	const launcher = new RocketLauncher(universe);
	universe.RocketLauncher = launcher;
	launcher.mode = 'host';
	launcher.hostId = earth.id;
	presetManager.applyToLauncher(launcher, { vehicleId, payloadId, missionId });
	// The trajectory preview is not part of these findings
	launcher.updatePredictionSync = () => null;
	launcher.updatePrediction = () => null;

	const rollout = () => {
		const before = new Set(om.objects);
		launcher.rollout();
		const main = om.objects.find(o => o.type === OBJECT_TYPES.ROCKET && !before.has(o));
		const msg = sent.filter(m => m.cmd === 'add' && m.type === OBJECT_TYPES.ROCKET).pop();
		const calc = controller.engine.objects.find(o => o.id === main.id);
		return { main, msg, calc, initialMass: calc.mass };
	};
	const liftoff = (calc) => {
		workerManager.postMessage({ cmd: 'setRocketState', id: calc.id, isIgnited: true, isHoldDown: false });
		EventBus.emit('liftoff');
	};
	const sync = () => {
		const buf = WorkerBridge.formatWorkerToMain(controller.engine.objects);
		om.updateObjectParams({ objectsData: buf.buffer, validLength: buf.length });
	};
	return { controller, universe, om, launcher, rollout, liftoff, sync };
};

describe('G2-02: the launched rocket owns its configuration (real rollout path)', () => {
	it("the first launch's fairing separation does not reach the launcher or the second rollout", () => {
		const app = createAppPath({ vehicleId: 'h3_22', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
		const first = app.rollout();
		assert.equal(first.msg.fairing.isSeparated, undefined);
		assert.equal(first.calc.fairing.isSeparated, false);
		for (const k of ['flightProfile', 'stages', 'payload', 'fairing', 'boosters', 'rendering']) {
			assert.notStrictEqual(first.main[k], app.launcher[k], `${k} is not shared with the launcher`);
		}

		app.liftoff(first.calc);
		for (let i = 0; i < 600 / DT && !first.calc.fairing.isSeparated; i++) app.controller.engine._moveObjects(DT);
		assert.equal(first.calc.fairing.isSeparated, true, 'the Worker separated the fairing in flight');
		app.sync();
		assert.equal(first.main.fairing.isSeparated, true, 'the main-thread rocket mirrors the separation');
		assert.notEqual(app.launcher.fairing.isSeparated, true, 'the launcher fairing stays attached');
		assert.notEqual(app.launcher.getState().fairing.isSeparated, true, 'the launcher state does not persist the separation');

		const second = app.rollout();
		assert.notEqual(second.msg.fairing.isSeparated, true);
		assert.equal(second.calc.fairing.isSeparated, false, 'the second vehicle rolls out with its fairing');
		assert.equal(second.initialMass, first.initialMass, 'the second vehicle has the full liftoff mass (fairing included)');
		assert.deepEqual(second.msg.fairing, first.msg.fairing);
	});

	it('post-liftoff launcher edits do not change the flying rocket or its saved state', () => {
		const app = createAppPath({ vehicleId: 'h3_22', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
		const flying = app.rollout();
		app.liftoff(flying.calc);
		for (let i = 0; i < 20; i++) app.controller.engine._moveObjects(DT);
		app.sync();
		const savedBefore = app.om.getState().find(s => s.id === flying.main.id);

		// The RocketTab editors write the launcher configuration in place
		const l = app.launcher;
		l.stages[1].fuelMassT = 123;
		l.stages[0].thrustKN = 1;
		l.flightProfile[3].angle = 77;
		l.flightProfile[0].action = 'sep_payload';
		l.flightProfile.push({ type: 'alt', value: 1, thrust: 100, angle: 0, action: '' });
		l.payload.massT = 99;
		l.payload.propulsion.thrustKN = 1;
		l.fairing.massT = 9;
		l.boosters.count = 4;
		if (l.rendering) l.rendering.__edited = true;

		const savedAfter = app.om.getState().find(s => s.id === flying.main.id);
		for (const k of ['stages', 'flightProfile', 'payload', 'fairing', 'boosters']) {
			assert.deepEqual(savedAfter[k], savedBefore[k], `${k} of the flying rocket`);
		}
		assert.equal(flying.main.rendering?.__edited, undefined);
		assert.equal(flying.calc.flightProfile.length, savedBefore.flightProfile.length);
		assert.equal(flying.calc.flightProfile[3].angle, savedBefore.flightProfile[3].angle);
	});
});

// ---------------------------------------------------------------------------
// G2-04
// ---------------------------------------------------------------------------

describe('G2-04: a coast followed by a vel re-ignition row is a pending burn (STG_COAST, propellant kept)', () => {
	// Earth-like host without a preset entry: no surface rotation, so the vel trigger equals the inertial speed
	const EARTH = Object.freeze({ name: 'G2-04 Planet', x: 0, y: 0, vx: 0, vy: 0, mass: 5.972e24, radius: 6371000 });
	const ALT = 300000;
	const R = EARTH.radius + ALT;
	const V_CIRC = Math.sqrt((PHYSICS.G * EARTH.mass) / R);
	const stage = (n, over = {}) => ({ stageNumber: n, fuelType: 'liquid', thrustKN: 500, isp: 320, dryMassT: 3, fuelMassT: 20, oxidMassT: 40, burnTime: 600, ofRatio: 2, separationDelaySec: 3, ignitionDelaySec: 2, ...over });

	/** Upper stage of a 2-stage vehicle burning in a closed 300 km orbit (peKm >= 140: "orbit complete") */
	const coastingUpperStage = (laterRows) => {
		const rocket = new CalcRocket(7, 'G2-04', 0, 0, 0, 0, 0, 0, 2, 0, 3, 20, 40, {
			stages: [stage(1, { burnTime: 5 }), stage(2)],
			payload: { name: 'Sat', massT: 2, propulsion: { enabled: false } },
			flightProfile: [
				{ type: 'time', value: 0, thrust: 100, angle: 90, action: '' },
				{ type: 'time', value: 20, thrust: 0, angle: 90, action: '' },
				...laterRows
			],
			isHoldDown: false, isIgnited: true, autoControl: true,
			disableOrbitalCutoff: true // keep the orbital-insertion cutoff out of the way: only the commanded coast is tested
		});
		rocket.separateCurrentStage();
		rocket.stageState = 'STG_BURNING';
		rocket.isIgnited = true;
		rocket.x = R; rocket.y = 0; rocket.vx = 0; rocket.vy = V_CIRC;
		rocket.flightComputer.flightTime = 20; // past COMMANDED_CUTOFF_MIN_FLIGHT_TIME_SEC, on the coast row
		return rocket;
	};
	const burnRow = (type, value) => ({ type, value, thrust: 100, angle: 90, action: '' });

	for (const [type, value] of [['vel', 9000], ['time', 1e6], ['alt', 1e9], ['apogee', 1e6]]) {
		it(`a later ${type} burn row keeps the propellant (STG_COAST)`, () => {
			const rocket = coastingUpperStage([burnRow(type, value)]);
			const burnBefore = rocket.burnTime;
			const propBefore = rocket.fuelMass + rocket.oxidMass;
			rocket.flightControl(1.0, EARTH, R);
			assert.equal(rocket.flightComputer.currentThrottle, 0, 'the coast row commands zero throttle');
			assert.equal(rocket.flightComputer.hasPendingBurnStep(), true);
			assert.equal(rocket.stageState, 'STG_COAST');
			assert.equal(rocket.isIgnited, false);
			assert.equal(rocket.burnTime, burnBefore);
			assert.equal(rocket.fuelMass + rocket.oxidMass, propBefore);
			assert.equal(rocket.currentStageIndex, 1);
			for (let i = 0; i < 5; i++) rocket.flightControl(1.0, EARTH, R);
			assert.equal(rocket.stageState, 'STG_COAST', 'the coast persists (no separation)');
			assert.equal(rocket.burnTime, burnBefore);
		});
	}

	it('the vel row re-ignites the stage once the speed reaches it', () => {
		const rocket = coastingUpperStage([burnRow('vel', 9000)]);
		rocket.flightControl(1.0, EARTH, R);
		assert.equal(rocket.stageState, 'STG_COAST');
		const burnBefore = rocket.burnTime;
		rocket.vy = 8999.9;
		rocket.flightControl(1.0, EARTH, R);
		assert.equal(rocket.stageState, 'STG_COAST', 'just below the vel threshold');
		rocket.vy = 9000.1;
		rocket.flightControl(1.0, EARTH, R);
		assert.equal(rocket.stageState, 'STG_BURNING', 're-ignited');
		assert.equal(rocket.isIgnited, true);
		assert.ok(Math.abs(rocket.burnTime - (burnBefore - 1)) < 1e-9, 'burning again');
	});

	it('a satisfied vel row blocked by an unreached earlier row still counts as pending', () => {
		const rocket = coastingUpperStage([{ type: 'alt', value: 1e9, thrust: 0, angle: 90, action: '' }, burnRow('vel', 0)]);
		rocket.flightControl(1.0, EARTH, R);
		assert.equal(rocket.stageState, 'STG_COAST');
		assert.ok(rocket.burnTime > 0);
	});

	it('control: without a later burn row the coast is the final cutoff (STG_MECO, burnTime 0)', () => {
		for (const later of [[], [{ type: 'vel', value: 9000, thrust: 0, angle: 90, action: '' }]]) {
			const rocket = coastingUpperStage(later);
			rocket.flightControl(1.0, EARTH, R);
			assert.equal(rocket.flightComputer.hasPendingBurnStep(), false);
			assert.equal(rocket.stageState, 'STG_MECO');
			assert.equal(rocket.burnTime, 0);
		}
	});
});

// ---------------------------------------------------------------------------
// G2-05
// ---------------------------------------------------------------------------

describe('G2-05: a fuel-type change never lowers stage-1 thrust below max(10000, ceil(thrust))', () => {
	const freshTab = (configure) => {
		delete globalThis.document;
		setupMockDOM();
		EventBus.clearAll();
		const universe = createMockUniverse();
		configure(universe.RocketLauncher);
		const tab = new RocketTab(universe);
		tab.selectTab(0);
		return { tab, launcher: universe.RocketLauncher };
	};
	const liftoffWeightKN = (rl) => {
		const fairing = rl.fairing?.enabled ? (rl.fairing.massT || 0) : 0;
		const m = (rl.payload?.massT || 0) + fairing + rl.stages.reduce((s, st) => s + st.dryMassT + st.fuelMassT + st.oxidMassT, 0);
		return m * PHYSICS.G0;
	};
	const changeFuel = (tab, fuel) => tab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: fuel } });

	// Design §4.6: the clamp never lowers a thrust already above the 10000 kN slider base, so the expected value is the
	// thrust before the change. leo_250km keeps the h3_24 preset thrust (11500 kN, not a deep-space mission);
	// solar_escape uses the deep-space sizing result (h3_24 x earth_obs: core 8547 + SRB 8560 = 17107 kN, checked
	// against the §3.4-3 formulas in unit/09 "liftoff TWR floor 1.25" / "SRB core thrust floor 1.15").
	for (const missionId of ['leo_250km', 'solar_escape']) {
		it(`h3_24 ${missionId}: a stage-1 thrust above 10000 kN survives hydro -> liquid`, () => {
			const { tab, launcher } = freshTab((rl) => presetManager.applyToLauncher(rl, { vehicleId: 'h3_24', payloadId: 'earth_obs', missionId }));
			const thrust = launcher.stages[0].thrustKN;
			if (missionId === 'leo_250km') assert.equal(thrust, presetManager.getVehicle('h3_24').stages[0].thrustKN, 'preset thrust');
			assert.ok(thrust > 10000, `precondition: ${thrust} kN is above the 10000 kN base (the G2-05 cap would lower it)`);
			assert.equal(launcher.stages[0].fuelType, 'hydro');
			changeFuel(tab, 'liquid');
			assert.ok(liftoffWeightKN(launcher) * 1.35 > thrust + 50, 'precondition: the 1.35 TWR floor exceeds the current thrust (the clamp branch runs)');
			assert.equal(launcher.stages[0].thrustKN, thrust, 'not lowered to 10000 kN');
			assert.equal(launcher.thrustKN, thrust);
			assert.equal(tab.ui.rlLaunchThrust.max, String(Math.ceil(thrust)));
			assert.equal(tab.ui.rlLaunchThrust.value, thrust);
		});
	}

	it('boundaries 9999 / 10000 / 10001 kN with the TWR floor above the thrust', () => {
		for (const [thrust, expected] of [[9999, 10000], [10000, 10000], [10001, 10001]]) {
			const { tab, launcher } = freshTab((rl) => {
				rl.stages = [{ stageNumber: 1, name: 'Core', fuelType: 'liquid', thrustKN: thrust, dryMassT: 20, fuelMassT: 100, oxidMassT: 250, burnTime: 100, ofRatio: 2.5 }];
				rl.payload = { name: 'Mass', massT: 2000 };
				rl.fairing = { enabled: false, massT: 0 };
			});
			changeFuel(tab, 'liquid');
			assert.ok(liftoffWeightKN(launcher) * 1.35 > 10001 + 50);
			assert.equal(launcher.stages[0].thrustKN, expected, `thrust ${thrust}`);
			assert.equal(tab.ui.rlLaunchThrust.max, String(expected));
		}
	});
});

// ---------------------------------------------------------------------------
// Gate-3 findings (design Rev 6.10)
// ---------------------------------------------------------------------------

describe('Rev 6.10: FlightComputer keeps the orbit targets of its constructor config', () => {
	it('standalone and as CalcRocket.flightComputer before the first update', () => {
		const fc = new FlightComputer({ targetApogeeKm: 400, targetPerigeeKm: 380, disableOrbitalCutoff: true });
		assert.deepEqual([fc.targetApogeeKm, fc.targetPerigeeKm, fc.disableOrbitalCutoff], [400, 380, true]);
		const rocket = new CalcRocket(1, 'R', 0, 0, 0, 0, 0, 0, 2, 0, 5, 10, 20, {
			stages: [{ stageNumber: 1, fuelType: 'liquid', thrustKN: 1000, dryMassT: 5, fuelMassT: 10, oxidMassT: 20, burnTime: 5, ofRatio: 2 }],
			targetApogeeKm: 400, targetPerigeeKm: 380, disableOrbitalCutoff: true, isHoldDown: false, isIgnited: true
		});
		assert.equal(rocket.flightComputer.flightTime, 0);
		assert.deepEqual([rocket.flightComputer.targetApogeeKm, rocket.flightComputer.targetPerigeeKm, rocket.flightComputer.disableOrbitalCutoff], [400, 380, true]);
	});
});

describe('Rev 6.10: non-object flight-profile rows from a corrupted save never reach the guidance loop', () => {
	it('FlightComputer: a null row right after the latched row does not throw', () => {
		const fc = new FlightComputer({ flightProfile: [
			{ type: 'time', value: 0, thrust: 100, angle: 0 },
			{ type: 'time', value: 10, thrust: 0, angle: 0 },
			null,
			{ type: 'alt', value: 9e9, thrust: 0, angle: 0 }
		] });
		fc.flightTime = 10;
		assert.doesNotThrow(() => fc._evaluateProfile({}));
		assert.equal(fc._highestStepIndex, 1);
		assert.equal(fc._profileState.throttle, 0);
	});

	it('the app path (RocketLauncher.loadState, RocketTab.loadState, rollout, Worker flight) drops the bad rows', () => {
		delete globalThis.document;
		setupMockDOM();
		const app = createAppPath({ vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km' });
		const clean = app.launcher.getState().flightProfile.concat([{ type: 'time', value: 1e5, thrust: 100, angle: 90, action: 'sep_payload' }]);
		const corrupted = [null, ...clean.slice(0, 3), 5, 'junk', ...clean.slice(3), undefined, true];
		const saveFile = JSON.parse(JSON.stringify({ ...app.launcher.getState(), flightProfile: corrupted })); // undefined -> null

		app.launcher.loadState(saveFile);
		assert.deepEqual(app.launcher.flightProfile, clean);
		const tab = new RocketTab(app.universe);
		assert.doesNotThrow(() => tab.loadState(saveFile));
		assert.deepEqual(app.launcher.flightProfile, clean);
		assert.equal(tab.ui.rlFlightProfileBody.children.length, clean.length);

		const { msg, calc } = app.rollout();
		assert.deepEqual(msg.flightProfile, clean);
		assert.deepEqual(calc.flightComputer.flightProfile, clean);
		assert.equal(calc.flightComputer.hasScheduledAction('sep_payload'), true);
		app.liftoff(calc);
		assert.doesNotThrow(() => {
			for (let i = 0; i < 400; i++) app.controller.engine._moveObjects(DT);
			app.sync();
		});
		assert.equal(calc.flightComputer.flightTime, 400 * DT);
		assert.equal(calc.collided, false);
	});

	// Gate 3 Iteration 1, Watchpoint 5: object rows without a finite value / thrust / angle passed the object filter and
	// commanded a NaN throttle, so a rocket whose plan was only `{ type: 'time', value: 0 }` never burned.
	it('object rows without finite value/thrust/angle are dropped too: the rocket burns instead of a NaN throttle', () => {
		const stage = { stageNumber: 1, fuelType: 'liquid', thrustKN: 1000, dryMassT: 5, fuelMassT: 100, oxidMassT: 200, burnTime: 50, ofRatio: 2 };
		const rocket = new CalcRocket(1, 'R', 0, 0, 0, 0, 0, 0, 2, 0, 5, 100, 200, {
			stages: [stage, { ...stage, stageNumber: 2 }], flightProfile: [{ type: 'time', value: 0 }],
			isHoldDown: false, isIgnited: true, autoControl: true, disableOrbitalCutoff: true
		});
		assert.deepEqual(rocket.flightComputer.flightProfile, []);
		for (let i = 1; i <= 3; i++) {
			rocket.flightControl(1.0);
			assert.equal(rocket.flightComputer.currentThrottle, 1, `step ${i}: empty plan = full throttle`);
			assert.equal(rocket.burnTime, 50 - i, `step ${i}: burning`);
		}

		delete globalThis.document;
		setupMockDOM();
		const app = createAppPath({ vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km' });
		const clean = app.launcher.getState().flightProfile;
		const incomplete = [{ type: 'time', value: 0 }, { type: 'alt', value: 0, thrust: '100', angle: 0 }, { type: 'alt', value: 1000, thrust: 100 }];
		const saveFile = JSON.parse(JSON.stringify({ ...app.launcher.getState(), flightProfile: [incomplete[0], ...clean.slice(0, 2), incomplete[1], ...clean.slice(2), incomplete[2]] }));
		app.launcher.loadState(saveFile);
		assert.deepEqual(app.launcher.flightProfile, clean);
		new RocketTab(app.universe).loadState(saveFile);
		assert.deepEqual(app.launcher.flightProfile, clean);
		const { calc } = app.rollout();
		assert.deepEqual(calc.flightComputer.flightProfile, clean);
	});
});
