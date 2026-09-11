
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

		if (isPayloadOnly) {
			// Draw high-visibility mini satellite icon even in low detail
			const iconW = R * 1.5;
			const iconH = R * 1.0;
			ctx.fillStyle = '#d4af37';
			ctx.fillRect(-iconW * 0.5, -iconH * 0.5, iconW, iconH);

			// Blue solar paddles
			ctx.fillStyle = '#0066cc';
			ctx.fillRect(-iconW * 0.4, -iconH * 0.5 - R * 0.6, iconW * 0.8, R * 0.5);
			ctx.fillRect(-iconW * 0.4, iconH * 0.5 + R * 0.1, iconW * 0.8, R * 0.5);
			return;
		}

		const len = hasStage1 ? R * 4.2 : R * 2.2;
		const width = R * 0.9;

		ctx.fillStyle = hasStage1 ? theme.stg1Grad[1] : theme.stg2Grad[0];
		ctx.beginPath();
		ctx.ellipse(0, 0, len * 0.5, width * 0.5, 0, 0, Math.PI * 2);
		ctx.fill();

		const isFiring = rocket.isIgnited && (rocket.burnTime > 0) && (rocket.thrustRatio > 0.01 || (rocket.telemetry?.twr > 0.01));
		if (isFiring) {
			const plumeLen = R * 2.8 * (rocket.thrustRatio || 1.0);
			ctx.fillStyle = '#ffaa00';
			ctx.beginPath();
			ctx.moveTo(-len * 0.5, -width * 0.35);
			ctx.lineTo(-len * 0.5 - plumeLen, 0);
			ctx.lineTo(-len * 0.5, width * 0.35);
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

		const baseX = hasStage1 ? R * 0.4 : -R * 0.6;
		const stg2X = baseX;
		const fairingX = stg2X + l2;
		const interX = stg2X - lInter;
		const stg1X = interX - l1;
		const nozzle1X = stg1X - lNozzle1;
		const nozzle2X = stg2X - lNozzle2;

		if (hasFairing) {
			this._drawFairing(ctx, fairingX, r2, lFairing, theme);
		} else {
			this._drawPayloadSatellite(ctx, fairingX + lFairing * 0.35, 0, r2);
		}

		this._drawStage2(ctx, stg2X, r2, l2, !hasStage1, nozzle2X, lNozzle2, theme);

		if (hasStage1) {
			if (totalStg > 1) {
				this._drawInterstage(ctx, interX, r1, lInter, theme);
			}
			this._drawStage1(ctx, stg1X, r1, l1, nozzle1X, lNozzle1, theme);
		}

		const isFiring = rocket.isIgnited && (rocket.burnTime > 0) && (rocket.thrustRatio > 0.01 || (rocket.telemetry?.twr > 0.01));
		if (isFiring) {
			const curFuel = (rocket.stages && rocket.stages[curStgIdx]?.fuelType) || rocket.fuelType || 'liquid';
			const throttle = rocket.thrustRatio || 1.0;

			if (hasStage1) {
				this._drawPlume(ctx, nozzle1X, 0, 1.0, throttle, curFuel, R);
			} else {
				this._drawPlume(ctx, nozzle2X, 0, 0.65, throttle, curFuel, R);
			}
		}
	}

	static _drawFairing(ctx, startX, radius, length, theme) {
		const grad = ctx.createLinearGradient(0, -radius, 0, radius);
		grad.addColorStop(0, theme.fairingGrad[0]);
		grad.addColorStop(0.4, theme.fairingGrad[1]);
		grad.addColorStop(1, theme.fairingGrad[2]);

		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.moveTo(startX, -radius);
		ctx.quadraticCurveTo(startX + length * 0.7, -radius * 0.9, startX + length, 0);
		ctx.quadraticCurveTo(startX + length * 0.7, radius * 0.9, startX, radius);
		ctx.closePath();
		ctx.fill();

		ctx.strokeStyle = theme.fairingLine;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(startX, 0);
		ctx.lineTo(startX + length - 2, 0);
		ctx.stroke();

		ctx.fillStyle = theme.accentBand;
		ctx.fillRect(startX, -radius, Math.max(1.5, radius * 0.15), radius * 2);
	}

	static _drawStage2(ctx, startX, radius, length, isExposedNozzle, nozzleX, nozzleLen, theme) {
		const grad = ctx.createLinearGradient(0, -radius, 0, radius);
		grad.addColorStop(0, theme.stg2Grad[0]);
		grad.addColorStop(0.4, theme.stg2Grad[1]);
		grad.addColorStop(1, theme.stg2Grad[2]);

		ctx.fillStyle = grad;
		ctx.fillRect(startX, -radius, length, radius * 2);

		ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
		ctx.lineWidth = 1;
		ctx.strokeRect(startX, -radius, length, radius * 2);

		if (isExposedNozzle) {
			ctx.fillStyle = theme.nozzle;
			ctx.beginPath();
			ctx.moveTo(startX, -radius * 0.35);
			ctx.lineTo(nozzleX, -radius * 0.75);
			ctx.lineTo(nozzleX, radius * 0.75);
			ctx.lineTo(startX, radius * 0.35);
			ctx.closePath();
			ctx.fill();
		}
	}

	static _drawInterstage(ctx, startX, radius, length, theme) {
		ctx.fillStyle = theme.interstage;
		ctx.fillRect(startX, -radius, length, radius * 2);

		ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
		ctx.lineWidth = 1;
		ctx.strokeRect(startX, -radius, length, radius * 2);
	}

	static _drawStage1(ctx, startX, radius, length, nozzleX, nozzleLen, theme) {
		const grad = ctx.createLinearGradient(0, -radius, 0, radius);
		grad.addColorStop(0, theme.stg1Grad[0]);
		grad.addColorStop(0.4, theme.stg1Grad[1]);
		grad.addColorStop(1, theme.stg1Grad[2]);

		ctx.fillStyle = grad;
		ctx.fillRect(startX, -radius, length, radius * 2);

		ctx.fillStyle = theme.accentBand;
		ctx.fillRect(startX + length - Math.max(2, length * 0.04), -radius, Math.max(2, length * 0.04), radius * 2);

		ctx.fillStyle = theme.nozzle;
		ctx.beginPath();
		ctx.moveTo(startX, -radius * 0.6);
		ctx.lineTo(nozzleX, -radius * 0.95);
		ctx.lineTo(nozzleX, radius * 0.95);
		ctx.lineTo(startX, radius * 0.6);
		ctx.closePath();
		ctx.fill();

		ctx.fillStyle = theme.fins;
		const m = ROCKET_VISUAL.MODULES;
		const finBaseLen = length * m.FIN_BASE_RATIO;
		const finSpan = radius * m.FIN_SPAN_RATIO;

		ctx.beginPath();
		ctx.moveTo(startX + finBaseLen, -radius);
		ctx.lineTo(startX, -radius - finSpan);
		ctx.lineTo(startX + finBaseLen * 0.25, -radius);
		ctx.closePath();
		ctx.fill();

		ctx.beginPath();
		ctx.moveTo(startX + finBaseLen, radius);
		ctx.lineTo(startX, radius + finSpan);
		ctx.lineTo(startX + finBaseLen * 0.25, radius);
		ctx.closePath();
		ctx.fill();
	}

	static _drawPayloadSatellite(ctx, cx, cy, R) {
		ctx.save();
		ctx.translate(cx, cy);

		const m = ROCKET_VISUAL.MODULES;
		const busW = R * m.SATELLITE_BUS_W_RATIO;
		const busH = R * m.SATELLITE_BUS_H_RATIO;

		ctx.fillStyle = '#d4af37';
		ctx.strokeStyle = '#ffee88';
		ctx.lineWidth = 1;
		ctx.fillRect(-busW * 0.5, -busH * 0.5, busW, busH);
		ctx.strokeRect(-busW * 0.5, -busH * 0.5, busW, busH);

		const dishR = busH * m.SATELLITE_DISH_R_RATIO;
		ctx.beginPath();
		ctx.arc(busW * 0.65, 0, dishR, -Math.PI * 0.5, Math.PI * 0.5);
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 1.0;
		ctx.stroke();

		const panelW = busW * m.SATELLITE_PANEL_W_RATIO;
		const panelH = busH * m.SATELLITE_PANEL_H_RATIO;
		ctx.fillStyle = '#004488';
		ctx.strokeStyle = '#00aaff';
		ctx.lineWidth = 1;

		ctx.fillRect(-panelW * 0.5, -busH * 0.5 - panelH - 1, panelW, panelH);
		ctx.strokeRect(-panelW * 0.5, -busH * 0.5 - panelH - 1, panelW, panelH);

		ctx.fillRect(-panelW * 0.5, busH * 0.5 + 1, panelW, panelH);
		ctx.strokeRect(-panelW * 0.5, busH * 0.5 + 1, panelW, panelH);

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
				grad.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
				grad.addColorStop(0.15, 'rgba(120, 200, 255, 0.7)');
				grad.addColorStop(0.5, 'rgba(150, 120, 255, 0.35)');
				grad.addColorStop(0.85, 'rgba(200, 100, 255, 0.1)');
				grad.addColorStop(1, 'rgba(150, 50, 255, 0)');

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.quadraticCurveTo(-len * 0.3, -w * 0.9, -len, 0);
				ctx.quadraticCurveTo(-len * 0.3, w * 0.9, 0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				ctx.strokeStyle = 'rgba(200, 240, 255, 0.65)';
				ctx.lineWidth = 1.2;
				for (let i = 1; i <= cfg.diamonds; i++) {
					const dx = -len * (cfg.diamondInterval * i);
					const dw = (w * cfg.diamondWidthRatio) / i;
					ctx.beginPath();
					ctx.moveTo(dx - 3, 0);
					ctx.lineTo(dx, -dw);
					ctx.lineTo(dx + 3, 0);
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
				grad.addColorStop(0, '#ffffff');
				grad.addColorStop(0.2, '#fff6bd');
				grad.addColorStop(0.5, '#ffd15c');
				grad.addColorStop(0.8, '#ff8c1a');
				grad.addColorStop(1, 'rgba(180, 80, 0, 0)');

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.lineTo(-len * 0.6, -w * 0.35);
				ctx.lineTo(-len, 0);
				ctx.lineTo(-len * 0.6, w * 0.35);
				ctx.lineTo(0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
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
				grad.addColorStop(0, '#ffffff');
				grad.addColorStop(0.25, '#00ffcc');
				grad.addColorStop(0.65, 'rgba(0, 160, 255, 0.5)');
				grad.addColorStop(1, 'rgba(0, 50, 200, 0)');

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.lineTo(-len, 0);
				ctx.lineTo(0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				ctx.strokeStyle = '#88ffff';
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
				grad.addColorStop(0, '#ffffff');
				grad.addColorStop(0.15, '#ffea77');
				grad.addColorStop(0.45, '#ff6600');
				grad.addColorStop(0.85, 'rgba(200, 30, 0, 0.4)');
				grad.addColorStop(1, 'rgba(100, 10, 0, 0)');

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.moveTo(0, -w * 0.5);
				ctx.quadraticCurveTo(-len * 0.35, -w * 0.75, -len, 0);
				ctx.quadraticCurveTo(-len * 0.35, w * 0.75, 0, w * 0.5);
				ctx.closePath();
				ctx.fill();

				const coreGrad = ctx.createLinearGradient(0, 0, -len * cfg.coreLenRatio, 0);
				coreGrad.addColorStop(0, '#ffffff');
				coreGrad.addColorStop(1, 'rgba(255, 230, 150, 0)');
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
