/**
 * Unit Test Suite 09: Flight plan triggers, independent action latch, pending burns, ORBIT_ASSIST,
 * deferred separation, mission presets, deep-space sizing, the 6-column flight-profile table,
 * the thrust slider max, the fuel-change thrust clamp and launcher-config isolation.
 *
 * Expected values come from docs/design/2026-11-20_trajectory_fx_flightplan.md
 * §3.4 (requirement 4), §4.2 (G2-02), §4.5 (G2-04) and §4.6 (G2-05).
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-D (unit part).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupMockDOM, createMockUniverse } from '../test_helpers.mjs';

setupMockDOM();

import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { CalcRocket } from '../../scripts/gravsim_calc_object.js';
import { PresetManager, presetManager } from '../../scripts/gravsim_preset_manager.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { ObjectPlacer } from '../../scripts/gravsim_object_placer.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { PHYSICS } from '../../scripts/gravsim_const.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const assertNear = (actual, expected, tol, msg = '') => {
	assert.ok(
		Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
		`${msg ? msg + ': ' : ''}expected ${expected} ± ${tol}, got ${actual}`
	);
};

const normalizeAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const angleBetween = (a, b) => Math.abs(normalizeAngle(a - b));

/** Flight-profile row in the design's (type, value, thrust, angle, action) form */
const row = (type, value, action = '', thrust = 100, angle = 0) => ({ type, value, thrust, angle, action });

/** Sets the trigger inputs on a FlightComputer, runs one profile evaluation and drains the latched actions */
const evaluate = (fc, { altM, flightTime, vV, vH } = {}) => {
	if (altM !== undefined) fc.telemetryCache.altM = altM;
	if (flightTime !== undefined) fc.flightTime = flightTime;
	if (vV !== undefined) fc.telemetryCache.vV = vV;
	if (vH !== undefined) fc.telemetryCache.vH = vH;
	fc._evaluateProfile({});
	return fc.consumePendingActions();
};

// Adjacent double values (positive inputs only) for exact threshold tests
/* global BigInt, BigInt64Array */
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
const nextUp = (x) => { f64[0] = x; i64[0] += 1n; return f64[0]; };
const nextDown = (x) => { f64[0] = x; i64[0] -= 1n; return f64[0]; };

const EARTH = Object.freeze({ name: 'Earth', x: 0, y: 0, vx: 0, vy: 0, mass: 5.972e24, radius: 6371000 });
const GM_EARTH = PHYSICS.G * EARTH.mass;

/** Inertial state on the +X axis: radial component vr along +X, horizontal component vh along +Y */
const stateAt = (altM, vr, vh) => ({ x: EARTH.radius + altM, y: 0, vx: vr, vy: vh });

/**
 * Design §3.4-1 ORBIT_ASSIST (inertial vectors, apKm = Infinity when E >= 0), evaluated independently
 * of FlightComputer. Returns the intervention predicate and the commanded angle.
 */
const designAssist = (s, tgtAp, tgtPe, body = EARTH, disableOrbitalCutoff = false) => {
	const dx = s.x - body.x;
	const dy = s.y - body.y;
	const r = Math.hypot(dx, dy);
	const dvx = s.vx - body.vx;
	const dvy = s.vy - body.vy;
	const uRx = dx / r;
	const uRy = dy / r;
	const vr = dvx * uRx + dvy * uRy;
	const vHx = dvx - vr * uRx;
	const vHy = dvy - vr * uRy;
	const vHMag = Math.hypot(vHx, vHy);
	const altM = r - body.radius;
	const GM = PHYSICS.G * body.mass;
	const vSq = dvx * dvx + dvy * dvy;
	const E = 0.5 * vSq - GM / r;
	const h = dx * dvy - dy * dvx;
	const ecc = Math.sqrt(Math.max(0, 1 + (2 * E * h * h) / (GM * GM)));
	const apKm = E < 0 ? (((-GM / (2 * E)) * (1 + ecc)) - body.radius) / 1000 : Infinity;
	const isCircularTarget = Boolean(tgtAp > 0 && tgtPe > 0 && tgtAp / tgtPe <= 1.5);
	const intervenes = isCircularTarget && !disableOrbitalCutoff && altM >= 140000 && vHMag >= 4200 && (apKm >= tgtAp * 0.88 || E >= 0);
	const rTgt = body.radius + ((tgtAp + tgtPe) / 2) * 1000;
	const apOver = Number.isFinite(apKm) ? Math.max(0, (apKm - tgtAp) * 1000) : Math.max(0, altM);
	const vrRaw = ((rTgt - r) - 1.1 * apOver) / 130;
	const vrTgt = Math.max(-85, Math.min(14, vrRaw));
	const gammaRaw = (vrTgt - vr) / 650;
	const gamma = Math.max(-0.30, Math.min(0.45, gammaRaw));
	const tx = Math.cos(gamma) * (vHx / vHMag) + Math.sin(gamma) * uRx;
	const ty = Math.cos(gamma) * (vHy / vHMag) + Math.sin(gamma) * uRy;
	return { intervenes, angle: Math.atan2(ty, tx), apKm, E, vr, vrRaw, gammaRaw, gamma, altM, vHMag };
};

// Profile command used when ORBIT_ASSIST does not intervene (prograde = 0, no Q, so the safe target is the profile target)
const PROFILE_ANGLE_RAD = 2.5;

/** Runs FlightComputer._computeThrustAngle on a powered state and returns the commanded (desired) angle */
/** Runs _computeThrustAngle on an existing FlightComputer (its orbit targets untouched) and returns the commanded angle */
const commandFrom = (fc, s, sensorOver = {}) => {
	fc.flightTime = 100; // past the tower-clearance window
	fc.telemetryCache.altM = Math.hypot(s.x, s.y) - EARTH.radius;
	fc.telemetryCache.progradeAngle = 0;
	fc.telemetryCache.gravityAngle = Math.PI;
	fc.currentThrustAngle = 0;
	fc.targetLaunchAngle = PROFILE_ANGLE_RAD;
	fc._computeThrustAngle({
		dt: 1, burnTime: 100, stageState: 'STG_BURNING', isHoldDown: false,
		qAxialKpa: 0, qLateralKpa: 0, refBody: EARTH, ...s, ...sensorOver
	});
	return fc.desiredThrustAngleRad;
};

const commandedAngle = (s, tgtAp, tgtPe, sensorOver = {}, disableOrbitalCutoff = false) => {
	const fc = new FlightComputer({});
	fc.targetApogeeKm = tgtAp;
	fc.targetPerigeeKm = tgtPe;
	fc.disableOrbitalCutoff = disableOrbitalCutoff;
	return commandFrom(fc, s, sensorOver);
};

/** Minimal powered sensor for FlightComputer.update() */
const baseSensor = (over = {}) => ({
	dt: 1, mass: 100, dryMass: 10, fuelMass: 50, thrustForce: 1.0e6, thrustRatio: 1, burnTime: 100,
	massLossRate: 0.5, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, qAxialKpa: 0, qLateralKpa: 0,
	aoaDeg: 0, progradeAngle: 0, refBody: null, distToRefM: 0, isHoldDown: false, isIgnited: true,
	stageState: 'STG_BURNING', ...over
});

const liquidStage = (stageNumber, over = {}) => ({
	stageNumber, name: `Stage ${stageNumber}`, fuelType: 'liquid', thrustKN: 1000, isp: 320,
	dryMassT: 5, fuelMassT: 10, oxidMassT: 20, burnTime: 5, ofRatio: 2, radius: 2,
	separationDelaySec: 3, ignitionDelaySec: 2, jettisonSpeedM_S: 5, ...over
});

const PASSIVE_PAYLOAD = Object.freeze({ name: 'Passive Sat', massT: 3, radius: 1.5, propulsion: { enabled: false } });
const SELF_PROPELLED_PAYLOAD = Object.freeze({
	name: 'Kick Sat', massT: 4, radius: 1.8,
	propulsion: { enabled: true, name: 'OMS', fuelType: 'liquid', thrustKN: 20, dryMassT: 2.5, fuelMassT: 0.5, oxidMassT: 1.0, burnTime: 200, ofRatio: 2 }
});
const FAIRING = Object.freeze({ enabled: true, massT: 1.5, separationAltKm: 110 });

const makeRocket = ({ stageCount = 2, profile = [row('time', 0)], payload = PASSIVE_PAYLOAD, fairing = null, stageOver = {}, extra = {} } = {}) => {
	const stages = Array.from({ length: stageCount }, (_, i) => liquidStage(i + 1, stageOver[i] || {}));
	return new CalcRocket(
		101, 'Test Rocket', 0, 0, 0, 0, 0, 0, 2, 0,
		stages[0].dryMassT, stages[0].fuelMassT, stages[0].oxidMassT,
		{
			stages,
			payload: JSON.parse(JSON.stringify(payload)),
			fairing: fairing ? { ...fairing } : undefined,
			flightProfile: profile,
			isHoldDown: false,
			isIgnited: true,
			autoControl: true,
			disableOrbitalCutoff: true,
			...extra
		}
	);
};

/** Profile whose only action row is far in the future (scheduled, never latched during the test) */
const scheduled = (action) => (action ? [row('time', 0), row('time', 1e6, action)] : [row('time', 0)]);

const snapshotStaging = (rocket) => ({
	currentStageIndex: rocket.currentStageIndex,
	stageState: rocket.stageState,
	isPayloadSeparated: rocket.isPayloadSeparated,
	isStage2Separated: rocket.isStage2Separated,
	fuelMass: rocket.fuelMass,
	oxidMass: rocket.oxidMass,
	burnTime: rocket.burnTime,
	isIgnited: rocket.isIgnited,
	fairingSeparated: rocket.fairing.isSeparated,
	debris: rocket._pendingDebris.length,
	mass: rocket.mass
});

const debrisTypes = (rocket) => rocket._pendingDebris.map(d => d.debrisSubType).sort((a, b) => a - b);

/** Advances the rocket to its final stage (index 1 of 2) and makes it a burning upper stage */
const toBurningUpperStage = (rocket) => {
	rocket.separateCurrentStage();
	rocket._pendingDebris.length = 0;
	rocket.stageState = 'STG_BURNING';
	rocket.isIgnited = true;
	return rocket;
};

/** Places the rocket at altitude altM on +X with prograde speed v (radial 0); returns distToRefM */
const placeOnX = (rocket, altM, v) => {
	const r = EARTH.radius + altM;
	rocket.x = r; rocket.y = 0; rocket.vx = 0; rocket.vy = v;
	return r;
};

/** Speed giving hyperbolic excess vInfKmS at radius r */
const speedForVInf = (r, vInfKmS) => Math.sqrt((vInfKmS * 1000) ** 2 + 2 * GM_EARTH / r);
/** Same E / V∞ expression order as the cutoff check (design §3.4-1) */
const vInfAt = (r, v) => {
	const E = 0.5 * v * v - GM_EARTH / r;
	return E >= 0 ? Math.sqrt(2 * E) / 1000 : NaN;
};

/** Fresh mock document (element registry and listeners are per document) */
const freshDom = () => {
	delete globalThis.document;
	setupMockDOM();
};

const makeTab = (configure) => {
	freshDom();
	EventBus.clearAll();
	const universe = createMockUniverse();
	if (configure) configure(universe.RocketLauncher, universe);
	const tab = new RocketTab(universe);
	return { universe, tab, launcher: universe.RocketLauncher };
};

/** Parses the option list that RocketTab writes into a <select> via innerHTML */
const parseOptions = (selectEl) => {
	const opts = [];
	const re = /<option value="([^"]*)"\s*(selected)?\s*>([^<]*)<\/option>/g;
	let m;
	while ((m = re.exec(selectEl.innerHTML)) !== null) {
		opts.push({ value: m[1], selected: m[2] === 'selected', label: m[3] });
	}
	return opts;
};
const selectedValue = (selectEl) => {
	const sel = parseOptions(selectEl).filter(o => o.selected);
	return sel.length === 1 ? sel[0].value : (sel.length === 0 ? null : 'MULTIPLE');
};
const classesOf = (el) => String(el.className || '').split(/\s+/).filter(Boolean);
const profileRows = (tab) => tab.ui.rlFlightProfileBody.children;

const DESIGN_MISSIONS = {
	leo_250km: {
		ap: null, pe: null, vinf: null, cutoffDisabled: false, dv: 9300,
		rows: [['alt', 0, 100, 0], ['alt', 2000, 100, 10], ['alt', 15000, 100, 26], ['alt', 40000, 100, 48], ['alt', 80000, 100, 68], ['alt', 150000, 100, 80], ['alt', 220000, 100, 86], ['alt', 300000, 100, 89], ['alt', 380000, 100, 90]]
	},
	iss_rendezvous: {
		ap: 400, pe: 400, vinf: null, cutoffDisabled: false, dv: 9500,
		rows: [['alt', 0, 100, 0], ['alt', 2000, 100, 8], ['alt', 18000, 100, 22], ['alt', 50000, 100, 42], ['alt', 100000, 100, 62], ['alt', 200000, 100, 76], ['alt', 320000, 100, 85], ['alt', 400000, 100, 90]]
	},
	gto_insertion: {
		ap: 35786, pe: 250, vinf: null, cutoffDisabled: false, dv: 11800,
		rows: [['alt', 0, 100, 0], ['alt', 2000, 100, 11], ['alt', 14000, 100, 28], ['alt', 38000, 100, 50], ['alt', 78000, 100, 70], ['alt', 145000, 100, 82], ['alt', 210000, 100, 87], ['alt', 290000, 100, 89], ['alt', 370000, 100, 90]]
	},
	lunar_insertion: {
		ap: 384400, pe: 250, vinf: null, cutoffDisabled: false, dv: 12300,
		rows: [['alt', 0, 100, 0], ['alt', 1800, 100, 11], ['alt', 14000, 100, 29], ['alt', 36000, 100, 51], ['alt', 75000, 100, 71], ['alt', 140000, 100, 83], ['alt', 205000, 100, 88], ['alt', 285000, 100, 89], ['alt', 360000, 100, 90]]
	},
	mars_transfer: {
		ap: null, pe: null, vinf: 3.3, cutoffDisabled: true, dv: 12800,
		rows: [['alt', 0, 100, 0], ['alt', 2000, 100, 10], ['alt', 15000, 100, 26], ['alt', 42000, 100, 46], ['alt', 85000, 100, 66], ['alt', 155000, 100, 78], ['alt', 230000, 100, 85], ['alt', 310000, 100, 89], ['alt', 380000, 100, 90]]
	},
	jupiter_transfer: {
		ap: null, pe: null, vinf: 9.0, cutoffDisabled: true, dv: 15800,
		rows: [['alt', 0, 100, 0], ['alt', 2000, 100, 9], ['alt', 16000, 100, 25], ['alt', 44000, 100, 45], ['alt', 90000, 100, 64], ['alt', 165000, 100, 77], ['alt', 245000, 100, 85], ['alt', 325000, 100, 89], ['alt', 390000, 100, 90]]
	},
	solar_escape: {
		ap: null, pe: null, vinf: 12.8, cutoffDisabled: true, dv: 18500,
		rows: [['alt', 0, 100, 0], ['alt', 2000, 100, 8], ['alt', 17000, 100, 24], ['alt', 48000, 100, 44], ['alt', 95000, 100, 63], ['alt', 175000, 100, 76], ['alt', 260000, 100, 84], ['alt', 340000, 100, 88], ['alt', 400000, 100, 90]]
	}
};

beforeEach(() => {
	EventBus.clearAll();
});

// ---------------------------------------------------------------------------
// 1. FlightComputer: trigger values and step triggering (design §3.4-1, §4.5)
// ---------------------------------------------------------------------------

describe('FlightComputer.getTriggerValue (single source of truth, design §4.5)', () => {
	it('time returns flightTime', () => {
		const fc = new FlightComputer({});
		assert.equal(fc.getTriggerValue('time'), 0);
		fc.flightTime = 12.5;
		assert.equal(fc.getTriggerValue('time'), 12.5);
		fc.flightTime = 1e6;
		assert.equal(fc.getTriggerValue('time'), 1e6);
	});

	it('alt returns the telemetry altitude (including a value below the surface)', () => {
		const fc = new FlightComputer({});
		assert.equal(fc.getTriggerValue('alt'), 0);
		fc.telemetryCache.altM = 150000;
		assert.equal(fc.getTriggerValue('alt'), 150000);
		fc.telemetryCache.altM = -5;
		assert.equal(fc.getTriggerValue('alt'), -5);
	});

	it('vel returns hypot(vV || 0, vH || 0)', () => {
		const fc = new FlightComputer({});
		const cases = [
			[3, 4, 5], [-3, -4, 5], [0, 0, 0], [1800, 2400, 3000],
			[undefined, 4, 4], [3, undefined, 3], [NaN, NaN, 0], [NaN, 7, 7]
		];
		for (const [vV, vH, expected] of cases) {
			fc.telemetryCache.vV = vV;
			fc.telemetryCache.vH = vH;
			assert.equal(fc.getTriggerValue('vel'), expected, `vV=${vV} vH=${vH}`);
		}
	});

	it('apogee is NaN before apogee passage and the elapsed time after it', () => {
		const fc = new FlightComputer({});
		fc.flightTime = 500;
		assert.ok(Number.isNaN(fc.getTriggerValue('apogee')));
		fc.hasPassedApogee = true;
		fc.apogeeTime = 500;
		assert.equal(fc.getTriggerValue('apogee'), 0);
		fc.flightTime = 530;
		assert.equal(fc.getTriggerValue('apogee'), 30);
	});

	it('unknown, missing or non-string trigger types return NaN', () => {
		const fc = new FlightComputer({});
		fc.flightTime = 10;
		fc.telemetryCache.altM = 10;
		for (const type of ['foo', 'ALT', 'Time', '', ' alt', undefined, null, 0, 42, {}, []]) {
			assert.ok(Number.isNaN(fc.getTriggerValue(type)), `type=${String(type)}`);
		}
	});

	it('apogee passage is detected only above APOGEE_MIN_ALT_M (100 km) on a vV sign change', () => {
		const run = (altM, vVFirst, vVSecond, isHoldDown = false) => {
			const fc = new FlightComputer({});
			const r = EARTH.radius + altM;
			const sensor = (vV) => baseSensor({ refBody: EARTH, distToRefM: r, x: r, y: 0, vx: vV, vy: 7000, isHoldDown, burnTime: 0 });
			fc.update(sensor(vVFirst));
			fc.update(sensor(vVSecond));
			return fc;
		};
		const below = run(99999, 5, -5);
		assert.equal(below.hasPassedApogee, false);
		assert.ok(Number.isNaN(below.getTriggerValue('apogee')));

		const atLimit = run(100000, 5, -5);
		assert.equal(atLimit.hasPassedApogee, true);
		assert.equal(atLimit.apogeeTime, 2);
		assert.equal(atLimit.getTriggerValue('apogee'), 0);

		const toZero = run(150000, 5, 0);
		assert.equal(toZero.hasPassedApogee, true, 'vV reaching exactly 0 counts as passage');

		const fromZero = run(150000, 0, -5);
		assert.equal(fromZero.hasPassedApogee, false, 'the previous vV must be strictly positive');

		const heldDown = run(150000, 5, -5, true);
		assert.equal(heldDown.hasPassedApogee, false, 'no detection while held down');
	});
});

describe('FlightComputer._isStepTriggered boundaries', () => {
	it('returns false for a missing step', () => {
		const fc = new FlightComputer({});
		assert.equal(fc._isStepTriggered(null), false);
		assert.equal(fc._isStepTriggered(undefined), false);
	});

	it('time: just below / equal / just above the threshold', () => {
		const fc = new FlightComputer({});
		const step = row('time', 100);
		fc.flightTime = nextDown(100);
		assert.equal(fc._isStepTriggered(step), false);
		fc.flightTime = 100;
		assert.equal(fc._isStepTriggered(step), true);
		fc.flightTime = nextUp(100);
		assert.equal(fc._isStepTriggered(step), true);
	});

	it('alt: just below / equal / just above the threshold', () => {
		const fc = new FlightComputer({});
		const step = row('alt', 2000);
		fc.telemetryCache.altM = nextDown(2000);
		assert.equal(fc._isStepTriggered(step), false);
		fc.telemetryCache.altM = 2000;
		assert.equal(fc._isStepTriggered(step), true);
		fc.telemetryCache.altM = nextUp(2000);
		assert.equal(fc._isStepTriggered(step), true);
	});

	it('vel: just below / equal / just above the threshold on the vector magnitude', () => {
		const fc = new FlightComputer({});
		const step = row('vel', 3000);
		fc.telemetryCache.vV = 0;
		fc.telemetryCache.vH = nextDown(3000);
		assert.equal(fc._isStepTriggered(step), false);
		fc.telemetryCache.vV = 1800;
		fc.telemetryCache.vH = 2400; // |v| = 3000 exactly
		assert.equal(fc._isStepTriggered(step), true);
		fc.telemetryCache.vV = -1800; // descending still counts by magnitude
		assert.equal(fc._isStepTriggered(step), true);
		fc.telemetryCache.vV = 0;
		fc.telemetryCache.vH = nextUp(3000);
		assert.equal(fc._isStepTriggered(step), true);
	});

	it('apogee: never fires before passage (even with value 0), then on elapsed >= value', () => {
		const fc = new FlightComputer({});
		fc.flightTime = 1000;
		assert.equal(fc._isStepTriggered(row('apogee', 0)), false);
		assert.equal(fc._isStepTriggered({ type: 'apogee', thrust: 100, angle: 0 }), false);
		fc.hasPassedApogee = true;
		fc.apogeeTime = 1000;
		fc.flightTime = 1029.999;
		assert.equal(fc._isStepTriggered(row('apogee', 30)), false);
		fc.flightTime = 1030;
		assert.equal(fc._isStepTriggered(row('apogee', 30)), true);
		fc.flightTime = 1030.001;
		assert.equal(fc._isStepTriggered(row('apogee', 30)), true);
	});

	it('uses an exact >= comparison (no tolerance at the floating-point limit)', () => {
		const fc = new FlightComputer({});
		let t = 0;
		for (let i = 0; i < 10; i++) t += 0.1;
		assert.notEqual(t, 1); // 0.9999999999999999
		fc.flightTime = t;
		assert.equal(fc._isStepTriggered(row('time', 1)), false);
		assert.equal(fc._isStepTriggered(row('time', t)), true);
	});

	it('unknown trigger types never fire; a row without a value uses threshold 0', () => {
		const fc = new FlightComputer({});
		fc.flightTime = 1e9;
		fc.telemetryCache.altM = 1e9;
		for (const type of ['foo', '', undefined, null]) {
			assert.equal(fc._isStepTriggered({ type, value: 0, thrust: 100, angle: 0 }), false, `type=${String(type)}`);
		}
		const fresh = new FlightComputer({});
		assert.equal(fresh._isStepTriggered({ type: 'time', thrust: 100, angle: 0 }), true);
		fresh.telemetryCache.altM = -1;
		assert.equal(fresh._isStepTriggered({ type: 'alt', thrust: 100, angle: 0 }), false);
	});
});

describe('FlightComputer profile interpolation for every trigger type (design §3.4-1, §4.5)', () => {
	// §3.4-1: the interpolation value currentVal implements time, alt, vel and apogee; §4.5: it comes from
	// getTriggerValue. Between two rows of the same type, progress = (current - valueA) / (valueB - valueA),
	// and thrust / angle are linear in progress.
	const interpolate = (rows, inputs, apogee = null) => {
		const fc = new FlightComputer({ flightProfile: rows });
		if (apogee) { fc.hasPassedApogee = true; fc.apogeeTime = apogee.apogeeTime; }
		evaluate(fc, inputs);
		assert.equal(fc._highestStepIndex, 0, 'between row 0 and row 1');
		return fc._profileState;
	};

	it('time rows: progress 0.75 at t = 17.5 s between 10 s and 20 s', () => {
		const s = interpolate([row('time', 10, '', 100, 0), row('time', 20, '', 60, 40)], { flightTime: 17.5 });
		assertNear(s.throttle, 1.0 + (0.6 - 1.0) * 0.75, 1e-12);
		assertNear(s.relAngleDeg, 30, 1e-12);
	});

	it('vel rows: progress uses hypot(vV, vH) (vV = ±1200, vH = 1600 m/s -> 2000 m/s, halfway between 1000 and 3000)', () => {
		for (const vV of [1200, -1200]) {
			const s = interpolate([row('vel', 1000, '', 100, 10), row('vel', 3000, '', 50, 50)], { vV, vH: 1600 });
			assertNear(s.throttle, 0.75, 1e-12, `vV=${vV}`);
			assertNear(s.relAngleDeg, 30, 1e-12, `vV=${vV}`);
		}
		const vertical = interpolate([row('vel', 1000, '', 100, 10), row('vel', 3000, '', 50, 50)], { vV: 2500, vH: 0 });
		assertNear(vertical.throttle, 1.0 + (0.5 - 1.0) * 0.75, 1e-12, 'a purely vertical velocity also interpolates');
		assertNear(vertical.relAngleDeg, 40, 1e-12);
	});

	it('apogee rows: progress uses the time since apogee passage (15 s between 10 s and 30 s)', () => {
		const s = interpolate([row('apogee', 10, '', 100, 20), row('apogee', 30, '', 50, 60)], { flightTime: 115 }, { apogeeTime: 100 });
		assertNear(s.throttle, 1.0 + (0.5 - 1.0) * 0.25, 1e-12);
		assertNear(s.relAngleDeg, 30, 1e-12);
	});
});

// ---------------------------------------------------------------------------
// 2. Independent action latch, scheduled/pending actions, pending burns
// ---------------------------------------------------------------------------

describe('FlightComputer independent action latch (design §3.4-1)', () => {
	it('emits every action of the rows crossed in one evaluation exactly once, in row order', () => {
		const fc = new FlightComputer({
			flightProfile: [
				row('alt', 0), row('alt', 1000, 'sep_stage1'), row('alt', 2000), row('alt', 3000, 'sep_stage2'),
				row('alt', 4000, 'sep_payload'), row('alt', 100000)
			]
		});
		assert.deepEqual(evaluate(fc, { altM: 4500 }), ['sep_stage1', 'sep_stage2', 'sep_payload']);
		assert.equal(fc._highestStepIndex, 4);
		assert.deepEqual([...fc._triggeredActionIndices].sort(), [1, 3, 4]);
		assert.deepEqual(evaluate(fc, { altM: 4500 }), [], 'no re-emission at the same state');
		assert.deepEqual(evaluate(fc, { altM: 200000 }), [], 'reaching the last (action-less) row emits nothing');
		assert.equal(fc._highestStepIndex, 5);
	});

	it('latches an already-satisfied action row behind an unreached guide row once and never re-emits it', () => {
		const fc = new FlightComputer({
			flightProfile: [row('alt', 0), row('alt', 100000), row('time', 10, 'sep_stage1'), row('time', 20, 'sep_payload')]
		});
		assert.deepEqual(evaluate(fc, { altM: 500, flightTime: 15 }), ['sep_stage1']);
		assert.equal(fc._highestStepIndex, 0, 'the sequential latch stays blocked by the guide row');
		assert.deepEqual(evaluate(fc, { flightTime: 19.999 }), []);
		assert.deepEqual(evaluate(fc, { flightTime: 20 }), ['sep_payload']);
		assert.deepEqual(evaluate(fc, { flightTime: 25 }), []);
		// The guide row is reached later: the sequential latch passes rows 2 and 3 without re-emitting
		assert.deepEqual(evaluate(fc, { altM: 100000 }), []);
		assert.equal(fc._highestStepIndex, 3);
	});

	it('does not latch action rows whose own trigger is not met, and never latches unknown triggers', () => {
		const fc = new FlightComputer({
			flightProfile: [row('alt', 0), row('vel', 3000, 'sep_stage1'), row('warp', 0, 'sep_payload')]
		});
		assert.deepEqual(evaluate(fc, { altM: 10, vV: 0, vH: 2999 }), []);
		assert.equal(fc.hasScheduledAction('sep_stage1'), true);
		assert.deepEqual(evaluate(fc, { vH: 3000 }), ['sep_stage1']);
		assert.deepEqual(evaluate(fc, { altM: 1e9, flightTime: 1e9, vH: 1e9 }), []);
		assert.equal(fc.hasScheduledAction('sep_payload'), true, 'an unknown trigger stays scheduled');
	});

	it('rows with an empty or missing action are never emitted', () => {
		const fc = new FlightComputer({
			flightProfile: [row('time', 0), row('time', 1, ''), { type: 'time', value: 2, thrust: 100, angle: 0 }, { type: 'time', value: 3, thrust: 100, angle: 0, action: null }]
		});
		assert.deepEqual(evaluate(fc, { flightTime: 10 }), []);
		assert.equal(fc._triggeredActionIndices.size, 0);
		assert.equal(fc._highestStepIndex, 3);
	});

	it('the same action on two rows is emitted once per row', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0), row('time', 10, 'sep_payload'), row('time', 20, 'sep_payload')] });
		assert.deepEqual(evaluate(fc, { flightTime: 15 }), ['sep_payload']);
		assert.equal(fc.hasScheduledAction('sep_payload'), true, 'the second row is still scheduled');
		assert.deepEqual(evaluate(fc, { flightTime: 25 }), ['sep_payload']);
		assert.equal(fc.hasScheduledAction('sep_payload'), false);
	});

	it('an empty profile emits nothing and keeps full throttle', () => {
		const fc = new FlightComputer({ flightProfile: [] });
		assert.deepEqual(evaluate(fc, { flightTime: 10 }), []);
		assert.equal(fc._profileState.throttle, 1.0);
		assert.equal(fc._profileState.relAngleDeg, 0);
	});
});

describe('FlightComputer.hasScheduledAction / consumePendingActions', () => {
	it('hasScheduledAction reports unlatched rows only', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0), row('time', 10, 'sep_stage1'), row('time', 20, 'sep_payload')] });
		assert.equal(fc.hasScheduledAction('sep_stage1'), true);
		assert.equal(fc.hasScheduledAction('sep_payload'), true);
		assert.equal(fc.hasScheduledAction('sep_stage2'), false);
		evaluate(fc, { flightTime: 10 });
		assert.equal(fc.hasScheduledAction('sep_stage1'), false);
		assert.equal(fc.hasScheduledAction('sep_payload'), true);
		evaluate(fc, { flightTime: 20 });
		assert.equal(fc.hasScheduledAction('sep_payload'), false);
	});

	it('hasScheduledAction is false for empty names and non-array profiles', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0, ''), row('time', 10, 'sep_stage1')] });
		for (const name of ['', undefined, null, 0]) {
			assert.equal(fc.hasScheduledAction(name), false, `name=${String(name)}`);
		}
		for (const profile of [null, undefined, {}, 'sep_stage1']) {
			fc.flightProfile = profile;
			assert.equal(fc.hasScheduledAction('sep_stage1'), false, `profile=${String(profile)}`);
		}
		fc.flightProfile = [null, undefined, row('time', 10, 'sep_stage1')];
		assert.equal(fc.hasScheduledAction('sep_stage1'), true, 'holes in the profile are skipped');
	});

	it('consumePendingActions returns the pending list once and then an empty array', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0), row('time', 1, 'sep_stage1'), row('time', 2, 'sep_payload')] });
		const none = fc.consumePendingActions();
		assert.deepEqual(none, []);
		none.push('foreign');
		assert.deepEqual(fc._pendingActions, [], 'the empty result is not the internal array');

		fc.flightTime = 5;
		fc._evaluateProfile({});
		const first = fc.consumePendingActions();
		assert.deepEqual(first, ['sep_stage1', 'sep_payload']);
		assert.deepEqual(fc._pendingActions, []);
		first.push('foreign');
		assert.deepEqual(fc.consumePendingActions(), []);

		fc._pendingActions = undefined; // corrupted state is tolerated
		assert.deepEqual(fc.consumePendingActions(), []);
	});
});

describe('FlightComputer.hasPendingBurnStep (design §4.5, G2-04)', () => {
	it('recognizes an unreached vel row with thrust > 0 after a coast row', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0), row('time', 50, '', 0), row('vel', 3000, '', 100)] });
		evaluate(fc, { flightTime: 60, vV: 0, vH: 2000 });
		assert.equal(fc._highestStepIndex, 1);
		assert.equal(fc._profileState.throttle, 0);
		assert.equal(fc.hasPendingBurnStep(), true);
		evaluate(fc, { vH: 3000 });
		assert.equal(fc._highestStepIndex, 2);
		assert.equal(fc.hasPendingBurnStep(), false);
	});

	it('counts a satisfied later row as pending while an earlier row blocks it', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0), row('alt', 1e9, '', 0), row('vel', 0, '', 100)] });
		evaluate(fc, { flightTime: 10, altM: 100, vV: 0, vH: 500 });
		assert.equal(fc._highestStepIndex, 0);
		assert.equal(fc._isStepTriggered(fc.flightProfile[2]), true);
		assert.equal(fc.hasPendingBurnStep(), true);
	});

	it('includes the first row before any row is reached', () => {
		const fc = new FlightComputer({ flightProfile: [row('alt', 5000, '', 100)] });
		assert.equal(fc._highestStepIndex, -1);
		assert.equal(fc.hasPendingBurnStep(), true);
	});

	it('is false when only zero/non-positive/missing-thrust rows remain, or the profile is empty or invalid', () => {
		const fc = new FlightComputer({
			flightProfile: [row('time', 0), row('time', 10, '', 0), { type: 'vel', value: 9e9, angle: 0 }, row('alt', 9e9, '', -5)]
		});
		evaluate(fc, { flightTime: 10 });
		assert.equal(fc._highestStepIndex, 1);
		assert.equal(fc.hasPendingBurnStep(), false);
		fc.flightProfile = [row('time', 0), row('time', 10, '', 0), null, undefined, row('alt', 9e9, '', 0)];
		assert.equal(fc.hasPendingBurnStep(), false, 'holes are skipped');
		fc.flightProfile.push(row('alt', 9e9, '', 1));
		assert.equal(fc.hasPendingBurnStep(), true);
		for (const profile of [[], null, undefined, {}]) {
			fc.flightProfile = profile;
			assert.equal(fc.hasPendingBurnStep(), false, `profile=${String(profile)}`);
		}
	});
});

describe('FlightComputer.update during ORBITAL_COAST (design §3.4-1)', () => {
	it('keeps extracting actions with throttle 0', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0), row('time', 5, 'sep_payload')] });
		fc.update(baseSensor({ dt: 6, stageState: 'ORBITAL_COAST', burnTime: 100 }));
		assert.equal(fc.flightTime, 6);
		assert.equal(fc.currentThrottle, 0);
		assert.deepEqual(fc.consumePendingActions(), ['sep_payload']);
		fc.update(baseSensor({ dt: 1, stageState: 'ORBITAL_COAST', burnTime: 100 }));
		assert.equal(fc.currentThrottle, 0);
		assert.deepEqual(fc.consumePendingActions(), []);
	});

	it('the same profile commands full throttle in STG_BURNING', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0), row('time', 5, 'sep_payload')] });
		fc.update(baseSensor({ dt: 6, stageState: 'STG_BURNING', burnTime: 100 }));
		assert.equal(fc.currentThrottle, 1);
		assert.deepEqual(fc.consumePendingActions(), ['sep_payload']);
	});
});

// ---------------------------------------------------------------------------
// 3. ORBIT_ASSIST (design §3.4-1, fixed formula)
// ---------------------------------------------------------------------------

describe('FlightComputer ORBIT_ASSIST intervention and clamps', () => {
	it('inside the window: the unclamped command phi = pi/2 - gamma (rocket on +X moving +Y)', () => {
		const s = stateAt(398500, 0, 7600);
		const d = designAssist(s, 400, 400);
		assert.equal(d.intervenes, true);
		assert.ok(d.apKm >= 352 && d.apKm <= 400, `apKm=${d.apKm}`);
		assert.ok(d.vrRaw > -85 && d.vrRaw < 14, `vrRaw=${d.vrRaw}`);
		assert.ok(d.gammaRaw > -0.30 && d.gammaRaw < 0.45, `gammaRaw=${d.gammaRaw}`);
		const gamma = (1500 / 130) / 650; // (r_tgt - r) = 1500 m, apOver = 0, v_r = 0
		assertNear(commandedAngle(s, 400, 400), Math.PI / 2 - gamma, 1e-12, 'commanded angle');
	});

	it('apogee != perigee target: r_tgt is R + (h_ap + h_pe) / 2 (420/380 and 380/420 km, unclamped)', () => {
		// The state is the apogee of its orbit (v_r = 0, v below circular), so apKm = altitude.
		// 420/380 at 398.5 km: r_tgt - r = 400 - 398.5 km = 1500 m; apKm < 420 -> apOver = 0
		const s1 = stateAt(398500, 0, 7600);
		const d1 = designAssist(s1, 420, 380);
		assert.equal(d1.intervenes, true);
		assertNear(d1.apKm, 398.5, 1e-6, 'apKm = altitude at apogee');
		const gamma1 = (1500 / 130) / 650;
		assert.ok(gamma1 > -0.30 && gamma1 < 0.45 && 1500 / 130 < 14, 'unclamped');
		assertNear(commandedAngle(s1, 420, 380), Math.PI / 2 - gamma1, 1e-12, '420/380');

		// 380/420 at 389 km: r_tgt - r = 400 - 389 km = 11000 m; apOver = (389 - 380) km = 9000 m
		const s2 = stateAt(389000, 0, 7600);
		const d2 = designAssist(s2, 380, 420);
		assert.equal(d2.intervenes, true);
		assertNear(d2.apKm, 389, 1e-6, 'apKm = altitude at apogee');
		const vr2 = (11000 - 1.1 * 9000) / 130; // 8.46 m/s, inside [-85, +14]
		assert.ok(vr2 > -85 && vr2 < 14, 'unclamped');
		assertNear(commandedAngle(s2, 380, 420), Math.PI / 2 - vr2 / 650, 1e-10, '380/420');
	});

	it('clamps v_r,tgt at +14 m/s', () => {
		const s = stateAt(250000, 0, 7800);
		const d = designAssist(s, 400, 400);
		assert.equal(d.intervenes, true);
		assert.ok(d.apKm >= 352 && d.apKm <= 400, `apKm=${d.apKm}`);
		assert.ok(d.vrRaw > 14);
		assertNear(commandedAngle(s, 400, 400), Math.PI / 2 - 14 / 650, 1e-12);
	});

	it('clamps v_r,tgt at -85 m/s (E >= 0: apOver = altitude)', () => {
		const s = stateAt(200000, 0, 11100);
		const d = designAssist(s, 400, 400);
		assert.ok(d.E > 0);
		assert.ok(d.vrRaw < -85);
		assertNear(commandedAngle(s, 400, 400), Math.PI / 2 + 85 / 650, 1e-12);
	});

	it('clamps gamma at -0.30 rad', () => {
		const s = stateAt(200000, 200, 11100);
		const d = designAssist(s, 400, 400);
		assert.ok(d.gammaRaw < -0.30);
		assertNear(commandedAngle(s, 400, 400), Math.PI / 2 + 0.30, 1e-12);
		const s2 = stateAt(250000, 250, 7800); // bound orbit variant
		assert.ok(designAssist(s2, 400, 400).gammaRaw < -0.30);
		assertNear(commandedAngle(s2, 400, 400), Math.PI / 2 + 0.30, 1e-12);
	});

	it('clamps gamma at +0.45 rad', () => {
		const s = stateAt(380000, -400, 7650);
		const d = designAssist(s, 400, 400);
		assert.equal(d.intervenes, true);
		assert.ok(d.gammaRaw > 0.45);
		assertNear(commandedAngle(s, 400, 400), Math.PI / 2 - 0.45, 1e-12);
	});

	it('altitude threshold 140 km: below / equal / above', () => {
		const expected = Math.PI / 2 + 0.30; // hyperbolic state, gamma clamps at -0.30
		assert.equal(commandedAngle(stateAt(139999.99, 10200, 4500), 400, 400), PROFILE_ANGLE_RAD);
		assertNear(commandedAngle(stateAt(140000, 10200, 4500), 400, 400), expected, 1e-12);
		assertNear(commandedAngle(stateAt(140000.01, 10200, 4500), 400, 400), expected, 1e-12);
	});

	it('horizontal speed threshold 4200 m/s: below / equal / above', () => {
		const expected = Math.PI / 2 - 14 / 650; // apKm = 360 km (>= 352), r_tgt - r = 40 km
		for (const vh of [4199.999, 4200, 4200.001]) {
			assert.ok(designAssist(stateAt(360000, 0, vh), 400, 400).apKm >= 352);
		}
		assert.equal(commandedAngle(stateAt(360000, 0, 4199.999), 400, 400), PROFILE_ANGLE_RAD);
		assertNear(commandedAngle(stateAt(360000, 0, 4200), 400, 400), expected, 1e-12);
		assertNear(commandedAngle(stateAt(360000, 0, 4200.001), 400, 400), expected, 1e-12);
	});

	it('apogee threshold apKm >= 0.88 x target: below / equal / above (exact doubles)', () => {
		const s = stateAt(360000, 0, 4500);
		const apKm = designAssist(s, 400, 400).apKm;
		let tEq = null;
		for (let k = -16, t = apKm / 0.88; k <= 16 && tEq === null; k++) {
			f64[0] = t; i64[0] += BigInt(k);
			if (f64[0] * 0.88 === apKm) tEq = f64[0];
		}
		assert.ok(tEq !== null, 'a target with target*0.88 === apKm exists');
		let tAbove = tEq;
		while (tAbove * 0.88 <= apKm) tAbove = nextUp(tAbove);
		let tBelow = tEq;
		while (tBelow * 0.88 >= apKm) tBelow = nextDown(tBelow);

		const expected = Math.PI / 2 - 14 / 650; // apOver = 0, (r_tgt - r) / 130 > 14
		assertNear(commandedAngle(s, tBelow, tBelow), expected, 1e-12, 'apKm > 0.88 target');
		assertNear(commandedAngle(s, tEq, tEq), expected, 1e-12, 'apKm == 0.88 target');
		assert.equal(commandedAngle(s, tAbove, tAbove), PROFILE_ANGLE_RAD, 'apKm < 0.88 target');
	});

	it('E >= 0 boundary: apOver switches from the (huge) apogee overshoot to the current altitude', () => {
		const altM = 192000;
		const r = EARTH.radius + altM;
		const vEsc = Math.sqrt(2 * GM_EARTH / r);
		const below = stateAt(altM, 0, vEsc * (1 - 1e-7));
		const above = stateAt(altM, 0, vEsc * (1 + 1e-7));
		assert.ok(designAssist(below, 400, 400).E < 0);
		assert.ok(designAssist(above, 400, 400).E > 0);
		assertNear(commandedAngle(below, 400, 400), Math.PI / 2 + 85 / 650, 1e-12, 'E < 0');
		const gammaAbove = ((400000 - altM) - 1.1 * altM) / 130 / 650;
		assertNear(commandedAngle(above, 400, 400), Math.PI / 2 - gammaAbove, 1e-12, 'E > 0');
	});

	it('near-circular target ratio 1.5: below / equal / above', () => {
		const s = stateAt(200000, 0, 11100);
		const expected = Math.PI / 2 - 14 / 650; // r_tgt = R + 500 km, apOver = 200 km
		assertNear(commandedAngle(s, 599.9999999, 400), expected, 1e-9);
		assertNear(commandedAngle(s, 600, 400), expected, 1e-12);
		assert.equal(commandedAngle(s, 600.0000001, 400), PROFILE_ANGLE_RAD);
	});

	it('never intervenes for non-circular, zero, negative or non-finite targets', () => {
		const s = stateAt(200000, 0, 11100);
		for (const [ap, pe] of [[35786, 250], [384400, 250], [0, 400], [400, 0], [0, 0], [-400, -400], [NaN, 400], [400, NaN], [undefined, undefined]]) {
			assert.equal(commandedAngle(s, ap, pe), PROFILE_ANGLE_RAD, `ap=${ap} pe=${pe}`);
		}
	});

	it('disableOrbitalCutoff boundary: false intervenes, true never intervenes (same state and targets)', () => {
		for (const s of [stateAt(398500, 0, 7600), stateAt(200000, 0, 11100), stateAt(140000, 10200, 4500)]) {
			const d = designAssist(s, 400, 400);
			assert.equal(d.intervenes, true);
			assertNear(commandedAngle(s, 400, 400, {}, false), d.angle, 1e-12);
			assert.equal(designAssist(s, 400, 400, EARTH, true).intervenes, false);
			assert.equal(commandedAngle(s, 400, 400, {}, true), PROFILE_ANGLE_RAD);
		}
		const viaSensor = new FlightComputer({ flightProfile: [row('time', 0, '', 100, 90)] });
		const s = stateAt(200000, 0, 11100);
		viaSensor.update(baseSensor({
			...s, dt: 1, refBody: EARTH, distToRefM: s.x, progradeAngle: Math.PI / 2,
			targetApogeeKm: 400, targetPerigeeKm: 400, disableOrbitalCutoff: true
		}));
		assert.equal(viaSensor.disableOrbitalCutoff, true);
		assertNear(viaSensor.desiredThrustAngleRad, normalizeAngle(viaSensor.targetLaunchAngle), 1e-12, 'the profile command is kept');
		assert.ok(angleBetween(viaSensor.desiredThrustAngleRad, designAssist(s, 400, 400).angle) > 1e-3);
	});

	it('never intervenes outside STG_BURNING, without a valid host, or below the surface', () => {
		const s = stateAt(200000, 0, 11100);
		assert.equal(commandedAngle(s, 400, 400, { stageState: 'STG_COAST' }), PROFILE_ANGLE_RAD);
		assert.equal(commandedAngle(s, 400, 400, { stageState: 'PRE_LAUNCH' }), PROFILE_ANGLE_RAD);
		assert.equal(commandedAngle(s, 400, 400, { refBody: null }), PROFILE_ANGLE_RAD);
		assert.equal(commandedAngle(s, 400, 400, { refBody: { ...EARTH, mass: 0 } }), PROFILE_ANGLE_RAD);
		assert.equal(commandedAngle(stateAt(-1, 0, 11100), 400, 400), PROFILE_ANGLE_RAD);
	});

	it('update() takes the targets from the sensor (CalcRocket sensor contract) and commands the assist angle', () => {
		const fc = new FlightComputer({ flightProfile: [row('time', 0, '', 100, 90)] });
		const s = stateAt(200000, 0, 11100);
		fc.update(baseSensor({
			...s, dt: 1, refBody: EARTH, distToRefM: s.x, progradeAngle: Math.PI / 2,
			targetApogeeKm: 400, targetPerigeeKm: 400, disableOrbitalCutoff: false
		}));
		assert.equal(fc.targetApogeeKm, 400);
		assert.equal(fc.targetPerigeeKm, 400);
		assert.equal(fc.disableOrbitalCutoff, false);
		assertNear(fc.desiredThrustAngleRad, Math.PI / 2 + 85 / 650, 1e-12);
	});
});

describe('FlightComputer constructor orbit targets (design §3.4-1, Rev 6.10)', () => {
	it('standalone construction keeps targetApogeeKm, targetPerigeeKm and disableOrbitalCutoff', () => {
		const fc = new FlightComputer({ targetApogeeKm: 400, targetPerigeeKm: 380, disableOrbitalCutoff: true });
		assert.equal(fc.targetApogeeKm, 400);
		assert.equal(fc.targetPerigeeKm, 380);
		assert.equal(fc.disableOrbitalCutoff, true);
		for (const empty of [new FlightComputer(), new FlightComputer({})]) {
			assert.equal(empty.targetApogeeKm, 0);
			assert.equal(empty.targetPerigeeKm, 0);
			assert.equal(empty.disableOrbitalCutoff, false);
		}
	});

	it('the constructor targets drive ORBIT_ASSIST before the first update', () => {
		const s = stateAt(200000, 0, 11100);
		const expected = designAssist(s, 400, 400).angle;
		assertNear(commandFrom(new FlightComputer({ targetApogeeKm: 400, targetPerigeeKm: 400 }), s), expected, 1e-12);
		assert.equal(commandFrom(new FlightComputer({ targetApogeeKm: 400, targetPerigeeKm: 400, disableOrbitalCutoff: true }), s), PROFILE_ANGLE_RAD);
		assert.equal(commandFrom(new FlightComputer({ targetApogeeKm: 35786, targetPerigeeKm: 250 }), s), PROFILE_ANGLE_RAD);
	});

	it('abnormal target values: numeric strings convert, string/NaN/null/undefined become 0, negatives stay and never intervene', () => {
		const cases = [['400', 400], ['abc', 0], ['', 0], [NaN, 0], [null, 0], [undefined, 0], [-400, -400], [0, 0]];
		for (const [value, expected] of cases) {
			const fc = new FlightComputer({ targetApogeeKm: value, targetPerigeeKm: value });
			assert.equal(fc.targetApogeeKm, expected, `targetApogeeKm=${String(value)}`);
			assert.equal(fc.targetPerigeeKm, expected, `targetPerigeeKm=${String(value)}`);
			const s = stateAt(200000, 0, 11100);
			const cmd = commandFrom(fc, s);
			if (expected > 0) assertNear(cmd, designAssist(s, expected, expected).angle, 1e-12);
			else assert.equal(cmd, PROFILE_ANGLE_RAD, `no intervention for ${String(value)}`);
		}
		for (const [value, expected] of [[1, true], ['yes', true], [0, false], ['', false], [NaN, false], [null, false], [undefined, false]]) {
			assert.equal(new FlightComputer({ disableOrbitalCutoff: value }).disableOrbitalCutoff, expected, `disableOrbitalCutoff=${String(value)}`);
		}
	});

	it('CalcRocket.flightComputer holds the rocket targets before the first update', () => {
		const circular = makeRocket({ extra: { targetApogeeKm: 400, targetPerigeeKm: 380, disableOrbitalCutoff: false } });
		assert.equal(circular.flightComputer.flightTime, 0);
		assert.equal(circular.flightComputer.targetApogeeKm, 400);
		assert.equal(circular.flightComputer.targetPerigeeKm, 380);
		assert.equal(circular.flightComputer.disableOrbitalCutoff, false);

		const deep = makeRocket({ extra: { disableOrbitalCutoff: true, targetVInfKmS: 3.3 } });
		assert.equal(deep.flightComputer.targetApogeeKm, 0);
		assert.equal(deep.flightComputer.targetPerigeeKm, 0);
		assert.equal(deep.flightComputer.disableOrbitalCutoff, true);

		const textual = makeRocket({ extra: { targetApogeeKm: '35786', targetPerigeeKm: 'x', disableOrbitalCutoff: false } });
		assert.equal(textual.flightComputer.targetApogeeKm, 35786);
		assert.equal(textual.flightComputer.targetPerigeeKm, 0);

		const none = makeRocket({ extra: { disableOrbitalCutoff: undefined } });
		assert.equal(none.flightComputer.targetApogeeKm, 0);
		assert.equal(none.flightComputer.disableOrbitalCutoff, false);
	});

	it('update() overrides the constructor values with defined sensor values only', () => {
		const fc = new FlightComputer({ targetApogeeKm: 400, targetPerigeeKm: 400, disableOrbitalCutoff: true });
		fc.update(baseSensor({ targetApogeeKm: 35786, targetPerigeeKm: 250, disableOrbitalCutoff: false }));
		assert.deepEqual([fc.targetApogeeKm, fc.targetPerigeeKm, fc.disableOrbitalCutoff], [35786, 250, false]);
		fc.update(baseSensor());
		assert.deepEqual([fc.targetApogeeKm, fc.targetPerigeeKm, fc.disableOrbitalCutoff], [35786, 250, false], 'absent sensor keys keep the current values');
		fc.update(baseSensor({ targetApogeeKm: null, targetPerigeeKm: 'abc', disableOrbitalCutoff: 1 }));
		assert.deepEqual([fc.targetApogeeKm, fc.targetPerigeeKm, fc.disableOrbitalCutoff], [0, 0, true]);

		const rocket = makeRocket({ extra: { targetApogeeKm: 400, targetPerigeeKm: 380, disableOrbitalCutoff: false } });
		rocket.targetApogeeKm = 500; // the per-step sensor carries the rocket's current targets
		rocket.flightControl(1.0);
		assert.equal(rocket.flightComputer.targetApogeeKm, 500);
		assert.equal(rocket.flightComputer.targetPerigeeKm, 380);
	});
});

// ---------------------------------------------------------------------------
// 4. CalcRocket deferred separation, profile actions and the V∞ cutoff
// ---------------------------------------------------------------------------

describe('CalcRocket._isCurrentStageSepDeferred / _isPayloadSepDeferred (design §3.4-1)', () => {
	// [total stages, current stage index, scheduled action, current-stage deferred, payload deferred]
	const CASES = [
		[1, 0, 'sep_payload', true, true],
		[1, 0, 'sep_stage1', false, false],
		[1, 0, 'sep_stage2', false, false],
		[1, 0, '', false, false],
		[2, 0, 'sep_stage1', true, false],
		[2, 0, 'sep_stage2', false, false],
		[2, 0, 'sep_payload', false, true],
		[2, 0, '', false, false],
		[2, 1, 'sep_payload', true, true],
		[2, 1, 'sep_stage2', true, true],
		[2, 1, 'sep_stage1', false, false],
		[2, 1, '', false, false],
		[3, 0, 'sep_stage1', true, false],
		[3, 0, 'sep_stage2', false, false],
		[3, 0, 'sep_payload', false, true],
		[3, 1, 'sep_stage2', true, false],
		[3, 1, 'sep_payload', false, true],
		[3, 1, 'sep_stage1', false, false],
		[3, 2, 'sep_payload', true, true],
		[3, 2, 'sep_stage2', false, false],
		[3, 2, 'sep_stage1', false, false]
	];

	for (const [total, cur, action, stageDeferred, payloadDeferred] of CASES) {
		it(`${total}-stage, stage index ${cur}, scheduled "${action}" -> stage ${stageDeferred}, payload ${payloadDeferred}`, () => {
			const rocket = makeRocket({ stageCount: total, profile: scheduled(action) });
			rocket.currentStageIndex = cur;
			assert.equal(rocket._isCurrentStageSepDeferred(), stageDeferred);
			assert.equal(rocket._isPayloadSepDeferred(), payloadDeferred);
		});
	}

	it('a latched action row no longer defers', () => {
		const rocket = makeRocket({ stageCount: 2, profile: [row('time', 0), row('time', 10, 'sep_stage1')] });
		assert.equal(rocket._isCurrentStageSepDeferred(), true);
		rocket.flightComputer.flightTime = 10;
		rocket.flightComputer._evaluateProfile({});
		assert.equal(rocket._isCurrentStageSepDeferred(), false);
	});

	it('a separated payload or a missing flight computer never defers', () => {
		const rocket = makeRocket({ stageCount: 2, profile: scheduled('sep_payload') });
		rocket.currentStageIndex = 1;
		rocket.isPayloadSeparated = true;
		assert.equal(rocket._isCurrentStageSepDeferred(), false);
		assert.equal(rocket._isPayloadSepDeferred(), false);
		const noFc = makeRocket({ stageCount: 2, profile: scheduled('sep_stage1') });
		noFc.flightComputer = null;
		assert.equal(noFc._isCurrentStageSepDeferred(), false);
		assert.equal(noFc._isPayloadSepDeferred(), false);
	});
});

describe('CalcRocket deferred auto-staging in STG_MECO (design §3.4-1)', () => {
	const burnToMeco = (rocket, dt = 1.0) => {
		for (let i = 0; i < 20 && rocket.stageState !== 'STG_MECO'; i++) rocket.flightControl(dt);
		assert.equal(rocket.stageState, 'STG_MECO');
		return rocket.flightComputer.flightTime;
	};

	it('without a reservation, separates exactly when stgTimer reaches separationDelaySec (3 s)', () => {
		const rocket = makeRocket({ stageCount: 2 });
		const tMeco = burnToMeco(rocket);
		assert.equal(tMeco, 5);
		rocket.flightControl(1.0);
		rocket.flightControl(1.0);
		assert.equal(rocket.stgTimer, 2);
		assert.equal(rocket.currentStageIndex, 0, 'stgTimer 2 < 3: still attached');
		rocket.flightControl(1.0);
		assert.equal(rocket.currentStageIndex, 1, 'stgTimer 3 >= 3: separated');
		assert.equal(rocket.stageState, 'INTERSTAGE_COAST');
		assert.deepEqual(debrisTypes(rocket), [1]);
	});

	it('holds STG_MECO with zero thrust past the delay until the sep_stage1 row fires (2-stage)', () => {
		const rocket = makeRocket({ stageCount: 2, profile: [row('time', 0), row('time', 30, 'sep_stage1')] });
		burnToMeco(rocket);
		const massAtMeco = rocket.mass;
		for (let t = 6; t <= 29; t++) {
			rocket.flightControl(1.0);
			assert.equal(rocket.stageState, 'STG_MECO', `t=${t}`);
			assert.equal(rocket.currentStageIndex, 0, `t=${t}`);
			assert.equal(rocket._thrustRatio, 0, `t=${t}`);
			assert.equal(rocket.mass, massAtMeco, `t=${t}`);
		}
		assert.ok(rocket.stgTimer > rocket.stages[0].separationDelaySec);
		assert.equal(rocket._pendingDebris.length, 0);
		rocket.ax = 0;
		rocket.ay = 0;
		rocket.applyThrust();
		assert.equal(rocket.ax, 0);
		assert.equal(rocket.ay, 0);

		rocket.flightControl(1.0); // t = 30: the action row latches
		assert.equal(rocket.currentStageIndex, 1);
		assert.equal(rocket.stageState, 'INTERSTAGE_COAST');
		assert.deepEqual(debrisTypes(rocket), [1]);
	});

	it('a sep_payload reservation does not hold stage 1 of a 2-stage vehicle', () => {
		const rocket = makeRocket({ stageCount: 2, profile: [row('time', 0), row('time', 1e6, 'sep_payload')] });
		burnToMeco(rocket);
		for (let i = 0; i < 3; i++) rocket.flightControl(1.0);
		assert.equal(rocket.currentStageIndex, 1);
	});

	it('holds stage 2 of a 3-stage vehicle until sep_stage2, then ignites stage 3', () => {
		const rocket = makeRocket({ stageCount: 3, profile: [row('time', 0), row('time', 40, 'sep_stage2')] });
		burnToMeco(rocket);
		for (let i = 0; i < 3; i++) rocket.flightControl(1.0);
		assert.equal(rocket.currentStageIndex, 1, 'stage 1 auto-separated (no sep_stage1 reserved)');
		burnToMeco(rocket);
		const tMeco2 = rocket.flightComputer.flightTime;
		assert.ok(tMeco2 < 35);
		while (rocket.flightComputer.flightTime < 39) {
			rocket.flightControl(1.0);
			assert.equal(rocket.stageState, 'STG_MECO');
			assert.equal(rocket.currentStageIndex, 1);
			assert.equal(rocket._thrustRatio, 0);
		}
		rocket.flightControl(1.0); // t = 40
		assert.equal(rocket.currentStageIndex, 2);
		assert.equal(rocket.isStage2Separated, true);
		assert.equal(rocket.isPayloadSeparated, false);
		assert.equal(rocket.stageState, 'INTERSTAGE_COAST');
		rocket.flightControl(1.0);
		assert.equal(rocket.stageState, 'STG_BURNING', 'stage 3 ignites after ignitionDelaySec');
	});

	for (const action of ['sep_payload', 'sep_stage2']) {
		it(`holds the final stage of a 2-stage vehicle in STG_MECO until ${action}, then releases the payload`, () => {
			const rocket = makeRocket({ stageCount: 2, profile: [row('time', 0), row('time', 40, action)] });
			burnToMeco(rocket);
			for (let i = 0; i < 3; i++) rocket.flightControl(1.0);
			assert.equal(rocket.currentStageIndex, 1);
			burnToMeco(rocket);
			rocket._pendingDebris.length = 0;
			while (rocket.flightComputer.flightTime < 39) {
				rocket.flightControl(1.0);
				assert.equal(rocket.stageState, 'STG_MECO');
				assert.equal(rocket.isPayloadSeparated, false);
				assert.equal(rocket._thrustRatio, 0);
			}
			rocket.flightControl(1.0);
			assert.equal(rocket.isPayloadSeparated, true);
			assert.equal(rocket.isStage2Separated, true);
			assert.equal(rocket.currentStageIndex, 2);
			assert.equal(rocket.stageState, 'ORBITAL_COAST');
			assert.equal(rocket.mass, PASSIVE_PAYLOAD.massT);
			assert.deepEqual(debrisTypes(rocket), [2]);
		});
	}
});

describe('CalcRocket deferred orbital hold in ORBITAL_COAST (design §3.4-1)', () => {
	const ALT = 300000;
	const makeOrbiting = ({ stageCount = 2, profile } = {}) => {
		const rocket = makeRocket({
			stageCount, profile, stageOver: { [stageCount - 1]: { burnTime: 300, fuelMassT: 50, oxidMassT: 100 } },
			extra: { disableOrbitalCutoff: false }
		});
		for (let i = 0; i < stageCount - 1; i++) rocket.separateCurrentStage();
		rocket._pendingDebris.length = 0;
		rocket.stageState = 'STG_BURNING';
		rocket.isIgnited = true;
		const r = placeOnX(rocket, ALT, Math.sqrt(GM_EARTH / (EARTH.radius + ALT)));
		return { rocket, r };
	};

	for (const [stageCount, action] of [[2, 'sep_payload'], [2, 'sep_stage2'], [3, 'sep_payload']]) {
		it(`${stageCount}-stage with ${action} reserved: cutoff enters ORBITAL_COAST with the payload attached, released by the action`, () => {
			const { rocket, r } = makeOrbiting({ stageCount, profile: [row('time', 0, '', 100, 90), row('time', 500, action, 100, 90)] });
			rocket.flightControl(1.0, EARTH, r);
			assert.equal(rocket.stageState, 'ORBITAL_COAST');
			assert.equal(rocket.isPayloadSeparated, false);
			assert.equal(rocket.currentStageIndex, stageCount - 1);
			assert.equal(rocket.burnTime, 0);
			assert.equal(rocket.fuelMass, 0);
			assert.equal(rocket.oxidMass, 0);
			assert.equal(rocket.thrustForce, 0);
			assert.equal(rocket.isIgnited, false);
			const massHold = rocket.mass;
			for (let i = 0; i < 10; i++) {
				rocket.flightControl(1.0, EARTH, r);
				assert.equal(rocket.stageState, 'ORBITAL_COAST');
				assert.equal(rocket.isPayloadSeparated, false);
				assert.equal(rocket._thrustRatio, 0);
				assert.equal(rocket.mass, massHold);
			}
			assert.equal(rocket.flightComputer.currentThrottle, 0);
			assert.equal(rocket._pendingDebris.length, 0, 'no automatic separation during the hold');
			rocket.flightComputer.flightTime = 499;
			rocket.flightControl(1.0, EARTH, r);
			assert.equal(rocket.isPayloadSeparated, true);
			assert.equal(rocket.currentStageIndex, stageCount);
			assert.equal(rocket.stageState, 'ORBITAL_COAST');
			assert.equal(rocket.mass, PASSIVE_PAYLOAD.massT);
			assert.deepEqual(debrisTypes(rocket), [2]);
		});
	}

	it('without a reservation, the cutoff goes to STG_MECO and separates after the delay', () => {
		const { rocket, r } = makeOrbiting({ stageCount: 2, profile: [row('time', 0, '', 100, 90)] });
		rocket.flightControl(1.0, EARTH, r);
		assert.equal(rocket.stageState, 'STG_MECO');
		assert.equal(rocket.isPayloadSeparated, false);
		rocket.flightControl(1.0, EARTH, r);
		assert.equal(rocket.isPayloadSeparated, false);
		rocket.flightControl(1.0, EARTH, r);
		assert.equal(rocket.isPayloadSeparated, true);
		assert.equal(rocket.stageState, 'ORBITAL_COAST');
	});
});

describe('CalcRocket.executeProfileAction (design §3.4-1)', () => {
	it('disableStaging blocks every action', () => {
		for (const action of ['sep_stage1', 'sep_stage2', 'sep_payload']) {
			for (const cur of [0, 1]) {
				const rocket = makeRocket({ stageCount: 3, fairing: FAIRING, extra: { disableStaging: true } });
				rocket.currentStageIndex = cur;
				const before = snapshotStaging(rocket);
				rocket.executeProfileAction(action);
				assert.deepEqual(snapshotStaging(rocket), before, `${action} at stage ${cur}`);
			}
		}
	});

	it('empty, missing or unknown actions are ignored', () => {
		for (const action of ['', undefined, null, 'sep_stage3', 'SEP_STAGE1', 'sep_fairing', 42]) {
			const rocket = makeRocket({ stageCount: 2, fairing: FAIRING });
			const before = snapshotStaging(rocket);
			rocket.executeProfileAction(action);
			assert.deepEqual(snapshotStaging(rocket), before, `action=${String(action)}`);
		}
	});

	it('sep_stage1 separates stage 1 only from stage index 0 of a multi-stage vehicle', () => {
		for (const stageCount of [2, 3]) {
			const rocket = makeRocket({ stageCount, stageOver: { 1: { fuelMassT: 11, oxidMassT: 22 } } });
			rocket.executeProfileAction('sep_stage1');
			assert.equal(rocket.currentStageIndex, 1);
			assert.equal(rocket.stageState, 'INTERSTAGE_COAST');
			assert.equal(rocket.isIgnited, false);
			assert.equal(rocket.isPayloadSeparated, false);
			assert.equal(rocket.isStage2Separated, false);
			assert.equal(rocket.fuelMass, 11, 'the next stage is activated');
			assert.equal(rocket.oxidMass, 22);
			assert.deepEqual(debrisTypes(rocket), [1]);
			const after = snapshotStaging(rocket);
			rocket.executeProfileAction('sep_stage1');
			assert.deepEqual(snapshotStaging(rocket), after, 'repeated sep_stage1 at index 1 is ignored');
		}
		const single = makeRocket({ stageCount: 1 });
		const before = snapshotStaging(single);
		single.executeProfileAction('sep_stage1');
		assert.deepEqual(snapshotStaging(single), before, 'single-stage vehicles ignore sep_stage1');
	});

	it('sep_stage2 on a 3-stage vehicle: only from index 1, advances to stage 3', () => {
		const rocket = makeRocket({ stageCount: 3 });
		const before = snapshotStaging(rocket);
		rocket.executeProfileAction('sep_stage2');
		assert.deepEqual(snapshotStaging(rocket), before, 'ignored at index 0');
		rocket.executeProfileAction('sep_stage1');
		rocket._pendingDebris.length = 0;
		rocket.executeProfileAction('sep_stage2');
		assert.equal(rocket.currentStageIndex, 2);
		assert.equal(rocket.isStage2Separated, true);
		assert.equal(rocket.isPayloadSeparated, false);
		assert.equal(rocket.stageState, 'INTERSTAGE_COAST');
		assert.deepEqual(debrisTypes(rocket), [1]);
	});

	it('sep_stage2 on a 2-stage vehicle releases the payload (stage 2 + payload separated, fairing forced)', () => {
		const rocket = makeRocket({ stageCount: 2, fairing: FAIRING });
		rocket.executeProfileAction('sep_stage1');
		rocket._pendingDebris.length = 0;
		rocket.executeProfileAction('sep_stage2');
		assert.equal(rocket.isPayloadSeparated, true);
		assert.equal(rocket.isStage2Separated, true);
		assert.equal(rocket.currentStageIndex, 2);
		assert.equal(rocket.fairing.isSeparated, true);
		assert.equal(rocket.stageState, 'ORBITAL_COAST');
		assert.equal(rocket.mass, PASSIVE_PAYLOAD.massT);
		assert.deepEqual(debrisTypes(rocket), [2, 3, 3]);
	});

	it('sep_stage2 on a 2-stage vehicle hands propulsion to a self-propelled payload (STG_COAST)', () => {
		const rocket = makeRocket({ stageCount: 2, payload: SELF_PROPELLED_PAYLOAD });
		rocket.executeProfileAction('sep_stage1');
		rocket.executeProfileAction('sep_stage2');
		const prop = SELF_PROPELLED_PAYLOAD.propulsion;
		assert.equal(rocket.isPayloadSeparated, true);
		assert.equal(rocket.hasPayloadPropulsion, true);
		assert.equal(rocket.stageState, 'STG_COAST');
		assert.equal(rocket.autoControl, true);
		assert.equal(rocket.thrustForce, prop.thrustKN * 1000);
		assert.equal(rocket.dryMass, prop.dryMassT);
		assert.equal(rocket.fuelMass, prop.fuelMassT);
		assert.equal(rocket.oxidMass, prop.oxidMassT);
		assertNear(rocket.mass, prop.dryMassT + prop.fuelMassT + prop.oxidMassT, 1e-12);
		rocket.flightControl(1.0);
		assert.equal(rocket.stageState, 'STG_BURNING', 'the payload engine restarts under the profile');
	});

	it('sep_payload jettisons the fairing and every remaining stage (1/2/3-stage)', () => {
		const expectedDebris = { 1: [2, 3, 3], 2: [1, 2, 3, 3], 3: [1, 1, 2, 3, 3] };
		for (const stageCount of [1, 2, 3]) {
			const rocket = makeRocket({ stageCount, fairing: FAIRING });
			rocket.executeProfileAction('sep_payload');
			assert.equal(rocket.isPayloadSeparated, true, `${stageCount}-stage`);
			assert.equal(rocket.currentStageIndex, stageCount);
			assert.equal(rocket.fairing.isSeparated, true);
			assert.equal(rocket.stageState, 'ORBITAL_COAST');
			assert.equal(rocket.mass, PASSIVE_PAYLOAD.massT);
			assert.deepEqual(debrisTypes(rocket), expectedDebris[stageCount]);
			const after = snapshotStaging(rocket);
			rocket.executeProfileAction('sep_payload');
			rocket.executeProfileAction('sep_stage1');
			rocket.executeProfileAction('sep_stage2');
			assert.deepEqual(snapshotStaging(rocket), after, 'actions after payload separation are ignored');
		}
	});

	it('sep_payload keeps a self-propelled payload under autoControl in STG_COAST', () => {
		const rocket = makeRocket({ stageCount: 2, payload: SELF_PROPELLED_PAYLOAD });
		rocket.executeProfileAction('sep_payload');
		assert.equal(rocket.isPayloadSeparated, true);
		assert.equal(rocket.hasPayloadPropulsion, true);
		assert.equal(rocket.stageState, 'STG_COAST');
		assert.equal(rocket.autoControl, true);
		assert.equal(rocket.thrustForce, SELF_PROPELLED_PAYLOAD.propulsion.thrustKN * 1000);
	});

	it('profile actions are executed from flightControl through consumePendingActions', () => {
		const rocket = makeRocket({ stageCount: 2, stageOver: { 0: { burnTime: 100, fuelMassT: 200, oxidMassT: 400 } }, profile: [row('time', 0), row('time', 3, 'sep_stage1')] });
		rocket.flightControl(1.0);
		rocket.flightControl(1.0);
		assert.equal(rocket.currentStageIndex, 0);
		assert.ok(rocket.fuelMass > 0, 'stage 1 still has propellant');
		rocket.flightControl(1.0); // t = 3
		assert.equal(rocket.currentStageIndex, 1, 'early separation discards the remaining stage-1 propellant');
		assert.equal(rocket.stageState, 'INTERSTAGE_COAST');
		assert.deepEqual(rocket.flightComputer.consumePendingActions(), []);
	});

	// §3.4-1: `for (const act of this.flightComputer.consumePendingActions()) this.executeProfileAction(act);`
	// executes every action latched in the step, in row order (sep_stage2 is valid only from stage index 1,
	// so it takes effect only if sep_stage1 ran before it in the same step). The expected end state is that of
	// calling executeProfileAction for each action in turn (the separation results are those of the tests above).
	for (const { stageCount, actions, stageIndex, payloadSeparated, debris } of [
		{ stageCount: 2, actions: ['sep_stage1', 'sep_payload'], stageIndex: 2, payloadSeparated: true, debris: [1, 2, 3, 3] },
		{ stageCount: 3, actions: ['sep_stage1', 'sep_stage2'], stageIndex: 2, payloadSeparated: false, debris: [1, 1] },
		{ stageCount: 3, actions: ['sep_stage1', 'sep_stage2', 'sep_payload'], stageIndex: 3, payloadSeparated: true, debris: [1, 1, 2, 3, 3] }
	]) {
		it(`${stageCount}-stage: ${actions.join(' + ')} latched in the same step are all executed by one flightControl call`, () => {
			const build = () => makeRocket({
				stageCount, fairing: actions.includes('sep_payload') ? FAIRING : null,
				stageOver: { 0: { burnTime: 100, fuelMassT: 200, oxidMassT: 400 } },
				profile: [row('time', 0), ...actions.map(a => row('time', 3, a))]
			});
			const rocket = build();
			rocket.flightControl(1.0);
			rocket.flightControl(1.0);
			assert.equal(rocket.currentStageIndex, 0, 't = 2: nothing latched yet');
			assert.equal(rocket._pendingDebris.length, 0);
			rocket.flightControl(1.0); // t = 3: every action row fires in this evaluation
			assert.equal(rocket.currentStageIndex, stageIndex);
			assert.equal(rocket.isPayloadSeparated, payloadSeparated);
			assert.deepEqual(debrisTypes(rocket), debris);
			assert.deepEqual([...rocket.flightComputer._triggeredActionIndices].sort(), actions.map((_, i) => i + 1));
			assert.deepEqual(rocket.flightComputer.consumePendingActions(), [], 'nothing left pending');

			const twin = build();
			for (const a of actions) twin.executeProfileAction(a);
			assert.deepEqual(
				[rocket.currentStageIndex, rocket.isPayloadSeparated, rocket.isStage2Separated, rocket.stageState, debrisTypes(rocket)],
				[twin.currentStageIndex, twin.isPayloadSeparated, twin.isStage2Separated, twin.stageState, debrisTypes(twin)],
				'same end state as executing the actions one after another'
			);
		});
	}
});

describe('CalcRocket targetVInfKmS cutoff (design §3.4-1)', () => {
	const makeHyperbolic = ({ targetVInfKmS = 3.3, profile = [row('time', 0, '', 100, 90)], payload = PASSIVE_PAYLOAD } = {}) => {
		const rocket = makeRocket({
			stageCount: 2, profile, payload,
			stageOver: { 1: { burnTime: 300, fuelMassT: 50, oxidMassT: 100 } },
			extra: { disableOrbitalCutoff: true, targetVInfKmS }
		});
		return toBurningUpperStage(rocket);
	};

	it('cuts off when V∞ reaches the target: just below keeps burning, at/above cuts off', () => {
		const altM = 300000;
		const r = EARTH.radius + altM;
		const vBelow = speedForVInf(r, 3.3 * (1 - 1e-6));
		const vAbove = speedForVInf(r, 3.3 * (1 + 1e-6));
		assert.ok(vInfAt(r, vBelow) < 3.3);
		assert.ok(vInfAt(r, vAbove) >= 3.3);

		const below = makeHyperbolic();
		placeOnX(below, altM, vBelow);
		const burnBefore = below.burnTime;
		below.flightControl(1.0, EARTH, r);
		assert.equal(below.stageState, 'STG_BURNING');
		assert.equal(below.burnTime, burnBefore - 1);

		const above = makeHyperbolic();
		placeOnX(above, altM, vAbove);
		above.flightControl(1.0, EARTH, r);
		assert.equal(above.stageState, 'STG_MECO');
		assert.equal(above.burnTime, 0);
		assert.equal(above.fuelMass, 0);
		assert.equal(above.oxidMass, 0);
		assert.equal(above.thrustForce, 0);
		assert.equal(above.isIgnited, false);
	});

	it('boundary at the floating-point limit: V∞ == target cuts off (>=), target one ulp above V∞ keeps burning', () => {
		// The target is computed with the cutoff's own expression order (E = 0.5 v² - GM / r, sqrt(2E) / 1000),
		// so "equal" is an exact double equality; nextDown / nextUp are the adjacent doubles.
		const altM = 300000;
		const r = EARTH.radius + altM;
		const v = speedForVInf(r, 3.3);
		const vInf = vInfAt(r, v);
		assert.ok(Number.isFinite(vInf) && Math.abs(vInf - 3.3) < 1e-9);
		for (const [target, expected] of [[nextDown(vInf), 'STG_MECO'], [vInf, 'STG_MECO'], [nextUp(vInf), 'STG_BURNING']]) {
			const rocket = makeHyperbolic({ targetVInfKmS: target });
			placeOnX(rocket, altM, v);
			rocket.flightControl(1.0, EARTH, r);
			assert.equal(rocket.stageState, expected, `target ${target} vs V∞ ${vInf}`);
			assert.equal(rocket.isIgnited, expected === 'STG_BURNING');
		}
	});

	it('requires the cutoff altitude (140 km): just below / at', () => {
		const lowR = EARTH.radius + 139999;
		const low = makeHyperbolic();
		placeOnX(low, 139999, speedForVInf(lowR, 5));
		low.flightControl(1.0, EARTH, lowR);
		assert.equal(low.stageState, 'STG_BURNING');

		const atR = EARTH.radius + 140000;
		const at = makeHyperbolic();
		placeOnX(at, 140000, speedForVInf(atR, 5));
		at.flightControl(1.0, EARTH, atR);
		assert.equal(at.stageState, 'STG_MECO');
	});

	it('a reserved payload separation turns the V∞ cutoff into ORBITAL_COAST with the payload attached', () => {
		const rocket = makeHyperbolic({ profile: [row('time', 0, '', 100, 90), row('time', 1e6, 'sep_payload')] });
		const r = placeOnX(rocket, 300000, 0);
		rocket.vy = speedForVInf(r, 4);
		rocket.flightControl(1.0, EARTH, r);
		assert.equal(rocket.stageState, 'ORBITAL_COAST');
		assert.equal(rocket.isPayloadSeparated, false);
		assert.equal(rocket.thrustForce, 0);
	});

	it('no V∞ cutoff without a positive target or while the orbit is still bound', () => {
		for (const target of [0, -1, NaN, null, 'abc']) {
			const rocket = makeHyperbolic({ targetVInfKmS: target });
			const r = placeOnX(rocket, 300000, 0);
			rocket.vy = speedForVInf(r, 20);
			rocket.flightControl(1.0, EARTH, r);
			assert.equal(rocket.stageState, 'STG_BURNING', `target=${String(target)}`);
		}
		const bound = makeHyperbolic({ targetVInfKmS: 3.3 });
		const r = placeOnX(bound, 300000, 0);
		bound.vy = Math.sqrt(GM_EARTH / r);
		bound.flightControl(1.0, EARTH, r);
		assert.equal(bound.stageState, 'STG_BURNING', 'disableOrbitalCutoff keeps a bound deep-space stage burning');
	});

	it('never interferes with a self-propelled payload burning after separation', () => {
		const rocket = makeHyperbolic({ payload: SELF_PROPELLED_PAYLOAD });
		const r = placeOnX(rocket, 300000, 0);
		rocket.vy = speedForVInf(r, 6);
		rocket.executeProfileAction('sep_payload');
		assert.equal(rocket.stageState, 'STG_COAST');
		rocket.flightControl(1.0, EARTH, r); // re-ignition under the profile
		assert.equal(rocket.stageState, 'STG_BURNING');
		const fuel0 = rocket.fuelMass;
		const burn0 = rocket.burnTime;
		for (let i = 0; i < 3; i++) {
			rocket.flightControl(1.0, EARTH, r);
			assert.equal(rocket.stageState, 'STG_BURNING', `call ${i}`);
		}
		assert.ok(vInfAt(r, rocket.vy) > 3.3);
		assert.ok(rocket.fuelMass < fuel0);
		assertNear(rocket.burnTime, burn0 - 3, 1e-9);
	});

	it('passes stageState and the orbit targets to the flight computer each step', () => {
		const rocket = makeRocket({ stageCount: 2, extra: { targetApogeeKm: 400, targetPerigeeKm: 380, disableOrbitalCutoff: false } });
		rocket.flightControl(1.0);
		assert.equal(rocket._sensorData.stageState, 'STG_BURNING');
		assert.equal(rocket._sensorData.targetApogeeKm, 400);
		assert.equal(rocket._sensorData.targetPerigeeKm, 380);
		assert.equal(rocket._sensorData.disableOrbitalCutoff, false);
		assert.equal(rocket.flightComputer.targetApogeeKm, 400);
		assert.equal(rocket.flightComputer.targetPerigeeKm, 380);
		assert.equal(rocket.flightComputer.disableOrbitalCutoff, false);
	});
});

// ---------------------------------------------------------------------------
// 5. PresetManager: mission table, deep-space sizing, profile adaptation, applyToLauncher
// ---------------------------------------------------------------------------

describe('PresetManager mission presets match the design table (§3.4-2)', () => {
	const pm = new PresetManager();

	it('the manifest lists exactly the 7 design missions', () => {
		const ids = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'presets/missions/manifest.json'), 'utf8'));
		assert.deepEqual(ids, Object.keys(DESIGN_MISSIONS));
		assert.deepEqual(pm.getMissions().map(m => m.id).sort(), Object.keys(DESIGN_MISSIONS).sort());
	});

	for (const [id, d] of Object.entries(DESIGN_MISSIONS)) {
		it(`${id}: targets and every flightProfile row equal the design table`, () => {
			const m = pm.getMission(id);
			assert.ok(m, `mission ${id} loads`);
			assert.equal(m.targetApogeeKm ?? null, d.ap);
			assert.equal(m.targetPerigeeKm ?? null, d.pe);
			assert.equal(m.targetVInfKmS ?? null, d.vinf);
			assert.equal(m.disableOrbitalCutoff, d.cutoffDisabled);
			assert.equal(m.targetDeltaVM_S, d.dv);
			assert.deepEqual(m.flightProfile.map(r => [r.type, r.value, r.thrust, r.angle]), d.rows);
			for (const r of m.flightProfile) assert.equal(r.action, '');

			const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_30'), payload: pm.getPayload('earth_obs'), mission: m });
			assert.equal(plan.targetApogeeKm, d.ap ?? 0);
			assert.equal(plan.targetPerigeeKm, d.pe ?? 0);
			assert.equal(plan.targetVInfKmS, d.vinf ?? 0);
			assert.equal(plan.disableOrbitalCutoff, d.cutoffDisabled);
			assert.deepEqual(plan.flightProfile.map(r => [r.type, r.thrust, r.angle, r.action]), d.rows.map(([t, , th, a]) => [t, th, a, '']));
		});
	}

	it('getMission returns an isolated copy; unknown ids give null', () => {
		const a = pm.getMission('iss_rendezvous');
		a.flightProfile[0].angle = 45;
		assert.equal(pm.getMission('iss_rendezvous').flightProfile[0].angle, 0);
		assert.equal(pm.getMission('ISS_RENDEZVOUS').id, 'iss_rendezvous');
		for (const id of ['nope', '', undefined, null]) assert.equal(pm.getMission(id), null, `id=${String(id)}`);
	});
});

describe('PresetManager deep-space sizing (design §3.4-3)', () => {
	const pm = new PresetManager();
	const G0 = PHYSICS.G0;
	const ispOf = (stg) => {
		const fuel = pm.getFuel(stg.fuelType || 'liquid');
		return stg.ispVac || stg.isp || fuel.ispVac || fuel.isp;
	};

	for (const vid of ['h3_22', 'h3_24', 'h3_30', 'falcon9']) {
		for (const mid of ['mars_transfer', 'jupiter_transfer', 'solar_escape']) {
			it(`${vid} x ${mid}: upper burnTime <= 420 s and thrust within the caps`, () => {
				const base = pm.getVehicle(vid);
				const baseSnapshot = JSON.parse(JSON.stringify(base));
				const baseLast = base.stages[base.stages.length - 1];
				const baseBoosters = base.boosters || base.rendering?.boosters || null;
				const hasSrb = Boolean(baseBoosters && (baseBoosters.count > 0 || baseBoosters.burnTimeSec > 0));
				for (const pid of ['earth_obs', 'mmx']) {
					const plan = pm.calculateMissionFlightPlan({ vehicle: base, payload: pm.getPayload(pid), mission: pm.getMission(mid) });
					const last = plan.stages[plan.stages.length - 1];
					const lastProp = last.fuelMassT + last.oxidMassT;
					const tag = `${vid}/${mid}/${pid}`;

					assert.ok(lastProp > baseLast.fuelMassT + baseLast.oxidMassT, `${tag}: upper propellant expanded`);
					assert.ok(last.burnTime > 0 && last.burnTime <= 420, `${tag}: burnTime ${last.burnTime}`);
					assert.ok(Number.isInteger(last.thrustKN), `${tag}: upper thrust is ceil'd`);
					assert.ok(last.thrustKN >= baseLast.thrustKN, `${tag}: upper thrust never lowered`);
					assert.ok(last.thrustKN <= Math.max(baseLast.thrustKN, 10000), `${tag}: upper thrust cap`);
					const burnFromProp = (lastProp * ispOf(last) * G0) / last.thrustKN;
					assertNear(last.burnTime, burnFromProp, 0.05 + (0.1 * ispOf(last) * G0) / last.thrustKN, `${tag}: upper burnTime`);

					const stg0 = plan.stages[0];
					const origStg0 = base.stages[0].thrustKN;
					assert.ok(Number.isInteger(stg0.thrustKN), `${tag}: stage-1 thrust is ceil'd`);
					assert.ok(stg0.thrustKN >= origStg0, `${tag}: stage-1 thrust never lowered`);
					let effTh0 = stg0.thrustKN;
					if (hasSrb) {
						const core = plan.boosters.coreThrustKN;
						const origCore = baseBoosters.coreThrustKN;
						const srb = plan.boosters.thrustKN || 0;
						assert.ok(Number.isInteger(core), `${tag}: core thrust is ceil'd`);
						assert.ok(core >= origCore && core <= Math.max(origCore, 10000), `${tag}: core ${core}`);
						assert.ok(stg0.thrustKN >= core + srb, `${tag}: stage-1 >= core + SRB`);
						assert.ok(stg0.thrustKN <= Math.max(Math.max(origStg0, 10000), core + srb), `${tag}: stage-1 cap`);
						effTh0 = core;
					} else {
						assert.ok(stg0.thrustKN <= Math.max(origStg0, 10000), `${tag}: stage-1 cap ${stg0.thrustKN}`);
					}
					const stg0Prop = stg0.fuelMassT + stg0.oxidMassT;
					assertNear(stg0.burnTime, Math.round(((stg0Prop * ispOf(stg0) * G0) / effTh0) * 10) / 10, 1e-9, `${tag}: stage-1 burnTime from effTh0`);
				}
				assert.deepEqual(pm.getVehicle(vid), baseSnapshot, 'the base vehicle JSON is unchanged');
			});
		}
	}

	const DEEP_SPACE_PLANS = [];
	for (const vid of ['h3_22', 'h3_24', 'h3_30', 'falcon9']) {
		for (const mid of ['mars_transfer', 'jupiter_transfer', 'solar_escape']) {
			for (const pid of ['earth_obs', 'mmx']) DEEP_SPACE_PLANS.push({ vid, mid, pid });
		}
	}
	const stageMassT = (st) => st.dryMassT + st.fuelMassT + st.oxidMassT;
	const planOf = ({ vid, mid, pid }) => {
		const base = pm.getVehicle(vid);
		const plan = pm.calculateMissionFlightPlan({ vehicle: base, payload: pm.getPayload(pid), mission: pm.getMission(mid) });
		const baseBoosters = base.boosters || base.rendering?.boosters || null;
		const hasSrb = Boolean(baseBoosters && (baseBoosters.count > 0 || baseBoosters.burnTimeSec > 0));
		const fairingT = plan.fairing?.enabled ? plan.fairing.massT : 0;
		const b = plan.boosters;
		const boosterT = hasSrb ? (b.dryMassT || 0) + (b.fuelMassT || 0) + (b.oxidMassT || 0) : 0;
		// Liftoff mass = everything on the pad in the plan's output
		const liftoffT = plan.stages.reduce((s, st) => s + stageMassT(st), 0) + plan.payload.massT + fairingT + boosterT;
		return { base, plan, baseBoosters, hasSrb, fairingT, liftoffT, tag: `${vid}/${mid}/${pid}` };
	};

	it('liftoff TWR floor 1.25 (§3.4-3): stage-1 thrust from the plan masses, and TWR >= 1.25 also at the thrust cap', () => {
		// Non-SRB: stages[0].thrustKN = ceil(min(maxStg0, max(orig, m·G0·1.25)));
		// SRB: stages[0].thrustKN = ceil(min(max(maxStg0, core + srb), max(orig, m·G0·1.25, core + srb))), maxStg0 = max(orig, 10000).
		// maxByTwr caps the upper propellant at maxStg0 / (G0·1.25) − (the rest of the liftoff mass), so a capped thrust
		// still gives TWR >= 1.25 up to the 0.1 t propellant rounding (1 t allowed: TWR >= 1.25·maxStg0 / (maxStg0 + 1.25·G0·1 t)).
		let floorBinding = 0;
		let capBinding = 0;
		for (const key of DEEP_SPACE_PLANS) {
			const { base, plan, hasSrb, liftoffT, tag } = planOf(key);
			const stg0 = plan.stages[0];
			const orig0 = base.stages[0].thrustKN;
			const max0 = Math.max(orig0, 10000);
			const req = liftoffT * G0 * 1.25;
			let expected;
			if (hasSrb) {
				const coreSrb = plan.boosters.coreThrustKN + (plan.boosters.thrustKN || 0);
				expected = Math.ceil(Math.min(Math.max(max0, coreSrb), Math.max(orig0, req, coreSrb)));
			} else {
				expected = Math.ceil(Math.min(max0, Math.max(orig0, req)));
				if (req > orig0 && req < max0) floorBinding++;
				if (req >= max0) capBinding++;
			}
			assert.equal(stg0.thrustKN, expected, `${tag}: stage-1 thrust (1.25 x ${liftoffT.toFixed(3)} t x G0 = ${req.toFixed(3)} kN)`);
			const twr = stg0.thrustKN / (liftoffT * G0);
			if (stg0.thrustKN < max0) {
				assert.ok(twr >= 1.25, `${tag}: liftoff TWR ${twr} >= 1.25`);
			} else {
				assert.ok(twr >= (1.25 * max0) / (max0 + 1.25 * G0), `${tag}: liftoff TWR ${twr} at the ${max0} kN cap`);
			}
		}
		// The presets exercise both non-SRB branches (otherwise the floor would not be observable here)
		assert.ok(floorBinding > 0, 'some plan raises the thrust to the 1.25 floor below the cap (h3_30 Jupiter / Solar)');
		assert.ok(capBinding > 0, 'some plan reaches the thrust cap (falcon9)');
	});

	it('SRB core thrust floor 1.15 (§3.4-3): core thrust from the plan masses, bracketed by the fairing reading', () => {
		// core = ceil(min(maxCore, max(origCore, m_postSrb·G0·1.15))), maxCore = max(origCore, 10000).
		// m_postSrb = payload + stage-1 dry + stage-1 propellant left at SRB burnout + all upper stages, with
		// remStg0Prop = stg0Prop·(1 − srbBurnT / max(1, stg0BurnT)), stg0BurnT = stages[0].burnTime || 290 at sizing time
		// (the preset value: stage 1 stays at full capacity), srbBurnT = boosters.burnTimeSec || 105.
		// The design does not say whether the fairing (still attached at SRB burnout) belongs to m_postSrb, so the
		// core thrust is checked between the two readings (without / with the fairing).
		let srbPlans = 0;
		for (const key of DEEP_SPACE_PLANS) {
			const { base, plan, baseBoosters, hasSrb, fairingT, tag } = planOf(key);
			if (!hasSrb) continue;
			srbPlans++;
			const stg0 = plan.stages[0];
			const stg0Prop = stg0.fuelMassT + stg0.oxidMassT;
			assert.equal(stg0Prop, base.stages[0].fuelMassT + base.stages[0].oxidMassT, `${tag}: precondition: stage 1 at full capacity`);
			const stg0BurnT = base.stages[0].burnTime || 290;
			const srbBurnT = plan.boosters.burnTimeSec || 105;
			const remStg0Prop = Math.max(0, stg0Prop * (1 - srbBurnT / Math.max(1, stg0BurnT)));
			const upperT = plan.stages.slice(1).reduce((s, st) => s + stageMassT(st), 0);
			const postSrbNoFairing = plan.payload.massT + stg0.dryMassT + remStg0Prop + upperT;
			const origCore = baseBoosters.coreThrustKN;
			const maxCore = Math.max(origCore, 10000);
			const coreFor = (m) => Math.ceil(Math.min(maxCore, Math.max(origCore, m * G0 * 1.15)));
			const lo = coreFor(postSrbNoFairing);
			const hi = coreFor(postSrbNoFairing + fairingT);
			const core = plan.boosters.coreThrustKN;
			assert.ok(core >= lo && core <= hi, `${tag}: core ${core} within [${lo}, ${hi}]`);
			assert.ok(lo > origCore && lo < maxCore, `${tag}: precondition: the 1.15 floor decides the core thrust`);
		}
		assert.equal(srbPlans, 12, 'h3_22 and h3_24 x 3 missions x 2 payloads');
	});

	it('does not size solid upper stages, single-stage vehicles or non-deep missions', () => {
		for (const mid of ['mars_transfer', 'jupiter_transfer', 'solar_escape']) {
			const eps = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('epsilon'), payload: pm.getPayload('asnaro_2'), mission: pm.getMission(mid) });
			const epsBase = pm.getVehicle('epsilon').stages[2];
			const epsLast = eps.stages[2];
			assert.deepEqual([epsLast.fuelMassT, epsLast.oxidMassT, epsLast.thrustKN, epsLast.burnTime], [epsBase.fuelMassT, epsBase.oxidMassT, epsBase.thrustKN, epsBase.burnTime], `epsilon ${mid}`);

			const ssto = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('ssto'), payload: pm.getPayload('earth_obs'), mission: pm.getMission(mid) });
			const sstoBase = pm.getVehicle('ssto').stages[0];
			assert.deepEqual([ssto.stages[0].fuelMassT, ssto.stages[0].oxidMassT, ssto.stages[0].thrustKN, ssto.stages[0].burnTime], [sstoBase.fuelMassT, sstoBase.oxidMassT, sstoBase.thrustKN, sstoBase.burnTime], `ssto ${mid}`);
		}
		for (const vid of ['h3_22', 'h3_24', 'h3_30', 'falcon9']) {
			const baseLast = pm.getVehicle(vid).stages[1];
			for (const mission of [pm.getMission('leo_250km'), pm.getMission('gto_insertion'), undefined, { ...pm.getMission('leo_250km'), targetVInfKmS: 0, disableOrbitalCutoff: false }]) {
				const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle(vid), payload: pm.getPayload('earth_obs'), mission });
				const last = plan.stages[1];
				assert.deepEqual([last.fuelMassT, last.oxidMassT, last.thrustKN, last.burnTime], [baseLast.fuelMassT, baseLast.oxidMassT, baseLast.thrustKN, baseLast.burnTime], `${vid} ${mission?.id ?? 'no mission'}`);
			}
		}
	});

	it('applicability boundary: targetVInfKmS 0 vs 0.001, and disableOrbitalCutoff alone', () => {
		const leo = pm.getMission('leo_250km');
		const vehicle = pm.getVehicle('h3_30');
		const baseLast = vehicle.stages[1];
		const off = pm.calculateMissionFlightPlan({ vehicle, payload: pm.getPayload('earth_obs'), mission: { ...leo, targetVInfKmS: 0 } }).stages[1];
		assert.equal(off.burnTime, baseLast.burnTime);
		for (const mission of [{ ...leo, targetVInfKmS: 0.001 }, { ...leo, disableOrbitalCutoff: true }]) {
			const on = pm.calculateMissionFlightPlan({ vehicle, payload: pm.getPayload('earth_obs'), mission }).stages[1];
			assert.ok(on.fuelMassT + on.oxidMassT > baseLast.fuelMassT + baseLast.oxidMassT);
			assert.ok(on.burnTime > 0 && on.burnTime <= 420, `burnTime ${on.burnTime}`);
		}
	});

	it('returns null without a vehicle', () => {
		assert.equal(pm.calculateMissionFlightPlan({}), null);
		assert.equal(pm.calculateMissionFlightPlan(), null);
		assert.equal(pm.calculateMissionFlightPlan({ vehicle: null, mission: pm.getMission('mars_transfer') }), null);
	});
});

describe('PresetManager._adaptFlightProfileForVehicle (design §3.4-3)', () => {
	const pm = new PresetManager();
	const PROFILE = Object.freeze([
		Object.freeze({ type: 'alt', value: 1001, thrust: 100, angle: 0 }),
		Object.freeze({ type: 'time', value: 50, thrust: 100, angle: 10, action: 'sep_stage1' }),
		Object.freeze({ type: 'vel', value: 3000, thrust: 100, angle: 20 }),
		Object.freeze({ type: 'apogee', value: 10, thrust: 0, angle: 90, action: 'sep_payload' })
	]);
	const adaptAlt = (vehicle, stages, isDeep) => pm._adaptFlightProfileForVehicle(PROFILE, vehicle, stages, isDeep)[0].value;

	// The altitude scales are not in the design text. §3.4-3 requires "vehicle = {} 完全互換" with
	// integration/08_tab_navigation_lifecycle.test.mjs:1340-1368 (main branch), whose fixtures fix them for a 1000 m row:
	// all-solid stages -> 620 (0.62), one stage -> 580 (0.58), upper stage 10 kN / (30 + 4) t -> 1080 (1.08),
	// upper stage 500 kN / (30 + 4) t -> 850 (0.85). §3.4-3 adds: the upper-stage check uses
	// refUpper = vehicle?.stages?.[1] ?? stages?.[1], and non-solid multi-stage deep-space plans get altScale >= 1.0.
	// The upper-stage TWR threshold itself is not specified; only these two bracketing fixtures are used for it.
	const COMPAT = Object.freeze({
		solid: [{ fuelType: 'solid' }, { fuelType: 'solid' }],
		ssto: [{ fuelType: 'liquid' }],
		lowUpper: [{ fuelType: 'liquid', thrustKN: 1000 }, { fuelType: 'liquid', thrustKN: 10, dryMassT: 10, fuelMassT: 10, oxidMassT: 10 }],
		normalUpper: [{ fuelType: 'liquid', thrustKN: 1000 }, { fuelType: 'liquid', thrustKN: 500, dryMassT: 10, fuelMassT: 10, oxidMassT: 10 }]
	});
	const COMPAT_SCALE = Object.freeze({ solid: 0.62, ssto: 0.58, lowUpper: 1.08, normalUpper: 0.85 });

	it('vehicle = {} keeps the integration/08 compatibility scales; null/undefined vehicles fall back to the given stages', () => {
		for (const [kind, stages] of Object.entries(COMPAT)) {
			assert.equal(adaptAlt({}, stages, false), Math.round(1001 * COMPAT_SCALE[kind]), kind);
			assert.equal(adaptAlt(undefined, stages, false), adaptAlt({}, stages, false), `${kind}: undefined vehicle`);
			assert.equal(adaptAlt(null, stages, false), adaptAlt({}, stages, false), `${kind}: null vehicle`);
		}
		for (const kind of ['lowUpper', 'normalUpper']) {
			assert.ok(adaptAlt({}, COMPAT[kind], true) >= 1001, `${kind}: deep-space non-solid multi-stage scale >= 1.0`);
		}
	});

	it('refUpper: the original vehicle upper stage takes precedence over the given (sized) stages', () => {
		assert.equal(adaptAlt({ stages: COMPAT.lowUpper }, COMPAT.normalUpper, false), adaptAlt({}, COMPAT.lowUpper, false));
		assert.equal(adaptAlt({ stages: COMPAT.normalUpper }, COMPAT.lowUpper, false), adaptAlt({}, COMPAT.normalUpper, false));
		assert.notEqual(adaptAlt({}, COMPAT.lowUpper, false), adaptAlt({}, COMPAT.normalUpper, false), 'precondition: the fixtures differ');
		assert.equal(adaptAlt({ stages: [COMPAT.normalUpper[0]] }, COMPAT.lowUpper, false), adaptAlt({}, COMPAT.lowUpper, false), 'no vehicle stages[1]: the given stages[1]');
		for (const vid of ['h3_22', 'h3_24', 'h3_30', 'falcon9']) {
			const vehicle = pm.getVehicle(vid);
			const sized = pm.calculateMissionFlightPlan({ vehicle, payload: pm.getPayload('earth_obs'), mission: pm.getMission('solar_escape') }).stages;
			for (const isDeep of [false, true]) {
				assert.equal(adaptAlt(vehicle, sized, isDeep), adaptAlt({}, vehicle.stages, isDeep), `${vid} isDeep=${isDeep}`);
			}
		}
	});

	it('all-solid and single-stage presets use the compatibility solid / single-stage scales; missing stages do not throw', () => {
		assert.equal(adaptAlt({}, pm.getVehicle('epsilon').stages, false), Math.round(1001 * COMPAT_SCALE.solid));
		assert.equal(adaptAlt({}, pm.getVehicle('ssto').stages, false), Math.round(1001 * COMPAT_SCALE.ssto));
		for (const isDeep of [false, true]) {
			const out = pm._adaptFlightProfileForVehicle(PROFILE, {}, undefined, isDeep);
			assert.ok(Number.isFinite(out[0].value) && out[0].value > 0, `isDeep=${isDeep}: ${out[0].value}`);
			assert.deepEqual(out.slice(1).map(r => r.value), [50, 3000, 10]);
		}
	});

	it('scales alt rows only, defaults the action to "" and does not mutate the input', () => {
		const out = pm._adaptFlightProfileForVehicle(PROFILE, {}, COMPAT.normalUpper, false);
		assert.notStrictEqual(out, PROFILE);
		assert.deepEqual(out.map(r => [r.type, r.value, r.thrust, r.angle, r.action]), [
			['alt', Math.round(1001 * COMPAT_SCALE.normalUpper), 100, 0, ''], ['time', 50, 100, 10, 'sep_stage1'], ['vel', 3000, 100, 20, ''], ['apogee', 10, 0, 90, 'sep_payload']
		]);
		assert.equal(PROFILE[0].value, 1001);
		assert.equal(PROFILE[0].action, undefined);
	});

	it('returns non-array profiles unchanged and maps an empty profile to []', () => {
		for (const p of [null, undefined, 'x', 42]) assert.equal(pm._adaptFlightProfileForVehicle(p, {}, [], false), p);
		const obj = { type: 'alt' };
		assert.equal(pm._adaptFlightProfileForVehicle(obj, {}, [], false), obj);
		assert.deepEqual(pm._adaptFlightProfileForVehicle([], {}, pm.getVehicle('h3_30').stages, false), []);
	});

	it('deep-space plans of non-solid multi-stage vehicles never lower the altitude rows (scale >= 1.0)', () => {
		for (const vid of ['h3_22', 'h3_24', 'h3_30', 'falcon9']) {
			for (const mid of ['mars_transfer', 'jupiter_transfer', 'solar_escape']) {
				const mission = pm.getMission(mid);
				const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle(vid), payload: pm.getPayload('earth_obs'), mission });
				mission.flightProfile.forEach((r, i) => {
					assert.ok(plan.flightProfile[i].value >= r.value, `${vid}/${mid} row ${i}`);
				});
			}
		}
	});
});

describe('PresetManager.applyToLauncher recommended-mission rule (design §3.4-4)', () => {
	const pm = new PresetManager();
	const makeLauncher = (over = {}) => ({ currentVehicleId: 'h3_30', currentPayloadId: 'geo_sat', currentMissionId: 'mars_transfer', previewRequests: 0, requestPreviewUpdate() { this.previewRequests++; }, ...over });

	it('an explicit payloadId applies the payload recommendation', () => {
		const l = makeLauncher();
		pm.applyToLauncher(l, { payloadId: 'htv_x' });
		assert.equal(l.currentPayloadId, 'htv_x');
		assert.equal(l.currentMissionId, 'iss_rendezvous');
		assert.equal(l.targetApogeeKm, 400);
		assert.equal(l.previewRequests, 1);
	});

	it('an explicit missionId wins over the recommendation', () => {
		const l = makeLauncher();
		pm.applyToLauncher(l, { payloadId: 'htv_x', missionId: 'gto_insertion' });
		assert.equal(l.currentMissionId, 'gto_insertion');
	});

	it('without payloadId the current mission is kept (no recommendation)', () => {
		for (const opts of [{}, { vehicleId: 'h3_22' }, { payloadId: undefined }, { applyRecommendedMission: false }, { applyRecommendedMission: 'true' }, { applyRecommendedMission: 1 }]) {
			const l = makeLauncher();
			pm.applyToLauncher(l, opts);
			assert.equal(l.currentMissionId, 'mars_transfer', JSON.stringify(opts));
			assert.equal(l.currentPayloadId, 'geo_sat');
			assert.equal(l.targetVInfKmS, 3.3);
		}
		// payloadId null selects the default payload but is not an explicit payload choice
		const l = makeLauncher();
		pm.applyToLauncher(l, { payloadId: null });
		assert.equal(l.currentPayloadId, 'earth_obs');
		assert.equal(l.currentMissionId, 'mars_transfer');
	});

	it('applyRecommendedMission === true applies the current payload recommendation', () => {
		const l = makeLauncher();
		pm.applyToLauncher(l, { applyRecommendedMission: true });
		assert.equal(l.currentMissionId, 'gto_insertion');
	});

	it('falls back to leo_250km and the default payload when nothing is configured', () => {
		const l = makeLauncher({ currentPayloadId: undefined, currentMissionId: undefined });
		pm.applyToLauncher(l, {});
		assert.equal(l.currentPayloadId, 'earth_obs');
		assert.equal(l.currentMissionId, 'leo_250km');
		const e = makeLauncher({ currentPayloadId: undefined, currentMissionId: undefined });
		pm.applyToLauncher(e, { vehicleId: 'epsilon', payloadId: '' });
		assert.equal(e.currentPayloadId, 'asnaro_2', 'epsilon defaults to its small payload');
		assert.equal(e.currentMissionId, 'leo_250km', 'asnaro_2 recommends leo_250km');
	});

	it('ignores a missing launcher and leaves the launcher untouched for an unknown vehicle', () => {
		assert.doesNotThrow(() => pm.applyToLauncher(null, { payloadId: 'htv_x' }));
		assert.doesNotThrow(() => pm.applyToLauncher(undefined));
		const l = makeLauncher({ currentVehicleId: 'no_such_vehicle' });
		const before = JSON.stringify(l);
		pm.applyToLauncher(l, { vehicleId: 'no_such_vehicle', payloadId: 'htv_x' });
		assert.equal(JSON.stringify(l), before);
		assert.equal(l.previewRequests, 0);
	});
});

// ---------------------------------------------------------------------------
// 6. RocketTab: 6-column flight-profile table, thrust slider, fuel-change clamp (design §3.4-4, §4.6)
// ---------------------------------------------------------------------------

describe('RocketTab flight-profile table (6 columns)', () => {
	it('renders the 6 columns with the designed elements, classes and options', () => {
		const { tab } = makeTab((rl) => { rl.flightProfile = [row('vel', 3000, 'sep_stage2', 80, 45)]; });
		tab._renderProfileTable();
		const rows = profileRows(tab);
		assert.equal(rows.length, 1);
		const cells = rows[0].children;
		assert.equal(rows[0].tagName, 'TR');
		assert.equal(cells.length, 6);
		cells.forEach((td) => {
			assert.equal(td.tagName, 'TD');
			assert.equal(td.children.length, 1);
		});
		const [trig, val, thr, ang, act, del] = cells.map(td => td.children[0]);

		assert.equal(trig.tagName, 'SELECT');
		assert.deepEqual(classesOf(trig), ['fp-trigger']);
		assert.deepEqual(parseOptions(trig).map(o => [o.value, o.label]), [['alt', 'Alt(m)'], ['time', 'Time(s)'], ['vel', 'Vel(m/s)'], ['apogee', 'Apogee(s)']]);
		assert.equal(selectedValue(trig), 'vel');

		for (const [el, cls, value] of [[val, 'fp-val', 3000], [thr, 'fp-thrust', 80], [ang, 'fp-angle', 45]]) {
			assert.equal(el.tagName, 'INPUT');
			assert.equal(el.type, 'number');
			assert.deepEqual(classesOf(el), [cls]);
			assert.equal(el.value, value);
		}
		assert.equal(thr.min, '0');
		assert.equal(thr.max, '100');
		assert.equal(ang.min, '-90');
		assert.equal(ang.max, '90');

		assert.equal(act.tagName, 'SELECT');
		assert.deepEqual(classesOf(act), ['fp-action']);
		assert.deepEqual(parseOptions(act).map(o => [o.value, o.label]), [['', '-'], ['sep_stage1', 'Stg1'], ['sep_stage2', 'Stg2'], ['sep_payload', 'Pay']]);
		assert.equal(selectedValue(act), 'sep_stage2');

		assert.equal(del.tagName, 'BUTTON');
		assert.equal(del.type, 'button');
		assert.ok(classesOf(del).includes('fp-del'));
		assert.equal(del.textContent, '✕');
	});

	it('marks the step type and action for every option; a missing action selects "-"', () => {
		const types = ['alt', 'time', 'vel', 'apogee'];
		const actions = ['', 'sep_stage1', 'sep_stage2', 'sep_payload', undefined];
		const { tab } = makeTab((rl) => {
			rl.flightProfile = actions.map((a, i) => ({ type: types[i % 4], value: i, thrust: 100, angle: 0, ...(a === undefined ? {} : { action: a }) }));
		});
		tab._renderProfileTable();
		const rows = profileRows(tab);
		assert.equal(rows.length, actions.length);
		rows.forEach((tr, i) => {
			assert.equal(selectedValue(tr.children[0].children[0]), types[i % 4]);
			assert.equal(selectedValue(tr.children[4].children[0]), actions[i] ?? '');
		});
	});

	it('0 rows: empty table; the add button appends the default row', () => {
		const { tab, launcher } = makeTab((rl) => { rl.flightProfile = []; });
		tab._renderProfileTable();
		assert.equal(profileRows(tab).length, 0);
		tab.ui.rlAddProfileBtn.click();
		assert.deepEqual(launcher.flightProfile, [{ type: 'alt', value: 0, thrust: 100, angle: 0, action: '' }]);
		assert.equal(profileRows(tab).length, 1);
		assert.equal(selectedValue(profileRows(tab)[0].children[4].children[0]), '');
	});

	it('1 row: deleting it leaves an empty table', () => {
		const { tab, launcher } = makeTab((rl) => { rl.flightProfile = [row('alt', 0, 'sep_payload')]; });
		tab._renderProfileTable();
		profileRows(tab)[0].children[5].children[0].onclick();
		assert.deepEqual(launcher.flightProfile, []);
		assert.equal(profileRows(tab).length, 0);
	});

	it('many rows: deleting re-renders with fresh indices and keeps order', () => {
		const { tab, launcher } = makeTab((rl) => { rl.flightProfile = Array.from({ length: 25 }, (_, i) => row('time', i * 10)); });
		tab._renderProfileTable();
		assert.equal(profileRows(tab).length, 25);
		profileRows(tab)[12].children[5].children[0].onclick();
		assert.equal(profileRows(tab).length, 24);
		assert.deepEqual(launcher.flightProfile.map(r => r.value), Array.from({ length: 25 }, (_, i) => i * 10).filter(v => v !== 120));
		profileRows(tab)[23].children[5].children[0].onclick(); // last
		profileRows(tab)[0].children[5].children[0].onclick(); // first
		assert.equal(launcher.flightProfile.length, 22);
		assert.equal(launcher.flightProfile[0].value, 10);
		assert.equal(launcher.flightProfile[21].value, 230);
		profileRows(tab).forEach((tr, i) => assert.equal(tr.children[1].children[0].value, launcher.flightProfile[i].value));
	});

	it('cell editors write back to the profile; invalid numbers fall back to 0 without throwing', () => {
		const { tab, launcher } = makeTab((rl) => { rl.flightProfile = [row('alt', 1000, '', 100, 10)]; });
		tab._renderProfileTable();
		const cells = profileRows(tab)[0].children.map(td => td.children[0]);
		cells[0].onchange({ target: { value: 'apogee' } });
		cells[1].onchange({ target: { value: '2500.5' } });
		cells[2].onchange({ target: { value: '0' } });
		cells[3].onchange({ target: { value: '-90' } });
		for (const a of ['sep_stage1', 'sep_stage2', 'sep_payload', '']) {
			cells[4].onchange({ target: { value: a } });
			assert.equal(launcher.flightProfile[0].action, a);
		}
		assert.deepEqual(launcher.flightProfile[0], { type: 'apogee', value: 2500.5, thrust: 0, angle: -90, action: '' });
		// 'Infinity' / '-Infinity' / '1e999' parse to ±Infinity: such a row would stay in the table but be dropped at rollout (§3.4-1)
		for (const bad of ['', 'abc', 'NaN', undefined, 'Infinity', '-Infinity', '1e999']) {
			assert.doesNotThrow(() => {
				cells[1].onchange({ target: { value: bad } });
				cells[2].onchange({ target: { value: bad } });
				cells[3].onchange({ target: { value: bad } });
			});
			assert.deepEqual([launcher.flightProfile[0].value, launcher.flightProfile[0].thrust, launcher.flightProfile[0].angle], [0, 0, 0], `bad=${String(bad)}`);
		}
	});

	it('actions survive RocketLauncher.getState/loadState and RocketTab.loadState renders them', () => {
		const { tab, universe } = makeTab();
		const launcher = new RocketLauncher(universe);
		launcher.flightProfile = [row('alt', 0), row('time', 120, 'sep_stage1'), row('vel', 3000, 'sep_stage2'), row('apogee', 30, 'sep_payload'), { type: 'alt', value: 5, thrust: 100, angle: 0 }];
		const state = launcher.getState();
		assert.deepEqual(state.flightProfile.map(r => r.action), ['', 'sep_stage1', 'sep_stage2', 'sep_payload', undefined]);
		state.flightProfile[1].action = 'mutated';
		assert.equal(launcher.flightProfile[1].action, 'sep_stage1', 'getState returns a copy');
		state.flightProfile[1].action = 'sep_stage1';

		const restored = new RocketLauncher(universe);
		const saved = JSON.parse(JSON.stringify(state));
		restored.loadState(saved);
		assert.deepEqual(restored.flightProfile, launcher.flightProfile);
		assert.notStrictEqual(restored.flightProfile, saved.flightProfile);

		universe.RocketLauncher.flightProfile = [];
		tab.loadState({ flightProfile: saved.flightProfile });
		assert.deepEqual(universe.RocketLauncher.flightProfile, saved.flightProfile);
		assert.notStrictEqual(universe.RocketLauncher.flightProfile, saved.flightProfile);
		assert.deepEqual(profileRows(tab).map(tr => selectedValue(tr.children[4].children[0])), ['', 'sep_stage1', 'sep_stage2', 'sep_payload', '']);
		assert.deepEqual(profileRows(tab).map(tr => selectedValue(tr.children[0].children[0])), ['alt', 'time', 'vel', 'apogee', 'alt']);
	});

	it('index.html declares the 6 columns and style.css the fixed table layout', () => {
		const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
		const table = html.match(/<table id="rl-flight-profile-table"[\s\S]*?<\/table>/);
		assert.ok(table, '#rl-flight-profile-table exists');
		assert.ok(/class="profile-table"/.test(table[0]));
		const widths = [...table[0].matchAll(/<col style="width:\s*(\d+)%">/g)].map(m => Number(m[1]));
		assert.deepEqual(widths, [19, 22, 14, 14, 21, 10]);
		assert.equal([...table[0].matchAll(/<th>/g)].length, 6);
		assert.ok(/<tbody id="rl-flight-profile-body">/.test(table[0]));
		const thrustInput = html.match(/<input[^>]*id="rl-launch-thrust"[^>]*>/);
		assert.ok(thrustInput && /max="10000"/.test(thrustInput[0]), 'static slider max is the 10000 kN base');

		const css = fs.readFileSync(path.resolve(process.cwd(), 'style.css'), 'utf8');
		const block = (sel) => {
			const i = css.indexOf(`${sel} {`);
			assert.ok(i >= 0, `${sel} rule exists`);
			return css.slice(i, css.indexOf('}', i));
		};
		const tableRule = block('.profile-table');
		for (const decl of ['width: 100%', 'table-layout: fixed', 'border-collapse: collapse']) assert.ok(tableRule.includes(decl), decl);
		const cellRule = block('.profile-table th, .profile-table td');
		for (const decl of ['padding: 2px 1px', 'box-sizing: border-box', 'overflow: hidden']) assert.ok(cellRule.includes(decl), decl);
		const inputRule = block('.profile-table select, .profile-table input');
		for (const decl of ['width: 100%', 'min-width: 0', 'font-size: 11px', 'box-sizing: border-box']) assert.ok(inputRule.includes(decl), decl);
		assert.ok(css.includes('-webkit-appearance: none'));
		assert.ok(css.includes('-moz-appearance: textfield'));
	});
});

describe('RocketTab #rl-launch-thrust max sync (3 places, design §3.4-4)', () => {
	const expectSlider = (tab, max, value) => {
		assert.equal(tab.ui.rlLaunchThrust.max, String(max));
		assert.equal(tab.ui.rlLaunchThrust.value, value);
		assert.equal(tab.ui.rlLaunchThrustVal.textContent, value);
	};

	it('selectTab: max = max(10000, ceil(thrustKN)) at 9999 / 10000 / 10000.2 / 10001 / 17107', () => {
		const { tab, launcher } = makeTab();
		for (const [thrust, max] of [[0, 10000], [9999, 10000], [10000, 10000], [10000.2, 10001], [10001, 10001], [17107, 17107]]) {
			launcher.stages[0].thrustKN = thrust;
			tab.selectTab(0);
			expectSlider(tab, max, thrust);
		}
	});

	it('selectTab keeps a finite base max for missing or invalid thrust values', () => {
		const { tab, launcher } = makeTab();
		for (const bad of [undefined, NaN, -500]) {
			launcher.stages[0].thrustKN = bad;
			tab.selectTab(0);
			assert.equal(tab.ui.rlLaunchThrust.max, '10000', `thrust=${String(bad)}`);
		}
	});

	it('selectTab of an upper stage syncs to that stage', () => {
		const { tab, launcher } = makeTab((rl) => { rl.stages = [liquidStage(1, { thrustKN: 12000 }), liquidStage(2, { thrustKN: 150 })]; });
		tab.selectTab(1);
		expectSlider(tab, 10000, 150);
		tab.selectTab(0);
		expectSlider(tab, 12000, 12000);
		assert.equal(launcher.stages[0].thrustKN, 12000);
	});

	it('loadState: uses the saved thrustKN, else the launcher thrustKN', () => {
		const { tab, launcher } = makeTab();
		tab.loadState({ thrustKN: 12000.5 });
		expectSlider(tab, 12001, 12000.5);
		tab.loadState({ thrustKN: 9999 });
		expectSlider(tab, 10000, 9999);
		launcher.thrustKN = 17107;
		tab.loadState({});
		expectSlider(tab, 17107, 17107);
	});

	it('fuel-type change: syncs the slider to the (unchanged) heavy thrust', () => {
		const { tab, launcher } = makeTab((rl) => presetManager.applyToLauncher(rl, { vehicleId: 'h3_24', payloadId: 'earth_obs', missionId: 'leo_250km' }));
		tab.selectTab(0);
		expectSlider(tab, 11500, 11500);
		tab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: 'liquid' } });
		assert.equal(launcher.stages[0].thrustKN, 11500);
		assert.equal(launcher.thrustKN, 11500, 'stage 0 is synced to the launcher');
		expectSlider(tab, 11500, 11500);
	});

	it('fuel-type change: a raised thrust moves the slider value and display (the max stays max(10000, ceil(thrust)))', () => {
		// §4.6: the raise is capped at max(10000, ceil(thrust)), so the max cannot change; §3.4-4 syncs the slider to the new thrust
		for (const [thrust, payloadMassT] of [[5000, 2000], [10000.5, 2000], [1000, 100]]) {
			const { tab, launcher } = makeTab((rl) => {
				rl.stages = [liquidStage(1, { thrustKN: thrust, dryMassT: 20, fuelMassT: 100, oxidMassT: 250, burnTime: 100, ofRatio: 2.5 })];
				rl.payload = { name: 'Mass', massT: payloadMassT };
				rl.fairing = { enabled: false, massT: 0 };
			});
			tab.selectTab(0);
			const maxBefore = tab.ui.rlLaunchThrust.max;
			expectSlider(tab, Math.max(10000, Math.ceil(thrust)), thrust);
			tab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: 'liquid' } });
			const raised = launcher.stages[0].thrustKN;
			assert.ok(raised > thrust, `precondition: the TWR floor raised ${thrust} kN to ${raised} kN`);
			assert.equal(launcher.thrustKN, raised);
			expectSlider(tab, Math.max(10000, Math.ceil(raised)), raised);
			assert.equal(tab.ui.rlLaunchThrust.max, maxBefore, 'max unchanged by the capped raise');
		}
	});
});

describe('RocketTab fuel-type change thrust clamp (design §4.6, G2-05)', () => {
	const G0 = PHYSICS.G0;
	/** Single-stage launcher whose liftoff mass makes the 1.35 TWR floor exceed the thrust when the payload is heavy */
	const setup = (thrustKN, payloadMassT) => makeTab((rl) => {
		rl.stages = [liquidStage(1, { thrustKN, dryMassT: 20, fuelMassT: 100, oxidMassT: 250, burnTime: 100, ofRatio: 2.5 })];
		rl.payload = { name: 'Mass', massT: payloadMassT };
		rl.fairing = { enabled: false, massT: 0 };
	});
	const liftoffMass = (rl) => rl.payload.massT + rl.stages.reduce((s, st) => s + st.dryMassT + st.fuelMassT + st.oxidMassT, 0);
	const changeFuel = (tab, fuel) => tab.ui.rlFuelType.dispatchEvent({ type: 'change', target: { value: fuel } });

	it('TWR floor above the thrust: never lowers, and caps the raise at max(10000, ceil(thrust))', () => {
		for (const [thrust, expected] of [[5000, 10000], [9999, 10000], [10000, 10000], [10000.5, 10001], [10001, 10001], [25000, 25000]]) {
			const { tab, launcher } = setup(thrust, 2000);
			changeFuel(tab, 'liquid');
			const m = liftoffMass(launcher);
			assert.ok(m * G0 * 1.35 > 30000, `precondition: floor ${m * G0 * 1.35} kN exceeds every tested thrust`);
			assert.equal(launcher.stages[0].thrustKN, expected, `thrust ${thrust}`);
			assert.equal(tab.ui.rlLaunchThrust.max, String(Math.max(10000, Math.ceil(expected))));
		}
	});

	it('thrust already above the floor is unchanged (also above 10000 kN)', () => {
		for (const thrust of [9000, 40000]) {
			const { tab, launcher } = setup(thrust, 100);
			changeFuel(tab, 'liquid');
			assert.ok(liftoffMass(launcher) * G0 * 1.35 < thrust);
			assert.equal(launcher.stages[0].thrustKN, thrust);
		}
	});

	it('thrust below a floor under 10000 kN is raised to the floor (50 kN steps)', () => {
		const { tab, launcher } = setup(1000, 100);
		changeFuel(tab, 'liquid');
		const floor = liftoffMass(launcher) * G0 * 1.35;
		const t = launcher.stages[0].thrustKN;
		assert.ok(floor > 1000 && floor < 10000);
		assert.equal(t % 50, 0);
		assert.ok(Math.abs(t - floor) <= 25, `raised to ${t}, floor ${floor}`);
		assert.equal(tab.ui.rlLaunchThrust.max, '10000');
	});

	it('ion propulsion and upper stages are not TWR-protected', () => {
		const ion = setup(1000, 2000);
		changeFuel(ion.tab, 'ion');
		assert.equal(ion.launcher.stages[0].thrustKN, 1000);

		const upper = makeTab((rl) => {
			rl.stages = [liquidStage(1, { thrustKN: 9000 }), liquidStage(2, { thrustKN: 150 })];
			rl.payload = { name: 'Mass', massT: 2000 };
		});
		upper.tab.selectTab(1);
		changeFuel(upper.tab, 'liquid');
		assert.equal(upper.launcher.stages[1].thrustKN, 150);
	});
});

// ---------------------------------------------------------------------------
// 7. ObjectPlacer: the launched rocket owns its configuration (design §4.2, G2-02)
// ---------------------------------------------------------------------------

describe('ObjectPlacer launcher-config isolation (design §4.2, G2-02)', () => {
	const makeOptions = () => ({
		flightProfile: [row('alt', 0), row('time', 200, 'sep_payload')],
		stages: [liquidStage(1), liquidStage(2)],
		payload: { name: 'Sat', massT: 3, propulsion: { enabled: true, thrustKN: 4, fuelMassT: 0.5 } },
		fairing: { enabled: true, massT: 1.5, separationAltKm: 110, isSeparated: false },
		boosters: { count: 2, thrustKN: 4310, coreThrustKN: 2940, burnTimeSec: 105 },
		rendering: { boosters: { count: 2 }, palette: ['#fff'] },
		isHoldDown: true,
		isIgnited: false
	});
	const KEYS = ['flightProfile', 'stages', 'payload', 'fairing', 'boosters', 'rendering'];

	it('deep-copies all 6 mutable configuration objects', () => {
		const placer = new ObjectPlacer(createMockUniverse());
		const options = makeOptions();
		const rocket = placer.placeObject('Rocket', 0, 0, 0, 0, options);
		for (const k of KEYS) {
			assert.notStrictEqual(rocket[k], options[k], `${k} reference`);
			assert.deepEqual(rocket[k], options[k], `${k} content`);
		}
		assert.notStrictEqual(rocket.stages[0], options.stages[0]);
		assert.notStrictEqual(rocket.flightProfile[1], options.flightProfile[1]);
		assert.notStrictEqual(rocket.payload.propulsion, options.payload.propulsion);
		assert.notStrictEqual(rocket.rendering.boosters, options.rendering.boosters);
	});

	it('mutations do not propagate in either direction', () => {
		const placer = new ObjectPlacer(createMockUniverse());
		const options = makeOptions();
		const rocket = placer.placeObject('Rocket', 0, 0, 0, 0, options);
		rocket.fairing.isSeparated = true;
		rocket.stages[1].fuelMassT = 0;
		rocket.flightProfile[1].action = '';
		assert.equal(options.fairing.isSeparated, false);
		assert.equal(options.stages[1].fuelMassT, 10);
		assert.equal(options.flightProfile[1].action, 'sep_payload');

		options.stages[0].thrustKN = 1;
		options.flightProfile.push(row('alt', 1));
		options.flightProfile[0].angle = 45;
		options.payload.propulsion.thrustKN = 99;
		options.boosters.count = 4;
		options.rendering.palette.push('#000');
		assert.equal(rocket.stages[0].thrustKN, 1000);
		assert.equal(rocket.flightProfile.length, 2);
		assert.equal(rocket.flightProfile[0].angle, 0);
		assert.equal(rocket.payload.propulsion.thrustKN, 4);
		assert.equal(rocket.boosters.count, 2);
		assert.deepEqual(rocket.rendering.palette, ['#fff']);
	});

	it('null passes through as null and absent keys are not assigned from options', () => {
		const placer = new ObjectPlacer(createMockUniverse());
		const options = { ...makeOptions(), boosters: null, rendering: null };
		delete options.payload;
		const rocket = placer.placeObject('Rocket', 0, 0, 0, 0, options);
		assert.equal(rocket.boosters, null);
		assert.equal(rocket.rendering, null);
		const plain = placer.placeObject('Rocket', 0, 0, 0, 0, { isHoldDown: true });
		assert.deepEqual(rocket.payload, plain.payload, 'an absent payload keeps the Rocket default');
		assert.doesNotThrow(() => placer.placeObject('Rocket', 0, 0, 0, 0, {}));
	});

	it('two rockets placed from the same options never share configuration', () => {
		const placer = new ObjectPlacer(createMockUniverse());
		const options = makeOptions();
		const first = placer.placeObject('Rocket', 0, 0, 0, 0, options);
		const second = placer.placeObject('Rocket', 0, 0, 0, 0, options);
		first.fairing.isSeparated = true;
		assert.equal(second.fairing.isSeparated, false);
		for (const k of KEYS) assert.notStrictEqual(first[k], second[k], k);
	});
});

// ---------------------------------------------------------------------------
// 8. Flight-profile row sanitisation at the three entry points (design §3.4-1, Rev 6.10)
// ---------------------------------------------------------------------------

describe('Flight-profile row sanitisation (design §3.4-1, Rev 6.10)', () => {
	const A = Object.freeze(row('alt', 0, '', 100, 0));
	const B = Object.freeze(row('alt', 1000, 'sep_stage1', 50, 40));
	const C = Object.freeze(row('alt', 2000, 'sep_payload', 0, 90));
	const JUNK = [null, undefined, 0, 7, NaN, '', 'alt', true, false];

	it('the FlightComputer constructor drops null/number/string/boolean rows at the first, middle and last positions', () => {
		const layouts = [
			[null, A, B, C], [A, null, B, C], [A, B, C, null],
			[7, A, B, C], [A, 'x', B, C], [A, B, C, 42],
			[null, A, 'alt', B, 3, C, undefined], [...JUNK, A, ...JUNK, B, ...JUNK, C, ...JUNK]
		];
		for (const raw of layouts) {
			const snapshot = raw.slice();
			const fc = new FlightComputer({ flightProfile: raw });
			assert.deepEqual(fc.flightProfile, [A, B, C], JSON.stringify(raw));
			assert.notStrictEqual(fc.flightProfile, raw, 'a filtered copy');
			assert.equal(fc.flightProfile[0], A, 'rows themselves are kept as given');
			assert.deepEqual(raw, snapshot, 'the input is not mutated');
		}
	});

	it('a non-array profile becomes an empty plan', () => {
		for (const profile of [null, undefined, {}, { 0: A, length: 1 }, 'alt', 42, true]) {
			const fc = new FlightComputer({ flightProfile: profile });
			assert.deepEqual(fc.flightProfile, [], `profile=${String(profile)}`);
			assert.deepEqual(evaluate(fc, { altM: 5000, flightTime: 100 }), []);
			assert.equal(fc._profileState.throttle, 1.0);
			assert.equal(fc._profileState.relAngleDeg, 0);
			assert.equal(fc.hasPendingBurnStep(), false);
			assert.equal(fc.hasScheduledAction('sep_payload'), false);
		}
	});

	it('an all-null profile behaves exactly like an empty plan', () => {
		const junk = new FlightComputer({ flightProfile: [null, null, undefined, 0, 'x'] });
		const empty = new FlightComputer({ flightProfile: [] });
		assert.deepEqual(junk.flightProfile, []);
		const s = stateAt(150000, 100, 7000);
		for (let i = 0; i < 5; i++) {
			const sensor = () => baseSensor({ ...s, refBody: EARTH, distToRefM: s.x, progradeAngle: Math.PI / 2, dt: 1 });
			assert.doesNotThrow(() => junk.update(sensor()));
			empty.update(sensor());
			assert.equal(junk.currentThrottle, empty.currentThrottle);
			assert.equal(junk.currentThrustAngleRad, empty.currentThrustAngleRad);
			assert.deepEqual(junk._profileState, empty._profileState);
			assert.equal(junk._highestStepIndex, -1);
			assert.deepEqual(junk.consumePendingActions(), []);
		}
		assert.equal(junk.hasPendingBurnStep(), false);
	});

	it('latching and interpolation run on the remaining rows, with indices of the filtered array', () => {
		const fc = new FlightComputer({ flightProfile: [null, A, 7, B, 'junk', C, null] });
		assert.deepEqual(evaluate(fc, { altM: 500 }), []);
		assert.equal(fc._highestStepIndex, 0);
		assertNear(fc._profileState.throttle, 0.75, 1e-12); // A (100 %) -> B (50 %) halfway
		assertNear(fc._profileState.relAngleDeg, 20, 1e-12);
		assert.deepEqual(evaluate(fc, { altM: 1500 }), ['sep_stage1']);
		assert.equal(fc._highestStepIndex, 1);
		assert.deepEqual([...fc._triggeredActionIndices], [1]);
		assertNear(fc._profileState.throttle, 0.25, 1e-12); // B (50 %) -> C (0 %) halfway
		assertNear(fc._profileState.relAngleDeg, 65, 1e-12);
		assert.equal(fc.hasScheduledAction('sep_payload'), true);
		assert.deepEqual(evaluate(fc, { altM: 2500 }), ['sep_payload']);
		assert.equal(fc._highestStepIndex, 2);
		assert.deepEqual([...fc._triggeredActionIndices].sort(), [1, 2]);
		assert.equal(fc._profileState.throttle, 0);
		assert.equal(fc._profileState.relAngleDeg, 90);
	});

	it('runtime-state restore validates row indices against the filtered array', () => {
		const raw = [null, A, 7, B, 'junk', C, null]; // filtered: [A, B, C]
		const fc = new FlightComputer({ flightProfile: raw });
		fc.restoreRuntimeState({ highestStepIndex: 1, triggeredActionIndices: [1], pendingActions: ['sep_stage1'] });
		assert.equal(fc._highestStepIndex, 1);
		assert.deepEqual([...fc._triggeredActionIndices], [1]);
		assert.deepEqual(fc.consumePendingActions(), ['sep_stage1']);
		assert.equal(fc.hasScheduledAction('sep_payload'), true);

		const rawIdx = new FlightComputer({ flightProfile: raw });
		rawIdx.restoreRuntimeState({ highestStepIndex: 5, triggeredActionIndices: [3, 5], pendingActions: ['sep_stage1', 'sep_payload'] });
		assert.equal(rawIdx._highestStepIndex, 2, 'clamped to the filtered length');
		assert.deepEqual([...rawIdx._triggeredActionIndices], [], 'raw-array indices are not latched rows of the filtered plan');
		assert.deepEqual(rawIdx.consumePendingActions(), [], 'pending actions need a latched row');
	});

	it('CalcRocket with a corrupted profile flies and executes the action of the remaining rows', () => {
		const rocket = makeRocket({
			stageCount: 2, stageOver: { 0: { burnTime: 100, fuelMassT: 200, oxidMassT: 400 } },
			profile: [null, row('time', 0), 'x', row('time', 3, 'sep_stage1'), 42, null]
		});
		assert.deepEqual(rocket.flightComputer.flightProfile, [row('time', 0), row('time', 3, 'sep_stage1')]);
		assert.equal(rocket._isCurrentStageSepDeferred(), true);
		for (let i = 0; i < 2; i++) assert.doesNotThrow(() => rocket.flightControl(1.0));
		assert.equal(rocket.currentStageIndex, 0);
		rocket.flightControl(1.0);
		assert.equal(rocket.currentStageIndex, 1);
		assert.equal(rocket.stageState, 'INTERSTAGE_COAST');
	});

	it('RocketLauncher.loadState keeps only object rows; non-array becomes [] and an absent profile is untouched', () => {
		const { universe } = makeTab();
		const launcher = new RocketLauncher(universe);
		const raw = [null, A, 3, 'junk', B, undefined, C, false];
		launcher.loadState({ flightProfile: raw });
		assert.deepEqual(launcher.flightProfile, [A, B, C]);
		assert.notStrictEqual(launcher.flightProfile[0], A, 'a deep copy of the saved rows');
		assert.deepEqual(launcher.getState().flightProfile, [A, B, C]);
		for (const bad of [null, {}, 'alt', 42]) {
			launcher.loadState({ flightProfile: bad });
			assert.deepEqual(launcher.flightProfile, [], `flightProfile=${String(bad)}`);
		}
		launcher.loadState({ flightProfile: [null, null] });
		assert.deepEqual(launcher.flightProfile, []);
		launcher.flightProfile = [A];
		launcher.loadState({ mode: 'host' });
		assert.deepEqual(launcher.flightProfile, [A], 'no flightProfile key: unchanged');
	});

	it('RocketTab.loadState keeps only object rows and renders them; non-array renders an empty table', () => {
		const { tab, launcher } = makeTab();
		assert.doesNotThrow(() => tab.loadState({ flightProfile: [7, A, null, B, 'junk', C, undefined] }));
		assert.deepEqual(launcher.flightProfile, [A, B, C]);
		const rows = profileRows(tab);
		assert.equal(rows.length, 3);
		assert.deepEqual(rows.map(tr => selectedValue(tr.children[4].children[0])), ['', 'sep_stage1', 'sep_payload']);
		assert.deepEqual(rows.map(tr => tr.children[1].children[0].value), [0, 1000, 2000]);
		rows[1].children[5].children[0].onclick(); // delete B: indices refer to the filtered rows
		assert.deepEqual(launcher.flightProfile, [A, C]);
		for (const bad of [null, {}, 'alt', 42, [null, undefined]]) {
			tab.loadState({ flightProfile: bad });
			assert.deepEqual(launcher.flightProfile, [], `flightProfile=${JSON.stringify(bad)}`);
			assert.equal(profileRows(tab).length, 0);
		}
	});

	// Gate 3 Watchpoint 5: an object row without a finite value / thrust / angle has no defined command (§3.4-2 rows
	// are (type, value, thrust, angle, action); the design defines no defaults for thrust or angle) and produced a
	// NaN throttle / angle. It is removed by the same three entry points as a non-object row.
	const INCOMPLETE = [
		{ type: 'time', value: 0 }, { type: 'alt', value: 0, thrust: 100 }, { type: 'alt', thrust: 100, angle: 0 },
		{ type: 'time', value: 0, thrust: '100', angle: 0 }, { type: 'time', value: '0', thrust: 100, angle: 0 },
		{ type: 'time', value: 0, thrust: 100, angle: '10' }, { type: 'time', value: NaN, thrust: 100, angle: 0 },
		{ type: 'time', value: 0, thrust: Infinity, angle: 0 }, { type: 'time', value: 0, thrust: 100, angle: -Infinity },
		{ type: 'time', value: null, thrust: 100, angle: 0 }, { type: 'time', value: 0, thrust: null, angle: 0, action: 'sep_payload' },
		{}, [1, 2], []
	];

	it('the FlightComputer constructor also drops object rows whose value, thrust or angle is not a finite number', () => {
		for (const bad of INCOMPLETE) {
			for (const raw of [[bad, A, B, C], [A, bad, B, C], [A, B, C, bad]]) {
				const fc = new FlightComputer({ flightProfile: raw });
				assert.deepEqual(fc.flightProfile, [A, B, C], JSON.stringify(raw));
				assert.equal(fc.flightProfile[1], B, 'kept rows are the given objects');
			}
		}
		const fc = new FlightComputer({ flightProfile: [...INCOMPLETE, A, ...INCOMPLETE, B, null, ...INCOMPLETE, C] });
		assert.deepEqual(fc.flightProfile, [A, B, C]);
		const edge = [row('time', 0, '', 0, -90), row('time', -5, '', 100, 90), row('time', 1e300, '', 100, 0)];
		assert.deepEqual(new FlightComputer({ flightProfile: edge }).flightProfile, edge, 'finite zero / negative / large numbers are kept');
	});

	it('a profile of incomplete rows only behaves exactly like an empty plan (no NaN command, no scheduled action)', () => {
		const junk = new FlightComputer({ flightProfile: INCOMPLETE });
		const empty = new FlightComputer({ flightProfile: [] });
		assert.deepEqual(junk.flightProfile, []);
		assert.equal(junk.hasScheduledAction('sep_payload'), false, 'the action of a dropped row is not scheduled');
		const s = stateAt(150000, 100, 7000);
		for (let i = 0; i < 5; i++) {
			const sensor = () => baseSensor({ ...s, refBody: EARTH, distToRefM: s.x, progradeAngle: Math.PI / 2, dt: 1 });
			junk.update(sensor());
			empty.update(sensor());
			assert.ok(Number.isFinite(junk.currentThrottle) && Number.isFinite(junk.currentThrustAngleRad));
			assert.equal(junk.currentThrottle, empty.currentThrottle);
			assert.equal(junk.currentThrustAngleRad, empty.currentThrustAngleRad);
			assert.deepEqual(junk._profileState, empty._profileState);
		}
	});

	it('CalcRocket with a { type, value }-only row burns like a rocket with an empty plan', () => {
		const burnTimes = (profile) => {
			const rocket = makeRocket({ stageCount: 2, stageOver: { 0: { burnTime: 50, fuelMassT: 100, oxidMassT: 200 } }, profile });
			const out = [];
			for (let i = 0; i < 3; i++) {
				rocket.flightControl(1.0);
				out.push([rocket.stageState, rocket.burnTime, rocket.flightComputer.currentThrottle]);
			}
			return out;
		};
		const incomplete = burnTimes([{ type: 'time', value: 0 }]);
		assert.deepEqual(incomplete, burnTimes([]));
		assert.deepEqual(incomplete.map(([state, burn]) => [state, burn]), [['STG_BURNING', 49], ['STG_BURNING', 48], ['STG_BURNING', 47]]);
	});

	it('RocketLauncher.loadState and RocketTab.loadState drop the same incomplete rows', () => {
		const { tab, universe } = makeTab();
		const launcher = new RocketLauncher(universe);
		const raw = [INCOMPLETE[0], A, INCOMPLETE[3], B, INCOMPLETE[6], C, INCOMPLETE[10]];
		launcher.loadState({ flightProfile: raw });
		assert.deepEqual(launcher.flightProfile, [A, B, C]);
		const saved = JSON.parse(JSON.stringify({ flightProfile: [...raw, { type: 'time', value: Infinity, thrust: 100, angle: 0 }] })); // JSON: NaN/Infinity -> null
		launcher.loadState(saved);
		assert.deepEqual(launcher.flightProfile, [A, B, C]);
		tab.loadState(saved);
		assert.deepEqual(universe.RocketLauncher.flightProfile, [A, B, C]);
		assert.equal(profileRows(tab).length, 3);
		assert.deepEqual(profileRows(tab).map(tr => tr.children[2].children[0].value), [100, 50, 0]);
		tab.loadState({ flightProfile: INCOMPLETE });
		assert.deepEqual(universe.RocketLauncher.flightProfile, []);
		assert.equal(profileRows(tab).length, 0);
	});
});
