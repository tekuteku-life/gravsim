
// gravsim_renderer.js

import { EventBus } from './gravsim_event_bus.js';

/*******************************************************************
 * Renderer Class
*******************************************************************/
export class Renderer {
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.zoomScale = 1;
		this.rotation = 0;

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
		EventBus.emit('draw:before', this.ctx, this.renderContext);

		// 2. Draw main objects
		objects.forEach(obj => obj.draw(this.renderContext));

		// 3. After objects (effects, labels, etc. before restoring transform)
		EventBus.emit('draw:after', this.ctx, this.renderContext);

		this.ctx.restore();

		// 4. Screen-space overlays (UI, Scalebar)
		EventBus.emit('draw:overlay', this.ctx, this.renderContext);
	}
}
