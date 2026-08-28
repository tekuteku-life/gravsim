
// gravsim_overlay_renderer.js

import { PHYSICS, RENDER, EVENT_PRIORITY } from './gravsim_const.js';
import { UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

export class OverlayRenderer {
	constructor(universe) {
		this.universe = universe;
		this.showLabels = false;
		this.showDebugOverlay = false;

		EventBus.onDrawAfter((ctx, rc) => this.drawAfter(ctx, rc), EVENT_PRIORITY.DRAW_OVERLAY);
		EventBus.onDrawOverlay((ctx, rc) => this.drawOverlay(ctx, rc), EVENT_PRIORITY.DRAW_HUD);
		EventBus.on('render:set-labels-visible', (visible) => { this.showLabels = visible; });
		EventBus.on('render:set-debug-visible', (visible) => { this.showDebugOverlay = visible; });
	}

	drawAfter(ctx, renderContext) {
		if (renderContext.name !== 'main') { return; }

		if (this.showLabels) {
			this._drawLabels(ctx, renderContext);
		}
		if (this.showDebugOverlay) {
			this._drawDebugOverlay(ctx, renderContext);
		}
	}

	drawOverlay(ctx, renderContext) {
		if (renderContext.name !== 'main') { return; }

		this._drawScaleBar(ctx, renderContext);
	}

	_drawLabels(ctx, renderContext) {
		const objects = this.universe.objects;
		const centerObject = renderContext.basis;
		const zoomScale = renderContext.zoomScale;
		const LBL = RENDER.LABEL;
		
		ctx.save();
		ctx.font = LBL.FONT;
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";

		objects.forEach(obj => {
			if (obj.state !== 0) { return; }
			
			const relX = (obj.x - centerObject.x) * zoomScale;
			const relY = (obj.y - centerObject.y) * zoomScale;
			
			// Don't draw if completely out of screen
			const halfW = ctx.canvas.width / 2;
			const halfH = ctx.canvas.height / 2;
			if (relX < -halfW - LBL.MARGIN || relX > halfW + LBL.MARGIN || 
				relY < -halfH - LBL.MARGIN || relY > halfH + LBL.MARGIN) {
				return;
			}

			const labelX = relX + LBL.OFFSET_X;
			const labelY = relY + LBL.OFFSET_Y;
			
			// Draw background for readability
			const textWidth = ctx.measureText(obj.name).width;
			ctx.fillStyle = LBL.BG_COLOR;
			ctx.fillRect(
				labelX - LBL.BG_PAD_X, 
				labelY - LBL.BG_PAD_Y, 
				textWidth + LBL.BG_EXTRA_W, 
				LBL.BG_H
			);

			ctx.fillStyle = obj.color;
			ctx.fillText(obj.name, labelX, labelY);
		});
		
		ctx.restore();
	}

	_drawDebugOverlay(ctx, renderContext) {
		const zoomScale = renderContext.zoomScale;

		ctx.save();
		ctx.strokeStyle = RENDER.DEBUG.LINE_COLOR;
		ctx.fillStyle = RENDER.DEBUG.TEXT_COLOR;
		ctx.font = RENDER.DEBUG.FONT;
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		ctx.lineWidth = 1;

		// Calculate appropriate distance step based on zoom scale
		let stepAU = RENDER.DEBUG.STEP_MAX;
		const oneAUPx = UnitConvertUtils.au2pix(1) * zoomScale;

		for (const threshold of RENDER.DEBUG.STEP_THRESHOLDS) {
			if (oneAUPx < threshold.limit) {
				stepAU = threshold.step;
				break;
			}
		}
		if (oneAUPx > 500) { stepAU = RENDER.DEBUG.STEP_DEFAULT; }

		// Draw concentric circles up to screen boundary
		const maxRadiusPx = Math.sqrt(Math.pow(ctx.canvas.width, 2) + Math.pow(ctx.canvas.height, 2));
		const maxAU = UnitConvertUtils.pix2au(maxRadiusPx / zoomScale);
		
		for (let rAU = stepAU; rAU <= maxAU; rAU += stepAU) {
			const rPx = UnitConvertUtils.au2pix(rAU) * zoomScale;
			ctx.beginPath();
			ctx.arc(0, 0, rPx, 0, Math.PI * 2);
			ctx.stroke();

			ctx.fillText(`${parseFloat(rAU.toPrecision(4))} AU`, 0, -rPx - 2);
		}

		// Center cross
		const crossSize = RENDER.DEBUG.CROSS_SIZE;
		ctx.beginPath();
		ctx.moveTo(-crossSize, 0);
		ctx.lineTo(crossSize, 0);
		ctx.moveTo(0, -crossSize);
		ctx.lineTo(0, crossSize);
		ctx.stroke();

		ctx.restore();
	}

	_drawScaleBar(ctx, renderContext) {
		const zoomScale = renderContext.zoomScale;
		const targetPx = RENDER.SCALE_BAR.WIDTH;
		let val = UnitConvertUtils.pix2m(targetPx / zoomScale);

		let unit = "m";

		// Change unit depending the distance
		if (val > PHYSICS.METERS_PER_AU * 0.1) {
			unit = "AU";
			val = val / PHYSICS.METERS_PER_AU;
		} else if (val > 1000) {
			unit = "km";
			val = UnitConvertUtils.m2km(val);
		}

		// Make it even number
		const exp = Math.floor(Math.log10(val));
		const frac = val / Math.pow(10, exp);
		let niceFrac;
		const THRESHOLDS = RENDER.SCALE_BAR.FRAC_THRESHOLDS;
		if (frac < THRESHOLDS[0]) { niceFrac = 1; }
		else if (frac < THRESHOLDS[1]) { niceFrac = 2; }
		else if (frac < THRESHOLDS[2]) { niceFrac = 5; }
		else { niceFrac = 10; }
		const niceVal = niceFrac * Math.pow(10, exp);

		// Re-calculate pix
		let niceM = niceVal;
		if (unit === "AU") { niceM = niceVal * PHYSICS.METERS_PER_AU; }
		else if (unit === "km") { niceM = UnitConvertUtils.km2m(niceVal); }
		const drawPx = Math.round(UnitConvertUtils.m2pix(niceM) * zoomScale);

		// Generate indicator number text
		let textVal = niceVal;
		if (niceVal >= 10000) {
			textVal = niceVal.toLocaleString('en-US'); 
		} else {
			textVal = parseFloat(niceVal.toPrecision(15)).toString();
		}
		const label = `${textVal} ${unit}`;

		// Calculate position
		const rightX = Math.round(ctx.canvas.width - RENDER.SCALE_BAR.RIGHT);
		const bottomY = Math.round(ctx.canvas.height - RENDER.SCALE_BAR.BOTTOM);

		ctx.save();

		// Draw text
		ctx.fillStyle = RENDER.SCALE_BAR_TEXT.COLOR;
		ctx.font = RENDER.SCALE_BAR_TEXT.FONT_FAMILY;
		ctx.textAlign = RENDER.SCALE_BAR_TEXT.ALIGN;
		ctx.textBaseline = RENDER.SCALE_BAR_TEXT.BASE_LINE;
		ctx.fillText(label, rightX, bottomY - RENDER.SCALE_BAR_TEXT.BOTTOM_OFFSET);

		// Draw scale bar
		ctx.strokeStyle = RENDER.SCALE_BAR.COLOR;
		ctx.lineWidth = RENDER.SCALE_BAR.LINE_WIDTH;
		ctx.beginPath();
		ctx.moveTo(rightX - drawPx, bottomY - RENDER.SCALE_BAR.VERTICAL_LINE_WIDTH); // Left-side vertical line
		ctx.lineTo(rightX - drawPx, bottomY);
		ctx.lineTo(rightX, bottomY); // Bar
		ctx.lineTo(rightX, bottomY - RENDER.SCALE_BAR.VERTICAL_LINE_WIDTH); // Right-side vertical line
		ctx.stroke();

		ctx.restore();
	}
}
