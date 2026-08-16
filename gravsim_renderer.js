
// gravsim_renderer.js

import { PHYSICS, RENDER, DEBRIS } from './gravsim_const.js';
import { ColorUtils } from './gravsim_utils.js';

function AU2M(au) {
	return au * PHYSICS.METERS_PER_AU;
}
function M2AU(m) {
	return m / PHYSICS.METERS_PER_AU;
}

/*******************************************************************
 * Renderer Class
*******************************************************************/
export class Renderer {
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.zoomScale = 1;
		this.visualEffects = [];
		this.rotation = 0;
		this.showLabels = false;
		this.showDebugOverlay = false;

		this.renderContext = {
			ctx: this.ctx,
			basis: null,
			zoomScale: 1,
			trailLengthAU: 3.0,
		};
	}

	setRotation(angle) {
		this.rotation = angle;
	}

	setZoomScale(scale) {
		this.zoomScale = scale;
	}

	pix2au(px) { return px / RENDER.DISTANCE_SCALE; }
	au2pix(au) { return au * RENDER.DISTANCE_SCALE; }
	m2pix(m) { return this.au2pix(M2AU(m)); }
	pix2m(px) { return AU2M(this.pix2au(px)); }

	// Register shock-wave of impact
	addShockwave(x, y, color) {
		this.visualEffects.push({
			x: x,
			y: y,
			color: color,
			startTime: Date.now(),
			duration: DEBRIS.SHOCKWAVE_TIME
		});
	}

	draw(objects, centerObject, cameraOffset = {x: 0, y: 0}, trailLengthAU = 3.0) {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);

		// Apply offset to pan
		const offsetX_px = -cameraOffset.x * this.zoomScale;
		const offsetY_px = -cameraOffset.y * this.zoomScale;
		this.ctx.translate(offsetX_px, offsetY_px);

		if (this.rotation !== undefined) { this.ctx.rotate(this.rotation); }

		// draw object
		this.renderContext.basis = centerObject;
		this.renderContext.zoomScale = this.zoomScale;
		this.renderContext.trailLengthAU = trailLengthAU;
		
		objects.forEach(obj => obj.draw(this.renderContext));
		
		if (this.showLabels) {
			this._drawLabels(objects, centerObject);
		}

		if (this.showDebugOverlay) {
			this._drawDebugOverlay(centerObject);
		}

		// draw visual effect
		const now = Date.now();
		this.visualEffects = this.visualEffects.filter(eff => {
			const progress = (now - eff.startTime) / eff.duration;

			if (progress >= 1) { return false; }

			const radius = (progress * DEBRIS.SHOCKWAVE_RADIUS) * this.zoomScale;
			const alpha = 1.0 - progress;

			this.ctx.save();
			const relX = (eff.x - centerObject.x) * this.zoomScale;
			const relY = (eff.y - centerObject.y) * this.zoomScale;
			
			this.ctx.strokeStyle = ColorUtils.hexToRgba(eff.color, alpha);
			this.ctx.lineWidth = 2;
			this.ctx.beginPath();
			this.ctx.arc(relX, relY, radius, 0, Math.PI * 2);
			this.ctx.stroke();
			this.ctx.restore();

			return true;
		});

		this.ctx.restore();

		this._drawScaleBar();
	}

	_drawLabels(objects, centerObject) {
		this.ctx.save();
		this.ctx.font = RENDER.LABEL.FONT;
		this.ctx.textAlign = "left";
		this.ctx.textBaseline = "middle";

		objects.forEach(obj => {
			if (obj.state !== 0) { return; }
			
			const relX = (obj.x - centerObject.x) * this.zoomScale;
			const relY = (obj.y - centerObject.y) * this.zoomScale;
			
			// Don't draw if completely out of screen
			const margin = RENDER.LABEL.MARGIN;
			const halfW = this.canvas.width / 2;
			const halfH = this.canvas.height / 2;
			if (relX < -halfW - margin || relX > halfW + margin || 
				relY < -halfH - margin || relY > halfH + margin) {
				return;
			}

			const labelX = relX + RENDER.LABEL.OFFSET_X;
			const labelY = relY + RENDER.LABEL.OFFSET_Y;
			
			// Draw background for readability
			const textWidth = this.ctx.measureText(obj.name).width;
			this.ctx.fillStyle = RENDER.LABEL.BG_COLOR;
			this.ctx.fillRect(labelX - 2, labelY - 6, textWidth + 4, 12);

			this.ctx.fillStyle = obj.color;
			this.ctx.fillText(obj.name, labelX, labelY);
		});
		
		this.ctx.restore();
	}

	_drawDebugOverlay(centerObject) {
		this.ctx.save();
		this.ctx.strokeStyle = RENDER.DEBUG.LINE_COLOR;
		this.ctx.fillStyle = RENDER.DEBUG.TEXT_COLOR;
		this.ctx.font = RENDER.DEBUG.FONT;
		this.ctx.textAlign = "center";
		this.ctx.textBaseline = "bottom";
		this.ctx.lineWidth = 1;

		// Calculate appropriate distance step based on zoom scale
		let stepAU = 1;
		const oneAUPx = this.au2pix(1) * this.zoomScale;
		
		if (oneAUPx > 500) { stepAU = 0.1; }
		else if (oneAUPx < 5) { stepAU = 100; }
		else if (oneAUPx < 10) { stepAU = 20; }
		else if (oneAUPx < 50) { stepAU = 10; }
		else if (oneAUPx < 100) { stepAU = 2; }

		// Draw concentric circles up to screen boundary
		const maxRadiusPx = Math.sqrt(Math.pow(this.canvas.width, 2) + Math.pow(this.canvas.height, 2));
		const maxAU = this.pix2au(maxRadiusPx / this.zoomScale);
		
		for (let rAU = stepAU; rAU <= maxAU; rAU += stepAU) {
			const rPx = this.au2pix(rAU) * this.zoomScale;
			this.ctx.beginPath();
			this.ctx.arc(0, 0, rPx, 0, Math.PI * 2);
			this.ctx.stroke();

			this.ctx.fillText(`${parseFloat(rAU.toPrecision(4))} AU`, 0, -rPx - 2);
		}

		// Center cross
		const crossSize = RENDER.DEBUG.CROSS_SIZE;
		this.ctx.beginPath();
		this.ctx.moveTo(-crossSize, 0);
		this.ctx.lineTo(crossSize, 0);
		this.ctx.moveTo(0, -crossSize);
		this.ctx.lineTo(0, crossSize);
		this.ctx.stroke();

		this.ctx.restore();
	}

	_drawScaleBar() {
		const targetPx = RENDER.SCALE_BAR.WIDTH;
		let val = this.pix2m(targetPx / this.zoomScale);

		let unit = "m";

		// Change unit depending the distance
		if (val > PHYSICS.METERS_PER_AU * 0.1) {
			unit = "AU";
			val = val / PHYSICS.METERS_PER_AU;
		} else if (val > 1000) {
			unit = "km";
			val = val / 1000;
		}

		// Make it even number
		const exp = Math.floor(Math.log10(val));
		const frac = val / Math.pow(10, exp);
		let niceFrac;
		if (frac < 1.5) { niceFrac = 1; }
		else if (frac < 3.5) { niceFrac = 2; }
		else if (frac < 7.5) { niceFrac = 5; }
		else { niceFrac = 10; }
		const niceVal = niceFrac * Math.pow(10, exp);

		// Re-calculate pix
		let niceM = niceVal;
		if (unit === "AU") { niceM = niceVal * PHYSICS.METERS_PER_AU; }
		else if (unit === "km") { niceM = niceVal * 1000; }
		const drawPx = Math.round(this.m2pix(niceM) * this.zoomScale);

		// Generate indicator number text
		let textVal = niceVal;
		if (niceVal >= 10000) {
			textVal = niceVal.toLocaleString('en-US'); 
		} else {
			textVal = parseFloat(niceVal.toPrecision(15)).toString();
		}
		const label = `${textVal} ${unit}`;

		// Calculate position
		const rightX = Math.round(this.canvas.width - RENDER.SCALE_BAR.RIGHT);
		const bottomY = Math.round(this.canvas.height - RENDER.SCALE_BAR.BOTTOM);

		this.ctx.save();

		// Draw text
		this.ctx.fillStyle = RENDER.SCALE_BAR_TEXT.COLOR;
		this.ctx.font = RENDER.SCALE_BAR_TEXT.FONT_FAMILY;
		this.ctx.textAlign = RENDER.SCALE_BAR_TEXT.ALIGN;
		this.ctx.textBaseline = RENDER.SCALE_BAR_TEXT.BASE_LINE;
		this.ctx.fillText(label, rightX, bottomY - RENDER.SCALE_BAR_TEXT.BOTTOM_OFFSET);

		// Draw scale bar
		this.ctx.strokeStyle = RENDER.SCALE_BAR.COLOR;
		this.ctx.lineWidth = RENDER.SCALE_BAR.LINE_WIDTH;
		this.ctx.beginPath();
		this.ctx.moveTo(rightX - drawPx, bottomY - RENDER.SCALE_BAR.VERTICAL_LINE_WIDTH); // Left-side vertical line
		this.ctx.lineTo(rightX - drawPx, bottomY);
		this.ctx.lineTo(rightX, bottomY); // Bar
		this.ctx.lineTo(rightX, bottomY - RENDER.SCALE_BAR.VERTICAL_LINE_WIDTH); // Right-side vertical line
		this.ctx.stroke();
		
		this.ctx.restore();
	}
}
