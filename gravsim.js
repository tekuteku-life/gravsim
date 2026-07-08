
import { Universe } from './gravsim_universe.js';

window.onload = function() {
	const canvas = document.getElementById('gravsim-canvas');
	if (!canvas) {
		throw new Error("Canvas element with id 'gravsim-canvas' not found.");
	}

	function resizeCanvas() {
		if (window.universe && window.universe.objects.length > 0)
		{
			const prevWidth = window.universe.canvas.width;
			const prevHeight = window.universe.canvas.height;

			const newWidth = window.innerWidth;
			const newHeight = window.innerHeight;
			const vx = (newWidth - prevWidth) / 2;
			const vy = (newHeight - prevHeight) / 2;

			const sun = window.universe.objects.find(obj => obj.id === window.universe.centerObject.id);
			sun.setVelocity(vx, vy);
			
			window.universe.transformRelativeToCenterObject();
		}

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
		universe.update(dt);
		universe.draw();
		requestAnimationFrame(animate);
	}
	requestAnimationFrame(animate);
};
