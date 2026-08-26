
// gravsim.js

import { Universe } from './gravsim_universe.js';
import { EventBus } from './gravsim_event_bus.js';

window.onload = function() {
	const canvas = document.getElementById('gravsim-canvas');
	if (!canvas) {
		throw new Error("Canvas element with id 'gravsim-canvas' not found.");
	}

	function resizeCanvas() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
	}

	window.addEventListener('resize', resizeCanvas);
	resizeCanvas();

	window.universe = new Universe(canvas);

	let lastTime = performance.now();
	function animate(now) {
		const dt = now - lastTime;
		lastTime = now;

		EventBus.emit('app:update', dt);
		EventBus.emit('app:draw');
		EventBus.tickIntervals(now);

		requestAnimationFrame(animate);
	}
	requestAnimationFrame(animate);
};
