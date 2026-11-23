
// gravsim_rocket_renderer.js

import { PAD_EFFECT } from './gravsim_const.js';
import { AeroUtils } from './gravsim_utils.js';
import { ROCKET_VISUAL } from './gravsim_preset_manager.js';

export class RocketRenderer {
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
			this._drawHighDetail(ctx, rocket, screenRadius, zoomScale, theme, ambientPresRatio);
			const layout = this._computeVisualLayout(rocket, screenRadius, ROCKET_VISUAL);
			this.drawVaporCone(ctx, rocket, layout, ROCKET_VISUAL);
			this.drawColdGasRcs(ctx, rocket, layout, ROCKET_VISUAL);
		}

		ctx.restore();
	}

	static _computeVisualLayout(rocket, R, visualCfg = ROCKET_VISUAL) {
		const curStgIdx = rocket.telemetry?.stageIndex !== undefined ? rocket.telemetry.stageIndex : (rocket.currentStageIndex || 0);
		const totalStg = rocket.telemetry?.totalStages || rocket.stages?.length || 1;
		const isPayloadOnly = !rocket.disableStaging && Boolean(
			rocket.isPayloadSeparated ||
			rocket.telemetry?.isPayloadSeparated ||
			(rocket.stages && curStgIdx >= totalStg)
		);

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

		if (isPayloadOnly) {
			const payloadR = (totalStg === 1) ? r1 : ((totalStg >= 3) ? r3 : r2);
			const halfBusW = 0.5 * payloadR * m.SATELLITE_BUS_W_RATIO;
			const halfBusH = 0.5 * payloadR * m.SATELLITE_BUS_H_RATIO;
			return {
				xMin: -halfBusW,
				xMax: halfBusW,
				halfWidth: halfBusH,
				screenRadius: R
			};
		}

		const hasFairing = Boolean(
			rocket.disableStaging ||
			(rocket.fairing?.enabled &&
			!rocket.telemetry?.isFairingSeparated &&
			!rocket.fairing?.isSeparated)
		);
		const getNoseEnd = (fairingX, bodyR) => {
			if (hasFairing) return fairingX + lFairing;
			return fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO + bodyR * m.SATELLITE_BUS_W_RATIO * 0.5;
		};

		if (totalStg === 1) {
			const stg1X = R * (align.BASE_X_SINGLE_STAGE_RATIO ?? -1.5);
			const xMax = getNoseEnd(stg1X + l1, r1);
			return { xMin: stg1X, xMax, halfWidth: r1, screenRadius: R };
		}

		if (totalStg >= 3) {
			if (curStgIdx === 0) {
				const stg1X = R * (align.BASE_X_3STG_STAGE1_RATIO ?? -3.1);
				const xMax = getNoseEnd(stg1X + l1 + lInter + l2 + lInter2 + l3, r3);
				return { xMin: stg1X, xMax, halfWidth: r1, screenRadius: R };
			}
			if (curStgIdx === 1) {
				const stg2X = R * (align.BASE_X_3STG_STAGE2_RATIO ?? -1.6);
				const xMax = getNoseEnd(stg2X + l2 + lInter2 + l3, r3);
				return { xMin: stg2X, xMax, halfWidth: r2, screenRadius: R };
			}
			const stg3X = R * (align.BASE_X_3STG_STAGE3_RATIO ?? -0.9);
			const xMax = getNoseEnd(stg3X + l3, r3);
			return { xMin: stg3X, xMax, halfWidth: hasFairing ? r2 : r3, screenRadius: R };
		}

		const hasStage1 = (curStgIdx === 0);
		const stg2X = hasStage1 ? R * align.BASE_X_STAGE1_RATIO : R * align.BASE_X_UPPER_RATIO;
		const xMin = hasStage1 ? (stg2X - lInter - l1) : stg2X;
		const xMax = getNoseEnd(stg2X + l2, r2);
		return {
			xMin,
			xMax,
			halfWidth: hasStage1 ? r1 : r2,
			screenRadius: R
		};
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

		const cfg = visualCfg.COLD_GAS_RCS;
		const L = Math.max(1, layout.xMax - layout.xMin);
		const xFwd = layout.xMin + L * cfg.FWD_STATION_FRACTION;
		const xAft = layout.xMin + L * cfg.AFT_STATION_FRACTION;
		const yWall = layout.halfWidth;
		const plumeLen = Math.max(cfg.MIN_PLUME_PX, layout.halfWidth * cfg.PLUME_LEN_WIDTH_RATIO);

		if (rcsCw) {
			this._drawRcsPlume(ctx, xFwd, -yWall, 0, -1, plumeLen, cfg);
			this._drawRcsPlume(ctx, xAft, yWall, 0, 1, plumeLen, cfg);
		}
		if (rcsCcw) {
			this._drawRcsPlume(ctx, xFwd, yWall, 0, 1, plumeLen, cfg);
			this._drawRcsPlume(ctx, xAft, -yWall, 0, -1, plumeLen, cfg);
		}
		if (rcsUllage) {
			const cant = cfg.ULLAGE_CANT_RAD ?? 0.28;
			const cosC = Math.cos(cant);
			const sinC = Math.sin(cant);
			this._drawRcsPlume(ctx, xAft, yWall, -cosC, sinC, plumeLen, cfg);
			this._drawRcsPlume(ctx, xAft, -yWall, -cosC, -sinC, plumeLen, cfg);
		}
	}

	static drawVaporCone(ctx, rocket, layout, visualCfg = ROCKET_VISUAL) {
		if (!rocket || !layout || !visualCfg?.VAPOR_CONE) return;
		if (Number.isFinite(layout.screenRadius) && layout.screenRadius < (visualCfg.LOD_RADIUS_THRESHOLD ?? 10)) return;
		const mach = Number.isFinite(rocket.mach) ? rocket.mach : (rocket.telemetry?.mach ?? 0);
		const ambientPresRatio = this._resolveAmbientPresRatio(rocket);
		const vapor = AeroUtils.computeVaporConeParams(mach, ambientPresRatio);
		if (!vapor.active || vapor.intensity <= 0.01) return;

		const cfg = visualCfg.VAPOR_CONE;
		const L = Math.max(1, layout.xMax - layout.xMin);
		const drawConeAt = (xVertex, scale) => {
			const coneLen = layout.halfWidth * cfg.CONE_LENGTH_RATIO * (0.75 + 0.5 * vapor.intensity) * scale;
			const coneHalfW = Math.min(
				layout.halfWidth * cfg.MAX_WIDTH_MULTIPLIER,
				layout.halfWidth * (1.1 + 1.35 * vapor.intensity * Math.sin(vapor.machAngleRad))
			) * scale;
			const xBack = xVertex - coneLen;
			const noseRimX = xVertex - layout.halfWidth * 0.25 * scale;
			const grad = ctx.createRadialGradient(
				xVertex, 0, layout.halfWidth * 0.15 * scale,
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
			ctx.lineWidth = Math.max(1, layout.halfWidth * 0.12);
			ctx.beginPath();
			ctx.moveTo(xBack, -coneHalfW);
			ctx.quadraticCurveTo(noseRimX, 0, xBack, coneHalfW);
			ctx.stroke();
			ctx.restore();
		};

		const xPrimary = layout.xMin + L * cfg.PRIMARY_STATION_FRACTION;
		drawConeAt(xPrimary, 1.0);
		if (vapor.intensity >= cfg.SECONDARY_INTENSITY_MIN) {
			const xSecondary = layout.xMin + L * cfg.SECONDARY_STATION_FRACTION;
			drawConeAt(xSecondary, 0.78);
		}
	}

	static _drawLowDetail(ctx, rocket, R, theme, ambientPresRatio = 1.0) {
		const isPayloadOnly = !rocket.disableStaging && Boolean(
			rocket.isPayloadSeparated ||
			rocket.telemetry?.isPayloadSeparated ||
			(rocket.stages && rocket.currentStageIndex >= rocket.totalStages)
		);
		const curStgIdx = rocket.telemetry?.stageIndex !== undefined ? rocket.telemetry.stageIndex : (rocket.currentStageIndex || 0);
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
		const boosterCount = (hasStage1 && !isBoosterSeparated) ? (rocket.boosters?.count || rocket.rendering?.boosters?.count || 0) : 0;
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

	static _drawHighDetail(ctx, rocket, R, zoomScale, theme, ambientPresRatio = 1.0) {
		const curStgIdx = rocket.telemetry?.stageIndex !== undefined ? rocket.telemetry.stageIndex : (rocket.currentStageIndex || 0);
		const totalStg = rocket.telemetry?.totalStages || rocket.stages?.length || 1;

		const isPayloadOnly = !rocket.disableStaging && Boolean(
			rocket.isPayloadSeparated ||
			rocket.telemetry?.isPayloadSeparated ||
			(rocket.stages && curStgIdx >= totalStg)
		);

		const m = ROCKET_VISUAL.MODULES;
		const align = ROCKET_VISUAL.ALIGNMENT;
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

		if (isPayloadOnly) {
			const payloadR = (totalStg === 1) ? r1 : ((totalStg >= 3) ? r3 : r2);
			this._drawPayloadSatellite(ctx, 0, 0, payloadR, true);
			// The payload's own burn, behind the bus (its aft face, -x), with the plume of its propulsion's fuel type
			if (this.isPayloadEngineFiring(rocket)) {
				const busW = payloadR * m.SATELLITE_BUS_W_RATIO;
				this._drawPlume(ctx, -busW * 0.5, 0, align.PAYLOAD_PLUME_SCALE ?? 0.35, rocket.thrustRatio || 1.0, this.payloadFuelType(rocket), R, ambientPresRatio);
			}
			return;
		}

		const hasFairing = Boolean(
			rocket.disableStaging ||
			(rocket.fairing?.enabled &&
			!rocket.telemetry?.isFairingSeparated &&
			!rocket.fairing?.isSeparated)
		);

		const isFiring = this.isEngineFiring(rocket);
		const curFuel = (rocket.stages && rocket.stages[curStgIdx]?.fuelType) || rocket.fuelType || 'liquid';
		const throttle = rocket.thrustRatio || 1.0;

		// 1. Single-stage configuration (SSTO): Only Stage 1 + Fairing / Payload
		if (totalStg === 1) {
			const stg1X = R * (align.BASE_X_SINGLE_STAGE_RATIO ?? -1.5);
			const nozzle1X = stg1X - lNozzle1;
			const fairingX = stg1X + l1;

			if (hasFairing) {
				this._drawFairing(ctx, fairingX, r1, lFairing, theme);
			} else {
				this._drawPayloadSatellite(ctx, fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO, 0, r1, false);
			}

			this._drawStage1(ctx, stg1X, r1, l1, nozzle1X, lNozzle1, theme);
			this._drawBoosters(ctx, rocket, stg1X, r1, l1, nozzle1X, lNozzle1, theme, isFiring, throttle, R, ambientPresRatio);

			if (isFiring) {
				this._drawPlume(ctx, nozzle1X, 0, align.MAIN_PLUME_SCALE, throttle, curFuel, R, ambientPresRatio);
			}
			return;
		}

		// 2. Three-stage configuration (e.g., Epsilon solid-propellant rocket)
		if (totalStg >= 3) {
			if (curStgIdx === 0) {
				// All 3 stages attached
				const stg1X = R * (align.BASE_X_3STG_STAGE1_RATIO ?? -3.1);
				const nozzle1X = stg1X - lNozzle1;
				const inter1X = stg1X + l1;
				const stg2X = inter1X + lInter;
				const inter2X = stg2X + l2;
				const stg3X = inter2X + lInter2;
				const fairingX = stg3X + l3;

				if (hasFairing) {
					this._drawFairing(ctx, fairingX, r2, lFairing, theme);
				} else {
					this._drawPayloadSatellite(ctx, fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO, 0, r3, false);
				}

				this._drawStage2(ctx, stg3X, r3, l3, false, 0, 0, theme);
				this._drawInterstage(ctx, inter2X, r2, lInter2, theme);
				this._drawStage2(ctx, stg2X, r2, l2, false, 0, 0, theme);
				this._drawInterstage(ctx, inter1X, r1, lInter, theme);
				this._drawStage1(ctx, stg1X, r1, l1, nozzle1X, lNozzle1, theme);
				this._drawBoosters(ctx, rocket, stg1X, r1, l1, nozzle1X, lNozzle1, theme, isFiring, throttle, R, ambientPresRatio);

				if (isFiring) {
					this._drawPlume(ctx, nozzle1X, 0, align.MAIN_PLUME_SCALE, throttle, curFuel, R, ambientPresRatio);
				}
			} else if (curStgIdx === 1) {
				// Stage 1 jettisoned, Stage 2 active
				const stg2X = R * (align.BASE_X_3STG_STAGE2_RATIO ?? -1.6);
				const nozzle2X = stg2X - lNozzle2;
				const inter2X = stg2X + l2;
				const stg3X = inter2X + lInter2;
				const fairingX = stg3X + l3;

				if (hasFairing) {
					this._drawFairing(ctx, fairingX, r2, lFairing, theme);
				} else {
					this._drawPayloadSatellite(ctx, fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO, 0, r3, false);
				}

				this._drawStage2(ctx, stg3X, r3, l3, false, 0, 0, theme);
				this._drawInterstage(ctx, inter2X, r2, lInter2, theme);
				this._drawStage2(ctx, stg2X, r2, l2, true, nozzle2X, lNozzle2, theme);

				if (isFiring) {
					this._drawPlume(ctx, nozzle2X, 0, align.UPPER_PLUME_SCALE, throttle, curFuel, R, ambientPresRatio);
				}
			} else {
				// Stage 2 jettisoned, Stage 3 active
				const stg3X = R * (align.BASE_X_3STG_STAGE3_RATIO ?? -0.9);
				const nozzle3X = stg3X - lNozzle3;
				const fairingX = stg3X + l3;

				if (hasFairing) {
					this._drawFairing(ctx, fairingX, r2, lFairing, theme);
				} else {
					this._drawPayloadSatellite(ctx, fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO, 0, r3, false);
				}

				this._drawStage2(ctx, stg3X, r3, l3, true, nozzle3X, lNozzle3, theme);

				if (isFiring) {
					this._drawPlume(ctx, nozzle3X, 0, align.STAGE3_PLUME_SCALE ?? 0.5, throttle, curFuel, R, ambientPresRatio);
				}
			}
			return;
		}

		// 3. Standard two-stage configuration (Falcon 9, H3)
		const hasStage1 = (curStgIdx === 0);
		const baseX = hasStage1 ? R * align.BASE_X_STAGE1_RATIO : R * align.BASE_X_UPPER_RATIO;
		const stg2X = baseX;
		const fairingX = stg2X + l2;
		const interX = stg2X - lInter;
		const stg1X = interX - l1;
		const nozzle1X = stg1X - lNozzle1;
		const nozzle2X = stg2X - lNozzle2;

		if (hasFairing) {
			this._drawFairing(ctx, fairingX, r2, lFairing, theme);
		} else {
			this._drawPayloadSatellite(ctx, fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO, 0, r2, false);
		}

		this._drawStage2(ctx, stg2X, r2, l2, !hasStage1, nozzle2X, lNozzle2, theme);

		if (hasStage1) {
			this._drawInterstage(ctx, interX, r1, lInter, theme);
			this._drawStage1(ctx, stg1X, r1, l1, nozzle1X, lNozzle1, theme);
			this._drawBoosters(ctx, rocket, stg1X, r1, l1, nozzle1X, lNozzle1, theme, isFiring, throttle, R, ambientPresRatio);
		}

		if (isFiring) {
			if (hasStage1) {
				this._drawPlume(ctx, nozzle1X, 0, align.MAIN_PLUME_SCALE, throttle, curFuel, R, ambientPresRatio);
			} else {
				this._drawPlume(ctx, nozzle2X, 0, align.UPPER_PLUME_SCALE, throttle, curFuel, R, ambientPresRatio);
			}
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
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker) * (1.0 + e_vac * 0.15);
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
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker) * (1.0 + e_vac * 0.12);
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
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker) * (1.0 + e_vac * 0.15);
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

		const boosters = rocket.boosters ||
			rocket.rendering?.boosters ||
			(rocket.stages && rocket.stages[0]?.boosters);
		if (!boosters || !boosters.count || boosters.count <= 0) {
			return;
		}

		const count = boosters.count;
		const rB = R * (boosters.radiusRatio || 0.26);
		const lB = R * (boosters.lengthRatio || 1.70);
		const yOffset = r1 + rB * (boosters.offsetYRatio || 0.95);
		const xAttachOffset = l1 * (boosters.attachOffsetXRatio || 0.12);
		const xBase = stg1X + xAttachOffset;
		const lNozzleB = R * (boosters.nozzleLengthRatio || 0.20);
		const lNoseB = R * (boosters.noseConeLengthRatio || 0.35);
		const casingColor = boosters.casingColor || '#f0f2f5';
		const noseConeColor = boosters.noseConeColor || '#22262c';
		const bandColor = boosters.bandColor || '#c85a1a';
		const nozzleColor = boosters.nozzleColor || '#1c2024';
		const plumeFuel = boosters.plumeFuel || 'solid';
		const plumeScale = boosters.plumeScale || 0.55;

		// Determine lateral Y positions for boosters
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
