
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
			cameraOffset: { x: 0, y: 0 },
			rotation: 0,
			objectsMap: null
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

	draw(objects, renderState, trailLengthAU = 3.0) {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);

		// Apply rotation FIRST, then apply offset to pan
		if (renderState.rotation !== 0) { 
			this.ctx.rotate(renderState.rotation); 
		}

		const offsetX_px = -renderState.cameraOffset.x * renderState.zoomScale;
		const offsetY_px = -renderState.cameraOffset.y * renderState.zoomScale;
		this.ctx.translate(offsetX_px, offsetY_px);

		this.rotation = renderState.rotation;
		this.zoomScale = renderState.zoomScale;

		const objectsMap = new Map();
		objects.forEach(obj => objectsMap.set(obj.id, obj));

		// Set up context
		this.renderContext.basis = renderState.basis;
		this.renderContext.zoomScale = renderState.zoomScale;
		this.renderContext.trailLengthAU = trailLengthAU;
		this.renderContext.cameraOffset = renderState.cameraOffset;
		this.renderContext.centerObjectId = renderState.basis ? renderState.basis.id : null;
		this.renderContext.rotation = renderState.rotation;
		this.renderContext.objectsMap = objectsMap;
		
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
