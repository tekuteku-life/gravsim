/**
 * Unit Test Suite 13: the preset snapshot cache.
 *
 * Specification: docs/design/2026-11-23_vapor_cone_rcs_anchors.md (Rev 22) §1.4.1 (g), R10, §3.11 items 1-6 (with the
 * §3.11-5 call-site table) and the test plan §5.1-11.
 *
 * Expected values are computed independently of the cache, the way main built them: JSON deep copies of the stored
 * records (old* helpers below). The legacy preset list is rebuilt with main's getLegacyPresets body, which calls the two
 * builders (_buildLegacyPresets, _buildLegacyPresetFromVehicle) that the branch did not change.
 * Rebuilds and copies are counted deterministically (calls of the builders and of getCelestial), never timed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse, createMockCelestialBody, createMockElement } from '../test_helpers.mjs';

setupMockDOM();

import { PresetManager, presetManager, ROCKET_VISUAL, ROCKET_FUELS, MULTISTAGE_PRESETS } from '../../scripts/gravsim_preset_manager.js';
import { PhysicsEngine } from '../../scripts/gravsim_calc.js';
import { PredictorPhysicsEngine } from '../../scripts/gravsim_calc_predictor.js';
import { CalcRocket, CalcDebris, CalcCelestialBody } from '../../scripts/gravsim_calc_object.js';
import { FlightComputer } from '../../scripts/gravsim_flight_computer.js';
import { Rocket, CelestialBody } from '../../scripts/gravsim_object.js';
import { RocketRenderer } from '../../scripts/gravsim_rocket_renderer.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { ObjectPlacer } from '../../scripts/gravsim_object_placer.js';
import { NaviTab } from '../../scripts/gravsim_tab_navi.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { OBJECT_TYPES, PHYSICS, RENDER } from '../../scripts/gravsim_const.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The 8 preset tables of PresetManager (§3.11-1) */
const TABLES = Object.freeze(['vehicles', 'payloads', 'missions', 'celestials', 'celestialKeyMap', 'fuels', 'themes', 'visuals']);
/** The cache limit of peekObjectParam (§3.11-5) */
const PEEK_LIMIT = 512;

const jsonCopy = (v) => JSON.parse(JSON.stringify(v));

/** main's getFuelsMap: a JSON copy of every stored fuel */
const oldFuelsMap = (pm) => {
	const map = {};
	for (const [k, v] of pm.fuels.entries()) { map[k] = jsonCopy(v); }
	return map;
};
/** main's getPlumesMap: THRUST_THRESHOLD and a JSON copy of each stored fuel's plume (fuels without one are left out) */
const oldPlumesMap = (pm) => {
	const map = { THRUST_THRESHOLD: 0.01 };
	for (const [k, v] of pm.fuels.entries()) {
		if (v.plume) { map[k] = jsonCopy(v.plume); }
	}
	return map;
};
/** main's getThemesMap */
const oldThemesMap = (pm) => {
	const map = {};
	for (const [k, v] of pm.themes.entries()) { map[k] = jsonCopy(v); }
	return map;
};
/** main's getRocketVisual */
const oldRocketVisual = (pm) => ({
	...jsonCopy(pm.visuals.get('rocket') || {}),
	PLUMES: oldPlumesMap(pm),
	THEMES: oldThemesMap(pm)
});
/** main's getLegacyPresets body (an unfrozen list, rebuilt on every call) */
const oldLegacyPresets = (pm) => {
	const base = pm._buildLegacyPresets();
	base.H3_30 = base.H3;
	for (const [id, vehicle] of pm.vehicles.entries()) {
		const upperKey = String(id).toUpperCase();
		if (!base[upperKey]) {
			base[upperKey] = pm._buildLegacyPresetFromVehicle(vehicle, upperKey);
		}
	}
	return base;
};
/** main's getObjectParam (getCelestial): the lookup order of the stored tables and a JSON copy */
const oldObjectParam = (pm, idOrName) => {
	if (!idOrName) { return null; }
	const query = String(idOrName).trim();
	const lower = query.toLowerCase();
	const found = pm.celestials.get(query)
		|| pm.celestials.get(lower)
		|| pm.celestialKeyMap.get(query)
		|| Array.from(pm.celestials.values()).find(c => c.name?.toLowerCase() === lower || c.key?.toLowerCase() === lower)
		|| null;
	return found ? jsonCopy(found) : null;
};

/** The five cached snapshots of a preset manager (§3.11-2) */
const snapshot = (pm) => ({
	rocketVisual: pm.getRocketVisual(),
	fuelsMap: pm.getFuelsMap(),
	plumesMap: pm.getPlumesMap(),
	themesMap: pm.getThemesMap(),
	legacyPresets: pm.getLegacyPresets()
});
const SNAPSHOT_KEYS = Object.freeze(['rocketVisual', 'fuelsMap', 'plumesMap', 'themesMap', 'legacyPresets']);

const assertSnapshotMatchesOldBuild = (pm, snap, label = '') => {
	assert.deepStrictEqual(snap.rocketVisual, oldRocketVisual(pm), `${label} getRocketVisual equals the old build`);
	assert.deepStrictEqual(snap.fuelsMap, oldFuelsMap(pm), `${label} getFuelsMap equals the old build`);
	assert.deepStrictEqual(snap.plumesMap, oldPlumesMap(pm), `${label} getPlumesMap equals the old build`);
	assert.deepStrictEqual(snap.themesMap, oldThemesMap(pm), `${label} getThemesMap equals the old build`);
	assert.deepStrictEqual(snap.legacyPresets, oldLegacyPresets(pm), `${label} getLegacyPresets equals the old build`);
};

/** Paths of the objects / arrays reachable from value that are (frozen === true) or are not (frozen === false) frozen */
const pathsByFrozen = (value, frozen, path = '$', seen = new Set(), out = []) => {
	if (value === null || typeof value !== 'object' || seen.has(value)) { return out; }
	seen.add(value);
	if (Object.isFrozen(value) === frozen) { out.push(path); }
	for (const k of Object.keys(value)) { pathsByFrozen(value[k], frozen, `${path}.${k}`, seen, out); }
	return out;
};
const assertDeepFrozen = (value, label) => {
	assert.ok(value !== null && typeof value === 'object', `${label} is an object`);
	assert.deepStrictEqual(pathsByFrozen(value, false), [], `${label}: every nested object and array is frozen`);
};
const assertNothingFrozen = (value, label) => {
	assert.deepStrictEqual(pathsByFrozen(value, true), [], `${label}: nothing is frozen`);
};
const assertStoredTablesNotFrozen = (pm) => {
	for (const t of TABLES) {
		for (const [k, v] of pm[t].entries()) { assertNothingFrozen(v, `${t}.get(${JSON.stringify(k)})`); }
	}
};

/** Count the calls of obj[method] (optionally only those whose arguments pass filter); restore() puts it back */
const spyOn = (obj, method, filter = null) => {
	const had = Object.prototype.hasOwnProperty.call(obj, method);
	const original = obj[method];
	const spy = {
		count: 0,
		restore() {
			if (had) { obj[method] = original; } else { delete obj[method]; }
		}
	};
	obj[method] = function (...args) {
		if (!filter || filter(...args)) { spy.count++; }
		return original.apply(this, args);
	};
	return spy;
};

/** Run fn with globalThis.__presetManager (read by CelestialBody, Rocket and FlightComputer) set to pm */
const withGlobalPresetManager = (pm, fn) => {
	const saved = globalThis.__presetManager;
	globalThis.__presetManager = pm;
	try {
		return fn();
	} finally {
		globalThis.__presetManager = saved;
	}
};

/** A mock 2D context that records the drawing calls the readers' values reach */
const recordingCtx = () => {
	const ctx = createMockElement('canvas').getContext('2d');
	const calls = [];
	for (const name of ['moveTo', 'lineTo', 'arc', 'createRadialGradient', 'fillText', 'translate']) {
		const original = ctx[name];
		ctx[name] = (...args) => {
			calls.push([name, ...args]);
			return original(...args);
		};
	}
	ctx.calls = calls;
	return ctx;
};

/** A mock universe wired like Universe: getObjectParams / getLegacyPreset delegate to its presetManager */
const realLikeUniverse = (pm, objects = []) => createMockUniverse({
	objects,
	presetManager: pm,
	getObjectParams: (name) => pm.getObjectParam(name),
	getLegacyPreset: (key) => pm.getLegacyPreset(key)
});

const makeLauncher = (pm, objects = []) => {
	const universe = realLikeUniverse(pm, objects);
	const launcher = new RocketLauncher(universe);
	launcher.requestPreviewUpdate = () => {};
	return { universe, launcher };
};

/** Remove the Rocket record (id 'rocket', key and name 'Rocket') from a preset manager */
const removeRocketRecord = (pm) => {
	pm.celestials.delete('rocket');
	pm.celestialKeyMap.delete('Rocket');
	assert.equal(oldObjectParam(pm, 'Rocket'), null, 'the Rocket record is gone');
};

/** Fresh mock document (element registry per document), as unit suite 09 */
const freshDom = () => {
	delete globalThis.document;
	setupMockDOM();
};

const massSelect = () => document.getElementById('mass-select');

beforeEach(() => {
	EventBus.clearAll();
});

// ---------------------------------------------------------------------------
// §3.11-1 VersionedMap and the version number
// ---------------------------------------------------------------------------

describe('§3.11-1 VersionedMap: every preset table reports set, delete and clear', () => {
	it('each of the 8 tables is a Map whose set, delete (also of a missing key) and clear bump the version by one', () => {
		const pm = new PresetManager();
		for (const t of TABLES) {
			const map = pm[t];
			assert.ok(map instanceof Map, `${t} is a Map`);

			let v = pm._derivedVersion;
			assert.equal(map.set('__probe__', { id: '__probe__' }), map, `${t}.set returns the map`);
			assert.equal(pm._derivedVersion, v + 1, `${t}.set bumps the version`);
			assert.equal(map.has('__probe__'), true);
			assert.deepStrictEqual(map.get('__probe__'), { id: '__probe__' });

			v = pm._derivedVersion;
			assert.equal(map.set('__probe__', map.get('__probe__')), map);
			assert.equal(pm._derivedVersion, v + 1, `${t}.set with the same value bumps the version`);

			v = pm._derivedVersion;
			assert.equal(map.delete('__probe__'), true, `${t}.delete of a present key returns true`);
			assert.equal(pm._derivedVersion, v + 1, `${t}.delete bumps the version`);
			assert.equal(map.has('__probe__'), false);

			v = pm._derivedVersion;
			assert.equal(map.delete('__probe__'), false, `${t}.delete of a missing key returns false`);
			assert.equal(pm._derivedVersion, v + 1, `${t}.delete of a missing key bumps the version`);

			v = pm._derivedVersion;
			assert.equal(map.clear(), undefined);
			assert.equal(pm._derivedVersion, v + 1, `${t}.clear bumps the version once`);
			assert.equal(map.size, 0, `${t} is empty after clear`);

			v = pm._derivedVersion;
			map.clear();
			assert.equal(pm._derivedVersion, v + 1, `${t}.clear of an empty table bumps the version`);
		}
	});

	it('the tables behave as a Map: the same contents and order as a plain Map given the same operations', () => {
		const pm = new PresetManager({ skipDiskLoad: true });
		for (const t of TABLES) {
			const map = pm[t];
			const plain = new Map(map);
			for (const [k, v] of [['b', 2], ['a', 1], ['c', 3], ['b', 4]]) {
				map.set(k, v);
				plain.set(k, v);
			}
			map.delete('a');
			plain.delete('a');
			assert.equal(map.size, plain.size, `${t}.size`);
			assert.deepStrictEqual([...map.keys()], [...plain.keys()], `${t}.keys`);
			assert.deepStrictEqual([...map.values()], [...plain.values()], `${t}.values`);
			assert.deepStrictEqual([...map.entries()], [...plain.entries()], `${t}.entries`);
			assert.deepStrictEqual([...map], [...plain], `${t} iteration`);
			const forEachSeen = [];
			map.forEach((v, k) => forEachSeen.push([k, v]));
			assert.deepStrictEqual(forEachSeen, [...plain.entries()], `${t}.forEach`);
			assert.equal(map.get('b'), 4);
			assert.equal(map.get('a'), undefined);
		}
	});

	it('reads of the tables and of every snapshot do not change the version', () => {
		const pm = new PresetManager();
		const v = pm._derivedVersion;
		for (const t of TABLES) {
			const map = pm[t];
			map.get('earth');
			map.has('earth');
			void [...map.entries(), ...map.values(), ...map.keys(), ...map];
			void map.size;
			map.forEach(() => {});
		}
		snapshot(pm);
		pm.peekObjectParam('Earth');
		pm.peekObjectParam('No Such Body');
		pm.getObjectParam('Earth');
		pm.getLegacyPreset('H3_22');
		pm.getLegacyPreset('NOT_LISTED');
		pm.getFuel('liquid');
		pm.getFuels();
		pm.getPlume('hydro');
		pm.getTheme('orange');
		assert.equal(pm._derivedVersion, v);
	});
});

// ---------------------------------------------------------------------------
// §3.11-2 Cached getters: identity and values (normal path)
// ---------------------------------------------------------------------------

describe('§3.11-2 cached getters while the version is unchanged', () => {
	it('the five getters return the same object (===) on every call, equal to the old JSON build', () => {
		const pm = new PresetManager();
		const a = snapshot(pm);
		const b = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) {
			assert.strictEqual(b[k], a[k], `${k} returns the same object`);
		}
		assertSnapshotMatchesOldBuild(pm, a);
		// The shipped presets are what the snapshots hold (the tables are populated)
		assert.deepStrictEqual(Object.keys(a.fuelsMap), ['liquid', 'hydro', 'solid', 'ion']);
		assert.deepStrictEqual(Object.keys(a.legacyPresets), ['H3', 'H3_30', 'H3_22', 'H3_24', 'FALCON9', 'EPSILON', 'SSTO']);
		assert.equal(a.rocketVisual.LOD_RADIUS_THRESHOLD, pm.visuals.get('rocket').LOD_RADIUS_THRESHOLD);
	});

	it('getLegacyPresets keeps the H3_30 === H3 alias', () => {
		const pm = new PresetManager();
		const list = pm.getLegacyPresets();
		assert.strictEqual(list.H3_30, list.H3);
		assert.equal(list.H3.id, 'H3');
		assert.strictEqual(pm.getLegacyPreset('H3_30'), list.H3);
		assert.strictEqual(pm.getLegacyPreset('h3'), list.H3);
	});

	it('each preset manager has its own cache: a change of one rebuilds none of the other', () => {
		const pm1 = new PresetManager();
		const pm2 = new PresetManager();
		const s2 = snapshot(pm2);
		const e2 = pm2.peekObjectParam('Earth');
		const v2 = pm2._derivedVersion;
		snapshot(pm1);
		pm1.fuels.set('liquid', { ...jsonCopy(pm1.fuels.get('liquid')), isp: 1 });
		pm1.celestials.set('earth', { ...jsonCopy(pm1.celestials.get('earth')), RADIUS: 1, radius: 1 });
		assert.equal(pm1.getFuelsMap().liquid.isp, 1);
		assert.equal(pm1.peekObjectParam('Earth').RADIUS, 1);
		assert.equal(pm2._derivedVersion, v2);
		const s2b = snapshot(pm2);
		for (const k of SNAPSHOT_KEYS) { assert.strictEqual(s2b[k], s2[k], `pm2 ${k} kept`); }
		assert.strictEqual(pm2.peekObjectParam('Earth'), e2);
		assert.equal(e2.RADIUS, pm2.celestials.get('earth').RADIUS);
	});

	it('changing a stored record in place does not bump the version: the snapshot keeps the old value until set() puts it back', () => {
		const pm = new PresetManager();
		const before = pm.getFuelsMap();
		const isp = pm.fuels.get('liquid').isp;
		const v = pm._derivedVersion;
		pm.fuels.get('liquid').isp = isp + 100;
		assert.equal(pm._derivedVersion, v);
		assert.strictEqual(pm.getFuelsMap(), before);
		assert.equal(pm.getFuelsMap().liquid.isp, isp);
		pm.fuels.set('liquid', pm.fuels.get('liquid'));
		assert.equal(pm._derivedVersion, v + 1);
		assert.notStrictEqual(pm.getFuelsMap(), before);
		assert.equal(pm.getFuelsMap().liquid.isp, isp + 100);
	});
});

// ---------------------------------------------------------------------------
// Version bumps on each of the 8 tables rebuild every cache
// ---------------------------------------------------------------------------

/** Names whose peek value each change can reach: an id, a key / name, and an alias that exists only after a key map set */
const PEEK_NAMES = Object.freeze(['Earth', 'earth', 'Terra', 'Rocket']);

/** Per table and operation: the change, and what of it the rebuilt snapshots must show */
const TABLE_OPS = {
	vehicles: {
		set: {
			apply: (pm) => pm.vehicles.set('zz_test', { ...jsonCopy(pm.vehicles.get('h3_30')), id: 'zz_test', name: 'ZZ Test' }),
			check: (before, after) => {
				assert.equal('ZZ_TEST' in before.legacyPresets, false);
				assert.equal(after.legacyPresets.ZZ_TEST.name, 'ZZ Test');
			}
		},
		delete: {
			apply: (pm) => pm.vehicles.delete('falcon9'),
			check: (before, after) => {
				assert.equal('FALCON9' in before.legacyPresets, true);
				assert.equal('FALCON9' in after.legacyPresets, false);
			}
		},
		clear: {
			apply: (pm) => pm.vehicles.clear(),
			check: (before, after) => {
				assert.deepStrictEqual(Object.keys(after.legacyPresets), ['H3', 'H3_30']);
				assert.strictEqual(after.legacyPresets.H3_30, after.legacyPresets.H3);
			}
		}
	},
	payloads: {
		set: {
			apply: (pm) => pm.payloads.set('htv_x', { ...jsonCopy(pm.payloads.get('htv_x')), name: 'Renamed Cargo' }),
			check: (before, after) => assert.equal(after.legacyPresets.H3.payload.name, 'Renamed Cargo')
		},
		delete: {
			apply: (pm) => pm.payloads.delete('htv_x'),
			check: (before, after) => {
				assert.equal(before.legacyPresets.H3.payload.name, 'HTV-X Space Station Cargo Transfer');
				assert.equal(after.legacyPresets.H3.payload.name, 'HTV-X Cargo');
			}
		},
		clear: {
			apply: (pm) => pm.payloads.clear(),
			check: (before, after) => assert.equal(after.legacyPresets.H3.payload.name, 'HTV-X Cargo')
		}
	},
	missions: {
		set: {
			apply: (pm) => pm.missions.set('iss_rendezvous', {
				...jsonCopy(pm.missions.get('iss_rendezvous')),
				flightProfile: [{ type: 'alt', value: 0, thrust: 100, angle: 0 }]
			}),
			check: (before, after) => assert.deepStrictEqual(after.legacyPresets.H3.flightProfile, [{ type: 'alt', value: 0, thrust: 100, angle: 0 }])
		},
		delete: {
			apply: (pm) => pm.missions.delete('iss_rendezvous'),
			check: (before, after) => {
				assert.ok(before.legacyPresets.H3.flightProfile.length > 0);
				assert.deepStrictEqual(after.legacyPresets.H3.flightProfile, []);
			}
		},
		clear: {
			apply: (pm) => pm.missions.clear(),
			check: (before, after) => {
				assert.deepStrictEqual(after.legacyPresets.H3.flightProfile, []);
				assert.notDeepStrictEqual(after.legacyPresets.FALCON9, before.legacyPresets.FALCON9);
			}
		}
	},
	celestials: {
		set: {
			apply: (pm) => pm.celestials.set('earth', { ...jsonCopy(pm.celestials.get('earth')), RADIUS: 1234, radius: 1234 }),
			check: (before, after, peekBefore, peekAfter) => {
				assert.equal(peekBefore.Earth.RADIUS, 6378000);
				assert.equal(peekAfter.Earth.RADIUS, 1234);
				assert.equal(peekAfter.earth.RADIUS, 1234);
			}
		},
		delete: {
			apply: (pm) => pm.celestials.delete('earth'),
			check: (before, after, peekBefore, peekAfter) => {
				assert.equal(peekBefore.earth.NAME, 'Earth');
				assert.equal(peekAfter.earth, null);
			}
		},
		clear: {
			apply: (pm) => pm.celestials.clear(),
			check: (before, after, peekBefore, peekAfter) => {
				assert.equal(peekAfter.earth, null);
				assert.equal(peekAfter.Rocket.NAME, 'Rocket', 'still found through celestialKeyMap');
			}
		}
	},
	celestialKeyMap: {
		set: {
			apply: (pm) => pm.celestialKeyMap.set('Terra', pm.celestials.get('earth')),
			check: (before, after, peekBefore, peekAfter) => {
				assert.equal(peekBefore.Terra, null);
				assert.equal(peekAfter.Terra.NAME, 'Earth');
			}
		},
		delete: {
			apply: (pm) => pm.celestialKeyMap.delete('Earth'),
			check: (before, after, peekBefore, peekAfter) => {
				assert.notStrictEqual(peekAfter.Earth, peekBefore.Earth);
				assert.deepStrictEqual(peekAfter.Earth, peekBefore.Earth);
			}
		},
		clear: {
			apply: (pm) => pm.celestialKeyMap.clear(),
			check: (before, after, peekBefore, peekAfter) => {
				assert.notStrictEqual(peekAfter.Rocket, peekBefore.Rocket);
				assert.deepStrictEqual(peekAfter.Rocket, peekBefore.Rocket);
			}
		}
	},
	fuels: {
		set: {
			apply: (pm) => pm.fuels.set('cold', { id: 'cold', name: 'Cold Gas', isp: 70, plume: { lenMult: 1.5, colors: ['#fff'] } }),
			check: (before, after) => {
				assert.equal(after.fuelsMap.cold.isp, 70);
				assert.deepStrictEqual(after.plumesMap.cold, { lenMult: 1.5, colors: ['#fff'] });
				assert.deepStrictEqual(after.rocketVisual.PLUMES.cold, { lenMult: 1.5, colors: ['#fff'] });
			}
		},
		delete: {
			apply: (pm) => pm.fuels.delete('ion'),
			check: (before, after) => {
				assert.equal('ion' in before.fuelsMap, true);
				assert.equal('ion' in after.fuelsMap, false);
				assert.equal('ion' in after.plumesMap, false);
				assert.equal('ion' in after.rocketVisual.PLUMES, false);
			}
		},
		clear: {
			apply: (pm) => pm.fuels.clear(),
			check: (before, after) => {
				assert.deepStrictEqual(after.fuelsMap, {});
				assert.deepStrictEqual(after.plumesMap, { THRUST_THRESHOLD: 0.01 });
				assert.deepStrictEqual(after.rocketVisual.PLUMES, { THRUST_THRESHOLD: 0.01 });
			}
		}
	},
	themes: {
		set: {
			apply: (pm) => pm.themes.set('neon', { ...jsonCopy(pm.themes.get('orange')), accentBand: '#00ff00' }),
			check: (before, after) => {
				assert.equal('neon' in before.themesMap, false);
				assert.equal(after.themesMap.neon.accentBand, '#00ff00');
				assert.equal(after.rocketVisual.THEMES.neon.accentBand, '#00ff00');
			}
		},
		delete: {
			apply: (pm) => pm.themes.delete('blue'),
			check: (before, after) => {
				assert.equal('blue' in before.themesMap, true);
				assert.equal('blue' in after.themesMap, false);
				assert.equal('blue' in after.rocketVisual.THEMES, false);
			}
		},
		clear: {
			apply: (pm) => pm.themes.clear(),
			check: (before, after) => {
				assert.deepStrictEqual(after.themesMap, {});
				assert.deepStrictEqual(after.rocketVisual.THEMES, {});
			}
		}
	},
	visuals: {
		set: {
			apply: (pm) => pm.visuals.set('rocket', { ...jsonCopy(pm.visuals.get('rocket')), MIN_SCREEN_RADIUS: 9.25 }),
			check: (before, after) => {
				assert.notEqual(before.rocketVisual.MIN_SCREEN_RADIUS, 9.25);
				assert.equal(after.rocketVisual.MIN_SCREEN_RADIUS, 9.25);
			}
		},
		delete: {
			apply: (pm) => pm.visuals.delete('rocket'),
			check: (before, after) => assert.deepStrictEqual(Object.keys(after.rocketVisual), ['PLUMES', 'THEMES'])
		},
		clear: {
			apply: (pm) => pm.visuals.clear(),
			check: (before, after) => assert.deepStrictEqual(Object.keys(after.rocketVisual), ['PLUMES', 'THEMES'])
		}
	}
};

describe('§3.11-1/2 a set, delete or clear of any table bumps the version and rebuilds every cache with the new values', () => {
	for (const table of TABLES) {
		for (const op of ['set', 'delete', 'clear']) {
			it(`${table}.${op}`, () => {
				const pm = new PresetManager();
				const before = snapshot(pm);
				const peekBefore = Object.fromEntries(PEEK_NAMES.map(n => [n, pm.peekObjectParam(n)]));
				const v = pm._derivedVersion;

				TABLE_OPS[table][op].apply(pm);
				assert.equal(pm._derivedVersion, v + 1, 'the version is bumped once');

				const after = snapshot(pm);
				for (const k of SNAPSHOT_KEYS) {
					assert.notStrictEqual(after[k], before[k], `${k} is rebuilt`);
					assertDeepFrozen(after[k], `rebuilt ${k}`);
					assert.strictEqual(snapshot(pm)[k], after[k], `${k} is cached again`);
				}
				assertSnapshotMatchesOldBuild(pm, after, `${table}.${op}:`);

				// peekObjectParam rebuilds every cached name (one search each), then caches it again
				const searches = spyOn(pm, 'getCelestial');
				let peekAfter;
				try {
					peekAfter = Object.fromEntries(PEEK_NAMES.map(n => [n, pm.peekObjectParam(n)]));
					assert.equal(searches.count, PEEK_NAMES.length, 'each cached name is looked up again');
					for (const n of PEEK_NAMES) { assert.strictEqual(pm.peekObjectParam(n), peekAfter[n], `peek ${n} cached again`); }
					assert.equal(searches.count, PEEK_NAMES.length, 'and then cached');
				} finally {
					searches.restore();
				}
				for (const n of PEEK_NAMES) {
					assert.deepStrictEqual(peekAfter[n], oldObjectParam(pm, n), `peek ${n} equals the old getObjectParam`);
					if (peekAfter[n] !== null) {
						assert.notStrictEqual(peekAfter[n], peekBefore[n], `peek ${n} is a new object`);
						assertDeepFrozen(peekAfter[n], `peek ${n}`);
					}
				}

				TABLE_OPS[table][op].check(before, after, peekBefore, peekAfter);
				assertStoredTablesNotFrozen(pm);
			});
		}
	}

	it('a fuel change rebuilds the legacy list with the flight plan of the new fuel (vehicles, payloads, missions and fuels feed it)', () => {
		const pm = new PresetManager();
		pm.fuels.set('zzfuel', { id: 'zzfuel', name: 'ZZ Fuel', isp: 300, ispVac: 300, ofRatio: 3 });
		pm.vehicles.set('zz_fuel', {
			id: 'zz_fuel', name: 'ZZ Fuel Vehicle', lengthM: 30, colorTheme: 'classic',
			stages: [{ stageNumber: 1, name: 'Core', fuelType: 'zzfuel', thrustKN: 1000, dryMassT: 5, fuelMassT: 10, oxidMassT: 30, burnTime: 0 }]
		});
		const before = pm.getLegacyPresets();
		assert.equal(before.ZZ_FUEL.stages[0].fuelMassT, 10);
		assert.equal(before.ZZ_FUEL.stages[0].oxidMassT, 30);

		pm.fuels.set('zzfuel', { id: 'zzfuel', name: 'ZZ Fuel', isp: 150, ispVac: 150, ofRatio: 1 });
		const after = pm.getLegacyPresets();
		assert.notStrictEqual(after, before);
		assert.equal(after.ZZ_FUEL.stages[0].fuelMassT, 20);
		assert.equal(after.ZZ_FUEL.stages[0].oxidMassT, 20);
		// The sizing's burn time (40 t at 1000 kN), rounded to 0.1 s
		const burnTime = (isp) => Math.round(((40 * 1000 * isp * PHYSICS.G0) / (1000 * 1000)) * 10) / 10;
		assert.equal(before.ZZ_FUEL.stages[0].burnTime, burnTime(300));
		assert.equal(after.ZZ_FUEL.stages[0].burnTime, burnTime(150));
		assert.deepStrictEqual(after, oldLegacyPresets(pm));
	});
});

// ---------------------------------------------------------------------------
// §3.11-3 Deep freeze
// ---------------------------------------------------------------------------

describe('§3.11-3 returned snapshots are deeply frozen; the stored records are not', () => {
	it('writes, deletes, additions and push on every snapshot and nested object throw; the tables and the next snapshot are unchanged', () => {
		const pm = new PresetManager();
		const snap = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) { assertDeepFrozen(snap[k], k); }

		const storedMinRadius = pm.visuals.get('rocket').MIN_SCREEN_RADIUS;
		const storedTwoStage = pm.visuals.get('rocket').ALIGNMENT.NOZZLE_BOTTOM_OFFSET.TWO_STAGE;
		const storedColors = jsonCopy(pm.fuels.get('liquid').plume.colors);
		const storedEarthRadius = pm.celestials.get('earth').RADIUS;

		assert.throws(() => { snap.rocketVisual.MIN_SCREEN_RADIUS = 99; }, TypeError);
		assert.throws(() => { snap.rocketVisual.ALIGNMENT.NOZZLE_BOTTOM_OFFSET.TWO_STAGE = 99; }, TypeError);
		assert.throws(() => { delete snap.rocketVisual.MODULES; }, TypeError);
		assert.throws(() => { snap.rocketVisual.NEW_KEY = 1; }, TypeError);
		assert.throws(() => { snap.rocketVisual.PLUMES.liquid.colors.push('#fff'); }, TypeError);
		assert.throws(() => { snap.rocketVisual.PLUMES.liquid.colors[0] = '#000'; }, TypeError);
		assert.throws(() => { snap.rocketVisual.THEMES.orange.accentBand = '#000'; }, TypeError);
		assert.throws(() => { snap.fuelsMap.liquid.isp = 1; }, TypeError);
		assert.throws(() => { delete snap.fuelsMap.liquid; }, TypeError);
		assert.throws(() => { snap.fuelsMap.cold = {}; }, TypeError);
		assert.throws(() => { snap.plumesMap.THRUST_THRESHOLD = 0.5; }, TypeError);
		assert.throws(() => { snap.plumesMap.hydro.colors.push('#fff'); }, TypeError);
		assert.throws(() => { snap.themesMap.orange.accentBand = '#000'; }, TypeError);
		assert.throws(() => { delete snap.themesMap.blue; }, TypeError);
		assert.throws(() => { snap.legacyPresets.H3.stages.push({}); }, TypeError);
		assert.throws(() => { snap.legacyPresets.H3_22.stages[0].fuelMassT = 1; }, TypeError);
		assert.throws(() => { snap.legacyPresets.H3_22.boosters.count = 9; }, TypeError);
		assert.throws(() => { snap.legacyPresets.FALCON9.flightProfile.length = 0; }, TypeError);
		assert.throws(() => { delete snap.legacyPresets.FALCON9; }, TypeError);

		assert.equal(pm.visuals.get('rocket').MIN_SCREEN_RADIUS, storedMinRadius);
		assert.equal(pm.visuals.get('rocket').ALIGNMENT.NOZZLE_BOTTOM_OFFSET.TWO_STAGE, storedTwoStage);
		assert.deepStrictEqual(pm.fuels.get('liquid').plume.colors, storedColors);
		const next = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) { assert.strictEqual(next[k], snap[k], `${k} is the same snapshot`); }
		assertSnapshotMatchesOldBuild(pm, next);

		const earth = pm.peekObjectParam('Earth');
		assertDeepFrozen(earth, 'peekObjectParam(Earth)');
		assert.throws(() => { earth.RADIUS = 1; }, TypeError);
		assert.throws(() => { delete earth.NAME; }, TypeError);
		assert.equal(pm.celestials.get('earth').RADIUS, storedEarthRadius);
		assert.strictEqual(pm.peekObjectParam('Earth'), earth);
		assert.deepStrictEqual(earth, oldObjectParam(pm, 'Earth'));
	});

	it('the stored records stay unfrozen and writable after every snapshot was built (the legacy list does not share them)', () => {
		const pm = new PresetManager();
		snapshot(pm);
		for (const n of ['Earth', 'Rocket', 'Moon', 'Sagittarius A*']) { pm.peekObjectParam(n); }
		assertStoredTablesNotFrozen(pm);
		// The records the legacy builders could refer to (vehicle.boosters, vehicle.defaultFairing, rendering)
		const h3_22 = pm.vehicles.get('h3_22');
		assert.equal(Object.isFrozen(h3_22.boosters), false);
		assert.equal(Object.isFrozen(h3_22.defaultFairing), false);
		assert.equal(Object.isFrozen(h3_22.rendering.boosters), false);
		assert.notStrictEqual(pm.getLegacyPresets().H3_22.boosters, h3_22.boosters);
		const count = h3_22.boosters.count;
		h3_22.boosters.count = count + 1;
		assert.equal(h3_22.boosters.count, count + 1, 'a stored record can still be written');
		h3_22.boosters.count = count;
	});
});

// ---------------------------------------------------------------------------
// §3.11-4 What does not change
// ---------------------------------------------------------------------------

describe('§3.11-4 getObjectParam, getFuel, getFuels, getPlume copy on every call; getTheme returns the stored object', () => {
	it('getObjectParam returns a fresh unfrozen copy on every call, also while peekObjectParam has the name cached', () => {
		const pm = new PresetManager();
		const peek = pm.peekObjectParam('Earth');
		const a = pm.getObjectParam('Earth');
		const b = pm.getObjectParam('Earth');
		assert.notStrictEqual(a, b);
		assert.notStrictEqual(a, peek);
		assert.deepStrictEqual(a, b);
		assert.deepStrictEqual(a, peek);
		assert.deepStrictEqual(a, oldObjectParam(pm, 'Earth'));
		assertNothingFrozen(a, 'getObjectParam(Earth)');
		const radius = pm.celestials.get('earth').RADIUS;
		a.RADIUS = 1;
		assert.equal(pm.getObjectParam('Earth').RADIUS, radius);
		assert.equal(peek.RADIUS, radius);
		assert.equal(pm.celestials.get('earth').RADIUS, radius);
	});

	it('getFuel, getFuels and getPlume return fresh unfrozen copies on every call, also while the maps are cached', () => {
		const pm = new PresetManager();
		const snap = snapshot(pm);

		const f1 = pm.getFuel('liquid');
		const f2 = pm.getFuel('liquid');
		assert.notStrictEqual(f1, f2);
		assert.notStrictEqual(f1, snap.fuelsMap.liquid);
		assert.deepStrictEqual(f1, jsonCopy(pm.fuels.get('liquid')));
		assertNothingFrozen(f1, 'getFuel(liquid)');
		assert.deepStrictEqual(pm.getFuel('Cryogenic'), jsonCopy(pm.fuels.get('hydro')), 'by name, as before');
		assert.equal(pm.getFuel('nope'), null);
		assert.equal(pm.getFuel(''), null);

		const l1 = pm.getFuels();
		const l2 = pm.getFuels();
		assert.notStrictEqual(l1, l2);
		assert.notStrictEqual(l1[0], l2[0]);
		assert.deepStrictEqual(l1, [...pm.fuels.values()].map(jsonCopy));
		assertNothingFrozen(l1, 'getFuels()');

		const p1 = pm.getPlume('hydro');
		const p2 = pm.getPlume('hydro');
		assert.notStrictEqual(p1, p2);
		assert.notStrictEqual(p1, snap.plumesMap.hydro);
		assert.notStrictEqual(p1, snap.rocketVisual.PLUMES.hydro);
		assert.deepStrictEqual(p1, jsonCopy(pm.fuels.get('hydro').plume));
		assertNothingFrozen(p1, 'getPlume(hydro)');
		assert.deepStrictEqual(pm.getPlume('unknown fuel'), jsonCopy(pm.fuels.get('liquid').plume), 'falls back to liquid, as before');

		const isp = pm.fuels.get('liquid').isp;
		f1.isp = -1;
		p1.lenMult = -1;
		l1[0].isp = -1;
		assert.equal(pm.fuels.get('liquid').isp, isp);
		assert.equal(pm.getFuelsMap().liquid.isp, isp);
		assert.equal(pm.getPlumesMap().hydro.lenMult, pm.fuels.get('hydro').plume.lenMult);
		assert.strictEqual(pm.getFuelsMap(), snap.fuelsMap);
	});

	it('getTheme still returns the stored theme object, never frozen', () => {
		const pm = new PresetManager();
		snapshot(pm);
		assert.strictEqual(pm.getTheme('orange'), pm.themes.get('orange'));
		assert.strictEqual(pm.getTheme('BLUE'), pm.themes.get('blue'));
		assert.strictEqual(pm.getTheme(), pm.themes.get('orange'));
		assert.strictEqual(pm.getTheme({ colorTheme: 'blue' }), pm.themes.get('blue'));
		assert.strictEqual(pm.getTheme('no such theme'), pm.themes.get('orange'));
		assert.notStrictEqual(pm.getTheme('orange'), pm.getThemesMap().orange);
		assertNothingFrozen(pm.getTheme('orange'), 'getTheme(orange)');
	});
});

describe('§3.11-4 the ROCKET_VISUAL, ROCKET_FUELS and MULTISTAGE_PRESETS proxies give the old results', () => {
	it('ROCKET_VISUAL: reads, in and Object.keys equal the old build; a property is the same frozen object on every read', () => {
		const expected = oldRocketVisual(presetManager);
		assert.deepStrictEqual(Object.keys(ROCKET_VISUAL), Object.keys(expected));
		for (const k of Object.keys(expected)) {
			assert.deepStrictEqual(ROCKET_VISUAL[k], expected[k], `ROCKET_VISUAL.${k}`);
			assert.equal(k in ROCKET_VISUAL, true, `${k} in ROCKET_VISUAL`);
		}
		assert.deepStrictEqual({ ...ROCKET_VISUAL }, expected);
		assert.equal('NOT_A_KEY' in ROCKET_VISUAL, false);
		assert.equal(ROCKET_VISUAL.NOT_A_KEY, undefined);
		assert.strictEqual(ROCKET_VISUAL.ALIGNMENT, ROCKET_VISUAL.ALIGNMENT);
		assert.strictEqual(ROCKET_VISUAL.PLUMES, ROCKET_VISUAL.PLUMES);
		assertDeepFrozen(ROCKET_VISUAL.MODULES, 'ROCKET_VISUAL.MODULES');
		assertDeepFrozen(ROCKET_VISUAL.THEMES, 'ROCKET_VISUAL.THEMES');
	});

	it('ROCKET_FUELS: reads, in and Object.keys equal the old build; a name that is not a key returns an unfrozen copy', () => {
		const expected = oldFuelsMap(presetManager);
		assert.deepStrictEqual(Object.keys(ROCKET_FUELS), Object.keys(expected));
		for (const k of Object.keys(expected)) {
			assert.deepStrictEqual(ROCKET_FUELS[k], expected[k], `ROCKET_FUELS.${k}`);
			assert.equal(k in ROCKET_FUELS, true, `${k} in ROCKET_FUELS`);
		}
		assert.strictEqual(ROCKET_FUELS.liquid, ROCKET_FUELS.liquid);
		assertDeepFrozen(ROCKET_FUELS.liquid, 'ROCKET_FUELS.liquid');

		// Not a key: getFuel (by lower-cased id or by name), an unfrozen copy on every read, as before
		assert.equal('LIQUID' in ROCKET_FUELS, false);
		assert.equal('Cryogenic' in ROCKET_FUELS, false);
		const u1 = ROCKET_FUELS.LIQUID;
		const u2 = ROCKET_FUELS.LIQUID;
		assert.notStrictEqual(u1, u2);
		assert.deepStrictEqual(u1, expected.liquid);
		assertNothingFrozen(u1, 'ROCKET_FUELS.LIQUID');
		const byName = ROCKET_FUELS.Cryogenic;
		assert.deepStrictEqual(byName, expected.hydro);
		assertNothingFrozen(byName, 'ROCKET_FUELS.Cryogenic');
		byName.isp = -1;
		assert.equal(ROCKET_FUELS.hydro.isp, expected.hydro.isp);
		assert.equal(ROCKET_FUELS.nope, null);
		assert.equal('nope' in ROCKET_FUELS, false);
	});

	it('MULTISTAGE_PRESETS: reads, in and Object.keys equal the old build; a key is the same frozen preset on every read', () => {
		const expected = oldLegacyPresets(presetManager);
		const expectedKeys = [...new Set([
			...Object.keys(expected),
			...presetManager.getVehicles().map(v => String(v.id).toUpperCase())
		])];
		assert.deepStrictEqual(Object.keys(MULTISTAGE_PRESETS), expectedKeys);
		for (const k of expectedKeys) {
			assert.deepStrictEqual(MULTISTAGE_PRESETS[k], expected[k], `MULTISTAGE_PRESETS.${k}`);
			assert.equal(k in MULTISTAGE_PRESETS, true, `${k} in MULTISTAGE_PRESETS`);
		}
		assert.strictEqual(MULTISTAGE_PRESETS.H3_22, MULTISTAGE_PRESETS.H3_22);
		assert.strictEqual(MULTISTAGE_PRESETS.H3_30, MULTISTAGE_PRESETS.H3);
		assertDeepFrozen(MULTISTAGE_PRESETS.H3_22, 'MULTISTAGE_PRESETS.H3_22');
		// A lower-case key reaches the listed preset through getLegacyPreset, as before
		assert.deepStrictEqual(MULTISTAGE_PRESETS.h3_22, expected.H3_22);
		assert.equal('h3_22' in MULTISTAGE_PRESETS, true);
		assert.equal(MULTISTAGE_PRESETS.NOPE, null);
		assert.equal('NOPE' in MULTISTAGE_PRESETS, false);
	});
});

// ---------------------------------------------------------------------------
// Edge cases (abnormal and boundary values)
// ---------------------------------------------------------------------------

describe('edge cases of the snapshot cache', () => {
	it('empty tables after clear: empty maps, the defaults of the legacy builder, null parameters, all frozen', () => {
		const pm = new PresetManager();
		snapshot(pm);
		for (const t of TABLES) { pm[t].clear(); }
		const snap = snapshot(pm);
		assert.deepStrictEqual(snap.fuelsMap, {});
		assert.deepStrictEqual(snap.plumesMap, { THRUST_THRESHOLD: 0.01 });
		assert.deepStrictEqual(snap.themesMap, {});
		assert.deepStrictEqual(snap.rocketVisual, { PLUMES: { THRUST_THRESHOLD: 0.01 }, THEMES: {} });
		assert.deepStrictEqual(Object.keys(snap.legacyPresets), ['H3', 'H3_30']);
		assert.equal(snap.legacyPresets.H3.name, 'H3-30 (LE-9 x 3, No SRB)');
		assert.deepStrictEqual(snap.legacyPresets.H3.stages, []);
		assertSnapshotMatchesOldBuild(pm, snap);
		for (const k of SNAPSHOT_KEYS) { assertDeepFrozen(snap[k], k); }
		assert.equal(pm.peekObjectParam('Earth'), null);
		assert.equal(pm.peekObjectParam('Rocket'), null);
		assert.equal(pm.getLegacyPreset('H3_22'), null);
	});

	it('delete of a missing key bumps the version: new snapshots with the same values', () => {
		const pm = new PresetManager();
		const before = snapshot(pm);
		const earth = pm.peekObjectParam('Earth');
		const v = pm._derivedVersion;
		assert.equal(pm.fuels.delete('no such fuel'), false);
		assert.equal(pm._derivedVersion, v + 1);
		const after = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) {
			assert.notStrictEqual(after[k], before[k], `${k} rebuilt`);
			assert.deepStrictEqual(after[k], before[k], `${k} same values`);
		}
		const earthAfter = pm.peekObjectParam('Earth');
		assert.notStrictEqual(earthAfter, earth);
		assert.deepStrictEqual(earthAfter, earth);
	});

	it('set with the same value bumps the version: new snapshots with the same values', () => {
		const pm = new PresetManager();
		const before = snapshot(pm);
		const v = pm._derivedVersion;
		pm.visuals.set('rocket', pm.visuals.get('rocket'));
		assert.equal(pm._derivedVersion, v + 1);
		const after = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) {
			assert.notStrictEqual(after[k], before[k], `${k} rebuilt`);
			assert.deepStrictEqual(after[k], before[k], `${k} same values`);
		}
	});

	it('no rocket visual: getRocketVisual is PLUMES and THEMES only, as before', () => {
		const pm = new PresetManager();
		pm.visuals.delete('rocket');
		const vis = pm.getRocketVisual();
		assert.deepStrictEqual(Object.keys(vis), ['PLUMES', 'THEMES']);
		assert.deepStrictEqual(vis, { PLUMES: oldPlumesMap(pm), THEMES: oldThemesMap(pm) });
		assert.deepStrictEqual(vis, oldRocketVisual(pm));
		assertDeepFrozen(vis, 'getRocketVisual() without rocket');
		assert.strictEqual(pm.getRocketVisual(), vis);
	});

	it('a fuel without a plume is in getFuelsMap, not in getPlumesMap nor PLUMES; getPlume gives null, as before', () => {
		const pm = new PresetManager();
		pm.fuels.set('cold', { id: 'cold', name: 'Cold Gas', isp: 70 });
		pm.fuels.set('nullplume', { id: 'nullplume', name: 'Null Plume', isp: 80, plume: null });
		const snap = snapshot(pm);
		assert.deepStrictEqual(snap.fuelsMap.cold, { id: 'cold', name: 'Cold Gas', isp: 70 });
		assert.deepStrictEqual(snap.fuelsMap.nullplume, { id: 'nullplume', name: 'Null Plume', isp: 80, plume: null });
		assert.equal('cold' in snap.plumesMap, false);
		assert.equal('nullplume' in snap.plumesMap, false);
		assert.equal('cold' in snap.rocketVisual.PLUMES, false);
		assert.equal(pm.getPlume('cold'), null);
		assert.equal(pm.getPlume('Cold Gas'), null);
		assertSnapshotMatchesOldBuild(pm, snap);
	});
});

// ---------------------------------------------------------------------------
// init() path
// ---------------------------------------------------------------------------

/** Preset files served to init(): a new vehicle (with a theme), a changed Earth and a new body, a changed fuel and visual */
const makeInitFiles = (pm) => {
	const theme = { ...jsonCopy(pm.themes.get('orange')), accentBand: '#123456' };
	const vehicle = {
		...jsonCopy(pm.vehicles.get('h3_30')), id: 'zz_new', name: 'ZZ New', colorTheme: 'zz_theme',
		rendering: { ...jsonCopy(pm.vehicles.get('h3_30').rendering || {}), theme }
	};
	return new Map([
		['./presets/vehicles/manifest.json', ['zz_new']],
		['./presets/vehicles/zz_new.json', vehicle],
		['./presets/payloads/manifest.json', []],
		['./presets/missions/manifest.json', []],
		['./presets/celestials/manifest.json', ['earth', 'zz_planet']],
		['./presets/celestials/earth.json', { ...jsonCopy(pm.celestials.get('earth')), radius: 4321, RADIUS: 4321 }],
		['./presets/celestials/zz_planet.json', { id: 'zz_planet', key: 'ZZPlanet', name: 'ZZ Planet', mass: 1, radius: 2 }],
		['./presets/fuels/manifest.json', ['liquid']],
		['./presets/fuels/liquid.json', { ...jsonCopy(pm.fuels.get('liquid')), isp: 333 }],
		['./presets/visuals/manifest.json', ['rocket']],
		['./presets/visuals/rocket.json', { ...jsonCopy(pm.visuals.get('rocket')), MIN_SCREEN_RADIUS: 7.75 }]
	]);
};
const fetchResponse = (files, url) => {
	const data = files.get(String(url));
	return data === undefined
		? { ok: false, status: 404, json: async () => null }
		: { ok: true, status: 200, json: async () => jsonCopy(data) };
};
const withFetch = async (fetchStub, fn) => {
	const saved = globalThis.fetch;
	globalThis.fetch = fetchStub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = saved;
	}
};

describe('init(): caches built before a load are discarded once it changed the tables', () => {
	it('a successful load (fetch stubbed): every cache returns the loaded values', async () => {
		const pm = new PresetManager();
		const files = makeInitFiles(pm);
		const before = snapshot(pm);
		const earthBefore = pm.peekObjectParam('Earth');
		assert.equal(pm.peekObjectParam('ZZ Planet'), null);

		const ok = await withFetch(async (url) => fetchResponse(files, url), () => pm.init());
		assert.equal(ok, true);
		assert.equal(pm.isLoaded, true);

		const after = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) { assert.notStrictEqual(after[k], before[k], `${k} rebuilt after init()`); }
		assertSnapshotMatchesOldBuild(pm, after, 'after init():');
		assert.equal(after.rocketVisual.MIN_SCREEN_RADIUS, 7.75);
		assert.equal(after.fuelsMap.liquid.isp, 333);
		assert.equal(after.legacyPresets.ZZ_NEW.name, 'ZZ New');
		assert.equal(after.themesMap.zz_theme.accentBand, '#123456');
		assert.equal(after.rocketVisual.THEMES.zz_new.accentBand, '#123456');
		const earthAfter = pm.peekObjectParam('Earth');
		assert.notStrictEqual(earthAfter, earthBefore);
		assert.equal(earthAfter.RADIUS, 4321);
		assert.equal(pm.peekObjectParam('ZZ Planet').RADIUS, 2, 'the cached null is rebuilt');
		assert.deepStrictEqual(earthAfter, oldObjectParam(pm, 'Earth'));
	});

	it('a load that fails inside init() (_fetchJSON throws after the vehicles): values rebuilt for what it changed', async () => {
		const pm = new PresetManager();
		const files = makeInitFiles(pm);
		files.set('./presets/payloads/manifest.json', ['htv_x']);
		const before = snapshot(pm);
		const earthBefore = pm.peekObjectParam('Earth');
		const ispBefore = before.fuelsMap.liquid.isp;
		pm._fetchJSON = async (url) => {
			if (/\/payloads\/(?!manifest\.json$)/.test(url)) { throw new Error('offline'); }
			return files.has(url) ? jsonCopy(files.get(url)) : null;
		};

		const ok = await pm.init();
		assert.equal(ok, true, 'init() reports the built-in definitions');
		assert.equal(pm.isLoaded, true);

		const after = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) { assert.notStrictEqual(after[k], before[k], `${k} rebuilt`); }
		assertSnapshotMatchesOldBuild(pm, after, 'after a failed init():');
		assert.equal(after.legacyPresets.ZZ_NEW.name, 'ZZ New', 'the vehicles loaded before the failure are served');
		assert.equal(after.themesMap.zz_theme.accentBand, '#123456');
		assert.equal(after.rocketVisual.THEMES.zz_theme.accentBand, '#123456');
		assert.equal(after.fuelsMap.liquid.isp, ispBefore, 'the fuels were not reached');
		assert.notEqual(after.rocketVisual.MIN_SCREEN_RADIUS, 7.75, 'the visuals were not reached');
		const earthAfter = pm.peekObjectParam('Earth');
		assert.notStrictEqual(earthAfter, earthBefore);
		assert.deepStrictEqual(earthAfter, earthBefore, 'Earth was not reloaded');
	});

	it('a network drop in the middle of the load (fetch throws from the first payload file on): the vehicles loaded before it are served', async () => {
		const pm = new PresetManager();
		const files = makeInitFiles(pm);
		files.set('./presets/payloads/manifest.json', ['htv_x']);
		const before = snapshot(pm);
		let dropped = false;
		const ok = await withFetch(async (url) => {
			if (/\/payloads\/(?!manifest\.json$)/.test(String(url))) { dropped = true; }
			if (dropped) { throw new TypeError('Failed to fetch'); }
			return fetchResponse(files, url);
		}, () => pm.init());
		assert.equal(ok, true);
		assert.equal(dropped, true);

		const after = snapshot(pm);
		assert.notStrictEqual(after.legacyPresets, before.legacyPresets);
		assertSnapshotMatchesOldBuild(pm, after, 'after a dropped load:');
		assert.equal(after.legacyPresets.ZZ_NEW.name, 'ZZ New');
		assert.equal(after.fuelsMap.liquid.isp, before.fuelsMap.liquid.isp);
		assert.equal(pm.peekObjectParam('Earth').RADIUS, 6378000);
	});

	it('a load where every fetch throws changes no table: the cached snapshots stay the same objects', async () => {
		const pm = new PresetManager();
		const before = snapshot(pm);
		const earth = pm.peekObjectParam('Earth');
		const v = pm._derivedVersion;
		const ok = await withFetch(async () => { throw new TypeError('Failed to fetch'); }, () => pm.init());
		assert.equal(ok, true);
		assert.equal(pm._derivedVersion, v);
		const after = snapshot(pm);
		for (const k of SNAPSHOT_KEYS) { assert.strictEqual(after[k], before[k], `${k} kept`); }
		assert.strictEqual(pm.peekObjectParam('Earth'), earth);
	});
});

// ---------------------------------------------------------------------------
// §3.11-5 peekObjectParam
// ---------------------------------------------------------------------------

describe('§3.11-5 peekObjectParam', () => {
	it('returns the value of getObjectParam, the same deeply frozen object for the same name', () => {
		const pm = new PresetManager();
		for (const name of ['Earth', 'Rocket', 'Moon', 'Sun', 'Sagittarius A*', 'SgrAStar', 'sgra_star', 'Asteroid']) {
			const peek = pm.peekObjectParam(name);
			assert.deepStrictEqual(peek, pm.getObjectParam(name), `peek ${name} equals getObjectParam`);
			assert.deepStrictEqual(peek, oldObjectParam(pm, name), `peek ${name} equals the old lookup`);
			assert.notEqual(peek, null, name);
			assert.strictEqual(pm.peekObjectParam(name), peek, `peek ${name} is the same object`);
			assertDeepFrozen(peek, `peek ${name}`);
		}
	});

	it('an unknown name gives null and is not searched again', () => {
		const pm = new PresetManager();
		const searches = spyOn(pm, 'getCelestial');
		try {
			assert.equal(pm.peekObjectParam('No Such Body'), null);
			assert.equal(searches.count, 1);
			for (let i = 0; i < 20; i++) { assert.equal(pm.peekObjectParam('No Such Body'), null); }
			assert.equal(searches.count, 1, 'the null is cached');
			assert.equal(pm.getObjectParam('No Such Body'), null);
			assert.equal(searches.count, 2, 'getObjectParam still searches on every call');
		} finally {
			searches.restore();
		}
	});

	it('null, undefined, empty, case and surrounding-space variants give what getObjectParam gives', () => {
		const pm = new PresetManager();
		const names = [null, undefined, '', ' ', '\t', 'earth', 'EARTH', 'eArTh', ' Earth ', '\tEarth\n', 'rocket', 'ROCKET',
			' Rocket', 'sagittarius a*', 'SGRASTAR', ' sgra_star ', 'Earth ', 0, -0, NaN, false, true, 1];
		for (const name of names) {
			const peek = pm.peekObjectParam(name);
			assert.deepStrictEqual(peek, pm.getObjectParam(name), `peek(${JSON.stringify(name)}) equals getObjectParam`);
			assert.deepStrictEqual(peek, oldObjectParam(pm, name), `peek(${JSON.stringify(name)}) equals the old lookup`);
			assert.strictEqual(pm.peekObjectParam(name), peek, `peek(${JSON.stringify(name)}) cached`);
		}
		assert.equal(pm.peekObjectParam(' Earth ').NAME, 'Earth');
		assert.equal(pm.peekObjectParam(null), null);
		assert.equal(pm.peekObjectParam(''), null);
	});

	it('null has its own key: an object whose String() is "null" is not answered with the cached null (design §3.11-5, Rev 16)', () => {
		for (const order of ['null first', 'object first']) {
			const pm = new PresetManager();
			pm._registerCelestial('null', { name: 'null', mass: 1, radius: 13 });
			const objectName = ['null'];
			const seq = order === 'null first' ? [null, objectName] : [objectName, null];
			for (const name of seq) {
				assert.deepStrictEqual(pm.peekObjectParam(name), pm.getObjectParam(name), `${order}: peek(${Array.isArray(name) ? '["null"]' : 'null'})`);
			}
			assert.equal(pm.peekObjectParam(null), null, `${order}: null is no name`);
			assert.equal(pm.peekObjectParam(objectName).RADIUS, 13, `${order}: ["null"] names the body "null", as getCelestial searches String(name)`);
		}
	});

	it('the key separates names whose String() is equal by typeof: null / "null", undefined / "undefined", 0 / "0", false / "false", NaN / "NaN"', () => {
		const pairs = [[null, 'null'], [undefined, 'undefined'], [0, '0'], [false, 'false'], [NaN, 'NaN']];
		for (const order of ['non-string first', 'string first']) {
			const pm = new PresetManager();
			for (const [, s] of pairs) { pm._registerCelestial(s, { name: s, mass: 1, radius: 11 }); }
			for (const [value, s] of pairs) {
				const seq = order === 'non-string first' ? [value, s] : [s, value];
				for (const name of seq) {
					assert.deepStrictEqual(pm.peekObjectParam(name), pm.getObjectParam(name), `${order}: peek(${String(name)} as ${typeof name})`);
				}
				assert.equal(pm.peekObjectParam(value), null, `${typeof value} ${String(value)} is falsy: null`);
				assert.equal(pm.peekObjectParam(s).NAME, s, `the string "${s}" names the registered body`);
				assert.equal(pm.peekObjectParam(s).RADIUS, 11);
			}
		}
	});

	it('a change of celestials or celestialKeyMap rebuilds a cached object and a cached null', () => {
		const pm = new PresetManager();
		const earth = pm.peekObjectParam('Earth');
		assert.equal(pm.peekObjectParam('Terra'), null);
		pm.celestialKeyMap.set('Terra', pm.celestials.get('earth'));
		assert.equal(pm.peekObjectParam('Terra').NAME, 'Earth');
		pm.celestials.set('earth', { ...jsonCopy(pm.celestials.get('earth')), RADIUS: 99, radius: 99 });
		const earth2 = pm.peekObjectParam('Earth');
		assert.notStrictEqual(earth2, earth);
		assert.equal(earth2.RADIUS, 99);
		assert.equal(earth.RADIUS, 6378000, 'the earlier snapshot keeps its values');
		assertDeepFrozen(earth2, 'rebuilt peek Earth');
	});

	it(`keeps at most ${PEEK_LIMIT + 1} names: 512th and 513th distinct names are kept, the 514th starts the cache over`, () => {
		const pm = new PresetManager();
		const searches = spyOn(pm, 'getCelestial');
		try {
			const earth = pm.peekObjectParam('Earth'); // 1st distinct name
			for (let i = 2; i <= 511; i++) { assert.equal(pm.peekObjectParam(`unknown-${i}`), null); }
			assert.equal(pm._peekParamCache.size, 511);
			assert.equal(searches.count, 511);

			pm.peekObjectParam('unknown-512'); // 512th
			assert.equal(pm._peekParamCache.size, 512);
			assert.strictEqual(pm.peekObjectParam('Earth'), earth, 'a hit with 512 names keeps the cache');
			assert.strictEqual(pm.peekObjectParam('unknown-2'), null);
			assert.equal(pm._peekParamCache.size, 512);
			assert.equal(searches.count, 512);

			pm.peekObjectParam('unknown-513'); // 513th: the peak
			assert.equal(pm._peekParamCache.size, 513);
			assert.equal(searches.count, 513);

			assert.equal(pm.peekObjectParam('unknown-514'), null); // 514th: cleared, then this name
			assert.equal(pm._peekParamCache.size, 1);
			assert.equal(searches.count, 514);

			const earthAgain = pm.peekObjectParam('Earth');
			assert.notStrictEqual(earthAgain, earth, 'rebuilt after the clear');
			assert.deepStrictEqual(earthAgain, earth);
			assert.equal(pm.peekObjectParam('unknown-2'), null);
			assert.equal(pm._peekParamCache.size, 3);
			assert.equal(searches.count, 516);
		} finally {
			searches.restore();
		}
	});

	it('with 513 names even a cached name starts the cache over (more than 512 are never kept)', () => {
		const pm = new PresetManager();
		const earth = pm.peekObjectParam('Earth');
		for (let i = 2; i <= 513; i++) { pm.peekObjectParam(`unknown-${i}`); }
		assert.equal(pm._peekParamCache.size, 513);
		const earthAgain = pm.peekObjectParam('Earth');
		assert.equal(pm._peekParamCache.size, 1);
		assert.notStrictEqual(earthAgain, earth);
		assert.deepStrictEqual(earthAgain, oldObjectParam(pm, 'Earth'));
	});
});

// ---------------------------------------------------------------------------
// §3.11-5 PhysicsEngine.peekCelestialParam
// ---------------------------------------------------------------------------

describe('§3.11-5 PhysicsEngine.peekCelestialParam', () => {
	it('returns the celestialParams object (shared, not frozen) when the name is there, else the shared peek value', () => {
		const engine = new PhysicsEngine();
		const shared = { NAME: 'Earth', RADIUS: 1, ATM_LIMIT_ALT: 5 };
		engine.setCelestialParams({ Earth: shared, Hole: null });
		assert.strictEqual(engine.peekCelestialParam('Earth'), shared);
		assert.equal(Object.isFrozen(shared), false, 'the Worker table is shared as before, not frozen');
		assert.strictEqual(engine.peekCelestialParam('Moon'), presetManager.peekObjectParam('Moon'));
		assert.deepStrictEqual(engine.peekCelestialParam('Moon'), oldObjectParam(presetManager, 'Moon'));
		assert.equal(engine.peekCelestialParam('Hole'), null, 'a null entry falls through to the preset manager');
		assert.equal(engine.peekCelestialParam('No Such Body'), null);
	});

	it('with celestialParams null (always so in the predictor engine) it returns the peek value', () => {
		const engine = new PhysicsEngine();
		assert.equal(engine.celestialParams, null);
		assert.strictEqual(engine.peekCelestialParam('Earth'), presetManager.peekObjectParam('Earth'));

		const earth = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, 6378000, 0, 5.972e21);
		const probe = new CalcDebris(2, 'Probe', 6378000 + 1e6, 0, 0, 7000, 0, 0, 1, 1, 1);
		const predictor = new PredictorPhysicsEngine([earth], probe, 1);
		assert.equal(predictor.celestialParams, null);
		assert.equal(earth.param, null);
		assert.strictEqual(predictor.peekCelestialParam('Earth'), presetManager.peekObjectParam('Earth'));
		assert.deepStrictEqual(predictor.atmBodies, [earth], 'the categorisation read the atmosphere through the peek value');
	});

	it('an unknown name is searched once, then never again', () => {
		const engine = new PhysicsEngine();
		const name = 'Unlisted Debris peekCelestialParam';
		const searches = spyOn(presetManager, 'getCelestial', (n) => n === name);
		try {
			for (let i = 0; i < 25; i++) { assert.equal(engine.peekCelestialParam(name), null); }
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 1);
	});

	it('getCelestialParam (used by addObject to keep the parameters) still returns a fresh unfrozen copy', () => {
		const engine = new PhysicsEngine();
		const a = engine.getCelestialParam('Earth');
		const b = engine.getCelestialParam('Earth');
		assert.notStrictEqual(a, b);
		assert.deepStrictEqual(a, oldObjectParam(presetManager, 'Earth'));
		assertNothingFrozen(a, 'getCelestialParam(Earth)');
		const added = engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, radius: 6378000, mass: 5.972e21 });
		assert.equal(Object.isFrozen(added.param), false);
		assert.notStrictEqual(added.param, presetManager.peekObjectParam('Earth'));
	});
});

// ---------------------------------------------------------------------------
// §3.11-5 Rocket._visualBaseRadiusM
// ---------------------------------------------------------------------------

const makeRocket = () => new Rocket(500, 'Test Rocket', 0, 0, 0, 0, 25, 40, 200, '#fff', 5, 20);
/** A preset manager whose Rocket record has the radius 47 m, to tell its value from the literal 63 */
const pmWithRocketRadius = (radius = 47) => {
	const pm = new PresetManager();
	pm._registerCelestial('rocket', { ...jsonCopy(pm.celestials.get('rocket')), radius, RADIUS: radius });
	assert.equal(oldObjectParam(pm, 'Rocket').RADIUS, radius);
	return pm;
};

describe('§3.11-5 Rocket._visualBaseRadiusM: baseRadiusM, else param.RADIUS, else the shared Rocket radius, else 63', () => {
	it('with baseRadiusM it returns it and looks nothing up', () => {
		const pm = pmWithRocketRadius();
		const searches = spyOn(pm, 'getCelestial');
		const peeks = spyOn(pm, 'peekObjectParam');
		try {
			withGlobalPresetManager(pm, () => {
				const r = makeRocket();
				r.baseRadiusM = 31.5;
				r.param = { RADIUS: 7 };
				assert.equal(r._visualBaseRadiusM(), 31.5);
				r.param = null;
				assert.equal(r._visualBaseRadiusM(), 31.5);
			});
		} finally {
			searches.restore();
			peeks.restore();
		}
		assert.equal(searches.count, 0);
		assert.equal(peeks.count, 0);
	});

	it('with only param it returns param.RADIUS and looks nothing up', () => {
		const pm = pmWithRocketRadius();
		const searches = spyOn(pm, 'getCelestial');
		const peeks = spyOn(pm, 'peekObjectParam');
		try {
			withGlobalPresetManager(pm, () => {
				const r = makeRocket();
				r.baseRadiusM = 0;
				r.param = { RADIUS: 7 };
				assert.equal(r._visualBaseRadiusM(), 7);
			});
		} finally {
			searches.restore();
			peeks.restore();
		}
		assert.equal(searches.count, 0);
		assert.equal(peeks.count, 0);
	});

	it('otherwise the shared Rocket radius, else 63 (no Rocket record, a 0 radius, no preset manager)', () => {
		const r = makeRocket();
		r.baseRadiusM = 0;
		r.param = null;
		assert.equal(withGlobalPresetManager(pmWithRocketRadius(), () => r._visualBaseRadiusM()), 47);
		const noRocket = new PresetManager();
		removeRocketRecord(noRocket);
		assert.equal(withGlobalPresetManager(noRocket, () => r._visualBaseRadiusM()), 63);
		assert.equal(withGlobalPresetManager(pmWithRocketRadius(0), () => r._visualBaseRadiusM()), 63, 'a 0 radius falls through');
		assert.equal(withGlobalPresetManager(undefined, () => r._visualBaseRadiusM()), 63);
		assert.equal(withGlobalPresetManager(new PresetManager(), () => r._visualBaseRadiusM()), 63, 'the shipped Rocket radius');
	});

	it('falsy values (0, NaN, "") of baseRadiusM and param.RADIUS move on to the next candidate', () => {
		const pm = pmWithRocketRadius();
		withGlobalPresetManager(pm, () => {
			const r = makeRocket();
			for (const falsy of [0, NaN, '']) {
				r.baseRadiusM = falsy;
				r.param = { RADIUS: 7 };
				assert.equal(r._visualBaseRadiusM(), 7, `baseRadiusM ${String(falsy)}`);
				for (const falsyRadius of [0, NaN, '', undefined]) {
					r.param = { RADIUS: falsyRadius };
					assert.equal(r._visualBaseRadiusM(), 47, `baseRadiusM ${String(falsy)}, RADIUS ${String(falsyRadius)}`);
				}
				r.param = null;
				assert.equal(r._visualBaseRadiusM(), 47);
			}
		});
	});

	it('the drawing radius (_getDrawRadius) and the smoke emission (updateHistory) make no copy per frame', () => {
		const pm = pmWithRocketRadius();
		const searches = spyOn(pm, 'getCelestial');
		try {
			withGlobalPresetManager(pm, () => {
				// With baseRadiusM the drawing radius never looks the Rocket parameter up
				const withBase = makeRocket();
				withBase.baseRadiusM = 40;
				const zoom = 1e9;
				for (let i = 0; i < 10; i++) {
					assert.equal(withBase._getDrawRadius(zoom), Math.max(ROCKET_VISUAL.MIN_SCREEN_RADIUS, (40 / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE * zoom));
				}
				assert.equal(searches.count, 0, '_getDrawRadius with baseRadiusM');

				// Without baseRadiusM and param (a rocket loaded from a save): one lookup, then none
				const loaded = makeRocket();
				loaded.baseRadiusM = 0;
				loaded.param = null;
				loaded.isIgnited = true;
				loaded.burnTime = 100;
				loaded.thrustRatio = 1;
				loaded.stages = [{ fuelType: 'liquid' }, { fuelType: 'liquid' }];
				loaded._getDrawRadius(zoom);
				loaded.updateHistory(1, []);
				searches.count = 0;
				for (let frame = 2; frame < 12; frame++) {
					assert.equal(loaded._getDrawRadius(zoom), Math.max(ROCKET_VISUAL.MIN_SCREEN_RADIUS, (47 / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE * zoom));
					loaded.updateHistory(frame, []);
				}
				assert.equal(searches.count, 0, '_getDrawRadius and updateHistory without baseRadiusM and param');
			});
		} finally {
			searches.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// §3.11-5 readers of the call-site table
// ---------------------------------------------------------------------------

describe('§3.11-5 RocketLauncher readers: drawTargetMarker, _calculateTransform, getBaseRadiusM', () => {
	const zoom = 1e11;
	const markerHalfBox = (radiusM) => {
		const conf = RENDER.MARKER;
		const b = Math.max(conf.HOST_MIN_SIZE, UnitConvertUtils.m2pix(radiusM) * zoom) * conf.HOST_BOX_MULT;
		return [-b, -b + b * conf.HOST_LINE_FRAC];
	};
	const firstMoveTo = (ctx) => ctx.calls.find(c => c[0] === 'moveTo').slice(1);
	const setupMarker = (pm) => {
		const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6378000 }); // no param
		const { launcher } = makeLauncher(pm, [earth]);
		launcher.mode = 'host';
		launcher.hostId = 1;
		launcher.rolloutedRocketId = null;
		return { earth, launcher };
	};

	it('drawTargetMarker: the Rocket radius of the shared parameters, and no copy per frame', () => {
		const pm = new PresetManager();
		const { earth, launcher } = setupMarker(pm);
		let ctx = recordingCtx();
		launcher.drawTargetMarker(ctx, earth, zoom);
		assert.deepStrictEqual(firstMoveTo(ctx), markerHalfBox(oldObjectParam(pm, 'Rocket').RADIUS));
		const searches = spyOn(pm, 'getCelestial');
		try {
			for (let i = 0; i < 10; i++) {
				ctx = recordingCtx();
				launcher.drawTargetMarker(ctx, earth, zoom);
			}
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 0, 'the marker and the transform (host without param) copy nothing');
		assert.deepStrictEqual(firstMoveTo(ctx), markerHalfBox(63));
	});

	it('drawTargetMarker: the radius falls back to 1 m when there is no Rocket record', () => {
		const pm = new PresetManager();
		removeRocketRecord(pm);
		const { earth, launcher } = setupMarker(pm);
		const ctx = recordingCtx();
		launcher.drawTargetMarker(ctx, earth, zoom);
		assert.deepStrictEqual(firstMoveTo(ctx), markerHalfBox(1));
		assert.notDeepStrictEqual(markerHalfBox(1), markerHalfBox(63), 'the zoom tells the two radii apart');
	});

	it('_calculateTransform: a host without param rotates the launch as a host with param, with no copy per call', () => {
		const pm = new PresetManager();
		const base = { id: 1, name: 'Earth', radius: 6378000, vx: 3, vy: -2 };
		const transformFor = (host) => {
			const { launcher } = makeLauncher(pm, [host]);
			launcher.mode = 'host';
			launcher.hostId = 1;
			launcher.hostAngleDeg = 30;
			return { launcher, t: launcher._calculateTransform() };
		};
		const noParam = transformFor(createMockCelestialBody(base));
		const withParam = transformFor(createMockCelestialBody({ ...base, param: oldObjectParam(pm, 'Earth') }));
		const noRotation = transformFor(createMockCelestialBody({ ...base, param: {} }));
		assert.deepStrictEqual(noParam.t, withParam.t);
		assert.notEqual(noParam.t.vx, noRotation.t.vx, 'the rotation was applied');
		assert.notEqual(noParam.t.vy, noRotation.t.vy);

		const searches = spyOn(pm, 'getCelestial');
		try {
			for (let i = 0; i < 20; i++) { assert.deepStrictEqual(noParam.launcher._calculateTransform(), withParam.t); }
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 0);
	});

	it('getBaseRadiusM: the listed preset, else stage 0 rocketLengthM, else the shared Rocket radius (no copy), else 63', () => {
		const pm = pmWithRocketRadius();
		const { launcher } = makeLauncher(pm, []);
		launcher.currentPresetId = 'H3_30';
		assert.equal(launcher.getBaseRadiusM(), oldLegacyPresets(pm).H3_30.lengthM);
		assert.equal(launcher.getBaseRadiusM(), 63);

		launcher.currentPresetId = 'NOT_LISTED';
		launcher.stages = [{ fuelType: 'hydro', rocketLengthM: 52 }];
		assert.equal(launcher.getBaseRadiusM(), 52);

		// The peek path: an unlisted preset id and no stage-0 rocketLengthM
		launcher.stages = [{ fuelType: 'hydro' }];
		assert.equal(launcher.getBaseRadiusM(), 47);
		const searches = spyOn(pm, 'getCelestial');
		try {
			for (let i = 0; i < 20; i++) { assert.equal(launcher.getBaseRadiusM(), 47); }
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 0);

		removeRocketRecord(pm);
		assert.equal(launcher.getBaseRadiusM(), 63);
		launcher.stages = [];
		assert.equal(launcher.getBaseRadiusM(), 63);
	});

	it('_peekObjectParam asks universe.presetManager, then its own presetManager, then the module preset manager', () => {
		const { universe, launcher } = makeLauncher(new PresetManager(), []);
		const tagged = (label) => ({ peekObjectParam: (name) => ({ label, name }) });
		universe.presetManager = tagged('universe');
		launcher.presetManager = tagged('launcher');
		assert.deepStrictEqual(launcher._peekObjectParam('Earth'), { label: 'universe', name: 'Earth' });
		universe.presetManager = null;
		assert.deepStrictEqual(launcher._peekObjectParam('Earth'), { label: 'launcher', name: 'Earth' });
		launcher.presetManager = null;
		assert.strictEqual(launcher._peekObjectParam('Earth'), presetManager.peekObjectParam('Earth'));
		launcher.universe = null;
		assert.strictEqual(launcher._peekObjectParam('Rocket'), presetManager.peekObjectParam('Rocket'));
	});
});

describe('§3.11-5 ObjectPlacer readers: getLaunchObjectName and the slingshot HUD', () => {
	const startSlingshot = (placer) => {
		placer.isSlingshotting = true;
		placer.startRelX = 0;
		placer.startRelY = 0;
		placer.startScreenX = 900;
		placer.startScreenY = 500;
		placer.screenCursorX = 960;
		placer.screenCursorY = 540;
	};
	const hudTexts = (ctx) => ctx.calls.filter(c => c[0] === 'fillText').map(c => c[1]);

	it('getLaunchObjectName: the selected name when it has parameters, else Rocket; no copy per call', () => {
		const pm = new PresetManager();
		const placer = new ObjectPlacer(realLikeUniverse(pm));
		const cases = [['Earth', 'Earth'], [' Earth ', ' Earth '], ['moon', 'moon'], ['No Such Body', 'Rocket'], ['', 'Rocket']];
		for (const [value, expected] of cases) {
			massSelect().value = value;
			assert.equal(placer.getLaunchObjectName(), expected, `mass-select ${JSON.stringify(value)}`);
		}
		const searches = spyOn(pm, 'getCelestial');
		try {
			for (let i = 0; i < 10; i++) {
				for (const [value, expected] of cases) {
					massSelect().value = value;
					assert.equal(placer.getLaunchObjectName(), expected);
				}
			}
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 0);
	});

	it('slingshot HUD: the mass of the launched object, else of Rocket; no copy per frame', () => {
		const pm = new PresetManager();
		const placer = new ObjectPlacer(realLikeUniverse(pm));
		startSlingshot(placer);

		massSelect().value = 'Earth';
		let ctx = recordingCtx();
		placer.drawPreview(ctx, null, 1.0);
		assert.ok(hudTexts(ctx).includes('[ LAUNCH: EARTH ]'));
		assert.ok(hudTexts(ctx).includes(`MASS: ${oldObjectParam(pm, 'Earth').MASS.toExponential(2)} t`));

		massSelect().value = 'No Such Body';
		ctx = recordingCtx();
		placer.drawPreview(ctx, null, 1.0);
		assert.ok(hudTexts(ctx).includes('[ LAUNCH: ROCKET ]'));
		assert.ok(hudTexts(ctx).includes(`MASS: ${oldObjectParam(pm, 'Rocket').MASS.toExponential(2)} t`));

		const searches = spyOn(pm, 'getCelestial');
		try {
			for (const value of ['Earth', 'No Such Body', 'Earth', 'No Such Body', 'Earth']) {
				massSelect().value = value;
				placer.drawPreview(recordingCtx(), null, 1.0);
			}
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 0);
	});

	it('slingshot HUD: 1.00e+00 t for Rocket when the preset manager has no record', () => {
		const pm = new PresetManager();
		removeRocketRecord(pm);
		const placer = new ObjectPlacer(realLikeUniverse(pm));
		startSlingshot(placer);
		massSelect().value = 'No Such Body';
		const ctx = recordingCtx();
		placer.drawPreview(ctx, null, 1.0);
		assert.ok(hudTexts(ctx).includes('[ LAUNCH: ROCKET ]'));
		assert.ok(hudTexts(ctx).includes('MASS: 1.00e+00 t'));
	});

	it('_peekObjectParam asks universe.presetManager, then the module preset manager (never this.presetManager)', () => {
		const universe = realLikeUniverse(new PresetManager());
		const placer = new ObjectPlacer(universe);
		placer.presetManager = { peekObjectParam: () => { throw new Error('ObjectPlacer has no presetManager of its own'); } };
		universe.presetManager = { peekObjectParam: (name) => ({ label: 'universe', name }) };
		assert.deepStrictEqual(placer._peekObjectParam('Earth'), { label: 'universe', name: 'Earth' });
		delete universe.presetManager;
		assert.strictEqual(placer._peekObjectParam('Earth'), presetManager.peekObjectParam('Earth'));
		placer.universe = null;
		assert.strictEqual(placer._peekObjectParam('Moon'), presetManager.peekObjectParam('Moon'));
	});
});

describe('§3.11-5 NaviTab._updateNaviStats', () => {
	const atmTexts = (tab) => [tab.ui.nvAtmAlt.textContent, tab.ui.nvAtmRho.textContent, tab.ui.nvAtmScale.textContent];
	const expectedAtm = (p) => [
		UnitConvertUtils.m2km(p.ATM_LIMIT_ALT).toLocaleString() + ' km',
		p.ATM_DENSITY_0.toLocaleString() + ' kg/m³',
		p.ATM_SCALE_HEIGHT.toLocaleString() + ' m'
	];

	it('the atmosphere rows of a target without param come from the shared parameters, with no copy per update', () => {
		const pm = new PresetManager();
		const earth = createMockCelestialBody({ id: 7, name: 'Earth', radius: 6378000, mass: 5.972e21 });
		const moon = createMockCelestialBody({ id: 8, name: 'Moon', radius: 1737000, mass: 7.3e19 });
		const unknown = createMockCelestialBody({ id: 9, name: 'No Such Body', radius: 1000, mass: 1 });
		const universe = realLikeUniverse(pm, [earth, moon, unknown]);
		const tab = new NaviTab(universe);
		tab.naviTargetId = 7;
		tab._updateNaviStats();
		assert.deepStrictEqual(atmTexts(tab), expectedAtm(oldObjectParam(pm, 'Earth')));
		tab.naviTargetId = 8;
		tab._updateNaviStats();
		assert.deepStrictEqual(atmTexts(tab), ['--- km', '--- kg/m³', '--- m'], 'no atmosphere');
		tab.naviTargetId = 9;
		tab._updateNaviStats();
		assert.deepStrictEqual(atmTexts(tab), ['--- km', '--- kg/m³', '--- m'], 'no parameters');

		const searches = spyOn(pm, 'getCelestial');
		const viaUniverse = spyOn(universe, 'getObjectParams');
		try {
			for (let i = 0; i < 10; i++) {
				for (const id of [7, 8, 9]) {
					tab.naviTargetId = id;
					tab._updateNaviStats();
				}
			}
		} finally {
			searches.restore();
			viaUniverse.restore();
		}
		assert.equal(searches.count, 0);
		assert.equal(viaUniverse.count, 0, 'universe.getObjectParams (a copy per call) is not used');
		assert.deepStrictEqual(atmTexts(tab), ['--- km', '--- kg/m³', '--- m']);
	});

	it('reads target.param, then universe.presetManager, then the module preset manager', () => {
		const target = createMockCelestialBody({ id: 3, name: 'Earth', radius: 6378000, mass: 5.972e21 });
		const universe = realLikeUniverse(new PresetManager(), [target]);
		universe.getObjectParams = () => { throw new Error('universe.getObjectParams must not be called'); };
		const tab = new NaviTab(universe);
		tab.naviTargetId = 3;

		target.param = { ATM_LIMIT_ALT: 1000, ATM_DENSITY_0: 2, ATM_SCALE_HEIGHT: 3 };
		universe.presetManager = { peekObjectParam: () => { throw new Error('target.param comes first'); } };
		tab._updateNaviStats();
		assert.deepStrictEqual(atmTexts(tab), expectedAtm(target.param));

		target.param = null;
		const fromUniverse = { ATM_LIMIT_ALT: 2000, ATM_DENSITY_0: 4, ATM_SCALE_HEIGHT: 6 };
		universe.presetManager = { peekObjectParam: (name) => (name === 'Earth' ? fromUniverse : null) };
		tab._updateNaviStats();
		assert.deepStrictEqual(atmTexts(tab), expectedAtm(fromUniverse));

		delete universe.presetManager;
		tab._updateNaviStats();
		assert.deepStrictEqual(atmTexts(tab), expectedAtm(presetManager.peekObjectParam('Earth')));
	});
});

describe('§3.11-5 CelestialBody._drawEffects', () => {
	it('bodies without param draw the atmosphere of the shared parameters as with param; no copy per frame for 10 bodies', () => {
		const pm = new PresetManager();
		const names = ['Earth', 'Mars', 'Venus', 'Jupiter', 'Saturn', 'Titan', 'Moon', 'Sun', 'Pluto', 'No Such Body'];
		const make = (withParam) => names.map((n, i) => {
			const body = new CelestialBody(i + 1, n, 0, 0, 0, 0, 1, '#fff', 1, 1000);
			body.param = withParam ? oldObjectParam(pm, n) : null;
			return body;
		});
		const loaded = make(false);
		const reference = make(true);
		const zoom = 1e5;
		const frame = (bodies) => {
			const ctx = recordingCtx();
			for (const body of bodies) { body._drawEffects(ctx, 10, 20, 30, zoom); }
			return ctx.calls;
		};
		withGlobalPresetManager(pm, () => {
			const drawn = frame(loaded);
			assert.deepStrictEqual(drawn, frame(reference));
			const earth = oldObjectParam(pm, 'Earth');
			const outer = 30 + (earth.ATM_LIMIT_ALT / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE * zoom;
			assert.deepStrictEqual(drawn.find(c => c[0] === 'createRadialGradient'), ['createRadialGradient', 10, 20, 30, 10, 20, outer]);

			const searches = spyOn(pm, 'getCelestial');
			try {
				for (let f = 0; f < 5; f++) { assert.deepStrictEqual(frame(loaded), drawn); }
			} finally {
				searches.restore();
			}
			assert.equal(searches.count, 0);
		});
	});
});

describe('§3.11-5 Worker readers: FlightComputer, the aerodynamics of the calculation objects and the physics step', () => {
	it('FlightComputer._updateTelemetry: the host rotation of the shared parameters, with no copy per step', () => {
		const pm = new PresetManager();
		const r = 6378000 + 1000;
		const sensorFor = (refBody) => ({
			refBody, distToRefM: r, x: r, y: 0, vx: 0, vy: 500, ax: 1, ay: 2, mass: 100, fuelMass: 50,
			thrustForce: 0, thrustRatio: 0, massLossRate: 0, aoaDeg: 0, qAxialKpa: 0, qLateralKpa: 0, progradeAngle: 0
		});
		const earth = { name: 'Earth', mass: 5.972e24, radius: 6378000, x: 0, y: 0, vx: 0, vy: 0, param: null };
		withGlobalPresetManager(pm, () => {
			const telemetry = (refBody) => {
				const fc = new FlightComputer({});
				fc._updateTelemetry(sensorFor(refBody));
				return fc.telemetryCache;
			};
			const loaded = telemetry(earth);
			assert.deepStrictEqual(loaded, telemetry({ ...earth, param: oldObjectParam(pm, 'Earth') }));
			assert.notEqual(loaded.vH, telemetry({ ...earth, param: {} }).vH, 'the rotation was applied');

			const fc = new FlightComputer({});
			const sensor = sensorFor(earth);
			const searches = spyOn(pm, 'getCelestial');
			try {
				for (let i = 0; i < 20; i++) { fc._updateTelemetry(sensor); }
			} finally {
				searches.restore();
			}
			assert.equal(searches.count, 0);
			assert.equal(fc.telemetryCache.vH, loaded.vH);
		});
	});

	it('CalcRocket aerodynamics without objParam use the shared Rocket parameters, with no copy per step', () => {
		const rocketParam = oldObjectParam(presetManager, 'Rocket');
		const fake = (objParam, qAxialKpa = 0) => ({
			objParam, name: 'Rocket', thrustAngle: 0.3, _aoaDeg: 0, _qAxialKpa: qAxialKpa, _qLateralKpa: 0, shattered: false
		});
		const run = (obj) => CalcRocket.prototype._determinDynamicParam.call(obj, 100, 200, 50000, 0.5);
		const loaded = fake(null);
		const reference = fake(rocketParam);
		assert.deepStrictEqual(run(loaded), run(reference));
		assert.deepStrictEqual(loaded, { ...reference, objParam: null });
		assert.equal(run(loaded).cd, rocketParam.DRAG_COEF);

		const destroy = (objParam, qAxialKpa) => {
			const obj = fake(objParam, qAxialKpa);
			CalcRocket.prototype._checkAerodynamicDestruction.call(obj, 0);
			return obj.shattered;
		};
		const limitKpa = rocketParam.MAX_Q_AXIAL / 1000;
		assert.equal(destroy(null, limitKpa * 1.01), true);
		assert.equal(destroy(null, limitKpa * 0.99), false);
		assert.equal(destroy(rocketParam, limitKpa * 1.01), true);

		const searches = spyOn(presetManager, 'getCelestial');
		try {
			for (let i = 0; i < 20; i++) {
				run(fake(null));
				destroy(null, limitKpa * 0.99);
			}
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 0);
	});

	it('GravSimCalcObject._checkAerodynamicDestruction without param uses the shared parameters, with no copy per step', () => {
		const asteroid = oldObjectParam(presetManager, 'Asteroid');
		const destroy = (param, name, q) => {
			const obj = { param, name, shattered: false };
			CalcDebris.prototype._checkAerodynamicDestruction.call(obj, q);
			return obj.shattered;
		};
		assert.equal(destroy(null, 'Asteroid', asteroid.MAX_DYNAMIC_PRESSURE + 1), true);
		assert.equal(destroy(null, 'Asteroid', asteroid.MAX_DYNAMIC_PRESSURE - 1), false);
		assert.equal(destroy(asteroid, 'Asteroid', asteroid.MAX_DYNAMIC_PRESSURE + 1), true);
		assert.equal(destroy(null, 'Unlisted Fairing Half', 1e30), false, 'an unknown name has no limit');

		const searches = spyOn(presetManager, 'getCelestial');
		try {
			for (let i = 0; i < 20; i++) {
				destroy(null, 'Asteroid', 1);
				destroy(null, 'Unlisted Fairing Half', 1);
			}
		} finally {
			searches.restore();
		}
		assert.equal(searches.count, 0);
	});

	it('PhysicsEngine step: the same motion as with param; an unlisted debris name is not searched in any update', () => {
		const build = (keepParam) => {
			const engine = new PhysicsEngine();
			engine.addObject({ id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, radius: 6378000, mass: 5.972e21 });
			engine.addObject({ id: 2, name: 'Unlisted Rogue Planet', type: OBJECT_TYPES.CELESTIAL, x: 4e8, y: 0, vx: 0, vy: 100, radius: 1e6, mass: 1e18 });
			engine.addObject({ id: 3, name: 'Unlisted Stage-1 Debris', type: OBJECT_TYPES.DEBRIS, x: 6378000 + 50000, y: 0, vx: 0, vy: 7000, radius: 2, mass: 10 });
			const earth = engine.objects[0];
			if (!keepParam) {
				// A body without param (the per-step reads use the shared parameters)
				earth.param = null;
				earth.rotationPeriod = undefined;
			}
			return engine;
		};
		const update = (engine) => {
			const dt = 0.05;
			engine._categorizeBodies();
			engine.determineOptimalSubSteps(dt * 3, 1);
			engine._buildQuadTree(dt * 3);
			engine._checkCollisions(dt * 3);
			engine._checkRocheLimit();
			for (let i = 0; i < 3; i++) { engine._moveObjects(dt); }
			engine._updateEscapeStatus();
		};
		const state = (engine) => ({
			atm: engine.atmBodies.map(o => o.id),
			objects: engine.objects.map(o => ({
				id: o.id, x: o.x, y: o.y, vx: o.vx, vy: o.vy, ax: o.ax, ay: o.ay, rotationAngle: o.rotationAngle,
				inAtmosphere: o.inAtmosphere, nearestAtm: o._nearestAtmBody?.id ?? null, shattered: o.shattered
			}))
		});

		const loaded = build(false);
		const reference = build(true);
		update(loaded);
		update(reference);
		assert.deepStrictEqual(state(loaded), state(reference));
		assert.deepStrictEqual(state(loaded).atm, [1]);
		assert.equal(state(loaded).objects[2].inAtmosphere, true, 'the debris flies in the atmosphere');
		assert.notEqual(state(loaded).objects[0].rotationAngle, 0, 'the Earth rotates by the shared period');

		const unlisted = spyOn(presetManager, 'getCelestial', (n) => typeof n === 'string' && n.startsWith('Unlisted'));
		const all = spyOn(presetManager, 'getCelestial');
		try {
			for (let i = 0; i < 3; i++) { update(loaded); }
		} finally {
			all.restore();
			unlisted.restore();
		}
		assert.equal(unlisted.count, 0, 'the unlisted names were searched only when added, never in an update');
		assert.equal(all.count, 0, 'no lookup at all in an update');
		for (let i = 0; i < 3; i++) { update(reference); }
		assert.deepStrictEqual(state(loaded), state(reference));
	});
});

// ---------------------------------------------------------------------------
// Legacy presets
// ---------------------------------------------------------------------------

/** The launcher state RocketLauncher.loadPreset writes */
const LAUNCHER_LOAD_FIELDS = Object.freeze(['currentPresetId', 'currentVehicleId', 'colorTheme', 'stages', 'payload', 'fairing', 'boosters',
	'rendering', 'dryMassT', 'fuelMassT', 'oxidMassT', 'fuelType', 'thrustKN', 'calculatedBurnTime', 'flightProfile',
	'disableOrbitalCutoff', 'targetApogeeKm', 'targetPerigeeKm', 'targetVInfKmS']);
const pick = (obj, fields) => Object.fromEntries(fields.map(f => [f, obj[f]]));
const dataFields = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v !== 'function'));

/** A preset manager serving main's unfrozen legacy list (rebuilt on every call, as main did) */
const pmServingOldList = () => {
	const pm = new PresetManager();
	pm.getLegacyPreset = (key) => {
		const k = String(key || '').toUpperCase();
		return oldLegacyPresets(pm)[k] || null;
	};
	return pm;
};

describe('legacy presets from the frozen list', () => {
	it('getLegacyPreset of a listed key returns the shared frozen entry; of a key with no vehicle null, as before', () => {
		const pm = new PresetManager();
		const list = pm.getLegacyPresets();
		assert.strictEqual(pm.getLegacyPreset('h3_22'), list.H3_22);
		assert.strictEqual(pm.getLegacyPreset('FALCON9'), list.FALCON9);
		for (const key of ['NOPE', 'h3_99', '', null, undefined, 0]) {
			assert.equal(pm.getLegacyPreset(key), null, `getLegacyPreset(${JSON.stringify(key)})`);
		}
	});

	it('a vehicle id that does not round-trip through upper case: ß looked up with ẞ returns an unfrozen build', () => {
		const pm = new PresetManager();
		pm.vehicles.set('ß', { ...jsonCopy(pm.vehicles.get('h3_30')), id: 'ß', name: 'Eszett' });
		const list = pm.getLegacyPresets();
		assert.equal('ß'.toUpperCase(), 'SS');
		assert.equal('ẞ'.toUpperCase(), 'ẞ');
		assert.equal('ẞ'.toLowerCase(), 'ß');
		assert.equal(list.SS.name, 'Eszett', 'listed under its upper-cased id');
		assert.equal('ẞ' in list, false);

		const a = pm.getLegacyPreset('ẞ');
		const b = pm.getLegacyPreset('ẞ');
		assert.notStrictEqual(a, b, 'built on every call, as before');
		assert.deepStrictEqual(a, pm._buildLegacyPresetFromVehicle(pm.getVehicle('ß'), 'ẞ'));
		assert.equal(a.id, 'ẞ');
		assert.equal(a.name, 'Eszett');
		assertNothingFrozen(a, "getLegacyPreset('ẞ')");
		assert.strictEqual(pm.getLegacyPreset('ß'), list.SS, "the key 'ß' upper-cases to the listed 'SS'");
		assertStoredTablesNotFrozen(pm);
	});

	it('RocketLauncher.loadPreset builds from the frozen list the state it built from the unfrozen list', () => {
		const pm = new PresetManager();
		for (const key of ['H3_22', 'h3_24', 'FALCON9', 'EPSILON', 'SSTO', 'H3_30', 'H3']) {
			const { launcher } = makeLauncher(pm, []);
			launcher.loadPreset(key);
			const old = new RocketLauncher(createMockUniverse({ objects: [] }), { presetManager: pmServingOldList() });
			old.requestPreviewUpdate = () => {};
			old.loadPreset(key);
			assert.deepStrictEqual(pick(launcher, LAUNCHER_LOAD_FIELDS), pick(old, LAUNCHER_LOAD_FIELDS), `loadPreset(${key})`);

			for (const f of ['stages', 'payload', 'fairing', 'boosters', 'rendering', 'flightProfile']) {
				if (launcher[f] !== null) { assertNothingFrozen(launcher[f], `launcher.${f} after loadPreset(${key})`); }
			}
			const upper = key.toUpperCase();
			const listed = pm.getLegacyPresets()[upper].stages[0].fuelMassT;
			launcher.stages[0].fuelMassT = listed + 1;
			assert.equal(pm.getLegacyPresets()[upper].stages[0].fuelMassT, listed, 'the launcher state is its own copy');
		}
	});

	it('RocketTab.loadPreset builds from the frozen list the state it built from the unfrozen list', () => {
		const runTab = (pm, key) => {
			freshDom();
			EventBus.clearAll();
			const universe = createMockUniverse({ presetManager: pm });
			const tab = new RocketTab(universe);
			tab.loadPreset(key);
			return { tab, rl: universe.RocketLauncher };
		};
		const pm = new PresetManager();
		for (const key of ['H3_22', 'FALCON9', 'EPSILON', 'h3_24']) {
			const frozen = runTab(pm, key);
			const unfrozen = runTab(pmServingOldList(), key);
			assert.deepStrictEqual(dataFields(frozen.rl), dataFields(unfrozen.rl), `RocketTab.loadPreset(${key})`);
			assert.equal(frozen.tab.ui.rlColorTheme.value, unfrozen.tab.ui.rlColorTheme.value);
			for (const f of ['stages', 'payload', 'fairing', 'boosters', 'rendering', 'flightProfile']) {
				if (frozen.rl[f] !== null) { assertNothingFrozen(frozen.rl[f], `rl.${f} after RocketTab.loadPreset(${key})`); }
			}
		}
		freshDom();
	});
});

// ---------------------------------------------------------------------------
// §3.11-6 Rebuild counts (deterministic, not timings)
// ---------------------------------------------------------------------------

describe('§3.11-6 rebuilds per frame', () => {
	it('a high-detail RocketRenderer.draw reads the visual settings many times and rebuilds them 0 times', () => {
		const rocket = {
			thrustAngle: 0.0, colorTheme: 'orange', currentStageIndex: 0, totalStages: 2,
			stages: [{ fuelType: 'hydro' }, { fuelType: 'hydro' }],
			boosters: { count: 2, name: 'SRB-3', radiusRatio: 0.26, lengthRatio: 1.70, offsetYRatio: 0.95, plumeFuel: 'solid', plumeScale: 0.55 },
			fairing: { enabled: true, isSeparated: false },
			isIgnited: true, isHoldDown: false, burnTime: 100, thrustRatio: 1.0, disableStaging: false,
			rcsCw: true, rcsUllage: true, mach: 1.1, ambientPresRatio: 0.5
		};
		RocketRenderer.draw(recordingCtx(), rocket, 200, 200, 50, 1.0); // the first frame may build the snapshot

		const reads = spyOn(presetManager, 'getRocketVisual');
		const rocketVisualBuilds = spyOn(presetManager.visuals, 'get', (key) => key === 'rocket');
		const plumeBuilds = spyOn(presetManager.fuels, 'entries');
		const themeBuilds = spyOn(presetManager.themes, 'entries');
		const highDetail = spyOn(RocketRenderer, '_drawHighDetail');
		try {
			for (let i = 0; i < 3; i++) { RocketRenderer.draw(recordingCtx(), rocket, 200, 200, 50, 1.0); }
		} finally {
			highDetail.restore();
			themeBuilds.restore();
			plumeBuilds.restore();
			rocketVisualBuilds.restore();
			reads.restore();
		}
		assert.equal(highDetail.count, 3, 'the high-detail path was drawn');
		assert.ok(reads.count >= 3 * 10, `ROCKET_VISUAL is read many times per draw (${reads.count})`);
		assert.equal(rocketVisualBuilds.count, 0, 'getRocketVisual is not rebuilt');
		assert.equal(plumeBuilds.count, 0, 'getPlumesMap is not rebuilt');
		assert.equal(themeBuilds.count, 0, 'getThemesMap is not rebuilt');
	});

	it('RocketLauncher.drawPreview rebuilds the legacy presets 0 times and copies no parameter (listed and unlisted preset)', () => {
		for (const presetId of ['H3_30', 'NOT_LISTED']) {
			const pm = new PresetManager();
			const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6378000 }); // no param
			const { launcher } = makeLauncher(pm, [earth]);
			launcher.isActive = true;
			launcher.mode = 'host';
			launcher.hostId = 1;
			launcher.rolloutedRocketId = null;
			launcher.currentPrediction = null;
			launcher.currentPresetId = presetId;
			// The getBaseRadiusM peek path needs no stage-0 rocketLengthM as well
			launcher.stages = launcher.stages.map(({ rocketLengthM, ...stage }) => stage);
			assert.equal(launcher.stages[0].rocketLengthM, undefined);
			const rc = { basis: earth, zoomScale: 1.0, cameraOffset: { x: 0, y: 0 } };
			launcher.drawPreview(recordingCtx(), earth, 1.0, rc); // the first frame may build the snapshots

			const reads = spyOn(pm, 'getLegacyPresets');
			const builds = spyOn(pm, '_buildLegacyPresets');
			const copies = spyOn(pm, 'getCelestial');
			try {
				for (let i = 0; i < 5; i++) { launcher.drawPreview(recordingCtx(), earth, 1.0, rc); }
			} finally {
				copies.restore();
				builds.restore();
				reads.restore();
			}
			assert.ok(reads.count >= 5, `${presetId}: the legacy presets are read every frame (${reads.count})`);
			assert.equal(builds.count, 0, `${presetId}: getLegacyPresets is not rebuilt`);
			assert.equal(copies.count, 0, `${presetId}: no parameter is copied`);
			assert.equal(launcher.getBaseRadiusM(), presetId === 'H3_30' ? 63 : oldObjectParam(pm, 'Rocket').RADIUS);
		}
	});
});

describe('legacy presets do not freeze the stored records they share (design §3.11-2, Gate 3 G3-1-02)', () => {
	it('a nested value of a vehicle SRB configuration, shared by the built list, stays unfrozen in the stored record', () => {
		const pm = new PresetManager();
		const vehicle = pm.vehicles.get('h3_22');
		assert.ok(vehicle && vehicle.boosters, 'precondition: H3-22 has an SRB configuration');
		// calculateMissionFlightPlan spreads the SRB configuration one level deep, so a nested value is shared with the record
		const stored = { ...vehicle, boosters: { ...vehicle.boosters, meta: { tag: 'kept', list: [1, 2] } } };
		pm.vehicles.set('h3_22', stored);
		const entry = pm.getLegacyPresets().H3_22;
		assert.deepEqual(entry.boosters.meta, { tag: 'kept', list: [1, 2] }, 'the list carries the nested value');
		assert.ok(Object.isFrozen(entry.boosters.meta) && Object.isFrozen(entry.boosters.meta.list), 'the shared list is frozen to its leaves');
		assert.notEqual(entry.boosters.meta, stored.boosters.meta, 'the list holds its own copy');
		assert.equal(Object.isFrozen(stored.boosters.meta), false, 'the stored nested object is not frozen');
		assert.equal(Object.isFrozen(stored.boosters.meta.list), false, 'the stored nested array is not frozen');
		assert.equal(Object.isFrozen(stored.boosters), false, 'the stored SRB configuration is not frozen');
		stored.boosters.meta.tag = 'changed';
		stored.boosters.meta.list.push(3);
		assert.deepEqual(stored.boosters.meta, { tag: 'changed', list: [1, 2, 3] }, 'the record stays writable');
		assert.deepEqual(entry.boosters.meta, { tag: 'kept', list: [1, 2] }, 'the shared list is not affected');
	});
});
