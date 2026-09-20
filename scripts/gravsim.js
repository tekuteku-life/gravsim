
// gravsim.js

import { Universe } from './gravsim_universe.js';
import { EventBus } from './gravsim_event_bus.js';
import { presetManager } from './gravsim_preset_manager.js';

window.onload = async function() {
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

	// Fullscreen Bootstrap Loader & Preset Initialization
	const loaderEl = document.getElementById('bootstrap-loader');
	const progressBar = document.getElementById('bootstrap-progress-bar');
	const statusText = document.getElementById('bootstrap-status-text');

	window.presetManager = presetManager;

	try {
		await presetManager.init((progressOrLoaded, totalArg, nameArg) => {
			let loaded = progressOrLoaded;
			let total = totalArg;
			let name = nameArg;
			if (typeof progressOrLoaded === 'object' && progressOrLoaded !== null) {
				loaded = progressOrLoaded.current ?? progressOrLoaded.loaded ?? 0;
				total = progressOrLoaded.total ?? 1;
				name = progressOrLoaded.text ?? progressOrLoaded.name ?? '';
			}
			if (progressBar) {
				const pct = total > 0 ? Math.round((loaded / total) * 100) : 100;
				progressBar.style.width = `${pct}%`;
			}
			if (statusText) {
				const label = String(name || 'INITIALIZING').toUpperCase();
				statusText.textContent = `LOADING ASSETS: ${label} (${loaded}/${total})`;
			}
		});
		if (progressBar) progressBar.style.width = '100%';
		if (statusText) statusText.textContent = 'INITIALIZATION COMPLETE';
	} catch (e) {
		console.warn('[Bootstrap] Error during preset loading, continuing with fallbacks', e);
	}

	window.universe = new Universe(canvas, { presetManager });

	if (loaderEl) {
		setTimeout(() => {
			loaderEl.classList.add('fade-out');
			setTimeout(() => {
				if (loaderEl.parentNode) {
					loaderEl.style.display = 'none';
				}
			}, 600);
		}, 350);
	}

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
