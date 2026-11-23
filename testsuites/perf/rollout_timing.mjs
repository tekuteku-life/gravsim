#!/usr/bin/env node
/**
 * GravSim rollout() synchronous block-time measurement (design §4.12 acceptance criteria).
 *
 * Not part of `npm test`: timing depends on machine load, so it is run explicitly with the method defined in §4.12.
 *
 * Usage:
 *   node testsuites/perf/rollout_timing.mjs --baseline <path to a main-branch checkout>
 *        [--worlds SE,W7,SS,BIN,TB] [--rounds-heavy 6] [--rounds 3] [--azimuths 0,90,180,270]
 *        [--state <file> [--max-rounds <n>] [--max-total <n>]]
 *
 * Method (§4.12):
 *   - Configurations: 7 mission presets x periods x azimuths x worlds. Near-host missions (LEO/ISS/GTO/Lunar) use their
 *     default period plus 0.2/0.5/1/12/36 months, deep-space missions their default plus 0.2/1/36 months (124 per world).
 *   - Each world alternates this tree and the baseline, swapping the order every round. Sun+Earth (SE) and the 7-body
 *     world (W7) run --rounds-heavy rounds (an integer >= 6, default 6), the others --rounds rounds (an integer >= 3,
 *     default 3); a smaller or non-integer value is a usage error. The 1-minute load average is recorded.
 *   - Statistic: per configuration, the ratio of the minimum over rounds (this tree / baseline); criterion 1 uses the
 *     maximum over all configurations (a configuration without a positive baseline minimum counts as an infinite
 *     ratio). Criterion 2 uses the maximum of this tree's per-configuration minimum.
 *   - Margin: (1.5 - statistic) must exceed the statistic's own variation: the same statistic is computed on all
 *     rounds, the first-half rounds and the second-half rounds, and the variation is the largest minus the smallest.
 *   - Load: half or more of the rounds must start at a 1-minute load average <= 2.0 (sampled before each tree; a round
 *     counts half per sample). High-load rounds are kept, not excluded.
 *
 *   - Completeness: every round must hold, for both trees, exactly the expected configurations (each once, with a
 *     finite non-negative time); a measured or saved round that does not is a measurement error. Criterion 2 is taken
 *     over all of this tree's configurations.
 *
 * Split runs (--state <file>): every finished round is saved to the file, and a later run with the same file resumes
 * with the next round number (so the tree order keeps alternating). Each run measures at most --max-rounds rounds
 * (default: no limit; 0 only evaluates the saved rounds) of the worlds that still need one, in --worlds order. A world
 * needs another round while it has fewer than the required rounds, or while the load condition is unmet and it has
 * fewer than --max-total rounds (default 3 x required): the condition is met by adding low-load rounds, so only the part
 * measured under load is redone. The file records md5 fingerprints of both trees (scripts/, presets/,
 * testsuites/test_helpers.mjs) and of the measurement code (runChild, measure and the configuration constants), plus
 * the azimuths as given; a run with any of them changed is refused, so rounds measured on different code are never
 * combined. Without --state, every world runs exactly the required rounds, and --max-rounds / --max-total are refused.
 * ROLLOUT_TIMING_TEST_LOAD=<number> or =@<file> replaces every load sample with that number or with the file's content
 * read at the sample (for the harness's own tests only; it is recorded in the state file, so such a state is never
 * resumed by a real run, nor the reverse).
 * Exit code: 0 when every criterion holds, 1 otherwise, 2 on usage, state-file or measurement errors, 3 when a --state
 * run is incomplete (a world still needs rounds; run again).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..', '..');
const MO = (365.25 / 12) * 86400;
const MISSIONS = [
	['h3_30', 'earth_obs', 'leo_250km', 0.2], ['h3_22', 'htv_x', 'iss_rendezvous', 0.3],
	['h3_24', 'geo_sat', 'gto_insertion', 0.5], ['h3_24', 'lunar_orbiter', 'lunar_insertion', 1],
	['h3_30', 'mmx', 'mars_transfer', 12], ['h3_24', 'earth_obs', 'jupiter_transfer', 36],
	['falcon9', 'earth_obs', 'solar_escape', 36]
];
const NEAR = new Set(['leo_250km', 'iss_rendezvous', 'gto_insertion', 'lunar_insertion']);
const RATIO_LIMIT = 1.5;
const ABS_LIMIT_MS = { SE: 1000, W7: 2000 };
const LOAD_LIMIT = 2.0;
const WORLDS = ['SE', 'W7', 'SS', 'BIN', 'TB'];

const argValue = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};

/** Child mode: measure every configuration of one world in the tree given by --root (cwd must be that tree). */
async function runChild() {
	const root = path.resolve(argValue('--root', REPO));
	const world = argValue('--world', 'SE');
	const azimuths = argValue('--azimuths', '0,90,180,270').split(',').map(Number);
	const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
	const { setupMockDOM, createMockUniverse } = await imp('testsuites/test_helpers.mjs');
	const { PhysicsEngine } = await imp('scripts/gravsim_calc.js');
	const { ObjectManager } = await imp('scripts/gravsim_object_manager.js');
	const { ObjectPlacer } = await imp('scripts/gravsim_object_placer.js');
	const { RocketLauncher } = await imp('scripts/gravsim_rocket_launcher.js');
	const { WorkerBridge } = await imp('scripts/gravsim_worker_bridge.js');
	const { presetManager } = await imp('scripts/gravsim_preset_manager.js');
	const { EventBus } = await imp('scripts/gravsim_event_bus.js');
	const { PHYSICS } = await imp('scripts/gravsim_const.js');
	const { UnitConvertUtils } = await imp('scripts/gravsim_utils.js');
	setupMockDOM();
	const AU = PHYSICS.METERS_PER_AU;
	const m2p = (m) => UnitConvertUtils.m2pix(m);

	const createWorld = () => {
		EventBus.clearAll();
		const engine = new PhysicsEngine();
		const worker = {
			postMessage(msg) {
				if (msg.cmd === 'add') engine.addObject(JSON.parse(JSON.stringify(msg)));
				else if (msg.cmd === 'update') engine.updateObject(msg);
				else if (msg.cmd === 'remove') engine.removeObject(msg.id);
				else if (msg.cmd === 'returnBuffer') WorkerBridge.recycleBuffer(msg.buffer);
			}
		};
		const universe = createMockUniverse();
		const om = new ObjectManager(null, worker);
		om.universe = universe;
		universe.ObjectManager = om;
		Object.defineProperty(universe, 'objects', { get() { return om.objects; }, set(a) { om.objects = a; }, configurable: true });
		universe.addObject = (obj) => om.addObject(obj);
		universe.getObjectParams = (n) => presetManager.getObjectParam(n);
		universe.ObjectPlacer = new ObjectPlacer(universe);
		return { om, universe };
	};

	for (const [vehicleId, payloadId, missionId, defMo] of MISSIONS) {
		const periods = [...new Set([defMo, ...(NEAR.has(missionId) ? [0.2, 0.5, 1, 12, 36] : [0.2, 1, 36])])];
		for (const mo of periods) {
			for (const az of azimuths) {
				const { om, universe } = createWorld();
				const P = universe.ObjectPlacer;
				P.placeObject('Sun', 0, 0, 0, 0);
				let earth;
				if (world === 'SS') { P.deployProfile('SOLAR_SYSTEM'); earth = om.objects.find(o => o.name === 'Earth'); }
				else if (world === 'BIN') { P.deployProfile('BINARY_SYSTEM'); earth = om.objects.find(o => o.name === 'Earth'); }
				else if (world === 'TB') { P.deployProfile('THREE_BODY'); earth = om.objects.find(o => o.name === 'Earth (Trisolaris)'); }
				else {
					earth = P.placeObject('Earth', m2p(AU), 0, 0, m2p(29780));
					if (world === 'W7') {
						P.placeObject('Moon', m2p(AU + 384400e3), 0, 0, m2p(29780 + 1022));
						P.placeObject('Venus', m2p(-0.723 * AU), 0, 0, m2p(-35020));
						P.placeObject('Mars', 0, m2p(1.524 * AU), m2p(-24070), 0);
						P.placeObject('Jupiter', 0, m2p(-5.2 * AU), m2p(13070), 0);
					}
				}
				if (!earth) throw new Error(`host body not found in world ${world}`);
				const rl = new RocketLauncher(universe, { presetManager });
				universe.RocketLauncher = rl;
				rl.requestPreviewUpdate = () => {};
				rl.updatePrediction = () => null;
				presetManager.applyToLauncher(rl, { vehicleId, payloadId, missionId });
				if (mo !== defMo) { rl.predictionDurationMonths = mo; rl.maxSimTimeSec = mo * MO; }
				rl.mode = 'host';
				rl.hostId = earth.id;
				rl.hostAngleDeg = az;
				const t0 = performance.now();
				rl.rollout();
				const ms = performance.now() - t0;
				process.stdout.write(JSON.stringify({ m: missionId, mo, az, ms }) + '\n');
			}
		}
	}
}

/** Runs one child for (tree, world) and returns its parsed measurements. */
function measure(root, world, azimuths) {
	const r = spawnSync(process.execPath, [SELF, '--child', '--root', root, '--world', world, '--azimuths', azimuths], {
		cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
	});
	if (r.status !== 0) throw new Error(`measurement failed (${root}, ${world}):\n${r.stderr}`);
	return r.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
}

const key = (o) => `${o.m}|${o.mo}|${o.az}`;

/** Criterion statistics over the given round indices. */
function statistic(rounds, idx) {
	const minOf = (tree) => {
		const mins = new Map();
		for (const i of idx) for (const o of rounds[i][tree]) mins.set(key(o), Math.min(mins.get(key(o)) ?? Infinity, o.ms));
		return mins;
	};
	const cur = minOf('cur');
	const base = minOf('base');
	let maxRatio = 0, maxRatioKey = '', maxAbs = 0, maxAbsKey = '';
	for (const [k, v] of cur) {
		if (v > maxAbs) { maxAbs = v; maxAbsKey = k; }
		// Criterion 1 covers every configuration (§4.12): one without a positive baseline minimum cannot meet the ratio.
		const b = base.get(k);
		const ratio = b > 0 ? v / b : Infinity;
		if (ratio > maxRatio) { maxRatio = ratio; maxRatioKey = k; }
	}
	return { maxRatio, maxRatioKey, maxAbs, maxAbsKey };
}

/**
 * The configuration keys every round must hold for each tree: the child's loop (MISSIONS x periods x azimuths), in its
 * order. Kept in step with runChild by the harness tests (runChild itself is left unchanged so that its fingerprint,
 * and with it the saved rounds, stay valid).
 */
function expectedKeys(azimuths) {
	const keys = [];
	for (const [, , missionId, defMo] of MISSIONS) {
		const periods = [...new Set([defMo, ...(NEAR.has(missionId) ? [0.2, 0.5, 1, 12, 36] : [0.2, 1, 36])])];
		for (const mo of periods) for (const az of azimuths.split(',').map(Number)) keys.push(key({ m: missionId, mo, az }));
	}
	return keys;
}

/**
 * Throws unless round r (0-based) has the alternating order, two finite non-negative load samples and, for both trees,
 * exactly the expected configurations, each once with a finite non-negative time.
 */
function checkRound(round, r, keys) {
	const where = `round ${r + 1}`;
	if (!round || typeof round !== 'object') throw new Error(`${where} is not an object`);
	if (JSON.stringify(round.order) !== JSON.stringify(roundOrder(r))) {
		throw new Error(`${where} has order ${JSON.stringify(round.order)}, expected ${JSON.stringify(roundOrder(r))}`);
	}
	if (!Array.isArray(round.loads) || round.loads.length !== 2 || !round.loads.every(l => typeof l === 'number' && Number.isFinite(l) && l >= 0)) {
		throw new Error(`${where} needs two finite non-negative load samples`);
	}
	const want = new Set(keys);
	for (const t of ['cur', 'base']) {
		if (!Array.isArray(round[t])) throw new Error(`${where} has no ${t} measurements`);
		const seen = new Set();
		for (const o of round[t]) {
			const k = (o && typeof o === 'object') ? key(o) : String(o);
			if (!want.has(k)) throw new Error(`${where} ${t}: unexpected configuration ${k}`);
			if (seen.has(k)) throw new Error(`${where} ${t}: duplicate configuration ${k}`);
			if (typeof o.ms !== 'number' || !Number.isFinite(o.ms) || o.ms < 0) throw new Error(`${where} ${t}: invalid time for ${k}`);
			seen.add(k);
		}
		if (seen.size !== want.size) {
			throw new Error(`${where} ${t}: ${want.size - seen.size} of ${want.size} configurations missing (first: ${keys.find(k => !seen.has(k))})`);
		}
	}
}

/** Rounds required for a world (§4.12: SE and W7 at least --rounds-heavy (>= 6), the others at least --rounds (>= 3)). */
function requiredRounds(world, roundsHeavy, roundsLight) {
	return (world === 'SE' || world === 'W7') ? roundsHeavy : roundsLight;
}

/** Tree order of round r (0-based): this tree first on even rounds, the baseline first on odd rounds. */
const roundOrder = (r) => (r % 2 === 0) ? ['cur', 'base'] : ['base', 'cur'];

/**
 * Criteria for one world over all its rounds (each round: { cur, base, loads: [load before each tree] }).
 * `complete` is false while more rounds are needed: fewer than `required` rounds, or the load condition (half or more
 * of the rounds at load average <= LOAD_LIMIT) not yet met with fewer than `maxTotal` rounds. High-load rounds are
 * kept (§4.12 does not exclude them), so an unmet load condition is answered by adding rounds, never by replacing.
 */
function evaluateWorld(world, rounds, required, maxTotal = required) {
	const n = rounds.length;
	const loads = rounds.flatMap(r => r.loads);
	const lowLoadRounds = loads.filter(l => l <= LOAD_LIMIT).length / 2;
	const loadOk = n > 0 && lowLoadRounds >= n / 2;
	const complete = n >= required && (loadOk || n >= maxTotal);
	const e = { world, n, required, lowLoadRounds, loadOk, complete, crit1: false, crit2: false };
	if (n === 0) return e;
	const all = [...Array(n).keys()];
	const half = Math.floor(n / 2);
	const stats = [statistic(rounds, all), statistic(rounds, all.slice(0, half)), statistic(rounds, all.slice(half))];
	const s = stats[0];
	const ratios = stats.map(x => x.maxRatio);
	e.stat = s;
	e.variation = Math.max(...ratios) - Math.min(...ratios);
	e.margin = RATIO_LIMIT - s.maxRatio;
	e.crit1 = s.maxRatio <= RATIO_LIMIT && e.margin > e.variation;
	e.crit2 = ABS_LIMIT_MS[world] === undefined || s.maxAbs <= ABS_LIMIT_MS[world];
	e.loadMin = Math.min(...loads);
	e.loadMax = Math.max(...loads);
	return e;
}

/** One result line per world. */
function formatWorld(e) {
	const todo = e.complete ? '' : (e.n < e.required ? ` [incomplete: ${e.n}/${e.required} rounds, run again]`
		: ` [incomplete: load condition unmet after ${e.n} rounds, run again]`);
	if (e.n === 0) return `${e.world}: rounds=0${todo}`;
	const s = e.stat;
	return `${e.world}: rounds=${e.n} maxRatio=${s.maxRatio.toFixed(3)} (${s.maxRatioKey}) margin=${e.margin.toFixed(3)} variation=${e.variation.toFixed(3)} ` +
		`maxAbs=${Math.round(s.maxAbs)} ms (${s.maxAbsKey}) load=${e.loadMin.toFixed(2)}-${e.loadMax.toFixed(2)} lowLoadRounds=${e.lowLoadRounds} ` +
		`=> criterion1 ${e.crit1 ? 'OK' : 'NG'}, criterion2 ${e.crit2 ? 'OK' : 'NG'}, load ${e.loadOk ? 'OK' : 'NG (rerun on a quieter machine)'}${todo}`;
}

/**
 * md5 of what determines a tree's measured values: every file under scripts/ and presets/ and testsuites/test_helpers.mjs
 * (relative path and content, in sorted order). A missing entry is hashed as absent.
 */
function treeFingerprint(root) {
	const h = createHash('md5');
	const files = [];
	const walk = (rel) => {
		const abs = path.join(root, rel);
		if (!fs.existsSync(abs)) { files.push([rel, null]); return; }
		if (fs.statSync(abs).isDirectory()) {
			for (const name of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, name));
		} else {
			files.push([rel, abs]);
		}
	};
	for (const rel of ['scripts', 'presets', 'testsuites/test_helpers.mjs']) walk(rel);
	for (const [rel, abs] of files) {
		h.update(`${rel}\0`);
		h.update(abs === null ? '\u0001absent' : fs.readFileSync(abs));
		h.update('\0');
	}
	return h.digest('hex');
}

/** md5 of the measurement code itself (child mode and its configuration), so state is never mixed across harness changes. */
const harnessFingerprint = () => createHash('md5')
	.update(`${runChild.toString()}\0${measure.toString()}\0${JSON.stringify(MISSIONS)}\0${[...NEAR].join(',')}\0${MO}`)
	.digest('hex');

/**
 * The load sample taken before each tree: the 1-minute load average, or in the harness tests ROLLOUT_TIMING_TEST_LOAD
 * (a number, or @<file> whose content is read at each sample).
 */
const testLoad = () => process.env.ROLLOUT_TIMING_TEST_LOAD;
const sampleLoad = () => {
	const v = testLoad();
	if (v === undefined) return os.loadavg()[0];
	return Number(v.startsWith('@') ? fs.readFileSync(v.slice(1), 'utf8') : v);
};

/**
 * Loads the --state file, or starts a new one. The file records the fingerprints of both trees and the measurement code,
 * the azimuths and any test load; resuming with any of them changed throws, so rounds measured on different code are
 * never combined. Every saved round is checked with checkRound.
 */
function loadState(statePath, trees, azimuths) {
	const id = { version: 1, azimuths, harness: harnessFingerprint(), cur: treeFingerprint(trees.cur), base: treeFingerprint(trees.base), testLoad: testLoad() };
	if (!fs.existsSync(statePath)) return { ...id, baseline: trees.base, worlds: {} };
	let s;
	try {
		s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
	} catch (err) {
		throw new Error(`state file ${statePath} is not valid JSON (${err.message})`);
	}
	if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`state file ${statePath} is not an object`);
	for (const k of Object.keys(id)) {
		if (s[k] !== id[k]) throw new Error(`state file ${statePath} was recorded with a different ${k} (${s[k]} != ${id[k]}); use a new --state file`);
	}
	if (!s.worlds || typeof s.worlds !== 'object' || Array.isArray(s.worlds)) throw new Error(`state file ${statePath} has no worlds`);
	const keys = expectedKeys(azimuths);
	for (const [world, rounds] of Object.entries(s.worlds)) {
		if (!WORLDS.includes(world) || !Array.isArray(rounds)) throw new Error(`state file ${statePath} has an invalid world ${world}`);
		rounds.forEach((round, r) => {
			try {
				checkRound(round, r, keys);
			} catch (err) {
				throw new Error(`state file ${statePath}: ${world} ${err.message}`);
			}
		});
	}
	return s;
}

/** Writes the state atomically (a crash leaves the previous file). */
function saveState(statePath, state) {
	const tmp = `${statePath}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state));
	fs.renameSync(tmp, statePath);
}

function usage() {
	console.error('usage: node testsuites/perf/rollout_timing.mjs --baseline <main-branch checkout> [--worlds SE,W7,SS,BIN,TB] ' +
		'[--rounds-heavy 6] [--rounds 3] [--azimuths 0,90,180,270] [--state <file> [--max-rounds <n>] [--max-total <n>]]');
	process.exit(2);
}

/** Integer option value, or undefined when the option is absent; a missing, non-integer or too small value is a usage error. */
function intOption(name, min) {
	if (!process.argv.includes(name)) return undefined;
	const v = argValue(name, '');
	const n = Number(v);
	if (v.trim() === '' || !Number.isInteger(n) || n < min) usage();
	return n;
}

/** The parent run; returns the exit code. */
function parentMain() {
	const baseline = argValue('--baseline', null);
	if (!baseline || !fs.existsSync(path.join(baseline, 'scripts', 'gravsim_calc_predictor.js'))) usage();
	const worlds = argValue('--worlds', WORLDS.join(',')).split(',');
	if (worlds.some(w => !WORLDS.includes(w))) usage();
	const roundsHeavy = intOption('--rounds-heavy', 6) ?? 6;
	const roundsLight = intOption('--rounds', 3) ?? 3;
	const azimuths = argValue('--azimuths', '0,90,180,270');
	const trees = { cur: REPO, base: path.resolve(baseline) };
	const statePath = process.argv.includes('--state') ? argValue('--state', '') : null;
	if (statePath !== null && (statePath === '' || statePath.startsWith('--'))) usage();
	const maxRounds = intOption('--max-rounds', 0);
	const maxTotalOption = intOption('--max-total', 1);
	if (statePath === null && (maxRounds !== undefined || maxTotalOption !== undefined)) usage();
	if (testLoad() !== undefined) process.stderr.write(`ROLLOUT_TIMING_TEST_LOAD=${testLoad()}: load samples are not measured (harness tests only)\n`);
	const state = statePath !== null ? loadState(path.resolve(statePath), trees, azimuths) : { worlds: {} };
	const keys = expectedKeys(azimuths);
	let budget = maxRounds ?? Infinity;
	let ok = true, incomplete = false;
	for (const world of worlds) {
		const required = requiredRounds(world, roundsHeavy, roundsLight);
		const maxTotal = statePath !== null ? Math.max(required, maxTotalOption ?? 3 * required) : required;
		const rounds = state.worlds[world] ??= [];
		while (budget > 0 && !evaluateWorld(world, rounds, required, maxTotal).complete) {
			const r = rounds.length;
			const round = { order: roundOrder(r), loads: [] };
			for (const t of round.order) {
				round.loads.push(sampleLoad());
				round[t] = measure(trees[t], world, azimuths);
			}
			try {
				checkRound(round, r, keys);
			} catch (err) {
				throw new Error(`${world} ${err.message} (the round is not saved)`);
			}
			round.finishedAt = new Date().toISOString();
			rounds.push(round);
			budget--;
			if (statePath !== null) saveState(path.resolve(statePath), state);
			process.stderr.write(`  ${world} round ${r + 1} done (required ${required}, load ${sampleLoad().toFixed(2)})\n`);
		}
		const e = evaluateWorld(world, rounds, required, maxTotal);
		console.log(formatWorld(e));
		if (!e.complete) incomplete = true;
		else ok = ok && e.crit1 && e.crit2 && e.loadOk;
	}
	return incomplete ? 3 : (ok ? 0 : 1);
}

/** Runs the parent and exits; state-file and measurement errors (thrown) exit 2 with their message. */
function runParent() {
	let code;
	try {
		code = parentMain();
	} catch (err) {
		console.error(err.message);
		code = 2;
	}
	process.exit(code);
}

export {
	requiredRounds, roundOrder, statistic, expectedKeys, checkRound, evaluateWorld, formatWorld, treeFingerprint, harnessFingerprint,
	loadState, saveState, LOAD_LIMIT, RATIO_LIMIT, ABS_LIMIT_MS, WORLDS
};

const invokedPath = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (invokedPath === fs.realpathSync(SELF)) {
	if (process.argv.includes('--child')) {
		await runChild();
	} else {
		runParent();
	}
}
