/**
 * Regression 08c: see 08_trajectory_guarantees_helpers.mjs for the method (app path, drawn frame, design and
 * test plan references). Split from the former 08_trajectory_prediction_guarantees.test.mjs without changing any test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	TP,
	MONTH_S,
	DAY_S,
	AU,
	m2p,
	DRAWN_LIMIT_RAD,
	ROT0,
	AZ8,
	REVS_02,
	REVS_1PLUS,
	normAngle,
	round,
	makeWorld,
	makeLauncher,
	predictCase,
	capture,
	drawnStats,
	hostAt,
	flightCapture,
	postSwitchTurns,
	assertGuarantees12,
	assertGuarantee3,
	days,
	reach,
	presetManager,
	PHYSICS
} from './08_trajectory_guarantees_helpers.mjs';

describe('Regression 08c: trajectory prediction guarantees on the app path (§4.3), deep space, lunar transfer, other worlds and Gate 2 guards', () => {

	describe('Sun+Earth, 8 azimuths: deep-space departures (guarantee 4 (a))', () => {
		it('mars 36 months: 3 azimuths horizon, 5 point_budget at 99.91-99.98% reach', () => {
			const ends = { horizon: 0, point_budget: 0 };
			for (const az of AZ8) {
				const e = predictCase('SE', 'mars', 36, az);
				assertGuarantees12(e);
				assert.ok(e.pred.endReason === 'horizon' || e.pred.endReason === 'point_budget', `${e.key}: ${e.pred.endReason}`);
				assert.ok(reach(e) >= 99.5, `${e.key}: reach ${reach(e)}%`);
				ends[e.pred.endReason]++;
				if (e.pred.endReason === 'point_budget') {
					const r = round(reach(e), 2);
					assert.ok(r >= 99.91 && r <= 99.98, `${e.key}: point_budget reach ${r}%`);
				}
			}
			assert.deepEqual(ends, { horizon: 3, point_budget: 5 });
		});

		for (const [mission, months] of [['jupiter', 36], ['solar', 36], ['mars', 12]]) {
			it(`${mission} ${months} months: horizon (100%) on every azimuth`, () => {
				for (const az of AZ8) {
					const e = predictCase('SE', mission, months === 12 ? null : months, az);
					assert.equal(e.requested, months * MONTH_S, `${e.key}: preset period`);
					assertGuarantees12(e);
					assert.equal(e.pred.endReason, 'horizon', e.key);
					assert.ok(reach(e) >= 99.5);
				}
			});
		}
	});

	describe('Sun+Earth, 8 azimuths: lunar transfer 1 month (guarantee 5)', () => {
		it('ends by step_budget (13.8-13.9 days) on 4 azimuths and breakup (10.2-10.4 days) on 4', () => {
			const ends = { step_budget: 0, breakup: 0 };
			for (const az of AZ8) {
				const e = predictCase('SE', 'lunar', null, az);
				assert.equal(e.requested, MONTH_S);
				assertGuarantees12(e);
				assert.ok(['step_budget', 'breakup', 'impact', 'horizon'].includes(e.pred.endReason), `${e.key}: ${e.pred.endReason}`);
				ends[e.pred.endReason] = (ends[e.pred.endReason] || 0) + 1;
				const d = round(days(e), 1);
				if (e.pred.endReason === 'step_budget') { assert.ok(d >= 13.8 && d <= 13.9, `${e.key}: ${d} days`); }
				if (e.pred.endReason === 'breakup') { assert.ok(d >= 10.2 && d <= 10.4, `${e.key}: ${d} days`); }
			}
			assert.deepEqual(ends, { step_budget: 4, breakup: 4 });
		});
	});

	describe('Other worlds: 7-body, SOLAR_SYSTEM, BINARY_SYSTEM, THREE_BODY', () => {
		it('7-body world (Sun, Earth, Moon, Venus, Mars, Jupiter): guarantees 3, 4 (a) and 5', () => {
			const g3 = [['leo', 0.2, 0, REVS_02.leo], ['gto', 0.2, 135, REVS_02.gto], ['iss', 0.2, 270, REVS_02.iss], ['iss', 1, 270, REVS_1PLUS.iss]];
			for (const [mission, months, az, revs] of g3) {
				const e = predictCase('W7', mission, months, az);
				assert.equal(e.nBodies, 6, '7-body world = 6 bodies + the rocket');
				assertGuarantees12(e);
				assertGuarantee3(e, revs);
			}
			const mars = predictCase('W7', 'mars', 36, 0);
			assertGuarantees12(mars);
			assert.ok(['horizon', 'point_budget'].includes(mars.pred.endReason));
			assert.ok(reach(mars) >= 99.5, `reach ${reach(mars)}%`);
			const lunar = predictCase('W7', 'lunar', null, 0);
			assertGuarantees12(lunar);
			assert.ok(['step_budget', 'breakup', 'impact', 'horizon'].includes(lunar.pred.endReason));
		});

		it('SOLAR_SYSTEM: guarantees 3 and 4 (a)', () => {
			for (const [mission, az] of [['leo', 90], ['gto', 180]]) {
				const e = predictCase('SS', mission, 0.2, az);
				assert.equal(e.earth.name, 'Earth');
				assertGuarantees12(e);
				assertGuarantee3(e, REVS_02[mission]);
			}
			const mars = predictCase('SS', 'mars', 36, 270);
			assertGuarantees12(mars);
			assert.ok(['horizon', 'point_budget'].includes(mars.pred.endReason));
			assert.ok(reach(mars) >= 99.5, `reach ${reach(mars)}%`);
		});

		it('BINARY_SYSTEM: guarantee 3, guarantee 4 (b) end reasons only, guarantee 5 including horizon', () => {
			const iss = predictCase('BIN', 'iss', 0.2, 45);
			assertGuarantees12(iss);
			assertGuarantee3(iss, REVS_02.iss);
			for (const [mission, az] of [['mars', 0], ['solar', 180]]) {
				const e = predictCase('BIN', mission, 36, az);
				assertGuarantees12(e);
				assert.ok(['horizon', 'point_budget'].includes(e.pred.endReason), `${e.key}: ${e.pred.endReason}`);
				const turns = round(postSwitchTurns(e), 1);
				assert.ok(turns >= 7.8 && turns <= 15.3, `${e.key}: ${turns} drawn revolutions around the host`);
			}
			// Gate 2 Iteration 8 Watchpoint 5: this configuration ends at horizon, which guarantee 5 allows
			const lunar = predictCase('BIN', 'lunar', 0.5, 135);
			assertGuarantees12(lunar);
			assert.equal(lunar.pred.endReason, 'horizon');
		});

		it('THREE_BODY: guarantee 3, guarantee 4 (b), the 0.140 rad maximum and the shortest reach', () => {
			const gto = predictCase('TB', 'gto', 0.2, 90);
			assert.equal(gto.earth.name, 'Earth (Trisolaris)');
			assertGuarantees12(gto);
			assertGuarantee3(gto, REVS_02.gto);
			for (const [mission, az] of [['mars', 225], ['solar', 45], ['jupiter', 270]]) {
				const e = predictCase('TB', mission, 36, az);
				assertGuarantees12(e);
				assert.ok(['horizon', 'point_budget'].includes(e.pred.endReason), `${e.key}: ${e.pred.endReason}`);
				const turns = round(postSwitchTurns(e), 1);
				assert.ok(turns >= 7.8 && turns <= 15.3, `${e.key}: ${turns} drawn revolutions around the host`);
			}
			// Largest drawn step of guarantee 4 (b): Mars 36 months, azimuth 225, 0.140 rad on day 103 (not at the end)
			const mars = predictCase('TB', 'mars', 36, 225);
			const drawn = assertGuarantees12(mars);
			assert.equal(round(drawn.maxStep, 3), 0.140);
			const p = mars.pred.points;
			const tsw = mars.pred.frameSwitchTime;
			const ang = p.map(q => (q.time <= tsw ? q.phiSurf + ROT0 : Math.atan2(q.relY, q.relX) + ROT0 - mars.pred.frameSwitchHostRot));
			let iMax = 1;
			for (let i = 1; i < p.length; i++) {
				if (Math.abs(normAngle(ang[i] - ang[i - 1])) > Math.abs(normAngle(ang[iMax] - ang[iMax - 1]))) { iMax = i; }
			}
			assert.ok(Math.abs(Math.abs(normAngle(ang[iMax] - ang[iMax - 1])) - drawn.maxStep) <= 1e-9, 'the projected points reproduce the drawn maximum');
			assert.equal(Math.round(p[iMax].time / DAY_S), 103);
			assert.ok(iMax < p.length - 1, 'the maximum is not at the final point');
			// Shortest reach: Solar 36 months, azimuth 45, ends on day 1,023.2, 72.5 days before the request (93.38%)
			const solar = predictCase('TB', 'solar', 36, 45);
			assert.equal(solar.pred.endReason, 'point_budget');
			assert.equal(round(reach(solar), 2), 93.38);
			assert.equal(round(days(solar), 1), 1023.2);
			assert.equal(round((solar.requested - solar.pred.points.at(-1).time) / DAY_S, 1), 72.5);
			const lunar = predictCase('TB', 'lunar', null, 0);
			assertGuarantees12(lunar);
			assert.ok(['step_budget', 'breakup', 'impact', 'horizon'].includes(lunar.pred.endReason));
		});
	});

	describe('Gate 2 regression guards', () => {
		it('G2-2-01: deep-space preset periods are not drawn as a zigzag; without the frame switch they would be', () => {
			for (const mission of ['mars', 'jupiter', 'solar']) {
				const e = predictCase('SE', mission, null, 0);
				assert.equal(e.requested, (mission === 'mars' ? 12 : 36) * MONTH_S, 'preset default period');
				const drawn = assertGuarantees12(e);
				assert.ok(drawn.maxStep <= DRAWN_LIMIT_RAD);
				// Negative control: the Rev 6 drawing (every point host-fixed) jumps by more than 1 rad
				const legacy = { ...e.pred, frameSwitchTime: null };
				const legacyDrawn = drawnStats(capture(legacy, hostAt(e.earth, ROT0), { mode: 'preview' }), `${e.key} legacy`);
				assert.ok(legacyDrawn.maxStep > 1, `${e.key}: host-fixed drawing would jump ${legacyDrawn.maxStep} rad`);
			}
		});

		it('G2-2-02: a breakup ends the line at the breakup point; no motionless wreck is drawn', () => {
			const breakups = AZ8.map(az => predictCase('SE', 'lunar', null, az)).filter(e => e.pred.endReason === 'breakup');
			assert.equal(breakups.length, 4);
			for (const e of breakups) {
				const p = e.pred.points;
				const last = p.at(-1);
				const ev = e.pred.events.filter(x => x.id === 'breakup');
				assert.equal(ev.length, 1);
				assert.equal(ev[0].type, 'impact');
				assert.equal(ev[0].name, 'BREAKUP');
				assert.equal(last.time, ev[0].time, `${e.key}: the final point is the breakup point`);
				assert.equal(last.relX, ev[0].relX);
				assert.equal(last.relY, ev[0].relY);
				for (let i = 1; i < p.length; i++) {
					if (p[i].relX === p[i - 1].relX && p[i].relY === p[i - 1].relY) { assert.fail(`${e.key}: repeated position at ${p[i].time}`); }
				}
				assert.ok(e.pred.maxSimTime < e.requested, `${e.key}: no validity claimed beyond the breakup`);
			}
		});

		it('G2-3-01: a direct-ascent departure switches to the inertial frame during the ascent, not at the late orbit event', () => {
			const steep = (maxDeg) => [[0, 0], [2000, Math.min(10, maxDeg)], [15000, Math.min(20, maxDeg)], [40000, maxDeg], [400000, maxDeg]]
				.map(([value, angle]) => ({ type: 'alt', value, thrust: 100, angle, action: '' }));
			for (const maxDeg of [0, 20]) {
				const w = makeWorld('SE');
				const rl = makeLauncher(w, 'mars', null, 0, steep(maxDeg));
				const pred = rl.updatePredictionSync();
				const entry = { key: `direct ascent ${maxDeg} deg`, pred, earth: w.earth, requested: rl.maxSimTimeSec };
				assertGuarantees12(entry);
				assert.equal(pred.endReason, 'horizon');
				const tsw = pred.frameSwitchTime;
				const orbit = pred.events.find(x => x.id === 'orbit');
				assert.ok(tsw !== null && tsw < 1000, `${entry.key}: switch at ${tsw} s during the ascent`);
				assert.ok(orbit && orbit.time > tsw + 10 * DAY_S, `${entry.key}: the orbit criterion is met only ${orbit && orbit.time / DAY_S} days later`);
				const swPt = pred.points.find(q => q.time === tsw);
				assert.ok(swPt.altM > TP.EVENTS.ORBIT_MIN_ALT_M && swPt.altM < TP.FRAME_SWITCH.MAX_HOST_FIXED_ALT_M, `${entry.key}: switched by E >= 0 above the atmosphere`);
				const pre = pred.points.filter(q => q.time <= tsw);
				let winding = 0;
				for (let i = 1; i < pre.length; i++) { winding += normAngle(pre[i].phiSurf - pre[i - 1].phiSurf); }
				assert.ok(Math.abs(winding) / (2 * Math.PI) < 0.1, `${entry.key}: no host-fixed spiral before the switch (${winding / (2 * Math.PI)} turns)`);
				const a = drawnStats(flightCapture(entry, tsw + 1), 'tsw+1').vertices;
				const b = drawnStats(flightCapture(entry, tsw + 3600), 'tsw+3600').vertices;
				assert.equal(a.length, b.length);
				let maxDisp = 0;
				let maxR = 0;
				for (let i = 0; i < a.length; i++) {
					maxDisp = Math.max(maxDisp, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
					maxR = Math.max(maxR, Math.hypot(a[i][0], a[i][1]));
				}
				assert.ok(maxDisp <= 1e-9 * maxR, `${entry.key}: the line is fixed in space after the switch (moved ${maxDisp} px)`);
			}
		});

		it('G2-4-01 / G2-6-01: a later third-body flyby is never covered by an extrapolated validity', () => {
			// Gate 2 Iteration 6 counterexample: Moon thrown in at 1,300,000 km, 1.01 x escape speed, conic periapsis
			// 60,000 km (passage after ~13.7 days); GTO at its preset 0.5 months was shown valid for 15.22 days.
			const w = makeWorld('SE');
			const moonParam = presetManager.getObjectParam('Moon');
			const mu = PHYSICS.G * (5.972e24 + (moonParam.MASS ?? moonParam.mass) * 1000);
			const d = 1.3e9;
			const rp = 6e7;
			const v = 1.01 * Math.sqrt(2 * mu / d);
			const h = rp * Math.sqrt(2 * (0.5 * v * v - mu / d + mu / rp));
			const sinA = Math.min(1, h / (d * v));
			const cosA = Math.sqrt(1 - sinA * sinA);
			const ph = Math.PI / 4;
			const ux = Math.cos(ph);
			const uy = Math.sin(ph);
			w.placer.placeObject('Moon', m2p(AU + d * ux), m2p(d * uy), m2p(v * (-cosA * ux - sinA * uy)), m2p(29780 + v * (-cosA * uy + sinA * ux)));
			const rl = makeLauncher(w, 'gto', null, 0);
			const pred = rl.updatePredictionSync();
			const entry = { key: 'GTO + Moon flyby', pred, earth: w.earth, requested: rl.maxSimTimeSec };
			assertGuarantees12(entry);
			assert.equal(rl.maxSimTimeSec, 0.5 * MONTH_S);
			assert.equal(pred.endReason, 'step_budget');
			assert.equal(round(pred.maxSimTime / DAY_S, 1), 1.2, 'valid only over what was integrated');
			assert.ok(pred.maxSimTime < 13 * DAY_S, 'the flyby lies outside the claimed validity');
			assert.ok(drawnStats(flightCapture(entry, pred.maxSimTime - 1), 'before end').n > 0);
			assert.equal(drawnStats(flightCapture(entry, pred.maxSimTime + 1), 'after end').n, 0, 'erased instead of being shown until the request');
			assert.equal(Object.prototype.hasOwnProperty.call(TP, 'SETTLED_ORBIT'), false, 'the settled-orbit mechanism is removed');
		});

		it('G2-8-01 / Rev 6.10: budget options that are not positive numbers leave the app-path prediction unchanged', () => {
			const withoutAngle = (pred) => {
				const { baseHostAngleRad: _angle, ...rest } = pred;
				return rest;
			};
			const leo = predictCase('SE', 'leo', 0.2, 0);
			const leoCfg = leo.rl._getPredictionContext().config;
			for (const maxSteps of ['abc', '', {}, -1]) {
				const res = leo.rl.predictor.calculateSync({ ...leoCfg, maxSteps });
				assert.equal(res.steps, 120000, `maxSteps ${JSON.stringify(maxSteps)}: the normal 0.2-month step budget`);
				assert.deepStrictEqual(res, withoutAngle(leo.pred), `maxSteps ${JSON.stringify(maxSteps)}`);
			}
			const mars = predictCase('SE', 'mars', 36, 90);
			const marsCfg = mars.rl._getPredictionContext().config;
			for (const maxPoints of ['abc', [], -1]) {
				const res = mars.rl.predictor.calculateSync({ ...marsCfg, maxPoints });
				assert.equal(res.points.length, TP.MAX_POINTS, `maxPoints ${JSON.stringify(maxPoints)}`);
				assert.deepStrictEqual(res, withoutAngle(mars.pred), `maxPoints ${JSON.stringify(maxPoints)}`);
			}
			const lowered = mars.rl.predictor.calculateSync({ ...marsCfg, maxPoints: '500' });
			assert.equal(lowered.points.length, 500, "a numeric string lowers the point budget");
			assert.equal(lowered.endReason, 'point_budget');
		});

		it('G2-8-01: maxPoints and maxSteps passed to the predictor cannot exceed MAX_POINTS and MAX_STEPS_CAP', () => {
			const marsEntry = predictCase('SE', 'mars', 36, 90);
			assert.equal(marsEntry.pred.endReason, 'point_budget');
			const marsCtx = marsEntry.rl._getPredictionContext();
			for (const maxPoints of [TP.MAX_POINTS + 1, Infinity]) {
				const res = marsEntry.rl.predictor.calculateSync({ ...marsCtx.config, maxPoints });
				assert.equal(res.points.length, TP.MAX_POINTS, `maxPoints ${maxPoints}`);
				assert.equal(res.endReason, 'point_budget');
			}
			const leoEntry = predictCase('SE', 'leo', 1, 0);
			const leoCtx = leoEntry.rl._getPredictionContext();
			for (const maxSteps of [TP.MAX_STEPS_CAP + 1]) {
				const res = leoEntry.rl.predictor.calculateSync({ ...leoCtx.config, maxSteps });
				assert.equal(res.steps, TP.MAX_STEPS_CAP, `maxSteps ${maxSteps}`);
				assert.equal(res.endReason, 'step_budget');
				assert.equal(res.maxSimTime, leoEntry.pred.maxSimTime, 'same integrated range as the app path');
			}
		});
	});
});
