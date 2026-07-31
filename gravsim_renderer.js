
// gravsim_renderer.js

import {
	METERS_PER_AU, DISTANCE_SCALE, SCALE_BAR_WIDTH,
	DEBRIS_SHOCKWAVE_TIME, DEBRIS_SHOCKWAVE_RADIUS,
	SCALE_BAR_RIGHT, SCALE_BAR_LINE_WIDTH, SCALE_BAR_BOTTOM
} from './gravsim_const.js';

function AU2M(au) {
	return au * METERS_PER_AU;
}
function M2AU(m) {
	return m / METERS_PER_AU;
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
	}

	setZoomScale(scale) {
		this.zoomScale = scale;
	}

	pix2au(px) { return px / DISTANCE_SCALE; }
	au2pix(au) { return au * DISTANCE_SCALE; }
	m2pix(m) { return this.au2pix(M2AU(m)); }
	pix2m(px) { return AU2M(this.pix2au(px)); }

	// Register shock-wave of impact
	addShockwave(x, y, color) {
		this.visualEffects.push({
			x: x,
			y: y,
			color: color,
			startTime: Date.now(),
			duration: DEBRIS_SHOCKWAVE_TIME // Vanishes in 800 ms
		});
	}

	draw(objects, centerObject) {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
		this.ctx.scale(this.zoomScale, this.zoomScale);
		
		// draw object
		objects.forEach(obj => obj.draw(this.ctx, centerObject, 1 / this.zoomScale));
		
		// draw visual effect
		const now = Date.now();
		this.visualEffects = this.visualEffects.filter(eff => {
			const progress = (now - eff.startTime) / eff.duration;

			// vanishing
			if (progress >= 1) { return false; }

			// more larger and transparent as it progresses
			const radius = (progress * DEBRIS_SHOCKWAVE_RADIUS) * (1 / this.zoomScale);
			const alpha = 1.0 - progress;

			this.ctx.save();
			const relX = eff.x - centerObject.x;
			const relY = eff.y - centerObject.y;
			
			this.ctx.strokeStyle = this._hexToRgba(eff.color, alpha);
			this.ctx.lineWidth = 2 * (1 / this.zoomScale);
			this.ctx.beginPath();
			this.ctx.arc(relX, relY, radius, 0, Math.PI * 2);
			this.ctx.stroke();
			this.ctx.restore();

			return true;
		});

		this.ctx.restore();

		this._drawScaleBar();
	}

	_drawScaleBar() {
		const targetPx = SCALE_BAR_WIDTH;
		const targetM = this.pix2m(targetPx / this.zoomScale);
		
		let unit = "m";
		let val = targetM;
		
		// Change unit depending the distance
		if (val > METERS_PER_AU * 0.1) { 
			unit = "AU";
			val = val / METERS_PER_AU;
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
		if (unit === "AU") { niceM = niceVal * METERS_PER_AU; }
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
		const rightX = Math.round(this.canvas.width - SCALE_BAR_RIGHT);
		const bottomY = Math.round(this.canvas.height - SCALE_BAR_BOTTOM);

		this.ctx.save();
		
		// Draw text
		this.ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
		this.ctx.font = "12px sans-serif";
		this.ctx.textAlign = "right";
		this.ctx.textBaseline = "bottom";
		this.ctx.fillText(label, rightX, bottomY - 8);

		// Draw scale bar
		this.ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
		this.ctx.lineWidth = 2;
		this.ctx.beginPath();
		this.ctx.moveTo(rightX - drawPx, bottomY - 5); // Left-side vertical line
		this.ctx.lineTo(rightX - drawPx, bottomY);
		this.ctx.lineTo(rightX, bottomY); // Bar
		this.ctx.lineTo(rightX, bottomY - 5); // Right-side vertical line
		this.ctx.stroke();
		
		this.ctx.restore();
	}

	_hexToRgba(hex, alpha) {
		let c = hex.replace('#', '');
		if (c.length === 3) c = c.split('').map(x => x + x).join('');
		const num = parseInt(c, 16);
		const r = (num >> 16) & 255;
		const g = (num >> 8) & 255;
		const b = num & 255;
		return `rgba(${r},${g},${b},${alpha})`;
	}
}
