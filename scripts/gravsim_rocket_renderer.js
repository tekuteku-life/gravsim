
// gravsim_rocket_renderer.js

import { PAD_EFFECT, ROCKET_VISUAL } from './gravsim_const.js';

export class RocketRenderer {
	static draw(ctx, rocket, x, y, screenRadius, zoomScale) {
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(rocket.thrustAngle);

		if (rocket.isInternalPower) {
			ctx.shadowColor = PAD_EFFECT.STRUCTURE.GLOW_COLOR;
			ctx.shadowBlur = Math.max(8, screenRadius * PAD_EFFECT.STRUCTURE.GLOW_BLUR_MULT);
		}

		const theme = ROCKET_VISUAL.THEMES[rocket.colorTheme] || ROCKET_VISUAL.THEMES.orange;

		if (screenRadius < ROCKET_VISUAL.LOD_RADIUS_THRESHOLD) {
			this._drawLowDetail(ctx, rocket, screenRadius, theme);
		} else {
			this._drawHighDetail(ctx, rocket, screenRadius, zoomScale, theme);
		}

		ctx.restore();
	}

	static _drawLowDetail(ctx, rocket, R, theme) {
		const isPayloadOnly = Boolean(
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
			return;
		}

		const len = hasStage1 ? R * lod.STAGE1_LEN_RATIO : R * lod.STAGE2_LEN_RATIO;
		const width = R * lod.WIDTH_RATIO;

		ctx.fillStyle = hasStage1 ? theme.stg1Grad[1] : theme.stg2Grad[0];
		ctx.beginPath();
		ctx.ellipse(0, 0, len * 0.5, width * 0.5, 0, 0, Math.PI * 2);
		ctx.fill();

		const isFiring = rocket.isIgnited && (rocket.burnTime > 0) && (rocket.thrustRatio > ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD || (rocket.telemetry?.twr > ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD));
		if (isFiring) {
			const plumeLen = R * lod.PLUME_LEN_RATIO * (rocket.thrustRatio || 1.0);
			ctx.fillStyle = lod.PLUME_COLOR;
			ctx.beginPath();
			ctx.moveTo(-len * 0.5, -width * lod.PLUME_WIDTH_RATIO);
			ctx.lineTo(-len * 0.5 - plumeLen, 0);
			ctx.lineTo(-len * 0.5, width * lod.PLUME_WIDTH_RATIO);
			ctx.closePath();
			ctx.fill();
		}
	}

	static _drawHighDetail(ctx, rocket, R, zoomScale, theme) {
		const curStgIdx = rocket.telemetry?.stageIndex !== undefined ? rocket.telemetry.stageIndex : (rocket.currentStageIndex || 0);
		const totalStg = rocket.telemetry?.totalStages || rocket.stages?.length || 1;

		const isPayloadOnly = Boolean(
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
		const lInter = R * m.INTERSTAGE_LENGTH_RATIO;
		const lFairing = R * m.FAIRING_LENGTH_RATIO;
		const lNozzle1 = R * m.NOZZLE1_LENGTH_RATIO;
		const lNozzle2 = R * m.NOZZLE2_LENGTH_RATIO;

		if (isPayloadOnly) {
			this._drawPayloadSatellite(ctx, 0, 0, r2);
			return;
		}

		const hasStage1 = (curStgIdx === 0);
		const hasFairing = Boolean(
			rocket.fairing?.enabled &&
			!rocket.telemetry?.isFairingSeparated &&
			!rocket.fairing?.isSeparated
		);

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
			this._drawPayloadSatellite(ctx, fairingX + lFairing * align.PAYLOAD_OFFSET_RATIO, 0, r2);
		}

		this._drawStage2(ctx, stg2X, r2, l2, !hasStage1, nozzle2X, lNozzle2, theme);

		if (hasStage1) {
			if (totalStg > 1) {
				this._drawInterstage(ctx, interX, r1, lInter, theme);
			}
			this._drawStage1(ctx, stg1X, r1, l1, nozzle1X, lNozzle1, theme);
		}

		const isFiring = rocket.isIgnited && (rocket.burnTime > 0) && (rocket.thrustRatio > ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD || (rocket.telemetry?.twr > ROCKET_VISUAL.PLUMES.THRUST_THRESHOLD));
		if (isFiring) {
			const curFuel = (rocket.stages && rocket.stages[curStgIdx]?.fuelType) || rocket.fuelType || 'liquid';
			const throttle = rocket.thrustRatio || 1.0;

			if (hasStage1) {
				this._drawPlume(ctx, nozzle1X, 0, align.MAIN_PLUME_SCALE, throttle, curFuel, R);
			} else {
				this._drawPlume(ctx, nozzle2X, 0, align.UPPER_PLUME_SCALE, throttle, curFuel, R);
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

	static _drawPayloadSatellite(ctx, cx, cy, R) {
		ctx.save();
		ctx.translate(cx, cy);

		const m = ROCKET_VISUAL.MODULES;
		const busW = R * m.SATELLITE_BUS_W_RATIO;
		const busH = R * m.SATELLITE_BUS_H_RATIO;

		ctx.fillStyle = m.SATELLITE_BUS_FILL;
		ctx.strokeStyle = m.SATELLITE_BUS_STROKE;
		ctx.lineWidth = 1;
		ctx.fillRect(-busW * 0.5, -busH * 0.5, busW, busH);
		ctx.strokeRect(-busW * 0.5, -busH * 0.5, busW, busH);

		const dishR = busH * m.SATELLITE_DISH_R_RATIO;
		ctx.beginPath();
		ctx.arc(busW * m.SATELLITE_DISH_OFFSET_RATIO, 0, dishR, -Math.PI * 0.5, Math.PI * 0.5);
		ctx.strokeStyle = m.SATELLITE_DISH_COLOR;
		ctx.lineWidth = 1.0;
		ctx.stroke();

		const panelW = busW * m.SATELLITE_PANEL_W_RATIO;
		const panelH = busH * m.SATELLITE_PANEL_H_RATIO;
		ctx.fillStyle = m.SATELLITE_PANEL_FILL;
		ctx.strokeStyle = m.SATELLITE_PANEL_STROKE;
		ctx.lineWidth = 1;

		ctx.fillRect(-panelW * 0.5, -busH * 0.5 - panelH - m.SATELLITE_PANEL_MARGIN, panelW, panelH);
		ctx.strokeRect(-panelW * 0.5, -busH * 0.5 - panelH - m.SATELLITE_PANEL_MARGIN, panelW, panelH);

		ctx.fillRect(-panelW * 0.5, busH * 0.5 + m.SATELLITE_PANEL_MARGIN, panelW, panelH);
		ctx.strokeRect(-panelW * 0.5, busH * 0.5 + m.SATELLITE_PANEL_MARGIN, panelW, panelH);

		ctx.restore();
	}

	static _drawPlume(ctx, x, y, scale, throttle, fuelType, R) {
		ctx.save();
		ctx.translate(x, y);

		const timeSec = performance.now() * 0.001;
		const cfg = ROCKET_VISUAL.PLUMES[fuelType] || ROCKET_VISUAL.PLUMES.liquid;

		switch (fuelType) {
			case 'hydro': {
				const flicker = Math.sin(timeSec * cfg.flickerFreq) * cfg.noiseAmp;
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker);
				const w = R * cfg.widthMult * scale * Math.sqrt(throttle) * (1.0 + flicker * 0.5);

				const grad = ctx.createLinearGradient(0, 0, -len, 0);
				for (const [stop, color] of cfg.colors) {
					grad.addColorStop(stop, color);
				}

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.quadraticCurveTo(-len * cfg.curveLenRatio, -w * cfg.curveWidthRatio, -len, 0);
				ctx.quadraticCurveTo(-len * cfg.curveLenRatio, w * cfg.curveWidthRatio, 0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				ctx.strokeStyle = cfg.diamondStrokeColor;
				ctx.lineWidth = 1.2;
				for (let i = 1; i <= cfg.diamonds; i++) {
					const dx = -len * (cfg.diamondInterval * i);
					const dw = (w * cfg.diamondWidthRatio) / i;
					const dLen = cfg.diamondLength;
					ctx.beginPath();
					ctx.moveTo(dx - dLen, 0);
					ctx.lineTo(dx, -dw);
					ctx.lineTo(dx + dLen, 0);
					ctx.lineTo(dx, dw);
					ctx.closePath();
					ctx.stroke();
				}
				break;
			}

			case 'solid': {
				const flicker = (Math.random() - 0.5) * cfg.noiseAmp;
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker);
				const w = R * cfg.widthMult * scale * Math.sqrt(throttle);

				const grad = ctx.createLinearGradient(0, 0, -len, 0);
				for (const [stop, color] of cfg.colors) {
					grad.addColorStop(stop, color);
				}

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.lineTo(-len * cfg.curveLenRatio, -w * cfg.curveWidthRatio);
				ctx.lineTo(-len, 0);
				ctx.lineTo(-len * cfg.curveLenRatio, w * cfg.curveWidthRatio);
				ctx.lineTo(0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				ctx.fillStyle = cfg.coreFill;
				ctx.beginPath();
				ctx.moveTo(0, -w * cfg.coreWidthRatio);
				ctx.lineTo(-len * cfg.coreLenRatio, 0);
				ctx.lineTo(0, w * cfg.coreWidthRatio);
				ctx.closePath();
				ctx.fill();
				break;
			}

			case 'ion': {
				const flicker = Math.sin(timeSec * cfg.flickerFreq) * cfg.noiseAmp;
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker);
				const w = R * cfg.widthMult * scale;

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
				const len = R * cfg.lenMult * scale * throttle * (1.0 + flicker);
				const w = R * cfg.widthMult * scale * Math.sqrt(throttle) * (1.0 + flicker * 0.5);

				const grad = ctx.createLinearGradient(0, 0, -len, 0);
				for (const [stop, color] of cfg.colors) {
					grad.addColorStop(stop, color);
				}

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.quadraticCurveTo(-len * cfg.curveLenRatio, -w * cfg.curveWidthRatio, -len, 0);
				ctx.quadraticCurveTo(-len * cfg.curveLenRatio, w * cfg.curveWidthRatio, 0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				const coreGrad = ctx.createLinearGradient(0, 0, -len * cfg.coreLenRatio, 0);
				coreGrad.addColorStop(0, cfg.coreFillStart);
				coreGrad.addColorStop(1, cfg.coreFillEnd);
				ctx.fillStyle = coreGrad;
				ctx.beginPath();
				ctx.moveTo(0, -w * cfg.coreWidthRatio);
				ctx.lineTo(-len * cfg.coreLenRatio, 0);
				ctx.lineTo(0, w * cfg.coreWidthRatio);
				ctx.closePath();
				ctx.fill();
				break;
			}
		}

		ctx.restore();
	}
}
