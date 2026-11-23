/**
 * Shared helpers of Regression 08 (trajectory prediction guarantees on the app path), split into 08a/08b/08c so that
 * each file stays within the test plan's 60 s guideline (test plan §1-5).
 *
 * Design: docs/design/2026-11-20_trajectory_fx_flightplan.md §4.3 (guarantees 1-5, measured table, 8-azimuth
 * bullets), §4.10 (drawn frame), §4.11 (breakup), §4.12 (budgets).
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-B (regression part).
 *
 * Every prediction goes through the application path: ObjectPlacer.placeObject / deployProfile ->
 * PresetManager.applyToLauncher -> RocketLauncher.updatePredictionSync(). Drawn-frame quantities are measured on the
 * real TrajectoryPredictor.renderTrajectory output recorded by a mock canvas at zoom 1e9 (host at the screen origin),
 * in preview and in flight at several flight times (the host keeps rotating between prediction and each frame).
 * hostId/domId depend on object creation order and are never compared (Gate 2 Iteration 9 Watchpoint 2).
 * Guarantee 3 revolutions are the accumulated host-centred angle of the drawn line after the frame switch.
 */
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse } from '../test_helpers.mjs';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { ObjectPlacer } from '../../scripts/gravsim_object_placer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { TrajectoryPredictor } from '../../scripts/gravsim_trajectory_predictor.js';
import { presetManager } from '../../scripts/gravsim_preset_manager.js';
export { presetManager };
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { PHYSICS, TRAJECTORY_PREDICTION, RENDER } from '../../scripts/gravsim_const.js';
export { PHYSICS };
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';

setupMockDOM();

export const TP = TRAJECTORY_PREDICTION;
export const MONTH_S = (365.25 / 12) * 86400;
export const DAY_S = 86400;
export const AU = PHYSICS.METERS_PER_AU;
export const m2p = (m) => UnitConvertUtils.m2pix(m);
export const ZOOM = 1e9;
export const DRAWN_LIMIT_RAD = 0.15; // §4.3 guarantee 1 test threshold
export const ROT0 = 1.234; // non-trivial host rotation at prediction time
export const LIFTOFF_DELAY_S = 37; // the host keeps rotating between the prediction and liftoff
export const AZ8 = [0, 45, 90, 135, 180, 225, 270, 315];
export const END_REASONS = new Set(['horizon', 'impact', 'breakup', 'point_budget', 'step_budget', 'no_host']);
export const PREDICTED_DASHES = new Set([RENDER.PREDICTED_TRAJECTORY.LINE_DASH_PRE, RENDER.PREDICTED_TRAJECTORY.LINE_DASH_FLIGHT].map(d => d.join(',')));

// §4.3 table vehicles; payloads as in the Gate 2 measurements
export const MISSIONS = {
	iss: ['h3_22', 'htv_x', 'iss_rendezvous'],
	leo: ['h3_30', 'earth_obs', 'leo_250km'],
	gto: ['h3_24', 'geo_sat', 'gto_insertion'],
	lunar: ['h3_24', 'lunar_orbiter', 'lunar_insertion'],
	mars: ['h3_30', 'mmx', 'mars_transfer'],
	jupiter: ['h3_24', 'earth_obs', 'jupiter_transfer'],
	solar: ['falcon9', 'earth_obs', 'solar_escape']
};
// §4.3 guarantee 3: drawn revolutions after the switch (independent of world and azimuth) and arrival days (8-azimuth bullets)
export const REVS_02 = { leo: 1.90, iss: 1.73, gto: 1.32 };
export const REVS_1PLUS = { leo: 5.79, iss: 5.79, gto: 3.54 };

export const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
export const stepBudget = (maxSimTime) => Math.min(TP.MAX_STEPS_CAP, Math.max(TP.MAX_STEPS, Math.ceil(maxSimTime / 5)));

/** World construction through ObjectPlacer (SE: Sun+Earth, W7: 7-body world, SS/BIN/TB: app deploy profiles). */
export function makeWorld(world) {
	EventBus.clearAll();
	const universe = createMockUniverse();
	const om = new ObjectManager(null, { postMessage() {} });
	om.universe = universe;
	universe.ObjectManager = om;
	Object.defineProperty(universe, 'objects', { get() { return om.objects; }, set(a) { om.objects = a; }, configurable: true });
	universe.addObject = (obj) => om.addObject(obj);
	universe.getObjectParams = (name) => presetManager.getObjectParam(name);
	const placer = new ObjectPlacer(universe);
	universe.ObjectPlacer = placer;
	let earth;
	if (world === 'SS' || world === 'BIN' || world === 'TB') {
		placer.placeObject('Sun', 0, 0, 0, 0);
		placer.deployProfile({ SS: 'SOLAR_SYSTEM', BIN: 'BINARY_SYSTEM', TB: 'THREE_BODY' }[world]);
		earth = om.objects.find(o => o.name === 'Earth' || o.name === 'Earth (Trisolaris)');
	} else {
		placer.placeObject('Sun', 0, 0, 0, 0);
		earth = placer.placeObject('Earth', m2p(AU), 0, 0, m2p(29780));
		if (world === 'W7') {
			placer.placeObject('Moon', m2p(AU + 384400e3), 0, 0, m2p(29780 + 1022));
			placer.placeObject('Venus', m2p(-0.723 * AU), 0, 0, m2p(-35020));
			placer.placeObject('Mars', 0, m2p(1.524 * AU), m2p(-24070), 0);
			placer.placeObject('Jupiter', 0, m2p(-5.2 * AU), m2p(13070), 0);
		}
	}
	assert.ok(earth, `${world}: the launch host exists`);
	earth.rotationAngle = ROT0;
	return { universe, om, earth, placer };
}

/** RocketLauncher configured from presets (months null keeps the mission's preset period). */
export function makeLauncher(w, missionKey, months, az, profileOverride = null) {
	const [vehicleId, payloadId, missionId] = MISSIONS[missionKey];
	const rl = new RocketLauncher(w.universe, { presetManager });
	w.universe.RocketLauncher = rl;
	rl.requestPreviewUpdate = () => {};
	presetManager.applyToLauncher(rl, { vehicleId, payloadId, missionId });
	if (profileOverride) { rl.flightProfile = profileOverride; }
	rl.mode = 'host';
	rl.hostId = w.earth.id;
	rl.hostAngleDeg = az;
	if (months !== null) { rl.maxSimTimeSec = months * MONTH_S; }
	return rl;
}

const cache = new Map();
/** Cached app-path prediction of one configuration (keyed by the effective requested period). */
export function predictCase(world, missionKey, months, az) {
	const w = makeWorld(world);
	const rl = makeLauncher(w, missionKey, months, az);
	const key = `${world} ${missionKey} ${(rl.maxSimTimeSec / MONTH_S).toPrecision(6)}mo az${az}`;
	if (!cache.has(key)) {
		const pred = rl.updatePredictionSync();
		assert.ok(pred, `${key}: a prediction is produced`);
		cache.set(key, { key, world, missionKey, az, pred, earth: w.earth, requested: rl.maxSimTimeSec, nBodies: w.om.objects.length, rl });
	}
	return cache.get(key);
}

/** Recording canvas: keeps each stroke with its dash so the predicted line can be told apart. */
export function capture(pred, host, options) {
	const strokes = [];
	let path = [];
	let sub = null;
	let dash = [];
	const ctx = {
		canvas: { width: 1e13, height: 1e13 },
		save() {}, restore() {},
		beginPath() { path = []; sub = null; },
		moveTo(x, y) { sub = [[x, y]]; path.push(sub); },
		lineTo(x, y) { if (!sub) { sub = [[x, y]]; path.push(sub); } else { sub.push([x, y]); } },
		quadraticCurveTo(cx, cy) { this.lineTo(cx, cy); },
		arc() {}, fill() {}, fillRect() {}, fillText() {},
		stroke() { strokes.push({ dash: dash.slice(), path }); },
		setLineDash(d) { dash = Array.isArray(d) ? d.slice() : []; },
		measureText(t) { return { width: String(t).length * 6 }; }
	};
	const rc = { objects: [host], basis: { x: host.x, y: host.y }, zoomScale: ZOOM, cameraOffset: { x: 0, y: 0 } };
	TrajectoryPredictor.renderTrajectory(ctx, rc, pred, options);
	return strokes.filter(s => s.dash.length > 0 && PREDICTED_DASHES.has(s.dash.join(','))).flatMap(s => s.path);
}

/** Drawn statistics of one capture: vertex count, largest adjacent angle step, accumulated |angle| in turns. */
export function drawnStats(subpaths, label) {
	if (subpaths.length === 0) { return { n: 0, maxStep: 0, turns: 0, vertices: [] }; }
	assert.equal(subpaths.length, 1, `${label}: the predicted line is drawn as one unculled polyline`);
	const v = subpaths[0];
	let maxStep = 0;
	let sweep = 0;
	for (let i = 1; i < v.length; i++) {
		const st = Math.abs(normAngle(Math.atan2(v[i][1], v[i][0]) - Math.atan2(v[i - 1][1], v[i - 1][0])));
		sweep += st;
		if (st > maxStep) { maxStep = st; }
	}
	return { n: v.length, maxStep, turns: sweep / (2 * Math.PI), vertices: v };
}

export const hostAt = (earth, rot) => ({ ...earth, id: earth.id, x: earth.x, y: earth.y, rotationAngle: rot });
export const flightHost = (entry, tau) => hostAt(entry.earth, ROT0 + (entry.pred.hostOmega || 0) * (LIFTOFF_DELAY_S + tau));
export const flightCapture = (entry, tau, pred = entry.pred) => capture(pred, flightHost(entry, tau), { mode: 'flight', currentFlightTime: tau, showActualPath: false });

/** Drawn revolutions after the frame switch (post-switch subset drawn just after the switch), cross-checked on the points. */
export function postSwitchTurns(entry) {
	const { pred } = entry;
	const tsw = pred.frameSwitchTime;
	const sub = { ...pred, points: pred.points.filter(p => p.time >= tsw) };
	const tau = Math.min(tsw + 0.5, pred.points.at(-1).time - 1e-3);
	const drawn = drawnStats(flightCapture(entry, tau, sub), `${entry.key} post-switch`).turns;
	let sweep = 0;
	for (let i = 1; i < sub.points.length; i++) {
		sweep += Math.abs(normAngle(Math.atan2(sub.points[i].relY, sub.points[i].relX) - Math.atan2(sub.points[i - 1].relY, sub.points[i - 1].relX)));
	}
	assert.ok(Math.abs(drawn - sweep / (2 * Math.PI)) <= 1e-9, `${entry.key}: drawn post-switch rotation matches the host-centred angle of the points`);
	return drawn;
}

export const isImpactEvent = (e) => e.id === 'impact' || String(e.id).startsWith('impact_');

/**
 * Guarantees 1 and 2 (§4.3) plus the end-reason table conditions, on one prediction. Returns the drawn statistics.
 */
export function assertGuarantees12(entry) {
	const { pred, key, requested } = entry;
	const pts = pred.points;
	const last = pts.at(-1);
	// Guarantee 2: point cap, monotonic time, end reason, maxSimTime
	assert.ok(pts.length >= 2 && pts.length <= TP.MAX_POINTS, `${key}: ${pts.length} points within MAX_POINTS`);
	for (let i = 1; i < pts.length; i++) {
		if (!(pts[i].time > pts[i - 1].time)) { assert.fail(`${key}: time not strictly increasing at index ${i}`); }
	}
	for (const p of pts) {
		if (![p.relX, p.relY, p.r, p.phiSurf, p.time, p.altM, p.worldX, p.worldY].every(Number.isFinite)) { assert.fail(`${key}: non-finite point at ${p.time}`); }
	}
	assert.ok(END_REASONS.has(pred.endReason), `${key}: endReason ${pred.endReason}`);
	assert.equal(pred.maxSimTime, last.time, `${key}: maxSimTime is the final point time`);
	assert.ok(last.time <= requested + 0.01, `${key}: no time beyond the request`);
	assert.ok(pred.steps <= TP.MAX_STEPS_CAP, `${key}: steps within MAX_STEPS_CAP`);
	if (pred.endReason === 'step_budget') { assert.equal(pred.steps, stepBudget(requested), `${key}: step budget reached`); }
	if (pred.endReason === 'point_budget') { assert.equal(pts.length, TP.MAX_POINTS, `${key}: point budget reached`); }
	if (pred.endReason === 'horizon') { assert.ok(Math.abs(last.time - requested) <= 0.01, `${key}: horizon reached`); }
	assert.equal(pred.events.some(isImpactEvent), pred.endReason === 'impact', `${key}: impact event iff endReason impact`);
	assert.equal(pred.events.some(e => e.id === 'breakup'), pred.endReason === 'breakup', `${key}: breakup event iff endReason breakup`);
	assert.ok(pred.events.every(e => e.time <= last.time), `${key}: no event after the final point`);

	// Guarantee 1 in the drawn frame: preview and several flight times, same shape everywhere
	const preview = drawnStats(capture(pred, hostAt(entry.earth, ROT0), { mode: 'preview' }), `${key} preview`);
	assert.ok(preview.n >= 2, `${key}: preview is drawn`);
	assert.ok(preview.maxStep <= DRAWN_LIMIT_RAD, `${key}: preview drawn step ${preview.maxStep} rad`);
	const tsw = pred.frameSwitchTime;
	const taus = [0, 100, last.time * 0.5, last.time - 1];
	if (tsw !== null) { taus.push(Math.max(0, tsw - 0.5), tsw + 0.5, tsw + 3000); }
	for (const tau of taus.filter(t => t >= 0 && t < last.time)) {
		const fl = drawnStats(flightCapture(entry, tau), `${key} flight ${tau}`);
		assert.equal(fl.n, preview.n, `${key}: flight t=${tau} draws the whole line (not erased early)`);
		assert.ok(Math.abs(fl.maxStep - preview.maxStep) <= 1e-9, `${key}: flight t=${tau} has the preview shape`);
	}
	// Guarantee 2: erased once the flight time passes the final point
	assert.equal(drawnStats(flightCapture(entry, last.time + 1e-3), `${key} after`).n, 0, `${key}: erased after the final point`);
	return preview;
}

/** Guarantee 3 on one near-host closed-orbit prediction. */
export function assertGuarantee3(entry, expectedRevs) {
	assert.equal(entry.pred.endReason, 'step_budget', `${entry.key}: closed orbits end by the step budget`);
	assert.notEqual(entry.pred.frameSwitchTime, null, `${entry.key}: the frame switches`);
	const turns = postSwitchTurns(entry);
	assert.ok(turns >= 1, `${entry.key}: ${turns} drawn revolutions after the switch`);
	if (expectedRevs !== undefined) { assert.equal(round(turns, 2), expectedRevs, `${entry.key}: post-switch revolutions`); }
	return turns;
}

export const days = (entry) => entry.pred.points.at(-1).time / DAY_S;
export const reach = (entry) => 100 * entry.pred.points.at(-1).time / entry.requested;
