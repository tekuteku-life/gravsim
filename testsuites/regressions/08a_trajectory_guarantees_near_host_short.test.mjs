/**
 * Regression 08a: see 08_trajectory_guarantees_helpers.mjs for the method (app path, drawn frame, design and
 * test plan references). Split from the former 08_trajectory_prediction_guarantees.test.mjs without changing any test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	AZ8,
	REVS_02,
	round,
	predictCase,
	assertGuarantees12,
	assertGuarantee3,
	days
} from './08_trajectory_guarantees_helpers.mjs';

describe('Regression 08a: trajectory prediction guarantees on the app path (§4.3), near-host closed orbits at 0.2 months and preset periods', () => {

	describe('Sun+Earth, 8 azimuths: near-host closed orbits (guarantees 1-3)', () => {
		for (const mission of ['leo', 'iss', 'gto']) {
			it(`${mission} 0.2 months: step_budget and ${REVS_02[mission]} drawn revolutions after the switch on every azimuth`, () => {
				for (const az of AZ8) {
					const e = predictCase('SE', mission, 0.2, az);
					assertGuarantees12(e);
					assertGuarantee3(e, REVS_02[mission]);
				}
			});
		}

		it('default periods (LEO 0.2, ISS 0.3, GTO 0.5 months): step_budget at 0.1 / 0.2 / 1.2 days independent of azimuth', () => {
			const expectedDays = { leo: 0.1, iss: 0.2, gto: 1.2 };
			for (const mission of ['leo', 'iss', 'gto']) {
				// LEO's default is the 0.2-month case above (all 8 azimuths, cached); ISS/GTO use the 4 cardinal azimuths
				for (const az of (mission === 'leo' ? AZ8 : [0, 90, 180, 270])) {
					const e = mission === 'leo' ? predictCase('SE', 'leo', 0.2, az) : predictCase('SE', mission, null, az);
					assertGuarantees12(e);
					assertGuarantee3(e);
					assert.equal(round(days(e), 1), expectedDays[mission], `${e.key}: arrival day`);
				}
			}
		});
	});
});
