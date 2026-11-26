/**
 * Integration Test Suite 15: stack geometry, SRB count and preset caches through the Worker / main-thread pipeline
 *
 * The app path of a launch: RocketLauncher (presetManager.applyToLauncher -> rollout) -> ObjectPlacer -> ObjectManager
 * -> structured-clone Worker boundary -> SimulationController / PhysicsEngine / CalcRocket (scripts/gravsim_calc.js),
 * stepped with a fixed-step replica of SimulationController.update, and back through WorkerBridge ->
 * ObjectManager.updateObjectParams -> Rocket / telemetry -> RocketRenderer, Rocket.updateHistory, the HUD
 * (TelemetryPanel.formatStageInfo, NaviTab) and the trajectory predictor (PredictorPhysicsEngine). Saves go through
 * ObjectManager.getState / loadState.
 *
 * Design: docs/design/2026-11-23_vapor_cone_rcs_anchors.md §5.2 (with §3.1, §3.2-§3.7 and §3.11).
 *   15-1 RCS:        Worker RCS flags drawn at layout.rcs, the §3.6 nozzles of the Worker's configuration
 *   15-2 Vapor cone: Worker Mach / pressure ratio drawn as cones at noseShoulder / interstageShoulder (§3.4, §3.5)
 *   15-3 Smoke:      after a self-propelled payload separates and burns, the smoke point is its flame tip (§3.7)
 *   15-4 SRB count:  the CalcRocket separation, the drawing and the HUD follow one count rule (§3.1, R8)
 *   15-5 Save:       non-finite SRB values of a save (1e999) agree between the main thread and the Worker (§3.1)
 *   15-6 Caches:     no getCelestial name search per update; a pre-66d3687 save keeps the per-frame readers (§3.11)
 * Expected values come from the design formulas and tables, evaluated here from the visual configuration's ratios,
 * not from the implementation's output.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { setupMockDOM, createMockUniverse } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { PredictorPhysicsEngine } from '../../scripts/gravsim_calc_predictor.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { ObjectPlacer } from '../../scripts/gravsim_object_placer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { CelestialBody } from '../../scripts/gravsim_object.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { NaviTab } from '../../scripts/gravsim_tab_navi.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';
import { OBJECT_TYPES, PHYSICS, RENDER } from '../../scripts/gravsim_const.js';

/** Only the main thread registers tests; a worker thread of this file runs one scenario (15-4, the hang guard). */
const describeMain = isMainThread ? describe : () => {};

/*******************************************************************
 * Configuration (the design's inputs)
 *******************************************************************/
const VIS = presetManager.getRocketVisual();
const M = VIS.MODULES;
const AL = VIS.ALIGNMENT;
const RCS_CFG = VIS.COLD_GAS_RCS;
const VC = VIS.VAPOR_CONE;
const LOD = VIS.LOW_DETAIL;
const EARTH_PARAM = presetManager.getObjectParam('Earth');
const DT = 0.05; // s, Worker sub-step
const SUB_STEPS = 10;
const FRAME_S = DT * SUB_STEPS;
const R_DRAW = 30; // px, high detail
const R_LOW = 3; // px, below LOD_RADIUS_THRESHOLD: low detail
const TOL_PX = 1e-9;
const SRB_BURN_S = 6; // a short SRB burn keeps the count flights short
const SRB_CASING_STOPS = (casing) => [[0, '#ffffff'], [0.35, casing], [1, '#8c95a0']];
/** §3.7: vacuum stretch k of the plume per fuel; unknown fuels draw as liquid */
const DESIGN_VACUUM_STRETCH = { hydro: 0.15, solid: 0.12, ion: 0, liquid: 0.15 };
const SRB_TAG = /\[(\+SRB|SRB BURNOUT|SRB SEP)\]$/;
const ISOLATED_TIMEOUT_MS = 60000;

/*******************************************************************
 * App harness: main thread <-> structured-clone Worker boundary
 *******************************************************************/
const createApp = () => {
	EventBus.clearAll();
	const controller = new SimulationController();
	const sent = [];
	const workerManager = {
		postMessage(msg) {
			if (msg.cmd === 'returnBuffer') return; // the buffer pool is outside these tests
			const data = structuredClone(msg); // the Worker boundary copies messages
			sent.push(data);
			controller.handleMessage({ data });
		}
	};
	// As Universe: the Worker gets the celestial parameter table first
	workerManager.postMessage({ cmd: 'initDefinitions', celestialParams: presetManager.getObjectParamsMap() });
	const om = new ObjectManager(null, workerManager);
	const universe = createMockUniverse();
	Object.defineProperty(universe, 'objects', { get: () => om.objects, configurable: true });
	universe.ObjectManager = om;
	universe.addObject = (o) => om.addObject(o);
	universe.getObjectParams = (name) => presetManager.getObjectParam(name); // Universe.getObjectParams
	universe.ObjectPlacer = new ObjectPlacer(universe);
	return { controller, engine: controller.engine, workerManager, om, universe, sent };
};

const addEarth = (app) => {
	const earth = new CelestialBody(app.om.getNextId(), 'Earth', 0, 0, 0, 0, EARTH_PARAM.MASS, '#1E90FF', 1, EARTH_PARAM.RADIUS, 0, null, 0);
	earth.param = EARTH_PARAM;
	app.om.addObject(earth);
	return earth;
};

/** Rocket tab -> Rollout of a preset onto a host; mutate edits the launcher configuration first. */
const rolloutVehicle = (app, host, ids, mutate = () => {}, { predict = false } = {}) => {
	const launcher = new RocketLauncher(app.universe);
	app.universe.RocketLauncher = launcher;
	launcher.mode = 'host';
	launcher.hostId = host.id;
	presetManager.applyToLauncher(launcher, ids);
	mutate(launcher);
	if (!predict) {
		launcher.updatePredictionSync = () => null;
		launcher.updatePrediction = () => null;
	}
	launcher.rollout();
	const main = app.om.objects.find(o => o.id === launcher.rolloutedRocketId);
	assert.ok(main && main.type === OBJECT_TYPES.ROCKET, 'rollout placed a rocket');
	return { launcher, main };
};

/** LaunchSequencer at liftoff: 'rocket:update-state' -> ObjectManager.updateRocketState -> Worker 'setRocketState'. */
const release = (main) => EventBus.emit('rocket:update-state', main.id, true, false);

const workerOf = (app, id) => app.engine.objects.find(o => o.id === id);

/** Fixed-step replica of SimulationController.update() and the main thread's handling of the frame. */
const stepFrame = (app, onSubStep = null) => {
	const e = app.engine;
	e._categorizeBodies();
	e._buildQuadTree(FRAME_S);
	e._checkCollisions(FRAME_S);
	e._checkRocheLimit();
	for (let i = 0; i < SUB_STEPS; i++) {
		e._moveObjects(DT);
		if (onSubStep) onSubStep();
	}
	e._updateEscapeStatus();
	const buf = WorkerBridge.formatWorkerToMain(e.objects);
	app.om.updateObjectParams({ objectsData: buf.buffer, validLength: buf.length, syncSeq: app.controller.syncSeq });
	e.removeDeadObjects();
};

/** Counts the name searches (deep copies) of the shared preset manager, which the Worker engine and the main thread use. */
const spyGetCelestial = () => {
	const own = Object.prototype.hasOwnProperty.call(presetManager, 'getCelestial');
	const orig = presetManager.getCelestial;
	const spy = { count: 0, names: [] };
	presetManager.getCelestial = function (...args) {
		spy.count++;
		spy.names.push(args[0]);
		return orig.apply(this, args);
	};
	spy.restore = () => {
		if (own) { presetManager.getCelestial = orig; } else { delete presetManager.getCelestial; }
	};
	return spy;
};

/** Changes a preset table without changing a value (Map.set of the same record): every shared snapshot is rebuilt. */
const coldPresetCaches = () => {
	const [key, value] = presetManager.celestials.entries().next().value;
	presetManager.celestials.set(key, value);
};

/*******************************************************************
 * Recording canvas and decoders
 *******************************************************************/
const createRecordingCtx = () => {
	const fills = [];
	const calls = [];
	const stack = [];
	let path = [];
	const gradient = (kind, args) => {
		const g = { kind, args, stops: [], addColorStop(o, c) { g.stops.push([o, c]); } };
		return g;
	};
	const target = {
		fills, calls,
		fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, shadowColor: '', shadowBlur: 0,
		lineCap: 'butt', lineJoin: 'miter', font: '', textAlign: 'left', textBaseline: 'alphabetic', globalCompositeOperation: 'source-over',
		save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha }); },
		restore() { const s = stack.pop(); if (s) Object.assign(this, s); },
		beginPath() { path = []; },
		closePath() { path.push({ op: 'closePath' }); },
		moveTo(x, y) { path.push({ op: 'moveTo', x, y }); },
		lineTo(x, y) { path.push({ op: 'lineTo', x, y }); },
		quadraticCurveTo(cpx, cpy, x, y) { path.push({ op: 'quad', cpx, cpy, x, y }); },
		bezierCurveTo(a, b, c, d, x, y) { path.push({ op: 'bezier', x, y }); },
		arc(x, y, r) { path.push({ op: 'arc', x, y, r }); },
		ellipse(x, y, rx, ry) { path.push({ op: 'ellipse', x, y, rx, ry }); },
		rect(x, y, w, h) { path.push({ op: 'rect', x, y, w, h }); },
		roundRect(x, y, w, h) { path.push({ op: 'rect', x, y, w, h }); },
		fill() { fills.push({ style: this.fillStyle, path: path.slice() }); },
		fillRect(x, y, w, h) { fills.push({ style: this.fillStyle, path: [{ op: 'rect', x, y, w, h }] }); },
		createLinearGradient(...a) { return gradient('linear', a); },
		createRadialGradient(...a) { return gradient('radial', a); },
		translate() {}, rotate() {}, scale() {}, setTransform() {}, transform() {}, clip() {},
		stroke() {}, strokeRect() {}, clearRect() {}, setLineDash() {}, getLineDash() { return []; },
		measureText(t) { return { width: String(t ?? '').length * 8 }; }, fillText() {}, strokeText() {}, drawImage() {}
	};
	// Every call and every property write, in order (used to compare two drawings command by command)
	return new Proxy(target, {
		get(t, k) {
			const v = t[k];
			if (typeof v === 'function' && typeof k === 'string') {
				return (...args) => { calls.push([k, ...args]); return v.apply(t, args); };
			}
			return v;
		},
		set(t, k, v) {
			calls.push([`=${String(k)}`, v]);
			t[k] = v;
			return true;
		}
	});
};
const serializeCalls = (ctx) => JSON.stringify(ctx.calls);

/** Drawn RCS jets: the mist triangle of _drawRcsPlume (apex = nozzle, axis = jet direction, side = plume length). */
const extractJets = (ctx) => ctx.fills.filter(f => f.style === RCS_CFG.MIST_COLOR).map(f => {
	const [apex, a, b] = f.path;
	const mx = (a.x + b.x) / 2 - apex.x;
	const my = (a.y + b.y) / 2 - apex.y;
	const n = Math.hypot(mx, my);
	return { x: apex.x, y: apex.y, ux: mx / n, uy: my / n, len: Math.hypot(a.x - apex.x, a.y - apex.y) };
});
/** Drawn vapor cones: vertex, length, half width and the inner radius of the radial gradient. */
const extractCones = (ctx) => ctx.fills
	.filter(f => f.style && f.style.kind === 'radial' && f.style.stops.some(s => s[1] === VC.CORE_COLOR))
	.map(f => ({ x: f.path[0].x, coneLen: f.path[0].x - f.path[1].x, halfW: f.path[2].y, innerR: f.style.args[2] }));
/** Drawn SRB casings (the body rectangle with the casing gradient of _drawBoosters). */
const extractSrbBodies = (ctx, casing) => ctx.fills.filter(f => f.style && f.style.kind === 'linear'
	&& JSON.stringify(f.style.stops) === JSON.stringify(SRB_CASING_STOPS(casing)) && f.path[0]?.op === 'rect')
	.map(f => ({ x: f.path[0].x, y: f.path[0].y + f.path[0].h / 2, w: f.path[0].w, rB: f.path[0].h / 2 }));

const drawHigh = (rocket, R = R_DRAW) => {
	const ctx = createRecordingCtx();
	RocketRenderer.draw(ctx, rocket, 0, 0, R, 1.0);
	return ctx;
};
const lowDetailWidth = (rocket) => {
	const ctx = createRecordingCtx();
	RocketRenderer.draw(ctx, rocket, 0, 0, R_LOW, 1.0);
	const body = ctx.fills.find(f => f.path[0]?.op === 'ellipse');
	assert.ok(body, 'the low detail draws the body ellipse');
	return body.path[0].ry * 2;
};

const assertNear = (actual, expected, tol, msg) => {
	assert.ok(Number.isFinite(actual), `${msg}: expected a finite number, got ${actual}`);
	assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected}, got ${actual} (|diff| ${Math.abs(actual - expected)} > ${tol})`);
};
const assertNozzlesEqual = (actual, expected, msg) => {
	assert.equal(actual.length, expected.length, `${msg}: nozzle count`);
	for (const [i, e] of expected.entries()) {
		for (const k of ['x', 'y', 'ux', 'uy']) {
			assertNear(actual[i][k], e[k], TOL_PX, `${msg}: nozzle ${i} ${k}`);
		}
	}
};
/** Drawn jets are exactly the layout.rcs nozzles of the set flags (§3.6: drawColdGasRcs draws layout.rcs). */
const nozzlesOf = (rcs, flags) => (rcs ? [
	...(flags.cw ? rcs.cw : []),
	...(flags.ccw ? rcs.ccw : []),
	...(flags.ullage ? rcs.ullage : [])
] : []);
const assertJetsMatch = (jets, nozzles, plumeLen, msg) => {
	assert.equal(jets.length, nozzles.length, `${msg}: jet count`);
	const pool = jets.slice();
	for (const n of nozzles) {
		const idx = pool.findIndex(p => Math.abs(p.x - n.x) <= TOL_PX && Math.abs(p.y - n.y) <= TOL_PX
			&& Math.abs(p.ux - n.ux) <= TOL_PX && Math.abs(p.uy - n.uy) <= TOL_PX);
		assert.ok(idx >= 0, `${msg}: no jet at (${n.x}, ${n.y}) towards (${n.ux}, ${n.uy}); drawn ${JSON.stringify(jets)}`);
		assertNear(pool[idx].len, plumeLen, 1e-9, `${msg}: plume length`);
		pool.splice(idx, 1);
	}
};

/*******************************************************************
 * Design oracles
 *******************************************************************/
/** §3.1: SRB count of a configuration (Delta II's 9 is the cap). */
const designBoosterCount = (b) => {
	if (!b) return 0;
	const count = Number(b.count);
	if (Number.isFinite(count) && count >= 1) return Math.min(9, Math.floor(count));
	const burn = Number(b.burnTimeSec);
	return (Number.isFinite(burn) && burn > 0) ? 2 : 0;
};

/** The configuration the Worker's CalcRocket flies (the source of every synchronised flag). */
const configOf = (w) => ({
	totalStg: w.totalStages,
	curStg: w.currentStageIndex,
	payloadOnly: Boolean(w.isPayloadSeparated),
	fairingConfigured: Boolean(w.fairing?.enabled),
	fairingAttached: Boolean(w.fairing?.enabled && !w.fairing?.isSeparated),
	boosters: w.boosters ? JSON.parse(JSON.stringify(w.boosters)) : null,
	boostersSeparated: Boolean(w.isBoosterSeparated) // not an input of the geometry (§3.6: the configuration decides)
});

/** §3.2 table: the drawn stack (segments nose to tail), the fairing and the exposed payload at screen radius R. */
const designStack = (cfg, R) => {
	const r1 = R * M.STAGE1_RADIUS_RATIO;
	const l1 = R * M.STAGE1_LENGTH_RATIO;
	const r2 = R * M.STAGE2_RADIUS_RATIO;
	const l2 = R * M.STAGE2_LENGTH_RATIO;
	const r3 = R * M.STAGE3_RADIUS_RATIO;
	const l3 = R * M.STAGE3_LENGTH_RATIO;
	const lInter = R * M.INTERSTAGE_LENGTH_RATIO;
	const lInter2 = R * M.INTERSTAGE2_LENGTH_RATIO;
	const lFairing = R * M.FAIRING_LENGTH_RATIO;
	const stage = (index, x0, r, len) => ({ kind: 'stage', index, x0, r, len });
	const inter = (x0, r, len) => ({ kind: 'interstage', x0, r, len });
	let segs;
	let fairingX;
	let fairingR;
	let payloadR;
	if (cfg.totalStg === 1) {
		const s1 = R * AL.BASE_X_SINGLE_STAGE_RATIO;
		segs = [stage(0, s1, r1, l1)];
		fairingX = s1 + l1;
		fairingR = r1;
		payloadR = r1;
	} else if (cfg.totalStg >= 3) {
		fairingR = r2;
		payloadR = r3;
		if (cfg.curStg === 0) {
			const s1 = R * AL.BASE_X_3STG_STAGE1_RATIO;
			const i1 = s1 + l1;
			const s2 = i1 + lInter;
			const i2 = s2 + l2;
			const s3 = i2 + lInter2;
			segs = [stage(2, s3, r3, l3), inter(i2, r2, lInter2), stage(1, s2, r2, l2), inter(i1, r1, lInter), stage(0, s1, r1, l1)];
			fairingX = s3 + l3;
		} else if (cfg.curStg === 1) {
			const s2 = R * AL.BASE_X_3STG_STAGE2_RATIO;
			const i2 = s2 + l2;
			const s3 = i2 + lInter2;
			segs = [stage(2, s3, r3, l3), inter(i2, r2, lInter2), stage(1, s2, r2, l2)];
			fairingX = s3 + l3;
		} else {
			const s3 = R * AL.BASE_X_3STG_STAGE3_RATIO;
			segs = [stage(2, s3, r3, l3)];
			fairingX = s3 + l3;
		}
	} else {
		fairingR = r2;
		payloadR = r2;
		if (cfg.curStg === 0) {
			const s2 = R * AL.BASE_X_STAGE1_RATIO;
			const i1 = s2 - lInter;
			const s1 = i1 - l1;
			segs = [stage(1, s2, r2, l2), inter(i1, r1, lInter), stage(0, s1, r1, l1)];
			fairingX = s2 + l2;
		} else {
			const s2 = R * AL.BASE_X_UPPER_RATIO;
			segs = [stage(1, s2, r2, l2)];
			fairingX = s2 + l2;
		}
	}
	const fairingCfg = cfg.fairingConfigured ? { x0: fairingX, r: fairingR, len: lFairing } : null;
	return {
		segs,
		fairing: cfg.fairingAttached ? fairingCfg : null,
		fairingCfg,
		payload: cfg.fairingAttached ? null : { cx: fairingX + lFairing * AL.PAYLOAD_OFFSET_RATIO, r: payloadR }
	};
};

/** §3.2 (payload alone): the deployed bus of the payload's radius (r1 / r2 / r3 by the stage count). */
const designPayloadBus = (totalStg, R) => {
	const r = totalStg === 1 ? R * M.STAGE1_RADIUS_RATIO : (totalStg >= 3 ? R * M.STAGE3_RADIUS_RATIO : R * M.STAGE2_RADIUS_RATIO);
	return { r, a: 0.5 * r * M.SATELLITE_BUS_W_RATIO, b: 0.5 * r * M.SATELLITE_BUS_H_RATIO };
};

/** §3.3: SRB placement beside stage 1 (2: one each side, 4: pairs, else alternating tiers). */
const designBoosterLayout = (b, n, stage1, R) => {
	if (n <= 0) return null;
	const rB = R * (b.radiusRatio || 0.26);
	const lB = R * (b.lengthRatio || 1.70);
	const yOffset = stage1.r + rB * (b.offsetYRatio || 0.95);
	const xBase = stage1.x0 + stage1.len * (b.attachOffsetXRatio || 0.12);
	let ys;
	if (n === 2) {
		ys = [-yOffset, yOffset];
	} else if (n === 4) {
		const gap = rB * (b.pairSpacingRatio || 0.35);
		ys = [-yOffset - gap, -yOffset + gap, yOffset - gap, yOffset + gap];
	} else {
		ys = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? -1 : 1) * (yOffset + Math.floor(i / 2) * rB * 0.7));
	}
	return { rB, lB, xBase, lNozzleB: R * (b.nozzleLengthRatio || 0.20), lNoseB: R * (b.noseConeLengthRatio || 0.35), ys };
};

const ullageDir = (sign) => ({ ux: -Math.cos(RCS_CFG.ULLAGE_CANT_RAD), uy: sign * Math.sin(RCS_CFG.ULLAGE_CANT_RAD) });

/**
 * §3.6.1: lateral nozzles on the wall of the current stage, at FWD / AFT of the foremost / aftmost free stretch left
 * by the parts standing out of the wall (fins, SRBs, a wider neighbour), each widened by min(e, plumeLen) tan(spread).
 */
const designStackRcs = (stack, boosterLayout) => {
	const body = stack.segs[stack.segs.length - 1];
	const h = body.r;
	const plumeLen = Math.max(RCS_CFG.MIN_PLUME_PX, h * RCS_CFG.PLUME_LEN_WIDTH_RATIO);
	const tanSpread = Math.tan(RCS_CFG.PLUME_SPREAD_RAD);
	const parts = [];
	if (body.index === 0) {
		parts.push([body.x0, body.x0 + body.len * M.FIN_BASE_RATIO, body.r * M.FIN_SPAN_RATIO]);
		if (boosterLayout) {
			const outer = Math.max(...boosterLayout.ys.map(Math.abs)) + boosterLayout.rB;
			parts.push([boosterLayout.xBase - boosterLayout.lNozzleB, boosterLayout.xBase + boosterLayout.lB + boosterLayout.lNoseB, outer - h]);
		}
	}
	const above = stack.segs.length >= 2 ? stack.segs[stack.segs.length - 2] : null;
	if (above) {
		parts.push([above.x0, above.x0 + above.len, above.r - h]);
	} else if (stack.fairingCfg) {
		parts.push([stack.fairingCfg.x0, stack.fairingCfg.x0 + stack.fairingCfg.len, stack.fairingCfg.r - h]);
	}
	let free = [[body.x0, body.x0 + body.len]];
	for (const [a, b, e] of parts) {
		if (!(e > 0)) continue;
		const m = Math.min(e, plumeLen) * tanSpread;
		free = free.flatMap(([u, v]) => [[u, Math.min(v, a - m)], [Math.max(u, b + m), v]]).filter(([u, v]) => v > u);
	}
	if (free.length === 0) return null;
	free.sort((p, q) => p[0] - q[0]);
	const [fLo, fHi] = free[free.length - 1];
	const [aLo, aHi] = free[0];
	const xF = fLo + (fHi - fLo) * RCS_CFG.FWD_STATION_FRACTION;
	const xA = aLo + (aHi - aLo) * RCS_CFG.AFT_STATION_FRACTION;
	return {
		plumeLen, h, xF, xA, free,
		cw: [{ x: xF, y: -h, ux: 0, uy: -1 }, { x: xA, y: h, ux: 0, uy: 1 }],
		ccw: [{ x: xF, y: h, ux: 0, uy: 1 }, { x: xA, y: -h, ux: 0, uy: -1 }],
		ullage: [{ x: xA, y: h, ...ullageDir(1) }, { x: xA, y: -h, ...ullageDir(-1) }]
	};
};

/** §3.6.2: axial nozzles at the four corners of the deployed bus. */
const designPayloadRcs = ({ a, b }) => ({
	plumeLen: Math.max(RCS_CFG.MIN_PLUME_PX, b * RCS_CFG.PLUME_LEN_WIDTH_RATIO),
	cw: [{ x: -a, y: -b, ux: -1, uy: 0 }, { x: a, y: b, ux: 1, uy: 0 }],
	ccw: [{ x: -a, y: b, ux: -1, uy: 0 }, { x: a, y: -b, ux: 1, uy: 0 }],
	ullage: [{ x: -a, y: b, ...ullageDir(1) }, { x: -a, y: -b, ...ullageDir(-1) }]
});

/** The design anchors (§3.4) and SRB placement (§3.3) of a configuration at screen radius R. */
const designFor = (cfg, R) => {
	if (cfg.payloadOnly) {
		const bus = designPayloadBus(cfg.totalStg, R);
		return { nose: { x: bus.a, h: bus.b }, inter: null, rcs: designPayloadRcs(bus), boosters: null };
	}
	const stack = designStack(cfg, R);
	const stage1 = stack.segs.find(s => s.kind === 'stage' && s.index === 0) || null;
	const boosters = stage1 ? designBoosterLayout(cfg.boosters, designBoosterCount(cfg.boosters), stage1, R) : null;
	const nose = stack.fairing
		? { x: stack.fairing.x0, h: stack.fairing.r }
		: { x: stack.payload.cx + 0.5 * stack.payload.r * M.SATELLITE_BUS_W_RATIO, h: 0.5 * stack.payload.r * M.SATELLITE_BUS_H_RATIO };
	const iInter = stack.segs.findIndex(s => s.kind === 'interstage');
	const inter = iInter > 0 ? { x: stack.segs[iInter - 1].x0, h: stack.segs[iInter].r } : null;
	return { stack, nose, inter, rcs: designStackRcs(stack, boosters), boosters };
};

const assertRcsDesign = (rcs, design, msg) => {
	if (!design) {
		assert.equal(rcs, null, `${msg}: no free wall -> layout.rcs is null`);
		return;
	}
	assert.ok(rcs, `${msg}: layout.rcs exists`);
	assertNear(rcs.plumeLen, design.plumeLen, TOL_PX, `${msg}: plumeLen`);
	for (const k of ['cw', 'ccw', 'ullage']) {
		assertNozzlesEqual(rcs[k], design[k], `${msg}: ${k}`);
	}
};
const assertAnchorDesign = (anchor, design, msg) => {
	if (!design) {
		assert.equal(anchor, null, `${msg}: none`);
		return;
	}
	assert.ok(anchor, `${msg}: present`);
	assertNear(anchor.x, design.x, TOL_PX, `${msg}: x`);
	assertNear(anchor.halfWidth, design.h, TOL_PX, `${msg}: halfWidth`);
};

/** §4.4 of the 2026-11-20 design (unchanged): intensity and Mach angle of the vapor cone. */
const designVapor = (mach, pres) => {
	if (!Number.isFinite(mach) || !Number.isFinite(pres) || mach < 0.82 || mach > 1.22 || pres <= 0.015) {
		return { active: false, intensity: 0, machAngleRad: Math.PI / 2 };
	}
	const span = (mach <= 1.0) ? (1.0 - 0.82) : (1.22 - 1.0);
	const u = Math.max(0, 1 - Math.abs(mach - 1.0) / Math.max(0.01, span));
	const intensity = u * u * (3 - 2 * u) * Math.min(1, Math.max(0, (pres - 0.015) / 0.25));
	return { active: intensity > 0.01, intensity, machAngleRad: Math.asin(Math.min(0.96, 1 / Math.max(1 / 0.96, mach))) };
};
/** §3.5: the cones of a vapor state at the design anchors (primary at the nose shoulder, secondary at the interstage). */
const designCones = (design, mach, pres) => {
	const v = designVapor(mach, pres);
	if (!v.active) return [];
	const cones = [{ anchor: design.nose, s: 1.0 }];
	if (design.inter && v.intensity >= VC.SECONDARY_INTENSITY_MIN) cones.push({ anchor: design.inter, s: 0.78 });
	return cones.map(({ anchor, s }) => ({
		x: anchor.x,
		coneLen: anchor.h * VC.CONE_LENGTH_RATIO * (0.75 + 0.5 * v.intensity) * s,
		halfW: Math.min(anchor.h * VC.MAX_WIDTH_MULTIPLIER, anchor.h * (1.1 + 1.35 * v.intensity * Math.sin(v.machAngleRad))) * s,
		innerR: anchor.h * 0.15 * s
	}));
};
const assertConesDesign = (cones, expected, msg) => {
	assert.equal(cones.length, expected.length, `${msg}: cone count`);
	for (const [i, e] of expected.entries()) {
		for (const k of ['x', 'coneLen', 'halfW', 'innerR']) {
			assertNear(cones[i][k], e[k], TOL_PX, `${msg}: cone ${i} ${k}`);
		}
	}
};

/** §3.7: nominal (flicker-free) plume length _drawPlume draws for a stage / payload scale. */
const designPlumeLength = (R, scale, throttle, fuelType, pres) => {
	const cfg = VIS.PLUMES[fuelType] || VIS.PLUMES.liquid;
	const p = Math.max(0, Math.min(1, pres));
	const k = DESIGN_VACUUM_STRETCH[fuelType] ?? DESIGN_VACUUM_STRETCH.liquid;
	return R * cfg.lenMult * scale * throttle * (1 + (1 - p) * k);
};

/*******************************************************************
 * Recorded flights (shared by 15-1 and 15-2)
 *******************************************************************/
const FLIGHT_FRAMES = 700; // 350 s: SRB, fairing and stage separations of every preset
const flights = new Map();
const flyPreset = (vehicleId, payloadId, missionId) => {
	const key = `${vehicleId}/${payloadId}/${missionId}`;
	if (flights.has(key)) return flights.get(key);
	const app = createApp();
	const earth = addEarth(app);
	const { main } = rolloutVehicle(app, earth, { vehicleId, payloadId, missionId });
	const w = workerOf(app, main.id);
	release(main);
	const frames = [];
	for (let f = 0; f < FLIGHT_FRAMES; f++) {
		stepFrame(app);
		const flags = { cw: main.rcsCw, ccw: main.rcsCcw, ullage: main.rcsUllage };
		const vapor = designVapor(main.mach, main.ambientPresRatio);
		const rec = {
			f, t: w.flightComputer.flightTime, cfg: configOf(w), flags, mach: main.mach, pres: main.ambientPresRatio,
			workerMach: w.mach, workerPres: w.ambientPresRatio,
			layout: RocketRenderer._computeVisualLayout(main, R_DRAW, VIS)
		};
		if (flags.cw || flags.ccw || flags.ullage || vapor.active) {
			const ctx = drawHigh(main);
			rec.jets = extractJets(ctx);
			rec.cones = extractCones(ctx);
		}
		if (flags.cw || flags.ccw || flags.ullage) {
			// The LOD boundary of the same synchronised state: the threshold radius (high detail) and just below it
			const rLod = VIS.LOD_RADIUS_THRESHOLD;
			rec.lod = {
				layout: RocketRenderer._computeVisualLayout(main, rLod, VIS),
				jets: extractJets(drawHigh(main, rLod)),
				jetsBelow: extractJets(drawHigh(main, rLod * (1 - 1e-12)))
			};
		}
		frames.push(rec);
	}
	const flight = { app, main, worker: w, frames };
	flights.set(key, flight);
	return flight;
};
const PRESET_FLIGHTS = [
	['h3_22', 'earth_obs', 'leo_250km'],
	['h3_24', 'earth_obs', 'leo_250km'],
	['falcon9', 'earth_obs', 'leo_250km'],
	['epsilon', 'asnaro_2', 'leo_250km'],
	['ssto', 'htv_x', 'iss_rendezvous']
];

/*******************************************************************
 * 15-4 scenario (also run in a worker thread with a timeout)
 *******************************************************************/
const SRB_MAX_FRAMES = 40; // 20 s: separation of a 6 s SRB burn (+1.5 s delay) comes at about 7.5 s
const buildBoosters = (base, { patch = {}, drop = [], replace } = {}) => {
	if (replace !== undefined) return replace;
	const b = { ...base, ...patch };
	for (const k of drop) delete b[k];
	return b;
};
const summarizeSrbFlight = (app, main, w, maxFrames) => {
	const casing = main.boosters?.casingColor || '#f0f2f5';
	stepFrame(app); // a held frame: the telemetry of the pad
	const before = {
		hud: TelemetryPanel.formatStageInfo(main, main.telemetry),
		srbs: extractSrbBodies(drawHigh(main), casing),
		lowWidth: lowDetailWidth(main),
		workerHasBoosters: w.hasBoosters
	};
	release(main);
	let frames = 0;
	let sepTime = null;
	const onSubStep = () => { if (sepTime === null && w.isBoosterSeparated) sepTime = w.flightComputer.flightTime; };
	while (!w.isBoosterSeparated && frames < maxFrames) {
		stepFrame(app, onSubStep);
		frames++;
	}
	const workerSrbs = app.engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === 4);
	const mainSrbs = app.om.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === 4);
	return {
		before,
		separated: w.isBoosterSeparated,
		sepTime,
		workerSrbs: workerSrbs.length,
		workerSrbMass: workerSrbs.reduce((s, d) => s + d.mass, 0),
		mainSrbs: mainSrbs.length,
		after: { hud: TelemetryPanel.formatStageInfo(main, main.telemetry), srbs: extractSrbBodies(drawHigh(main), casing).length }
	};
};
const runSrbScenario = ({ vehicleId = 'h3_22', edit = {} }) => {
	const app = createApp();
	const earth = addEarth(app);
	const { main } = rolloutVehicle(app, earth, { vehicleId, payloadId: 'earth_obs', missionId: 'leo_250km' },
		(l) => { l.boosters = buildBoosters(l.boosters, edit); });
	const add = app.sent.find(m => m.cmd === 'add' && m.type === OBJECT_TYPES.ROCKET);
	const w = workerOf(app, main.id);
	const summary = summarizeSrbFlight(app, main, w, SRB_MAX_FRAMES);
	return {
		...summary,
		mainBoosters: main.boosters,
		sentBoosters: add.boosters,
		workerBoosters: w.boosters ? JSON.parse(JSON.stringify(w.boosters)) : null,
		stage1: designStack({ totalStg: 2, curStg: 0, fairingConfigured: true, fairingAttached: true }, R_DRAW).segs[2]
	};
};

/**
 * 15-5 scenario: the save of a rocket on the pad, edited by hand (the tokens become the 1e999 / -1e999 literals of the
 * JSON text), loaded by a fresh page.
 */
const runSaveScenario = ({ patch, drop = [], frames }) => {
	const src = createApp();
	const earth = addEarth(src);
	rolloutVehicle(src, earth, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' });
	stepFrame(src);
	const state = JSON.parse(JSON.stringify(src.om.getState()));
	const rec = state.find(o => o.type === OBJECT_TYPES.ROCKET);
	Object.assign(rec.boosters, patch);
	for (const k of drop) delete rec.boosters[k];
	const text = JSON.stringify(state).replaceAll('"__INF__"', '1e999').replaceAll('"__NINF__"', '-1e999');

	const app = createApp();
	app.om.loadState(JSON.parse(text));
	const main = app.om.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
	const add = app.sent.find(m => m.cmd === 'add' && m.type === OBJECT_TYPES.ROCKET);
	const w = workerOf(app, main.id);
	const loaded = {
		text,
		mainBoosters: { ...main.boosters },
		sentBoosters: add.boosters,
		workerBoosters: w.boosters ? { ...w.boosters } : null
	};
	const summary = summarizeSrbFlight(app, main, w, frames || SRB_MAX_FRAMES);
	return {
		...loaded,
		...summary,
		stage1: designStack({ totalStg: 2, curStg: 0, fairingConfigured: true, fairingAttached: true }, R_DRAW).segs[2]
	};
};

const SCENARIOS = { srbCount: runSrbScenario, saveNonFinite: runSaveScenario };

/**
 * Runs a scenario of this file in a worker thread: an endless loop or a runaway allocation (an SRB count the rules do
 * not cap) fails the test instead of hanging it or exhausting the machine.
 */
const runIsolated = (scenario, arg, timeoutMs) => new Promise((resolve, reject) => {
	const worker = new Worker(new URL(import.meta.url), {
		workerData: { scenario, arg },
		resourceLimits: { maxOldGenerationSizeMb: 384 }
	});
	const timer = setTimeout(() => {
		worker.terminate();
		reject(new Error(`the scenario did not finish within ${timeoutMs} ms (hang)`));
	}, timeoutMs);
	worker.once('message', (msg) => { clearTimeout(timer); worker.terminate(); resolve(msg); });
	worker.once('error', (err) => { clearTimeout(timer); reject(err); });
	worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`the scenario worker exited with code ${code}`)); });
});

/**
 * The SRBs burn out at the first sub-step whose flight time reaches the burn time and separate separationDelaySec
 * (1.5 s, H3) of sub-steps later: within one sub-step of burn + 1.5 s (plus the rounding of the summed sub-steps).
 */
const assertSeparationTime = (sepTime, burnS) => {
	assert.ok(Number.isFinite(sepTime), `the separation sub-step was seen (${sepTime})`);
	assert.ok(sepTime >= burnS + 1.5 - 1e-9 && sepTime <= burnS + 1.5 + DT + 1e-9, `separation at ${sepTime} s for a ${burnS} s burn`);
};

/** Assertions shared by 15-4 and 15-5: the drawing, the HUD and the Worker separation follow the count n. */
const assertSrbAgreement = (s, n, expectedMass, label) => {
	assert.equal(s.before.workerHasBoosters, n > 0, `${label}: CalcRocket.hasBoosters`);
	// Main thread, high detail: n casings at the §3.3 positions
	assert.equal(s.before.srbs.length, n, `${label}: SRBs drawn (high detail)`);
	if (n > 0) {
		const layout = designBoosterLayout(s.mainBoostersForLayout, n, s.stage1, R_DRAW);
		for (const [i, b] of s.before.srbs.entries()) {
			assertNear(b.y, layout.ys[i], TOL_PX, `${label}: SRB ${i} y`);
			assertNear(b.x, layout.xBase, TOL_PX, `${label}: SRB ${i} x`);
			assertNear(b.rB, layout.rB, TOL_PX, `${label}: SRB ${i} radius`);
		}
	}
	// Low detail: the width factor of the same count (2 -> 1.35, 4 or more -> 1.65)
	const mult = n === 2 ? 1.35 : (n >= 4 ? 1.65 : 1.0);
	assertNear(s.before.lowWidth, R_LOW * LOD.WIDTH_RATIO * mult, 1e-12, `${label}: low-detail width`);
	// HUD
	if (n > 0) {
		assert.match(s.before.hud, /\[\+SRB\]$/, `${label}: HUD before the separation`);
	} else {
		assert.doesNotMatch(s.before.hud, SRB_TAG, `${label}: HUD shows no SRB`);
	}
	// Worker separation: the same number of SRBs, on both threads
	assert.equal(s.separated, n > 0, `${label}: the Worker separates SRBs`);
	assert.equal(s.workerSrbs, n, `${label}: SRB debris the CalcRocket separation created`);
	assert.equal(s.mainSrbs, n, `${label}: SRB debris on the main thread`);
	if (n > 0) {
		assertNear(s.workerSrbMass, expectedMass, 1e-9 * expectedMass, `${label}: the SRB debris carry the SRB dry mass`);
		assert.equal(s.after.srbs, 0, `${label}: no SRB drawn after the separation`);
		assert.match(s.after.hud, /\[SRB SEP\]$/, `${label}: HUD after the separation`);
	} else {
		assert.equal(s.after.srbs, 0, `${label}: still no SRB drawn`);
		assert.doesNotMatch(s.after.hud, SRB_TAG, `${label}: HUD still shows no SRB`);
	}
};

/*******************************************************************
 * Pre-66d3687 save (15-6): celestial records without param, debris named outside the table
 *******************************************************************/
const AU_M = PHYSICS.METERS_PER_AU;
const legacySave = () => {
	const px = (m) => UnitConvertUtils.m2pix(m);
	const sun = presetManager.getObjectParam('Sun');
	const moon = presetManager.getObjectParam('Moon');
	const vEarth = Math.sqrt(PHYSICS.G * UnitConvertUtils.ton2kg(sun.MASS) / AU_M);
	const rMoon = 384400e3;
	const vMoon = Math.sqrt(PHYSICS.G * UnitConvertUtils.ton2kg(EARTH_PARAM.MASS) / rMoon);
	const rDeb = EARTH_PARAM.RADIUS + 2000e3;
	const vDeb = Math.sqrt(PHYSICS.G * UnitConvertUtils.ton2kg(EARTH_PARAM.MASS) / rDeb);
	// The fields ObjectManager.getState wrote before 66d3687: no param, no world-center flags, no runtime state
	const body = (id, name, p, x, y, vx, vy, mass, radius) => ({
		id, type: OBJECT_TYPES.CELESTIAL, name, x: px(x), y: px(y), vx: px(vx), vy: px(vy),
		color: p?.COLOR || '#aa8866', size: 5, radius, generation: 0, borderColor: null, borderWidth: 0, mass
	});
	const debris = (id, name, angle) => ({
		id, type: OBJECT_TYPES.DEBRIS, name,
		x: px(AU_M + rDeb * Math.cos(angle)), y: px(rDeb * Math.sin(angle)),
		vx: px(-vDeb * Math.sin(angle)), vy: px(vEarth + vDeb * Math.cos(angle)),
		color: '#c8d0d8', size: 3, radius: 20, generation: 0, borderColor: null, borderWidth: 0, mass: 2.0
	});
	return [
		body(0, 'Sun', sun, 0, 0, 0, 0, sun.MASS, sun.RADIUS),
		body(1, 'Earth', EARTH_PARAM, AU_M, 0, 0, vEarth, EARTH_PARAM.MASS, EARTH_PARAM.RADIUS),
		body(2, 'Moon', moon, AU_M + rMoon, 0, 0, vEarth + vMoon, moon.MASS, moon.RADIUS),
		// A body of a generator (its name is not in the preset table), far out
		body(3, 'Rogue Moonlet', null, 40 * AU_M, 0, 0, 4700, 1e17, 80e3),
		debris(4, 'Old Booster Shell', 2.0),
		debris(5, 'Panel Fragment', 4.0)
	];
};
const NON_TABLE_NAMES = ['Rogue Moonlet', 'Old Booster Shell', 'Panel Fragment'];

/*******************************************************************
 * 15-1 RCS
 *******************************************************************/
describeMain('Integration 15-1: CalcRocket RCS flags -> main thread -> jets at layout.rcs (design §3.6, §5.2)', () => {
	for (const [vehicleId, payloadId, missionId] of PRESET_FLIGHTS) {
		it(`${vehicleId}: every frame with a synchronised RCS flag draws the jets at layout.rcs, the §3.6 nozzles of the Worker's configuration`, () => {
			const { frames } = flyPreset(vehicleId, payloadId, missionId);
			const jetFrames = frames.filter(r => r.flags.cw || r.flags.ccw || r.flags.ullage);
			assert.ok(jetFrames.length >= 3, `${vehicleId}: the flight sets RCS flags (${jetFrames.length} frames)`);
			const seen = new Set();
			for (const r of jetFrames) {
				const msg = `${vehicleId} t ${r.t} (stage ${r.cfg.curStg}, fairing ${r.cfg.fairingAttached ? 'on' : 'off'}, SRBs ${r.cfg.boostersSeparated ? 'off' : 'on'})`;
				const design = designFor(r.cfg, R_DRAW).rcs;
				assertJetsMatch(r.jets, nozzlesOf(design, r.flags), design.plumeLen, `${msg}: drawn jets at the design nozzles`);
				assertRcsDesign(r.layout.rcs, design, `${msg}: layout.rcs`);
				assertJetsMatch(r.jets, nozzlesOf(r.layout.rcs, r.flags), r.layout.rcs.plumeLen, `${msg}: drawn jets are layout.rcs`);
				seen.add(`${r.cfg.curStg}${r.flags.ullage ? 'u' : ''}`);
			}
			const expectedSeen = {
				h3_22: ['0', '1u'], h3_24: ['0', '1u'], falcon9: ['1u'], epsilon: ['1u', '2u'], ssto: ['0']
			}[vehicleId];
			for (const k of expectedSeen) {
				assert.ok(seen.has(k), `${vehicleId}: jets on stage index ${k[0]}${k[1] ? ' with ullage' : ''} (${[...seen]})`);
			}
		});
	}

	it('regression: H3-22 / H3-24 first-stage nozzles clear the SRBs and match the §3.4 table (0.012 / -0.152 R and 0.018 / -0.124 R at 0.700 R)', () => {
		for (const [vehicleId, fwd, aft] of [['h3_22', 0.012, -0.152], ['h3_24', 0.018, -0.124]]) {
			const { frames } = flyPreset(vehicleId, 'earth_obs', 'leo_250km');
			const r = frames.find(fr => fr.cfg.curStg === 0 && (fr.flags.cw || fr.flags.ccw));
			assert.ok(r, `${vehicleId}: first-stage jets after the SRB separation`);
			// The drawn lateral jets: one forward and one aft station on the first-stage wall
			const lateral = r.jets.filter(j => Math.abs(j.ux) < 1e-12);
			assert.equal(lateral.length, 2, `${vehicleId}: a CW or CCW couple is drawn`);
			const xs = lateral.map(j => j.x / R_DRAW).sort((a, b) => b - a);
			assertNear(xs[0], fwd, 5e-4, `${vehicleId}: drawn forward nozzle (§3.4 table)`);
			assertNear(xs[1], aft, 5e-4, `${vehicleId}: drawn aft nozzle (§3.4 table)`);
			for (const j of lateral) assertNear(Math.abs(j.y) / R_DRAW, 0.7, 1e-12, `${vehicleId}: on the wall of the first stage`);
			// The jet triangles stay forward of the SRB nose cones (the former 0.14 L station was on the casing)
			const srb = designFor(r.cfg, R_DRAW).boosters;
			const margin = (Math.max(...srb.ys.map(Math.abs)) + srb.rB - 0.7 * R_DRAW) * Math.tan(RCS_CFG.PLUME_SPREAD_RAD);
			for (const j of r.jets) {
				assert.ok(j.x >= srb.xBase + srb.lB + srb.lNoseB + margin - 1e-9, `${vehicleId}: jet at ${j.x} px is clear of the SRBs`);
			}
		}
	});

	it('the SRB and fairing separations never move a nozzle: over each flight layout.rcs changes only with the current stage', () => {
		for (const [vehicleId, payloadId, missionId] of PRESET_FLIGHTS) {
			const { frames } = flyPreset(vehicleId, payloadId, missionId);
			const byStage = new Map();
			let fairingSeps = 0;
			let srbSeps = 0;
			for (const [i, r] of frames.entries()) {
				assert.ok(r.layout.rcs, `${vehicleId} t ${r.t}: layout.rcs (every preset stage has a free wall)`);
				const rcs = JSON.stringify(r.layout.rcs);
				if (!byStage.has(r.cfg.curStg)) byStage.set(r.cfg.curStg, rcs);
				assert.equal(rcs, byStage.get(r.cfg.curStg), `${vehicleId} t ${r.t}: the nozzles of stage index ${r.cfg.curStg}`);
				const prev = i > 0 ? frames[i - 1].cfg : null;
				if (prev && prev.curStg === r.cfg.curStg && prev.fairingAttached && !r.cfg.fairingAttached) fairingSeps++;
				if (prev && prev.curStg === r.cfg.curStg && !prev.boostersSeparated && r.cfg.boostersSeparated) srbSeps++;
			}
			assert.equal(fairingSeps, 1, `${vehicleId}: the flight separates the fairing within a stage`);
			assert.equal(srbSeps, vehicleId.startsWith('h3_2') ? 1 : 0, `${vehicleId}: SRB separations within a stage`);
		}
	});

	it('payload alone (sep_payload at liftoff): the settle-timer jets come from the four bus corners, axial (§3.6.2)', () => {
		const app = createApp();
		const earth = addEarth(app);
		const { main } = rolloutVehicle(app, earth, { vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'iss_rendezvous' },
			(l) => { l.flightProfile.push({ type: 'time', value: 0, thrust: 100, angle: 90, action: 'sep_payload' }); });
		const w = workerOf(app, main.id);
		release(main);
		let jetFrames = 0;
		for (let f = 0; f < 12; f++) {
			stepFrame(app);
			assert.equal(w.isPayloadSeparated, true, 'input: the payload flies alone from the first frame');
			const flags = { cw: main.rcsCw, ccw: main.rcsCcw, ullage: main.rcsUllage };
			const design = designFor(configOf(w), R_DRAW).rcs;
			const jets = extractJets(drawHigh(main));
			assertJetsMatch(jets, nozzlesOf(design, flags), design.plumeLen, `frame ${f}: drawn jets at the bus corners`);
			const layout = RocketRenderer._computeVisualLayout(main, R_DRAW, VIS);
			assertRcsDesign(layout.rcs, design, `frame ${f}: corner nozzles`);
			assertJetsMatch(jets, nozzlesOf(layout.rcs, flags), layout.rcs.plumeLen, `frame ${f}: drawn jets are layout.rcs`);
			if (jets.length > 0) jetFrames++;
		}
		assert.ok(jetFrames > 0, `the separation settle timer fires the payload's jets (${jetFrames} frames)`);
		const bus = designPayloadBus(2, 1);
		assertNear(bus.a, 0.455, 1e-12, '§3.4 table: corner x of the 2-stage payload');
		assertNear(bus.b, 0.5525, 1e-12, '§3.4 table: corner y of the 2-stage payload');
	});

	it('boundary: at the LOD threshold (R = 4) the shortest free stretch (H3-24, 0.202 R) still splits the jets; just below it nothing is drawn', () => {
		const { frames } = flyPreset('h3_24', 'earth_obs', 'leo_250km');
		const lodFrames = frames.filter(r => r.lod);
		assert.ok(lodFrames.some(r => r.cfg.curStg === 0), 'input: first-stage frames with jets');
		const R = VIS.LOD_RADIUS_THRESHOLD;
		for (const r of lodFrames) {
			const design = designFor(r.cfg, R).rcs;
			assertJetsMatch(r.lod.jets, nozzlesOf(design, r.flags), design.plumeLen, `t ${r.t}: jets at R = ${R}`);
			assertRcsDesign(r.lod.layout.rcs, design, `t ${r.t}: layout.rcs at R = ${R}`);
			assert.equal(r.lod.jetsBelow.length, 0, `t ${r.t}: low detail just below the threshold draws no jet`);
			if (r.cfg.curStg === 0) {
				const shortest = Math.min(...design.free.map(([u, v]) => v - u));
				assertNear(shortest / R, 0.202, 5e-4, 'the shortest free stretch (§3.6.1)');
				assert.ok(design.xF - design.xA >= 0.70 * (design.free[0][1] - design.free[0][0]) - 1e-12, 'forward and aft nozzles 0.70 |F| apart');
			}
		}
	});

	it('abnormal: an SRB that covers the whole first stage leaves no free wall -> rcs is null, the flags draw nothing and nothing throws', () => {
		const app = createApp();
		const earth = addEarth(app);
		const { main } = rolloutVehicle(app, earth, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' },
			(l) => { l.boosters = { ...l.boosters, lengthRatio: 2.8, attachOffsetXRatio: 1e-6, burnTimeSec: SRB_BURN_S }; });
		const w = workerOf(app, main.id);
		release(main);
		let flagFrames = 0;
		for (let f = 0; f < 30; f++) {
			stepFrame(app);
			assert.equal(designFor(configOf(w), R_DRAW).rcs, null, 'input: no free stretch by the design rule');
			assert.equal(RocketRenderer._computeVisualLayout(main, R_DRAW, VIS).rcs, null, `frame ${f}: layout.rcs`);
			let ctx;
			assert.doesNotThrow(() => { ctx = drawHigh(main); });
			assert.equal(extractJets(ctx).length, 0, `frame ${f}: no jet`);
			if (main.rcsCw || main.rcsCcw || main.rcsUllage) flagFrames++;
		}
		assert.ok(w.isBoosterSeparated && w.currentStageIndex === 0, 'input: the SRBs separated on the first stage');
		assert.ok(flagFrames > 0, `the Worker set RCS flags with no wall to draw them on (${flagFrames} frames)`);
	});
});

/*******************************************************************
 * 15-2 Vapor cone
 *******************************************************************/
describeMain('Integration 15-2: CalcRocket Mach / pressure ratio -> main thread -> cones at noseShoulder / interstageShoulder (design §3.4, §3.5, §5.2)', () => {
	for (const [vehicleId, payloadId, missionId] of PRESET_FLIGHTS) {
		it(`${vehicleId}: every transonic frame draws the design cones at the nose shoulder (and the uppermost interstage)`, () => {
			const { frames } = flyPreset(vehicleId, payloadId, missionId);
			let coneFrames = 0;
			let weak = 0;
			let strong = 0;
			for (const r of frames) {
				assert.equal(r.mach, r.workerMach, `t ${r.t}: Mach synchronised`);
				assert.equal(r.pres, r.workerPres, `t ${r.t}: pressure ratio synchronised`);
				const v = designVapor(r.mach, r.pres);
				if (!v.active) {
					if (r.cones) assert.equal(r.cones.length, 0, `t ${r.t}: no cone`);
					continue;
				}
				const design = designFor(r.cfg, R_DRAW);
				assertConesDesign(r.cones, designCones(design, r.mach, r.pres), `${vehicleId} t ${r.t} (intensity ${v.intensity})`);
				assertAnchorDesign(r.layout.noseShoulder, design.nose, `t ${r.t}: noseShoulder`);
				assertAnchorDesign(r.layout.interstageShoulder, design.inter, `t ${r.t}: interstageShoulder`);
				coneFrames++;
				if (v.intensity >= VC.SECONDARY_INTENSITY_MIN) strong++; else weak++;
			}
			assert.ok(coneFrames >= 10, `${vehicleId}: transonic frames drawn (${coneFrames})`);
			assert.ok(weak > 0 && strong > 0, `${vehicleId}: frames on both sides of SECONDARY_INTENSITY_MIN (${weak} / ${strong})`);
		});
	}

	it('regression (§1.2, §1.5): the 2-stage first-stage cones sit at the fairing base 1.600 R and the interstage 0.400 R, not at 0.72 L / 0.44 L', () => {
		for (const vehicleId of ['h3_22', 'falcon9']) {
			const { frames } = flyPreset(vehicleId, 'earth_obs', 'leo_250km');
			const r = frames.find(fr => fr.cones && fr.cones.length === 2);
			assert.ok(r, `${vehicleId}: a frame with both cones`);
			assertNear(r.cones[0].x / R_DRAW, 1.6, 1e-12, `${vehicleId}: primary vertex at the fairing base`);
			assertNear(r.cones[1].x / R_DRAW, 0.4, 1e-12, `${vehicleId}: secondary vertex at the interstage's forward edge`);
			assert.ok(Math.abs(r.cones[0].x / R_DRAW - 1.174) > 0.4, 'not the old 0.72 L station (1.174 R)');
			// Sizes follow the radius at the vertex: 0.65 R (fairing) and 0.70 R (interstage)
			assertNear(r.cones[0].innerR, 0.65 * R_DRAW * 0.15, 1e-9, `${vehicleId}: primary gradient from the fairing radius`);
			assertNear(r.cones[1].innerR, 0.7 * R_DRAW * 0.15 * 0.78, 1e-9, `${vehicleId}: secondary gradient from the interstage radius`);
		}
	});

	it('boundary: configurations without an interstage (single stage) draw only the primary cone even at the peak', () => {
		const { frames } = flyPreset('ssto', 'htv_x', 'iss_rendezvous');
		const peak = frames.filter(r => r.cones && designVapor(r.mach, r.pres).intensity >= VC.SECONDARY_INTENSITY_MIN);
		assert.ok(peak.length > 0, 'input: SSTO frames above SECONDARY_INTENSITY_MIN');
		for (const r of peak) {
			assert.equal(r.cones.length, 1, `t ${r.t}: primary only`);
			assertNear(r.cones[0].x / R_DRAW, 1.3, 1e-12, 'SSTO: the fairing base (§3.4 table 1.300)');
			assert.equal(r.layout.interstageShoulder, null, `t ${r.t}: no interstage shoulder`);
		}
		// The 3-stage first-stage secondary sits at the upper interstage's forward edge (1.500 R, radius 0.650 R)
		const eps = flyPreset('epsilon', 'asnaro_2', 'leo_250km').frames.find(r => r.cones && r.cones.length === 2);
		assert.ok(eps, 'input: an Epsilon frame with both cones');
		assertNear(eps.cones[0].x / R_DRAW, 2.4, 1e-12, 'Epsilon: primary at 2.400 R');
		assertNear(eps.cones[1].x / R_DRAW, 1.5, 1e-12, 'Epsilon: secondary at 1.500 R');
	});

	it('abnormal: above the atmosphere (Mach 0, pressure 0) no frame draws a cone', () => {
		for (const [vehicleId, payloadId, missionId] of PRESET_FLIGHTS) {
			const { frames } = flyPreset(vehicleId, payloadId, missionId);
			const vac = frames.filter(r => r.pres === 0 && r.cones);
			for (const r of vac) assert.equal(r.cones.length, 0, `${vehicleId} t ${r.t}`);
			assert.ok(frames.some(r => r.pres === 0), `${vehicleId}: the flight leaves the atmosphere`);
			assert.ok(frames.filter(r => r.pres === 0).every(r => r.mach === 0), `${vehicleId}: Mach 0 in vacuum`);
		}
	});
});

/*******************************************************************
 * 15-3 Smoke after the payload separation
 *******************************************************************/
/** The smoke point of the design (§3.7) for the synchronised main-thread rocket alone as a payload. */
const designPayloadSmoke = (main, objects) => {
	const bus = designPayloadBus(main.telemetry.totalStages || main.stages.length, 1);
	const scaleM = main.baseRadiusM;
	const selfPropelled = Boolean(main.hasPayloadPropulsion || main.payload?.propulsion?.enabled);
	const thr = VIS.PLUMES.THRUST_THRESHOLD;
	const firing = selfPropelled && main.isIgnited && main.burnTime > 0 && (main.thrustRatio > thr || main.telemetry?.twr > thr);
	const fuel = (typeof main.payload?.propulsion?.fuelType === 'string' && main.payload.propulsion.fuelType) || 'liquid';
	const nozzleM = bus.a * scaleM;
	const flameM = firing ? designPlumeLength(scaleM, AL.PAYLOAD_PLUME_SCALE, main.thrustRatio || 1.0, fuel, main.ambientPresRatio) : 0;
	const tipM = nozzleM + flameM;
	const ref = objects.find(o => o.id === main.dominantBodyId);
	const offPx = UnitConvertUtils.m2pix(tipM);
	let x = (main.x - Math.cos(main.thrustAngle) * offPx) - ref.x;
	let y = (main.y - Math.sin(main.thrustAngle) * offPx) - ref.y;
	const refAngle = ref.rotationAngle || 0;
	if (main.inAtmosphere && refAngle !== 0) {
		const c = Math.cos(-refAngle);
		const s = Math.sin(-refAngle);
		[x, y] = [x * c - y * s, x * s + y * c];
	}
	return { x, y, tipM, nozzleM, flameM, firing, ref: { id: ref.id, x: ref.x, y: ref.y, rotationAngle: refAngle } };
};
/** Where the recorded point is along the rocket axis, in metres behind the rocket (the inverse of the design's transform). */
const recordedTipM = (main, point, ref) => {
	let { x, y } = point;
	const refAngle = ref.rotationAngle || 0;
	if (main.inAtmosphere && refAngle !== 0) {
		const c = Math.cos(refAngle);
		const s = Math.sin(refAngle);
		[x, y] = [x * c - y * s, x * s + y * c];
	}
	const dx = x - (main.x - ref.x);
	const dy = y - (main.y - ref.y);
	return {
		behindM: UnitConvertUtils.pix2m(-(dx * Math.cos(main.thrustAngle) + dy * Math.sin(main.thrustAngle))),
		sideM: UnitConvertUtils.pix2m(Math.abs(-dx * Math.sin(main.thrustAngle) + dy * Math.cos(main.thrustAngle)))
	};
};

const flyPayload = ({ vehicleId, payloadId, missionId, row, fuelType, frames: maxFrames = 900, after = 6 }) => {
	const app = createApp();
	const earth = addEarth(app);
	const { main } = rolloutVehicle(app, earth, { vehicleId, payloadId, missionId }, (l) => {
		l.flightProfile.push(row);
		if (fuelType) l.payload = { ...l.payload, propulsion: { ...l.payload.propulsion, fuelType } };
	});
	const w = workerOf(app, main.id);
	release(main);
	const records = [];
	let sepFrame = null;
	for (let f = 0; f < maxFrames; f++) {
		stepFrame(app);
		if (sepFrame === null && w.isPayloadSeparated) sepFrame = f;
		if (sepFrame !== null) {
			const point = main.effectTrail.count > 0 ? main.effectTrail.getPoint(main.effectTrail.count - 1) : null;
			const fresh = point && point.frame === app.om.physicsSequence;
			records.push({ f, point: fresh ? point : null, trailCount: main.effectTrail.count, design: designPayloadSmoke(main, app.om.objects), main: { ...main, telemetry: { ...main.telemetry } } });
			if (f >= sepFrame + after) break;
		}
	}
	assert.ok(sepFrame !== null, `${vehicleId} + ${payloadId}: the payload separated`);
	return { app, main, w, records };
};

describeMain('Integration 15-3: smoke of the separated self-propelled payload at its flame tip behind the bus (design §3.7, §5.2)', () => {
	const assertSmokeRecords = (records, label, { firing }) => {
		assert.ok(records.length > 0, `${label}: frames after the separation`);
		for (const rec of records) {
			const { design, point } = rec;
			assert.equal(design.firing, firing, `${label} frame ${rec.f}: input, the payload engine ${firing ? 'fires' : 'is off'}`);
			assert.ok(point, `${label} frame ${rec.f}: a smoke point was recorded from the synchronised state`);
			const tol = UnitConvertUtils.m2pix(1e-6);
			assertNear(point.x, design.x, tol, `${label} frame ${rec.f}: smoke x`);
			assertNear(point.y, design.y, tol, `${label} frame ${rec.f}: smoke y`);
			assert.equal(point.refId, design.ref.id, `${label} frame ${rec.f}: relative to the dominant body`);
			const along = recordedTipM(rec.main, point, design.ref);
			assertNear(along.behindM, design.tipM, 1e-3, `${label} frame ${rec.f}: distance behind the rocket`);
			assert.ok(along.sideM < 1e-3, `${label} frame ${rec.f}: on the rocket axis (${along.sideM} m off)`);
			assert.ok(along.behindM >= design.nozzleM - 1e-3, `${label} frame ${rec.f}: at or behind the bus rear`);
		}
	};

	it('normal (liquid, HTV-X on H3-30, sep_payload at liftoff): the point is the payload flame tip, 0.455 R + the 0.35-scale plume behind the centre', () => {
		const { records } = flyPayload({ vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'iss_rendezvous', row: { type: 'time', value: 0, thrust: 100, angle: 90, action: 'sep_payload' } });
		assertSmokeRecords(records, 'HTV-X', { firing: true });
		const d = records[0].design;
		assertNear(d.nozzleM / records[0].main.baseRadiusM, 0.455, 1e-12, 'bus rear of the 2-stage payload (§1.4.1 (c): 0.455)');
		assertNear(d.flameM, records[0].main.baseRadiusM * VIS.PLUMES.liquid.lenMult * AL.PAYLOAD_PLUME_SCALE * (records[0].main.thrustRatio || 1)
			* (1 + (1 - records[0].main.ambientPresRatio) * DESIGN_VACUUM_STRETCH.liquid), 1e-9, 'the 0.35-scale liquid plume at the synchronised pressure');
	});

	for (const fuelType of ['hydro', 'ion', 'solid', 'xenon']) {
		it(`vacuum (separation above 140 km, payload fuel ${fuelType}): the flame carries the fuel's vacuum stretch (${fuelType === 'xenon' ? 'unknown fuel: as liquid' : `k ${DESIGN_VACUUM_STRETCH[fuelType]}`})`, () => {
			const { records } = flyPayload({ vehicleId: 'h3_30', payloadId: 'htv_x', missionId: 'iss_rendezvous', fuelType, row: { type: 'alt', value: 140000, thrust: 100, angle: 90, action: 'sep_payload' } });
			for (const rec of records) assert.equal(rec.main.ambientPresRatio, 0, 'input: vacuum');
			assertSmokeRecords(records, `HTV-X ${fuelType}`, { firing: true });
			const d = records[0].design;
			const lenMult = (VIS.PLUMES[fuelType] || VIS.PLUMES.liquid).lenMult;
			const k = DESIGN_VACUUM_STRETCH[fuelType] ?? DESIGN_VACUUM_STRETCH.liquid;
			assertNear(d.flameM, records[0].main.baseRadiusM * lenMult * AL.PAYLOAD_PLUME_SCALE * (records[0].main.thrustRatio || 1) * (1 + k), 1e-9, `${fuelType}: vacuum flame length`);
		});
	}

	it('boundary (single stage SSTO, three stages Epsilon): the bus of r1 / r3 sets the nozzle (0.490 R / 0.385 R)', () => {
		for (const [vehicleId, payloadId, missionId, ratio] of [['ssto', 'htv_x', 'iss_rendezvous', 0.49], ['epsilon', 'geo_sat', 'gto_insertion', 0.385]]) {
			const { records } = flyPayload({ vehicleId, payloadId, missionId, row: { type: 'time', value: 0, thrust: 100, angle: 90, action: 'sep_payload' } });
			assertSmokeRecords(records, vehicleId, { firing: true });
			assertNear(records[0].design.nozzleM / records[0].main.baseRadiusM, ratio, 1e-12, `${vehicleId}: bus rear`);
		}
	});

	it('abnormal (passive payload): in the atmosphere the point is the bus rear without a flame; in vacuum nothing is recorded', () => {
		const atm = flyPayload({ vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km', row: { type: 'time', value: 0, thrust: 100, angle: 90, action: 'sep_payload' } });
		for (const rec of atm.records) assert.equal(rec.main.inAtmosphere, true, 'input: in the atmosphere');
		assertSmokeRecords(atm.records, 'passive, atmosphere', { firing: false });
		for (const rec of atm.records) assertNear(rec.design.tipM, rec.design.nozzleM, 0, 'no flame');
		const vac = flyPayload({ vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'leo_250km', row: { type: 'alt', value: 140000, thrust: 100, angle: 90, action: 'sep_payload' } });
		for (const rec of vac.records) {
			assert.equal(rec.main.inAtmosphere || rec.main.isEscaping || (rec.main.isIgnited && rec.main.burnTime > 0), false, 'input: nothing to record');
			assert.equal(rec.trailCount, 0, `frame ${rec.f}: the smoke trail is cleared (recording condition unchanged)`);
		}
	});
});

/*******************************************************************
 * 15-4 SRB count from rocket.boosters
 *******************************************************************/
const SRB_CASES = [
	// normal
	{ label: 'H3-22 preset count 2', edit: { patch: { burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'H3-24 preset count 4', vehicleId: 'h3_24', edit: { patch: { burnTimeSec: SRB_BURN_S } }, n: 4, mass: 40 },
	// boundary
	{ label: 'count 1 (smallest)', edit: { patch: { count: 1, burnTimeSec: SRB_BURN_S } }, n: 1, mass: 20 },
	{ label: 'count 9 (the cap)', edit: { patch: { count: 9, burnTimeSec: SRB_BURN_S } }, n: 9, mass: 20 },
	{ label: 'count 10 (just above the cap)', edit: { patch: { count: 10, burnTimeSec: SRB_BURN_S } }, n: 9, mass: 20 },
	{ label: 'count 12', edit: { patch: { count: 12, burnTimeSec: SRB_BURN_S } }, n: 9, mass: 20 },
	{ label: 'count 2.5 (rounded down)', edit: { patch: { count: 2.5, burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'count 0 with a burn time', edit: { patch: { count: 0, burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'count 0 without a burn time', edit: { patch: { count: 0 }, drop: ['burnTimeSec'] }, n: 0 },
	{ label: 'count 0.5 with a burn time', edit: { patch: { count: 0.5, burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'count 0.5 without a burn time', edit: { patch: { count: 0.5 }, drop: ['burnTimeSec'] }, n: 0 },
	// abnormal
	{ label: 'count -3 with a burn time', edit: { patch: { count: -3, burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'count "4" (string)', edit: { patch: { count: '4', burnTimeSec: SRB_BURN_S } }, n: 4, mass: 20 },
	{ label: 'count "4" without dryMassT (default 40 t of four SRBs)', edit: { patch: { count: '4', burnTimeSec: SRB_BURN_S }, drop: ['dryMassT'] }, n: 4, mass: 40 },
	{ label: 'count " 4 " (padded string)', edit: { patch: { count: ' 4 ', burnTimeSec: SRB_BURN_S } }, n: 4, mass: 20 },
	{ label: 'count "0" with a burn time', edit: { patch: { count: '0', burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'count "abc" with a burn time', edit: { patch: { count: 'abc', burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'count [4] (array)', edit: { patch: { count: [4], burnTimeSec: SRB_BURN_S } }, n: 4, mass: 20 },
	{ label: 'count null with a burn time', edit: { patch: { count: null, burnTimeSec: SRB_BURN_S } }, n: 2, mass: 20 },
	{ label: 'an empty configuration {}', edit: { replace: {} }, n: 0 }
];

describeMain('Integration 15-4: SRB count of rocket.boosters -> CalcRocket separation, main-thread drawing and HUD agree (design §3.1, R8, §5.2)', () => {
	for (const c of SRB_CASES) {
		it(`${c.label}: ${c.n} SRB(s) separated by the Worker, drawn and shown`, () => {
			const s = runSrbScenario(c);
			// The configuration crosses the Worker boundary as the JSON copy of rocket.boosters (ObjectManager)
			assert.deepEqual(s.sentBoosters, JSON.parse(JSON.stringify(s.mainBoosters)), 'the Worker receives rocket.boosters');
			assert.deepEqual(s.workerBoosters, s.sentBoosters, 'CalcRocket keeps that configuration');
			assertSrbAgreement({ ...s, mainBoostersForLayout: s.mainBoosters }, c.n, c.mass, c.label);
			if (c.n > 0) assertSeparationTime(s.sepTime, SRB_BURN_S);
		});
	}

	it('count 1e9 (an edited preset or save): separates, draws and shows 9 SRBs without hanging (worker thread, 60 s timeout)', async () => {
		const s = await runIsolated('srbCount', { edit: { patch: { count: 1e9, burnTimeSec: SRB_BURN_S } } }, ISOLATED_TIMEOUT_MS);
		assert.equal(s.mainBoosters.count, 1e9, 'input: the main-thread configuration keeps 1e9');
		assert.equal(s.sentBoosters.count, 1e9, 'input: so does the Worker copy');
		assertSrbAgreement({ ...s, mainBoostersForLayout: s.mainBoosters }, 9, 20, 'count 1e9');
	});
});

/*******************************************************************
 * 15-5 Non-finite values in a save
 *******************************************************************/
const SAVE_CASES = [
	{ label: 'count 1e999 with a burn time', patch: { count: '__INF__', burnTimeSec: SRB_BURN_S }, n: 2, main: { count: Infinity }, sent: { count: null } },
	{ label: 'count -1e999 with a burn time', patch: { count: '__NINF__', burnTimeSec: SRB_BURN_S }, n: 2, main: { count: -Infinity }, sent: { count: null } },
	{ label: 'count 1e999 without a burn time', patch: { count: '__INF__' }, drop: ['burnTimeSec'], n: 0, main: { count: Infinity }, sent: { count: null } },
	{ label: 'count 2 with burnTimeSec 1e999', patch: { count: 2, burnTimeSec: '__INF__' }, n: 2, main: { burnTimeSec: Infinity }, sent: { burnTimeSec: null }, frames: 260 },
	{ label: 'count 0 with burnTimeSec 1e999', patch: { count: 0, burnTimeSec: '__INF__' }, n: 0, main: { burnTimeSec: Infinity }, sent: { burnTimeSec: null } },
	{ label: 'count and burnTimeSec 1e999', patch: { count: '__INF__', burnTimeSec: '__INF__' }, n: 0, main: { count: Infinity, burnTimeSec: Infinity }, sent: { count: null, burnTimeSec: null } }
];

describeMain('Integration 15-5: a save with non-finite SRB values (1e999) -> ObjectManager.loadState -> main thread and Worker agree (design §3.1, §5.2)', () => {
	for (const c of SAVE_CASES) {
		it(`${c.label}: ${c.n} SRB(s) on both threads (worker thread, ${ISOLATED_TIMEOUT_MS / 1000} s timeout)`, async () => {
			const s = await runIsolated('saveNonFinite', { patch: c.patch, drop: c.drop, frames: c.frames }, ISOLATED_TIMEOUT_MS);
			assert.ok(s.text.includes('1e999'), 'input: the save text has the literal');
			// The main-thread object keeps the parsed value (Infinity); the Worker gets the JSON copy (null)
			for (const [k, v] of Object.entries(c.main)) assert.equal(s.mainBoosters[k], v, `main-thread boosters.${k}`);
			for (const [k, v] of Object.entries(c.sent)) {
				assert.equal(s.sentBoosters[k], v, `the Worker copy has boosters.${k} = ${v} (JSON)`);
				assert.equal(s.workerBoosters[k], v, `CalcRocket.boosters.${k}`);
			}
			assertSrbAgreement({ ...s, mainBoostersForLayout: s.mainBoosters }, c.n, 20, c.label);
			// Without a burn time the Worker burns its SRBs for its default 105 s (gravsim_calc_object.js, unchanged)
			if (c.n > 0) assertSeparationTime(s.sepTime, c.sent.burnTimeSec === null ? 105 : SRB_BURN_S);
		});
	}
});

/*******************************************************************
 * 15-6 Preset caches
 *******************************************************************/
describeMain('Integration 15-6: preset caches on the Worker, the predictor and a pre-66d3687 save (design §3.11, §5.2)', () => {
	it('Worker engine: a full flight in a world with debris named outside the table makes no name search per update after the first, except one per new object and name', () => {
		const app = createApp();
		app.om.loadState(legacySave());
		const earth = app.om.objects.find(o => o.name === 'Earth');
		// SRB, fairing, stage and payload separations (the payload separation renames the craft to the payload's name)
		const SEP_PAYLOAD_T = 330;
		const { main } = rolloutVehicle(app, earth, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' },
			(l) => { l.flightProfile.push({ type: 'time', value: SEP_PAYLOAD_T, thrust: 100, angle: 90, action: 'sep_payload' }); });
		const w = workerOf(app, main.id);
		const tableNames = new Set(Object.keys(app.sent.find(m => m.cmd === 'initDefinitions').celestialParams));
		for (const name of NON_TABLE_NAMES) {
			assert.ok(app.engine.objects.some(o => o.name === name), `input: ${name} is in the Worker world`);
			assert.equal(tableNames.has(name), false, `input: ${name} is not in the table`);
		}
		release(main);
		coldPresetCaches();
		const spy = spyGetCelestial();
		const peeked = new Set();
		const counts = [];
		try {
			for (let f = 0; f < FLIGHT_FRAMES; f++) {
				const ids = new Set(app.engine.objects.map(o => o.id));
				const before = spy.count;
				stepFrame(app);
				const added = app.engine.objects.filter(o => !ids.has(o.id));
				// §3.11-5: addObject keeps getCelestialParam (one search for a name outside the table); every other reader
				// peeks, which searches a name once
				let expected = added.filter(o => !tableNames.has(o.name)).length;
				for (const o of app.engine.objects) {
					if (!o.param && !tableNames.has(o.name) && !peeked.has(o.name)) {
						peeked.add(o.name);
						expected++;
					}
				}
				counts.push({ f, got: spy.count - before, expected, added: added.map(o => o.name) });
			}
		} finally {
			spy.restore();
		}
		for (const c of counts) {
			assert.equal(c.got, c.expected, `frame ${c.f}: name searches (added ${JSON.stringify(c.added)})`);
		}
		assert.deepEqual(counts[0], { f: 0, got: NON_TABLE_NAMES.length, expected: NON_TABLE_NAMES.length, added: [] }, 'the first update searches each name outside the table once');
		const quiet = counts.slice(1).filter(c => c.added.length === 0);
		assert.ok(quiet.length > FLIGHT_FRAMES - 10, `updates without a new object (${quiet.length})`);
		assert.ok(quiet.every(c => c.got === 0), 'no name search in an update without a new object');
		const spawned = counts.filter(c => c.added.length > 0).flatMap(c => c.added);
		assert.ok(spawned.length >= 5, `the flight spawns SRB, fairing and stage debris (${JSON.stringify(spawned)})`);
		assert.ok(w.isBoosterSeparated && w.fairing.isSeparated && w.isPayloadSeparated, 'the flight passes the SRB, fairing, stage and payload separations');
		assert.equal(w.name, main.payload.name, 'input: the Worker craft carries the payload name (outside the table)');
		assert.equal(tableNames.has(w.name), false);
		const renameFrame = counts.find(c => c.added.some(n => /Upper Stage/.test(n)));
		assert.ok(renameFrame && renameFrame.got === renameFrame.expected && renameFrame.expected === 3,
			`the payload separation: the upper-stage debris (added + first read) and the new craft name (first read) (${JSON.stringify(renameFrame)})`);
	});

	it('predictor engine: the rollout prediction makes no name search per step after the first (a body outside the table included)', () => {
		const app = createApp();
		app.om.loadState(legacySave());
		const earth = app.om.objects.find(o => o.name === 'Earth');
		coldPresetCaches();
		const spy = spyGetCelestial();
		const proto = PredictorPhysicsEngine.prototype;
		const ownStep = Object.prototype.hasOwnProperty.call(proto, 'step');
		const origStep = proto.step;
		const steps = [];
		proto.step = function (dt) {
			const before = spy.count;
			const name = this.rocket.name;
			const result = origStep.call(this, dt);
			steps.push({ got: spy.count - before, renamed: this.rocket.name !== name });
			return result;
		};
		let launcher;
		try {
			({ launcher } = rolloutVehicle(app, earth, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' }, () => {}, { predict: true }));
		} finally {
			if (ownStep) { proto.step = origStep; } else { delete proto.step; }
			spy.restore();
		}
		assert.ok(launcher.currentPrediction && launcher.currentPrediction.points.length > 0, 'input: the rollout computed a prediction');
		assert.ok(steps.length > 1000, `input: predictor steps (${steps.length})`);
		assert.ok(spy.names.includes('Rogue Moonlet'), 'input: the moonlet (outside the table) is read by the predictor');
		// The predictor engine sorts its bodies (and reads each name, from the shared read-only copy) once while it is
		// built, so no step searches a name: neither the first nor a later one, the payload separation's rename included
		assert.ok(steps.some(s => s.renamed), 'input: the predicted flight separates the payload (the rocket is renamed)');
		const searched = steps.map((s, i) => ({ ...s, i })).filter(s => s.got !== 0);
		assert.deepEqual(searched.slice(0, 5), [], `name searches per step (${searched.length} steps search)`);
	});

	describe('pre-66d3687 save (celestial bodies without param): per-frame readers keep their values without deep copies', () => {
		const loadLegacy = () => {
			const app = createApp();
			app.om.loadState(legacySave());
			return app;
		};
		/** The same body placed by the Deploy tab (with its table parameters), for the reference values. */
		const withParam = (body) => {
			const twin = new CelestialBody(body.id, body.name, body.x, body.y, body.vx, body.vy, body.mass, body.color, body.size, body.radius, 0, null, 0);
			twin.param = presetManager.getObjectParam(body.name);
			twin.rotationAngle = body.rotationAngle;
			return twin;
		};
		const perFrame = (fn, frames = 6) => {
			const spy = spyGetCelestial();
			const out = [];
			try {
				for (let i = 0; i < frames; i++) {
					const before = spy.count;
					const value = fn(i);
					out.push({ searches: spy.count - before, value });
				}
			} finally {
				spy.restore();
			}
			return out;
		};

		it('input: the loaded bodies have no param on the main thread; the Worker takes them from its table', () => {
			const app = loadLegacy();
			for (const name of ['Sun', 'Earth', 'Moon', 'Rogue Moonlet']) {
				const body = app.om.objects.find(o => o.name === name);
				assert.equal(body.param, null, `${name}: no param on the main thread`);
				const add = app.sent.find(m => m.cmd === 'add' && m.name === name);
				assert.equal(add.param, null, `${name}: the add message has none`);
			}
			assert.equal(workerOf(app, 1).param.ROTATION_PERIOD, EARTH_PARAM.ROTATION_PERIOD, 'the Worker Earth has the table parameters');
			assert.equal(workerOf(app, 3).param, null, 'the moonlet has none anywhere');
		});

		it('CelestialBody._drawEffects: the atmosphere is drawn as for the table body, with no search after the first frame', () => {
			const app = loadLegacy();
			coldPresetCaches();
			for (const name of ['Earth', 'Moon', 'Sun', 'Rogue Moonlet']) {
				const body = app.om.objects.find(o => o.name === name);
				const ref = withParam(body);
				const zoom = 4 / ((EARTH_PARAM.ATM_LIMIT_ALT / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE); // a 4 px atmosphere
				const frames = perFrame(() => {
					const ctx = createRecordingCtx();
					body._drawEffects(ctx, 400, 300, 120, zoom);
					return serializeCalls(ctx);
				});
				const refCtx = createRecordingCtx();
				ref._drawEffects(refCtx, 400, 300, 120, zoom);
				for (const [i, fr] of frames.entries()) {
					assert.equal(fr.value, serializeCalls(refCtx), `${name} frame ${i}: the same drawing as with the table parameters`);
					assert.equal(fr.searches, i === 0 ? 1 : 0, `${name} frame ${i}: name searches`);
				}
				if (name === 'Earth') assert.ok(frames[0].value.includes('createRadialGradient'), 'Earth: the atmosphere is drawn');
				if (name === 'Rogue Moonlet') assert.equal(frames[0].value, '[]', 'the moonlet: nothing (no parameters)');
			}
		});

		it('RocketLauncher._calculateTransform / drawTargetMarker: the pad velocity carries the host rotation as for the table body, with no search after the first frame', () => {
			const app = loadLegacy();
			coldPresetCaches();
			const earth = app.om.objects.find(o => o.name === 'Earth');
			const launcher = new RocketLauncher(app.universe);
			app.universe.RocketLauncher = launcher;
			launcher.mode = 'host';
			launcher.hostId = earth.id;
			launcher.hostAngleDeg = 35;
			presetManager.applyToLauncher(launcher, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const refUniverse = createMockUniverse({ objects: [withParam(earth)] });
			const refLauncher = new RocketLauncher(refUniverse);
			Object.assign(refLauncher, { mode: 'host', hostId: earth.id, hostAngleDeg: 35 });
			presetManager.applyToLauncher(refLauncher, { vehicleId: 'h3_22', payloadId: 'earth_obs', missionId: 'leo_250km' });
			const expected = refLauncher._calculateTransform();
			const omega = 2 * Math.PI / EARTH_PARAM.ROTATION_PERIOD;
			const padSpeed = Math.hypot(expected.vx - earth.vx, expected.vy - earth.vy);
			assertNear(padSpeed, omega * Math.hypot(expected.x - earth.x, expected.y - earth.y), 1e-9 * padSpeed, 'reference: the pad moves with the rotation of the table period');
			const frames = perFrame(() => {
				const t = launcher._calculateTransform();
				const ctx = createRecordingCtx();
				launcher.drawTargetMarker(ctx, earth, 1e6);
				return { t, marker: serializeCalls(ctx) };
			});
			const refCtx = createRecordingCtx();
			refLauncher.drawTargetMarker(refCtx, earth, 1e6);
			for (const [i, fr] of frames.entries()) {
				assert.deepEqual(fr.value.t, expected, `frame ${i}: the same transform as with the table parameters`);
				assert.equal(fr.value.marker, serializeCalls(refCtx), `frame ${i}: the same target marker`);
				if (i > 0) assert.equal(fr.searches, 0, `frame ${i}: no name search`);
			}
		});

		it('HUD (Navi tab): the atmosphere rows read the table values, with no search after the first update; a body outside the table reads ---', () => {
			const app = loadLegacy();
			coldPresetCaches();
			const navi = new NaviTab(app.universe);
			const rows = () => [navi.ui.nvAtmAlt.textContent, navi.ui.nvAtmRho.textContent, navi.ui.nvAtmScale.textContent];
			for (const [name, expectedRows] of [
				['Earth', [`${UnitConvertUtils.m2km(EARTH_PARAM.ATM_LIMIT_ALT).toLocaleString()} km`, `${EARTH_PARAM.ATM_DENSITY_0.toLocaleString()} kg/m³`, `${EARTH_PARAM.ATM_SCALE_HEIGHT.toLocaleString()} m`]],
				['Rogue Moonlet', ['--- km', '--- kg/m³', '--- m']]
			]) {
				const body = app.om.objects.find(o => o.name === name);
				navi.naviTargetId = body.id;
				const frames = perFrame(() => { navi._updateNaviStats(); return rows(); });
				for (const [i, fr] of frames.entries()) {
					assert.deepEqual(fr.value, expectedRows, `${name} update ${i}: atmosphere rows`);
					assert.equal(fr.searches, i === 0 ? 1 : 0, `${name} update ${i}: name searches`);
				}
			}
		});

		it('HUD (slingshot preview over the loaded world): the launch object and its mass read the table, with no search after the first frame', () => {
			const app = loadLegacy();
			coldPresetCaches();
			const placer = app.universe.ObjectPlacer;
			Object.assign(placer, { isSlingshotting: true, startRelX: 10, startRelY: 20, startScreenX: 900, startScreenY: 500, screenCursorX: 700, screenCursorY: 600 });
			const massSelect = document.getElementById('mass-select');
			const saved = massSelect.value;
			try {
				for (const [selected, shown] of [['Moon', 'Moon'], ['Rogue Moonlet', 'Rocket']]) {
					massSelect.value = selected;
					const frames = perFrame(() => {
						const ctx = createRecordingCtx();
						placer.drawPreview(ctx, app.om.objects.find(o => o.name === 'Earth'), 1);
						return ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
					});
					const mass = presetManager.getObjectParam(shown).MASS.toExponential(2);
					for (const [i, fr] of frames.entries()) {
						assert.ok(fr.value.includes(`[ LAUNCH: ${shown.toUpperCase()} ]`), `${selected} frame ${i}: launch object ${JSON.stringify(fr.value)}`);
						assert.ok(fr.value.includes(`MASS: ${mass} t`), `${selected} frame ${i}: mass from the table`);
						if (i > 0) assert.equal(fr.searches, 0, `${selected} frame ${i}: no name search`);
					}
				}
			} finally {
				massSelect.value = saved;
			}
		});
	});
});

/*******************************************************************
 * Worker-thread entry (runIsolated): the file runs one scenario and posts its summary
 *******************************************************************/
if (!isMainThread && workerData?.scenario) {
	parentPort.postMessage(SCENARIOS[workerData.scenario](workerData.arg));
}
