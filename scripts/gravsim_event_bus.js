
// gravsim_event_bus.js

export class EventBus {
	static _listeners = {};
	static _intervals = [];

	static on(eventName, callback) {
		if (!this._listeners[eventName]) {
			this._listeners[eventName] = [];
		}
		this._listeners[eventName].push(callback);
	}

	static off(eventName, callback) {
		if (!this._listeners[eventName]) return;
		this._listeners[eventName] = this._listeners[eventName].filter(cb => cb !== callback);
	}

	static emit(eventName, ...args) {
		if (!this._listeners[eventName]) return;
		for (let i = 0; i < this._listeners[eventName].length; i++) {
			this._listeners[eventName][i](...args);
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
	}
}
