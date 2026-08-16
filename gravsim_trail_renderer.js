
// gravsim_trail_renderer.js

import { ColorUtils } from './gravsim_utils.js';
import { RENDER } from './gravsim_const.js';

/*******************************************************************
 * TrailRenderer for Base
 *******************************************************************/
class BaseTrailRenderer {
	draw(trajectory, renderContext) {
		throw new Error("Method 'draw()' must be implemented.");
	}

	_getPointsToDraw(trajectory, renderContext) {
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
				pointsToDraw.push({ relX, relY, logicalIdx: i });
				lastAddedPt = { relX, relY, logicalIdx: i };
			}

			if (drawnLength > targetLengthPx) {
				if (lastAddedPt && lastAddedPt.logicalIdx !== i) {
					pointsToDraw.push({ relX, relY, logicalIdx: i });
				}
				break; 
			}
		}
		
		return pointsToDraw;
	}
}

/*******************************************************************
 * TrailRenderer for Traditional trail
 *******************************************************************/
class SolidLineRenderer extends BaseTrailRenderer {
	draw(trajectory, renderContext) {
		const ctx = renderContext.ctx;
		const pointsToDraw = this._getPointsToDraw(trajectory, renderContext);
		if (pointsToDraw.length < 2) { return; }

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
}

/*******************************************************************
 * TrailRenderer for Spark & traditional trail
 *******************************************************************/
class SparkRenderer extends BaseTrailRenderer {
	constructor() {
		super();
	}

	draw(trajectory, renderContext) {
		const ctx = renderContext.ctx;
		const pointsToDraw = this._getPointsToDraw(trajectory, renderContext);
		if (pointsToDraw.length < 2) { return; }

		const now = Date.now();
		const config = trajectory.rendering_config;
		const trajectory_color = config.color || '#FFFFFF';
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

		// Drawing traditional trajectory
		for (let i = pointsToDraw.length - 1; i > RENDER.SPARKLE.COUNT; i--) {
			const p1 = pointsToDraw[i];
			const p2 = pointsToDraw[i - 1];

			const isOutside = 
				(p1.relX < minX && p2.relX < minX) ||
				(p1.relX > maxX && p2.relX > maxX) ||
				(p1.relY < minY && p2.relY < minY) ||
				(p1.relY > maxY && p2.relY > maxY);

			if (isOutside) { continue; }

			const t = (pointsToDraw.length - i) / pointsToDraw.length;
			const alpha = t * RENDER.TRAJECTORY.ALPHA_RATE + RENDER.TRAJECTORY.ALPHA_BASE;
			const width = baseSize * (RENDER.TRAJECTORY.TAPER_BASE + RENDER.TRAJECTORY.TAPER_RATE * t);

			ctx.strokeStyle = ColorUtils.hexToRgba(trajectory_color, alpha);
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(p1.relX, p1.relY);
			ctx.lineTo(p2.relX, p2.relY);
			ctx.stroke();
		}

		// Drawing spark
		const sparkEnd = Math.min(RENDER.SPARKLE.COUNT, pointsToDraw.length - 1);
		for (let i = sparkEnd; i >= 0; i--) {
			const pt = pointsToDraw[i];

			if (pt.relX < minX || pt.relX > maxX || pt.relY < minY || pt.relY > maxY) { continue; }

			const age = i;
			const attenuation = 1.0 - (age / RENDER.SPARKLE.COUNT);
			if (attenuation <= 0) { continue; }

			this._drawSingleSpark(ctx, pt.relX, pt.relY, baseSize, attenuation, now, trajectory.id);
		}

		ctx.restore();
	}

	_drawSingleSpark(ctx, x, y, baseSize, scale, now, id) {
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
 * TrailRenderer for Smoke trail
 *******************************************************************/
class SmokeRenderer extends BaseTrailRenderer {
	draw(trajectory, renderContext) {
		const ctx = renderContext.ctx;
		const zoomScale = renderContext.zoomScale;
		const pointsToDraw = this._getPointsToDraw(trajectory, renderContext);
		if (pointsToDraw.length < 2) { return; }

		const config = trajectory.rendering_config;
		const bodyScreenRadius = config.bodyScreenRadius || 1;

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

		const drawLen = Math.min(RENDER.SMOKE.DRAW_MAX_LEN, pointsToDraw.length);
		for (let i = 0; i < drawLen; i++) {
			const pt = pointsToDraw[i];

			// Culling
			if (pt.relX < minX || pt.relX > maxX || pt.relY < minY || pt.relY > maxY) { continue; }

			// Skip drawing to avoid overlapping
			const latestPt = pointsToDraw[0];
			const dx = pt.relX - latestPt.relX;
			const dy = pt.relY - latestPt.relY;
			const distSq = dx * dx + dy * dy;
			if (distSq <= bodyScreenRadius) {
				continue;
			}

			const t = i / drawLen;

			const peakT = 0.15;
			let alpha = 0;
			if (t < peakT) {
				alpha = (t / peakT) * RENDER.SMOKE.ALPHA_RATE + RENDER.SMOKE.ALPHA_BASE;
			} else {
				alpha = ((1.0 - t) / (1.0 - peakT)) * RENDER.SMOKE.ALPHA_RATE + RENDER.SMOKE.ALPHA_BASE;
			}

			const radius_atten = RENDER.SMOKE.RADIUS_BASE + t * RENDER.SMOKE.RADIUS_RATE;
			const radius = Math.min(bodyScreenRadius * radius_atten, bodyScreenRadius);

			const xDev = RENDER.SMOKE.DEVIATION_RATE * ((pt.relX + 1e5) % t);
			const yDev = RENDER.SMOKE.DEVIATION_RATE * ((pt.relY + 1e5) % t);

			ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
			ctx.beginPath();
			ctx.arc(pt.relX + xDev, pt.relY + yDev, radius, 0, Math.PI * 2);
			ctx.fill();
		}
		
		ctx.restore();
	}
}

// System common renderers
export const TRAIL_RENDERERS = {
	normal: new SolidLineRenderer(),
	escape: new SparkRenderer(),
	atmosphere: new SmokeRenderer(),
};
