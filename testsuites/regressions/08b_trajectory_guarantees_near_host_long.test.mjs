/**
 * Regression 08b: see 08_trajectory_guarantees_helpers.mjs for the method (app path, drawn frame, design and
 * test plan references). Split from the former 08_trajectory_prediction_guarantees.test.mjs without changing any test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	MONTH_S,
	AZ8,
	MISSIONS,
	REVS_1PLUS,
	round,
	predictCase,
	assertGuarantees12,
	assertGuarantee3,
	days
} from './08_trajectory_guarantees_helpers.mjs';

describe('Regression 08b: trajectory prediction guarantees on the app path (§4.3), near-host closed orbits at 1 month and the measured table', () => {

	describe('Sun+Earth, 8 azimuths: near-host closed orbits (guarantees 1-3)', () => {
		const arrival1 = { leo: [0.38, 0.39], iss: [0.38, 0.39], gto: [1.55, 1.55] };
		for (const mission of ['leo', 'iss', 'gto']) {
			it(`${mission} 1 month: step_budget at ${arrival1[mission].join('-')} days and ${REVS_1PLUS[mission]} revolutions on every azimuth`, () => {
				for (const az of AZ8) {
					const e = predictCase('SE', mission, 1, az);
					assertGuarantees12(e);
					assertGuarantee3(e, REVS_1PLUS[mission]);
					const d = round(days(e), 2);
					assert.ok(d >= arrival1[mission][0] && d <= arrival1[mission][1], `${e.key}: arrival ${d} days`);
				}
			});
		}
	});

	describe('§4.3 measured table (Sun+Earth, azimuth 0)', () => {
		// [mission, 0.2-month end/time(s)/points, >=1-month end/time(s)/points range, drawn max step (0.2 / >=1)]
		const NEAR = [
			['iss', 11262, 1528, 33262, [1829, 1829], 0.036, 0.120],
			['leo', 11358, 1572, 33358, [1834, 1834], 0.037, 0.120],
			['gto', 40882, 1537, 133707, [1747, 1771], 0.060, 0.120],
			['lunar', 372654, 1566, 1203081, [1598, 2013], 0.069, 0.120]
		];
		for (const [mission, t02, n02, t1, nRange, step02, step1] of NEAR) {
			it(`${mission}: step_budget ${t02} s / ${n02} points at 0.2 months, ${t1} s at 1-36 months`, () => {
				const e02 = predictCase('SE', mission, 0.2, 0);
				const s02 = assertGuarantees12(e02);
				assert.equal(e02.pred.endReason, 'step_budget');
				assert.ok(Math.abs(e02.pred.points.at(-1).time - t02) < 1, `${e02.key}: final time ${e02.pred.points.at(-1).time}`);
				assert.equal(e02.pred.points.length, n02);
				assert.equal(round(s02.maxStep, 3), step02, `${e02.key}: drawn max step`);
				let maxStep1 = 0;
				for (const months of [1, 36]) {
					const e = predictCase('SE', mission, months, 0);
					const s = assertGuarantees12(e);
					assert.equal(e.pred.endReason, 'step_budget');
					assert.ok(Math.abs(e.pred.points.at(-1).time - t1) < 1, `${e.key}: final time ${e.pred.points.at(-1).time}`);
					assert.ok(e.pred.points.length >= nRange[0] && e.pred.points.length <= nRange[1], `${e.key}: ${e.pred.points.length} points`);
					maxStep1 = Math.max(maxStep1, s.maxStep);
				}
				assert.equal(round(maxStep1, 3), step1, `${mission}: drawn max step over 1-36 months`);
			});
		}

		const DEEP = [
			['mars', 1949, [2965, 3000], 0.120],
			['jupiter', 1416, [2431, 2501], 0.120],
			['solar', 1679, [2695, 2730], 0.112]
		];
		for (const [mission, n02, nRange, step] of DEEP) {
			it(`${mission}: horizon 100% with ${n02} points at 0.2 months and ${nRange.join('-')} points at 1-36 months`, () => {
				const e02 = predictCase('SE', mission, 0.2, 0);
				let maxStep = assertGuarantees12(e02).maxStep;
				assert.equal(e02.pred.endReason, 'horizon');
				assert.equal(e02.pred.points.length, n02);
				for (const months of [1, 36]) {
					const e = predictCase('SE', mission, months, 0);
					maxStep = Math.max(maxStep, assertGuarantees12(e).maxStep);
					assert.equal(e.pred.endReason, 'horizon', e.key);
					assert.ok(e.pred.points.length >= nRange[0] && e.pred.points.length <= nRange[1], `${e.key}: ${e.pred.points.length} points`);
				}
				assert.equal(round(maxStep, 3), step, `${mission}: drawn max step`);
			});
		}

		it('1200 s predictions end at horizon with 1,122-1,631 points (> 500) for all 7 missions', () => {
			for (const mission of Object.keys(MISSIONS)) {
				const e = predictCase('SE', mission, 1200 / MONTH_S, 0);
				assertGuarantees12(e);
				assert.equal(e.pred.endReason, 'horizon', e.key);
				assert.ok(e.pred.points.length >= 1122 && e.pred.points.length <= 1631, `${e.key}: ${e.pred.points.length} points`);
			}
		});
	});
});
