/**
 * Regression Suite 20: the flight callouts are the events of the vehicle's stages and of the payload's own engine
 * (design §4.14-11 of docs/design/2026-11-20_trajectory_fx_flightplan.md, proposed with this suite; audit G3-2-01).
 *
 * The main thread derives the flight-event flags of the telemetry (ObjectManager._applyRocketState) that the voice rules of
 * the launch sequences read (isMeco, isStage1Separated, isSes, isSeco, isStage2Separated, isPes, isPeco). On main the
 * payload flag read a field that does not exist, so the payload callouts never played and the payload terms were dead;
 * this branch reads the real flag and syncs the Worker's isStage2Separated (Gate 1), and self-propelled payloads now burn
 * (§4.14-2). Nothing checked what the flags then meant:
 *  1. PECO ("payload engine cutoff") played at the separation of every passive payload (ASNARO-2, ALOS-4: burn time 0 and
 *     the MECO status), and at the separation of a self-propelled payload that was never seen firing. It is the payload's
 *     own engine stopping after it fired, as the prediction's PAYLOAD CUTOFF (§4.14-1).
 *  2. "2nd stage separation" played on a single-stage vehicle (CalcRocket sets isStage2Separated at its payload
 *     separation). It is only for vehicles with a second stage, as the prediction's 2-STG-SEP (§4.14-10); the rocket keeps
 *     the Worker's flag (the save and the restore use it).
 *  3. SES ("second engine start") played at the burn of a self-propelled payload on a single-stage vehicle (its payload is
 *     stage index 1). SES is the second stage's ignition; the payload's is PES (as PAYLOAD START comes first, §4.14-8 (c)).
 *  4. SECO ("second engine cutoff") of a three-stage vehicle played at the payload separation when the second stage's
 *     MECO was never seen: a sep_stage2 row (§3.4-1) jettisoning the burning second stage (its cutoff is the separation,
 *     §4.14-8 (b)), and again after a flight loaded during the third-stage burn (§4.14-6 (c) marks passed only what holds).
 *     The second stage gone (stage index 2 and up) is its cutoff.
 * Kept as on main (pre-existing, not of this branch): a single-stage vehicle voices SECO at its payload separation.
 *
 * Expected values: the callouts of each vehicle and payload follow from the design (the stage count, whether the payload
 * fires), and each is expected in the frame where the Worker's own state (stage index, stage state, payload separation)
 * shows its event, with the rules of the prediction (§4.14-1, -8, -10); the callout ids and their order within a frame
 * are those of the LEGACY_QUICK audio profile. Nothing is copied from the output of the code under test.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockElement } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { GravSimObject, Rocket } from '../../scripts/gravsim_object.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { OBJECT_TYPES, OBJECT_STATE, LAUNCH_SEQUENCES, TELEMETRY } from '../../scripts/gravsim_const.js';

// ------------------------------------------------------------------
// Worker transport emulation (structured clone; Worker -> main replies asynchronous), as regressions 12 to 19
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
/** One fixed-step frame of SimulationController.update(), delivered to the main thread synchronously. */
const stepFrame = (bridge) => {
	const e = bridge.ctrl.engine;
	e._categorizeBodies();
	e._buildQuadTree(FRAME_S);
	e._checkCollisions(FRAME_S);
	e._checkRocheLimit();
	for (let i = 0; i < SUB_STEPS; i++) { e._moveObjects(DT); }
	e._updateEscapeStatus();
	const buf = WorkerBridge.formatWorkerToMain(e.objects);
	bridge.onmessage({ data: { cmd: 'update', deltaTime: DT, subSteps: SUB_STEPS, objectsData: buf.buffer, validLength: buf.length } });
	e.removeDeadObjects();
};

let blobs = [];
/** A page load (the id counter starts at 0); the prediction is not under test. */
const newUniverse = () => {
	GravSimObject._idCounter = 0;
	const universe = new Universe(createMockElement('canvas'));
	const launcher = universe.RocketLauncher;
	launcher.updatePredictionSync = () => null;
	launcher.updatePrediction = () => null;
	launcher.requestPreviewUpdate = () => {};
	universe.SoundEffects.update = () => {}; // the synthesis is not under test (the mock AudioContext has no filters)
	universe.updateUI(0);
	return { universe, bridge: PhysicsWorkerBridge.last };
};
const deployEarth = (universe) => {
	EventBus.emit('object:deploy-orbit-sun', 'Earth');
	universe.updateUI(0);
	const obj = universe.objects.filter((o) => o.name === 'Earth' && o.state === OBJECT_STATE.ACTIVE).pop();
	assert.ok(obj, 'input: Earth deployed');
	return obj;
};

// ------------------------------------------------------------------
// The flight-event callouts of the LEGACY_QUICK audio profile (data): the telemetry flag each one reads
// ------------------------------------------------------------------
const QUICK = LAUNCH_SEQUENCES.LEGACY_QUICK;
const EVENT_FLAGS = ['isMeco', 'isStage1Separated', 'isSes', 'isSeco', 'isStage2Separated', 'isPes', 'isPeco'];
const EVENT_CONDITIONS = QUICK.audioProfile.conditions.filter((c) => EVENT_FLAGS.includes(c.type));
const CALLOUT = Object.fromEntries(EVENT_CONDITIONS.map((c) => [c.type, c.audio]));
/** The rank of a callout within a frame: the SoundSequencer evaluates the conditions in the profile's order. */
const RANK = new Map(QUICK.audioProfile.conditions.map((c, i) => [c.audio, i]));
const MECO = 'fl_meco', SEP1 = 'fl_1-stage_sep', SES = 'fl_ses', SECO = 'fl_seco', SEP2 = 'fl_2-stage_sep', PES = 'fl_pes', PECO = 'fl_peco';

/**
 * The frame of each event in the Worker's own states of a flight (`states[f]`: the rocket after frame f), by the rules of
 * design §4.14-11 (those of the prediction's events). null: the event does not happen in the states.
 *  MECO: stage index 0 in STG_MECO, or the stage index past 0 (a separation without a cutoff state)
 *  1-STG-SEP: stage index >= 1 (on a single-stage vehicle, the payload separation)
 *  SES (>= 2 stages): stage index 1, payload not separated, STG_BURNING
 *  SECO (>= 2 stages): stage index 1 in STG_MECO, or stage index >= 2 (the second stage gone). Single stage: at the
 *    payload separation, as on main (kept, pre-existing)
 *  2-STG-SEP (>= 2 stages): stage index >= 2
 *  PES: the payload separated and STG_BURNING (its own engine)
 *  PECO: after a PES state, the payload separated in ORBITAL_COAST or with no burn time (§4.14-1)
 */
const eventFrames = (states, totalStages) => {
	const first = (pred, from = 0) => {
		for (let f = from; f < states.length; f++) { if (states[f] && pred(states[f])) { return f; } }
		return null;
	};
	const pes = first((s) => s.pay && s.st === 'STG_BURNING');
	const multi = totalStages >= 2;
	return {
		[MECO]: first((s) => (s.idx === 0 && s.st === 'STG_MECO') || s.idx >= 1),
		[SEP1]: first((s) => s.idx >= 1),
		[SES]: multi ? first((s) => s.idx === 1 && !s.pay && s.st === 'STG_BURNING') : null,
		[SECO]: multi ? first((s) => (s.idx === 1 && s.st === 'STG_MECO') || s.idx >= 2) : first((s) => s.pay),
		[SEP2]: multi ? first((s) => s.idx >= 2) : null,
		[PES]: pes,
		[PECO]: pes === null ? null : first((s) => s.pay && s.st !== 'STG_BURNING' && (s.st === 'ORBITAL_COAST' || s.bt <= 0), pes + 1)
	};
};
/** The expected callouts of the frames: in frame order, the profile's order within a frame. */
const expectedCallouts = (frames, fromFrame = 0) => Object.entries(frames)
	.filter(([, f]) => f !== null && f >= fromFrame)
	.sort(([ka, fa], [kb, fb]) => (fa - fb) || (RANK.get(ka) - RANK.get(kb)))
	.map(([k, f]) => ({ k, f }));

/**
 * A LEGACY_QUICK launch through the real RocketLauncher and LaunchSequencer, the voice of the real SoundSequencer, flown in
 * 0.5 s frames to `seconds` of MET. The Worker state of the rocket is recorded after every frame, each event callout with
 * the frame whose telemetry it reads (the SoundSequencer runs in the update after the frame). `saveAtMet`: a same-session
 * save and load at that MET (the callouts and the states after the load are of the loaded rocket).
 */
const fly = async ({ vehicleId, payloadId, missionId, rows = [], seconds, saveAtMet = null }) => {
	const { universe, bridge } = newUniverse();
	const earth = deployEarth(universe);
	const L = universe.RocketLauncher;
	L.hostId = earth.id;
	presetManager.applyToLauncher(L, { vehicleId, payloadId, missionId });
	if (rows.length > 0) { L.flightProfile = [...L.flightProfile, ...rows]; }
	const before = new Set(universe.objects);
	L.rollout();
	let rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET && !before.has(o));
	assert.ok(rocket, 'input: rolled out');
	let frame = 0;
	const voice = [];
	EventBus.on('audio:play', (k) => { if (RANK.has(k) && Object.values(CALLOUT).includes(k)) { voice.push({ k, f: frame }); } });
	L.ignite('LEGACY_QUICK');
	universe.TelemetryPanel.targetId = rocket.id;
	const states = [null];
	const flags = [null];
	let loadFrame = null;
	for (;;) {
		EventBus.emitUpdate(FRAME_S * 1000, FRAME_S);
		const met = rocket.telemetry?.flightTime ?? 0;
		if (met >= seconds) { break; }
		if (saveAtMet !== null && loadFrame === null && met >= saveAtMet) {
			blobs = [];
			await universe.SaveManager.save();
			assert.equal(blobs.length, 1, 'input: one save file written');
			const json = JSON.parse(await blobs[0].text());
			const target = { files: [{ name: 'save.json', content: JSON.stringify(json) }], value: 'x' };
			universe.SaveManager.load({ target });
			assert.equal(target.value, '', 'input: load handled');
			universe.updateUI(0);
			rocket = universe.objects.find((o) => o.type === OBJECT_TYPES.ROCKET);
			assert.ok(rocket, 'input: the loaded rocket');
			universe.TelemetryPanel.targetId = rocket.id;
			loadFrame = frame + 1;
		}
		stepFrame(bridge);
		frame++;
		const w = bridge.ctrl.engine.objects.find((o) => o.id === rocket.id && o.type === OBJECT_TYPES.ROCKET);
		assert.ok(w, `input: the rocket flies (frame ${frame})`);
		states.push({ met: w.flightComputer.flightTime, idx: w.currentStageIndex, st: w.stageState, pay: Boolean(w.isPayloadSeparated), bt: w.burnTime });
		flags.push(Object.fromEntries(EVENT_FLAGS.map((k) => [k, rocket.telemetry?.[k]])));
		assert.ok(frame < 4000, 'input: the flight ends');
	}
	return { universe, bridge, rocket, voice, states, flags, loadFrame, totalStages: rocket.telemetry.totalStages };
};
const metOf = (run, f) => (f === null || f === undefined ? 'never' : `T+${run.states[f].met.toFixed(1)} s`);
/** The callouts of the flight: the ids expected from the design, each in the frame of its event in the Worker states. */
const assertCallouts = (run, ids, { fromFrame = 0, label = '' } = {}) => {
	const exp = expectedCallouts(eventFrames(run.states, run.totalStages), fromFrame);
	const got = run.voice.filter((v) => v.f >= fromFrame);
	const show = (list) => list.map((v) => `${v.k}@${metOf(run, v.f)}`).join(' ');
	assert.deepEqual(exp.map((v) => v.k), ids, `input: the events of the Worker flight are those the design gives ${label}(${show(exp)})`);
	assert.deepEqual(got.map((v) => v.k), ids, `${label}the callouts (${show(got)})`);
	got.forEach((v, i) => assert.equal(v.f, exp[i].f, `${v.k} at ${metOf(run, v.f)}, its event at ${metOf(run, exp[i].f)}`));
};

describe('Regression 20: the flight callouts are the events of the stages and of the payload\'s own engine (design §4.14-11)', () => {
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

	it('input: the LEGACY_QUICK and FULL_COUNTDOWN profiles voice each event flag once, with the same callout ids', () => {
		for (const seq of [QUICK, LAUNCH_SEQUENCES.FULL_COUNTDOWN]) {
			const conds = seq.audioProfile.conditions.filter((c) => EVENT_FLAGS.includes(c.type));
			assert.deepEqual(conds.map((c) => c.type).sort(), [...EVENT_FLAGS].sort());
			assert.ok(conds.every((c) => c.operator === '==' && c.value === true && c.once === true));
			assert.deepEqual(Object.fromEntries(conds.map((c) => [c.type, c.audio])), CALLOUT);
		}
		assert.deepEqual(CALLOUT, { isMeco: MECO, isStage1Separated: SEP1, isSes: SES, isSeco: SECO, isStage2Separated: SEP2, isPes: PES, isPeco: PECO });
	});

	// ==================================================================
	// 1. Passive payloads: no payload engine
	// ==================================================================
	describe('1. a passive payload has no engine: no PES, no PECO', () => {
		for (const [vehicleId, payloadId, seconds, ids] of [
			['h3_30', 'asnaro_2', 680, [MECO, SEP1, SES, SECO, SEP2]],
			['falcon9', 'earth_obs', 520, [MECO, SEP1, SES, SECO, SEP2]],
			['epsilon', 'asnaro_2', 400, [MECO, SEP1, SES, SECO, SEP2]]
		]) {
			it(`regression: ${vehicleId} + ${payloadId} (LEO): the stage callouts, 2ND STAGE SEPARATION included; no PAYLOAD ENGINE CUTOFF at the separation`, async () => {
				const run = await fly({ vehicleId, payloadId, missionId: 'leo_250km', seconds });
				const sep = run.states.findIndex((s) => s && s.pay);
				assert.ok(sep > 0 && run.states.length - sep > 60, `input: the payload separated (${metOf(run, sep)}) and flew on`);
				assert.equal(run.rocket.payload?.propulsion?.enabled, false, 'input: a passive payload');
				assert.ok(run.states.slice(sep).every((s) => s.st === 'ORBITAL_COAST' && s.bt === 0), 'input: it coasts with no burn time (the MECO status)');
				assertCallouts(run, ids);
				assert.ok(run.flags.every((t) => !t || (t.isPes === false && t.isPeco === false)), 'telemetry: never PES, never PECO');
			});
		}
	});

	// ==================================================================
	// 2. Single-stage vehicle (SSTO)
	// ==================================================================
	describe('2. a single-stage vehicle has no second stage: no 2ND STAGE SEPARATION, no SES; its payload\'s burn is PES / PECO', () => {
		it('regression: SSTO + ALOS-4 (passive, LEO): MECO, 1st stage separation and SECO (as on main) at the payload separation; telemetry never shows a second-stage separation, the rocket keeps the Worker\'s flag', async () => {
			const run = await fly({ vehicleId: 'ssto', payloadId: 'earth_obs', missionId: 'leo_250km', seconds: 340 });
			assert.equal(run.totalStages, 1, 'input: one stage');
			const sep = run.states.findIndex((s) => s && s.pay);
			assert.ok(sep > 0, 'input: the payload separated');
			assertCallouts(run, [MECO, SEP1, SECO]);
			assert.ok(run.flags.every((t) => !t || t.isStage2Separated === false), 'telemetry: no second-stage separation');
			const w = run.bridge.ctrl.engine.objects.find((o) => o.id === run.rocket.id);
			assert.equal(w.isStage2Separated, true, 'input: the Worker sets its flag at the payload separation (CalcRocket, totalStages <= 2)');
			assert.equal(run.rocket.isStage2Separated, true, 'the rocket keeps the Worker\'s flag (the save and the restore use it)');
		});

		it('regression: SSTO + HTV-X (self-propelled, ISS): the payload lights at its separation: PES there (not SES, not 2ND STAGE SEPARATION) and PECO at its cutoff', async () => {
			const run = await fly({ vehicleId: 'ssto', payloadId: 'htv_x', missionId: 'iss_rendezvous', seconds: 460 });
			assert.equal(run.totalStages, 1, 'input: one stage');
			const pes = run.states.findIndex((s) => s && s.pay && s.st === 'STG_BURNING');
			assert.ok(pes > 0, 'input: the payload burns its own engine');
			assert.equal(run.states[pes].idx, 1, 'input: the separated payload is stage index 1 = totalStages');
			assertCallouts(run, [MECO, SEP1, SECO, PES, PECO]);
			assert.ok(run.flags.every((t) => !t || (t.isSes === false && t.isStage2Separated === false)), 'telemetry: never SES, never a second-stage separation');
		});
	});

	// ==================================================================
	// 3. Self-propelled payloads on multi-stage vehicles
	// ==================================================================
	describe('3. a self-propelled payload: PES when it fires, PECO when it stops after firing', () => {
		it('normal: H3-24 + MMX (Mars transfer, 2 stages): every stage callout, then PES at the payload\'s ignition and PECO at its cutoff', async () => {
			const run = await fly({ vehicleId: 'h3_24', payloadId: 'mmx', missionId: 'mars_transfer', seconds: 1060 });
			assertCallouts(run, [MECO, SEP1, SES, SECO, SEP2, PES, PECO]);
			const f = eventFrames(run.states, run.totalStages);
			assert.ok(run.states[f[PECO]].met - run.states[f[PES]].met > 100, `input: a burn of the payload (${metOf(run, f[PES])} to ${metOf(run, f[PECO])})`);
		});

		it('normal: Epsilon + HTV-X (ISS, 3 stages): 2ND STAGE SEPARATION at the second-stage separation, PES / PECO for the payload after the third stage', async () => {
			const run = await fly({ vehicleId: 'epsilon', payloadId: 'htv_x', missionId: 'iss_rendezvous', seconds: 420 });
			assert.equal(run.totalStages, 3, 'input: three stages');
			assertCallouts(run, [MECO, SEP1, SES, SECO, SEP2, PES, PECO]);
		});

		it('regression: Falcon 9 + HTV-X (ISS): a self-propelled payload separated without ever being seen firing (in orbit already) has no PECO', async () => {
			const run = await fly({ vehicleId: 'falcon9', payloadId: 'htv_x', missionId: 'iss_rendezvous', seconds: 540 });
			const sep = run.states.findIndex((s) => s && s.pay);
			assert.ok(sep > 0 && run.states.length - sep > 60, 'input: the payload separated and flew on');
			assert.equal(run.rocket.payload?.propulsion?.enabled, true, 'input: a self-propelled payload');
			assert.ok(run.states.slice(sep).every((s) => s.st !== 'STG_BURNING'), 'input: never burning in a frame after its separation');
			assertCallouts(run, [MECO, SEP1, SES, SECO, SEP2]);
		});

		it('normal: a flight saved during the payload\'s burn (H3-24 + MMX, T+800 s) and loaded: the burn is behind (no PES again) and its cutoff is still PECO', async () => {
			const run = await fly({ vehicleId: 'h3_24', payloadId: 'mmx', missionId: 'mars_transfer', seconds: 1060, saveAtMet: 800 });
			assert.ok(run.loadFrame !== null, 'input: loaded');
			const atLoad = run.states[run.loadFrame];
			assert.ok(atLoad.pay && atLoad.st === 'STG_BURNING', `input: the payload burns at the load (${metOf(run, run.loadFrame)})`);
			assertCallouts(run, [PECO], { fromFrame: run.loadFrame, label: 'after the load: ' });
		});
	});

	// ==================================================================
	// 4. SECO when the second stage's cutoff is not seen as a MECO state
	// ==================================================================
	describe('4. the second stage gone is its cutoff: SECO at a sep_* row and not again after a load', () => {
		it('regression: Epsilon + ASNARO-2 with a sep_stage2 row at T+200 s (the second stage burning, §3.4-1): SECO with 2ND STAGE SEPARATION there, not at the payload separation', async () => {
			const row = { type: 'time', value: 200, thrust: 100, angle: 90, action: 'sep_stage2' };
			const run = await fly({ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km', rows: [row], seconds: 340 });
			const sep2 = run.states.findIndex((s) => s && s.idx >= 2);
			assert.ok(sep2 > 0 && Math.abs(run.states[sep2].met - 200) <= FRAME_S, `input: the second stage separated at ${metOf(run, sep2)}`);
			assert.equal(run.states[sep2 - 1].st, 'STG_BURNING', 'input: while it burned');
			assert.ok(!run.states.some((s) => s && s.idx === 1 && s.st === 'STG_MECO'), 'input: no MECO state of the second stage');
			assert.ok(run.states.some((s) => s && s.pay), 'input: the payload separated later');
			assertCallouts(run, [MECO, SEP1, SES, SECO, SEP2]);
		});

		it('regression: H3-30 + ASNARO-2 with a sep_payload row at T+500 s (the upper stage burning): SECO and 2ND STAGE SEPARATION at the separation, no PECO', async () => {
			const row = { type: 'time', value: 500, thrust: 100, angle: 90, action: 'sep_payload' };
			const run = await fly({ vehicleId: 'h3_30', payloadId: 'asnaro_2', missionId: 'leo_250km', rows: [row], seconds: 560 });
			const sep = run.states.findIndex((s) => s && s.pay);
			assert.ok(sep > 0 && Math.abs(run.states[sep].met - 500) <= FRAME_S, `input: the payload separated at ${metOf(run, sep)}`);
			assert.equal(run.states[sep - 1].st, 'STG_BURNING', 'input: during the upper-stage burn');
			assertCallouts(run, [MECO, SEP1, SES, SECO, SEP2]);
		});

		it('regression: Epsilon + ASNARO-2 saved during the third-stage burn (T+300 s) and loaded: nothing of the passed events again (SECO was voiced before the save), none at the payload separation', async () => {
			const run = await fly({ vehicleId: 'epsilon', payloadId: 'asnaro_2', missionId: 'leo_250km', seconds: 400, saveAtMet: 300 });
			assert.ok(run.loadFrame !== null, 'input: loaded');
			const atLoad = run.states[run.loadFrame];
			assert.ok(atLoad.idx === 2 && atLoad.st === 'STG_BURNING' && !atLoad.pay, `input: the third stage burns at the load (${metOf(run, run.loadFrame)})`);
			assert.ok(run.states.slice(run.loadFrame).some((s) => s.pay), 'input: the payload separates after the load');
			assert.deepEqual(run.voice.filter((v) => v.f < run.loadFrame).map((v) => v.k), [MECO, SEP1, SES, SECO, SEP2], 'input: before the save');
			assertCallouts(run, [], { fromFrame: run.loadFrame, label: 'after the load: ' });
		});
	});

	// ==================================================================
	// 5. The rules, frame by frame (ObjectManager._applyRocketState)
	// ==================================================================
	describe('5. the flags of single frames (ObjectManager._applyRocketState)', () => {
		const om = new ObjectManager(null, { postMessage() {} });
		let nextId = 100;
		const newRocket = () => {
			const id = nextId++;
			const r = new Rocket(id, `R${id}`, 0, 0, 0, 0, 20, 100, 200, '#ffffff', 5, 10, 0);
			om.addObject(r, false);
			return r;
		};
		/** A frame of the Worker (the fields _applyRocketState reads) with the given stage count and state. */
		const frameOf = (fields) => ({
			mass: 20, fuelMass: 10, oxidMass: 20, burnTime: 50, thrustRatio: 1, isIgnited: true, tmAltM: 200000, tmFlightTime: 300,
			tmStatus: TELEMETRY.STATUS.ASCENT, tmStageIndex: 0, tmTotalStages: 2, isPayloadSeparated: false, ...fields
		});
		const apply = (rocket, fields) => { om._applyRocketState(rocket, frameOf(fields)); return rocket.telemetry; };
		const FIRING = { isIgnited: true, thrustRatio: 1, burnTime: 50, tmStatus: TELEMETRY.STATUS.ASCENT };
		const STOPPED = { isIgnited: false, thrustRatio: 0, burnTime: 0, tmStatus: TELEMETRY.STATUS.MECO };

		it('2-STG-SEP: only with two stages or more; the rocket keeps the Worker\'s flag', () => {
			for (const [n, idx] of [[1, 1], [2, 2], [3, 2], [3, 3]]) {
				const r = newRocket();
				const tm = apply(r, { tmTotalStages: n, tmStageIndex: idx, isPayloadSeparated: idx === n, isStage2Separated: true, ...STOPPED });
				assert.equal(tm.isStage2Separated, n >= 2, `${n} stages, stage index ${idx}`);
				assert.equal(r.isStage2Separated, true, `${n} stages: the rocket's flag is the Worker's`);
			}
			// Without the Worker's flag (an older frame): stage index >= 2 or the payload separated, with two stages or more
			assert.equal(apply(newRocket(), { tmTotalStages: 1, tmStageIndex: 1, isPayloadSeparated: true, ...STOPPED }).isStage2Separated, false, '1 stage, no flag');
			assert.equal(apply(newRocket(), { tmTotalStages: 2, tmStageIndex: 2, isPayloadSeparated: true, ...STOPPED }).isStage2Separated, true, '2 stages, no flag');
			assert.equal(apply(newRocket(), { tmTotalStages: 3, tmStageIndex: 1, isStage2Separated: false, ...FIRING }).isStage2Separated, false, '3 stages, stage index 1');
		});

		it('SES: stage index 1 firing before the payload separation; a single-stage vehicle\'s separated payload firing is PES', () => {
			assert.equal(apply(newRocket(), { tmTotalStages: 2, tmStageIndex: 1, ...FIRING }).isSes, true, 'the second stage fires');
			assert.equal(apply(newRocket(), { tmTotalStages: 3, tmStageIndex: 1, ...FIRING }).isSes, true, 'the second of three fires');
			assert.equal(apply(newRocket(), { tmTotalStages: 2, tmStageIndex: 1, ...FIRING, thrustRatio: 0 }).isSes, false, 'ignited, no thrust');
			const tm = apply(newRocket(), { tmTotalStages: 1, tmStageIndex: 1, isPayloadSeparated: true, ...FIRING });
			assert.equal(tm.isSes, false, 'single stage: the payload fires');
			assert.equal(tm.isPes, true, 'it is PES');
		});

		it('SECO: the second stage\'s MECO status, or the second stage gone (stage index >= 2, or the payload separated); not before', () => {
			assert.equal(apply(newRocket(), { tmTotalStages: 3, tmStageIndex: 1, ...FIRING }).isSeco, false, 'the second stage fires');
			assert.equal(apply(newRocket(), { tmTotalStages: 3, tmStageIndex: 1, ...STOPPED }).isSeco, true, 'its MECO status');
			assert.equal(apply(newRocket(), { tmTotalStages: 3, tmStageIndex: 2, ...FIRING }).isSeco, true, 'the third stage fires: the second is gone');
			assert.equal(apply(newRocket(), { tmTotalStages: 3, tmStageIndex: 3, isPayloadSeparated: true, ...STOPPED }).isSeco, true, 'the payload separated');
			assert.equal(apply(newRocket(), { tmTotalStages: 2, tmStageIndex: 0, ...STOPPED }).isSeco, false, 'the first stage\'s MECO');
		});

		it('PECO: the separated payload stops after it was seen firing; not at a separation without a burn, not while it fires, not before its separation', () => {
			for (const n of [1, 2, 3]) {
				const sep = { tmTotalStages: n, tmStageIndex: n, isPayloadSeparated: true };
				// A passive payload (or one never seen firing): separated with no burn time and the MECO status
				const passive = newRocket();
				assert.equal(apply(passive, { ...sep, ...STOPPED }).isPeco, false, `${n} stages: separated, never fired`);
				assert.equal(apply(passive, { ...sep, ...STOPPED }).isPeco, false, `${n} stages: still not`);
				// A stage burning before the separation is not the payload's burn
				const staged = newRocket();
				apply(staged, { tmTotalStages: n, tmStageIndex: n - 1, ...FIRING });
				assert.equal(apply(staged, { ...sep, ...STOPPED }).isPeco, false, `${n} stages: the last stage fired, then the payload separated`);
				// A self-propelled payload: fires, stops
				const fired = newRocket();
				const firing = apply(fired, { ...sep, ...FIRING, hasPayloadPropulsion: true });
				assert.equal(firing.isPes, true, `${n} stages: PES`);
				assert.equal(firing.isPeco, false, `${n} stages: no PECO while it fires`);
				assert.equal(apply(fired, { ...sep, ...STOPPED, hasPayloadPropulsion: true }).isPeco, true, `${n} stages: PECO at its stop`);
				// A commanded coast (burn time left, COASTING status) is not a cutoff
				const coast = newRocket();
				apply(coast, { ...sep, ...FIRING, hasPayloadPropulsion: true });
				assert.equal(apply(coast, { ...sep, isIgnited: false, thrustRatio: 0, burnTime: 40, tmStatus: TELEMETRY.STATUS.COASTING, hasPayloadPropulsion: true }).isPeco, false, `${n} stages: a coast`);
			}
		});

		// Each alternative of the stop on its own (audit G3-3-02): the stopped frames above have the MECO status and no burn
		// time at once, as every real flight's (the Worker's status is MECO once the burn time is spent after T+0), so
		// either alternative could go unnoticed. The rule (§4.14-11): the MECO status, or burn time 0, as the prediction's
		// PAYLOAD CUTOFF (§4.14-1), whose burn-time test is burn time <= 0 (§4.14-3): -0 and below count, a positive
		// burn time does not, a frame without a burn time reads the status only. (A Worker frame carries 0 for any burn
		// time not above 0: WorkerBridge.formatWorkerToMain writes it clamped. -0 and below are the rule's boundary.)
		it('PECO boundary: after the payload fired, a stop with no burn time (0, -0, below 0) is PECO whatever the status, not only MECO; with burn time left (down to the smallest positive number) only the MECO status is', () => {
			const NOT_MECO = Object.entries(TELEMETRY.STATUS).filter(([, v]) => v !== TELEMETRY.STATUS.MECO);
			assert.deepEqual(NOT_MECO.map(([k]) => k), ['PRE_LAUNCH', 'LIFTOFF', 'ASCENT', 'MAX_Q', 'COASTING', 'TRACKING'], 'input: the statuses other than MECO');
			const STOP = { isIgnited: false, thrustRatio: 0, hasPayloadPropulsion: true };
			const label = (bt) => (Object.is(bt, -0) ? '-0' : String(bt));
			for (const n of [1, 2, 3]) {
				const sep = { tmTotalStages: n, tmStageIndex: n, isPayloadSeparated: true };
				/** The PECO flag of the frame `fields` (stopped unless they say otherwise) after the payload was seen firing */
				const afterBurn = (fields) => {
					const r = newRocket();
					assert.equal(apply(r, { ...sep, ...FIRING, hasPayloadPropulsion: true }).isPes, true, `input: ${n} stages, the payload fires`);
					return apply(r, { ...sep, ...STOP, ...fields }).isPeco;
				};
				for (const [name, status] of NOT_MECO) {
					for (const bt of [0, -0, -1e-9, -1]) {
						assert.equal(afterBurn({ burnTime: bt, tmStatus: status }), true, `${n} stages, ${name}, burn time ${label(bt)}: PECO`);
					}
					for (const bt of [Number.MIN_VALUE, 1e-9, 0.1, 40]) {
						assert.equal(afterBurn({ burnTime: bt, tmStatus: status }), false, `${n} stages, ${name}, burn time ${label(bt)} left: no PECO`);
					}
					assert.equal(afterBurn({ burnTime: undefined, tmStatus: status }), false, `${n} stages, ${name}, no burn time in the frame: no PECO`);
				}
				for (const bt of [40, Number.MIN_VALUE, undefined]) {
					assert.equal(afterBurn({ burnTime: bt, tmStatus: TELEMETRY.STATUS.MECO }), true, `${n} stages, the MECO status, burn time ${label(bt)}: PECO`);
				}
				// Still firing is never the stop, whatever the burn time and the status
				for (const bt of [0, -1]) {
					for (const [name, status] of [['MECO', TELEMETRY.STATUS.MECO], ['COASTING', TELEMETRY.STATUS.COASTING]]) {
						assert.equal(afterBurn({ isIgnited: true, thrustRatio: 1, burnTime: bt, tmStatus: status }), false, `${n} stages, firing, ${name}, burn time ${label(bt)}: no PECO`);
					}
				}
				// Never seen firing: no burn time without the MECO status is no stop of the payload's engine either
				const never = newRocket();
				assert.equal(apply(never, { ...sep, ...STOP, burnTime: 0, tmStatus: TELEMETRY.STATUS.COASTING }).isPeco, false, `${n} stages, never fired, burn time 0, COASTING: no PECO`);
			}
		});

		it('PECO boundary: the flag is that of each frame: burn time 0 without the MECO status, then a coast with burn time left, a new burn, and a stop with no thrust and no burn time (the callout itself plays once)', () => {
			const sep = { tmTotalStages: 2, tmStageIndex: 2, isPayloadSeparated: true };
			const r = newRocket();
			apply(r, { ...sep, ...FIRING, hasPayloadPropulsion: true });
			const seq = [
				[{ isIgnited: false, thrustRatio: 0, burnTime: 0, tmStatus: TELEMETRY.STATUS.COASTING }, true],
				[{ isIgnited: false, thrustRatio: 0, burnTime: 12.5, tmStatus: TELEMETRY.STATUS.COASTING }, false],
				[{ ...FIRING, burnTime: 12.5 }, false],
				[{ isIgnited: true, thrustRatio: 0, burnTime: 0, tmStatus: TELEMETRY.STATUS.ASCENT }, true]
			];
			seq.forEach(([fields, peco], i) => {
				assert.equal(apply(r, { ...sep, hasPayloadPropulsion: true, ...fields }).isPeco, peco, `frame ${i + 1}`);
			});
			assert.equal(EVENT_CONDITIONS.find((c) => c.type === 'isPeco').once, true, 'input: the callout plays once per flight');
		});
	});
});
