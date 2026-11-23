/**
 * Integration Test Suite 13: Flight-plan missions on the Worker engine
 *
 * Real flights through the Worker physics (`SimulationController` message protocol + `PhysicsEngine`
 * sub-steps of SIMULATION.SUB_STEPS.ROCKET_POWERED_MAX_DT) for representative vehicles of all 7 missions.
 * Verifies, against docs/design/2026-11-20_trajectory_fx_flightplan.md §3.4 (requirement 4):
 *  - the design mission profiles drive the vehicle to the designed cutoff (orbit / target apogee / V∞),
 *    with ordered, non-deferred separations;
 *  - ORBIT_ASSIST commands the design formula exactly when its intervention condition holds (circular targets)
 *    and never for non-circular targets;
 *  - deferred auto-staging (STG_MECO hold) and deferred orbital hold (ORBITAL_COAST hold) with zero thrust
 *    until the profile action row fires;
 *  - the targetVInfKmS cutoff never interferes with a self-propelled payload after separation;
 *  - the app path (applyToLauncher -> rollout -> ObjectPlacer -> ObjectManager -> Worker messages) carries
 *    the action rows and deep-space targets into CalcRocket.
 * Test plan: docs/design/2026-11-20_trajectory_fx_flightplan_test_plan.md §3-D (integration part).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupMockDOM, createMockUniverse } from '../test_helpers.mjs';

setupMockDOM();

import { SimulationController } from '../../scripts/gravsim_calc.js';
import { PresetManager, presetManager } from '../../scripts/gravsim_preset_manager.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { ObjectPlacer } from '../../scripts/gravsim_object_placer.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { CelestialBody } from '../../scripts/gravsim_object.js';
import { WorkerBridge } from '../../scripts/gravsim_worker_bridge.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { OBJECT_TYPES, PHYSICS, SIMULATION } from '../../scripts/gravsim_const.js';
import { UnitConvertUtils } from '../../scripts/gravsim_utils.js';

// ---------------------------------------------------------------------------
// World setup (Sun + Earth from the presets, rocket on the pad at the Earth's -Y side)
// ---------------------------------------------------------------------------

const DT = SIMULATION.SUB_STEPS.ROCKET_POWERED_MAX_DT; // powered-flight sub-step of the Worker (0.5 s)
const AU = PHYSICS.METERS_PER_AU;
const EARTH_PARAM = presetManager.getObjectParam('Earth');
const EARTH_RADIUS = EARTH_PARAM.RADIUS;
const EARTH_MASS_KG = UnitConvertUtils.ton2kg(EARTH_PARAM.MASS);
const EARTH_ORBIT_V = 29780;
const OMEGA = (2 * Math.PI) / EARTH_PARAM.ROTATION_PERIOD;
const ROCKET_ID = 300;

const createWorld = () => {
	const controller = new SimulationController();
	const post = (msg) => controller.handleMessage({ data: structuredClone(msg) });
	post({ cmd: 'add', id: 0, name: 'Sun', type: OBJECT_TYPES.CELESTIAL, x: 0, y: 0, vx: 0, vy: 0, mass: 1.989e30, radius: 696340000 });
	post({ cmd: 'add', id: 1, name: 'Earth', type: OBJECT_TYPES.CELESTIAL, x: AU, y: 0, vx: 0, vy: EARTH_ORBIT_V, mass: EARTH_MASS_KG, radius: EARTH_RADIUS });
	const engine = controller.engine;
	return { controller, engine, post, earth: engine.objects.find(o => o.id === 1) };
};

const launchFromPlan = (world, plan, extraRows = []) => {
	const s0 = plan.stages[0];
	const dy = -(EARTH_RADIUS + 10);
	world.post({
		cmd: 'add', id: ROCKET_ID, name: 'Rocket', type: OBJECT_TYPES.ROCKET,
		x: AU, y: dy, vx: -OMEGA * dy, vy: EARTH_ORBIT_V, radius: s0.radius || 2.0,
		mass: s0.dryMassT, fuelMass: s0.fuelMassT, oxidMass: s0.oxidMassT, ofRatio: s0.ofRatio,
		burnTime: s0.burnTime, thrustForce: s0.thrustKN * 1000, thrustAngle: -Math.PI / 2, maxGLimit: 4.0,
		isIgnited: true, isHoldDown: false,
		stages: plan.stages, payload: plan.payload, fairing: plan.fairing, boosters: plan.boosters,
		flightProfile: plan.flightProfile.concat(extraRows),
		disableOrbitalCutoff: plan.disableOrbitalCutoff,
		targetApogeeKm: plan.targetApogeeKm, targetPerigeeKm: plan.targetPerigeeKm, targetVInfKmS: plan.targetVInfKmS
	});
	return world.engine.objects.find(o => o.id === ROCKET_ID);
};

// ---------------------------------------------------------------------------
// Orbital quantities (same expression order as the Worker cutoff checks) and the ORBIT_ASSIST formula
// ---------------------------------------------------------------------------

const orbitOf = (x, y, vx, vy, ref, dist = Math.hypot(x - ref.x, y - ref.y)) => {
	const GM = PHYSICS.G * ref.mass;
	const dvx = vx - ref.vx;
	const dvy = vy - ref.vy;
	const v = Math.hypot(dvx, dvy);
	const E = 0.5 * v * v - GM / dist;
	const dx = x - ref.x;
	const dy = y - ref.y;
	const h = dx * dvy - dy * dvx;
	const ecc = Math.sqrt(Math.max(0, 1 + (2 * E * h * h) / (GM * GM)));
	const a = -GM / (2 * E);
	return {
		altM: dist - ref.radius, E, ecc,
		peKm: E < 0 ? (a * (1 - ecc) - ref.radius) / 1000 : NaN,
		apKm: E < 0 ? (a * (1 + ecc) - ref.radius) / 1000 : Infinity,
		vInfKmS: E >= 0 ? Math.sqrt(2 * E) / 1000 : NaN
	};
};

/**
 * Design §3.4-1 ORBIT_ASSIST. The intervention is gated by a circular target and !disableOrbitalCutoff;
 * forceCircular drops both gates to evaluate the would-be command inside the geometric window.
 */
const designAssist = (s, ref, tgtAp, tgtPe, { forceCircular = false, disableCutoff = false } = {}) => {
	const dx = s.x - ref.x;
	const dy = s.y - ref.y;
	const r = Math.hypot(dx, dy);
	const dvx = s.vx - ref.vx;
	const dvy = s.vy - ref.vy;
	const uRx = dx / r;
	const uRy = dy / r;
	const vr = dvx * uRx + dvy * uRy;
	const vHx = dvx - vr * uRx;
	const vHy = dvy - vr * uRy;
	const vHMag = Math.hypot(vHx, vHy);
	const altM = r - ref.radius;
	const GM = PHYSICS.G * ref.mass;
	const E = 0.5 * (dvx * dvx + dvy * dvy) - GM / r;
	const h = dx * dvy - dy * dvx;
	const ecc = Math.sqrt(Math.max(0, 1 + (2 * E * h * h) / (GM * GM)));
	const apKm = E < 0 ? (((-GM / (2 * E)) * (1 + ecc)) - ref.radius) / 1000 : Infinity;
	const gated = forceCircular || (Boolean(tgtAp > 0 && tgtPe > 0 && tgtAp / tgtPe <= 1.5) && !disableCutoff);
	const intervenes = gated && altM >= 140000 && vHMag >= 4200 && (apKm >= tgtAp * 0.88 || E >= 0);
	const rTgt = ref.radius + ((tgtAp + tgtPe) / 2) * 1000;
	const apOver = Number.isFinite(apKm) ? Math.max(0, (apKm - tgtAp) * 1000) : Math.max(0, altM);
	const vrTgt = Math.max(-85, Math.min(14, ((rTgt - r) - 1.1 * apOver) / 130));
	const gamma = Math.max(-0.30, Math.min(0.45, (vrTgt - vr) / 650));
	const tx = Math.cos(gamma) * (vHx / vHMag) + Math.sin(gamma) * uRx;
	const ty = Math.cos(gamma) * (vHy / vHMag) + Math.sin(gamma) * uRy;
	return { intervenes, angle: Math.atan2(ty, tx) };
};

const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// ---------------------------------------------------------------------------
// Instrumentation: record every CalcRocket.flightControl call and every guidance evaluation
// ---------------------------------------------------------------------------

const stagingState = (r) => ({
	stg: r.currentStageIndex, stageState: r.stageState, sep: r.isPayloadSeparated,
	fairing: Boolean(r.fairing?.isSeparated), boosters: Boolean(r.isBoosterSeparated),
	prop: r.fuelMass + r.oxidMass, burnTime: r.burnTime, massLossRate: r.massLossRate,
	thrustForce: r.thrustForce, isIgnited: r.isIgnited, mass: r.mass
});

const instrument = (rocket) => {
	const calls = [];
	const guidance = [];
	const fc = rocket.flightComputer;
	const origCompute = fc._computeThrustAngle.bind(fc);
	fc._computeThrustAngle = (sensor) => {
		const ref = sensor.refBody ? { x: sensor.refBody.x, y: sensor.refBody.y, vx: sensor.refBody.vx, vy: sensor.refBody.vy, mass: sensor.refBody.mass, radius: sensor.refBody.radius } : null;
		const entry = {
			state: { x: sensor.x, y: sensor.y, vx: sensor.vx, vy: sensor.vy }, ref,
			burnTime: sensor.burnTime, stageState: sensor.stageState, isHoldDown: sensor.isHoldDown,
			flightTime: fc.flightTime, altM: fc.telemetryCache.altM,
			tgtAp: fc.targetApogeeKm, tgtPe: fc.targetPerigeeKm, disableCutoff: fc.disableOrbitalCutoff
		};
		const out = origCompute(sensor);
		entry.desired = fc.desiredThrustAngleRad;
		guidance.push(entry);
		return out;
	};
	const origFlight = rocket.flightControl.bind(rocket);
	rocket.flightControl = (dt, ref, dist, sun) => {
		const before = stagingState(rocket);
		const orbit = (ref && dist > 0) ? orbitOf(rocket.x, rocket.y, rocket.vx, rocket.vy, ref, dist) : null;
		origFlight(dt, ref, dist, sun);
		calls.push({ t: rocket.flightComputer.flightTime, before, after: stagingState(rocket), orbit, thrustRatio: rocket._thrustRatio });
	};
	return { calls, guidance };
};

/** Guidance entries on which the design ORBIT_ASSIST condition applies (powered, past tower clearance) */
const assistApplicable = (g) => g.ref && g.burnTime > 0 && g.stageState === 'STG_BURNING' && !g.isHoldDown
	&& !(g.flightTime < 10 && g.altM < 1000);

const fly = (world, rocket, { maxTime, stop }) => {
	let minAltM = Infinity;
	const steps = Math.round(maxTime / DT);
	for (let i = 0; i < steps; i++) {
		world.engine._moveObjects(DT);
		minAltM = Math.min(minAltM, Math.hypot(rocket.x - world.earth.x, rocket.y - world.earth.y) - world.earth.radius);
		if (stop && stop(rocket)) break;
	}
	return { minAltM };
};

const findCall = (calls, pred, what) => {
	const idx = calls.findIndex(pred);
	assert.ok(idx >= 0, `expected event: ${what}`);
	return { call: calls[idx], idx };
};

const finalOrbit = (world, rocket) => orbitOf(rocket.x, rocket.y, rocket.vx, rocket.vy, world.earth);

const debrisOfType = (world, subType) => world.engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS && o.debrisSubType === subType).length;

beforeEach(() => {
	EventBus.clearAll();
});

// ---------------------------------------------------------------------------
// 1. All 7 missions (representative vehicles)
// ---------------------------------------------------------------------------

describe('Integration 13: the 7 design missions fly to their designed cutoff on the Worker engine', () => {
	const pm = new PresetManager();
	const MISSIONS = [
		{ missionId: 'leo_250km', vehicleId: 'h3_30', payloadId: 'earth_obs', kind: 'orbit' },
		{ missionId: 'iss_rendezvous', vehicleId: 'h3_22', payloadId: 'htv_x', kind: 'circular' },
		{ missionId: 'gto_insertion', vehicleId: 'h3_24', payloadId: 'geo_sat', kind: 'apogee' },
		{ missionId: 'lunar_insertion', vehicleId: 'h3_24', payloadId: 'lunar_orbiter', kind: 'apogee' },
		{ missionId: 'mars_transfer', vehicleId: 'h3_30', payloadId: 'earth_obs', kind: 'vinf' },
		{ missionId: 'jupiter_transfer', vehicleId: 'h3_24', payloadId: 'earth_obs', kind: 'vinf' },
		{ missionId: 'solar_escape', vehicleId: 'h3_24', payloadId: 'earth_obs', kind: 'vinf' }
	];

	for (const cfg of MISSIONS) {
		it(`${cfg.missionId} (${cfg.vehicleId} + ${cfg.payloadId})`, () => {
			const mission = pm.getMission(cfg.missionId);
			const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle(cfg.vehicleId), payload: pm.getPayload(cfg.payloadId), mission });
			const world = createWorld();
			const rocket = launchFromPlan(world, plan);
			assert.deepEqual(rocket.flightProfile, plan.flightProfile, 'the Worker rocket flies the adapted design profile');
			assert.equal(rocket.targetVInfKmS, plan.targetVInfKmS);
			assert.equal(rocket.targetApogeeKm, plan.targetApogeeKm);
			assert.equal(rocket.disableOrbitalCutoff, plan.disableOrbitalCutoff);
			const { calls, guidance } = instrument(rocket);
			const { minAltM } = fly(world, rocket, { maxTime: 2500, stop: r => r.isPayloadSeparated && r.stageState === 'ORBITAL_COAST' });
			assert.ok(minAltM > 0, `never below the surface (min ${minAltM} m)`);

			const lastIdx = plan.stages.length - 1;
			const hasSrb = Boolean(plan.boosters && (plan.boosters.count > 0 || plan.boosters.burnTimeSec > 0));

			// Stage 1: burnout MECO, then separation after separationDelaySec (nothing reserved)
			const meco1 = findCall(calls, c => c.before.stg === 0 && c.before.stageState === 'STG_BURNING' && c.after.stageState === 'STG_MECO', 'stage-1 MECO').call;
			const sep1 = findCall(calls, c => c.before.stg === 0 && c.after.stg === 1, 'stage-1 separation').call;
			const delay1 = sep1.t - meco1.t;
			assert.ok(delay1 >= plan.stages[0].separationDelaySec - DT - 1e-9 && delay1 <= plan.stages[0].separationDelaySec + 1e-9, `stage-1 separation delay ${delay1}`);
			if (hasSrb) {
				const boost = findCall(calls, c => !c.before.boosters && c.after.boosters, 'SRB separation').call;
				assert.ok(boost.t <= sep1.t, 'SRBs separate before stage 1');
			}

			// Final stage: commanded cutoff (propellant left) above the cutoff altitude
			const { call: cut, idx: cutIdx } = findCall(calls, c => !c.before.sep && c.before.stg === lastIdx && c.before.stageState === 'STG_BURNING' && c.after.stageState !== 'STG_BURNING', 'final-stage cutoff');
			assert.equal(cut.after.stageState, 'STG_MECO', 'no reservation: the cutoff goes to STG_MECO');
			assert.ok(cut.before.prop > 2 * cut.before.massLossRate * DT, 'cut off with propellant remaining (not a burnout)');
			assert.equal(cut.after.burnTime, 0);
			assert.equal(cut.after.prop, 0);
			assert.ok(cut.orbit.altM >= 140000, `cutoff altitude ${cut.orbit.altM}`);
			const prev = calls[cutIdx - 1];
			assert.ok(prev.before.stg === lastIdx && prev.before.stageState === 'STG_BURNING' && prev.after.stageState === 'STG_BURNING', 'the previous call was still a final-stage burn');

			// Payload and fairing
			const pay = findCall(calls, c => !c.before.sep && c.after.sep, 'payload separation').call;
			const sepDelayLast = plan.stages[lastIdx].separationDelaySec;
			const delayPay = pay.t - cut.t;
			assert.ok(delayPay >= sepDelayLast - DT - 1e-9 && delayPay <= sepDelayLast + 1e-9, `payload separation delay ${delayPay}`);
			const fair = findCall(calls, c => !c.before.fairing && c.after.fairing, 'fairing separation').call;
			assert.ok(fair.t <= pay.t, 'the fairing separates before the payload');
			assert.equal(rocket.isPayloadSeparated, true);

			const assistEntries = guidance.filter(assistApplicable);
			if (cfg.kind === 'circular') {
				const intervened = assistEntries.filter(g => designAssist(g.state, g.ref, g.tgtAp, g.tgtPe, { disableCutoff: g.disableCutoff }).intervenes);
				assert.ok(intervened.length > 0, 'ORBIT_ASSIST intervened during the final-stage burn');
				for (const g of intervened) {
					const expected = designAssist(g.state, g.ref, g.tgtAp, g.tgtPe, { disableCutoff: g.disableCutoff }).angle;
					assert.ok(angleDiff(g.desired, expected) < 1e-9, `ORBIT_ASSIST command at t=${g.flightTime}: ${g.desired} vs ${expected}`);
				}
				const fin = finalOrbit(world, rocket);
				assert.ok(fin.E < 0 && fin.ecc < 0.05, `near-circular bound orbit (ecc ${fin.ecc})`);
				assert.ok(fin.peKm >= 140, `perigee ${fin.peKm} km`);
				assert.ok(fin.apKm >= 380 && fin.apKm <= 550, `apogee ${fin.apKm} km`);
			} else {
				const geometric = assistEntries.filter(g => designAssist(g.state, g.ref, g.tgtAp, g.tgtPe, { forceCircular: true }).intervenes);
				for (const g of geometric) {
					const wouldBe = designAssist(g.state, g.ref, g.tgtAp, g.tgtPe, { forceCircular: true }).angle;
					assert.ok(angleDiff(g.desired, wouldBe) > 1e-6, `no ORBIT_ASSIST for a non-circular target (t=${g.flightTime})`);
				}
				if (cfg.kind !== 'orbit') assert.ok(geometric.length > 0, 'the non-intervention check covered powered states inside the geometric window');
			}

			if (cfg.kind === 'orbit') {
				const fin = finalOrbit(world, rocket);
				assert.ok(fin.E < 0, 'bound orbit');
				assert.ok(fin.peKm >= 140, `perigee ${fin.peKm} km`);
			} else if (cfg.kind === 'apogee') {
				assert.ok(cut.orbit.E < 0);
				assert.ok(cut.orbit.apKm >= mission.targetApogeeKm, `apogee at cutoff ${cut.orbit.apKm} km >= ${mission.targetApogeeKm} km`);
				assert.ok(prev.orbit.apKm < mission.targetApogeeKm, 'cut off at the first crossing of the target apogee');
				assert.ok(cut.orbit.peKm >= 140, `perigee at cutoff ${cut.orbit.peKm} km`);
			} else if (cfg.kind === 'vinf') {
				assert.ok(cut.orbit.E >= 0, 'hyperbolic at cutoff');
				assert.ok(cut.orbit.vInfKmS >= mission.targetVInfKmS, `V∞ at cutoff ${cut.orbit.vInfKmS} km/s >= ${mission.targetVInfKmS}`);
				assert.ok(prev.orbit.E < 0 || prev.orbit.vInfKmS < mission.targetVInfKmS, 'cut off at the first crossing of the target V∞');
				const fin = finalOrbit(world, rocket);
				assert.ok(fin.E >= 0, 'still hyperbolic after a passive payload separation');
			}
		});
	}
});

// ---------------------------------------------------------------------------
// 2. Deferred separation in real flights
// ---------------------------------------------------------------------------

describe('Integration 13: deferred separation driven by profile action rows', () => {
	const pm = new PresetManager();

	it('LEO (h3_30): a sep_payload row turns the orbital cutoff into an ORBITAL_COAST hold with zero thrust', () => {
		const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_30'), payload: pm.getPayload('earth_obs'), mission: pm.getMission('leo_250km') });
		const SEP_T = 1500;
		const world = createWorld();
		const rocket = launchFromPlan(world, plan, [{ type: 'time', value: SEP_T, thrust: 100, angle: 90, action: 'sep_payload' }]);
		const { calls } = instrument(rocket);
		fly(world, rocket, { maxTime: SEP_T + 60, stop: r => r.isPayloadSeparated });

		const { call: cut, idx: cutIdx } = findCall(calls, c => c.before.stg === 1 && c.before.stageState === 'STG_BURNING' && c.after.stageState !== 'STG_BURNING', 'final-stage cutoff');
		assert.equal(cut.after.stageState, 'ORBITAL_COAST');
		assert.equal(cut.after.sep, false);
		assert.equal(cut.after.stg, 1);
		assert.equal(cut.after.burnTime, 0);
		assert.equal(cut.after.prop, 0);
		assert.equal(cut.after.thrustForce, 0);
		assert.equal(cut.after.isIgnited, false);
		assert.ok(cut.orbit.E < 0 && cut.orbit.peKm >= 140, `orbit at cutoff: pe ${cut.orbit.peKm} km`);

		const { call: pay, idx: payIdx } = findCall(calls, c => !c.before.sep && c.after.sep, 'payload separation');
		assert.equal(pay.t, SEP_T, 'released exactly when the action row latches');
		const hold = calls.slice(cutIdx + 1, payIdx);
		assert.ok(hold.length * DT > plan.stages[1].separationDelaySec * 100, `the hold outlasts the automatic delay (${hold.length * DT} s)`);
		for (const c of hold) {
			assert.equal(c.after.stageState, 'ORBITAL_COAST', `t=${c.t}`);
			assert.equal(c.after.sep, false, `t=${c.t}`);
			assert.equal(c.after.stg, 1, `t=${c.t}`);
			assert.equal(c.thrustRatio, 0, `t=${c.t}`);
			assert.equal(c.after.mass, cut.after.mass, `t=${c.t}`);
		}
		assert.equal(calls[payIdx - 1].t, SEP_T - DT);
		assert.equal(pay.after.stg, 2);
		assert.equal(pay.after.stageState, 'ORBITAL_COAST');
		assert.equal(debrisOfType(world, 2), 1, 'one upper-stage debris');
		const fin = finalOrbit(world, rocket);
		assert.ok(fin.E < 0 && fin.peKm >= 140, `payload stays in orbit (pe ${fin.peKm} km)`);
	});

	it('LEO (h3_30) control: without the row the payload separates after separationDelaySec', () => {
		const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_30'), payload: pm.getPayload('earth_obs'), mission: pm.getMission('leo_250km') });
		const world = createWorld();
		const rocket = launchFromPlan(world, plan);
		const { calls } = instrument(rocket);
		fly(world, rocket, { maxTime: 1200, stop: r => r.isPayloadSeparated });
		const cut = findCall(calls, c => c.before.stg === 1 && c.before.stageState === 'STG_BURNING' && c.after.stageState !== 'STG_BURNING', 'final-stage cutoff').call;
		assert.equal(cut.after.stageState, 'STG_MECO');
		const pay = findCall(calls, c => !c.before.sep && c.after.sep, 'payload separation').call;
		const delay = pay.t - cut.t;
		assert.ok(delay >= plan.stages[1].separationDelaySec - DT - 1e-9 && delay <= plan.stages[1].separationDelaySec + 1e-9, `delay ${delay}`);
	});

	it('Falcon 9 LEO: a sep_stage1 row holds the spent first stage in STG_MECO with zero thrust, then stages', () => {
		const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('falcon9'), payload: pm.getPayload('earth_obs'), mission: pm.getMission('leo_250km') });
		const SEP_T = 175;
		const world = createWorld();
		const rocket = launchFromPlan(world, plan, [{ type: 'time', value: SEP_T, thrust: 100, angle: 90, action: 'sep_stage1' }]);
		const { calls } = instrument(rocket);
		fly(world, rocket, { maxTime: 1200, stop: r => r.isPayloadSeparated });

		const { call: meco, idx: mecoIdx } = findCall(calls, c => c.before.stg === 0 && c.before.stageState === 'STG_BURNING' && c.after.stageState === 'STG_MECO', 'stage-1 MECO');
		assert.ok(meco.t + plan.stages[0].separationDelaySec < SEP_T, 'the reservation is later than the automatic separation would be');
		const { call: sep, idx: sepIdx } = findCall(calls, c => c.before.stg === 0 && c.after.stg === 1, 'stage-1 separation');
		assert.equal(sep.t, SEP_T);
		for (const c of calls.slice(mecoIdx + 1, sepIdx)) {
			assert.equal(c.after.stageState, 'STG_MECO', `t=${c.t}`);
			assert.equal(c.after.stg, 0, `t=${c.t}`);
			assert.equal(c.thrustRatio, 0, `t=${c.t}`);
			assert.equal(c.after.mass, meco.after.mass, `t=${c.t}`);
		}
		assert.equal(sep.after.stageState, 'INTERSTAGE_COAST');
		const ign = findCall(calls, c => c.before.stg === 1 && c.before.stageState === 'INTERSTAGE_COAST' && c.after.stageState === 'STG_BURNING', 'stage-2 ignition').call;
		assert.ok(ign.t - SEP_T <= plan.stages[1].ignitionDelaySec + 1e-9, 'stage 2 ignites after its ignition delay');
		assert.equal(debrisOfType(world, 1), 1, 'one first-stage debris');
		assert.equal(rocket.isPayloadSeparated, true);
		assert.ok(finalOrbit(world, rocket).E < 0, 'the vehicle still reaches a bound orbit');
	});
});

// ---------------------------------------------------------------------------
// 2b. A row met on the pad runs at liftoff (design §3.4-1, §4.14-9)
// ---------------------------------------------------------------------------

describe('Integration 13: an action row met on the pad (time 0, alt / vel 0) runs in the first flight step after the release, never in hold-down', () => {
	const pm = new PresetManager();
	/** The plan's rocket on the pad (hold-down, engine off) at the Earth's -Y side, with the extra rows. */
	const rolloutFromPlan = (world, plan, extraRows) => {
		const s0 = plan.stages[0];
		const dy = -(EARTH_RADIUS + 10);
		world.post({
			cmd: 'add', id: ROCKET_ID, name: 'Rocket', type: OBJECT_TYPES.ROCKET,
			x: AU, y: dy, vx: -OMEGA * dy, vy: EARTH_ORBIT_V, radius: s0.radius || 2.0, bottomOffsetM: 10, hostId: 1, hostAngleRad: -Math.PI / 2, hostAltM: 0,
			mass: s0.dryMassT, fuelMass: s0.fuelMassT, oxidMass: s0.oxidMassT, ofRatio: s0.ofRatio,
			burnTime: s0.burnTime, thrustForce: s0.thrustKN * 1000, thrustAngle: -Math.PI / 2, maxGLimit: 4.0,
			isIgnited: false, isHoldDown: true,
			stages: plan.stages, payload: plan.payload, fairing: plan.fairing, boosters: plan.boosters,
			flightProfile: plan.flightProfile.concat(extraRows),
			disableOrbitalCutoff: plan.disableOrbitalCutoff,
			targetApogeeKm: plan.targetApogeeKm, targetPerigeeKm: plan.targetPerigeeKm, targetVInfKmS: plan.targetVInfKmS
		});
		return world.engine.objects.find(o => o.id === ROCKET_ID);
	};
	const debris = (world) => world.engine.objects.filter(o => o.type === OBJECT_TYPES.DEBRIS).length;
	const PAD_STEPS = 40; // 20 s on the pad: 10 s before MAIN ENGINE START, 10 s with the engine running
	const holdOnPad = (world, rocket) => {
		for (let i = 0; i < PAD_STEPS; i++) {
			if (i === PAD_STEPS / 2) { world.post({ cmd: 'setRocketState', id: ROCKET_ID, isIgnited: true }); }
			world.engine._moveObjects(DT);
			assert.deepEqual([rocket.currentStageIndex, rocket.isPayloadSeparated, rocket.stageState, Boolean(rocket.fairing.isSeparated), debris(world), rocket.flightComputer.flightTime],
				[0, false, 'PRE_LAUNCH', false, 0, 0], `on the pad, sub-step ${i}: nothing separates, the MET stays 0`);
		}
	};

	for (const [label, row] of [
		['time 0', { type: 'time', value: 0, thrust: 100, angle: 90, action: 'sep_payload' }],
		['alt 0', { type: 'alt', value: 0, thrust: 100, angle: 90, action: 'sep_payload' }],
		['vel 0', { type: 'vel', value: 0, thrust: 100, angle: 90, action: 'sep_payload' }]
	]) {
		it(`sep_payload (${label}, self-propelled HTV-X): latched on the pad, waiting; the payload separates and lights in the first sub-step after the release, not before`, () => {
			const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_30'), payload: pm.getPayload('htv_x'), mission: pm.getMission('iss_rendezvous') });
			const world = createWorld();
			const rocket = rolloutFromPlan(world, plan, [row]);
			holdOnPad(world, rocket);
			const fc = rocket.flightComputer;
			assert.deepEqual(fc._pendingActions, ['sep_payload'], 'the row is latched on the pad and its action waits');
			assert.equal(fc.hasScheduledAction('sep_payload'), false);
			world.post({ cmd: 'rocketCommand', id: ROCKET_ID, command: 'RELEASE_HOLD_DOWN' });
			assert.equal(rocket.stageState, 'STG_BURNING', 'input: released');
			// An evaluation that advances no time (the predictor's evaluation at liftoff) does not run it either
			rocket.flightControl(0, world.earth, Math.hypot(rocket.x - world.earth.x, rocket.y - world.earth.y));
			assert.deepEqual([rocket.currentStageIndex, rocket.isPayloadSeparated, fc._pendingActions], [0, false, ['sep_payload']], 'dt = 0: still waiting');
			world.engine._moveObjects(DT);
			assert.equal(fc.flightTime, DT, 'the first flight sub-step');
			assert.deepEqual([rocket.currentStageIndex, rocket.isPayloadSeparated, rocket.fairing.isSeparated, rocket.stageState, rocket.isIgnited], [2, true, true, 'STG_BURNING', true],
				'separated (the stages and the fairing jettisoned) and the payload lit in this sub-step');
			assert.deepEqual(fc._pendingActions, []);
			assert.equal(debris(world), 2 + (plan.fairing?.enabled ? 2 : 0), 'the two stages (and the fairing halves) are jettisoned at liftoff');
		});
	}

	it('sep_stage1 at t = 0 (SRB vehicle): no stage separates and no upper stage lights on the pad; the first stage and its boosters go in the first flight sub-step, the second stage lights its ignition delay later', () => {
		const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_22'), payload: pm.getPayload('earth_obs'), mission: pm.getMission('leo_250km') });
		const world = createWorld();
		const rocket = rolloutFromPlan(world, plan, [{ type: 'time', value: 0, thrust: 100, angle: 90, action: 'sep_stage1' }]);
		holdOnPad(world, rocket);
		assert.equal(rocket.isBoosterSeparated, false);
		world.post({ cmd: 'rocketCommand', id: ROCKET_ID, command: 'RELEASE_HOLD_DOWN' });
		world.engine._moveObjects(DT);
		assert.deepEqual([rocket.currentStageIndex, rocket.stageState, rocket.isBoosterSeparated], [1, 'INTERSTAGE_COAST', true], 'separated in the first flight sub-step');
		const ignDelay = plan.stages[1].ignitionDelaySec;
		let lit = null;
		for (let i = 0; i < 20 && lit === null; i++) {
			world.engine._moveObjects(DT);
			if (rocket.stageState === 'STG_BURNING') { lit = rocket.flightComputer.flightTime; }
		}
		assert.ok(lit !== null && Math.abs(lit - (DT + ignDelay)) <= DT + 1e-9, `the second stage lights at ${lit} s (separation at ${DT} s + ${ignDelay} s)`);
	});

	it('control: the design plan alone (its first row is met on the pad, without an action) flies unchanged: nothing waits, the default staging', () => {
		const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_30'), payload: pm.getPayload('earth_obs'), mission: pm.getMission('leo_250km') });
		const world = createWorld();
		const rocket = rolloutFromPlan(world, plan, []);
		holdOnPad(world, rocket);
		assert.deepEqual(rocket.flightComputer._pendingActions, []);
		world.post({ cmd: 'rocketCommand', id: ROCKET_ID, command: 'RELEASE_HOLD_DOWN' });
		fly(world, rocket, { maxTime: 400, stop: r => r.currentStageIndex >= 1 });
		assert.equal(rocket.currentStageIndex, 1, 'the first stage separates by itself');
		assert.ok(rocket.flightComputer.flightTime > 100, `after its burn (${rocket.flightComputer.flightTime} s)`);
	});
});

describe('Integration 13: corrupted flight-profile rows on the Worker (design §3.4-1, Rev 6.10)', () => {
	it('a profile with null/number/string rows flies identically to the clean profile (LEO h3_30, sep_payload row)', () => {
		const pm = new PresetManager();
		const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_30'), payload: pm.getPayload('earth_obs'), mission: pm.getMission('leo_250km') });
		const SEP_T = 1500;
		const sepRow = { type: 'time', value: SEP_T, thrust: 100, angle: 90, action: 'sep_payload' };
		const clean = [...plan.flightProfile, sepRow];
		const junk = [null, 0, 'alt', undefined, false];
		const corrupted = [null];
		clean.forEach((r, i) => { corrupted.push(r, junk[i % junk.length]); });
		corrupted.push('x', 42);

		const runFlight = (profile) => {
			const world = createWorld();
			const rocket = launchFromPlan(world, { ...plan, flightProfile: profile });
			const { calls } = instrument(rocket);
			fly(world, rocket, { maxTime: SEP_T + 60, stop: r => r.isPayloadSeparated });
			return { rocket, calls };
		};
		const a = runFlight(clean);
		const b = runFlight(corrupted);

		assert.deepEqual(b.rocket.flightComputer.flightProfile, clean, 'the Worker flight computer keeps only the object rows');
		assert.equal(b.calls.length, a.calls.length);
		const events = (calls) => calls.filter((c, i) => i === 0 || c.after.stageState !== c.before.stageState || c.after.stg !== c.before.stg || c.after.sep !== c.before.sep)
			.map(c => [c.t, c.after.stageState, c.after.stg, c.after.sep]);
		assert.deepEqual(events(b.calls), events(a.calls));
		const pay = findCall(b.calls, c => !c.before.sep && c.after.sep, 'payload separation').call;
		assert.equal(pay.t, SEP_T, 'the action row (index shifted by the junk rows) still latches at its time');
		for (const k of ['x', 'y', 'vx', 'vy', 'mass']) {
			assert.equal(b.rocket[k], a.rocket[k], `final ${k} is bit-identical`);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. V∞ cutoff vs a self-propelled payload
// ---------------------------------------------------------------------------

describe('Integration 13: targetVInfKmS cutoff and a self-propelled payload (mars_transfer, h3_30 + mmx)', () => {
	it('cuts the upper stage at the target V∞ and never cuts the payload engine afterwards', () => {
		const pm = new PresetManager();
		const mission = pm.getMission('mars_transfer');
		const plan = pm.calculateMissionFlightPlan({ vehicle: pm.getVehicle('h3_30'), payload: pm.getPayload('mmx'), mission });
		const world = createWorld();
		const rocket = launchFromPlan(world, plan);
		const { calls } = instrument(rocket);
		fly(world, rocket, { maxTime: 2500, stop: r => r.isPayloadSeparated && r.stageState === 'ORBITAL_COAST' });

		const cut = findCall(calls, c => !c.before.sep && c.before.stg === 1 && c.before.stageState === 'STG_BURNING' && c.after.stageState !== 'STG_BURNING', 'upper-stage cutoff').call;
		assert.ok(cut.orbit.E >= 0 && cut.orbit.vInfKmS >= mission.targetVInfKmS, `V∞ at cutoff ${cut.orbit.vInfKmS}`);
		assert.ok(cut.before.prop > 2 * cut.before.massLossRate * DT, 'commanded cutoff');

		const pay = findCall(calls, c => !c.before.sep && c.after.sep, 'payload separation').call;
		assert.equal(pay.after.stageState, 'STG_COAST', 'the payload takes over propulsion');
		const payloadBurn = calls.filter(c => c.before.sep && c.before.stageState === 'STG_BURNING' && c.orbit && c.orbit.E >= 0 && c.orbit.vInfKmS >= mission.targetVInfKmS);
		assert.ok(payloadBurn.length > 100, `payload burns beyond the target V∞ (${payloadBurn.length} calls)`);
		for (const c of payloadBurn) {
			if (c.after.stageState !== 'STG_BURNING') {
				assert.equal(c.after.prop, 0, `t=${c.t}: the payload burn ends only by depletion`);
			}
		}
		const ended = calls.filter(c => c.before.sep && c.before.stageState === 'STG_BURNING' && c.after.stageState !== 'STG_BURNING');
		assert.equal(ended.length, 1);
		assert.equal(ended[0].after.stageState, 'ORBITAL_COAST');
		assert.ok(ended[0].before.prop <= 2 * ended[0].before.massLossRate * DT, 'burnout, not a cutoff');
		assert.ok(finalOrbit(world, rocket).vInfKmS > mission.targetVInfKmS + 1, 'V∞ grows well past the launcher target');
	});
});

// ---------------------------------------------------------------------------
// 4. App path into the Worker
// ---------------------------------------------------------------------------

describe('Integration 13: app path (applyToLauncher -> rollout -> ObjectPlacer -> ObjectManager -> Worker)', () => {
	it('carries action rows and deep-space targets into CalcRocket and the main thread mirrors the deferred hold', () => {
		const controller = new SimulationController();
		const sent = [];
		const workerManager = {
			postMessage(msg) {
				if (msg.cmd === 'returnBuffer') return;
				const clone = structuredClone(msg); // the Worker boundary copies messages
				sent.push(clone);
				controller.handleMessage({ data: clone });
			}
		};
		const sync = (om) => {
			const buf = WorkerBridge.formatWorkerToMain(controller.engine.objects);
			om.updateObjectParams({ objectsData: buf.buffer, validLength: buf.length });
		};

		const universe = createMockUniverse();
		const om = new ObjectManager(null, workerManager);
		universe.ObjectManager = om;
		universe.objects = om.objects;
		universe.addObject = (o) => om.addObject(o);
		universe.ObjectPlacer = new ObjectPlacer(universe);
		const earth = new CelestialBody(om.getNextId(), 'Earth', 0, 0, 0, 0, EARTH_PARAM.MASS, '#1E90FF', 1, EARTH_PARAM.RADIUS, 0, null, 0);
		earth.param = EARTH_PARAM;
		om.addObject(earth);

		const launcher = new RocketLauncher(universe);
		universe.RocketLauncher = launcher;
		launcher.mode = 'host';
		launcher.hostId = earth.id;
		presetManager.applyToLauncher(launcher, { vehicleId: 'h3_30', payloadId: 'earth_obs', missionId: 'mars_transfer' });
		const SEP_T = 700;
		launcher.flightProfile.push({ type: 'time', value: SEP_T, thrust: 100, angle: 90, action: 'sep_payload' }); // "+ Add Step" with the Pay action
		// The trajectory preview is outside this test
		launcher.updatePredictionSync = () => null;
		launcher.updatePrediction = () => null;
		launcher.rollout();

		const addMsg = sent.find(m => m.cmd === 'add' && m.type === OBJECT_TYPES.ROCKET);
		assert.ok(addMsg, 'rollout posts the rocket to the Worker');
		assert.deepEqual(addMsg.flightProfile, launcher.flightProfile);
		assert.equal(addMsg.flightProfile[addMsg.flightProfile.length - 1].action, 'sep_payload');
		assert.equal(addMsg.targetVInfKmS, 3.3);
		assert.equal(addMsg.disableOrbitalCutoff, true);
		assert.equal(addMsg.targetApogeeKm, 0);
		assert.equal(addMsg.isHoldDown, true);
		assert.equal(addMsg.isIgnited, false);
		assert.equal(addMsg.restoredRuntimeState, false);

		const rocket = controller.engine.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
		const rocketMain = om.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
		assert.deepEqual(rocket.flightProfile, launcher.flightProfile);
		assert.notStrictEqual(rocket.flightProfile, launcher.flightProfile);
		assert.equal(rocket.targetVInfKmS, 3.3);
		assert.equal(rocket.disableOrbitalCutoff, true);
		assert.equal(rocket.stageState, 'PRE_LAUNCH');
		assert.equal(rocket.burnTime, launcher.stages[0].burnTime, 'normal rollout initializes stage 1 (not the restore branch)');
		assert.equal(rocket.flightComputer.hasScheduledAction('sep_payload'), true);

		// Hold-down: the rocket rides the pad and the flight clock does not start
		const host = controller.engine.objects.find(o => o.id === earth.id);
		const padDist = Math.hypot(rocket.x - host.x, rocket.y - host.y);
		for (let i = 0; i < 10; i++) {
			controller.engine._moveObjects(DT);
			assert.ok(Math.abs(Math.hypot(rocket.x - host.x, rocket.y - host.y) - padDist) < 1e-6);
		}
		assert.equal(rocket.flightComputer.flightTime, 0);

		workerManager.postMessage({ cmd: 'setRocketState', id: rocket.id, isIgnited: true, isHoldDown: false });
		const { calls } = instrument(rocket);
		const world = { engine: controller.engine, earth: host };
		let synced = false;
		fly(world, rocket, {
			maxTime: SEP_T + 60,
			stop: (r) => {
				if (!synced && r.stageState === 'ORBITAL_COAST') {
					sync(om);
					synced = true;
					assert.equal(rocketMain.stageState, 'ORBITAL_COAST', 'the main thread mirrors the hold');
					assert.equal(rocketMain.isPayloadSeparated, false);
				}
				return r.isPayloadSeparated;
			}
		});
		assert.ok(synced, 'the deferred hold was reached');

		const cut = findCall(calls, c => !c.before.sep && c.before.stg === 1 && c.before.stageState === 'STG_BURNING' && c.after.stageState !== 'STG_BURNING', 'upper-stage cutoff').call;
		assert.equal(cut.after.stageState, 'ORBITAL_COAST');
		assert.ok(cut.orbit.E >= 0 && cut.orbit.vInfKmS >= 3.3 && cut.orbit.altM >= 140000, `V∞ ${cut.orbit.vInfKmS} at ${cut.orbit.altM} m`);
		assert.ok(cut.t < SEP_T);
		const pay = findCall(calls, c => !c.before.sep && c.after.sep, 'payload separation').call;
		assert.equal(pay.t, SEP_T);

		sync(om);
		assert.equal(rocketMain.isPayloadSeparated, true);
		assert.equal(rocketMain.name, launcher.payload.name);
		assert.equal(rocketMain.fairing.isSeparated, true);
		assert.notEqual(launcher.fairing.isSeparated, true, 'the launcher configuration is not touched by the flight');
	});
});
