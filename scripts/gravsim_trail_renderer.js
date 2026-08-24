
// gravsim_trail_renderer.js

import { ColorUtils } from './gravsim_utils.js';
import { RENDER, TRAIL_MODE } from './gravsim_const.js';

/*******************************************************************
 * TrailLineRenderer: Draws solid trajectory lines
 *******************************************************************/
export class TrailLineRenderer {
	static draw(trajectory, renderContext) {
		const pointsToDraw = this._getPointsToDraw(trajectory, renderContext);
		if (pointsToDraw.length < 2) { return; }

		const ctx = renderContext.ctx;
		const config = trajectory.rendering_config;
		const color = config.color || '#FFFFFF';
		const baseSize = config.baseSize || 1;

		const cx = renderContext.cameraOffset ? renderContext.cameraOffset.x * renderContext.zoomScale : 0;
		const cy = renderContext.cameraOffset ? renderContext.cameraOffset.y * renderContext.zoomScale : 0;
		const halfW = (ctx.canvas.width / 2) + 50;
		const halfH = (ctx.canvas.height / 2) + 50;
		
		const minX = cx - halfW;
		const maxX = cx + halfW;
		const minY = cy - halfH;
		const maxY = cy + halfH;

		ctx.save();

		for (let i = pointsToDraw.length - 1; i > 0; i--) {
			const p1 = pointsToDraw[i];
			const p2 = pointsToDraw[i - 1];

			// Do not connect lines if either point is ATMOSPHERE
			if (p1.mode === TRAIL_MODE.ATMOSPHERE || p2.mode === TRAIL_MODE.ATMOSPHERE) { continue; }

			// Culling: skip if the point is out of screen
			const isOutside = 
				(p1.relX < minX && p2.relX < minX) ||
				(p1.relX > maxX && p2.relX > maxX) ||
				(p1.relY < minY && p2.relY < minY) ||
				(p1.relY > maxY && p2.relY > maxY);

			if (isOutside) { continue; }

			const t = (pointsToDraw.length - i) / pointsToDraw.length;
			const alpha = t * RENDER.TRAJECTORY.ALPHA_RATE + RENDER.TRAJECTORY.ALPHA_BASE;
			const width = baseSize * (RENDER.TRAJECTORY.TAPER_BASE + RENDER.TRAJECTORY.TAPER_RATE * t);

			ctx.strokeStyle = ColorUtils.hexToRgba(color, alpha);
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(p1.relX, p1.relY);
			ctx.lineTo(p2.relX, p2.relY);
			ctx.stroke();
		}
		ctx.restore();
	}

	static _getPointsToDraw(trajectory, renderContext) {
		if (renderContext.trailLengthAU <= 0) { return []; }

		const basis = renderContext.basis;
		const zoomScale = renderContext.zoomScale;
		const count = trajectory.count;

		let drawnLength = 0;
		const targetLengthPx = renderContext.trailLengthAU * RENDER.DISTANCE_SCALE * zoomScale;
		
		let prevPt = null;
		let lastAddedPt = null;
		const pointsToDraw = [];

		for (let i = count - 1; i >= 0; i--) {
			const pt = trajectory.getPoint(i);
			let basisPos = { x: 0, y: 0 };

			if (basis) {
				if (basis.trajectory) {
					const bPos = basis.trajectory.getInterpolatedPos(pt.frame);
					basisPos = bPos ? bPos : { x: basis.x, y: basis.y };
				} else {
					basisPos = { x: basis.x, y: basis.y };
				}
			}

			const relX = (pt.x - basisPos.x) * zoomScale;
			const relY = (pt.y - basisPos.y) * zoomScale;
			
			if (prevPt) {
				const dx = relX - prevPt.relX;
				const dy = relY - prevPt.relY;
				drawnLength += Math.sqrt(dx * dx + dy * dy);
			}
			prevPt = { relX, relY };

			// Thinning
			let shouldAdd = false;
			if (!lastAddedPt || i === 0) {
				shouldAdd = true;
			} else {
				const dxAdd = relX - lastAddedPt.relX;
				const dyAdd = relY - lastAddedPt.relY;
				if ((dxAdd * dxAdd + dyAdd * dyAdd) > 4) {
					shouldAdd = true;
				}
			}

			if (shouldAdd) {
				pointsToDraw.push({ relX, relY, logicalIdx: i, mode: pt.mode });
				lastAddedPt = { relX, relY, logicalIdx: i };
			}

			if (drawnLength > targetLengthPx) {
				if (lastAddedPt && lastAddedPt.logicalIdx !== i) {
					pointsToDraw.push({ relX, relY, logicalIdx: i, mode: pt.mode });
				}
				break; 
			}
		}
		
		return pointsToDraw;
	}
}

/*******************************************************************
 * EffectRenderer: Orchestrates effect rendering based on EffectTrail
 *******************************************************************/
export class EffectRenderer {
	static draw(effectTrail, renderContext) {
		const pointsToDraw = this._getPointsToDraw(effectTrail, renderContext);
		if (pointsToDraw.length === 0) { return; }

		const ctx = renderContext.ctx;
		
		SmokeEffectRenderer.draw(ctx, pointsToDraw, effectTrail, renderContext);
		SparkEffectRenderer.draw(ctx, pointsToDraw, effectTrail, renderContext);
	}

	static _getPointsToDraw(effectTrail, renderContext) {
		const objectsMap = renderContext.objectsMap;
		const basis = renderContext.basis;
		const zoomScale = renderContext.zoomScale;
		const count = effectTrail.count;

		// We always draw full history for effects, but with thinning to reduce rendering load
		const pointsToDraw = [];
		let lastAddedPt = null;

		const basisPos = basis ? { x: basis.x, y: basis.y } : { x: 0, y: 0 };

		for (let i = count - 1; i >= 0; i--) {
			const pt = effectTrail.getPoint(i);
			
			let absX = pt.x;
			let absY = pt.y;

			// Restore absolute coordinates using the recorded reference dominant body
			if (pt.refId !== -1 && objectsMap) {
				const refObj = objectsMap.get(pt.refId);
				if (refObj) {
					let relX = pt.x;
					let relY = pt.y;

					// Apply current rotation of the reference body to restore world coordinate
					if (pt.mode === TRAIL_MODE.ATMOSPHERE && refObj.rotationAngle) {
						const cosA = Math.cos(refObj.rotationAngle);
						const sinA = Math.sin(refObj.rotationAngle);
						const worldX = relX * cosA - relY * sinA;
						const worldY = relX * sinA + relY * cosA;
						relX = worldX;
						relY = worldY;
					}

					absX = relX + refObj.x;
					absY = relY + refObj.y;
				}
			}

			const relX = (absX - basisPos.x) * zoomScale;
			const relY = (absY - basisPos.y) * zoomScale;

			// Thinning
			let shouldAdd = false;
			if (!lastAddedPt || i === 0) {
				shouldAdd = true;
			} else {
				const dxAdd = relX - lastAddedPt.relX;
				const dyAdd = relY - lastAddedPt.relY;
				if ((dxAdd * dxAdd + dyAdd * dyAdd) > 4) {
					shouldAdd = true;
				}
			}

			if (shouldAdd) {
				pointsToDraw.push({ relX, relY, logicalIdx: i, mode: pt.mode });
				lastAddedPt = { relX, relY, logicalIdx: i };
			}
		}
		
		return pointsToDraw;
	}
}

/*******************************************************************
 * SparkEffectRenderer: Draws sparks for escape trajectory
 *******************************************************************/
class SparkEffectRenderer {
	static draw(ctx, pointsToDraw, effectTrail, renderContext) {
		const now = Date.now();
		const config = effectTrail.rendering_config;
		const baseSize = config.baseSize || 1;

		const cx = renderContext.cameraOffset ? renderContext.cameraOffset.x * renderContext.zoomScale : 0;
		const cy = renderContext.cameraOffset ? renderContext.cameraOffset.y * renderContext.zoomScale : 0;
		const halfW = (ctx.canvas.width / 2) + 50;
		const halfH = (ctx.canvas.height / 2) + 50;
		
		const minX = cx - halfW;
		const maxX = cx + halfW;
		const minY = cy - halfH;
		const maxY = cy + halfH;

		ctx.save();

		const sparkEnd = Math.min(RENDER.SPARKLE.COUNT, pointsToDraw.length - 1);
		for (let i = sparkEnd; i >= 0; i--) {
			const pt = pointsToDraw[i];

			if (pt.mode !== TRAIL_MODE.ESCAPE) { continue; }
			if (pt.relX < minX || pt.relX > maxX || pt.relY < minY || pt.relY > maxY) { continue; }

			const age = i;
			const attenuation = 1.0 - (age / RENDER.SPARKLE.COUNT);
			if (attenuation <= 0) { continue; }

			this._drawSingleSpark(ctx, pt.relX, pt.relY, baseSize, attenuation, now, effectTrail.id);
		}

		ctx.restore();
	}

	static _drawSingleSpark(ctx, x, y, baseSize, scale, now, id) {
		const blink = Math.abs(Math.sin(now / RENDER.SPARKLE.ANIM_SPEED + id));
		const rawStarSize = baseSize * RENDER.SPARKLE.STAR_SIZE_RATIO * scale;
		const starSize = Math.min(rawStarSize, RENDER.SPARKLE.MAX_SIZE_PX);
		const innerSize = starSize * (RENDER.SPARKLE.STAR_INNER_SIZE_RATIO / RENDER.SPARKLE.STAR_SIZE_RATIO);

		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(now / RENDER.SPARKLE.ROTATE_SPEED);

		ctx.globalAlpha = blink * scale;
		ctx.fillStyle = RENDER.SPARKLE.COLOR;

		ctx.beginPath();
		ctx.moveTo(0, -starSize);
		ctx.lineTo(innerSize, -innerSize);
		ctx.lineTo(starSize, 0);
		ctx.lineTo(innerSize, innerSize);
		ctx.lineTo(0, starSize);
		ctx.lineTo(-innerSize, innerSize);
		ctx.lineTo(-starSize, 0);
		ctx.lineTo(-innerSize, -innerSize);
		ctx.fill();

		ctx.restore();
	}
}

/*******************************************************************
 * SmokeEffectRenderer: Draws smoke trail in atmosphere
 *******************************************************************/
class SmokeEffectRenderer {
	static draw(ctx, pointsToDraw, effectTrail, renderContext) {
		const bodyScreenRadius = renderContext.bodyScreenRadius || 1;

		const r = 220, g = 220, b = 220;
		
		const cx = renderContext.cameraOffset ? renderContext.cameraOffset.x * renderContext.zoomScale : 0;
		const cy = renderContext.cameraOffset ? renderContext.cameraOffset.y * renderContext.zoomScale : 0;
		const halfW = (ctx.canvas.width / 2) + 50;
		const halfH = (ctx.canvas.height / 2) + 50;
		
		const minX = cx - halfW;
		const maxX = cx + halfW;
		const minY = cy - halfH;
		const maxY = cy + halfH;

		ctx.save();

		let smokeCount = 0;
		const drawLen = Math.min(RENDER.SMOKE.DRAW_MAX_LEN, pointsToDraw.length);

		// Distance culling to avoid drawing smoke over the rocket nozzle
		const cullRadius = bodyScreenRadius * 1.2;

		for (let i = 0; i < pointsToDraw.length; i++) {
			const pt = pointsToDraw[i];

			if (pt.mode !== TRAIL_MODE.ATMOSPHERE) { continue; }
			if (smokeCount >= drawLen) { break; }

			// Culling
			if (pt.relX < minX || pt.relX > maxX || pt.relY < minY || pt.relY > maxY) {
				smokeCount++;
				continue; 
			}

			// Skip drawing to avoid overlapping the rocket
			const latestPt = pointsToDraw[0];
			const dx = pt.relX - latestPt.relX;
			const dy = pt.relY - latestPt.relY;
			const distSq = dx * dx + dy * dy;
			if (distSq <= cullRadius * cullRadius) {
				smokeCount++;
				continue;
			}

			const t = smokeCount / drawLen;

			const peakT = 0.15;
			let alpha = 0;
			if (t < peakT) {
				alpha = (t / peakT) * RENDER.SMOKE.ALPHA_RATE + RENDER.SMOKE.ALPHA_BASE;
			} else {
				alpha = ((1.0 - t) / (1.0 - peakT)) * RENDER.SMOKE.ALPHA_RATE + RENDER.SMOKE.ALPHA_BASE;
			}

			const radius_atten = RENDER.SMOKE.RADIUS_BASE + t * RENDER.SMOKE.RADIUS_RATE;
			const radius = bodyScreenRadius * radius_atten;

			const xDev = RENDER.SMOKE.DEVIATION_RATE * ((pt.relX + 1e5) % t);
			const yDev = RENDER.SMOKE.DEVIATION_RATE * ((pt.relY + 1e5) % t);

			ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
			ctx.beginPath();
			ctx.arc(pt.relX + xDev, pt.relY + yDev, radius, 0, Math.PI * 2);
			ctx.fill();

			smokeCount++;
		}
		
		ctx.restore();
	}
}
