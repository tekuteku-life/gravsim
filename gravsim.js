
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

			const dx = (newWidth - prevWidth) / 2;
			const dy = (newHeight - prevHeight) / 2;

			window.universe.CalcWorkerManager.postMessage({ cmd: 'pause', value: true });
			window.universe.ignoreUpdatesUntil = Date.now() + 100;

			for (const obj of window.universe.objects) {
				obj.shiftPosition(dx, dy);
			}

			window.universe.CalcWorkerManager.postMessage({
				cmd: 'shiftPosition',
				dx: window.universe.pix2m(dx),
				dy: window.universe.pix2m(dy)
			});
			
			window.universe.CalcWorkerManager.postMessage({ cmd: 'pause', value: false });
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
