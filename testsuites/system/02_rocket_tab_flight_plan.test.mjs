/**
 * System E2E 02 (headless Chrome): the Rocket tab flight-profile table and launch-thrust slider.
 *
 * Expectations come from docs/design/2026-11-20_trajectory_fx_flightplan.md:
 *  - §3.4-4: `#rl-flight-profile-table` with 6 columns in children[0..5] order (19/22/14/14/21/10 %):
 *    select.fp-trigger (alt/time/vel/apogee), input[type=number].fp-val / .fp-thrust / .fp-angle,
 *    select.fp-action (""=-, sep_stage1=Stg1, sep_stage2=Stg2, sep_payload=Pay) and
 *    button[type=button].fp-del "✕"; the 320 px sidebar keeps scrollWidth <= clientWidth;
 *    `#rl-launch-thrust` max = max(10000, ceil(thrustKN)) synced in selectTab and the fuel-type change.
 *  - §3.4-2: the iss_rendezvous flightProfile (the launcher's default mission).
 *  - §4.6 (G2-05): changing the fuel type never lowers the thrust.
 *  - §4.13 / test plan §4.6 (fixed pre-existing defect): choosing a mission shows its prediction period
 *    (presets/missions predictionDurationMonths) on the System-tab slider #pred-duration and its label
 *    ("<m> mo (<round(m * 365.25 / 12)> d)" below 12 months, "<m / 12, 1 decimal> yr (<m> mo)" from 12).
 *  - Design §4.13-10 (fixed pre-existing defect): closing the Rocket tab restores the time scale, the zoom (camera and
 *    slider) and the camera target from before it opened, also after a second click on the open tab.
 * The trigger labels are compared exactly with design §3.4-4 (Rev 6.10: "Alt(m)", "Time(s)", "Vel(m/s)", "Apogee(s)").
 *  - Design §4.13-31: a launch sequence aborts when its rocket is removed: no later event (WATER DELUGE at the time of
 *    LAUNCH_SEQUENCES.FULL_COUNTDOWN), no deluge, and the Rocket tab is back to Rollout with the tabs unlocked.
 *  - Design §4.14-4: the stage and payload sliders step by the resolution of the sizing (0.1 t, 1 kN from 1 kN, 0.01 t),
 *    so the HTML value sanitization keeps every sized value: the slider value, its label and the launcher agree.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	startE2E, bootGravSim, clickTab, deployBody, predictorRequestId, waitPredictionSettled,
	predictionSummary, readProfileTable, setRangeByKeys, unexpectedProblems,
	PREDICTION_END_REASONS, MAX_PREDICTION_POINTS, PROJECT_ROOT, SECONDS_PER_MONTH
} from './cdp_helpers.mjs';

/** Design §3.4-2: iss_rendezvous rows (type alt, thrust 100, action ""): [value, angle]. */
const ISS_PROFILE = [[0, 0], [2000, 8], [18000, 22], [50000, 42], [100000, 62], [200000, 76], [320000, 85], [400000, 90]];
const TRIGGER_OPTIONS = [['alt', 'Alt(m)'], ['time', 'Time(s)'], ['vel', 'Vel(m/s)'], ['apogee', 'Apogee(s)']];
const ACTION_OPTIONS = [['', '-'], ['sep_stage1', 'Stg1'], ['sep_stage2', 'Stg2'], ['sep_payload', 'Pay']];
const COLUMN_WIDTHS = ['19%', '22%', '14%', '14%', '21%', '10%'];
const DEFAULT_ROW = { type: 'alt', value: 0, thrust: 100, angle: 0, action: '' };

/** Assert the 6-column structure of every rendered row (design §3.4-4). */
function assertRowStructure(rows) {
	rows.forEach((row, i) => {
		const at = `row ${i}`;
		assert.equal(row.cellCount, 6, `${at}: 6 cells`);
		row.cells.forEach((cell, c) => assert.equal(cell?.childCount, 1, `${at} cell ${c}: exactly one control`));
		const [trigger, value, thrust, angle, action, del] = row.cells;
		assert.equal(trigger.tag, 'select');
		assert.equal(trigger.className, 'fp-trigger');
		assert.deepEqual(trigger.options.map((o) => o.value), TRIGGER_OPTIONS.map(([v]) => v), `${at}: trigger values`);
		assert.deepEqual(trigger.options.map((o) => o.label), TRIGGER_OPTIONS.map(([, l]) => l), `${at}: trigger labels`);
		for (const [cell, cls] of [[value, 'fp-val'], [thrust, 'fp-thrust'], [angle, 'fp-angle']]) {
			assert.equal(cell.tag, 'input', `${at}: ${cls} is an input`);
			assert.equal(cell.type, 'number', `${at}: ${cls} is type=number`);
			assert.equal(cell.className, cls);
		}
		assert.equal(action.tag, 'select');
		assert.equal(action.className, 'fp-action');
		assert.deepEqual(action.options.map((o) => [o.value, o.label]), ACTION_OPTIONS, `${at}: action options`);
		assert.equal(del.tag, 'button');
		assert.equal(del.type, 'button');
		assert.ok(del.className.split(/\s+/).includes('fp-del'), `${at}: delete button has class fp-del`);
		assert.equal(del.text, '✕');
	});
}

/** The launcher's flight plan, as plain data. */
function readModel(page) {
	return page.evaluate(() => JSON.parse(JSON.stringify(window.universe.RocketLauncher.flightProfile)));
}

/** Rendered rows must show exactly the model rows. */
async function assertTableShowsModel(page, label) {
	const rows = await readProfileTable(page);
	const model = await readModel(page);
	assert.equal(rows.length, model.length, `${label}: one table row per flight-plan step`);
	rows.forEach((row, i) => {
		const shown = row.cells.slice(0, 5).map((c) => c.value);
		const step = model[i];
		assert.deepEqual(shown, [step.type, String(step.value), String(step.thrust), String(step.angle), step.action || ''],
			`${label}: row ${i} shows its step`);
	});
	return { rows, model };
}

/** Layout of the Rocket tab at the 320 px sidebar width. */
function readLayout(page) {
	return page.evaluate(() => {
		const panel = document.getElementById('ctrl-panel');
		const tab = document.getElementById('tab-rocket');
		const table = document.getElementById('rl-flight-profile-table');
		panel.scrollLeft = 64;
		const scrolledLeft = panel.scrollLeft;
		panel.scrollLeft = 0;
		const tableRect = table.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();
		const overflowingControls = [...table.querySelectorAll('td')].filter((td) => {
			const el = td.firstElementChild;
			if (!el) { return false; }
			const a = td.getBoundingClientRect();
			const b = el.getBoundingClientRect();
			return b.left < a.left - 0.5 || b.right > a.right + 0.5;
		}).length;
		return {
			sidebarWidth: panel.offsetWidth,
			panel: { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth },
			tab: { scrollWidth: tab.scrollWidth, clientWidth: tab.clientWidth },
			table: { scrollWidth: table.scrollWidth, clientWidth: table.clientWidth },
			tableInsidePanel: tableRect.left >= panelRect.left && tableRect.right <= panelRect.left + panel.clientLeft + panel.clientWidth,
			scrolledLeft,
			overflowingControls,
			headerTexts: [...table.querySelectorAll('thead th')].map((th) => th.textContent),
			colWidths: [...table.querySelectorAll('colgroup col')].map((c) => c.style.width),
			headerPercents: [...table.querySelectorAll('thead th')].map((th) => th.getBoundingClientRect().width / tableRect.width * 100),
			tableLayout: getComputedStyle(table).tableLayout
		};
	});
}

function assertNoHorizontalOverflow(layout, label) {
	assert.equal(layout.sidebarWidth, 320, `${label}: sidebar is 320 px wide`);
	assert.ok(layout.panel.scrollWidth <= layout.panel.clientWidth, `${label}: sidebar scrollWidth ${layout.panel.scrollWidth} <= clientWidth ${layout.panel.clientWidth}`);
	assert.ok(layout.tab.scrollWidth <= layout.tab.clientWidth, `${label}: Rocket tab scrollWidth ${layout.tab.scrollWidth} <= clientWidth ${layout.tab.clientWidth}`);
	assert.ok(layout.table.scrollWidth <= layout.table.clientWidth, `${label}: table scrollWidth ${layout.table.scrollWidth} <= clientWidth ${layout.table.clientWidth}`);
	assert.equal(layout.tableInsidePanel, true, `${label}: the table fits inside the sidebar`);
	assert.equal(layout.scrolledLeft, 0, `${label}: the sidebar cannot scroll horizontally`);
	assert.equal(layout.overflowingControls, 0, `${label}: every control stays inside its cell`);
}

/** Rocket statistics panel must keep finite numbers. */
async function assertStatsFinite(page, label) {
	const stats = await page.evaluate(() => ['rl-stat-dv', 'rl-stat-twr-y', 'rl-stat-twr-x', 'rl-stat-total-mass']
		.map((id) => document.getElementById(id).textContent));
	for (const text of stats) {
		assert.ok(/^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(Number(text)), `${label}: stats value "${text}" is a finite number`);
	}
	return stats.map(Number);
}

/** Wait for the Worker prediction triggered by the last edit and check it is sane. */
async function assertPredictionValid(page, sinceRequestId, label) {
	await waitPredictionSettled(page, sinceRequestId);
	const s = await predictionSummary(page);
	assert.ok(s, `${label}: a prediction exists`);
	assert.ok(PREDICTION_END_REASONS.includes(s.endReason), `${label}: endReason ${s.endReason}`);
	assert.ok(s.points >= 2 && s.points <= MAX_PREDICTION_POINTS, `${label}: ${s.points} points`);
	assert.equal(s.allFinite, true, `${label}: finite coordinates`);
	assert.equal(s.strictlyIncreasing, true, `${label}: strictly increasing time`);
	assert.equal(s.maxSimTime, s.lastTime, `${label}: maxSimTime is the last point time`);
	return s;
}

describe('System E2E 02: Rocket tab flight profile table and thrust slider', { timeout: 240000 }, () => {
	/** @type {any} */
	let env = null;
	/** @type {import('./cdp_helpers.mjs').PageSession} */
	let page = null;

	before(async () => {
		env = await startE2E();
		page = env.page;
		await bootGravSim(env);
		await deployBody(page, 'put-earth-btn', 'Earth');
		await clickTab(page, 'tab-rocket');
	});

	after(async () => {
		if (env) { await env.close(); }
	});

	it('normal: the table has the 6 designed columns, controls, classes and options, showing the default ISS plan', async () => {
		const mark = page.mark();
		const layout = await readLayout(page);
		assert.deepEqual(layout.headerTexts, ['Trigger', 'Value', 'Thr(%)', 'Ang(°)', 'Action', '']);
		assert.deepEqual(layout.colWidths, COLUMN_WIDTHS);
		assert.equal(layout.tableLayout, 'fixed');
		layout.headerPercents.forEach((pct, i) => {
			assert.ok(Math.abs(pct - parseFloat(COLUMN_WIDTHS[i])) <= 0.25, `column ${i} is rendered at ${pct.toFixed(2)} % (design ${COLUMN_WIDTHS[i]})`);
		});

		const { rows, model } = await assertTableShowsModel(page, 'default plan');
		assertRowStructure(rows);
		assert.deepEqual(model.map((s) => [s.type, s.value, s.thrust, s.angle, s.action]),
			ISS_PROFILE.map(([value, angle]) => ['alt', value, 100, angle, '']), 'the default plan is the designed iss_rendezvous profile');
		assert.equal(await page.evaluate(() => window.universe.RocketLauncher.currentMissionId), 'iss_rendezvous');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: the 320 px sidebar shows the table without horizontal overflow', async () => {
		assertNoHorizontalOverflow(await readLayout(page), 'default plan');
	});

	it('normal: editing cells, adding and deleting rows update the launcher flight plan and the prediction', async () => {
		const mark = page.mark();
		let r0 = await predictorRequestId(page);
		for (const [value] of [['time'], ['vel'], ['apogee'], ['alt']]) {
			await page.selectOption('#rl-flight-profile-body tr:nth-child(2) .fp-trigger', value);
			assert.equal((await readModel(page))[1].type, value, `trigger ${value} is stored`);
		}
		await page.selectOption('#rl-flight-profile-body tr:nth-child(3) .fp-action', 'sep_stage1');
		await page.selectOption('#rl-flight-profile-body tr:nth-child(4) .fp-action', 'sep_payload');
		await page.typeInto('#rl-flight-profile-body tr:nth-child(2) .fp-val', '2500');
		await page.typeInto('#rl-flight-profile-body tr:nth-child(2) .fp-thrust', '80');
		await page.typeInto('#rl-flight-profile-body tr:nth-child(2) .fp-angle', '12.5');
		let model = await readModel(page);
		assert.deepEqual(model[1], { type: 'alt', value: 2500, thrust: 80, angle: 12.5, action: '' });
		assert.equal(model[2].action, 'sep_stage1');
		assert.equal(model[3].action, 'sep_payload');
		await assertTableShowsModel(page, 'after edits');
		await assertPredictionValid(page, r0, 'after edits');

		// Add a step: appended with the defaults
		r0 = await predictorRequestId(page);
		await page.click('#rl-add-profile-btn');
		model = await readModel(page);
		assert.equal(model.length, ISS_PROFILE.length + 1);
		assert.deepEqual(model[model.length - 1], DEFAULT_ROW);
		let rendered = await assertTableShowsModel(page, 'after add');
		assertRowStructure(rendered.rows);
		await assertPredictionValid(page, r0, 'after add');

		// Delete the 4th row: exactly that step disappears and the rest keep their order
		const beforeDelete = await readModel(page);
		r0 = await predictorRequestId(page);
		await page.click('#rl-flight-profile-body tr:nth-child(4) .fp-del');
		model = await readModel(page);
		assert.deepEqual(model, [...beforeDelete.slice(0, 3), ...beforeDelete.slice(4)]);
		rendered = await assertTableShowsModel(page, 'after delete');
		assertRowStructure(rendered.rows);
		await assertPredictionValid(page, r0, 'after delete');

		assertNoHorizontalOverflow(await readLayout(page), 'after edits');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('boundary: 0 rows, 1 row and many rows', async () => {
		const mark = page.mark();
		// Delete every row with its ✕ button; each click removes exactly one row
		let count = (await readModel(page)).length;
		let r0 = await predictorRequestId(page);
		while (count > 0) {
			if (count === 1) { r0 = await predictorRequestId(page); }
			await page.click('#rl-flight-profile-body tr:first-child .fp-del');
			const next = (await readModel(page)).length;
			assert.equal(next, count - 1, 'one row removed per click');
			assert.equal((await readProfileTable(page)).length, next);
			count = next;
		}
		assert.deepEqual(await readModel(page), [], '0 rows: empty flight plan');
		assert.equal(await page.evaluate(() => document.querySelectorAll('#rl-flight-profile-body tr').length), 0);
		await assertStatsFinite(page, '0 rows');
		// The empty plan still yields a prediction (requested by the last deletion)
		await assertPredictionValid(page, r0, '0 rows');
		assertNoHorizontalOverflow(await readLayout(page), '0 rows');

		// 1 row
		r0 = await predictorRequestId(page);
		await page.click('#rl-add-profile-btn');
		assert.deepEqual(await readModel(page), [DEFAULT_ROW], '1 row: the default step');
		let rendered = await assertTableShowsModel(page, '1 row');
		assertRowStructure(rendered.rows);
		const stats = await assertStatsFinite(page, '1 row');
		assert.equal(stats[2], 0, '1 row at 0 deg: no horizontal TWR component');
		await assertPredictionValid(page, r0, '1 row');

		// Many rows
		const MANY = 40;
		for (let i = 1; i < MANY; i++) {
			await page.click('#rl-add-profile-btn');
		}
		r0 = await predictorRequestId(page);
		await page.typeInto(`#rl-flight-profile-body tr:nth-child(${MANY}) .fp-angle`, '45');
		const model = await readModel(page);
		assert.equal(model.length, MANY, `${MANY} rows`);
		assert.deepEqual(model.slice(0, MANY - 1), Array.from({ length: MANY - 1 }, () => DEFAULT_ROW));
		assert.deepEqual(model[MANY - 1], { ...DEFAULT_ROW, angle: 45 });
		rendered = await assertTableShowsModel(page, `${MANY} rows`);
		assertRowStructure(rendered.rows);
		assertNoHorizontalOverflow(await readLayout(page), `${MANY} rows`);
		await assertStatsFinite(page, `${MANY} rows`);
		await assertPredictionValid(page, r0, `${MANY} rows`);

		// Restore the designed plan from the mission selector
		r0 = await predictorRequestId(page);
		await page.selectOption('#rl-mission-select', 'iss_rendezvous');
		assert.equal((await readModel(page)).length, ISS_PROFILE.length, 'selecting the mission restores its plan');
		await assertPredictionValid(page, r0, 'restored plan');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('abnormal: empty, negative, non-numeric and out-of-range values in the inputs raise no exception', async () => {
		const mark = page.mark();
		// [typed text, value shown by the number input, value stored in the plan]
		const cases = [
			['', '', 0],
			['-500', '-500', -500],
			['abc', '', 0],
			['1e', '', 0],
			['--3', '', 0],
			['1e400', '', 0],
			['-0.0001', '-0.0001', -0.0001],
			['999999999', '999999999', 999999999]
		];
		const fields = [['fp-val', 'value'], ['fp-thrust', 'thrust'], ['fp-angle', 'angle']];
		for (const [cls, key] of fields) {
			const selector = `#rl-flight-profile-body tr:nth-child(3) .${cls}`;
			for (const [typed, shown, stored] of cases) {
				// Start each case from a valid value so the change event always fires
				await page.typeInto(selector, '123');
				assert.equal((await readModel(page))[2][key], 123);
				const r0 = await predictorRequestId(page);
				await page.typeInto(selector, typed);
				const domValue = await page.evaluate((sel) => document.querySelector(sel).value, selector);
				const step = (await readModel(page))[2];
				assert.equal(domValue, shown, `${cls} "${typed}": input shows "${shown}"`);
				assert.equal(step[key], stored, `${cls} "${typed}": plan stores ${stored}`);
				assert.ok(Number.isFinite(step.value) && Number.isFinite(step.thrust) && Number.isFinite(step.angle), `${cls} "${typed}": the step stays finite`);
				await assertStatsFinite(page, `${cls} "${typed}"`);
				await assertPredictionValid(page, r0, `${cls} "${typed}"`);
				assert.deepEqual(unexpectedProblems(page, mark), [], `${cls} "${typed}": no exception or console error`);
			}
		}

		// The inconsistent plan can still be rolled out and aborted safely
		await page.typeInto('#rl-flight-profile-body tr:nth-child(3) .fp-val', '-500');
		await page.typeInto('#rl-flight-profile-body tr:nth-child(4) .fp-thrust', '250');
		await page.typeInto('#rl-flight-profile-body tr:nth-child(5) .fp-angle', '-720');
		await page.click('#rl-rollout-btn');
		await page.waitFor(() => window.universe.RocketLauncher.rolloutedRocketId !== null, { description: 'rollout' });
		const onPad = await page.evaluate(() => {
			const r = window.universe.objects.find((o) => o.id === window.universe.RocketLauncher.rolloutedRocketId);
			return { plan: r.flightProfile.slice(2, 5).map((s) => [s.value, s.thrust, s.angle]), points: r.predictedTrajectory?.points?.length, inputsDisabled: [...document.querySelectorAll('#rl-flight-profile-body input, #rl-flight-profile-body select, #rl-flight-profile-body button')].every((el) => el.disabled) };
		});
		assert.deepEqual(onPad.plan[0][0], -500);
		assert.equal(onPad.plan[1][1], 250);
		assert.equal(onPad.plan[2][2], -720);
		assert.ok(onPad.points >= 2, 'the rolled-out rocket carries a prediction');
		assert.equal(onPad.inputsDisabled, true, 'the table is locked while on the pad');
		await page.click('#rl-abort-btn');
		await page.waitFor(() => !window.universe.objects.some((o) => o.type === 1), { description: 'abort removes the rocket' });
		assert.deepEqual(unexpectedProblems(page, mark), []);

		const r0 = await predictorRequestId(page);
		await page.selectOption('#rl-mission-select', 'iss_rendezvous');
		await assertPredictionValid(page, r0, 'restored plan');
	});

	it('boundary: launch-thrust slider max is 10000 kN, raised to the stage thrust for heavier stages and kept on stage-tab and fuel-type changes', async () => {
		const mark = page.mark();
		const readThrust = () => page.evaluate(() => {
			const rl = window.universe.RocketLauncher;
			const el = document.getElementById('rl-launch-thrust');
			return { value: el.value, max: el.max, min: el.min, label: document.getElementById('rl-launch-thrust-val').textContent, stage0: rl.stages[0].thrustKN, launcher: rl.thrustKN, vehicle: rl.currentVehicleId };
		});

		await page.selectOption('#rl-vehicle-select', 'h3_30');
		let t = await readThrust();
		// The slider steps by 1 kN from 1 kN (design §4.14-4; it stepped by 50 kN from 100 kN and showed 4410 kN at 4400, the
		// HTML value sanitization), so it holds the exact 4410 kN like the label and the stage
		const snapped = (kN) => String(kN);
		assert.deepEqual(t, { value: snapped(4410), max: '10000', min: '1', label: '4410', stage0: 4410, launcher: 4410, vehicle: 'h3_30' });

		await page.focus('#rl-launch-thrust');
		await page.pressKey('End');
		assert.deepEqual(await readThrust(), { ...t, value: '10000', label: '10000', stage0: 10000, launcher: 10000 }, 'End reaches max = 10000');
		await page.pressKey('ArrowRight');
		assert.equal((await readThrust()).value, '10000', 'cannot exceed the max');
		await page.pressKey('ArrowLeft');
		t = await readThrust();
		assert.deepEqual([t.value, t.stage0], ['9999', 9999], 'one step (1 kN) below the max');
		await page.pressKey('Home');
		t = await readThrust();
		assert.deepEqual([t.value, t.label, t.stage0], ['1', '1', 1], 'Home reaches the minimum');

		// Heavier first stage: max = ceil(thrustKN)
		await page.selectOption('#rl-vehicle-select', 'h3_24');
		t = await readThrust();
		assert.deepEqual([t.value, t.max, t.label, t.stage0, t.vehicle], ['11500', '11500', '11500', 11500, 'h3_24']);
		await page.focus('#rl-launch-thrust');
		await page.pressKey('End');
		await page.pressKey('ArrowRight');
		t = await readThrust();
		assert.deepEqual([t.value, t.max, t.stage0], ['11500', '11500', 11500], 'max follows the heavier stage');

		// Stage tabs (selectTab sync)
		const tabs = await page.evaluate(() => [...document.querySelectorAll('#rl-stage-tabs button')].map((b) => b.textContent));
		assert.deepEqual(tabs, ['Stage 1', 'Stage 2', 'Payload']);
		await page.click('#rl-stage-tabs button:nth-child(2)');
		t = await readThrust();
		const stage1Thrust = await page.evaluate(() => window.universe.RocketLauncher.stages[1].thrustKN);
		assert.deepEqual([t.value, t.max, t.label], [snapped(stage1Thrust), '10000', String(stage1Thrust)], 'stage 2 uses the base max');
		await page.click('#rl-stage-tabs button:nth-child(1)');
		t = await readThrust();
		assert.deepEqual([t.value, t.max], ['11500', '11500'], 'back on stage 1 the raised max returns');

		// Fuel-type change keeps the thrust and the raised max (G2-05)
		await page.selectOption('#rl-fuel-type', 'liquid');
		t = await readThrust();
		assert.deepEqual([t.value, t.max, t.stage0], ['11500', '11500', 11500], 'fuel change does not lower the thrust');
		assert.equal(await page.evaluate(() => window.universe.RocketLauncher.stages[0].fuelType), 'liquid');
		await page.selectOption('#rl-fuel-type', 'hydro');
		t = await readThrust();
		assert.deepEqual([t.value, t.max, t.stage0], ['11500', '11500', 11500]);

		await page.click('#rl-stage-tabs button:nth-child(3)');
		assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.getElementById('rl-stage-config-panel')).display, getComputedStyle(document.getElementById('rl-payload-config-panel')).display]),
			['none', 'block'], 'the payload tab hides the stage sliders');
		await page.click('#rl-stage-tabs button:nth-child(1)');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal / boundary (§4.14-4): the stage and payload sliders hold the sized values exactly (deep-space 0.1 t / 1 kN, the smallest stage, 0.01 t payload), and a key moves by one such step', async () => {
		const mark = page.mark();
		const before = await page.evaluate(() => { const rl = window.universe.RocketLauncher; return [rl.currentPayloadId, rl.currentMissionId, rl.currentVehicleId]; });
		const choose = async (payload, mission, vehicle) => {
			await page.selectOption('#rl-payload-select', payload);
			await page.selectOption('#rl-mission-select', mission);
			await page.selectOption('#rl-vehicle-select', vehicle);
		};
		/** Slider value, its label and the launcher's value, for the stage tab shown (or the payload tab). */
		const readStage = () => page.evaluate(() => {
			const rl = window.universe.RocketLauncher;
			const stg = rl.stages[window.universe.ControlPanel.rocketTab.currentTab];
			const v = (id) => [document.getElementById(id).value, document.getElementById(`${id}-val`).textContent];
			return { fuel: [...v('rl-fuel-mass'), stg.fuelMassT], oxid: [...v('rl-oxid-mass'), stg.oxidMassT], dry: [...v('rl-launch-mass'), stg.dryMassT], thrust: [...v('rl-launch-thrust'), stg.thrustKN] };
		});
		const exact = (row, what) => assert.deepEqual(row.slice(0, 2), [String(row[2]), String(row[2])], `${what}: the slider and its label hold ${row[2]}`);

		// H3-30 + HTV-X on the Mars transfer: the deep-space sizing (§3.4-3) of the upper stage
		await choose('htv_x', 'mars_transfer', 'h3_30');
		await page.click('#rl-stage-tabs button:nth-child(2)');
		let t = await readStage();
		assert.deepEqual([t.fuel[2], t.oxid[2], t.thrust[2]], [15.1, 90.8, 1113], 'input: the sized upper stage');
		for (const k of ['fuel', 'oxid', 'dry', 'thrust']) { exact(t[k], `stage 2 ${k}`); }
		await page.click('#rl-stage-tabs button:nth-child(1)');
		t = await readStage();
		for (const k of ['fuel', 'oxid', 'dry', 'thrust']) { exact(t[k], `stage 1 ${k}`); }
		// One key step: 0.1 t of fuel (the oxidizer follows the O/F ratio 6 of presets/fuels/hydro.json), 1 kN of thrust
		await page.click('#rl-stage-tabs button:nth-child(2)');
		await page.focus('#rl-fuel-mass');
		await page.pressKey('ArrowRight');
		t = await readStage();
		assert.deepEqual([t.fuel, t.oxid.slice(0, 1), t.oxid[2]], [['15.2', '15.2', 15.2], ['91.2'], 91.2], 'fuel +0.1 t, oxidizer 15.2 x 6');
		await page.focus('#rl-launch-thrust');
		await page.pressKey('ArrowLeft');
		t = await readStage();
		assert.deepEqual(t.thrust, ['1112', '1112', 1112], 'thrust -1 kN');

		// Epsilon stage 3: 0.8 t dry and 85 kN, below the former minimum (1 t / 100 kN)
		await choose('asnaro_2', 'leo_250km', 'epsilon');
		await page.click('#rl-stage-tabs button:nth-child(3)');
		t = await readStage();
		assert.deepEqual([t.dry[2], t.thrust[2]], [0.8, 85], 'input: Epsilon stage 3');
		for (const k of ['fuel', 'dry', 'thrust']) { exact(t[k], `Epsilon stage 3 ${k}`); }

		// SSTO + HTV-X on the ISS plan: payload 4.93 t and its propellant 0.14 / 0.29 t (0.01 t)
		await choose('htv_x', 'iss_rendezvous', 'ssto');
		await page.click('#rl-stage-tabs button:nth-child(2)');
		const p = await page.evaluate(() => {
			const rl = window.universe.RocketLauncher;
			const v = (id) => document.getElementById(id).value;
			return { mass: [v('rl-payload-mass'), rl.payload.massT], fuel: [v('rl-payload-fuel'), rl.payload.propulsion.fuelMassT], oxid: [v('rl-payload-oxid'), rl.payload.propulsion.oxidMassT] };
		});
		assert.deepEqual([p.mass[1], p.fuel[1], p.oxid[1]], [4.93, 0.14, 0.29], 'input: the sized payload');
		for (const k of ['mass', 'fuel', 'oxid']) { assert.equal(p[k][0], String(p[k][1]), `payload ${k} slider holds ${p[k][1]}`); }

		await page.click('#rl-stage-tabs button:nth-child(1)');
		await choose(...before);
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal / boundary: choosing a mission shows its prediction period on the System-tab slider (0.2 to 36 months)', async () => {
		const mark = page.mark();
		const monthsOf = (id) => JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'presets', 'missions', `${id}.json`), 'utf8')).predictionDurationMonths;
		// [mission, expected label]: the slider minimum (LEO), an in-between value, the year format and the slider maximum
		const cases = [['leo_250km', '0.2 mo (6 d)'], ['iss_rendezvous', '0.3 mo (9 d)'], ['mars_transfer', '1.0 yr (12 mo)'], ['jupiter_transfer', '3.0 yr (36 mo)']];
		for (const [mission, label] of cases) {
			const months = monthsOf(mission);
			await clickTab(page, 'tab-rocket');
			const r0 = await predictorRequestId(page);
			await page.selectOption('#rl-mission-select', mission);
			await waitPredictionSettled(page, r0);
			await clickTab(page, 'tab-sys');
			const shown = await page.evaluate(() => ({
				value: document.getElementById('pred-duration').value,
				label: document.getElementById('pred-duration-val').textContent,
				months: window.universe.RocketLauncher.predictionDurationMonths,
				sec: window.universe.RocketLauncher.maxSimTimeSec
			}));
			assert.deepEqual(shown, { value: String(months), label, months, sec: months * SECONDS_PER_MONTH }, `${mission}: slider, label and launcher period`);
		}
		await clickTab(page, 'tab-rocket');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal: closing the Rocket tab restores the time scale, the zoom and the camera target from before it opened (also after a second click on the open tab)', async () => {
		const mark = page.mark();
		// System-tab view: slider positions, indicators, the values in use and the camera target
		const readView = (p) => p.evaluate(() => ({
			time: document.getElementById('time-scale').value,
			timeText: document.getElementById('time-scale-indicator').textContent,
			timeScale: window.universe.timeScale,
			zoom: document.getElementById('zoom-scale').value,
			zoomText: document.getElementById('zoom-scale-indicator').textContent,
			zoomExp: window.universe.camera.targetZoomExp,
			tracking: window.universe.camera.trackingTarget?.name,
			offset: { ...window.universe.camera.targetOffset }
		}));
		await clickTab(page, 'tab-sys');
		// A view that is none of the tab's own (index.html #time-scale min -7.5, step 0.1; #zoom-scale step 0.05)
		assert.equal(await setRangeByKeys(page, '#time-scale', -4), -4);
		assert.equal(await setRangeByKeys(page, '#zoom-scale', 1.5), 1.5);
		await page.selectOption('#center-select', '0');
		await page.waitFor(() => window.universe.camera.trackingTarget?.name === 'Sun', { description: 'the camera tracks the Sun' });
		const before = await readView(page);
		assert.deepEqual({ time: before.time, timeScale: before.timeScale, zoom: before.zoom, zoomExp: before.zoomExp, tracking: before.tracking },
			{ time: '-4', timeScale: Math.pow(10, -4), zoom: '1.5', zoomExp: 1.5, tracking: 'Sun' });

		await clickTab(page, 'tab-rocket');
		const inTab = await readView(page);
		assert.equal(inTab.time, '-7.5', 'the Rocket tab sets the minimum time scale');
		assert.equal(inTab.tracking, 'Earth', 'the Rocket tab tracks the host');
		assert.notEqual(inTab.zoomExp, before.zoomExp, 'the Rocket tab fits the zoom to the host');
		// A second click on the open tab runs open() again: it must not replace the values to restore with its own
		await clickTab(page, 'tab-rocket');
		await clickTab(page, 'tab-sys');
		assert.deepEqual(await readView(page), before, 'closing restores the view from before the tab opened (design §4.13-10, fixed: it restored the tab\'s minimum time scale, its zoom and the host)');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('normal (§4.13-31): the rocket of a full countdown removed 1.5 s before WATER DELUGE: the sequence aborts, no deluge, the Rocket tab is back to Rollout', async () => {
		const mark = page.mark();
		await clickTab(page, 'tab-rocket');
		await page.click('#rl-rollout-btn');
		await page.waitFor(() => window.universe.RocketLauncher.rolloutedRocketId !== null, { description: 'rollout' });
		const rocketId = await page.evaluate(() => window.universe.RocketLauncher.rolloutedRocketId);
		await page.click('#rl-ignite-full-btn');
		await page.waitFor(() => window.universe.LaunchSequencer.isActive, { description: 'the full countdown runs' });
		// The sequence clock jumps to 1.5 s before WATER DELUGE (input: LAUNCH_SEQUENCES.FULL_COUNTDOWN); the full 95 s
		// of real time would not fit the time budget of the file
		const delugeTime = await page.evaluate(async () => {
			const { LAUNCH_SEQUENCES } = await import('/scripts/gravsim_const.js');
			const t = LAUNCH_SEQUENCES.FULL_COUNTDOWN.events.find((e) => e.command === 'WATER_DELUGE').time;
			window.universe.LaunchSequencer.timer = t - 1.5;
			return t;
		});
		await page.waitFrames(3);
		assert.deepEqual(await page.evaluate(() => [window.universe.LaunchSequencer.isActive, window.universe.SoundEffects.isDelugeTriggered]), [true, false], 'input: before the deluge');
		// System › Clear Selected › rockets. The tabs are locked during a countdown, so the click goes to the button itself
		// (a user meets the same 'rocket:destroyed' when a collision destroys the rocket on the pad)
		const clearedAt = await page.evaluate(() => {
			for (const [id, on] of [['clear-debris-chk', false], ['clear-rocket-chk', true], ['clear-celestial-chk', false]]) {
				document.getElementById(id).checked = on;
			}
			document.getElementById('clear-selected-btn').click();
			return performance.now();
		});
		// On past the deluge's time (real time: 1 s per s; the sequence clock was 1.5 s before it)
		await page.waitFor((t0) => performance.now() > t0 + 3000, { args: [clearedAt], timeoutMs: 10000, description: '3 s after the removal' });
		assert.ok(delugeTime > 1.5, 'input');
		const after = await page.evaluate((id) => {
			const r = window.universe.objects.find((o) => o.id === id);
			const se = window.universe.SoundEffects;
			const tabLocked = Array.from(document.querySelectorAll('.tab-btn')).some((b) => b.disabled);
			return {
				rocket: r ? { state: r.state, isDestroyed: r.isDestroyed } : 'gone',
				sequence: window.universe.LaunchSequencer.isActive,
				deluge: { triggered: se.isDelugeTriggered, running: Boolean(se.voices.waterDeluge?.isRunning) },
				pad: window.universe.RocketLauncher.rolloutedRocketId,
				rolloutBtn: getComputedStyle(document.getElementById('rl-rollout-btn')).display,
				ignition: getComputedStyle(document.getElementById('rl-ignition-group')).display,
				countdown: getComputedStyle(document.getElementById('countdown-display')).display,
				tabLocked
			};
		}, rocketId);
		assert.ok(after.rocket === 'gone' || (after.rocket.state === 1 && after.rocket.isDestroyed), `the rocket was removed (${JSON.stringify(after.rocket)})`);
		assert.deepEqual({ ...after, rocket: undefined }, {
			rocket: undefined, sequence: false, deluge: { triggered: false, running: false }, pad: null,
			rolloutBtn: 'block', ignition: 'none', countdown: 'none', tabLocked: false
		}, 'the countdown ran on and started the deluge for the empty pad before');
		await clickTab(page, 'tab-sys');
		assert.deepEqual(unexpectedProblems(page, mark), []);
	});

	it('the whole session produced no exceptions, console errors or dialogs', () => {
		assert.deepEqual(page.problems(), []);
		assert.deepEqual(page.dialogs, []);
	});
});
