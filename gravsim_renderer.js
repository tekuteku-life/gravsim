
// gravsim_renderer.js

/*******************************************************************
 * Renderer Class
*******************************************************************/
export class Renderer {
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.zoomScale = 1;
		this.rotation = 0;

		this.drawHooks = {
			before: [],
			after: [],
			overlay: []
		};

		this.renderContext = {
			ctx: this.ctx,
			basis: null,
			zoomScale: 1,
			trailLengthAU: 3.0,
			centerObjectId: null,
			cameraOffset: { x: 0, y: 0 }
		};
	}

	setRotation(angle) {
		this.rotation = angle;
	}

	setZoomScale(scale) {
		this.zoomScale = scale;
	}

	addDrawHook(timing, callback) {
		if (this.drawHooks[timing]) {
			this.drawHooks[timing].push(callback);
		}
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

		// set up context
		this.renderContext.basis = centerObject;
		this.renderContext.zoomScale = this.zoomScale;
		this.renderContext.trailLengthAU = trailLengthAU;
		this.renderContext.cameraOffset = cameraOffset;
		this.renderContext.centerObjectId = centerObject ? centerObject.id : null;
		
		// 1. Before objects
		this.drawHooks.before.forEach(hook => hook(this.ctx, this.renderContext));

		// 2. Draw main objects
		objects.forEach(obj => obj.draw(this.renderContext));

		// 3. After objects (effects, labels, etc. before restoring transform)
		this.drawHooks.after.forEach(hook => hook(this.ctx, this.renderContext));

		this.ctx.restore();

		// 4. Screen-space overlays (UI, Scalebar)
		this.drawHooks.overlay.forEach(hook => hook(this.ctx, this.renderContext));
	}
}
