
// gravsim_event_bus.js

export class EventBus {
	static _listeners = {};
	static _intervals = [];

	static _updateListeners = [];
	static _drawBeforeListeners = [];
	static _drawAfterListeners = [];
	static _drawOverlayListeners = [];

	static on(eventName, callback, priority = 0) {
		if (!this._listeners[eventName]) {
			this._listeners[eventName] = [];
		}
		this._listeners[eventName].push({ callback, priority });
		this._listeners[eventName].sort((a, b) => a.priority - b.priority);
	}

	static off(eventName, callback) {
		if (!this._listeners[eventName]) return;
		this._listeners[eventName] = this._listeners[eventName].filter(cb => cb.callback !== callback);
	}

	static emit(eventName, ...args) {
		if (!this._listeners[eventName]) return;
		for (let i = 0; i < this._listeners[eventName].length; i++) {
			this._listeners[eventName][i].callback(...args);
		}
	}

	// -----------------------------
	// Fast-paths for lifecycles
	// -----------------------------

	static onUpdate(callback, priority = 0) {
		this._updateListeners.push({ callback, priority });
		this._updateListeners.sort((a, b) => a.priority - b.priority);
	}

	static emitUpdate(dt, scaledDt) {
		for (let i = 0; i < this._updateListeners.length; i++) {
			this._updateListeners[i].callback(dt, scaledDt);
		}
	}

	static onDrawBefore(callback, priority = 0) {
		this._drawBeforeListeners.push({ callback, priority });
		this._drawBeforeListeners.sort((a, b) => a.priority - b.priority);
	}

	static emitDrawBefore(ctx, renderContext) {
		for (let i = 0; i < this._drawBeforeListeners.length; i++) {
			this._drawBeforeListeners[i].callback(ctx, renderContext);
		}
	}

	static onDrawAfter(callback, priority = 0) {
		this._drawAfterListeners.push({ callback, priority });
		this._drawAfterListeners.sort((a, b) => a.priority - b.priority);
	}

	static emitDrawAfter(ctx, renderContext) {
		for (let i = 0; i < this._drawAfterListeners.length; i++) {
			this._drawAfterListeners[i].callback(ctx, renderContext);
		}
	}

	static onDrawOverlay(callback, priority = 0) {
		this._drawOverlayListeners.push({ callback, priority });
		this._drawOverlayListeners.sort((a, b) => a.priority - b.priority);
	}

	static emitDrawOverlay(ctx, renderContext) {
		for (let i = 0; i < this._drawOverlayListeners.length; i++) {
			this._drawOverlayListeners[i].callback(ctx, renderContext);
		}
	}

	static registerInterval(intervalMs, callback) {
		this._intervals.push({
			interval: intervalMs,
			callback: callback,
			lastTime: 0
		});
	}

	static tickIntervals(now) {
		for (let i = 0; i < this._intervals.length; i++) {
			const updater = this._intervals[i];
			if (now - updater.lastTime >= updater.interval) {
				updater.callback();
				updater.lastTime = now;
			}
		}
	}

	static clearAll() {
		this._listeners = {};
		this._intervals = [];
		this._updateListeners = [];
		this._drawBeforeListeners = [];
		this._drawAfterListeners = [];
		this._drawOverlayListeners = [];
	}
}
