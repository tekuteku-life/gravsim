
// gravsim_profiler.js

import { EventBus } from './gravsim_event_bus.js';

/*******************************************************************
 * Main Profiler for Performance Tuning
 *******************************************************************/
export class MainProfiler {
	constructor() {
		this.metrics = {}; // ms
		this.startTimes = {}; // ms
		this.frames = 0; // count

		this._onStart = this.start.bind(this);
		this._onEnd = this.end.bind(this);
		this._onFrame = this.frame.bind(this);

		EventBus.on('profile:start', this._onStart);
		EventBus.on('profile:end', this._onEnd);

		// Run after all draws are complete
		EventBus.on('app:draw', this._onFrame, 999);
	}

	destroy() {
		EventBus.off('profile:start', this._onStart);
		EventBus.off('profile:end', this._onEnd);
		EventBus.off('app:draw', this._onFrame);
	}

	start(key) {
		this.startTimes[key] = performance.now();
	}

	end(key) {
		if (this.startTimes[key] !== undefined) {
			const elapsed = performance.now() - this.startTimes[key]; // ms
			this.metrics[key] = (this.metrics[key] || 0) + elapsed;
		}
	}

	frame() {
		this.frames++;
		if (this.frames >= 60) {
			console.log("=== Main Thread Profile (ms/frame) ===");
			let totalMs = 0; // ms
			for (const key in this.metrics) {
				const avgMs = this.metrics[key] / 60; // ms
				totalMs += avgMs;
				console.log(` - ${key.padEnd(25)}: ${avgMs.toFixed(2)} ms`);
			}
			console.log(` - ${"TOTAL TRACKED".padEnd(25)}: ${totalMs.toFixed(2)} ms`);
			console.log("======================================");

			this.metrics = {};
			this.frames = 0;
		}
	}
}

/*******************************************************************
 * Worker Profiler for Performance Tuning
 *******************************************************************/
export class WorkerProfiler {
	constructor() {
		this.enabled = false;
		this.metrics = {
			QuadTreeAndCollisions: 0,
			Integration: 0,
			BufferFormat: 0,
			PostMessage: 0,
			TotalUpdate: 0
		};
		this.totalSubSteps = 0;
		this.frames = 0;
	}

	recordSubSteps(count) {
		if (!this.enabled) { return; }
		this.totalSubSteps += count;
	}

	start() {
		if (!this.enabled) { return 0; }
		return performance.now();
	}

	end(key, startMs) {
		if (!this.enabled) { return; }
		this.metrics[key] += (performance.now() - startMs);
	}

	report() {
		if (!this.enabled) { return; }

		this.frames++;
		if (this.frames >= 60) {
			console.log("=== Worker Physics Profile (ms/frame) ===");
			for (const key in this.metrics) {
				if (key !== 'TotalUpdate') {
					const avgMs = this.metrics[key] / 60;
					console.log(` - ${key.padEnd(25)}: ${avgMs.toFixed(2)} ms`);
				}
			}
			console.log(` - ${"TOTAL UPDATE".padEnd(25)}: ${(this.metrics.TotalUpdate / 60).toFixed(2)} ms`);
			console.log(` - ${"AVG SUB-STEPS".padEnd(25)}: ${(this.totalSubSteps / 60).toFixed(1)} steps/frame`);
			console.log("=========================================");

			for (const key in this.metrics) {
				this.metrics[key] = 0;
			}
			this.totalSubSteps = 0;
			this.frames = 0;
		}
	}
}
