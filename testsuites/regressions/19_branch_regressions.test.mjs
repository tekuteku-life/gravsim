/**
 * Regression Suite 19: defects this branch introduced or made worse, found by the last four read-only bug hunts
 * (docs/design/2026-11-21_architecture_redesign_inputs.md §3; the pre-existing ones go to the redesign) and fixed here
 * (design §4.14 of docs/design/2026-11-20_trajectory_fx_flightplan.md, proposed with this suite).
 *
 *  1. (H1-9) The prediction recorded PAYLOAD CUTOFF for a passive payload that a flight-plan row with action sep_payload
 *     separated during the upper-stage burn (§3.4-1): the separation step went from STG_BURNING to ORBITAL_COAST with
 *     the payload separated, which the predictor took for the payload's own engine stopping. A PAYLOAD CUTOFF needs the
 *     payload to have been burning: separated before the step, and burning in the step before.
 *  2. (H4-3) A self-propelled payload's own burn was never drawn: the payload-only paths of RocketRenderer (both levels of
 *     detail) returned before any plume. The plume is drawn behind the bus while the payload fires, with the fuel type
 *     of its propulsion and the one firing rule of every stage (isEngineFiring), in both levels of detail.
 *  3. (H1-6, branch part, and the same rule for the rest) The flight-event markers of the prediction passed early:
 *     payload_sep and the last stg_sep_N on ORBITAL_COAST, which a deferred payload separation enters at SECO (branch);
 *     and, as on main, PAYLOAD CUTOFF by the stage rule (at MECO-1) and every ignition event at SES-1. Each event is now
 *     passed by its own state (separation flag, stage index, ignition) or at its predicted time.
 *  4. (H3-17) The Rocket-tab sliders could not show the values the deep-space sizing (§3.4-3) and the presets produce
 *     (0.1 t, 1 kN, 0.01 t): 250 off-step values (32 on main). The sliders step by that resolution (and reach 0.8 t /
 *     85 kN), the handlers read decimals.
 *  5. (H3-18 part) SystemTab.loadState was left without a caller when ControlPanel.loadState was rewritten (the Rocket
 *     tab's deferral rule, §3.5-1): removed, so no loader can bypass that rule.
 *  6. (H2-4 / H4-4) After a load the Worker MET continues (§4.7), but the voice used the main thread's rocket.flightTime
 *     (restarted at 0: the T+1..5 count played again) and the relative altitude was re-based on the first frame after the
 *     load (the altitude callouts came hundreds of metres late). The voice follows the Worker MET (the HUD's), the relative
 *     altitude is the height above the pad (hostAltM + bottomOffsetM), the main clock is restored from the saved runtime
 *     state, a load marks what the loaded flight has passed, Reset forgets the flight, no second is voiced twice.
 *  7. (triage (a)) A rocket on the pad whose host is removed stood still in space: held rockets were never integrated
 *     (this branch); main integrated them. A held rocket is skipped only while it is pinned to a host that exists.
 *  8. A sep_* row (§3.4-1) that separates a burning stage: the step goes from that stage's STG_BURNING straight to the next
 *     state, so the prediction had no cutoff of that stage (MECO-N / SECO-1), recorded SECO-1 at the payload's own cutoff
 *     (the stage rule read the payload's ORBITAL_COAST, also for upper stages that never burned), no PAYLOAD START for a
 *     self-propelled payload lit in the separation step, and SES-2 for one lit from the interstage coast. The prediction
 *     now has the events the Worker flight of the same plan goes through, at its times.
 *  9. A sep_* row met on the pad (time 0, or alt / vel 0: the MET stays 0 in hold-down): the Worker executed it on the pad
 *     at rollout (stages jettisoned on the pad, the payload's or the next stage's engine lit while held), the predictor in
 *     its evaluation at liftoff, before the first step (no separation events). The action now runs in the first flight
 *     step after the release, in both.
 *
 * Expected values come from the design (§3.4-1 sep_payload, §3.4-3 sizing, §3.5-1, §4.7 continuation, §4.13-29 one
 * firing rule) and from data (index.html slider attributes, preset sizing, the launch-sequence audio profile, the
 * uninterrupted flight, the Worker's own state, the Worker flight of the same plan), never from the output of the code
 * under test.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMockDOM, createMockElement } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController, PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { GravSimObject } from '../../scripts/gravsim_object.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { SoundSequencer } from '../../scripts/gravsim_sound_sequencer.js';
import { SystemTab } from '../../scripts/gravsim_tab_system.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { presetManager, ROCKET_VISUAL } from '../../scripts/gravsim_preset_manager.js';
import {
	OBJECT_TYPES, OBJECT_STATE, SIMULATION, LAUNCH_SEQUENCES, TELEMETRY
} from '../../scripts/gravsim_const.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (file) => fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
/** Source without block and line comments (the comments name the history). */
const code = (file) => source(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 to 18
// ------------------------------------------------------------------
let activeBridge = null;
class PhysicsWorkerBridge {
	constructor(url) {
		this.isPhysics = String(url).includes('gravsim_calc.js');
		this.ctrl = this.isPhysics ? new SimulationController() : null;
		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
		if (this.isPhysics) { PhysicsWorkerBridge.last = this; }
	}

	postMessage(msg) {
		if (!this.isPhysics || this.terminated) { return; }
		const data = structuredClone(msg);
		const prev = activeBridge;
		activeBridge = this;
		try {
			this.ctrl.handleMessage({ data });
		} finally {
			activeBridge = prev;
		}
	}

	toMain(msg) {
		const data = structuredClone(msg);
		setImmediate(() => {
			if (!this.terminated && this.onmessage) { this.onmessage({ data }); }
		});
	}

	terminate() { this.terminated = true; }
}

const DT = 0.05;
const SUB_STEPS = 10;
const FRAME_S = DT * SUB_STEPS;
/** Fixed-step replica of SimulationController.update(), delivering each frame to the main thread synchronously. */
const stepFrames = (bridge, frames, stopWhen = null) => {
	const e = bridge.ctrl.engine;
	for (let f = 0; f < frames; f++) {
		e._categorizeBodies();
		e._buildQuadTree(FRAME_S);
		e._checkCollisions(FRAME_S);
		e._checkRocheLimit();
		for (let i = 0; i < SUB_STEPS; i++) { e._moveObjects(DT); }
		e._updateEscapeStatus();
		const buf = WorkerBridge.formatWorkerToMain(e.objects);
		bridge.onmessage({ data: { cmd: 'update', deltaTime: DT, subSteps: SUB_STEPS, objectsData: buf.buffer, validLength: buf.length } });
		e.removeDeadObjects();
		if (stopWhen && stopWhen()) { return true; }
	}
	return false;
};

let blobs = [];
/** A page load (the id counter starts at 0). `predict`: keep the real synchronous prediction of the launcher. */
const newUniverse = ({ predict = false } = {}) => {
	GravSimObject._idCounter = 0;
	const universe = new Universe(createMockElement('canvas'));
	const launcher = universe.RocketLauncher;
	if (!predict) {
		launcher.updatePredictionSync = () => null;
		launcher.updatePrediction = () => null;
	}
	launcher.requestPreviewUpdate = () => {};
	universe.updateUI(0);
	return { universe, bridge: PhysicsWorkerBridge.last };
};
const deployPlanet = (universe, name) => {
	EventBus.emit('object:deploy-orbit-sun', name);
	universe.updateUI(0);
	const obj = universe.objects.filter((o) => o.name === name && o.state === OBJECT_STATE.ACTIVE).pop();
	assert.ok(obj, `input: ${name} deployed`);
	return obj;
};
/** Rollout through the real RocketLauncher on a host, with an optional extra flight-plan row. */
const rollout = (universe, host, { vehicleId = 'h3_30', payloadId = 'earth_obs', missionId = 'leo_250km', extraRow = null } = {}) => {
	const launcher = universe.RocketLauncher;
	launcher.hostId = host.id;
	presetManager.applyToLauncher(launcher, { vehicleId, payloadId, missionId });
	if (extraRow) { launcher.flightProfile = [...launcher.flightProfile, extraRow]; }
	const before = new Set(universe.objects);
	launcher.rollout();
	const rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET && !before.has(o));
	assert.ok(rocket, 'input: rolled out');
	return rocket;
};
/** The LEGACY_QUICK command order of LaunchSequencer (without its clock). */
const launch = (universe, bridge, rocket) => {
	const seq = universe.LaunchSequencer;
	seq.rocketId = rocket.id;
	seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
	stepFrames(bridge, 2);
	seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
	stepFrames(bridge, 2);
	seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
};
const workerObj = (bridge, id) => bridge.ctrl.engine.objects.find((o) => o.id === id);
/** Save through SaveManager (with the Worker runtime snapshot) and return the file. */
const saveToJson = async (universe) => {
	blobs = [];
	await universe.SaveManager.save();
	assert.equal(blobs.length, 1, 'input: one save file written');
	return JSON.parse(await blobs[0].text());
};
const loadJson = (universe, json) => {
	const target = { files: [{ name: 'save.json', content: JSON.stringify(json) }], value: 'x' };
	universe.SaveManager.load({ target });
	assert.equal(target.value, '', 'input: load handled');
	universe.updateUI(0);
};
/** Record the payloads of an EventBus event until stop(). */
const record = (event) => {
	const seen = [];
	const listener = (...args) => seen.push(args.length > 1 ? args : args[0]);
	EventBus.on(event, listener);
	Object.defineProperty(seen, 'stop', { value: () => EventBus.off(event, listener), enumerable: false });
	return seen;
};
/** A recording 2D context: every call with its arguments. */
const recordingCtx = () => {
	const calls = [];
	const grad = { addColorStop: () => {} };
	const state = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, shadowColor: '', shadowBlur: 0 };
	const ctx = new Proxy(state, {
		get(t, k) {
			if (k in t) { return t[k]; }
			if (k === 'createLinearGradient' || k === 'createRadialGradient') { return (...args) => { calls.push({ fn: k, args }); return grad; }; }
			return (...args) => { calls.push({ fn: k, args, fillStyle: t.fillStyle }); };
		},
		set(t, k, v) { t[k] = v; return true; }
	});
	return { ctx, calls };
};
/** Call `fn` with RocketRenderer._drawPlume recorded (its arguments), and restore it. */
const withPlumeSpy = (fn) => {
	const plumes = [];
	const orig = RocketRenderer._drawPlume;
	RocketRenderer._drawPlume = function (...args) { plumes.push(args); return orig.apply(this, args); };
	try { fn(); } finally { RocketRenderer._drawPlume = orig; }
	return plumes;
};
const eventsById = (pred) => Object.fromEntries((pred?.events || []).map((e) => [e.id, e]));

describe('Regression 19: defects introduced or made worse by this branch (design §4.14)', () => {
	let origWorker;
	let hadSelf;
	let origSelf;
	let origCreate;
	let origRevoke;

	before(() => {
		origWorker = globalThis.Worker;
		hadSelf = Object.prototype.hasOwnProperty.call(globalThis, 'self');
		origSelf = globalThis.self;
		globalThis.Worker = PhysicsWorkerBridge;
		globalThis.self = { postMessage: (msg) => { activeBridge.toMain(msg); } };
		origCreate = URL.createObjectURL;
		origRevoke = URL.revokeObjectURL;
		URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
		URL.revokeObjectURL = () => {};
	});

	after(() => {
		globalThis.Worker = origWorker;
		if (hadSelf) { globalThis.self = origSelf; } else { delete globalThis.self; }
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevoke;
	});

	afterEach(() => {
		EventBus.clearAll();
		blobs = [];
	});

	// ==================================================================
	// 1. (H1-9) The prediction's PAYLOAD CUTOFF is the payload's own engine stopping
	// ==================================================================
	describe('1. (H1-9) the prediction records PAYLOAD CUTOFF only for a payload that burned its own engine', () => {
		/** The flight-plan row of §3.4-1 that separates the payload at a time (the upper stage still burns before SECO). */
		const sepRow = (t) => ({ type: 'time', value: t, thrust: 100, angle: 90, action: 'sep_payload' });
		/** The launcher's synchronous prediction (the app path: ObjectPlacer -> PresetManager.applyToLauncher -> updatePredictionSync). */
		const predict = ({ vehicleId = 'h3_30', payloadId = 'earth_obs', missionId = 'iss_rendezvous', rows = [] } = {}) => {
			const { universe } = newUniverse({ predict: true });
			const earth = deployPlanet(universe, 'Earth');
			const L = universe.RocketLauncher;
			L.hostId = earth.id;
			presetManager.applyToLauncher(L, { vehicleId, payloadId, missionId });
			L.flightProfile = [...L.flightProfile, ...rows];
			const pred = L.updatePredictionSync();
			assert.ok(pred && Array.isArray(pred.events) && pred.events.length > 0, 'input: a prediction with events');
			return { ev: eventsById(pred), L };
		};
		/** The time of the first step at or after a time trigger: within one prediction step (at most 1 s near the host). */
		const atRow = (ev, t, what) => assert.ok(ev && ev.time >= t && ev.time < t + 1, `${what} at the row's ${t} s (got ${ev?.time})`);

		it('normal: a passive payload separated by sep_payload during the upper-stage burn has PAYLOAD SEP, 2-STG-SEP and SECO-1 there, and no PAYLOAD CUTOFF or START', () => {
			const { ev, L } = predict({ payloadId: 'earth_obs', rows: [sepRow(500)] });
			assert.equal(Boolean(L.payload?.propulsion?.enabled), false, 'input: a passive payload (no engine)');
			atRow(ev.payload_sep, 500, 'PAYLOAD SEP');
			atRow(ev.stg_sep_2, 500, '2-STG-SEP');
			atRow(ev.seco_1, 500, 'SECO-1 (the separation ends the upper-stage burn)');
			assert.equal(ev.payload_cutoff, undefined, 'no PAYLOAD CUTOFF: the payload has no engine');
			assert.equal(ev.payload_start, undefined, 'no PAYLOAD START');
		});

		it('normal: a passive payload of the default plan (separated after SECO by the staging) has neither event (unchanged)', () => {
			const { ev } = predict({ payloadId: 'earth_obs' });
			assert.ok(ev.payload_sep && ev.seco_1 && ev.seco_1.time <= ev.payload_sep.time, 'input: SECO, then the separation');
			assert.equal(ev.payload_cutoff, undefined);
			assert.equal(ev.payload_start, undefined);
		});

		it('normal: a self-propelled payload of the default plan keeps PAYLOAD START and PAYLOAD CUTOFF, in flight order (unchanged)', () => {
			const { ev, L } = predict({ payloadId: 'htv_x' });
			assert.equal(Boolean(L.payload?.propulsion?.enabled), true, 'input: HTV-X has its own engine');
			assert.ok(ev.payload_sep && ev.payload_start && ev.payload_cutoff, 'all three events');
			assert.ok(ev.payload_sep.time <= ev.payload_start.time && ev.payload_start.time <= ev.payload_cutoff.time, 'separation, start, cutoff');
		});

		it('normal: a self-propelled payload separated during the upper-stage burn burns on: its PAYLOAD CUTOFF comes after the separation, within its burn time, when the flight\'s payload stops', () => {
			const row = sepRow(500);
			const { ev, L } = predict({ payloadId: 'htv_x', rows: [row] });
			atRow(ev.payload_sep, 500, 'PAYLOAD SEP');
			assert.ok(ev.payload_cutoff, 'PAYLOAD CUTOFF of the payload\'s own burn');
			const burnS = L.payload.propulsion.burnTime;
			assert.ok(ev.payload_cutoff.time > ev.payload_sep.time && ev.payload_cutoff.time <= ev.payload_sep.time + burnS + 1,
				`after the separation, within the payload burn time ${burnS} s (got ${ev.payload_cutoff.time} s)`);
			// The same plan flown by the Worker: the payload's engine stops (ORBITAL_COAST or out of burn time after burning)
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'iss_rendezvous', extraRow: row });
			launch(universe, bridge, rocket);
			let burned = false;
			let stopAt = null;
			stepFrames(bridge, 3000, () => {
				const w = workerObj(bridge, rocket.id);
				if (!w) { return true; }
				if (w.isPayloadSeparated && w.stageState === 'STG_BURNING') { burned = true; }
				if (burned && w.isPayloadSeparated && (w.stageState === 'ORBITAL_COAST' || w.burnTime <= 0)) {
					stopAt = w.flightComputer.flightTime;
					return true;
				}
				return false;
			});
			assert.ok(stopAt !== null, 'input: the flight\'s payload burned and stopped');
			assert.ok(Math.abs(stopAt - ev.payload_cutoff.time) <= 2, `the predicted cutoff ${ev.payload_cutoff.time} s is the flight's ${stopAt} s (within 2 s)`);
		});

		it('boundary: a separation deferred past SECO (ORBITAL_COAST, §3.4-1): no cutoff for the passive payload; START then CUTOFF for the self-propelled one', () => {
			const passive = predict({ payloadId: 'earth_obs', rows: [sepRow(2000)] }).ev;
			atRow(passive.payload_sep, 2000, 'PAYLOAD SEP (deferred)');
			assert.ok(passive.seco_1 && passive.seco_1.time < 2000, 'input: SECO before the row');
			assert.equal(passive.payload_cutoff, undefined);
			const own = predict({ payloadId: 'htv_x', rows: [sepRow(2000)] }).ev;
			atRow(own.payload_sep, 2000, 'PAYLOAD SEP (deferred)');
			assert.ok(own.payload_start && own.payload_cutoff, 'the payload\'s own burn after the separation');
			assert.ok(own.payload_sep.time <= own.payload_start.time && own.payload_start.time <= own.payload_cutoff.time);
		});

		it('boundary: a single-stage vehicle (the only stage is the upper stage) separating a passive payload during its burn: no PAYLOAD CUTOFF', () => {
			const { ev, L } = predict({ vehicleId: 'ssto', payloadId: 'earth_obs', missionId: 'leo_250km', rows: [sepRow(100)] });
			assert.equal(L.stages.length, 1, 'input: one stage');
			atRow(ev.payload_sep, 100, 'PAYLOAD SEP');
			assert.equal(ev.payload_cutoff, undefined);
		});

		it('abnormal: a sep_payload row at t = 0 (it fires in the first step, §4.14-9) and a repeated row: the passive payload never gets a PAYLOAD CUTOFF', () => {
			const first = predict({ payloadId: 'earth_obs', rows: [sepRow(0)] }).ev;
			assert.ok(first.payload_sep && first.payload_sep.time < 1, `input: the payload is separated from the first step (${first.payload_sep?.time})`);
			assert.equal(first.payload_cutoff, undefined, 'no PAYLOAD CUTOFF');
			assert.equal(first.payload_start, undefined, 'no PAYLOAD START');
			const twice = predict({ payloadId: 'earth_obs', rows: [sepRow(500), sepRow(600)] }).ev;
			atRow(twice.payload_sep, 500, 'PAYLOAD SEP (the first row)');
			assert.equal(twice.payload_cutoff, undefined, 'none for the repeated row');
		});
	});

	// ==================================================================
	// 2. (H4-3) The self-propelled payload's own burn is drawn
	// ==================================================================
	describe('2. (H4-3) a self-propelled payload firing its engine is drawn with a plume behind the bus, in both levels of detail', () => {
		const HIGH_R = 40;
		const LOW_R = 2;
		/** A separated payload of a 2-stage vehicle (main-thread fields as ObjectManager synchronises them). */
		const payloadRocket = (over = {}) => ({
			thrustAngle: 0, colorTheme: 'classic', isInternalPower: false, disableStaging: false,
			isPayloadSeparated: true, hasPayloadPropulsion: true, isIgnited: true, burnTime: 120, thrustRatio: 1.0, ambientPresRatio: 0,
			currentStageIndex: 2, totalStages: 2, stages: [{ fuelType: 'hydro' }, { fuelType: 'hydro' }],
			payload: { name: 'P', propulsion: { enabled: true, fuelType: 'liquid' } },
			telemetry: { stageIndex: 2, totalStages: 2, isPayloadSeparated: true, twr: 0 },
			...over
		});
		/** The plumes drawn by each level of detail: high = _drawPlume calls, low = the plume triangle (moveTo / lineTo). */
		const drawBoth = (rocket) => {
			const high = recordingCtx();
			const highPlumes = withPlumeSpy(() => RocketRenderer.draw(high.ctx, rocket, 0, 0, HIGH_R, 1));
			const low = recordingCtx();
			const lowPlumes = withPlumeSpy(() => RocketRenderer.draw(low.ctx, rocket, 0, 0, LOW_R, 1));
			const triangle = low.calls.filter((c) => c.fn === 'moveTo' || c.fn === 'lineTo');
			return { highPlumes, lowPlumes, triangle, lowCalls: low.calls };
		};

		it('input: the two radii are on the two sides of the LOD threshold', () => {
			assert.ok(HIGH_R >= ROCKET_VISUAL.LOD_RADIUS_THRESHOLD && LOW_R < ROCKET_VISUAL.LOD_RADIUS_THRESHOLD);
		});

		it('normal (high detail): one plume at the aft face of the bus, with the fuel type of the payload\'s propulsion (not the stages\'), its throttle and the payload plume scale', () => {
			const { highPlumes } = drawBoth(payloadRocket({ thrustRatio: 0.8 }));
			assert.equal(highPlumes.length, 1, 'one plume');
			const [, x, y, scale, throttle, fuelType, R] = highPlumes[0];
			const m = ROCKET_VISUAL.MODULES;
			const payloadR = HIGH_R * m.STAGE2_RADIUS_RATIO; // a 2-stage vehicle's payload is drawn at the stage-2 radius (§3.2-3)
			assert.equal(x, -0.5 * payloadR * m.SATELLITE_BUS_W_RATIO, 'at the aft face (-x) of the bus');
			assert.equal(y, 0, 'on the axis');
			assert.equal(scale, ROCKET_VISUAL.ALIGNMENT.PAYLOAD_PLUME_SCALE, 'the payload plume scale');
			assert.equal(ROCKET_VISUAL.ALIGNMENT.PAYLOAD_PLUME_SCALE, 0.35, 'design §4.14-2 (presets/visuals/rocket.json)');
			assert.equal(throttle, 0.8, 'the throttle');
			assert.equal(fuelType, 'liquid', 'payload.propulsion.fuelType');
			assert.equal(R, HIGH_R);
		});

		it('normal (low detail): a plume triangle from the aft face of the icon, on the axis, in the plume colour, its length in proportion to the throttle', () => {
			const lod = ROCKET_VISUAL.LOW_DETAIL;
			const iconHalfW = 0.5 * LOW_R * lod.SATELLITE_BUS_W_RATIO;
			const full = drawBoth(payloadRocket({ thrustRatio: 1.0 }));
			assert.equal(full.lowPlumes.length, 0, 'no high-detail plume in low detail');
			const [base1, tip, base2] = full.triangle.map((c) => c.args);
			assert.deepEqual([full.triangle.map((c) => c.fn)], [['moveTo', 'lineTo', 'lineTo']]);
			assert.equal(base1[0], -iconHalfW, 'base at the aft face');
			assert.equal(base2[0], -iconHalfW);
			assert.equal(base1[1], -base2[1], 'symmetric about the axis');
			assert.ok(base2[1] > 0);
			assert.equal(tip[1], 0, 'tip on the axis');
			assert.ok(tip[0] < -iconHalfW, 'tip behind the bus');
			const fill = full.lowCalls.filter((c) => c.fn === 'fill').pop();
			assert.equal(fill.fillStyle, lod.PLUME_COLOR, 'the plume colour');
			const half = drawBoth(payloadRocket({ thrustRatio: 0.5 }));
			const lenFull = -iconHalfW - tip[0];
			const lenHalf = -iconHalfW - half.triangle[1].args[0];
			assert.ok(Math.abs(lenHalf - 0.5 * lenFull) < 1e-12, `half throttle, half length (${lenHalf} vs ${lenFull})`);
		});

		it('normal (low detail): the plume is the stages\' triangle at PAYLOAD_PLUME_SCALE times its length (§4.14-2): R x PLUME_LEN_RATIO x PAYLOAD_PLUME_SCALE x throttle x (1 + e_vac x 0.15); a stage\'s plume has no such scale', () => {
			// Expected lengths from the design and the visual preset file, not from the renderer: the stage triangle of the
			// low detail is R x PLUME_LEN_RATIO x throttle x (1 + e_vac x 0.15) (e_vac = 1 - ambient pressure ratio: 1 in
			// vacuum, 0 at sea level; unchanged from main), and the payload's is that times PAYLOAD_PLUME_SCALE
			const visual = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', 'visuals', 'rocket.json'), 'utf8'));
			const lenRatio = visual.LOW_DETAIL.PLUME_LEN_RATIO;
			const payloadScale = visual.ALIGNMENT.PAYLOAD_PLUME_SCALE;
			assert.deepEqual([lenRatio, payloadScale], [2.8, 0.35], 'input: presets/visuals/rocket.json');
			assert.deepEqual([ROCKET_VISUAL.LOW_DETAIL.PLUME_LEN_RATIO, ROCKET_VISUAL.ALIGNMENT.PAYLOAD_PLUME_SCALE], [lenRatio, payloadScale], 'input: the loaded preset');
			/** Length of a drawn plume triangle [base, tip, base]: from the base (aft face) back to the tip, along -x. */
			const lengthOf = (triangle) => {
				assert.deepEqual(triangle.map((c) => c.fn), ['moveTo', 'lineTo', 'lineTo'], 'one plume triangle');
				return triangle[0].args[0] - triangle[1].args[0];
			};
			const near = (got, want, what) => assert.ok(Math.abs(got - want) <= 1e-12 * want, `${what}: length ${got}, expected ${want}`);
			for (const [ambientPresRatio, eVac] of [[0, 1], [1, 0]]) for (const throttle of [1.0, 0.8, 0.25]) {
				const what = `ambient ${ambientPresRatio}, throttle ${throttle}`;
				const stageLen = LOW_R * lenRatio * throttle * (1 + eVac * 0.15);
				const payload = drawBoth(payloadRocket({ thrustRatio: throttle, ambientPresRatio }));
				near(lengthOf(payload.triangle), stageLen * payloadScale, `payload, ${what}`);
				// The upper stage of the same vehicle with the payload attached, firing on the same flags: not scaled
				const stage = drawBoth(payloadRocket({
					thrustRatio: throttle, ambientPresRatio, isPayloadSeparated: false, currentStageIndex: 1,
					telemetry: { stageIndex: 1, totalStages: 2, isPayloadSeparated: false, twr: 0 }
				}));
				near(lengthOf(stage.triangle), stageLen, `upper stage, ${what}`);
			}
			// The first stage too (another base position, the same plume length)
			const first = drawBoth(payloadRocket({
				ambientPresRatio: 0, isPayloadSeparated: false, currentStageIndex: 0,
				telemetry: { stageIndex: 0, totalStages: 2, isPayloadSeparated: false, twr: 0 }
			}));
			near(lengthOf(first.triangle), LOW_R * lenRatio * 1.15, 'first stage, vacuum, full throttle');
		});

		it('normal: before the first Worker frame after a load hasPayloadPropulsion may be unset: payload.propulsion.enabled makes it self-propelled (the rule of Rocket.mass)', () => {
			const { highPlumes, triangle } = drawBoth(payloadRocket({ hasPayloadPropulsion: false }));
			assert.equal(highPlumes.length, 1);
			assert.equal(triangle.length, 3);
		});

		it('abnormal: a passive payload, an engine not ignited, no burn time or no throttle draw no plume in either level', () => {
			const passive = { hasPayloadPropulsion: false, payload: { name: 'P', propulsion: { enabled: false } } };
			for (const [what, over] of [['passive', passive], ['passive (no propulsion)', { hasPayloadPropulsion: false, payload: { name: 'P' } }],
				['not ignited', { isIgnited: false }], ['burn time 0', { burnTime: 0 }], ['burn time NaN', { burnTime: NaN }],
				['throttle 0', { thrustRatio: 0 }], ['throttle undefined', { thrustRatio: undefined }]]) {
				const { highPlumes, triangle } = drawBoth(payloadRocket(over));
				assert.equal(highPlumes.length, 0, `${what}: no high-detail plume`);
				assert.equal(triangle.length, 0, `${what}: no low-detail plume`);
			}
		});

		it('abnormal: the plume fuel type is liquid when the propulsion names none or not a string; another fuel type is used as named', () => {
			for (const [fuelType, expected] of [[undefined, 'liquid'], ['', 'liquid'], [123, 'liquid'], [null, 'liquid'], ['hydro', 'hydro'], ['solid', 'solid']]) {
				const { highPlumes } = drawBoth(payloadRocket({ payload: { name: 'P', propulsion: { enabled: true, fuelType } } }));
				assert.equal(highPlumes[0][5], expected, `fuelType ${String(fuelType)}`);
			}
		});

		it('boundary: the plume threshold of the stages (THRUST_THRESHOLD): throttle at it draws none, just above draws one; the TWR alternative counts as for a stage', () => {
			const th = ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD;
			assert.equal(th, 0.01, 'input: the threshold');
			assert.equal(drawBoth(payloadRocket({ thrustRatio: th })).highPlumes.length, 0, 'at the threshold');
			assert.equal(drawBoth(payloadRocket({ thrustRatio: th })).triangle.length, 0);
			assert.equal(drawBoth(payloadRocket({ thrustRatio: th + 1e-6 })).highPlumes.length, 1, 'just above');
			assert.equal(drawBoth(payloadRocket({ thrustRatio: th + 1e-6 })).triangle.length, 3);
			const twr = payloadRocket({ thrustRatio: 0, telemetry: { stageIndex: 2, totalStages: 2, isPayloadSeparated: true, twr: 0.02 } });
			assert.equal(drawBoth(twr).highPlumes.length, 1, 'TWR above the threshold');
		});

		it('one rule: in both levels a plume is drawn exactly when isPayloadEngineFiring (payload) / isEngineFiring (stage) holds', () => {
			const states = [];
			for (const isIgnited of [true, false]) for (const burnTime of [0, 50]) for (const thrustRatio of [0, 0.01, 0.5]) for (const own of [true, false]) {
				states.push({ isIgnited, burnTime, thrustRatio, hasPayloadPropulsion: own, payload: { name: 'P', propulsion: { enabled: own, fuelType: 'liquid' } } });
			}
			for (const s of states) {
				const r = payloadRocket(s);
				const expected = Boolean(s.isIgnited && s.burnTime > 0 && s.thrustRatio > 0.01 && s.hasPayloadPropulsion);
				assert.equal(RocketRenderer.isPayloadEngineFiring(r), expected, JSON.stringify(s));
				const { highPlumes, triangle } = drawBoth(r);
				assert.equal(highPlumes.length === 1, expected, `high ${JSON.stringify(s)}`);
				assert.equal(triangle.length === 3, expected, `low ${JSON.stringify(s)}`);
				// The same flags on the upper stage (payload attached): its plume follows the same rule
				const stage = payloadRocket({ ...s, isPayloadSeparated: false, currentStageIndex: 1, telemetry: { stageIndex: 1, totalStages: 2, isPayloadSeparated: false, twr: 0 } });
				const stageExpected = Boolean(s.isIgnited && s.burnTime > 0 && s.thrustRatio > 0.01);
				assert.equal(RocketRenderer.isEngineFiring(stage), stageExpected);
				const st = drawBoth(stage);
				assert.equal(st.highPlumes.length === 1, stageExpected, `stage high ${JSON.stringify(s)}`);
				assert.equal(st.triangle.length === 3, stageExpected, `stage low ${JSON.stringify(s)}`);
			}
		});

		it('real path: MMX on its Mars transfer (H3-24): every frame its own engine burns in the Worker draws a plume in both levels; none after the burn', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_24', payloadId: 'mmx', missionId: 'mars_transfer' });
			launch(universe, bridge, rocket);
			let burning = 0;
			let drawn = 0;
			let after = 0;
			let afterDrawn = 0;
			stepFrames(bridge, 3000, () => {
				const w = workerObj(bridge, rocket.id);
				if (!w) { return true; }
				// The Worker's own rule of the payload's burn (CalcRocket: isPayloadBurning, thrust applied)
				const isBurning = w.isPayloadSeparated && w.hasPayloadPropulsion && w.stageState === 'STG_BURNING' && w._thrustRatio > 0.01;
				if (!w.isPayloadSeparated) { return false; }
				const { highPlumes, triangle } = drawBoth(rocket);
				if (isBurning) {
					burning++;
					if (highPlumes.length === 1 && triangle.length === 3) { drawn++; }
					return false;
				}
				if (burning > 0) {
					after++;
					if (highPlumes.length > 0 || triangle.length > 0) { afterDrawn++; }
				}
				return after >= 20;
			});
			assert.ok(burning > 100, `input: the payload burned in ${burning} frames`);
			assert.equal(drawn, burning, 'a plume in both levels in every burning frame');
			assert.ok(after >= 20, 'input: frames after the burn');
			assert.equal(afterDrawn, 0, 'no plume after the burn');
		});
	});

	// ==================================================================
	// 3. (H1-6) Each flight-event marker passes by its own event
	// ==================================================================
	describe('3. (H1-6) the flight-event markers pass when their own event happens (or at its predicted time), not by a state shortcut', () => {
		/** A flying rocket with a prediction holding `events`, in the given state (main-thread fields). */
		const flying = (events, over = {}) => ({
			isHoldDown: false, state: OBJECT_STATE.ACTIVE, isDestroyed: false, hostId: null,
			currentStageIndex: 0, totalStages: 2, isPayloadSeparated: false, isIgnited: true, stageState: 'STG_BURNING',
			burnTime: 100, fuelMass: 10, isBoosterBurnout: false, isBoosterSeparated: false,
			predictedTrajectory: { events: events.map((e) => ({ ...e })) },
			passedEventIds: new Set(),
			telemetry: { status: TELEMETRY.STATUS.ASCENT, altM: 200000, vV: 100, flightTime: 10 },
			...over
		});
		/** Set the state and evaluate once: the ids passed so far. */
		const step = (rocket, state = {}, telemetry = {}) => {
			Object.assign(rocket, state);
			Object.assign(rocket.telemetry, telemetry);
			TrajectoryPredictor.updateRocketFlightEvents(rocket, null);
			return rocket.passedEventIds;
		};

		it('normal (branch part): a deferred payload separation enters ORBITAL_COAST at SECO; PAYLOAD SEP and the last stage separation pass only at the separation', () => {
			const r = flying([{ id: 'payload_sep', type: 'staging', time: 1200 }, { id: 'stg_sep_2', type: 'staging', time: 1200 }, { id: 'stg_sep_1', type: 'staging', time: 260 }],
				{ currentStageIndex: 1 });
			let passed = step(r, { stageState: 'ORBITAL_COAST', burnTime: 0, isIgnited: false }, { flightTime: 700, status: TELEMETRY.STATUS.MECO });
			assert.equal(passed.has('stg_sep_1'), true, 'input: the stage-1 separation is behind (stage index 1)');
			assert.equal(passed.has('payload_sep'), false, 'PAYLOAD SEP not at SECO (ORBITAL_COAST, payload attached)');
			assert.equal(passed.has('stg_sep_2'), false, '2-STG-SEP not at SECO');
			passed = step(r, {}, { flightTime: 1100 });
			assert.equal(passed.has('payload_sep'), false, 'still attached');
			passed = step(r, { isPayloadSeparated: true, currentStageIndex: 2 }, { flightTime: 1150 });
			assert.equal(passed.has('payload_sep'), true, 'at the separation (before the predicted time)');
			assert.equal(passed.has('stg_sep_2'), true);
		});

		it('boundary: with the payload attached, the predicted time passes them (just before: not yet)', () => {
			const r = flying([{ id: 'payload_sep', type: 'staging', time: 1200 }, { id: 'stg_sep_2', type: 'staging', time: 1200 }],
				{ currentStageIndex: 1, stageState: 'ORBITAL_COAST' });
			assert.equal(step(r, {}, { flightTime: 1199.999 }).size, 0, 'just before the predicted time');
			assert.deepEqual([...step(r, {}, { flightTime: 1200 })].sort(), ['payload_sep', 'stg_sep_2'], 'at the predicted time');
		});

		it('normal (as on main, same per-event rule): SES-2 of a 3-stage vehicle is not passed at SES-1, but at the stage-3 ignition', () => {
			const r = flying([{ id: 'ses_1', type: 'ignition', time: 116 }, { id: 'ses_2', type: 'ignition', time: 252 }], { totalStages: 3, currentStageIndex: 0 });
			let passed = step(r, { currentStageIndex: 1, isIgnited: false, stageState: 'INTERSTAGE_COAST' }, { flightTime: 115 });
			assert.equal(passed.size, 0, 'interstage coast: no ignition yet');
			passed = step(r, { isIgnited: true, stageState: 'STG_BURNING' }, { flightTime: 116.5 });
			assert.deepEqual([...passed], ['ses_1'], 'SES-1 at the stage-2 ignition, SES-2 not');
			passed = step(r, { currentStageIndex: 2, isIgnited: false, stageState: 'INTERSTAGE_COAST' }, { flightTime: 250 });
			assert.equal(passed.has('ses_2'), false, 'stage 3 not ignited yet');
			passed = step(r, { isIgnited: true, stageState: 'STG_BURNING' }, { flightTime: 251 });
			assert.equal(passed.has('ses_2'), true, 'at the stage-3 ignition');
		});

		it('normal (as on main): PAYLOAD START and PAYLOAD CUTOFF pass at the payload\'s own ignition and cutoff, not at MECO-1, the stage separation or SES-1', () => {
			const r = flying([{ id: 'payload_start', type: 'ignition', time: 906.8 }, { id: 'payload_cutoff', type: 'meco', name: 'PAYLOAD CUTOFF', time: 1100 }]);
			let passed = step(r, { stageState: 'STG_MECO', burnTime: 0, isIgnited: false }, { flightTime: 290, status: TELEMETRY.STATUS.MECO });
			assert.equal(passed.size, 0, 'MECO-1');
			passed = step(r, { currentStageIndex: 1, stageState: 'STG_BURNING', burnTime: 300, isIgnited: true }, { flightTime: 306, status: TELEMETRY.STATUS.ASCENT });
			assert.equal(passed.size, 0, 'SES-1 (an ignition after the first stage)');
			passed = step(r, { stageState: 'STG_MECO', burnTime: 0, isIgnited: false }, { flightTime: 900, status: TELEMETRY.STATUS.MECO });
			assert.equal(passed.size, 0, 'SECO');
			passed = step(r, { isPayloadSeparated: true, currentStageIndex: 2, stageState: 'STG_COAST', burnTime: 200, isIgnited: false }, { flightTime: 905 });
			assert.equal(passed.size, 0, 'separated, the payload\'s engine not yet ignited');
			passed = step(r, { stageState: 'STG_BURNING', isIgnited: true }, { flightTime: 906 });
			assert.deepEqual([...passed], ['payload_start'], 'PAYLOAD START at its ignition (before the predicted time)');
			passed = step(r, { burnTime: 50 }, { flightTime: 1000 });
			assert.equal(passed.has('payload_cutoff'), false, 'burning');
			passed = step(r, { stageState: 'ORBITAL_COAST', burnTime: 0, isIgnited: false }, { flightTime: 1050 });
			assert.equal(passed.has('payload_cutoff'), true, 'PAYLOAD CUTOFF at its cutoff');
		});

		it('boundary: PAYLOAD CUTOFF by the end of the burn time (0, the predictor\'s rule) while still STG_BURNING; and a commanded coast with burn time left is not a cutoff', () => {
			const ev = [{ id: 'payload_cutoff', type: 'meco', name: 'PAYLOAD CUTOFF', time: 5000 }];
			const coast = flying(ev, { isPayloadSeparated: true, currentStageIndex: 2 });
			assert.equal(step(coast, { stageState: 'STG_COAST', burnTime: 20, isIgnited: false }, { flightTime: 1000 }).size, 0, 'a coast with burn time left');
			assert.equal(step(coast, { stageState: 'STG_BURNING', burnTime: 0 }, { flightTime: 1001 }).has('payload_cutoff'), true, 'burn time 0');
		});

		it('normal: REIGNITION of a stage is not passed during its first burn; it passes once the stage is left (or the payload separated) or at its predicted time', () => {
			const ev = [{ id: 'reignition_2', type: 'ignition', time: 800 }];
			const r = flying(ev, { currentStageIndex: 1 });
			assert.equal(step(r, { isIgnited: true }, { flightTime: 300 }).size, 0, 'the first burn of stage 2 (index 1)');
			assert.equal(step(r, { stageState: 'STG_COAST', isIgnited: false }, { flightTime: 600 }).size, 0, 'its coast');
			assert.equal(step(r, { isPayloadSeparated: true, currentStageIndex: 2 }, { flightTime: 700 }).has('reignition_2'), true, 'the stage is gone');
			const t = flying(ev, { currentStageIndex: 1 });
			assert.equal(step(t, {}, { flightTime: 799.9 }).size, 0);
			assert.equal(step(t, {}, { flightTime: 800 }).has('reignition_2'), true, 'at the predicted time');
		});

		it('abnormal: an event without a time is passed by its state only; an id without a stage number and a stage index that is not a number pass nothing early', () => {
			const r = flying([{ id: 'ses_x', type: 'ignition' }, { id: 'ses_1', type: 'ignition' }, { id: 'payload_sep', type: 'staging' }],
				{ currentStageIndex: 'junk', isIgnited: true });
			let passed = step(r, {}, { flightTime: 1e9 });
			assert.equal(passed.size, 0, 'no time and no state: nothing (a non-numeric stage index reads 0)');
			passed = step(r, { currentStageIndex: 1 }, { flightTime: 1e9 });
			assert.deepEqual([...passed], ['ses_1'], 'ses_1 by its stage; ses_x never by state');
			passed = step(r, { isPayloadSeparated: true }, {});
			assert.equal(passed.has('payload_sep'), true);
			assert.equal(passed.has('ses_x'), false);
		});

		it('real path: the deferred separation of §3.4-1 (ISS plan + a row at 1200 s): the markers PAYLOAD SEP and 2-STG-SEP pass at the frame the Worker separates the payload, not at SECO', () => {
			const { universe: pu } = newUniverse({ predict: true });
			const pe = deployPlanet(pu, 'Earth');
			const row = { type: 'time', value: 1200, thrust: 0, angle: 90, action: 'sep_payload' };
			pu.RocketLauncher.hostId = pe.id;
			presetManager.applyToLauncher(pu.RocketLauncher, { vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'iss_rendezvous' });
			pu.RocketLauncher.flightProfile = [...pu.RocketLauncher.flightProfile, row];
			const prediction = pu.RocketLauncher.updatePredictionSync();
			assert.ok(eventsById(prediction).payload_sep, 'input: the prediction has PAYLOAD SEP');
			EventBus.clearAll();
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'iss_rendezvous', extraRow: row });
			rocket.predictedTrajectory = JSON.parse(JSON.stringify(prediction));
			rocket.passedEventIds = new Set();
			launch(universe, bridge, rocket);
			const objectsMap = new Map(universe.objects.map((o) => [o.id, o]));
			const passedAt = {};
			let coastAt = null;
			let sepAt = null;
			stepFrames(bridge, 3000, () => {
				const t = rocket.telemetry.flightTime;
				TrajectoryPredictor.updateRocketFlightEvents(rocket, { objectsMap });
				for (const id of rocket.passedEventIds) { if (passedAt[id] === undefined) { passedAt[id] = t; } }
				const w = workerObj(bridge, rocket.id);
				if (w.stageState === 'ORBITAL_COAST' && coastAt === null) { coastAt = t; }
				if (w.isPayloadSeparated && sepAt === null) { sepAt = t; }
				return sepAt !== null;
			});
			assert.ok(coastAt !== null && coastAt < 1100, `input: ORBITAL_COAST from SECO (${coastAt} s)`);
			assert.ok(sepAt >= 1200 && sepAt < 1201, `input: the Worker separates at the row (${sepAt} s)`);
			const predSep = eventsById(prediction).payload_sep.time;
			for (const id of ['payload_sep', 'stg_sep_2']) {
				assert.ok(passedAt[id] !== undefined && passedAt[id] <= sepAt && passedAt[id] >= Math.min(sepAt, predSep) - FRAME_S,
					`${id} passed at the separation ${sepAt} s or its predicted time ${predSep} s (got ${passedAt[id]} s), not at SECO ${coastAt} s`);
			}
		});
	});

	// ==================================================================
	// 4. (H3-17) The Rocket-tab sliders represent every sized and preset value
	// ==================================================================
	describe('4. (H3-17) every Rocket-tab slider can hold the values of every vehicle x payload x mission (index.html range and step)', () => {
		const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
		/** min / max / step of a range input of index.html. */
		const slider = (id) => {
			const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
			assert.ok(tag, `input: #${id} in index.html`);
			const attr = (a) => { const m = tag[0].match(new RegExp(`\\s${a}="([^"]*)"`)); return m ? m[1] : null; };
			assert.equal(attr('type'), 'range', `#${id} is a range input`);
			return { id, min: Number(attr('min')), max: Number(attr('max')), step: Number(attr('step') ?? 1), value: Number(attr('value')) };
		};
		/** On the step grid from min (decimal steps: compared in units of the step, to 1e-6 of a step). */
		const onStep = (v, s) => Math.abs((v - s.min) / s.step - Math.round((v - s.min) / s.step)) < 1e-6;
		const S = {
			fuel: slider('rl-fuel-mass'), oxid: slider('rl-oxid-mass'), dry: slider('rl-launch-mass'), thrust: slider('rl-launch-thrust'),
			sep: slider('rl-sep-delay'), ign: slider('rl-ign-delay'), payloadMass: slider('rl-payload-mass'),
			fairingMass: slider('rl-fairing-mass'), fairingAlt: slider('rl-fairing-alt'), pFuel: slider('rl-payload-fuel'), pOxid: slider('rl-payload-oxid')
		};
		/** Every value each slider shows for each combination (RocketTab writes them; sep / ign delay default 2.0 s). */
		const valuesOf = () => {
			const out = [];
			for (const v of presetManager.getVehicles()) for (const p of presetManager.getPayloads()) for (const m of presetManager.getMissions()) {
				const rl = { currentVehicleId: v.id };
				presetManager.applyToLauncher(rl, { vehicleId: v.id, payloadId: p.id, missionId: m.id });
				const at = `${v.id}/${p.id}/${m.id}`;
				rl.stages.forEach((s, i) => {
					out.push(['fuel', s.fuelMassT, `${at} stage ${i + 1}`], ['oxid', s.oxidMassT, `${at} stage ${i + 1}`], ['dry', s.dryMassT, `${at} stage ${i + 1}`],
						['thrust', s.thrustKN, `${at} stage ${i + 1}`], ['sep', s.separationDelaySec ?? 2.0, `${at} stage ${i + 1}`], ['ign', s.ignitionDelaySec ?? 2.0, `${at} stage ${i + 1}`]);
				});
				out.push(['payloadMass', rl.payload.massT, at], ['fairingMass', rl.fairing.massT, at], ['fairingAlt', rl.fairing.separationAltKm, at]);
				if (rl.payload.propulsion?.enabled) {
					out.push(['pFuel', rl.payload.propulsion.fuelMassT, at], ['pOxid', rl.payload.propulsion.oxidMassT, at]);
				}
			}
			return out;
		};

		it('input: 6 vehicles x 6 payloads x 7 missions, every slider value a finite number', () => {
			assert.deepEqual([presetManager.getVehicles().length, presetManager.getPayloads().length, presetManager.getMissions().length], [6, 6, 7]);
			const values = valuesOf();
			assert.ok(values.length > 3000, `${values.length} values`);
			assert.deepEqual(values.filter(([, v]) => !Number.isFinite(v)), []);
		});

		it('the range and step of the 7 sliders of §4.14-4 are the design\'s (index.html min / max / step)', () => {
			// Design §4.14-4: #rl-fuel-mass / #rl-oxid-mass by 0.1 t; #rl-launch-mass 0.1 to 500 t by 0.1 t; #rl-launch-thrust
			// from 1 kN by 1 kN, its maximum the one of §3.4-4 (the base 10000 kN of max(10000, ceil(thrustKN)), raised at run
			// time); #rl-payload-mass, #rl-payload-fuel and #rl-payload-oxid by 0.01 t. The ranges §4.14-4 leaves as they
			// were (main's index.html): the propellant 0 to 1500 t / 0 to 3000 t (the tank caps of the §3.4-3 sizing,
			// maxByTank), the payload mass 0 to 100 t, its propellant 0 to 10 t / 0 to 20 t
			const DESIGN = {
				'rl-fuel-mass': { min: 0, max: 1500, step: 0.1 },
				'rl-oxid-mass': { min: 0, max: 3000, step: 0.1 },
				'rl-launch-mass': { min: 0.1, max: 500, step: 0.1 },
				'rl-launch-thrust': { min: 1, max: 10000, step: 1 },
				'rl-payload-mass': { min: 0, max: 100, step: 0.01 },
				'rl-payload-fuel': { min: 0, max: 10, step: 0.01 },
				'rl-payload-oxid': { min: 0, max: 20, step: 0.01 }
			};
			assert.deepEqual([S.fuel.id, S.oxid.id, S.dry.id, S.thrust.id, S.payloadMass.id, S.pFuel.id, S.pOxid.id].sort(), Object.keys(DESIGN).sort(),
				'input: the 7 sliders are the ones the other tests of this section read');
			for (const [id, want] of Object.entries(DESIGN)) {
				const { min, max, step } = slider(id);
				assert.deepEqual({ min, max, step }, want, `#${id}`);
			}
		});

		it('normal: every value lies in the slider range (the thrust maximum rises to the stage thrust, §3.4-4) and on its step', () => {
			const bad = [];
			for (const [k, v, at] of valuesOf()) {
				const s = S[k];
				const max = k === 'thrust' ? Math.max(s.max, Math.ceil(v)) : s.max;
				if (v < s.min || v > max) { bad.push(`${at} ${k}=${v} outside [${s.min}, ${max}]`); } else if (!onStep(v, s)) { bad.push(`${at} ${k}=${v} off the step ${s.step}`); }
			}
			assert.deepEqual(bad, []);
		});

		it('boundary: the deep-space sizing\'s 0.1 t, 1 kN and 0.01 t values, the smallest stage (Epsilon stage 3: 0.8 t dry, 85 kN) and each initial value are on their slider', () => {
			const rl = { currentVehicleId: 'h3_30' };
			presetManager.applyToLauncher(rl, { vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'mars_transfer' });
			const upper = rl.stages[1];
			assert.deepEqual([upper.fuelMassT, upper.oxidMassT, upper.thrustKN], [15.1, 90.8, 1113], 'input: the sized upper stage (§3.4-3)');
			assert.ok(onStep(15.1, S.fuel) && onStep(90.8, S.oxid) && onStep(1113, S.thrust));
			const eps = { currentVehicleId: 'epsilon' };
			presetManager.applyToLauncher(eps, { vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km' });
			assert.deepEqual([eps.stages[2].dryMassT, eps.stages[2].thrustKN], [0.8, 85], 'input: Epsilon stage 3');
			assert.ok(S.dry.min <= 0.8 && onStep(0.8, S.dry), `dry min ${S.dry.min}`);
			assert.ok(S.thrust.min <= 85 && onStep(85, S.thrust), `thrust min ${S.thrust.min}`);
			for (const s of Object.values(S)) { assert.ok(s.value >= s.min && s.value <= s.max && onStep(s.value, s), `#${s.id} initial value ${s.value}`); }
		});

		it('boundary (usable): each changed slider steps by the resolution the values need, no finer: a 10 times coarser step would leave some value off it', () => {
			const values = valuesOf();
			for (const k of ['fuel', 'oxid', 'dry', 'thrust', 'payloadMass', 'pFuel', 'pOxid']) {
				const s = S[k];
				const coarser = { ...s, step: s.step * 10 };
				assert.ok(values.some(([kk, v]) => kk === k && !onStep(v, coarser)), `${k}: step ${s.step} is needed`);
				assert.ok((s.max - s.min) / s.step <= 30000, `${k}: ${(s.max - s.min) / s.step} positions`);
			}
		});

		it('normal: the stage and payload handlers keep the decimals a slider gives (no integer rounding); the propellant that follows the O/F ratio is rounded to the 0.1 t step', () => {
			const { universe } = newUniverse();
			const tab = universe.ControlPanel.rocketTab;
			const rl = universe.RocketLauncher;
			presetManager.applyToLauncher(rl, { vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'mars_transfer' });
			tab.selectTab(1);
			const stg = rl.stages[1];
			const of = presetManager.getFuel(stg.fuelType).ofRatio;
			assert.equal(of, 6, 'input: the hydrogen O/F ratio of presets/fuels');
			const input = (el, value) => el.dispatchEvent({ type: 'input', target: { value } });
			input(tab.ui.rlFuelMass, '15.2');
			assert.deepEqual([stg.fuelMassT, stg.oxidMassT, String(tab.ui.rlFuelMassVal.textContent)], [15.2, 91.2, '15.2'], 'fuel 15.2 t, oxidizer 15.2 x 6');
			input(tab.ui.rlOxidMass, '90.8');
			assert.deepEqual([stg.oxidMassT, stg.fuelMassT], [90.8, 15.1], 'oxidizer 90.8 t, fuel 90.8 / 6 = 15.13 -> 15.1 t');
			input(tab.ui.rlLaunchMass, '0.8');
			assert.equal(stg.dryMassT, 0.8);
			input(tab.ui.rlLaunchThrust, '1112');
			assert.equal(stg.thrustKN, 1112);
			input(tab.ui.rlPayloadMass, '4.93');
			assert.deepEqual([rl.payload.massT, tab.ui.rlPayloadMassVal.textContent], [4.93, '4.93'], 'payload mass to 0.01 t, label too');
			input(tab.ui.rlFuelMass, '0.1');
			assert.deepEqual([stg.fuelMassT, stg.oxidMassT], [0.1, 0.6], 'boundary: one step');
			input(tab.ui.rlFuelMass, '0');
			assert.deepEqual([stg.fuelMassT, stg.oxidMassT], [0, 0], 'boundary: the minimum');
		});

		it('RocketTab.roundToSliderStep rounds to the decimal of the step (as the sizing rounds), not to step multiples with a binary error', () => {
			assert.equal(RocketTab.roundToSliderStep(15.1 * 6, 0.1), 90.6);
			assert.equal(RocketTab.roundToSliderStep(0.1 + 0.2, 0.1), 0.3);
			assert.equal(RocketTab.roundToSliderStep(90.8 / 6, 0.1), 15.1);
			assert.equal(RocketTab.roundToSliderStep(1112.6, 1), 1113);
			assert.equal(RocketTab.roundToSliderStep(0.014, 0.01), 0.01);
			assert.equal(RocketTab.roundToSliderStep(-0.26, 0.1), -0.3);
			assert.equal(RocketTab.roundToSliderStep(0, 0.1), 0);
		});
	});

	// ==================================================================
	// 5. (H3-18 part) SystemTab.loadState is gone: ControlPanel.loadState is the one loader of the System-tab view
	// ==================================================================
	describe('5. (H3-18) the System-tab view of a save is loaded only by ControlPanel.loadState (SystemTab.loadState removed)', () => {
		const el = (id) => document.getElementById(id);

		it('normal: SystemTab has no loadState and no script calls one on a System tab', () => {
			assert.equal(typeof SystemTab.prototype.loadState, 'undefined', 'SystemTab.loadState removed');
			for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter((x) => x.endsWith('.js'))) {
				assert.doesNotMatch(code(f), /systemTab\s*\.\s*loadState\s*\(/i, `${f}: no call of a SystemTab loader`);
			}
		});

		it('normal: ControlPanel.loadState validates the saved view with SystemTab.normalizeViewState and applies it, or defers it while the Rocket tab is open (§3.5-1)', () => {
			const body = code('gravsim_control_panel.js');
			const start = body.indexOf('loadState(cpState, rlState)');
			assert.ok(start > 0, 'input: ControlPanel.loadState');
			const method = body.slice(start, body.indexOf('\n\t}\n', start));
			assert.match(method, /this\.systemTab\.normalizeViewState\(/);
			assert.match(method, /this\.rocketTab\.deferViewState\(view\)/);
			assert.match(method, /this\.systemTab\.applyViewState\(view\)/);
			const { universe } = newUniverse();
			universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: -2.2, zoomScaleVal: 5.5 } }, null);
			assert.equal(universe.timeScale, Math.pow(10, -2.2), 'the saved time scale applied (the tab is closed)');
			assert.equal(universe.camera.targetZoomExp, 5.5, 'the saved zoom applied');
			assert.equal(Number(el('time-scale').value), -2.2);
		});

		it('abnormal / boundary: invalid saved values keep the view; with the Rocket tab open the view waits for its close', () => {
			const { universe } = newUniverse();
			universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: -2.2, zoomScaleVal: 5.5 } }, null);
			universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: 'fast', zoomScaleVal: null } }, null);
			assert.deepEqual([universe.timeScale, universe.camera.targetZoomExp], [Math.pow(10, -2.2), 5.5], 'invalid values change nothing');
			const tab = universe.ControlPanel.rocketTab;
			const btn = createMockElement('button');
			btn.setAttribute('data-target', 'tab-rocket');
			universe.ControlPanel._tabBtnClick({ target: btn });
			assert.equal(tab.isOpened, true, 'input: the Rocket tab is open');
			const openScale = universe.timeScale;
			universe.ControlPanel.loadState({ controlPanel: { timeScaleVal: -1.5, zoomScaleVal: 4 } }, null);
			assert.equal(universe.timeScale, openScale, 'deferred while the tab is open');
			const sys = createMockElement('button');
			sys.setAttribute('data-target', 'tab-sys');
			universe.ControlPanel._tabBtnClick({ target: sys });
			assert.equal(universe.timeScale, Math.pow(10, -1.5), 'applied when the tab closes');
		});
	});

	// ==================================================================
	// 6. (H2-4 / H4-4) The voice and the relative altitude continue with the loaded flight
	// ==================================================================
	describe('6. (H2-4 / H4-4) after a load the voice follows the continued Worker MET and the relative altitude stays the height above the pad', () => {
		const QUICK = LAUNCH_SEQUENCES.LEGACY_QUICK;
		/** One main-loop update at the time scale of a launch sequence and one Worker frame (both FRAME_S). */
		const tick = (bridge, n) => { for (let i = 0; i < n; i++) { EventBus.emitUpdate(FRAME_S * 1000, FRAME_S); stepFrames(bridge, 1); } };
		/** Quick launch of HTV-X on H3-30 (ISS plan), flown to T+12.5 s; the voice recorded with the HUD MET of its target. */
		const quickFlight = () => {
			const { universe, bridge } = newUniverse();
			universe.SoundEffects.update = () => {}; // the synthesis is not under test (the mock AudioContext has no filters)
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth, { vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
			const voice = [];
			EventBus.on('audio:play', (k) => {
				const target = universe.objects.find((o) => o.id === universe.TelemetryPanel.targetId);
				voice.push({ k, met: target?.telemetry?.flightTime ?? null });
			});
			universe.RocketLauncher.ignite('LEGACY_QUICK');
			tick(bridge, 2 * (QUICK.tMinusOffset + 12) + 1);
			assert.equal(universe.LaunchSequencer.isActive, false, 'input: the countdown sequence has ended (T+10 s)');
			return { universe, bridge, rocket, voice };
		};
		const padAlt = (r) => r.hostAltM + r.bottomOffsetM;
		const isTimeKey = (k) => Object.values(QUICK.audioProfile.times).includes(k);

		it('normal: a same-session save and load at T+12.5 s: the voice after the load is that of the uninterrupted flight (no T+1..5 again), the main clock and the relative altitude continue', async () => {
			// The uninterrupted flight
			const A = quickFlight();
			const savedMet = A.rocket.telemetry.flightTime;
			assert.ok(savedMet > 12 && savedMet < 13.5, `input: T+${savedMet} s`);
			const beforeA = A.voice.length;
			tick(A.bridge, 80);
			const controlAfter = A.voice.slice(beforeA);
			assert.ok(controlAfter.length >= 2 && controlAfter.every((v) => !isTimeKey(v.k)), `input: callouts of the uninterrupted flight after T+12.5 s: ${controlAfter.map((v) => v.k)}`);
			EventBus.clearAll();

			// The same flight saved and loaded at T+12.5 s
			const B = quickFlight();
			assert.deepEqual(B.voice.map((v) => v.k), A.voice.slice(0, beforeA).map((v) => v.k), 'input: the same voice up to the save');
			const relBefore = B.rocket.telemetry.relativeAltM;
			assert.ok(relBefore > 150, `input: ${relBefore} m above the pad`);
			const saved = await saveToJson(B.universe);
			const savedRocket = saved.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
			const savedFcMet = savedRocket.runtimeState.flightComputer.flightTime;
			loadJson(B.universe, saved);
			const loaded = B.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.notEqual(loaded, B.rocket, 'input: a new rocket object');
			assert.equal(loaded.flightTime, savedFcMet, 'the main thread\'s clock continues at the saved flight time (before any frame)');
			const voiceAt = B.voice.length;
			tick(B.bridge, 1);
			assert.ok(loaded.telemetry.flightTime > savedFcMet, 'input: the Worker MET continues');
			assert.equal(loaded.telemetry.relativeAltM, Math.max(0, loaded.telemetry.altM - padAlt(loaded)), 'the height above the pad');
			assert.ok(loaded.telemetry.relativeAltM >= relBefore, `continues from ${relBefore} m (got ${loaded.telemetry.relativeAltM} m), not from 0`);
			tick(B.bridge, 79);
			const afterLoad = B.voice.slice(voiceAt);
			assert.deepEqual(afterLoad.map((v) => v.k), controlAfter.map((v) => v.k), 'the callouts of the uninterrupted flight');
			afterLoad.forEach((v, i) => assert.ok(Math.abs(v.met - controlAfter[i].met) <= FRAME_S + 1e-9, `${v.k} at T+${v.met} s (uninterrupted T+${controlAfter[i].met} s)`));
		});

		it('normal: a flight saved at T+12.5 s loaded into a session whose own flight is at T+60 s: the loaded flight\'s callouts play as in its uninterrupted flight (the session flight\'s once-only flags and seconds do not carry over)', async () => {
			// The saved flight and its uninterrupted continuation (the control)
			const B = quickFlight();
			const saved = await saveToJson(B.universe);
			const beforeB = B.voice.length;
			tick(B.bridge, 80);
			const controlAfter = B.voice.slice(beforeB);
			assert.ok(controlAfter.some((v) => v.k === 'fl_pitch_roll') && controlAfter.some((v) => v.k === 'fl_traj_nominal'), `input: ${controlAfter.map((v) => v.k)}`);
			EventBus.clearAll();
			// Another session, its own flight at T+60 s (pitch, downrange and T+45 callouts already played)
			const A = quickFlight();
			tick(A.bridge, 2 * 48);
			assert.ok(['fl_pitch_roll', 'fl_pitch_downrange', 'fl_traj_nominal'].every((k) => A.voice.some((v) => v.k === k)), `input: the session flight played them: ${A.voice.map((v) => v.k)}`);
			loadJson(A.universe, saved);
			const at = A.voice.length;
			tick(A.bridge, 80);
			const afterLoad = A.voice.slice(at);
			assert.deepEqual(afterLoad.map((v) => v.k), controlAfter.map((v) => v.k), 'the loaded flight\'s own callouts');
			afterLoad.forEach((v, i) => assert.ok(Math.abs(v.met - controlAfter[i].met) <= FRAME_S + 1e-9, `${v.k} at T+${v.met} s (uninterrupted T+${controlAfter[i].met} s)`));
		});

		it('abnormal: a save without the Worker runtime state (degraded, §4.7): the Worker clock restarts at 0, and the main clock and the voice clock with it', async () => {
			const B = quickFlight();
			const saved = await saveToJson(B.universe);
			const r = saved.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
			delete r.runtimeState;
			r.restoredRuntimeState = false;
			loadJson(B.universe, saved);
			const loaded = B.universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.equal(loaded.flightTime, 0, 'nothing to restore: 0');
			tick(B.bridge, 3);
			const fc = workerObj(B.bridge, loaded.id).flightComputer.flightTime;
			assert.ok(fc > 0 && fc < 2, `input: the Worker clock restarted (${fc} s)`);
			assert.equal(B.universe.SoundSequencer._calculateCurrentMET(), loaded.telemetry.flightTime, 'the voice clock is the HUD MET');
			assert.equal(loaded.telemetry.relativeAltM, Math.max(0, loaded.telemetry.altM - padAlt(loaded)), 'still the height above the pad');
		});

		it('boundary: a rocket loaded on the pad (hold-down): relative altitude 0, and no T+ voice while the main clock runs on the pad', async () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			rollout(universe, earth, { vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'iss_rendezvous' });
			stepFrames(bridge, 2);
			const saved = await saveToJson(universe);
			loadJson(universe, saved);
			const loaded = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			universe.TelemetryPanel.targetId = loaded.id;
			universe.SoundSequencer.audioProfile = JSON.parse(JSON.stringify(QUICK.audioProfile));
			const voice = record('audio:play');
			tick(bridge, 20);
			voice.stop();
			assert.equal(loaded.isHoldDown, true, 'input: held on the pad');
			assert.ok(loaded.flightTime > 5, `input: the main clock runs on the pad (${loaded.flightTime} s)`);
			assert.equal(loaded.telemetry.flightTime, 0, 'input: the Worker MET is 0 until liftoff');
			assert.ok(Math.abs(loaded.telemetry.relativeAltM) < 1e-6, `0 m above the pad (${loaded.telemetry.relativeAltM})`);
			assert.deepEqual(voice, [], 'no voice on the pad');
		});

		it('ObjectManager.padAltitudeM: hostAltM + bottomOffsetM for a rocket on a host (id 0 included); null without a host or with values that are not finite numbers', () => {
			assert.equal(ObjectManager.padAltitudeM({ hostId: 3, hostAltM: 10, bottomOffsetM: 195.3 }), 10 + 195.3);
			assert.equal(ObjectManager.padAltitudeM({ hostId: 0, hostAltM: 0, bottomOffsetM: 89.7 }), 89.7, 'id 0 is an object id (§4.13-24); altitude 0');
			for (const r of [null, undefined, {}, { hostId: null, hostAltM: 10, bottomOffsetM: 1 }, { hostId: undefined, hostAltM: 10, bottomOffsetM: 1 },
				{ hostId: 1, hostAltM: NaN, bottomOffsetM: 1 }, { hostId: 1, hostAltM: 10, bottomOffsetM: Infinity }, { hostId: 1, hostAltM: '10', bottomOffsetM: 1 },
				{ hostId: 1, hostAltM: 10 }]) {
				assert.equal(ObjectManager.padAltitudeM(r), null, JSON.stringify(r));
			}
		});

		it('real path: on the pad the first frame reads 0 m above the pad (the Worker holds the rocket at hostAltM + bottomOffsetM, within 1e-6 m)', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			for (const vehicleId of ['h3_30', 'epsilon', 'ssto']) {
				const rocket = rollout(universe, earth, { vehicleId, payloadId: 'earth_obs', missionId: 'leo_250km' });
				stepFrames(bridge, 1);
				assert.ok(Math.abs(rocket.telemetry.altM - padAlt(rocket)) < 1e-6, `${vehicleId}: the Worker's pad altitude ${rocket.telemetry.altM} m = ${padAlt(rocket)} m`);
				assert.ok(rocket.telemetry.relativeAltM < 1e-6, `${vehicleId}: relative altitude ${rocket.telemetry.relativeAltM}`);
				universe.RocketLauncher.abortRollout();
				stepFrames(bridge, 1);
			}
		});

		it('the main clock of a load takes the FlightComputer\'s restored flight time with its validation (§4.7: [0, 1e10] s, not a number 0), as the Worker does', async () => {
			const B = quickFlight();
			const saved = await saveToJson(B.universe);
			const cases = [[undefined, null], [123.4, 123.4], [0, 0], [-5, 0], [1e12, SIMULATION.RUNTIME_RESTORE_MAX_TIME_S], ['x', 0], [null, 0], [NaN, 0]];
			for (const [met, expected] of cases) {
				EventBus.clearAll();
				const json = JSON.parse(JSON.stringify(saved));
				const r = json.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
				const want = met === undefined ? r.runtimeState.flightComputer.flightTime : expected;
				if (met !== undefined) { r.runtimeState.flightComputer.flightTime = met; }
				const { universe, bridge } = newUniverse();
				loadJson(universe, json);
				const loaded = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
				assert.equal(loaded.flightTime, want, `saved ${String(met)}: main clock`);
				assert.equal(workerObj(bridge, loaded.id).flightComputer.flightTime, want, `saved ${String(met)}: the Worker's`);
			}
			for (const mutate of [(r) => { r.restoredRuntimeState = false; }, (r) => { r.runtimeState.flightComputer = 7; }, (r) => { delete r.runtimeState; }]) {
				EventBus.clearAll();
				const json = JSON.parse(JSON.stringify(saved));
				mutate(json.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET));
				const { universe, bridge } = newUniverse();
				loadJson(universe, json);
				const loaded = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
				assert.equal(loaded.flightTime, 0, 'no runtime state to restore');
				assert.equal(workerObj(bridge, loaded.id).flightComputer.flightTime, 0, 'the Worker\'s too');
			}
		});

		describe('SoundSequencer', () => {
			/** A sequencer on a minimal universe: a target rocket with telemetry and a launch sequencer. */
			const setup = (telemetry = {}, over = {}) => {
				const rocket = { id: 7, type: OBJECT_TYPES.ROCKET, state: OBJECT_STATE.ACTIVE, flightTime: 0, telemetry: { flightTime: 0, status: TELEMETRY.STATUS.ASCENT, ...telemetry }, ...over };
				const universe = { objects: [rocket], TelemetryPanel: { targetId: 7 }, LaunchSequencer: { isActive: false, timer: 0, tMinusOffset: 0 } };
				const seq = new SoundSequencer(universe);
				const voice = record('audio:play');
				return { seq, rocket, universe, voice };
			};

			it('normal: the T+ clock is the Worker MET (telemetry.flightTime), not the main thread\'s rocket.flightTime', () => {
				const { seq, rocket } = setup({ flightTime: 7.25 }, { flightTime: 0 });
				assert.equal(seq._calculateCurrentMET(), 7.25);
				rocket.telemetry.flightTime = 0;
				rocket.flightTime = 30;
				assert.equal(seq._calculateCurrentMET(), null, 'on the pad (Worker MET 0) no T+ clock, whatever the main clock');
			});

			it('abnormal: a MET that is not a finite positive number (a numeric string or another type included), a missing telemetry or target give no clock', () => {
				// Design §4.14-6 (a): the MET is used only when it is a finite positive number. A value of another type is
				// not converted: a numeric string is not a MET, as it is not a status (§4.13-21); Number() would take '12',
				// ' 12 ', true, [12] and new Number(12) for 12, 1, 12, 12
				for (const flightTime of [NaN, -1, 0, -0, -Infinity, Infinity, '12', ' 12 ', '1e3', '', true, [12], new Number(12), 12n, null, undefined]) {
					const { seq } = setup({ flightTime });
					assert.equal(seq._calculateCurrentMET(), null, `MET ${typeof flightTime} ${String(flightTime)}`);
				}
				// The valid numbers are used as they are (the smallest positive one included)
				for (const flightTime of [Number.MIN_VALUE, 1e-9, 0.5, 12, SIMULATION.RUNTIME_RESTORE_MAX_TIME_S]) {
					const { seq } = setup({ flightTime });
					assert.equal(seq._calculateCurrentMET(), flightTime, `MET ${flightTime}`);
				}
				const { seq, rocket, universe } = setup({ flightTime: 5 });
				delete rocket.telemetry;
				assert.equal(seq._calculateCurrentMET(), null, 'no telemetry');
				universe.TelemetryPanel.targetId = null;
				assert.equal(seq._calculateCurrentMET(), null, 'no target');
			});

			it('boundary: at the end of the countdown the clock steps back to the Worker MET (a frame behind): the T+10 s voice of the full countdown plays once', () => {
				const FULL = LAUNCH_SEQUENCES.FULL_COUNTDOWN;
				assert.equal(FULL.audioProfile.times['10'], 'num_10', 'input: the profile voices T+10 s');
				const { seq, rocket, universe, voice } = setup();
				seq.audioProfile = JSON.parse(JSON.stringify(FULL.audioProfile));
				const LS = universe.LaunchSequencer;
				LS.isActive = true;
				LS.tMinusOffset = FULL.tMinusOffset;
				for (const t of [9.9, 10.01]) { LS.timer = t + FULL.tMinusOffset; seq.update(); }
				LS.isActive = false; // the sequence ended (T > LAUNCH_TO_COMPLETION_TIME)
				for (const met of [9.98, 10.02, 10.5, 11.2]) { rocket.telemetry.flightTime = met; rocket.flightTime = met; seq.update(); }
				assert.equal(voice.filter((k) => k === 'num_10').length, 1, `T+10 voiced once: ${voice.join(' ')}`);
			});

			it('normal: after a load the first MET marks what the flight has passed: once-only callouts that hold are not voiced, later ones are; no second up to it is voiced', () => {
				const { seq, rocket, voice } = setup({ flightTime: 3, relativeAltM: 0 });
				seq.audioProfile = { ...JSON.parse(JSON.stringify(QUICK.audioProfile)), times: { ...QUICK.audioProfile.times, '13': 't13', '14': 't14' } };
				seq.conditionFlags = { meco: true, seco: true }; // flags of the earlier flight
				seq.previousMET = 2.5;
				seq.resyncAfterLoad();
				assert.deepEqual(seq.conditionFlags, {}, 'the earlier flight\'s flags are cleared');
				Object.assign(rocket.telemetry, { flightTime: 13.0, relativeAltM: 250 });
				seq.update();
				assert.deepEqual(voice, [], 'the first MET after the load voices nothing');
				assert.equal(seq.conditionFlags.tower_clear, true, 'tower clear (relative altitude > 120 m) is behind');
				assert.equal(seq.conditionFlags.pitch_roll, undefined, 'pitch and roll (> 500 m) is not');
				assert.equal(seq.conditionFlags.meco, undefined, 'MECO of the earlier flight is not taken over');
				Object.assign(rocket.telemetry, { flightTime: 14.2, relativeAltM: 600 });
				seq.update();
				assert.deepEqual(voice, ['t14', 'fl_pitch_roll'], 'T+14 s and pitch-and-roll, nothing replayed');
			});

			it('abnormal / boundary: after a load with no target or a MET of 0 (on the pad) the marking waits for the first valid MET', () => {
				const { seq, rocket, universe, voice } = setup({ flightTime: 0, relativeAltM: 300 });
				seq.audioProfile = JSON.parse(JSON.stringify(QUICK.audioProfile));
				seq.resyncAfterLoad();
				universe.TelemetryPanel.targetId = null;
				seq.update();
				assert.equal(seq.isResyncPending, true, 'no target: still pending');
				universe.TelemetryPanel.targetId = 7;
				seq.update();
				assert.equal(seq.isResyncPending, true, 'MET 0 (on the pad): still pending');
				rocket.telemetry.flightTime = 40;
				seq.update();
				assert.equal(seq.isResyncPending, false);
				assert.deepEqual(voice, [], 'nothing voiced at the first MET');
				assert.equal(seq.conditionFlags.tower_clear, true);
				assert.equal(seq.lastTimeKeySecond, 40);
			});

			it('normal: Reset forgets the flight (profile, once-only flags, clock); the end of the countdown keeps them for the flight\'s callouts', () => {
				const { seq } = setup({ flightTime: 50 });
				seq.audioProfile = JSON.parse(JSON.stringify(QUICK.audioProfile));
				seq.conditionFlags = { tower_clear: true };
				seq.previousMET = 50;
				EventBus.emit('sequencer-end');
				assert.equal(seq.audioProfile.conditions.length, QUICK.audioProfile.conditions.length, 'kept at the end of the countdown');
				assert.deepEqual(seq.conditionFlags, { tower_clear: true });
				EventBus.emit('simulation:reset');
				assert.deepEqual(seq.audioProfile, { events: {}, times: {}, conditions: [] }, 'Reset: no profile');
				assert.deepEqual(seq.conditionFlags, {});
				assert.equal(seq.previousMET, null);
				assert.equal(seq.lastTimeKeySecond, null);
			});
		});
	});

	// ==================================================================
	// 7. (triage (a)) A rocket in hold-down whose host is gone is a free body
	// ==================================================================
	describe('7. (triage (a)) a rocket on the pad of a removed host is integrated again (main), not frozen in space', () => {
		it('normal: on its host the held rocket is pinned to the pad (host + (R + bottomOffsetM + hostAltM) at hostAngleRad)', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth);
			stepFrames(bridge, 5);
			const w = workerObj(bridge, rocket.id);
			const h = workerObj(bridge, earth.id);
			const r = h.radius + w.bottomOffsetM + w.hostAltM;
			assert.equal(w.isHoldDown, true, 'input: held');
			assert.equal(w.x, h.x + r * Math.cos(w.hostAngleRad));
			assert.equal(w.y, h.y + r * Math.sin(w.hostAngleRad));
		});

		it('regression: the host removed (as System › Clear Selected does), the held rocket moves on with its velocity under gravity', () => {
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			const rocket = rollout(universe, earth);
			stepFrames(bridge, 3);
			universe.removeObject(earth);
			stepFrames(bridge, 1);
			const w = workerObj(bridge, rocket.id);
			assert.equal(workerObj(bridge, earth.id), undefined, 'input: the host is gone from the Worker');
			assert.equal(w.isHoldDown, true, 'input: still in hold-down');
			const p0 = { x: w.x, y: w.y };
			const v = Math.hypot(w.vx, w.vy);
			assert.ok(v > 25000, `input: the orbital velocity of the pad (${v} m/s)`);
			const N = 10;
			stepFrames(bridge, N);
			const moved = Math.hypot(w.x - p0.x, w.y - p0.y);
			const expected = v * N * FRAME_S; // the Sun's gravity changes the speed by about 6e-3 m/s^2 here: < 1e-4 of it
			assert.ok(Math.abs(moved - expected) / expected < 1e-3, `moved ${moved} m in ${N * FRAME_S} s (free body: ${expected} m)`);
		});

		it('PhysicsEngine._getHoldDownHost: the host of a held rocket while it exists (id 0 too); null for a rocket not held, without a host id, whose host is gone, or for another object', () => {
			const engine = new PhysicsEngine();
			const host = { id: 0, type: OBJECT_TYPES.CELESTIAL };
			const held = { id: 1, type: OBJECT_TYPES.ROCKET, isHoldDown: true, hostId: 0 };
			engine.objects = [host, held];
			assert.equal(engine._getHoldDownHost(held), host, 'host id 0');
			assert.equal(engine._getHoldDownHost({ ...held, isHoldDown: false }), null, 'released');
			assert.equal(engine._getHoldDownHost({ ...held, hostId: null }), null, 'no host id');
			assert.equal(engine._getHoldDownHost({ ...held, hostId: 9 }), null, 'host gone');
			assert.equal(engine._getHoldDownHost({ ...held, type: OBJECT_TYPES.DEBRIS }), null, 'not a rocket');
		});
	});

	// ==================================================================
	// 8 and 9 share the Worker flight of a plan and its prediction
	// ==================================================================
	/** A flight-plan row (design §3.4-1). */
	const planRow = (value, action, { type = 'time', thrust = 100, angle = 90 } = {}) => ({ type, value, thrust, angle, action });
	/** The presets of the plan on the launcher, and its rows: the mission's plus `rows`, or `rows` alone (`replace`). */
	const applyPlan = (L, host, { vehicleId = 'h3_30', payloadId = 'htv_x', missionId = 'iss_rendezvous', rows = [], replace = false }) => {
		L.hostId = host.id;
		presetManager.applyToLauncher(L, { vehicleId, payloadId, missionId });
		L.flightProfile = replace ? rows.map((r) => ({ ...r })) : [...L.flightProfile, ...rows];
	};
	/** The launcher's synchronous prediction of the plan (the app path). */
	const predictPlan = (plan) => {
		const { universe } = newUniverse({ predict: true });
		const earth = deployPlanet(universe, 'Earth');
		const L = universe.RocketLauncher;
		applyPlan(L, earth, plan);
		const pred = L.updatePredictionSync();
		assert.ok(pred && Array.isArray(pred.events) && pred.events.length > 0, 'input: a prediction with events');
		return pred;
	};
	/** Frames of the Worker as stepFrames does, calling onSub() after every sub-step (true stops). */
	const stepSubSteps = (bridge, frames, onSub) => {
		const e = bridge.ctrl.engine;
		for (let f = 0; f < frames; f++) {
			e._categorizeBodies();
			e._buildQuadTree(FRAME_S);
			e._checkCollisions(FRAME_S);
			e._checkRocheLimit();
			for (let i = 0; i < SUB_STEPS; i++) {
				e._moveObjects(DT);
				if (onSub()) { return true; }
			}
			e._updateEscapeStatus();
			const buf = WorkerBridge.formatWorkerToMain(e.objects);
			bridge.onmessage({ data: { cmd: 'update', deltaTime: DT, subSteps: SUB_STEPS, objectsData: buf.buffer, validLength: buf.length } });
			e.removeDeadObjects();
		}
		return false;
	};
	/** The staging state of the Worker rocket (t: its MET). */
	const snapOf = (w) => ({
		t: w.flightComputer.flightTime, hold: Boolean(w.isHoldDown), st: w.stageState, idx: w.currentStageIndex, pay: Boolean(w.isPayloadSeparated),
		ign: Boolean(w.isIgnited), bt: w.burnTime, fair: Boolean(w.fairing?.isSeparated), bsep: Boolean(w.isBoosterSeparated), bout: Boolean(w.isBoosterBurnout)
	});
	/**
	 * The same plan flown by the Worker: rolled out through the launcher, launched with the LEGACY_QUICK commands (1 s of
	 * engine on the pad between MAIN ENGINE START and LIFTOFF), for `seconds` of MET or until it is destroyed. The state
	 * after every sub-step from rollout, and after each command (the state the command sets: LIFTOFF is STG_BURNING at MET 0).
	 */
	const flyPlan = (plan, seconds, { beforeLaunch = null } = {}) => {
		const { universe, bridge } = newUniverse();
		const earth = deployPlanet(universe, 'Earth');
		const L = universe.RocketLauncher;
		applyPlan(L, earth, plan);
		const before = new Set(universe.objects);
		L.rollout();
		let rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET && !before.has(o));
		assert.ok(rocket, 'input: rolled out');
		const snaps = [];
		const debrisOnPad = [];
		const onSub = () => {
			const w = workerObj(bridge, rocket.id);
			if (!w || w.collided || w.shattered) { return true; }
			snaps.push(snapOf(w));
			if (w.isHoldDown) { debrisOnPad.push(bridge.ctrl.engine.objects.filter((o) => o.type === OBJECT_TYPES.DEBRIS).length); }
			return w.flightComputer.flightTime >= seconds;
		};
		onSub();
		if (beforeLaunch) { rocket = beforeLaunch({ universe, bridge, rocket, onSub }) || rocket; }
		const seq = universe.LaunchSequencer;
		seq.rocketId = rocket.id;
		for (const [cmd, label, frames] of [['PRESSURIZE_TANK', 'TANK PRESSURIZATION', 2], ['IGNITE_ENGINE', 'MAIN ENGINE START', 2], ['RELEASE_HOLD_DOWN', 'LIFTOFF', Math.ceil(seconds / FRAME_S) + 2]]) {
			seq.executeCommand(cmd, label);
			if (onSub() || stepSubSteps(bridge, frames, onSub)) { break; }
		}
		return { snaps, debrisOnPad, totalStages: L.stages.length, payload: L.payload };
	};
	/**
	 * The events the Worker flight goes through, from its state between sub-steps (design §3.4-1 and the event names of
	 * the prediction): the cutoff of a burning stage (its own STG_MECO / ORBITAL_COAST, or its separation, which ends its
	 * burn), each stage index passed (STG-N SEP), the payload separation, an ignition from the interstage coast (SES-k,
	 * k the stage index), the payload's own engine starting (separated and burning) and stopping (ORBITAL_COAST or out of
	 * burn time), the fairing and the boosters. A commanded coast (STG_COAST) is not a cutoff. Id -> MET of the sub-step.
	 */
	const workerEvents = ({ snaps, totalStages: total }) => {
		const ev = new Map();
		const add = (id, t) => { if (!ev.has(id)) { ev.set(id, t); } };
		const cutoffId = (k) => (k + 1 >= total ? (total > 1 ? 'seco_1' : 'meco') : `meco_${k + 1}`);
		for (let i = 1; i < snaps.length; i++) {
			const a = snaps[i - 1];
			const b = snaps[i];
			if (!a.pay && a.st === 'STG_BURNING' && (b.idx > a.idx || (!b.pay && (b.st === 'STG_MECO' || b.st === 'ORBITAL_COAST')))) { add(cutoffId(a.idx), b.t); }
			for (let s = a.idx + 1; s <= Math.min(b.idx, total); s++) { add(`stg_sep_${s}`, b.t); }
			if (!a.pay && b.pay) { add('payload_sep', b.t); }
			if (!b.pay && b.idx === a.idx && a.st === 'INTERSTAGE_COAST' && b.st === 'STG_BURNING') { add(`ses_${b.idx}`, b.t); }
			if (!b.pay && b.idx === a.idx && a.st === 'STG_COAST' && b.st === 'STG_BURNING') { add(`reignition_${b.idx + 1}`, b.t); }
			if (b.pay && b.st === 'STG_BURNING' && !(a.pay && a.st === 'STG_BURNING')) { add('payload_start', b.t); }
			if (a.pay && a.st === 'STG_BURNING' && b.pay && (b.st === 'ORBITAL_COAST' || b.bt <= 0)) { add('payload_cutoff', b.t); }
			if (!a.fair && b.fair) { add('fairing_sep', b.t); }
			if (!a.bout && b.bout) { add('booster_burnout', b.t); }
			if (!a.bsep && b.bsep) { add('booster_sep', b.t); }
		}
		return ev;
	};
	/** The staging events (a stg_sep_N beyond the vehicle's stages is a separate finding of a single-stage vehicle, not compared). */
	const isStagingEvent = (id, total) => /^(meco(_\d+)?|seco_1|payload_sep|payload_start|payload_cutoff|ses_\d+|reignition_\d+|fairing_sep|booster_sep|booster_burnout)$/.test(id)
		|| (/^stg_sep_\d+$/.test(id) && Number(id.slice(8)) <= total);
	/**
	 * The predicted staging events are the Worker flight's, as far as it was flown: the same ids, the same order from the
	 * row on, and the same times. Tolerance: ROW_TOL (a Worker sub-step and a prediction step) for what the row causes,
	 * i.e. within ROW_SPAN_S after it (the separations, the cutoff, the ignitions after their delay); CUTOFF_TOL for
	 * PAYLOAD CUTOFF (the payload's own orbital cutoff); LOOSE_TOL otherwise (the Worker's first stage burns 1 s on the pad
	 * between MAIN ENGINE START and LIFTOFF, the prediction starts at liftoff). An event is compared when it falls, on
	 * either side, at least its tolerance before the end of the flown part (the predictor ends later or at the same time).
	 */
	const ROW_TOL = 0.25;
	const ROW_SPAN_S = 5;
	const CUTOFF_TOL = 1.0;
	const LOOSE_TOL = 1.5;
	const assertSameEvents = (pred, flight, rowT, label) => {
		const total = flight.totalStages;
		const lastT = flight.snaps[flight.snaps.length - 1].t;
		const worker = workerEvents(flight);
		const predicted = new Map(pred.events.filter((e) => isStagingEvent(e.id, total)).map((e) => [e.id, e]));
		const tolOf = (id, t) => (id === 'payload_cutoff' ? CUTOFF_TOL : (t >= rowT - 1e-9 && t <= rowT + ROW_SPAN_S ? ROW_TOL : LOOSE_TOL));
		const ids = new Set();
		for (const [id, t] of worker) { if (t <= lastT - tolOf(id, t)) { ids.add(id); } }
		for (const [id, e] of predicted) { if (e.time <= lastT - tolOf(id, e.time)) { ids.add(id); } }
		const show = (list) => list.map(([id, t]) => `${id}@${t.toFixed(2)}`).join(' ');
		const msg = `flown ${show([...worker])}, predicted ${show([...predicted].map(([id, e]) => [id, e.time]))}`;
		for (const id of ids) {
			assert.ok(worker.has(id) && predicted.has(id), `${label}: ${id} in both (${msg})`);
			const t = worker.get(id);
			const tol = tolOf(id, t);
			assert.ok(Math.abs(predicted.get(id).time - t) <= tol, `${label}: ${id} predicted at ${predicted.get(id).time} s, flown at ${t} s (within ${tol} s; ${msg})`);
		}
		const fromRow = [...ids].filter((id) => worker.get(id) >= rowT - 1e-9);
		const byFlown = [...fromRow].sort((x, y) => worker.get(x) - worker.get(y) || [...worker.keys()].indexOf(x) - [...worker.keys()].indexOf(y));
		const byPredicted = pred.events.map((e) => e.id).filter((id) => fromRow.includes(id));
		assert.deepEqual(byPredicted, byFlown, `${label}: the order from the row on (${msg})`);
		return Object.fromEntries([...ids].map((id) => [id, predicted.get(id)]));
	};
	/** One plan both ways. */
	const both = (plan, seconds, rowT, label) => {
		const flight = flyPlan(plan, seconds);
		const pred = predictPlan(plan);
		return { ev: assertSameEvents(pred, flight, rowT, label), flight, worker: workerEvents(flight) };
	};
	const within = (ev, t, tol, what) => assert.ok(ev && Math.abs(ev.time - t) <= tol, `${what} at ${t} s (got ${ev?.time})`);

	// ==================================================================
	// 8. A sep_* row separating a burning stage: the cutoff at the separation, PAYLOAD START, as the Worker flight
	// ==================================================================
	describe('8. a sep_* row: the prediction has the events of the Worker flight of the same plan (the cutoff of the stage it separates while burning, the payload\'s own START and CUTOFF)', () => {
		it('regression (the report): HTV-X separated by sep_payload during the upper-stage burn: SECO-1, 2-STG-SEP, PAYLOAD SEP and PAYLOAD START at the row, PAYLOAD CUTOFF when the payload stops, as flown', () => {
			const T = 500;
			const { ev, worker } = both({ rows: [planRow(T, 'sep_payload')] }, 620, T, 'HTV-X at 500 s');
			for (const id of ['seco_1', 'stg_sep_2', 'payload_sep', 'payload_start']) { within(ev[id], T, ROW_TOL, id); }
			assert.ok(worker.get('payload_cutoff') > T + 10, `input: the flown payload burns on (${worker.get('payload_cutoff')} s)`);
			assert.ok(ev.seco_1.time < ev.payload_cutoff.time - 10, 'SECO-1 is the upper stage\'s cut at the separation, not the payload\'s cutoff');
		});

		it('normal: sep_stage2 of the two-stage H3 during the upper-stage burn is the payload separation (§3.4-1): the same events as sep_payload', () => {
			const T = 500;
			const a = both({ rows: [planRow(T, 'sep_stage2')] }, 620, T, 'sep_stage2 at 500 s').ev;
			const b = predictPlan({ rows: [planRow(T, 'sep_payload')] });
			assert.deepEqual(Object.keys(a).sort(), b.events.filter((e) => isStagingEvent(e.id, 2) && e.time <= 618).map((e) => e.id).sort());
		});

		it('normal: a passive payload separated during the upper-stage burn: SECO-1 and the separations at the row, nothing of its own, as flown', () => {
			const T = 500;
			const { ev } = both({ payloadId: 'earth_obs', rows: [planRow(T, 'sep_payload')] }, 560, T, 'passive at 500 s');
			within(ev.seco_1, T, ROW_TOL, 'SECO-1');
			assert.equal(ev.payload_start, undefined);
			assert.equal(ev.payload_cutoff, undefined);
		});

		it('normal: sep_stage1 during the first-stage burn: MECO-1 and STG-1 SEP at the row, SES-1 after the ignition delay, as flown (with SRBs: BOOSTER SEP at the row, no BOOSTER BURNOUT)', () => {
			const T = 100;
			const h3 = both({ payloadId: 'earth_obs', rows: [planRow(T, 'sep_stage1')] }, 130, T, 'H3-30 sep_stage1 at 100 s').ev;
			within(h3.meco_1, T, ROW_TOL, 'MECO-1');
			const srb = both({ vehicleId: 'h3_22', rows: [planRow(50, 'sep_stage1')] }, 80, 50, 'H3-22 sep_stage1 at 50 s').ev;
			within(srb.meco_1, 50, ROW_TOL, 'MECO-1');
			within(srb.booster_sep, 50, ROW_TOL, 'BOOSTER SEP');
			assert.equal(srb.booster_burnout, undefined, 'the boosters go with the first stage before their burnout');
		});

		it('normal (3 stages, Epsilon): sep_stage2 during the second-stage burn gives MECO-2 at the row; sep_payload during the third-stage burn gives SECO-1 at the row, as flown', () => {
			const s2 = both({ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km', rows: [planRow(200, 'sep_stage2')] }, 320, 200, 'Epsilon sep_stage2 at 200 s').ev;
			within(s2.meco_2, 200, ROW_TOL, 'MECO-2');
			within(s2.stg_sep_2, 200, ROW_TOL, 'STG-2 SEP');
			const s3 = both({ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km', rows: [planRow(300, 'sep_payload')] }, 330, 300, 'Epsilon sep_payload at 300 s').ev;
			within(s3.seco_1, 300, ROW_TOL, 'SECO-1');
			within(s3.stg_sep_3, 300, ROW_TOL, '3-STG-SEP');
		});

		it('boundary: sep_payload during the first-stage burn (2 and 3 stages): MECO-1 at the row, the unlit upper stages go with it (no SES, no SECO-1, also not at the payload\'s cutoff), as flown', () => {
			const h3 = both({ rows: [planRow(100, 'sep_payload')] }, 200, 100, 'H3 + HTV-X at 100 s').ev;
			within(h3.meco_1, 100, ROW_TOL, 'MECO-1');
			within(h3.payload_start, 100, ROW_TOL, 'PAYLOAD START');
			assert.ok(h3.payload_cutoff, 'input: the payload stopped within the flown part');
			assert.equal(h3.seco_1, undefined, 'no SECO-1');
			const eps = both({ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km', rows: [planRow(60, 'sep_payload')] }, 90, 60, 'Epsilon at 60 s').ev;
			assert.deepEqual(['meco_1', 'stg_sep_1', 'stg_sep_2', 'stg_sep_3', 'payload_sep'].map((id) => Boolean(eps[id])), [true, true, true, true, true]);
			assert.equal(eps.meco_2, undefined);
			assert.equal(eps.seco_1, undefined);
		});

		it('boundary: during the first stage\'s cutoff wait (STG_MECO) and during the interstage coast: the upper stage never lit (no SES-1 or SES-2, no SECO-1), the payload starts in the same step from the coast and one step later from STG_MECO, as flown', () => {
			const meco = both({ rows: [planRow(257, 'sep_payload')] }, 340, 257, 'in STG_MECO at 257 s').ev;
			const coast = both({ rows: [planRow(260, 'sep_payload')] }, 340, 260, 'in the interstage coast at 260 s').ev;
			for (const ev of [meco, coast]) {
				assert.equal(ev.seco_1, undefined);
				assert.equal(ev.ses_1, undefined);
				assert.equal(ev.ses_2, undefined, 'no SES-2: the payload\'s ignition is PAYLOAD START');
				assert.ok(ev.payload_start && ev.payload_cutoff);
			}
		});

		it('boundary: during a commanded coast of the upper stage (a row at 0 % thrust): the separation and PAYLOAD START at the row, no SECO-1 (the coast cut is not an event, as on main), as flown', () => {
			const rows = [planRow(0, '', { angle: 0 }), planRow(100, '', { angle: 40 }), planRow(300, '', { angle: 80 }), planRow(400, '', { thrust: 0, angle: 85 }), planRow(450, 'sep_payload', { angle: 85 })];
			const { ev, flight } = both({ rows, replace: true }, 520, 450, 'commanded coast');
			assert.ok(flight.snaps.some((s) => !s.pay && s.idx === 1 && s.st === 'STG_COAST'), 'input: the upper stage coasts before the row');
			within(ev.payload_start, 450, ROW_TOL, 'PAYLOAD START');
			assert.equal(ev.seco_1, undefined);
		});

		it('boundary: after SECO (the deferred ORBITAL_COAST hold, §3.4-1): SECO-1 at the cutoff, the separation at the row, PAYLOAD START a step later, as flown', () => {
			const T = 1200;
			const { ev } = both({ rows: [planRow(T, 'sep_payload')] }, 1230, T, 'after SECO');
			assert.ok(ev.seco_1.time < T - 100, `input: SECO-1 long before the row (${ev.seco_1.time})`);
			within(ev.payload_sep, T, ROW_TOL, 'PAYLOAD SEP');
			assert.ok(ev.payload_start.time >= ev.payload_sep.time && ev.payload_start.time <= ev.payload_sep.time + ROW_TOL);
		});

		it('boundary: a single-stage vehicle separating its payload during its burn: MECO at the row, as flown', () => {
			const { ev } = both({ vehicleId: 'ssto', payloadId: 'earth_obs', missionId: 'leo_250km', rows: [planRow(100, 'sep_payload')] }, 130, 100, 'SSTO at 100 s');
			within(ev.meco, 100, ROW_TOL, 'MECO');
			assert.equal(ev.seco_1, undefined);
		});

		it('abnormal: a row whose action does not apply (sep_stage2 while the first stage of a two-stage vehicle burns) or a repeated row changes nothing: the events of the default plan, as flown', () => {
			const ignored = both({ rows: [planRow(100, 'sep_stage2')] }, 300, 100, 'sep_stage2 at 100 s').ev;
			assert.deepEqual(Object.keys(ignored).sort(), ['fairing_sep', 'meco_1', 'ses_1', 'stg_sep_1'], 'the first-stage events only');
			const twice = both({ rows: [planRow(500, 'sep_payload'), planRow(510, 'sep_payload')] }, 620, 500, 'two sep_payload rows').ev;
			within(twice.payload_sep, 500, ROW_TOL, 'PAYLOAD SEP (the first row)');
		});
	});

	// ==================================================================
	// 9. A sep_* row met on the pad runs at liftoff (the first flight step), in the Worker and in the prediction
	// ==================================================================
	describe('9. a sep_* row met on the pad (time 0, alt / vel 0) runs in the first flight step after the release: nothing separates or lights on the pad, and the prediction has the separation events', () => {
		it('regression (Worker): sep_payload at t = 0: while held nothing separates (no debris, the payload not separated, PRE_LAUNCH), the separation is the first flight sub-step; the self-propelled payload never burns on the pad', () => {
			for (const payloadId of ['earth_obs', 'htv_x']) {
				const flight = flyPlan({ payloadId, rows: [planRow(0, 'sep_payload')] }, 3);
				const pad = flight.snaps.filter((s) => s.hold);
				const air = flight.snaps.filter((s) => !s.hold && s.t > 0);
				assert.ok(pad.length >= 4 * SUB_STEPS && air.length > 0, 'input: sub-steps on the pad and in flight');
				assert.ok(pad.every((s) => s.idx === 0 && !s.pay && !s.fair && s.st === 'PRE_LAUNCH' && s.t === 0), `${payloadId}: on the pad ${JSON.stringify(pad.find((s) => s.idx !== 0 || s.pay || s.fair || s.st !== 'PRE_LAUNCH'))}`);
				assert.ok(flight.debrisOnPad.every((n) => n === 0), `${payloadId}: no stage or fairing jettisoned on the pad`);
				assert.equal(air[0].t, DT, 'input: the first flight sub-step');
				assert.ok(air[0].pay && air[0].idx === flight.totalStages && air[0].fair, `${payloadId}: separated in the first flight sub-step`);
			}
		});

		it('regression (Worker): a row at t = 0 flies as the same row at the first flight sub-step (MET = one sub-step): the same states from liftoff', () => {
			for (const action of ['sep_payload', 'sep_stage1']) {
				const at0 = flyPlan({ rows: [planRow(0, action)] }, 4).snaps.filter((s) => !s.hold);
				const atFirst = flyPlan({ rows: [planRow(DT, action)] }, 4).snaps.filter((s) => !s.hold);
				assert.ok(at0.length > 2, 'input: flown from liftoff');
				assert.deepEqual(at0, atFirst, action);
			}
		});

		it('regression (Worker, SRBs): sep_stage1 at t = 0 jettisons nothing and lights no upper stage on the pad; the first stage and its boosters go in the first flight sub-step', () => {
			const flight = flyPlan({ vehicleId: 'h3_22', rows: [planRow(0, 'sep_stage1')] }, 4);
			const pad = flight.snaps.filter((s) => s.hold);
			assert.ok(pad.length >= 4 * SUB_STEPS, 'input: sub-steps on the pad');
			assert.ok(pad.every((s) => s.idx === 0 && s.st === 'PRE_LAUNCH' && !s.bsep), `nothing on the pad: ${JSON.stringify(pad.find((s) => s.idx !== 0 || s.st !== 'PRE_LAUNCH' || s.bsep))}`);
			assert.ok(flight.debrisOnPad.every((n) => n === 0), 'no debris on the pad');
			const first = flight.snaps.find((s) => !s.hold && s.t > 0);
			assert.deepEqual([first.t, first.idx, first.st, first.bsep], [DT, 1, 'INTERSTAGE_COAST', true], 'separated in the first flight sub-step, the second stage not yet lit');
		});

		it('normal (prediction = Worker): sep_payload at t = 0, passive and self-propelled: MECO-1, the separations (and PAYLOAD START) in the first step, no SECO-1 (the upper stage never lights)', () => {
			for (const payloadId of ['earth_obs', 'htv_x']) {
				const { ev } = both({ payloadId, rows: [planRow(0, 'sep_payload')] }, 3, 0, `${payloadId} at 0 s`);
				for (const id of ['meco_1', 'stg_sep_1', 'stg_sep_2', 'payload_sep', 'fairing_sep']) { within(ev[id], DT, ROW_TOL, `${payloadId}: ${id}`); }
				assert.equal(ev.seco_1, undefined);
				assert.equal(Boolean(ev.payload_start), payloadId === 'htv_x', `${payloadId}: PAYLOAD START only for the self-propelled payload`);
			}
		});

		it('normal (prediction = Worker): sep_stage1 at t = 0 (and with SRBs): MECO-1 and STG-1 SEP in the first step, SES-1 after the ignition delay', () => {
			const h3 = both({ payloadId: 'earth_obs', rows: [planRow(0, 'sep_stage1')] }, 4, 0, 'H3-30').ev;
			within(h3.meco_1, DT, ROW_TOL, 'MECO-1');
			const srb = both({ vehicleId: 'h3_22', rows: [planRow(0, 'sep_stage1')] }, 4, 0, 'H3-22').ev;
			within(srb.booster_sep, DT, ROW_TOL, 'BOOSTER SEP');
			// The flown vehicle falls back onto the pad before the second stage lights; the prediction (impact from
			// IMPACT_MIN_TIME_S on) lights it after its ignition delay
			const pred = Object.fromEntries(predictPlan({ vehicleId: 'h3_22', rows: [planRow(0, 'sep_stage1')] }).events.map((e) => [e.id, e]));
			within(pred.ses_1, DT + presetManager.getVehicle('h3_22').stages[1].ignitionDelaySec, 0.1, 'SES-1');
		});

		it('boundary (prediction = Worker): rows met on the pad by alt 0 and vel 0, and a row at the first step: as a row at t = 0', () => {
			const ref = predictPlan({ rows: [planRow(0, 'sep_payload')] }).events.map((e) => `${e.id}@${e.time}`);
			for (const [label, r] of [['alt 0', planRow(0, 'sep_payload', { type: 'alt' })], ['vel 0', planRow(0, 'sep_payload', { type: 'vel' })], ['first step', planRow(DT, 'sep_payload')]]) {
				both({ rows: [r] }, 3, 0, label);
				assert.deepEqual(predictPlan({ rows: [r] }).events.map((e) => `${e.id}@${e.time}`), ref, `${label}: the prediction of the row at 0 s`);
			}
		});

		it('boundary (prediction = Worker): 3 stages (Epsilon): sep_stage1 at t = 0 gives MECO-1 in the first step; sep_stage2 at t = 0 does not apply (the second stage is not active) and changes nothing', () => {
			const s1 = both({ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km', rows: [planRow(0, 'sep_stage1')] }, 4, 0, 'Epsilon sep_stage1').ev;
			within(s1.meco_1, DT, ROW_TOL, 'MECO-1');
			const plan = { vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km' };
			const s2 = both({ ...plan, rows: [planRow(0, 'sep_stage2')] }, 260, 0, 'Epsilon sep_stage2').ev;
			const base = predictPlan(plan).events.filter((e) => isStagingEvent(e.id, 3) && e.time <= 258).map((e) => e.id);
			assert.deepEqual(Object.keys(s2).sort(), base.sort(), 'the events of the default plan');
		});

		it('boundary: a single-stage vehicle with sep_payload at t = 0: MECO in the first step, as flown', () => {
			const { ev } = both({ vehicleId: 'ssto', payloadId: 'earth_obs', missionId: 'leo_250km', rows: [planRow(0, 'sep_payload')] }, 3, 0, 'SSTO at 0 s');
			within(ev.meco, DT, ROW_TOL, 'MECO');
		});

		it('boundary: a row latched on the pad survives a save and load on the pad: the loaded flight separates in its first flight sub-step, as the uninterrupted one', async () => {
			const plan = { payloadId: 'earth_obs', rows: [planRow(0, 'sep_payload')] };
			const control = flyPlan(plan, 2).snaps.filter((s) => !s.hold && s.t > 0);
			const { universe, bridge } = newUniverse();
			const earth = deployPlanet(universe, 'Earth');
			applyPlan(universe.RocketLauncher, earth, plan);
			universe.RocketLauncher.rollout();
			stepFrames(bridge, 2);
			const saved = await saveToJson(universe);
			const r = saved.universe.objectManager.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.deepEqual(r.runtimeState.flightComputer.pendingActions, ['sep_payload'], 'input: latched on the pad, waiting');
			loadJson(universe, saved);
			const loaded = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.equal(workerObj(bridge, loaded.id).isPayloadSeparated, false, 'input: not separated by the load');
			const air = [];
			const seq = universe.LaunchSequencer;
			seq.rocketId = loaded.id;
			seq.executeCommand('PRESSURIZE_TANK', 'TANK PRESSURIZATION');
			stepFrames(bridge, 2);
			seq.executeCommand('IGNITE_ENGINE', 'MAIN ENGINE START');
			stepFrames(bridge, 2);
			assert.equal(workerObj(bridge, loaded.id).isPayloadSeparated, false, 'not on the pad after the load either');
			seq.executeCommand('RELEASE_HOLD_DOWN', 'LIFTOFF');
			stepSubSteps(bridge, 1, () => { air.push(snapOf(workerObj(bridge, loaded.id))); return air.length >= 3; });
			const pick = (s) => ({ t: s.t, st: s.st, idx: s.idx, pay: s.pay, fair: s.fair });
			assert.deepEqual(air.map(pick), control.slice(0, 3).map(pick));
		});
	});

	describe('10. a single-stage vehicle has no 2-STG-SEP in the prediction (design §4.14-10)', () => {
		/** The launcher's synchronous prediction on the app path, with the plan's events by id. */
		const predictEvents = ({ vehicleId, payloadId = 'earth_obs', missionId = 'leo_250km' }) => {
			const { universe } = newUniverse({ predict: true });
			const earth = deployPlanet(universe, 'Earth');
			const L = universe.RocketLauncher;
			L.hostId = earth.id;
			presetManager.applyToLauncher(L, { vehicleId, payloadId, missionId });
			const pred = L.updatePredictionSync();
			assert.ok(pred && Array.isArray(pred.events) && pred.events.length > 0, 'input: a prediction with events');
			return { ev: eventsById(pred), stages: L.stages.length };
		};

		it('normal: the single-stage SSTO default plan has PAYLOAD SEP but no 2-STG-SEP (there is no second stage)', () => {
			const { ev, stages } = predictEvents({ vehicleId: 'ssto' });
			assert.equal(stages, 1, 'input: a single-stage vehicle');
			assert.ok(ev.payload_sep, 'the payload separates');
			assert.equal(ev.stg_sep_2, undefined, 'no 2-STG-SEP for a vehicle without a second stage');
			assert.ok(Object.keys(ev).every((id) => !/^stg_sep_([2-9]|\d{2,})$/.test(id)), `no stage separation above the stage count (${Object.keys(ev).join(', ')})`);
		});

		it('guard: two- and three-stage default plans keep their 2-STG-SEP (unchanged)', () => {
			for (const vehicleId of ['h3_30', 'falcon9', 'epsilon']) {
				const { ev, stages } = predictEvents({ vehicleId });
				assert.ok(stages >= 2, `input: ${vehicleId} has ${stages} stages`);
				assert.ok(ev.stg_sep_2, `${vehicleId}: 2-STG-SEP is kept`);
			}
		});

		it('guard: the rule is gated on the stage count in the predictor source', () => {
			assert.match(code('gravsim_calc_predictor.js'), /rocket\.isStage2Separated && rocket\.totalStages >= 2/);
		});
	});
});
