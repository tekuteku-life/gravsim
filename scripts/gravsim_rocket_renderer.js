
// gravsim_rocket_renderer.js

import { PAD_EFFECT } from './gravsim_const.js';
import { AeroUtils, RocketStackUtils } from './gravsim_utils.js';
import { ROCKET_VISUAL } from './gravsim_preset_manager.js';

/** Vacuum lengthening of each fuel's plume in _drawPlume: length x (1 + (1 - p) x k). Unknown fuels draw as liquid. */
const PLUME_VACUUM_STRETCH = Object.freeze({ hydro: 0.15, solid: 0.12, ion: 0, liquid: 0.15 });

export class RocketRenderer {
	/** The per-fuel vacuum stretch of the plume length (design 2026-11-23 §3.7). */
	static get PLUME_VACUUM_STRETCH() {
		return PLUME_VACUUM_STRETCH;
	}

	static _resolveAmbientPresRatio(rocket) {
		if (rocket.ambientPresRatio !== undefined) {
			return rocket.ambientPresRatio;
		}
		if (rocket.telemetry?.ambientPresRatio !== undefined) {
			return rocket.telemetry.ambientPresRatio;
		}
		if (rocket.telemetry?.altM !== undefined) {
			return rocket.telemetry.altM > 100000 ? 0.0 : Math.exp(-rocket.telemetry.altM / 8500);
		}
		return rocket.inAtmosphere ? 1.0 : 0.0;
	}

	/**
	 * Whether the SRBs fire: attached, ignited and not burnt out. The SRBs ignite at the release of the hold-down
	 * (CalcRocket: isBoosterIgnited = !isHoldDown && isIgnited on the first stage). The Worker's isBoosterIgnited never
	 * reaches the main thread, so it is derived here from the synchronised flags (design §4.13-23). Both levels of detail
	 * use this one rule: the low detail widened the plume for the SRBs whenever they were not burnt out, so on the pad
	 * after MAIN ENGINE START (only the core fires) it showed them firing (design §4.13-29). The callers draw SRBs on
	 * the first stage only.
	 * @param {any} rocket
	 * @returns {boolean}
	 */
	static isBoosterFiring(rocket) {
		const isBoosterSeparated = Boolean(rocket.isBoosterSeparated || rocket.telemetry?.isBoosterSeparated);
		const isBoosterBurnout = Boolean(rocket.isBoosterBurnout || rocket.telemetry?.isBoosterBurnout);
		const isBoosterIgnited = !rocket.isHoldDown && rocket.isIgnited;
		return Boolean(isBoosterIgnited && !isBoosterBurnout && !isBoosterSeparated);
	}

	/**
	 * Whether the engine of the current stage (or of the separated payload) fires: ignited, with burn time left and a
	 * throttle above the plume threshold. Every stage, the self-propelled payload and both levels of detail use this one
	 * rule (design §4.13-29, §4.14-2).
	 * @param {any} rocket
	 * @returns {boolean}
	 */
	static isEngineFiring(rocket) {
		const threshold = ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD;
		return Boolean(rocket.isIgnited && (rocket.burnTime > 0) && (rocket.thrustRatio > threshold || (rocket.telemetry?.twr > threshold)));
	}

	/**
	 * Whether the separated payload fires its own engine: self-propelled (hasPayloadPropulsion, else
	 * payload.propulsion.enabled, as Rocket.mass reads it) and firing by isEngineFiring. After the separation the Worker
	 * runs the payload's propulsion on the same flags (isIgnited, burnTime, thrustRatio), which the telemetry reports as
	 * PES; a passive payload is never ignited. The payload-only drawing returned before any plume, so such a burn was
	 * never shown (design §4.14-2).
	 * @param {any} rocket
	 * @returns {boolean}
	 */
	static isPayloadEngineFiring(rocket) {
		const isSelfPropelled = Boolean(rocket.hasPayloadPropulsion || rocket.payload?.propulsion?.enabled);
		return isSelfPropelled && this.isEngineFiring(rocket);
	}

	/**
	 * The fuel type of the payload's engine (its plume): payload.propulsion.fuelType, else liquid. The rocket's own
	 * fuelType is the first stage's on the main thread.
	 * @param {any} rocket
	 * @returns {string}
	 */
	static payloadFuelType(rocket) {
		const fuelType = rocket.payload?.propulsion?.fuelType;
		return (typeof fuelType === 'string' && fuelType) ? fuelType : 'liquid';
	}

	static draw(ctx, rocket, x, y, screenRadius, zoomScale) {
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(rocket.thrustAngle);

		if (rocket.isInternalPower) {
			ctx.shadowColor = PAD_EFFECT.STRUCTURE.GLOW_COLOR;
			ctx.shadowBlur = Math.max(8, screenRadius * PAD_EFFECT.STRUCTURE.GLOW_BLUR_MULT);
		}

		const theme = ROCKET_VISUAL.THEMES[rocket.colorTheme] || ROCKET_VISUAL.THEMES.orange;
		const ambientPresRatio = this._resolveAmbientPresRatio(rocket);

		if (screenRadius < ROCKET_VISUAL.LOD_RADIUS_THRESHOLD) {
			this._drawLowDetail(ctx, rocket, screenRadius, theme, ambientPresRatio);
		} else {
			// One geometry for the hull and the effect anchors (design 2026-11-23 §3.2-3.4); the RCS jets are drawn last so
			// that engine plumes never hide them (§3.6, the user's choice)
			const geometry = this._computeStackGeometry(rocket, screenRadius, ROCKET_VISUAL);
			this._drawHighDetail(ctx, rocket, screenRadius, zoomScale, theme, ambientPresRatio, geometry);
			const layout = this._layoutFromGeometry(geometry, screenRadius, ROCKET_VISUAL);
			this.drawVaporCone(ctx, rocket, layout, ROCKET_VISUAL);
			this.drawColdGasRcs(ctx, rocket, layout, ROCKET_VISUAL);
		}

		ctx.restore();
	}

	/**
	 * The drawn shape of the rocket in its local frame (+x = nose), in screen pixels for the screen radius R. It is the
	 * only place the hull positions are computed: _drawHighDetail draws it, _layoutFromGeometry derives the vapor-cone
	 * and RCS anchors from it, the smoke emission (Rocket.updateHistory) and the pad's umbilical read it
	 * (design 2026-11-23 §3.2). Each position uses the same operations in the same order as the former
	 * _drawHighDetail, so the drawn hull is bit-identical.
	 * @param {any} rocket
	 * @param {number} R screen radius
	 * @param {any} [visualCfg]
	 * @returns {any}
	 */
	static _computeStackGeometry(rocket, R, visualCfg = ROCKET_VISUAL) {
		const state = RocketStackUtils.resolveStackState(rocket);
		const { curStgIdx, totalStg } = state;
		const m = visualCfg.MODULES;
		const align = visualCfg.ALIGNMENT;
		const r1 = R * m.STAGE1_RADIUS_RATIO;
		const l1 = R * m.STAGE1_LENGTH_RATIO;
		const r2 = R * m.STAGE2_RADIUS_RATIO;
		const l2 = R * m.STAGE2_LENGTH_RATIO;
		const r3 = R * (m.STAGE3_RADIUS_RATIO || 0.55);
		const l3 = R * (m.STAGE3_LENGTH_RATIO || 0.9);
		const lInter = R * m.INTERSTAGE_LENGTH_RATIO;
		const lInter2 = R * (m.INTERSTAGE2_LENGTH_RATIO || 0.25);
		const lFairing = R * m.FAIRING_LENGTH_RATIO;
		const lNozzle1 = R * m.NOZZLE1_LENGTH_RATIO;
		const lNozzle2 = R * m.NOZZLE2_LENGTH_RATIO;
		const lNozzle3 = R * (m.NOZZLE3_LENGTH_RATIO || 0.28);

		if (state.isPayloadOnly) {
			const payloadR = (totalStg === 1) ? r1 : ((totalStg >= 3) ? r3 : r2);
			const busW = payloadR * m.SATELLITE_BUS_W_RATIO;
			return {
				state,
				payload: { cx: 0, r: payloadR, isDeployed: true },
				fairing: null,
				fairingConfig: null,
				segments: [],
				boosterLayout: null,
				boostersAttached: false,
				plume: {
					x: -busW * 0.5,
					scale: align.PAYLOAD_PLUME_SCALE ?? 0.35,
					fuelType: this.payloadFuelType(rocket),
					isFiring: this.isPayloadEngineFiring(rocket)
				}
			};
		}

		/** A stage body; its own nozzle extends aft of startX (drawn exposed only for the lowest upper stage). */
		const stage = (stageIndex, startX, radius, length, lNozzle, isExposedNozzle) => ({
			kind: 'stage', stageIndex, startX, radius, length,
			nozzleX: startX - lNozzle, nozzleLength: lNozzle, isExposedNozzle, hasFins: stageIndex === 0
		});
		const interstage = (startX, radius, length) => ({ kind: 'interstage', startX, radius, length });

		let segments;
		let fairingX;
		let fairingR;
		let payloadR;
		let plumeScale;
		if (totalStg === 1) {
			// Single stage (SSTO): stage 1 and the fairing / payload
			const stg1X = R * (align.BASE_X_SINGLE_STAGE_RATIO ?? -1.5);
			fairingX = stg1X + l1;
			segments = [stage(0, stg1X, r1, l1, lNozzle1, false)];
			fairingR = r1;
			payloadR = r1;
			plumeScale = align.MAIN_PLUME_SCALE;
		} else if (totalStg >= 3) {
			// Three stages (Epsilon): stage 3 and its fairing ride on stage 2, which rides on stage 1
			fairingR = r2;
			payloadR = r3;
			if (curStgIdx === 0) {
				const stg1X = R * (align.BASE_X_3STG_STAGE1_RATIO ?? -3.1);
				const inter1X = stg1X + l1;
				const stg2X = inter1X + lInter;
				const inter2X = stg2X + l2;
				const stg3X = inter2X + lInter2;
				fairingX = stg3X + l3;
				segments = [
					stage(2, stg3X, r3, l3, lNozzle3, false),
					interstage(inter2X, r2, lInter2),
					stage(1, stg2X, r2, l2, lNozzle2, false),
					interstage(inter1X, r1, lInter),
					stage(0, stg1X, r1, l1, lNozzle1, false)
				];
				plumeScale = align.MAIN_PLUME_SCALE;
			} else if (curStgIdx === 1) {
				const stg2X = R * (align.BASE_X_3STG_STAGE2_RATIO ?? -1.6);
				const inter2X = stg2X + l2;
				const stg3X = inter2X + lInter2;
				fairingX = stg3X + l3;
				segments = [
					stage(2, stg3X, r3, l3, lNozzle3, false),
					interstage(inter2X, r2, lInter2),
					stage(1, stg2X, r2, l2, lNozzle2, true)
				];
				plumeScale = align.UPPER_PLUME_SCALE;
			} else {
				const stg3X = R * (align.BASE_X_3STG_STAGE3_RATIO ?? -0.9);
				fairingX = stg3X + l3;
				segments = [stage(2, stg3X, r3, l3, lNozzle3, true)];
				plumeScale = align.STAGE3_PLUME_SCALE ?? 0.5;
			}
		} else {
			// Two stages (Falcon 9, H3): stage 2 is the reference; stage 1 hangs below it through the interstage
			const hasStage1 = (curStgIdx === 0);
			const stg2X = hasStage1 ? R * align.BASE_X_STAGE1_RATIO : R * align.BASE_X_UPPER_RATIO;
			fairingX = stg2X + l2;
			segments = [stage(1, stg2X, r2, l2, lNozzle2, !hasStage1)];
			if (hasStage1) {
				const interX = stg2X - lInter;
				const stg1X = interX - l1;
				segments.push(interstage(interX, r1, lInter), stage(0, stg1X, r1, l1, lNozzle1, false));
			}
			fairingR = r2;
			payloadR = r2;
			plumeScale = hasStage1 ? align.MAIN_PLUME_SCALE : align.UPPER_PLUME_SCALE;
		}

		const isFairingConfigured = Boolean(rocket.disableStaging || rocket.fairing?.enabled);
		const fairingConfig = isFairingConfigured ? { startX: fairingX, radius: fairingR, length: lFairing } : null;
		const current = segments[segments.length - 1];
		const stage1 = segments.find(seg => seg.kind === 'stage' && seg.stageIndex === 0) || null;
		const boosterLayout = stage1 ? this._computeBoosterLayout(rocket, stage1.startX, stage1.radius, stage1.length, R) : null;
		const isBoosterSeparated = Boolean(rocket.isBoosterSeparated || rocket.telemetry?.isBoosterSeparated);
		return {
			state,
			payload: state.hasFairing ? null : { cx: fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO, r: payloadR, isDeployed: false },
			fairing: state.hasFairing ? fairingConfig : null,
			fairingConfig,
			segments,
			boosterLayout,
			boostersAttached: Boolean(boosterLayout) && !isBoosterSeparated,
			plume: {
				x: current.nozzleX,
				scale: plumeScale,
				fuelType: (rocket.stages && rocket.stages[curStgIdx]?.fuelType) || rocket.fuelType || 'liquid',
				isFiring: this.isEngineFiring(rocket)
			}
		};
	}

	/**
	 * Placement of the SRBs beside stage 1 (moved unchanged from _drawBoosters). null when the configuration has no
	 * SRB (RocketStackUtils.boosterCount is 0, also for a missing configuration).
	 * @param {any} rocket
	 * @param {number} stg1X aft end of stage 1
	 * @param {number} r1 stage-1 radius
	 * @param {number} l1 stage-1 length
	 * @param {number} R screen radius
	 * @returns {any}
	 */
	static _computeBoosterLayout(rocket, stg1X, r1, l1, R) {
		const boosters = RocketStackUtils.resolveBoosters(rocket);
		const count = RocketStackUtils.boosterCount(boosters);
		if (count <= 0) {
			return null;
		}
		const rB = R * (boosters.radiusRatio || 0.26);
		const lB = R * (boosters.lengthRatio || 1.70);
		const yOffset = r1 + rB * (boosters.offsetYRatio || 0.95);
		const xAttachOffset = l1 * (boosters.attachOffsetXRatio || 0.12);
		const xBase = stg1X + xAttachOffset;

		// Lateral Y positions of the boosters
		const yPositions = [];
		if (count === 2) {
			// Symmetrical top and bottom side boosters (H3-22 style)
			yPositions.push(-yOffset, yOffset);
		} else if (count === 4) {
			// Clustered pairs on both lateral sides (H3-24 style)
			const pairGap = rB * (boosters.pairSpacingRatio || 0.35);
			yPositions.push(-yOffset - pairGap, -yOffset + pairGap, yOffset - pairGap, yOffset + pairGap);
		} else {
			for (let i = 0; i < count; i++) {
				const sign = (i % 2 === 0) ? -1 : 1;
				const tier = Math.floor(i / 2);
				yPositions.push(sign * (yOffset + tier * rB * 0.7));
			}
		}

		return {
			count,
			rB,
			lB,
			yOffset,
			xBase,
			lNozzleB: R * (boosters.nozzleLengthRatio || 0.20),
			lNoseB: R * (boosters.noseConeLengthRatio || 0.35),
			yPositions,
			casingColor: boosters.casingColor || '#f0f2f5',
			noseConeColor: boosters.noseConeColor || '#22262c',
			bandColor: boosters.bandColor || '#c85a1a',
			nozzleColor: boosters.nozzleColor || '#1c2024',
			plumeFuel: boosters.plumeFuel || 'solid',
			plumeScale: boosters.plumeScale || 0.55
		};
	}

	/**
	 * Effect anchors of the drawn rocket (design 2026-11-23 §3.4): the vapor-cone vertices and the RCS nozzles.
	 * @param {any} rocket
	 * @param {number} R screen radius
	 * @param {any} [visualCfg]
	 * @returns {{ screenRadius: number, noseShoulder: any, interstageShoulder: any, rcs: any }}
	 */
	static _computeVisualLayout(rocket, R, visualCfg = ROCKET_VISUAL) {
		return this._layoutFromGeometry(this._computeStackGeometry(rocket, R, visualCfg), R, visualCfg);
	}

	/**
	 * Effect anchors from a geometry. noseShoulder: the fairing base, else the front of the exposed / deployed payload.
	 * interstageShoulder: the forward edge of the uppermost interstage (the aft end of the stage above it), or null.
	 * @param {any} geometry _computeStackGeometry
	 * @param {number} R screen radius
	 * @param {any} [visualCfg]
	 * @returns {{ screenRadius: number, noseShoulder: any, interstageShoulder: any, rcs: any }}
	 */
	static _layoutFromGeometry(geometry, R, visualCfg = ROCKET_VISUAL) {
		const m = visualCfg.MODULES;
		let noseShoulder;
		if (geometry.fairing) {
			noseShoulder = { x: geometry.fairing.startX, halfWidth: geometry.fairing.radius };
		} else {
			const p = geometry.payload;
			noseShoulder = { x: p.cx + 0.5 * p.r * m.SATELLITE_BUS_W_RATIO, halfWidth: 0.5 * p.r * m.SATELLITE_BUS_H_RATIO };
		}
		const segs = geometry.segments;
		const iInter = segs.findIndex(seg => seg.kind === 'interstage');
		const interstageShoulder = (iInter > 0) ? { x: segs[iInter - 1].startX, halfWidth: segs[iInter].radius } : null;
		return { screenRadius: R, noseShoulder, interstageShoulder, rcs: this._rcsNozzles(geometry, visualCfg) };
	}

	/**
	 * Cold-gas RCS nozzles (design 2026-11-23 §3.6). Stack: lateral jets from the wall of the current stage, at the
	 * FWD / AFT fractions of the foremost / aftmost free stretch of wall, where the jet triangle (half angle
	 * PLUME_SPREAD_RAD) clears every part standing out of the wall (fins, SRBs, a wider neighbour). The parts come from
	 * the configuration, so separating the fairing or the SRBs never moves a nozzle. Payload only: axial jets from
	 * the bus corners, clear of the solar panels. null when no free wall is left.
	 * @param {any} geometry
	 * @param {any} visualCfg
	 * @returns {any}
	 */
	static _rcsNozzles(geometry, visualCfg) {
		const cfg = visualCfg?.COLD_GAS_RCS;
		if (!cfg) {
			return null;
		}
		const m = visualCfg.MODULES;
		const cant = cfg.ULLAGE_CANT_RAD ?? 0.28;
		const cosC = Math.cos(cant);
		const sinC = Math.sin(cant);

		if (geometry.state.isPayloadOnly) {
			const p = geometry.payload;
			const a = 0.5 * p.r * m.SATELLITE_BUS_W_RATIO;
			const b = 0.5 * p.r * m.SATELLITE_BUS_H_RATIO;
			return {
				plumeLen: Math.max(cfg.MIN_PLUME_PX, b * cfg.PLUME_LEN_WIDTH_RATIO),
				cw: [{ x: -a, y: -b, ux: -1, uy: 0 }, { x: a, y: b, ux: 1, uy: 0 }],
				ccw: [{ x: -a, y: b, ux: -1, uy: 0 }, { x: a, y: -b, ux: 1, uy: 0 }],
				ullage: [{ x: -a, y: b, ux: -cosC, uy: sinC }, { x: -a, y: -b, ux: -cosC, uy: -sinC }]
			};
		}

		const segs = geometry.segments;
		const body = segs[segs.length - 1];
		const h = body.radius;
		const plumeLen = Math.max(cfg.MIN_PLUME_PX, h * cfg.PLUME_LEN_WIDTH_RATIO);
		const tanSpread = Math.tan(cfg.PLUME_SPREAD_RAD ?? 0.34);

		// Parts standing out of the wall: x range and how far they stand out (e)
		const parts = [];
		if (body.hasFins) {
			parts.push({ a: body.startX, b: body.startX + body.length * m.FIN_BASE_RATIO, e: body.radius * m.FIN_SPAN_RATIO });
		}
		const boosters = geometry.boosterLayout;
		if (body.stageIndex === 0 && boosters) {
			const outer = Math.max(...boosters.yPositions.map(Math.abs)) + boosters.rB;
			parts.push({ a: boosters.xBase - boosters.lNozzleB, b: boosters.xBase + boosters.lB + boosters.lNoseB, e: outer - h });
		}
		const above = segs.length >= 2 ? segs[segs.length - 2] : null;
		if (above) {
			parts.push({ a: above.startX, b: above.startX + above.length, e: above.radius - h });
		} else if (geometry.fairingConfig) {
			const f = geometry.fairingConfig;
			parts.push({ a: f.startX, b: f.startX + f.length, e: f.radius - h });
		}

		// Only stretches of positive length are free wall, the body itself included (a degenerate R or stage length
		// leaves none)
		let free = [[body.startX, body.startX + body.length]].filter(([u, v]) => v > u);
		for (const part of parts) {
			if (!(part.e > 0)) {
				continue;
			}
			const margin = Math.min(part.e, plumeLen) * tanSpread;
			const lo = part.a - margin;
			const hi = part.b + margin;
			free = free.flatMap(([u, v]) => {
				const out = [];
				if (lo > u) out.push([u, Math.min(v, lo)]);
				if (hi < v) out.push([Math.max(u, hi), v]);
				return out.filter(([p0, p1]) => p1 > p0);
			});
		}
		if (free.length === 0) {
			return null;
		}
		free.sort((p0, p1) => p0[0] - p1[0]);
		const [fwdLo, fwdHi] = free[free.length - 1];
		const [aftLo, aftHi] = free[0];
		const xFwd = fwdLo + (fwdHi - fwdLo) * cfg.FWD_STATION_FRACTION;
		const xAft = aftLo + (aftHi - aftLo) * cfg.AFT_STATION_FRACTION;
		return {
			plumeLen,
			cw: [{ x: xFwd, y: -h, ux: 0, uy: -1 }, { x: xAft, y: h, ux: 0, uy: 1 }],
			ccw: [{ x: xFwd, y: h, ux: 0, uy: 1 }, { x: xAft, y: -h, ux: 0, uy: -1 }],
			ullage: [{ x: xAft, y: h, ux: -cosC, uy: sinC }, { x: xAft, y: -h, ux: -cosC, uy: -sinC }]
		};
	}

	/**
	 * The drawn parts that make up the side-view silhouette: x range and radius at x (stage bodies, interstages, the
	 * attached fairing's curve, the stowed payload bus).
	 * @param {any} geometry
	 * @param {any} visualCfg
	 * @returns {Array<{ a: number, b: number, radiusAt: (x: number) => number }>}
	 */
	static _silhouetteParts(geometry, visualCfg = ROCKET_VISUAL) {
		// The stack is one continuous body: each segment reaches the start of the one on its nose side, so the last-bit
		// gap that rounding leaves at a joint (stage 1 is built downwards from stage 2) is not a hole in the outline
		const segs = geometry.segments;
		const parts = segs.map((seg, i) => ({
			a: seg.startX,
			b: (i > 0) ? Math.max(seg.startX + seg.length, segs[i - 1].startX) : seg.startX + seg.length,
			radiusAt: () => seg.radius
		}));
		const f = geometry.fairing;
		if (f) {
			parts.push({ a: f.startX, b: f.startX + f.length, radiusAt: (x) => this._fairingRadiusAt(f, x, visualCfg) });
		}
		const p = geometry.payload;
		if (p && !p.isDeployed) {
			const m = visualCfg.MODULES;
			const halfW = 0.5 * p.r * m.SATELLITE_BUS_W_RATIO;
			const halfH = 0.5 * p.r * m.SATELLITE_BUS_H_RATIO;
			parts.push({ a: p.cx - halfW, b: p.cx + halfW, radiusAt: () => halfH });
		}
		return parts;
	}

	/**
	 * Half-height of the drawn silhouette at x: the largest radius of the drawn parts covering x, or null where nothing
	 * is drawn (design 2026-11-23 §3.8).
	 * @param {any} geometry
	 * @param {number} x
	 * @param {any} [visualCfg]
	 * @returns {number|null}
	 */
	static bodyRadiusAt(geometry, x, visualCfg = ROCKET_VISUAL) {
		let best = null;
		for (const part of this._silhouetteParts(geometry, visualCfg)) {
			if (x >= part.a && x <= part.b) {
				const r = part.radiusAt(x);
				if (best === null || r > best) best = r;
			}
		}
		return best;
	}

	/**
	 * Smallest silhouette half-height over [x0, x1], or null when part of the range has nothing drawn. Every part is
	 * constant or narrows towards the nose (the fairing), so on each stretch between part boundaries the minimum is at
	 * its forward end.
	 * @param {any} geometry
	 * @param {number} x0
	 * @param {number} x1
	 * @param {any} [visualCfg]
	 * @returns {number|null}
	 */
	static minBodyRadiusOver(geometry, x0, x1, visualCfg = ROCKET_VISUAL) {
		if (x0 > x1) {
			[x0, x1] = [x1, x0];
		}
		const parts = this._silhouetteParts(geometry, visualCfg);
		const cuts = [x0, x1];
		for (const part of parts) {
			for (const x of [part.a, part.b]) {
				if (x > x0 && x < x1) cuts.push(x);
			}
		}
		cuts.sort((u, v) => u - v);
		let min = null;
		for (let i = 0; i + 1 < cuts.length; i++) {
			const u = cuts[i];
			const v = cuts[i + 1];
			if (!(v > u)) continue;
			const mid = 0.5 * (u + v);
			let best = null;
			for (const part of parts) {
				if (mid >= part.a && mid <= part.b) {
					const r = part.radiusAt(Math.min(v, part.b));
					if (best === null || r > best) best = r;
				}
			}
			if (best === null) return null;
			if (min === null || best < min) min = best;
		}
		return min === null ? this.bodyRadiusAt(geometry, x0, visualCfg) : min;
	}

	/**
	 * Half-height of the fairing curve at x (_drawFairing: a quadratic Bézier from (startX, radius) through the control
	 * point (startX + length * FAIRING_CURVE_X_RATIO, radius * FAIRING_CURVE_Y_RATIO) to (startX + length, 0)).
	 * @param {{ startX: number, radius: number, length: number }} f
	 * @param {number} x within [startX, startX + length]
	 * @param {any} visualCfg
	 * @returns {number}
	 */
	static _fairingRadiusAt(f, x, visualCfg) {
		const m = visualCfg.MODULES;
		const cx = f.length * m.FAIRING_CURVE_X_RATIO;
		const cy = f.radius * m.FAIRING_CURVE_Y_RATIO;
		// x(t) = startX + 2t(1 - t) cx + t^2 length  ->  (length - 2 cx) t^2 + 2 cx t - (x - startX) = 0
		const qa = f.length - 2 * cx;
		const qb = 2 * cx;
		const qc = -(x - f.startX);
		const root = Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc));
		// The roots (-qb ± root) / (2 qa) as q / qa and qc / q, with q = -(qb + sign(qb) root) / 2: these forms lose no
		// digits to cancellation, so they stay exact as qa -> 0 (the linear case FAIRING_CURVE_X_RATIO = 0.5, where the
		// root is -qc / qb) and near x = startX
		const q = -0.5 * (qb + Math.sign(qb || 1) * root);
		const byQ = (q !== 0) ? qc / q : 0;
		const byA = (qa !== 0) ? q / qa : byQ;
		// t1 = (-qb + root) / (2 qa), the root on the curve while the control point lies inside the fairing; t2 the other
		const t1 = (qb >= 0) ? byQ : byA;
		const t2 = (qb >= 0) ? byA : byQ;
		let t = (t1 >= -1e-9 && t1 <= 1 + 1e-9) ? t1 : t2;
		t = Math.max(0, Math.min(1, t));
		return (1 - t) * (1 - t) * f.radius + 2 * t * (1 - t) * cy;
	}

	/**
	 * Nominal (flicker-free) length of an engine plume: the length _drawPlume draws with zero flicker.
	 * @param {number} R scale (screen radius, or metres for the smoke emission)
	 * @param {number} scale plume scale of the stage
	 * @param {number} throttle
	 * @param {string} fuelType
	 * @param {number} [ambientPresRatio]
	 * @returns {number}
	 */
	static nominalPlumeLength(R, scale, throttle, fuelType, ambientPresRatio = 1.0) {
		const cfg = ROCKET_VISUAL.PLUMES[fuelType] || ROCKET_VISUAL.PLUMES.liquid;
		const p = Math.max(0, Math.min(1.0, ambientPresRatio));
		const k = PLUME_VACUUM_STRETCH[fuelType] ?? PLUME_VACUUM_STRETCH.liquid;
		return R * cfg.lenMult * scale * throttle * (1.0 + (1.0 - p) * k);
	}

	static _drawRcsPlume(ctx, x, y, ux, uy, plumeLen, cfg) {
		const spread = cfg.PLUME_SPREAD_RAD ?? 0.34;
		const baseAngle = Math.atan2(uy, ux);
		const drawCone = (len, angSpread, color) => {
			const a1 = baseAngle - angSpread;
			const a2 = baseAngle + angSpread;
			ctx.fillStyle = color;
			ctx.beginPath();
			ctx.moveTo(x, y);
			ctx.lineTo(x + Math.cos(a1) * len, y + Math.sin(a1) * len);
			ctx.lineTo(x + Math.cos(a2) * len, y + Math.sin(a2) * len);
			ctx.closePath();
			ctx.fill();
		};
		drawCone(plumeLen, spread, cfg.MIST_COLOR);
		drawCone(plumeLen * 0.65, spread * 0.45, cfg.CORE_COLOR);
	}

	static drawColdGasRcs(ctx, rocket, layout, visualCfg = ROCKET_VISUAL) {
		if (!rocket || !layout || !visualCfg?.COLD_GAS_RCS) return;
		if (Number.isFinite(layout.screenRadius) && layout.screenRadius < (visualCfg.LOD_RADIUS_THRESHOLD ?? 10)) return;
		const rcsCw = Boolean(rocket.rcsCw || rocket.telemetry?.rcsCw);
		const rcsCcw = Boolean(rocket.rcsCcw || rocket.telemetry?.rcsCcw);
		const rcsUllage = Boolean(rocket.rcsUllage || rocket.telemetry?.rcsUllage);
		if (!rcsCw && !rcsCcw && !rcsUllage) return;
		const rcs = layout.rcs;
		if (!rcs) return;

		const cfg = visualCfg.COLD_GAS_RCS;
		const drawNozzles = (nozzles) => {
			for (const n of nozzles) {
				this._drawRcsPlume(ctx, n.x, n.y, n.ux, n.uy, rcs.plumeLen, cfg);
			}
		};
		if (rcsCw) drawNozzles(rcs.cw);
		if (rcsCcw) drawNozzles(rcs.ccw);
		if (rcsUllage) drawNozzles(rcs.ullage);
	}

	static drawVaporCone(ctx, rocket, layout, visualCfg = ROCKET_VISUAL) {
		if (!rocket || !layout || !visualCfg?.VAPOR_CONE) return;
		if (Number.isFinite(layout.screenRadius) && layout.screenRadius < (visualCfg.LOD_RADIUS_THRESHOLD ?? 10)) return;
		const mach = Number.isFinite(rocket.mach) ? rocket.mach : (rocket.telemetry?.mach ?? 0);
		const ambientPresRatio = this._resolveAmbientPresRatio(rocket);
		const vapor = AeroUtils.computeVaporConeParams(mach, ambientPresRatio);
		if (!vapor.active || vapor.intensity <= 0.01) return;
		const primary = layout.noseShoulder;
		if (!primary) return;

		const cfg = visualCfg.VAPOR_CONE;
		// A cone opens aft from its vertex on the axis; its size follows the body radius at the vertex (design 2026-11-23 §3.5)
		const drawConeAt = (anchor, scale) => {
			const xVertex = anchor.x;
			const h = anchor.halfWidth;
			const coneLen = h * cfg.CONE_LENGTH_RATIO * (0.75 + 0.5 * vapor.intensity) * scale;
			const coneHalfW = Math.min(
				h * cfg.MAX_WIDTH_MULTIPLIER,
				h * (1.1 + 1.35 * vapor.intensity * Math.sin(vapor.machAngleRad))
			) * scale;
			const xBack = xVertex - coneLen;
			const noseRimX = xVertex - h * 0.25 * scale;
			const grad = ctx.createRadialGradient(
				xVertex, 0, h * 0.15 * scale,
				xBack + coneLen * 0.35, 0, Math.max(coneLen, coneHalfW)
			);
			grad.addColorStop(0, cfg.CORE_COLOR);
			grad.addColorStop(0.55, cfg.CORE_COLOR);
			grad.addColorStop(1, cfg.EDGE_COLOR);

			ctx.fillStyle = grad;
			ctx.beginPath();
			ctx.moveTo(xVertex, 0);
			ctx.quadraticCurveTo(xVertex - coneLen * 0.22, -coneHalfW * 0.72, xBack, -coneHalfW);
			ctx.quadraticCurveTo(xBack + coneLen * 0.22, 0, xBack, coneHalfW);
			ctx.quadraticCurveTo(xVertex - coneLen * 0.22, coneHalfW * 0.72, xVertex, 0);
			ctx.closePath();
			ctx.fill();

			ctx.save();
			ctx.globalAlpha = Math.min(1, 0.4 + 0.6 * vapor.intensity);
			ctx.strokeStyle = cfg.RIM_COLOR;
			ctx.lineWidth = Math.max(1, h * 0.12);
			ctx.beginPath();
			ctx.moveTo(xBack, -coneHalfW);
			ctx.quadraticCurveTo(noseRimX, 0, xBack, coneHalfW);
			ctx.stroke();
			ctx.restore();
		};

		// Primary at the nose shoulder; the secondary at the uppermost interstage when the intensity is high
		drawConeAt(primary, 1.0);
		if (layout.interstageShoulder && vapor.intensity >= cfg.SECONDARY_INTENSITY_MIN) {
			drawConeAt(layout.interstageShoulder, 0.78);
		}
	}

	static _drawLowDetail(ctx, rocket, R, theme, ambientPresRatio = 1.0) {
		// The stack state of both levels of detail (design 2026-11-23 §3.1)
		const { isPayloadOnly, curStgIdx } = RocketStackUtils.resolveStackState(rocket);
		const hasStage1 = !isPayloadOnly && (curStgIdx === 0);
		const lod = ROCKET_VISUAL.LOW_DETAIL;

		if (isPayloadOnly) {
			// Draw high-visibility mini satellite icon even in low detail
			const iconW = R * lod.SATELLITE_BUS_W_RATIO;
			const iconH = R * lod.SATELLITE_BUS_H_RATIO;
			ctx.fillStyle = lod.SATELLITE_BUS_COLOR;
			ctx.fillRect(-iconW * 0.5, -iconH * 0.5, iconW, iconH);

			// Blue solar paddles
			ctx.fillStyle = lod.SOLAR_PADDLE_COLOR;
			ctx.fillRect(-iconW * lod.PADDLE_OFFSET_X_RATIO, -iconH * 0.5 - R * lod.PADDLE_OFFSET_Y_RATIO, iconW * lod.PADDLE_W_RATIO, R * lod.PADDLE_H_RATIO);
			ctx.fillRect(-iconW * lod.PADDLE_OFFSET_X_RATIO, iconH * 0.5 + R * lod.PADDLE_GAP_RATIO, iconW * lod.PADDLE_W_RATIO, R * lod.PADDLE_H_RATIO);

			// The payload's own burn: the plume of the stages (below), scaled to the payload, behind the bus
			if (this.isPayloadEngineFiring(rocket)) {
				const p = Math.max(0, Math.min(1.0, ambientPresRatio !== undefined ? ambientPresRatio : 1.0));
				const e_vac = 1.0 - p;
				const payloadScale = ROCKET_VISUAL.ALIGNMENT.PAYLOAD_PLUME_SCALE ?? 0.35;
				// The low detail draws one schematic plume for every fuel, with its own vacuum stretch (not PLUME_VACUUM_STRETCH)
				const plumeLen = R * lod.PLUME_LEN_RATIO * payloadScale * (rocket.thrustRatio || 1.0) * (1.0 + e_vac * 0.15);
				const halfW = iconH * lod.PLUME_WIDTH_RATIO * (1.0 + e_vac * 1.3);
				ctx.fillStyle = lod.PLUME_COLOR;
				ctx.beginPath();
				ctx.moveTo(-iconW * 0.5, -halfW);
				ctx.lineTo(-iconW * 0.5 - plumeLen, 0);
				ctx.lineTo(-iconW * 0.5, halfW);
				ctx.closePath();
				ctx.fill();
			}
			return;
		}

		const len = hasStage1 ? R * lod.STAGE1_LEN_RATIO : R * lod.STAGE2_LEN_RATIO;
		let width = R * lod.WIDTH_RATIO;

		const isBoosterSeparated = Boolean(
			rocket.isBoosterSeparated ||
			rocket.telemetry?.isBoosterSeparated
		);
		const boosterCount = (hasStage1 && !isBoosterSeparated) ? RocketStackUtils.boosterCount(RocketStackUtils.resolveBoosters(rocket)) : 0;
		if (boosterCount === 2) {
			width *= 1.35;
		} else if (boosterCount >= 4) {
			width *= 1.65;
		}

		ctx.fillStyle = hasStage1 ? theme.stg1Grad[1] : theme.stg2Grad[0];
		ctx.beginPath();
		ctx.ellipse(0, 0, len * 0.5, width * 0.5, 0, 0, Math.PI * 2);
		ctx.fill();

		const isFiring = this.isEngineFiring(rocket);
		if (isFiring) {
			const p = Math.max(0, Math.min(1.0, ambientPresRatio !== undefined ? ambientPresRatio : 1.0));
			const e_vac = 1.0 - p;
			// The low detail draws one schematic plume for every fuel, with its own vacuum stretch (not PLUME_VACUUM_STRETCH)
			const plumeLen = R * lod.PLUME_LEN_RATIO * (rocket.thrustRatio || 1.0) * (1.0 + e_vac * 0.15);
			// The SRBs widen the plume only while they fire (the rule of the high detail, isBoosterFiring)
			const isBoosterFiring = this.isBoosterFiring(rocket);
			const boosterMult = (isBoosterFiring && boosterCount >= 4) ? 1.5 : ((isBoosterFiring && boosterCount === 2) ? 1.25 : 1.0);
			const plumeWidthMult = boosterMult * (1.0 + e_vac * 1.3);
			ctx.fillStyle = lod.PLUME_COLOR;
			ctx.beginPath();
			ctx.moveTo(-len * 0.5, -width * lod.PLUME_WIDTH_RATIO * plumeWidthMult);
			ctx.lineTo(-len * 0.5 - plumeLen, 0);
			ctx.lineTo(-len * 0.5, width * lod.PLUME_WIDTH_RATIO * plumeWidthMult);
			ctx.closePath();
			ctx.fill();
		}
	}

	static _drawHighDetail(ctx, rocket, R, zoomScale, theme, ambientPresRatio = 1.0, geometry = this._computeStackGeometry(rocket, R)) {
		const plume = geometry.plume;
		const throttle = rocket.thrustRatio || 1.0;

		if (geometry.state.isPayloadOnly) {
			this._drawPayloadSatellite(ctx, 0, 0, geometry.payload.r, true);
			// The payload's own burn, behind the bus (its aft face, -x), with the plume of its propulsion's fuel type
			if (plume.isFiring) {
				this._drawPlume(ctx, plume.x, 0, plume.scale, throttle, plume.fuelType, R, ambientPresRatio);
			}
			return;
		}

		// Nose: the fairing, or the stowed payload when there is none
		if (geometry.fairing) {
			const f = geometry.fairing;
			this._drawFairing(ctx, f.startX, f.radius, f.length, theme);
		} else {
			const p = geometry.payload;
			this._drawPayloadSatellite(ctx, p.cx, 0, p.r, false);
		}

		// Bodies from the nose to the tail (stage 1 with its SRBs)
		for (const seg of geometry.segments) {
			if (seg.kind === 'interstage') {
				this._drawInterstage(ctx, seg.startX, seg.radius, seg.length, theme);
			} else if (seg.stageIndex === 0) {
				this._drawStage1(ctx, seg.startX, seg.radius, seg.length, seg.nozzleX, seg.nozzleLength, theme);
				this._drawBoosters(ctx, rocket, seg.startX, seg.radius, seg.length, seg.nozzleX, seg.nozzleLength, theme, plume.isFiring, throttle, R, ambientPresRatio);
			} else {
				this._drawStage2(ctx, seg.startX, seg.radius, seg.length, seg.isExposedNozzle, seg.nozzleX, seg.nozzleLength, theme);
			}
		}

		if (plume.isFiring) {
			this._drawPlume(ctx, plume.x, 0, plume.scale, throttle, plume.fuelType, R, ambientPresRatio);
		}
	}

	static _drawFairing(ctx, startX, radius, length, theme) {
		const m = ROCKET_VISUAL.MODULES;
		const grad = ctx.createLinearGradient(0, -radius, 0, radius);
		grad.addColorStop(0, theme.fairingGrad[0]);
		grad.addColorStop(0.4, theme.fairingGrad[1]);
		grad.addColorStop(1, theme.fairingGrad[2]);

		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.moveTo(startX, -radius);
		ctx.quadraticCurveTo(startX + length * m.FAIRING_CURVE_X_RATIO, -radius * m.FAIRING_CURVE_Y_RATIO, startX + length, 0);
		ctx.quadraticCurveTo(startX + length * m.FAIRING_CURVE_X_RATIO, radius * m.FAIRING_CURVE_Y_RATIO, startX, radius);
		ctx.closePath();
		ctx.fill();

		ctx.strokeStyle = theme.fairingLine;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(startX, 0);
		ctx.lineTo(startX + length - m.FAIRING_TIP_MARGIN, 0);
		ctx.stroke();

		ctx.fillStyle = theme.accentBand;
		ctx.fillRect(startX, -radius, Math.max(m.FAIRING_BAND_MIN_W, radius * m.FAIRING_BAND_W_RATIO), radius * 2);
	}

	static _drawStage2(ctx, startX, radius, length, isExposedNozzle, nozzleX, nozzleLen, theme) {
		const m = ROCKET_VISUAL.MODULES;
		const grad = ctx.createLinearGradient(0, -radius, 0, radius);
		grad.addColorStop(0, theme.stg2Grad[0]);
		grad.addColorStop(0.4, theme.stg2Grad[1]);
		grad.addColorStop(1, theme.stg2Grad[2]);

		ctx.fillStyle = grad;
		ctx.fillRect(startX, -radius, length, radius * 2);

		ctx.strokeStyle = m.STAGE2_BORDER_COLOR;
		ctx.lineWidth = 1;
		ctx.strokeRect(startX, -radius, length, radius * 2);

		if (isExposedNozzle) {
			ctx.fillStyle = theme.nozzle;
			ctx.beginPath();
			ctx.moveTo(startX, -radius * m.STAGE2_NOZZLE_BASE_RATIO);
			ctx.lineTo(nozzleX, -radius * m.STAGE2_NOZZLE_BELL_RATIO);
			ctx.lineTo(nozzleX, radius * m.STAGE2_NOZZLE_BELL_RATIO);
			ctx.lineTo(startX, radius * m.STAGE2_NOZZLE_BASE_RATIO);
			ctx.closePath();
			ctx.fill();
		}
	}

	static _drawInterstage(ctx, startX, radius, length, theme) {
		const m = ROCKET_VISUAL.MODULES;
		ctx.fillStyle = theme.interstage;
		ctx.fillRect(startX, -radius, length, radius * 2);

		ctx.strokeStyle = m.INTERSTAGE_BORDER_COLOR;
		ctx.lineWidth = 1;
		ctx.strokeRect(startX, -radius, length, radius * 2);
	}

	static _drawStage1(ctx, startX, radius, length, nozzleX, nozzleLen, theme) {
		const m = ROCKET_VISUAL.MODULES;
		const grad = ctx.createLinearGradient(0, -radius, 0, radius);
		grad.addColorStop(0, theme.stg1Grad[0]);
		grad.addColorStop(0.4, theme.stg1Grad[1]);
		grad.addColorStop(1, theme.stg1Grad[2]);

		ctx.fillStyle = grad;
		ctx.fillRect(startX, -radius, length, radius * 2);

		ctx.fillStyle = theme.accentBand;
		ctx.fillRect(startX + length - Math.max(m.STAGE1_BAND_MIN_W, length * m.STAGE1_BAND_W_RATIO), -radius, Math.max(m.STAGE1_BAND_MIN_W, length * m.STAGE1_BAND_W_RATIO), radius * 2);

		ctx.fillStyle = theme.nozzle;
		ctx.beginPath();
		ctx.moveTo(startX, -radius * m.STAGE1_NOZZLE_BASE_RATIO);
		ctx.lineTo(nozzleX, -radius * m.STAGE1_NOZZLE_BELL_RATIO);
		ctx.lineTo(nozzleX, radius * m.STAGE1_NOZZLE_BELL_RATIO);
		ctx.lineTo(startX, radius * m.STAGE1_NOZZLE_BASE_RATIO);
		ctx.closePath();
		ctx.fill();

		ctx.fillStyle = theme.fins;
		const finBaseLen = length * m.FIN_BASE_RATIO;
		const finSpan = radius * m.FIN_SPAN_RATIO;

		ctx.beginPath();
		ctx.moveTo(startX + finBaseLen, -radius);
		ctx.lineTo(startX, -radius - finSpan);
		ctx.lineTo(startX + finBaseLen * m.FIN_ROOT_RATIO, -radius);
		ctx.closePath();
		ctx.fill();

		ctx.beginPath();
		ctx.moveTo(startX + finBaseLen, radius);
		ctx.lineTo(startX, radius + finSpan);
		ctx.lineTo(startX + finBaseLen * m.FIN_ROOT_RATIO, radius);
		ctx.closePath();
		ctx.fill();
	}

	static _drawPayloadSatellite(ctx, cx, cy, R, isDeployed = false) {
		ctx.save();
		ctx.translate(cx, cy);

		const m = ROCKET_VISUAL.MODULES;
		const busW = R * m.SATELLITE_BUS_W_RATIO;
		const busH = R * m.SATELLITE_BUS_H_RATIO;

		// 1. Satellite Bus (Center Gold Foil / MLI Body matching stage width)
		ctx.fillStyle = m.SATELLITE_BUS_FILL;
		ctx.strokeStyle = m.SATELLITE_BUS_STROKE;
		ctx.lineWidth = 1;
		ctx.fillRect(-busW * 0.5, -busH * 0.5, busW, busH);
		ctx.strokeRect(-busW * 0.5, -busH * 0.5, busW, busH);

		// MLI panel division lines across body
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
		ctx.beginPath();
		ctx.moveTo(0, -busH * 0.5);
		ctx.lineTo(0, busH * 0.5);
		ctx.moveTo(-busW * 0.5, 0);
		ctx.lineTo(busW * 0.5, 0);
		ctx.stroke();

		if (!isDeployed) {
			// Folded Solar Arrays (accordion stowed along top and bottom edges)
			const foldedH = busH * (m.SATELLITE_PANEL_FOLDED_H_RATIO || 0.12);
			ctx.fillStyle = m.SATELLITE_PANEL_FILL;
			ctx.strokeStyle = m.SATELLITE_PANEL_STROKE;
			ctx.lineWidth = 1;

			// Top folded array
			ctx.fillRect(-busW * 0.45, -busH * 0.5, busW * 0.9, foldedH);
			ctx.strokeRect(-busW * 0.45, -busH * 0.5, busW * 0.9, foldedH);

			// Bottom folded array
			ctx.fillRect(-busW * 0.45, busH * 0.5 - foldedH, busW * 0.9, foldedH);
			ctx.strokeRect(-busW * 0.45, busH * 0.5 - foldedH, busW * 0.9, foldedH);

			// Stowed antenna dish
			const dishR = busH * m.SATELLITE_DISH_R_RATIO;
			ctx.beginPath();
			ctx.arc(busW * 0.5, 0, dishR * 0.4, -Math.PI * 0.5, Math.PI * 0.5);
			ctx.strokeStyle = m.SATELLITE_DISH_COLOR;
			ctx.lineWidth = 1.0;
			ctx.stroke();
		} else {
			// Deployed High-Gain Parabolic Dish Antenna (+x face)
			const dishR = busH * m.SATELLITE_DISH_R_RATIO;
			const dishX = busW * m.SATELLITE_DISH_OFFSET_RATIO;
			ctx.strokeStyle = m.SATELLITE_DISH_COLOR;
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.arc(dishX, 0, dishR, -Math.PI * 0.5, Math.PI * 0.5);
			ctx.stroke();

			// Antenna feed horn / boom
			ctx.beginPath();
			ctx.moveTo(busW * 0.5, 0);
			ctx.lineTo(dishX + dishR * 0.3, 0);
			ctx.stroke();

			// Expanded Solar Panels (deployed on booms in ±y)
			const panelW = busW * m.SATELLITE_PANEL_W_RATIO;
			const panelH = busH * m.SATELLITE_PANEL_H_RATIO;
			const margin = m.SATELLITE_PANEL_MARGIN;
			const boomW = busW * (m.SATELLITE_PANEL_BOOM_W_RATIO || 0.15);

			// Boom arms
			ctx.fillStyle = '#7a828a';
			ctx.fillRect(-boomW * 0.5, -busH * 0.5 - margin, boomW, margin);
			ctx.fillRect(-boomW * 0.5, busH * 0.5, boomW, margin);

			ctx.fillStyle = m.SATELLITE_PANEL_FILL;
			ctx.strokeStyle = m.SATELLITE_PANEL_STROKE;
			ctx.lineWidth = 1;

			// Top panel
			ctx.fillRect(-panelW * 0.5, -busH * 0.5 - panelH - margin, panelW, panelH);
			ctx.strokeRect(-panelW * 0.5, -busH * 0.5 - panelH - margin, panelW, panelH);

			// Bottom panel
			ctx.fillRect(-panelW * 0.5, busH * 0.5 + margin, panelW, panelH);
			ctx.strokeRect(-panelW * 0.5, busH * 0.5 + margin, panelW, panelH);

			// Solar cell gridlines
			ctx.strokeStyle = 'rgba(0, 200, 255, 0.6)';
			ctx.beginPath();
			ctx.moveTo(-panelW * 0.5, -busH * 0.5 - panelH * 0.5 - margin);
			ctx.lineTo(panelW * 0.5, -busH * 0.5 - panelH * 0.5 - margin);
			ctx.moveTo(-panelW * 0.5, busH * 0.5 + panelH * 0.5 + margin);
			ctx.lineTo(panelW * 0.5, busH * 0.5 + panelH * 0.5 + margin);
			ctx.moveTo(0, -busH * 0.5 - panelH - margin);
			ctx.lineTo(0, -busH * 0.5 - margin);
			ctx.moveTo(0, busH * 0.5 + margin);
			ctx.lineTo(0, busH * 0.5 + panelH + margin);
			ctx.stroke();
		}

		ctx.restore();
	}

	static _drawPlume(ctx, x, y, scale, throttle, fuelType, R, ambientPresRatio = 1.0) {
		ctx.save();
		ctx.translate(x, y);

		const timeSec = performance.now() * 0.001;
		const cfg = ROCKET_VISUAL.PLUMES[fuelType] || ROCKET_VISUAL.PLUMES.liquid;
		const p = Math.max(0, Math.min(1.0, ambientPresRatio !== undefined ? ambientPresRatio : 1.0));
		const e_vac = 1.0 - p; // 0.0 at sea level (collimated jet), 1.0 in vacuum (maximum expansion)

		switch (fuelType) {
			case 'hydro': {
				const flicker = Math.sin(timeSec * cfg.flickerFreq) * cfg.noiseAmp;
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker) * (1.0 + e_vac * PLUME_VACUUM_STRETCH.hydro);
				const w = R * cfg.widthMult * scale * Math.sqrt(throttle) * (1.0 + flicker * 0.5) * (1.0 + e_vac * 1.5);
				const curveW = w * cfg.curveWidthRatio * (1.0 + e_vac * 0.45);
				const curveLen = len * cfg.curveLenRatio * (1.0 - e_vac * 0.2);

				const grad = ctx.createLinearGradient(0, 0, -len, 0);
				for (const [stop, color] of cfg.colors) {
					grad.addColorStop(stop, color);
				}

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.quadraticCurveTo(-curveLen, -curveW, -len, 0);
				ctx.quadraticCurveTo(-curveLen, curveW, 0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				// Mach / shock diamonds appear in overexpanded/collimated atmospheric flow,
				// and fade out as ambient backpressure drops to vacuum (e_vac >= 0.65).
				const diamondAlpha = Math.max(0, (0.65 - e_vac) / 0.65);
				if (diamondAlpha > 0.01 && cfg.diamonds) {
					ctx.save();
					ctx.strokeStyle = cfg.diamondStrokeColor;
					ctx.globalAlpha *= diamondAlpha;
					ctx.lineWidth = 1.2;
					for (let i = 1; i <= cfg.diamonds; i++) {
						const dx = -len * (cfg.diamondInterval * i);
						const dw = (w * cfg.diamondWidthRatio) / (i * (1.0 + e_vac * 0.5));
						const dLen = cfg.diamondLength;
						ctx.beginPath();
						ctx.moveTo(dx - dLen, 0);
						ctx.lineTo(dx, -dw);
						ctx.lineTo(dx + dLen, 0);
						ctx.lineTo(dx, dw);
						ctx.closePath();
						ctx.stroke();
					}
					ctx.restore();
				}
				break;
			}

			case 'solid': {
				const flicker = (Math.random() - 0.5) * cfg.noiseAmp;
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker) * (1.0 + e_vac * PLUME_VACUUM_STRETCH.solid);
				const w = R * cfg.widthMult * scale * Math.sqrt(throttle) * (1.0 + e_vac * 1.3);
				const curveW = w * cfg.curveWidthRatio * (1.0 + e_vac * 0.4);
				const curveLen = len * cfg.curveLenRatio * (1.0 - e_vac * 0.15);

				const grad = ctx.createLinearGradient(0, 0, -len, 0);
				for (const [stop, color] of cfg.colors) {
					grad.addColorStop(stop, color);
				}

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.lineTo(-curveLen, -curveW);
				ctx.lineTo(-len, 0);
				ctx.lineTo(-curveLen, curveW);
				ctx.lineTo(0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				const coreW = w * cfg.coreWidthRatio * (1.0 + e_vac * 0.25);
				const coreLen = len * cfg.coreLenRatio * (1.0 - e_vac * 0.2);
				ctx.fillStyle = cfg.coreFill;
				ctx.beginPath();
				ctx.moveTo(0, -coreW);
				ctx.lineTo(-coreLen, 0);
				ctx.lineTo(0, coreW);
				ctx.closePath();
				ctx.fill();
				break;
			}

			case 'ion': {
				const flicker = Math.sin(timeSec * cfg.flickerFreq) * cfg.noiseAmp;
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker);
				const w = R * cfg.widthMult * scale * (1.0 + e_vac * 0.5);

				const grad = ctx.createLinearGradient(0, 0, -len, 0);
				for (const [stop, color] of cfg.colors) {
					grad.addColorStop(stop, color);
				}

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.lineTo(-len, 0);
				ctx.lineTo(0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				ctx.strokeStyle = cfg.beamStrokeColor;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(0, 0);
				ctx.lineTo(-len * cfg.beamLengthRatio, 0);
				ctx.stroke();
				break;
			}

			case 'liquid':
			default: {
				const flicker = Math.sin(timeSec * cfg.flickerFreq) * cfg.noiseAmp;
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker) * (1.0 + e_vac * PLUME_VACUUM_STRETCH.liquid);
				const w = R * cfg.widthMult * scale * Math.sqrt(throttle) * (1.0 + flicker * 0.5) * (1.0 + e_vac * 1.4);
				const curveW = w * cfg.curveWidthRatio * (1.0 + e_vac * 0.5);
				const curveLen = len * cfg.curveLenRatio * (1.0 - e_vac * 0.2);

				const grad = ctx.createLinearGradient(0, 0, -len, 0);
				for (const [stop, color] of cfg.colors) {
					grad.addColorStop(stop, color);
				}

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.quadraticCurveTo(-curveLen, -curveW, -len, 0);
				ctx.quadraticCurveTo(-curveLen, curveW, 0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				const coreW = w * cfg.coreWidthRatio * (1.0 + e_vac * 0.3);
				const coreLen = len * cfg.coreLenRatio * (1.0 - e_vac * 0.25);
				const coreGrad = ctx.createLinearGradient(0, 0, -coreLen, 0);
				coreGrad.addColorStop(0, cfg.coreFillStart);
				coreGrad.addColorStop(1, cfg.coreFillEnd);
				ctx.fillStyle = coreGrad;
				ctx.beginPath();
				ctx.moveTo(0, -coreW);
				ctx.lineTo(-coreLen, 0);
				ctx.lineTo(0, coreW);
				ctx.closePath();
				ctx.fill();
				break;
			}
		}

		ctx.restore();
	}

	static _drawBoosters(ctx, rocket, stg1X, r1, l1, nozzle1X, lNozzle1, theme, isFiring, throttle, R, ambientPresRatio = 1.0) {
		const isBoosterSeparated = Boolean(
			rocket.isBoosterSeparated ||
			rocket.telemetry?.isBoosterSeparated
		);
		if (isBoosterSeparated) {
			return;
		}
		// The placement is shared with the geometry's RCS rule (design 2026-11-23 §3.3); null without any SRB
		const layout = this._computeBoosterLayout(rocket, stg1X, r1, l1, R);
		if (!layout) {
			return;
		}
		const { rB, lB, xBase, lNozzleB, lNoseB, yPositions, casingColor, noseConeColor, bandColor, nozzleColor, plumeFuel, plumeScale } = layout;

		for (const yPos of yPositions) {
			// 1. Booster Cylindrical Body (Casing)
			const bodyGrad = ctx.createLinearGradient(0, yPos - rB, 0, yPos + rB);
			bodyGrad.addColorStop(0, '#ffffff');
			bodyGrad.addColorStop(0.35, casingColor);
			bodyGrad.addColorStop(1, '#8c95a0');
			ctx.fillStyle = bodyGrad;
			ctx.fillRect(xBase, yPos - rB, lB, rB * 2);

			// Center seam line
			ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(xBase, yPos);
			ctx.lineTo(xBase + lB, yPos);
			ctx.stroke();

			// 2. Attachment Bands (Forward & Aft)
			ctx.fillStyle = bandColor;
			ctx.fillRect(xBase + lB * 0.82, yPos - rB, Math.max(1.5, rB * 0.3), rB * 2);
			ctx.fillRect(xBase + lB * 0.15, yPos - rB, Math.max(1.5, rB * 0.3), rB * 2);

			// 3. Nose Cone (Aerodynamic cone angled slightly inward toward core centerline)
			const tipCantY = (yPos > 0 ? -1 : 1) * rB * 0.25;
			const noseTipX = xBase + lB + lNoseB;
			const noseTipY = yPos + tipCantY;

			const noseGrad = ctx.createLinearGradient(xBase + lB, yPos - rB, noseTipX, yPos + rB);
			noseGrad.addColorStop(0, casingColor);
			noseGrad.addColorStop(0.5, noseConeColor);
			noseGrad.addColorStop(1, '#111418');
			ctx.fillStyle = noseGrad;

			ctx.beginPath();
			ctx.moveTo(xBase + lB, yPos - rB);
			ctx.quadraticCurveTo(xBase + lB + lNoseB * 0.6, yPos - rB * 0.2 + tipCantY, noseTipX, noseTipY);
			ctx.quadraticCurveTo(xBase + lB + lNoseB * 0.6, yPos + rB * 0.2 + tipCantY, xBase + lB, yPos + rB);
			ctx.closePath();
			ctx.fill();

			// 4. Conical Nozzle
			const nozzleGrad = ctx.createLinearGradient(xBase - lNozzleB, yPos - rB * 0.85, xBase, yPos + rB * 0.85);
			nozzleGrad.addColorStop(0, nozzleColor);
			nozzleGrad.addColorStop(0.5, '#353b43');
			nozzleGrad.addColorStop(1, '#111418');
			ctx.fillStyle = nozzleGrad;

			ctx.beginPath();
			ctx.moveTo(xBase, yPos - rB * 0.55);
			ctx.lineTo(xBase - lNozzleB, yPos - rB * 0.85);
			ctx.lineTo(xBase - lNozzleB, yPos + rB * 0.85);
			ctx.lineTo(xBase, yPos + rB * 0.55);
			ctx.closePath();
			ctx.fill();

			// 5. Solid Booster Exhaust Plume (when firing, booster ignited, and not burnt out: isBoosterFiring; the read of
			// rocket.isBoosterIgnited was always undefined and fell back to that rule, design §4.13-23)
			if (isFiring && this.isBoosterFiring(rocket) && throttle > ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD) {
				this._drawPlume(ctx, xBase - lNozzleB, yPos, plumeScale, throttle, plumeFuel, R, ambientPresRatio);
			}
		}
	}
}
