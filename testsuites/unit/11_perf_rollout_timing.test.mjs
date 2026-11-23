/**
 * Unit Test Suite 11: rollout() block-time harness (testsuites/perf/rollout_timing.mjs)
 *
 * Expected values are derived from docs/design/2026-11-20_trajectory_fx_flightplan.md §4.12 (configurations, acceptance
 * criteria 1 and 2, rounds and order, load condition, statistic, margin and its variation, split runs) and from the
 * harness header (exit codes, state-file rules: rounds are saved and resumed, an unmet load condition is answered by
 * adding rounds, fingerprints refuse mixing rounds measured on different code, incomplete rounds are errors).
 * No real timing is measured: rounds are synthetic, and the measuring loop runs on fake trees whose modules are mocks
 * (ROLLOUT_TIMING_TEST_LOAD fixes the load samples there).
 * Each group covers normal, abnormal (missing / mismatched / malformed input) and boundary cases.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	requiredRounds, roundOrder, statistic, expectedKeys, checkRound, evaluateWorld, formatWorld, treeFingerprint,
	harnessFingerprint, loadState, saveState, LOAD_LIMIT, RATIO_LIMIT, ABS_LIMIT_MS, WORLDS
} from '../perf/rollout_timing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(REPO, 'testsuites', 'perf', 'rollout_timing.mjs');

/** One synthetic round with chosen configurations: [key, curMs, baseMs] (key "m|mo|az"), loads before each tree. */
const mkRound = (configs, loads = [1, 1]) => {
	const split = (k, ms) => { const [m, mo, az] = k.split('|'); return { m, mo: Number(mo), az: Number(az), ms }; };
	return { loads, cur: configs.map(([k, c]) => split(k, c)), base: configs.map(([k, , b]) => split(k, b)) };
};
const K1 = 'leo_250km|0.2|0';
const K2 = 'lunar_insertion|0.2|90';

/** §4.12: near-host missions use their default period plus 0.2/0.5/1/12/36 months, deep-space missions plus 0.2/1/36. */
const DESIGN_MISSIONS = [
	['leo_250km', 0.2, true], ['iss_rendezvous', 0.3, true], ['gto_insertion', 0.5, true], ['lunar_insertion', 1, true],
	['mars_transfer', 12, false], ['jupiter_transfer', 36, false], ['solar_escape', 36, false]
];
const designKeys = (azs) => DESIGN_MISSIONS.flatMap(([m, def, near]) =>
	[...new Set([def, ...(near ? [0.2, 0.5, 1, 12, 36] : [0.2, 1, 36])])].flatMap(mo => azs.map(az => `${m}|${mo}|${az}`)));
const entry = (k, ms) => { const [m, mo, az] = k.split('|'); return { m, mo: Number(mo), az: Number(az), ms }; };

/** A complete round r (all 31 configurations per azimuth), with the §4.12 order (this tree first on even rounds). */
const fullRound = (r, { cur = 120, base = 100, loads = [1, 1], azs = [0] } = {}) => {
	const keys = designKeys(azs);
	return {
		order: r % 2 === 0 ? ['cur', 'base'] : ['base', 'cur'], loads,
		cur: keys.map(k => entry(k, cur)), base: keys.map(k => entry(k, base))
	};
};
const fullRounds = (n, opts) => Array.from({ length: n }, (_, r) => fullRound(r, opts));

/** Minimal tree that the fingerprint reads. */
const mkTree = (root) => {
	fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
	fs.mkdirSync(path.join(root, 'presets', 'missions'), { recursive: true });
	fs.mkdirSync(path.join(root, 'testsuites'), { recursive: true });
	fs.writeFileSync(path.join(root, 'scripts', 'gravsim_calc_predictor.js'), 'export const a = 1;\n');
	fs.writeFileSync(path.join(root, 'scripts', 'gravsim_calc.js'), 'export const b = 2;\n');
	fs.writeFileSync(path.join(root, 'presets', 'missions', 'leo_250km.json'), '{"id":"leo_250km"}\n');
	fs.writeFileSync(path.join(root, 'testsuites', 'test_helpers.mjs'), 'export const h = 3;\n');
	return root;
};

/** A copy of the harness at <root>/testsuites/perf/rollout_timing.mjs, with optional [from, to] source edits. */
const copyHarness = (root, edits = []) => {
	let src = fs.readFileSync(HARNESS, 'utf8');
	for (const [from, to] of edits) {
		assert.equal(src.split(from).length, 2, `edit anchor must occur once: ${from}`);
		src = src.replace(from, to);
	}
	const file = path.join(root, 'testsuites', 'perf', 'rollout_timing.mjs');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, src);
	return file;
};

/**
 * A tree whose modules are mocks, so the child measures 31 configurations in milliseconds. Each child appends
 * "<tree name> <--world>" to $FAKE_LOG and adds 1 to the number in $FAKE_LOAD_FILE; FAKE_STOP_AFTER and FAKE_EXTRA
 * inject faults into the child's output.
 */
const mkFakeTree = (root, name) => {
	const files = {
		'testsuites/test_helpers.mjs': 'export function setupMockDOM() {}\nexport function createMockUniverse() { return {}; }\n',
		'scripts/gravsim_calc_predictor.js': 'export {};\n',
		'scripts/gravsim_calc.js': 'export class PhysicsEngine { addObject() {} updateObject() {} removeObject() {} }\n',
		'scripts/gravsim_object_manager.js': 'export class ObjectManager { constructor() { this.objects = []; } }\n',
		'scripts/gravsim_object_placer.js': [
			'let nextId = 1;',
			'export class ObjectPlacer {',
			'\tconstructor(universe) { this.universe = universe; }',
			'\tplaceObject(name) { const o = { id: nextId++, name }; this.universe.objects.push(o); return o; }',
			"\tdeployProfile(name) { this.placeObject(name === 'THREE_BODY' ? 'Earth (Trisolaris)' : 'Earth'); }",
			'}', ''
		].join('\n'),
		'scripts/gravsim_rocket_launcher.js': [
			"import fs from 'node:fs';",
			"const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };",
			`if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, ${JSON.stringify(name)} + ' ' + arg('--world') + '\\n');`,
			'if (process.env.FAKE_LOAD_FILE) {',
			"\tfs.writeFileSync(process.env.FAKE_LOAD_FILE, String(Number(fs.readFileSync(process.env.FAKE_LOAD_FILE, 'utf8')) + 1));",
			'}',
			'let calls = 0;',
			'export class RocketLauncher {',
			'\trollout() {',
			'\t\tcalls++;',
			'\t\tif (Number(process.env.FAKE_STOP_AFTER) >= 0 && calls > Number(process.env.FAKE_STOP_AFTER)) process.exit(0);',
			"\t\tif (process.env.FAKE_EXTRA && calls === 1) process.stdout.write(JSON.stringify({ m: 'extra', mo: 1, az: 0, ms: 1 }) + '\\n');",
			'\t\tconst t = performance.now();',
			'\t\twhile (performance.now() - t < 0.02) { /* a measurable, positive time */ }',
			'\t}',
			'}', ''
		].join('\n'),
		'scripts/gravsim_worker_bridge.js': 'export const WorkerBridge = { recycleBuffer() {} };\n',
		'scripts/gravsim_preset_manager.js': 'export const presetManager = { applyToLauncher() {}, getObjectParam() { return null; } };\n',
		'scripts/gravsim_event_bus.js': 'export const EventBus = { clearAll() {} };\n',
		'scripts/gravsim_const.js': 'export const PHYSICS = { METERS_PER_AU: 1.495978707e11 };\n',
		'scripts/gravsim_utils.js': 'export const UnitConvertUtils = { m2pix: (m) => m / 1e6 };\n'
	};
	for (const [rel, src] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), src);
	}
	fs.mkdirSync(path.join(root, 'presets'), { recursive: true });
	return root;
};

/**
 * spawnSync of node with a time limit. spawnSync blocks the event loop, so the test runner's own timeout cannot stop a
 * hung child; the limit makes a hang fail the test (ETIMEDOUT) instead of stopping `npm test`.
 */
const SPAWN_TIMEOUT_MS = 60000;
const spawnNode = (args, opts = {}) => {
	const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts });
	if (r.error) throw r.error;
	return r;
};

const readState = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const roundLines = (stderr) => stderr.split('\n').filter(l => /round \d+ done/.test(l));

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-timing-unit-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('Test helpers', () => {
	it('fails a hung child with ETIMEDOUT instead of waiting for it', () => {
		assert.equal(SPAWN_TIMEOUT_MS, 60000);
		const t0 = Date.now();
		assert.throws(() => spawnNode(['-e', 'setTimeout(() => {}, 30000)'], { timeout: 300 }), { code: 'ETIMEDOUT' });
		assert.ok(Date.now() - t0 < 10000);
		assert.equal(spawnNode(['-e', 'process.stdout.write("ok")']).stdout, 'ok');
	});
});

describe('Rounds and order (§4.12)', () => {
	it('alternates the tree order every round, this tree first on even rounds', () => {
		assert.deepEqual(roundOrder(0), ['cur', 'base']);
		assert.deepEqual(roundOrder(1), ['base', 'cur']);
		assert.deepEqual(roundOrder(2), ['cur', 'base']);
		assert.deepEqual(roundOrder(7), ['base', 'cur']);
	});

	it('requires the heavy count for Sun+Earth and the 7-body world, the light count for the others', () => {
		assert.deepEqual(WORLDS, ['SE', 'W7', 'SS', 'BIN', 'TB']);
		assert.equal(requiredRounds('SE', 6, 3), 6);
		assert.equal(requiredRounds('W7', 8, 3), 8);
		for (const w of ['SS', 'BIN', 'TB']) assert.equal(requiredRounds(w, 6, 4), 4);
		assert.equal(LOAD_LIMIT, 2.0);
		assert.equal(RATIO_LIMIT, 1.5);
		assert.deepEqual(ABS_LIMIT_MS, { SE: 1000, W7: 2000 });
	});
});

describe('Configurations and complete rounds (§4.12)', () => {
	it('expects the 124 configurations of §4.12 for four azimuths (31 per azimuth), each once', () => {
		const keys = expectedKeys('0,90,180,270');
		assert.equal(keys.length, 124);
		assert.equal(new Set(keys).size, 124);
		assert.deepEqual(new Set(keys), new Set(designKeys([0, 90, 180, 270])));
		assert.deepEqual(expectedKeys('0'), designKeys([0]));
		assert.equal(expectedKeys('0,90').length, 62);
	});

	it('accepts a complete round, including a time of exactly 0 ms, and rejects the wrong order for its number', () => {
		const ok = fullRound(0);
		assert.doesNotThrow(() => checkRound(ok, 0, expectedKeys('0')));
		ok.cur[0].ms = 0;
		assert.doesNotThrow(() => checkRound(ok, 0, expectedKeys('0')));
		assert.doesNotThrow(() => checkRound(fullRound(1), 1, expectedKeys('0')));
		assert.throws(() => checkRound(fullRound(0), 1, expectedKeys('0')), /^Error: round 2 has order \["cur","base"\], expected \["base","cur"\]$/);
		assert.throws(() => checkRound({ ...fullRound(0), order: undefined }, 0, expectedKeys('0')), /round 1 has order/);
		for (const bad of [null, 'x', 3]) assert.throws(() => checkRound(bad, 0, expectedKeys('0')), /round 1 is not an object/);
	});

	it('rejects load samples that are not two finite non-negative numbers', () => {
		for (const loads of [[1], [1, 1, 1], [1, NaN], [Infinity, 1], [-0.1, 1], ['1', 1], undefined, {}]) {
			assert.throws(() => checkRound({ ...fullRound(0), loads }, 0, expectedKeys('0')), /round 1 needs two finite non-negative load samples/);
		}
		assert.doesNotThrow(() => checkRound({ ...fullRound(0), loads: [0, 0] }, 0, expectedKeys('0')));
	});

	it('rejects a missing, unexpected or duplicate configuration and an invalid time, for either tree', () => {
		const keys = expectedKeys('0');
		const missing = fullRound(0);
		missing.base.splice(5, 1);
		assert.throws(() => checkRound(missing, 0, keys), new RegExp(`round 1 base: 1 of 31 configurations missing \\(first: ${keys[5].replace(/[|.]/g, '\\$&')}\\)`));
		const extra = fullRound(0);
		extra.cur.push(entry('leo_250km|0.2|90', 1));
		assert.throws(() => checkRound(extra, 0, keys), /round 1 cur: unexpected configuration leo_250km\|0\.2\|90/);
		const dup = fullRound(0);
		dup.cur[3] = { ...dup.cur[2] };
		assert.throws(() => checkRound(dup, 0, keys), /round 1 cur: duplicate configuration/);
		for (const ms of [NaN, -1, '5', Infinity, undefined, null]) {
			const bad = fullRound(0);
			bad.base[0].ms = ms;
			assert.throws(() => checkRound(bad, 0, keys), /round 1 base: invalid time for leo_250km\|0\.2\|0/);
		}
		const nul = fullRound(0);
		nul.cur[0] = null;
		assert.throws(() => checkRound(nul, 0, keys), /round 1 cur: unexpected configuration null/);
		assert.throws(() => checkRound({ ...fullRound(0), base: undefined }, 0, keys), /round 1 has no base measurements/);
		assert.throws(() => checkRound({ ...fullRound(0), cur: [] }, 0, keys), /round 1 cur: 31 of 31 configurations missing/);
	});
});

describe('statistic: ratio of the per-configuration minimums', () => {
	it('takes the minimum of each tree over the rounds, then the ratio (not the minimum of per-round ratios)', () => {
		const rounds = [mkRound([[K1, 100, 100]]), mkRound([[K1, 90, 60]])];
		const s = statistic(rounds, [0, 1]);
		assert.equal(s.maxRatio, 90 / 60);
		assert.equal(s.maxRatioKey, K1);
		assert.equal(s.maxAbs, 90);
	});

	it('uses only the selected rounds', () => {
		const rounds = [mkRound([[K1, 100, 100]]), mkRound([[K1, 90, 60]])];
		assert.equal(statistic(rounds, [0]).maxRatio, 1);
		assert.equal(statistic(rounds, [1]).maxRatio, 1.5);
	});

	it('reports the configuration with the largest ratio and, separately, the largest minimum of this tree', () => {
		const s = statistic([mkRound([[K1, 120, 100], [K2, 900, 1000]])], [0]);
		assert.equal(s.maxRatio, 1.2);
		assert.equal(s.maxRatioKey, K1);
		assert.equal(s.maxAbs, 900);
		assert.equal(s.maxAbsKey, K2);
	});

	it('counts a configuration without a positive baseline as an infinite ratio; criterion 2 is this tree alone', () => {
		// §4.12: criterion 1 covers all configurations, so one whose ratio cannot be formed cannot pass it.
		const zero = statistic([mkRound([[K2, 80, 100], [K1, 50, 0]])], [0]);
		assert.equal(zero.maxRatio, Infinity);
		assert.equal(zero.maxRatioKey, K1);
		const r = mkRound([[K2, 80, 100]]);
		r.cur.push({ m: 'solar_escape', mo: 36, az: 0, ms: 5000 });
		const missing = statistic([r], [0]);
		assert.equal(missing.maxRatio, Infinity);
		assert.equal(missing.maxRatioKey, 'solar_escape|36|0');
		assert.equal(missing.maxAbs, 5000, '§4.12: criterion 2 is the maximum of this tree’s per-configuration minimum');
		assert.equal(missing.maxAbsKey, 'solar_escape|36|0');
		const both0 = statistic([mkRound([[K1, 0, 0]])], [0]);
		assert.equal(both0.maxRatio, Infinity, '0 / 0 is not a passing ratio either');
		const e = evaluateWorld('TB', [1, 2, 3].map(() => mkRound([[K2, 80, 100], [K1, 50, 0]])), 3, 9);
		assert.equal(e.crit1, false);
		assert.match(formatWorld(e), /maxRatio=Infinity \(leo_250km\|0\.2\|0\) .*criterion1 NG/);
	});

	it('keeps a minimum of exactly 0 ms, accepts a baseline below 1 ms, and reports the first configuration on ties', () => {
		const zeroMin = statistic([mkRound([[K1, 0, 100]]), mkRound([[K1, 5, 100]])], [0, 1]);
		assert.equal(zeroMin.maxRatio, 0, 'the 0 ms of round 1 is the minimum, not replaced by the 5 ms of round 2');
		assert.equal(zeroMin.maxAbs, 0);
		const sub = statistic([mkRound([[K1, 0.6, 0.5]])], [0]);
		assert.ok(Math.abs(sub.maxRatio - 1.2) < 1e-12, 'a positive baseline below 1 ms still forms a ratio');
		const tie = statistic([mkRound([[K1, 120, 100], [K2, 120, 100]])], [0]);
		assert.equal(tie.maxRatioKey, K1, 'ties keep the first configuration in measurement order');
		assert.equal(tie.maxAbsKey, K1);
	});

	it('returns zero for no rounds', () => {
		assert.deepEqual(statistic([mkRound([[K1, 1, 1]])], []), { maxRatio: 0, maxRatioKey: '', maxAbs: 0, maxAbsKey: '' });
	});
});

describe('evaluateWorld: criteria, load condition and completeness', () => {
	const steady = (n, ratio = 1.2, loads = [1, 1], world = 'TB') => {
		const rounds = Array.from({ length: n }, () => mkRound([[K1, 100 * ratio, 100]], loads));
		return evaluateWorld(world, rounds, requiredRounds(world, 6, 3), 3 * requiredRounds(world, 6, 3));
	};
	const byRatio = (...pct) => evaluateWorld('SE', pct.map(p => mkRound([[K1, p, 100]])), 3, 18);

	it('passes all criteria for the required rounds at low load', () => {
		const e = steady(3);
		assert.equal(e.complete, true);
		assert.equal(e.loadOk, true);
		assert.equal(e.crit1, true);
		assert.equal(e.crit2, true);
		assert.equal(e.variation, 0);
		assert.ok(Math.abs(e.margin - 0.3) < 1e-12);
		assert.match(formatWorld(e), /^TB: rounds=3 maxRatio=1\.200 .* lowLoadRounds=3 => criterion1 OK, criterion2 OK, load OK$/);
	});

	it('is incomplete with no rounds or fewer than the required rounds, even at low load', () => {
		const e0 = evaluateWorld('TB', [], 3, 9);
		assert.equal(e0.complete, false);
		assert.equal(e0.loadOk, false, 'no rounds do not meet the load condition');
		assert.equal(e0.crit1, false);
		assert.equal(e0.crit2, false);
		assert.equal(formatWorld(e0), 'TB: rounds=0 [incomplete: 0/3 rounds, run again]');
		const e2 = steady(2);
		assert.equal(e2.complete, false);
		assert.match(formatWorld(e2), /\[incomplete: 2\/3 rounds, run again\]$/);
		assert.equal(steady(5, 1.2, [1, 1], 'SE').complete, false);
		assert.equal(steady(6, 1.2, [1, 1], 'SE').complete, true);
	});

	it('meets the load condition with a single low-load round and formats every value as specified', () => {
		const one = evaluateWorld('TB', [mkRound([[K1, 120, 100]], [1.234, 0.5])], 3, 9);
		assert.equal(one.loadOk, true, '1 round, both samples low: 1 >= 1/2');
		assert.equal(one.complete, false);
		// With 1 round the first half (floor(1/2) = 0 rounds) is empty and its statistic is 0, so the variation is the
		// whole statistic and criterion 1 cannot pass: a single round never shows a margin.
		assert.equal(formatWorld(one), 'TB: rounds=1 maxRatio=1.200 (leo_250km|0.2|0) margin=0.300 variation=1.200 maxAbs=120 ms ' +
			'(leo_250km|0.2|0) load=0.50-1.23 lowLoadRounds=1 => criterion1 NG, criterion2 OK, load OK [incomplete: 1/3 rounds, run again]');
		// all: 123.456 / 98.7654 = 1.24999, first: 123.456 / 100 = 1.23456, second: 130 / 98.7654 = 1.31625.
		const e = evaluateWorld('SE', [mkRound([[K1, 123.456, 100]], [1, 2.5]), mkRound([[K1, 130, 98.7654]], [3, 0.25])], 2, 6);
		assert.equal(formatWorld(e), 'SE: rounds=2 maxRatio=1.250 (leo_250km|0.2|0) margin=0.250 variation=0.082 maxAbs=123 ms ' +
			'(leo_250km|0.2|0) load=0.25-3.00 lowLoadRounds=1 => criterion1 OK, criterion2 OK, load OK');
	});

	it('counts a load of exactly 2.0 as low and anything above as high (half a round per sample)', () => {
		assert.equal(steady(3, 1.2, [2.0, 2.0]).lowLoadRounds, 3);
		assert.equal(steady(3, 1.2, [2.0, 2.0000001]).lowLoadRounds, 1.5);
		assert.equal(steady(3, 1.2, [2.0000001, 2.5]).lowLoadRounds, 0);
	});

	it('meets the load condition at exactly half the rounds and misses it one sample short', () => {
		const lo = () => mkRound([[K1, 120, 100]], [1, 1]);
		const hi = () => mkRound([[K1, 120, 100]], [3, 3]);
		const half = evaluateWorld('SE', [lo(), hi(), lo(), hi(), lo(), hi()], 6, 18);
		assert.equal(half.lowLoadRounds, 3);
		assert.equal(half.loadOk, true);
		assert.equal(half.complete, true);
		const short = evaluateWorld('SE', [lo(), hi(), lo(), hi(), mkRound([[K1, 120, 100]], [1, 3]), hi()], 6, 18);
		assert.equal(short.lowLoadRounds, 2.5);
		assert.equal(short.loadOk, false);
		assert.equal(short.complete, false, 'an unmet load condition asks for more rounds');
		assert.match(formatWorld(short), /\[incomplete: load condition unmet after 6 rounds, run again\]$/);
	});

	it('keeps high-load rounds and completes once added low-load rounds reach half', () => {
		const rounds = [1, 2, 3].map(() => mkRound([[K1, 125, 100]], [4, 4]));
		assert.equal(evaluateWorld('TB', rounds, 3, 9).complete, false);
		rounds.push(mkRound([[K1, 120, 100]], [1, 1]), mkRound([[K1, 120, 100]], [1, 1]));
		assert.equal(evaluateWorld('TB', rounds, 3, 9).complete, false, '2 of 5 rounds are low load');
		rounds.push(mkRound([[K1, 120, 100]], [1, 1]));
		const e = evaluateWorld('TB', rounds, 3, 9);
		assert.equal(e.n, 6, 'the high-load rounds are counted, not replaced');
		assert.equal(e.complete, true);
		assert.equal(e.loadOk, true);
		assert.equal(e.loadMax, 4);
		assert.ok(Math.abs(e.stat.maxRatio - 1.2) < 1e-12, 'the minimum over all rounds');
	});

	it('stops asking for rounds at the total cap and then reports the load condition as unmet', () => {
		const e = evaluateWorld('TB', [1, 2, 3, 4].map(() => mkRound([[K1, 120, 100]], [3, 3])), 3, 4);
		assert.equal(e.complete, true);
		assert.equal(e.loadOk, false);
		assert.match(formatWorld(e), /load NG \(rerun on a quieter machine\)$/);
		assert.equal(evaluateWorld('TB', [1, 2, 3].map(() => mkRound([[K1, 120, 100]], [3, 3])), 3).complete, true,
			'without a cap beyond the required rounds (no --state) the required rounds are final');
	});

	it('fails criterion 1 above 1.5 and at exactly 1.5 (no margin), passes just below', () => {
		assert.equal(steady(3, 1.51).crit1, false);
		assert.equal(steady(3, 1.5).crit1, false);
		assert.equal(steady(3, 1.49).crit1, true);
	});

	it('requires the margin to exceed (strictly) the variation over all, first-half and second-half rounds', () => {
		// 3 rounds: first half = round 0, second half = rounds 1-2, so the variation is r0 - 1.2 and the margin 1.5 - 1.2.
		const ok = byRatio(145, 120, 120);
		assert.ok(Math.abs(ok.stat.maxRatio - 1.2) < 1e-12);
		assert.ok(Math.abs(ok.variation - 0.25) < 1e-12);
		assert.ok(Math.abs(ok.margin - 0.3) < 1e-12);
		assert.equal(ok.crit1, true);
		const tie = byRatio(150, 120, 120);
		assert.equal(tie.margin, tie.variation);
		assert.equal(tie.crit1, false);
		const ng = byRatio(160, 120, 120);
		assert.ok(Math.abs(ng.variation - 0.4) < 1e-12);
		assert.equal(ng.crit1, false, 'the all-round statistic 1.2 is within 1.5, but the margin does not exceed the variation');
	});

	it('takes the variation over the second half too, from round floor(n/2) through the last round', () => {
		// 4 rounds: the second half (rounds 2-3) alone gives the largest statistic.
		const hi = byRatio(120, 120, 145, 145);
		assert.ok(Math.abs(hi.variation - 0.25) < 1e-12);
		assert.equal(hi.crit1, true);
		const hiNg = byRatio(120, 120, 155, 155);
		assert.ok(Math.abs(hiNg.variation - 0.35) < 1e-12);
		assert.equal(hiNg.crit1, false, 'only the second half exceeds the margin');
		// The last round sets the second-half statistic: without it the variation would be 0.25, with it 0.2.
		const last = byRatio(140, 140, 145, 120);
		assert.ok(Math.abs(last.variation - 0.2) < 1e-12);
		// 5 rounds: first half = rounds 0-1, second half = rounds 2-4.
		const five = byRatio(130, 130, 150, 150, 120);
		assert.ok(Math.abs(five.variation - 0.1) < 1e-12);
		assert.equal(five.crit1, true);
	});

	it('applies the absolute limits to Sun+Earth (1 s) and the 7-body world (2 s) only, inclusive', () => {
		const abs = (world, ms) => evaluateWorld(world, Array.from({ length: 6 }, () => mkRound([[K1, ms, ms]])), 6, 18).crit2;
		assert.equal(abs('SE', 1000), true);
		assert.equal(abs('SE', 1000.5), false);
		assert.equal(abs('W7', 2000), true);
		assert.equal(abs('W7', 2000.5), false);
		for (const w of ['SS', 'BIN', 'TB']) assert.equal(abs(w, 5000), true);
	});
});

describe('treeFingerprint', () => {
	it('is equal for identical trees and ignores files outside scripts/, presets/ and test_helpers.mjs', () => {
		const a = mkTree(path.join(TMP, 'fa'));
		const b = mkTree(path.join(TMP, 'fb'));
		fs.mkdirSync(path.join(b, 'docs'));
		fs.writeFileSync(path.join(b, 'docs', 'note.md'), 'x');
		fs.writeFileSync(path.join(b, 'testsuites', 'other.mjs'), 'x');
		assert.match(treeFingerprint(a), /^[0-9a-f]{32}$/);
		assert.equal(treeFingerprint(a), treeFingerprint(b));
	});

	it('changes with a file content, a renamed file, an added preset or a missing helper', () => {
		const base = treeFingerprint(mkTree(path.join(TMP, 'fc')));
		const edit = mkTree(path.join(TMP, 'fd'));
		fs.writeFileSync(path.join(edit, 'scripts', 'gravsim_calc.js'), 'export const b = 3;\n');
		assert.notEqual(treeFingerprint(edit), base);
		const ren = mkTree(path.join(TMP, 'fe'));
		fs.renameSync(path.join(ren, 'scripts', 'gravsim_calc.js'), path.join(ren, 'scripts', 'gravsim_calc2.js'));
		assert.notEqual(treeFingerprint(ren), base);
		const add = mkTree(path.join(TMP, 'ff'));
		fs.writeFileSync(path.join(add, 'presets', 'missions', 'gto.json'), '{}');
		assert.notEqual(treeFingerprint(add), base);
		const miss = mkTree(path.join(TMP, 'fg'));
		fs.rmSync(path.join(miss, 'testsuites', 'test_helpers.mjs'));
		assert.notEqual(treeFingerprint(miss), base);
		const empty = mkTree(path.join(TMP, 'fh'));
		fs.writeFileSync(path.join(empty, 'testsuites', 'test_helpers.mjs'), '');
		assert.notEqual(treeFingerprint(miss), treeFingerprint(empty), 'a missing file differs from an empty one');
		// Each file is framed (path, NUL, content, NUL): the closing NUL keeps a file's content from running into the next
		// path, so this pair differs. Contents that themselves contain the NUL framing can still collide (source and
		// preset files do not contain NUL); the fingerprint guards against mixing trees, not against crafted files.
		const two = mkTree(path.join(TMP, 'fi'));
		fs.writeFileSync(path.join(two, 'scripts', 'x.js'), 'A');
		fs.writeFileSync(path.join(two, 'scripts', 'y.js'), 'B');
		const one = mkTree(path.join(TMP, 'fj'));
		fs.writeFileSync(path.join(one, 'scripts', 'x.js'), 'Ascripts/y.js\0B');
		assert.notEqual(treeFingerprint(two), treeFingerprint(one));
	});
});

describe('harnessFingerprint: the measurement code', () => {
	const variants = {
		same: [],
		runChild: [["const world = argValue('--world', 'SE');", "const world = argValue('--world', 'W7');"]],
		measure: [['maxBuffer: 64 * 1024 * 1024', 'maxBuffer: 65 * 1024 * 1024']],
		missions: [["['falcon9', 'earth_obs', 'solar_escape', 36]", "['falcon9', 'earth_obs', 'solar_escape', 35]"]],
		near: [["'gto_insertion', 'lunar_insertion']);", "'gto_insertion']);"]],
		month: [['const MO = (365.25 / 12) * 86400;', 'const MO = (365 / 12) * 86400;']],
		evaluation: [['const LOAD_LIMIT = 2.0;', 'const LOAD_LIMIT = 2.5;']],
		comment: [['Not part of `npm test`', 'Not run by `npm test`']]
	};
	const mods = {};
	before(async () => {
		for (const [name, edits] of Object.entries(variants)) {
			mods[name] = await import(pathToFileURL(copyHarness(path.join(TMP, `h_${name}`), edits)).href);
		}
	});

	it('changes with runChild, measure and the configuration constants, not with the evaluation code or comments', () => {
		const fp = harnessFingerprint();
		assert.match(fp, /^[0-9a-f]{32}$/);
		assert.equal(mods.same.harnessFingerprint(), fp, 'the same code at another path');
		for (const name of ['runChild', 'measure', 'missions', 'near', 'month']) assert.notEqual(mods[name].harnessFingerprint(), fp, name);
		assert.equal(mods.evaluation.harnessFingerprint(), fp, 'the saved rounds stay valid when only the evaluation changes');
		assert.equal(mods.comment.harnessFingerprint(), fp);
	});

	it('refuses to resume a state saved by other measurement code', () => {
		const base = mkTree(path.join(TMP, 'hfp_base'));
		const file = path.join(TMP, 'hfp.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds.TB = [fullRound(0)];
		saveState(file, s);
		assert.equal(mods.same.loadState(file, { cur: REPO, base }, '0').worlds.TB.length, 1);
		for (const name of ['runChild', 'measure', 'missions']) {
			assert.throws(() => mods[name].loadState(file, { cur: REPO, base }, '0'), /different harness/, name);
		}
	});
});

describe('State file (--state)', () => {
	let base;
	before(() => { base = mkTree(path.join(TMP, 'state_base')); });

	it('starts a new state when the file does not exist', () => {
		const s = loadState(path.join(TMP, 'none.json'), { cur: REPO, base }, '0,90');
		assert.deepEqual(s.worlds, {});
		assert.equal(s.version, 1);
		assert.equal(s.azimuths, '0,90');
		assert.equal(s.baseline, base);
		assert.equal(s.cur, treeFingerprint(REPO));
		assert.equal(s.base, treeFingerprint(base));
		assert.equal(s.harness, harnessFingerprint());
		assert.equal(s.testLoad, undefined);
	});

	it('round-trips saved rounds atomically', () => {
		const file = path.join(TMP, 'rt.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds.TB = fullRounds(2);
		saveState(file, s);
		assert.equal(fs.existsSync(`${file}.tmp`), false);
		assert.equal('testLoad' in readState(file), false, 'no test load is recorded for real samples');
		assert.deepEqual(loadState(file, { cur: REPO, base }, '0').worlds.TB, s.worlds.TB);
	});

	it('refuses a state recorded with another baseline tree, another tree under test or other azimuths', () => {
		const file = path.join(TMP, 'mm.json');
		const same = mkTree(path.join(TMP, 'state_same'));
		const other = mkTree(path.join(TMP, 'state_other'));
		fs.writeFileSync(path.join(other, 'scripts', 'gravsim_calc.js'), 'changed');
		saveState(file, loadState(file, { cur: REPO, base }, '0'));
		assert.doesNotThrow(() => loadState(file, { cur: REPO, base: same }, '0'), 'an identical copy elsewhere is the same tree');
		assert.throws(() => loadState(file, { cur: REPO, base: other }, '0'), /different base/);
		assert.throws(() => loadState(file, { cur: other, base }, '0'), /different cur/);
		assert.throws(() => loadState(file, { cur: REPO, base }, '0,90'), /different azimuths/);
	});

	it('refuses a state from another harness or version, and one without a worlds object', () => {
		const file = path.join(TMP, 'bad.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		saveState(file, { ...s, harness: '0'.repeat(32) });
		assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /different harness/);
		saveState(file, { ...s, version: 2 });
		assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /different version/);
		for (const worlds of [undefined, null, [], 'x']) {
			saveState(file, { ...s, worlds });
			assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /has no worlds/);
		}
	});

	it('refuses a file that is not JSON or not an object, an unknown world, and invalid saved rounds', () => {
		const file = path.join(TMP, 'inv.json');
		fs.writeFileSync(file, '{"version": 1,');
		assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /is not valid JSON/);
		for (const text of ['[]', 'null', '3']) {
			fs.writeFileSync(file, text);
			assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /is not an object/);
		}
		const s = loadState(path.join(TMP, 'none.json'), { cur: REPO, base }, '0');
		const check = (worlds, re) => { saveState(file, { ...s, worlds }); assert.throws(() => loadState(file, { cur: REPO, base }, '0'), re); };
		check({ XX: [] }, /has an invalid world XX/);
		check({ TB: {} }, /has an invalid world TB/);
		const missing = fullRound(0);
		missing.base.pop();
		check({ TB: [missing] }, /: TB round 1 base: 1 of 31 configurations missing/);
		check({ BIN: [fullRound(0), fullRound(0)] }, /: BIN round 2 has order/);
		check({ SE: [{ ...fullRound(0), loads: [1] }] }, /: SE round 1 needs two finite non-negative load samples/);
	});

	it('records a test load and never mixes it with real samples', () => {
		const file = path.join(TMP, 'tl.json');
		const prev = process.env.ROLLOUT_TIMING_TEST_LOAD;
		try {
			process.env.ROLLOUT_TIMING_TEST_LOAD = '3';
			saveState(file, loadState(file, { cur: REPO, base }, '0'));
			assert.equal(readState(file).testLoad, '3');
			assert.doesNotThrow(() => loadState(file, { cur: REPO, base }, '0'));
			process.env.ROLLOUT_TIMING_TEST_LOAD = '0.5';
			assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /different testLoad/);
			delete process.env.ROLLOUT_TIMING_TEST_LOAD;
			assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /different testLoad \(3 != undefined\)/);
			saveState(file, loadState(path.join(TMP, 'none.json'), { cur: REPO, base }, '0'));
			process.env.ROLLOUT_TIMING_TEST_LOAD = '3';
			assert.throws(() => loadState(file, { cur: REPO, base }, '0'), /different testLoad \(undefined != 3\)/);
		} finally {
			if (prev === undefined) delete process.env.ROLLOUT_TIMING_TEST_LOAD;
			else process.env.ROLLOUT_TIMING_TEST_LOAD = prev;
		}
	});
});

describe('Command line', () => {
	const run = (...args) => spawnNode([HARNESS, ...args], { cwd: REPO });
	let base;
	before(() => { base = mkTree(path.join(TMP, 'cli_base')); });
	const st = (name) => path.join(TMP, name);

	it('exits 2 with the usage without a valid baseline or with an unknown world', () => {
		for (const r of [run(), run('--baseline', path.join(TMP, 'nowhere')), run('--baseline', base, '--worlds', 'SE,XX')]) {
			assert.equal(r.status, 2);
			assert.match(r.stderr, /^usage: /);
		}
	});

	it('exits 2 with the usage for an invalid --state, --max-rounds or --max-total, or those options without --state', () => {
		const b = ['--baseline', base, '--worlds', 'TB', '--azimuths', '0'];
		const cases = [
			[...b, '--state'], [...b, '--state', '--max-rounds', '0'],
			...['x', '-1', '1.5', '', ' '].map(v => [...b, '--state', st('u.json'), '--max-rounds', v]),
			[...b, '--state', st('u.json'), '--max-rounds'],
			...['0', '-2', '2.5', 'y'].map(v => [...b, '--state', st('u.json'), '--max-total', v]),
			[...b, '--max-rounds', '1'], [...b, '--max-total', '4']
		];
		for (const args of cases) {
			const r = run(...args);
			assert.equal(r.status, 2, JSON.stringify(args));
			assert.match(r.stderr, /^usage: /, JSON.stringify(args));
		}
		assert.equal(fs.existsSync(st('u.json')), false);
	});

	it('uses the §4.12 azimuths 0/90/180/270 by default and accepts --max-total 1', () => {
		const file = st('cli_az.json');
		const s = loadState(file, { cur: REPO, base }, '0,90,180,270');
		s.worlds.TB = fullRounds(3, { azs: [0, 90, 180, 270] });
		saveState(file, s);
		const r = run('--baseline', base, '--worlds', 'TB', '--state', file, '--max-rounds', '0');
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^TB: rounds=3 maxRatio=1\.200 .*load OK\n$/);
		const one = run('--baseline', base, '--worlds', 'TB', '--state', file, '--max-rounds', '0', '--max-total', '1');
		assert.equal(one.status, 0, 'the smallest valid --max-total');
		assert.equal(one.stderr, '');
	});

	it('evaluates the five worlds of §4.12 in order when --worlds is not given', () => {
		const file = st('cli_worlds.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds = { TB: fullRounds(3), SE: fullRounds(6) };
		saveState(file, s);
		const r = run('--baseline', base, '--azimuths', '0', '--state', file, '--max-rounds', '0');
		assert.equal(r.status, 3, r.stderr);
		assert.deepEqual(r.stdout.trim().split('\n').map(l => l.split(':')[0]), ['SE', 'W7', 'SS', 'BIN', 'TB']);
		assert.match(r.stdout, /^W7: rounds=0 \[incomplete: 0\/6 rounds, run again\]$/m);
		assert.match(r.stdout, /^SS: rounds=0 \[incomplete: 0\/3 rounds, run again\]$/m);
	});

	it('runs nothing when imported, also from an evaluated script without a file name', () => {
		const r = spawnNode(['--input-type=module', '-e',
			`import(${JSON.stringify(pathToFileURL(HARNESS).href)}).then(m => console.log(typeof m.statistic, typeof m.loadState))`]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, 'function function\n');
		assert.equal(r.stderr, '');
	});

	it('exits 2 for a state recorded with other trees or a file that is not JSON, without measuring', () => {
		const file = st('cli_mm.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		saveState(file, { ...s, base: 'f'.repeat(32) });
		const r = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /different base/);
		assert.deepEqual(roundLines(r.stderr), []);
		fs.writeFileSync(file, 'not json');
		const j = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file);
		assert.equal(j.status, 2);
		assert.match(j.stderr, /is not valid JSON/);
	});

	it('resumes a complete state without measuring and exits 0 when the criteria hold, 1 when they do not', () => {
		const file = st('cli_ok.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds.TB = fullRounds(3);
		saveState(file, s);
		const ok = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file, '--max-rounds', '1');
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /^TB: rounds=3 maxRatio=1\.200 .*criterion1 OK, criterion2 OK, load OK\n$/);
		assert.equal(ok.stderr, '');
		s.worlds.TB = fullRounds(3, { cur: 160 });
		saveState(file, s);
		const ng = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file);
		assert.equal(ng.status, 1);
		assert.match(ng.stdout, /criterion1 NG/);
		s.worlds.TB = fullRounds(3, { loads: [3, 3] });
		saveState(file, s);
		const load = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file, '--max-total', '3');
		assert.equal(load.status, 1, 'at the --max-total cap an unmet load condition fails the run');
		assert.match(load.stdout, /criterion1 OK, criterion2 OK, load NG \(rerun on a quieter machine\)\n$/);
		assert.equal(load.stderr, '');
	});

	it('evaluates an incomplete state with --max-rounds 0 without measuring and exits 3', () => {
		const file = st('cli_part.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds.TB = fullRounds(2);
		s.worlds.BIN = fullRounds(3, { cur: 110 });
		saveState(file, s);
		const r = run('--baseline', base, '--worlds', 'BIN,TB,SE', '--azimuths', '0', '--state', file, '--max-rounds', '0');
		assert.equal(r.status, 3, r.stderr);
		assert.equal(r.stderr, '');
		const lines = r.stdout.trim().split('\n');
		assert.equal(lines.length, 3);
		assert.match(lines[0], /^BIN: rounds=3 maxRatio=1\.100 .*load OK$/);
		assert.match(lines[1], /^TB: rounds=2 .*\[incomplete: 2\/3 rounds, run again\]$/);
		assert.equal(lines[2], 'SE: rounds=0 [incomplete: 0/6 rounds, run again]');
		assert.deepEqual(readState(file).worlds, { TB: s.worlds.TB, BIN: s.worlds.BIN }, 'the state is not changed');
	});

	it('exits 1 when criterion 2 alone fails (Sun+Earth over 1 s, 7-body world over 2 s) and 0 at the limits', () => {
		const file = st('cli_abs.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		const evalWith = (world, cur, b) => {
			s.worlds = { [world]: fullRounds(6, { cur, base: b }) };
			saveState(file, s);
			return run('--baseline', base, '--worlds', world, '--azimuths', '0', '--state', file, '--max-rounds', '0');
		};
		const se = evalWith('SE', 1001, 1000);
		assert.equal(se.status, 1);
		assert.match(se.stdout, /^SE: .*maxAbs=1001 ms .*criterion1 OK, criterion2 NG, load OK\n$/);
		assert.equal(evalWith('SE', 1000, 1000).status, 0);
		const w7 = evalWith('W7', 2001, 2000);
		assert.equal(w7.status, 1);
		assert.match(w7.stdout, /^W7: .*criterion1 OK, criterion2 NG, load OK\n$/);
		assert.equal(evalWith('W7', 2000, 2000).status, 0);
		assert.equal(evalWith('SS', 5000, 5000).status, 0, 'SOLAR_SYSTEM has no absolute limit');
	});

	it('fails criterion 1 for a configuration whose baseline minimum is 0 ms', () => {
		const file = st('cli_zero.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds.TB = fullRounds(3);
		for (const r of s.worlds.TB) r.base[0].ms = 0;
		saveState(file, s);
		const r = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file, '--max-rounds', '0');
		assert.equal(r.status, 1);
		assert.match(r.stdout, /^TB: rounds=3 maxRatio=Infinity \(leo_250km\|0\.2\|0\) .*criterion1 NG, criterion2 OK, load OK\n$/);
	});

	it('takes --rounds-heavy and --rounds as integers of at least 6 and 3, and refuses smaller or non-integer values', () => {
		const file = st('cli_rounds.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds = { SE: fullRounds(6), TB: fullRounds(3) };
		saveState(file, s);
		const ev = (...opts) => run('--baseline', base, '--worlds', 'SE,TB', '--azimuths', '0', '--state', file, '--max-rounds', '0', ...opts);
		assert.equal(ev().status, 0);
		assert.equal(ev('--rounds-heavy', '6', '--rounds', '3').status, 0);
		const more = ev('--rounds-heavy', '8', '--rounds', '4');
		assert.equal(more.status, 3);
		assert.match(more.stdout, /^SE: rounds=6 .*\[incomplete: 6\/8 rounds, run again\]\nTB: rounds=3 .*\[incomplete: 3\/4 rounds, run again\]\n$/);
		for (const opts of [['--rounds-heavy', '5'], ['--rounds', '2'], ['--rounds-heavy', '7.5'], ['--rounds', 'x'], ['--rounds', '0'], ['--rounds-heavy']]) {
			const r = ev(...opts);
			assert.equal(r.status, 2, opts.join(' '));
			assert.match(r.stderr, /^usage: /, opts.join(' '));
		}
	});

	it('asks for rounds up to 3 x the required count by default while the load condition is unmet', () => {
		const file = st('cli_cap.json');
		const s = loadState(file, { cur: REPO, base }, '0');
		s.worlds.TB = fullRounds(8, { loads: [3, 3] });
		saveState(file, s);
		const eight = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file, '--max-rounds', '0');
		assert.equal(eight.status, 3);
		assert.match(eight.stdout, /\[incomplete: load condition unmet after 8 rounds, run again\]\n$/);
		s.worlds.TB = fullRounds(9, { loads: [3, 3] });
		saveState(file, s);
		const nine = run('--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file, '--max-rounds', '0');
		assert.equal(nine.status, 1);
		assert.match(nine.stdout, /^TB: rounds=9 .*load NG \(rerun on a quieter machine\)\n$/);
	});
});

describe('Measuring loop (fake trees with mock modules)', () => {
	let cur, base, harness;
	before(() => {
		cur = mkFakeTree(path.join(TMP, 'loop_cur'), 'cur');
		base = mkFakeTree(path.join(TMP, 'loop_base'), 'base');
		harness = copyHarness(cur);
	});
	let logN = 0;
	const newLog = () => { const f = path.join(TMP, `loop_${++logN}.log`); fs.writeFileSync(f, ''); return f; };
	const readLog = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
	const run = (env, worlds, ...args) => spawnNode([harness, '--baseline', base, '--worlds', worlds, '--azimuths', '0', ...args], {
		cwd: cur, env: { ...process.env, ROLLOUT_TIMING_TEST_LOAD: '0.5', ...env }
	});
	/** §4.12 order of rounds first..first+n-1 as "<tree> <world>" log lines. */
	const orderLog = (world, first, n) => Array.from({ length: n }, (_, k) => ((first + k) % 2 === 0 ? ['cur', 'base'] : ['base', 'cur']))
		.flat().map(tree => `${tree} ${world}`);

	it('measures one round per --max-rounds 1 run, saves it, and keeps alternating the order across runs', () => {
		const file = path.join(TMP, 'loop1.json');
		const log = newLog();
		const expected = [['cur', 'base'], ['base', 'cur'], ['cur', 'base']];
		for (let k = 1; k <= 3; k++) {
			const r = run({ FAKE_LOG: log }, 'TB', '--state', file, '--max-rounds', '1');
			assert.equal(r.status, k < 3 ? 3 : (r.status === 0 ? 0 : 1), r.stderr);
			assert.deepEqual(roundLines(r.stderr), [`  TB round ${k} done (required 3, load 0.50)`]);
			assert.match(r.stderr, /^ROLLOUT_TIMING_TEST_LOAD=0\.5: load samples are not measured/);
			assert.deepEqual(readLog(log), orderLog('TB', 0, k), 'each tree is measured in the recorded order, in its own tree, for the world');
			const s = readState(file);
			assert.equal(s.worlds.TB.length, k, 'one round is added and saved per run');
			assert.deepEqual(s.worlds.TB.map(x => x.order), expected.slice(0, k));
			assert.deepEqual(s.worlds.TB[k - 1].loads, [0.5, 0.5]);
			assert.match(s.worlds.TB[k - 1].finishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
			assert.ok(Date.now() - Date.parse(s.worlds.TB[k - 1].finishedAt) < 600000);
			for (const t of ['cur', 'base']) assert.deepEqual(s.worlds.TB[k - 1][t].map(o => `${o.m}|${o.mo}|${o.az}`), designKeys([0]));
			assert.equal(s.testLoad, '0.5');
		}
		const again = run({ FAKE_LOG: log }, 'TB', '--state', file, '--max-rounds', '1');
		assert.deepEqual(roundLines(again.stderr), [], 'a complete world is not measured again');
		assert.equal(readLog(log).length, 6);
		assert.equal(readState(file).worlds.TB.length, 3);
	});

	it('samples the 1-minute load average when no test load is set', () => {
		// os.loadavg() is replaced in the harness process by a preloaded module: [1 min, 5 min, 15 min].
		const stub = path.join(TMP, 'loadavg_stub.mjs');
		fs.writeFileSync(stub, "import os from 'node:os';\nos.loadavg = () => [0.25, 7.5, 9.75];\n");
		const file = path.join(TMP, 'loop_real.json');
		const env = { ...process.env };
		delete env.ROLLOUT_TIMING_TEST_LOAD;
		const r = spawnNode(['--import', pathToFileURL(stub).href, harness, '--baseline', base, '--worlds', 'TB', '--azimuths', '0', '--state', file, '--max-rounds', '1'], {
			cwd: cur, env
		});
		assert.equal(r.status, 3, r.stderr);
		assert.doesNotMatch(r.stderr, /ROLLOUT_TIMING_TEST_LOAD/);
		assert.deepEqual(roundLines(r.stderr), ['  TB round 1 done (required 3, load 0.25)']);
		const s = readState(file);
		assert.equal('testLoad' in s, false);
		assert.deepEqual(s.worlds.TB[0].loads, [0.25, 0.25], 'the 1-minute value, before each tree');
	});

	it('samples the load before each tree, after the previous tree has finished', () => {
		const file = path.join(TMP, 'loop_load.json');
		const loadFile = path.join(TMP, 'load.txt');
		fs.writeFileSync(loadFile, '0');
		const r = run({ ROLLOUT_TIMING_TEST_LOAD: `@${loadFile}`, FAKE_LOAD_FILE: loadFile }, 'TB', '--state', file, '--max-rounds', '2');
		assert.equal(r.status, 3, r.stderr);
		assert.deepEqual(readState(file).worlds.TB.map(x => x.loads), [[0, 1], [2, 3]], 'the n-th sample sees the n trees measured before it');
		assert.equal(fs.readFileSync(loadFile, 'utf8'), '4');
		assert.equal(readState(file).testLoad, `@${loadFile}`);
	});

	it('without --state measures exactly the required rounds of every world, even when the load condition is unmet', () => {
		const log = newLog();
		const r = run({ ROLLOUT_TIMING_TEST_LOAD: '3', FAKE_LOG: log }, 'BIN,TB');
		assert.equal(r.status, 1);
		assert.deepEqual(roundLines(r.stderr).map(l => l.trim().split(' (')[0]),
			['BIN round 1 done', 'BIN round 2 done', 'BIN round 3 done', 'TB round 1 done', 'TB round 2 done', 'TB round 3 done']);
		assert.deepEqual(readLog(log), [...orderLog('BIN', 0, 3), ...orderLog('TB', 0, 3)]);
		const lines = r.stdout.trim().split('\n');
		assert.equal(lines.length, 2);
		for (const [k, w] of [[0, 'BIN'], [1, 'TB']]) {
			assert.match(lines[k], new RegExp(`^${w}: rounds=3 .* load=3\\.00-3\\.00 lowLoadRounds=0 => .*load NG \\(rerun on a quieter machine\\)$`));
		}
	});

	it('with --state adds rounds while the load condition is unmet, up to --max-total, in one run without --max-rounds', () => {
		const file = path.join(TMP, 'loop2.json');
		const r = run({ ROLLOUT_TIMING_TEST_LOAD: '3' }, 'TB', '--state', file, '--max-total', '4');
		assert.equal(r.status, 1);
		assert.equal(roundLines(r.stderr).length, 4);
		assert.equal(readState(file).worlds.TB.length, 4);
		assert.match(r.stdout, /^TB: rounds=4 .*load NG/);
	});

	it('stops with exit 2 and saves nothing for a round with an unexpected or missing configuration', () => {
		const file = path.join(TMP, 'loop3.json');
		assert.equal(run({}, 'TB', '--state', file, '--max-rounds', '1').status, 3);
		const extra = run({ FAKE_EXTRA: '1' }, 'TB', '--state', file, '--max-rounds', '1');
		assert.equal(extra.status, 2);
		assert.match(extra.stderr, /TB round 2 (cur|base): unexpected configuration extra\|1\|0 \(the round is not saved\)/);
		assert.equal(readState(file).worlds.TB.length, 1);
		const partial = run({ FAKE_STOP_AFTER: '5' }, 'TB', '--state', file, '--max-rounds', '1');
		assert.equal(partial.status, 2, 'a child that exits 0 after 5 of 31 configurations');
		assert.match(partial.stderr, /TB round 2 (cur|base): 26 of 31 configurations missing \(first: iss_rendezvous\|0\.3\|0\) \(the round is not saved\)/);
		assert.equal(readState(file).worlds.TB.length, 1);
		const next = run({}, 'TB', '--state', file, '--max-rounds', '1');
		assert.equal(next.status, 3);
		assert.deepEqual(readState(file).worlds.TB.map(x => x.order), [['cur', 'base'], ['base', 'cur']]);
	});
});
