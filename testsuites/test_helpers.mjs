/**
 * Common test helper utilities for GravSim test suite
 * Provides shared assertion helpers, debug logging, and mock DOM / Canvas / Audio environment.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const isVerbose = () => {
	return process.env.DEBUG === '1' || process.env.VERBOSE === '1' || process.argv.includes('--verbose');
};

export const logDebug = (...args) => {
	if (isVerbose()) {
		console.log('    [DEBUG]', ...args);
	}
};

/**
 * Asserts that two numbers are approximately equal within a relative or absolute tolerance.
 */
export const assertClose = (actual, expected, tolerance = 1e-4, msg = '') => {
	const diff = Math.abs(actual - expected);
	const maxVal = Math.max(Math.abs(actual), Math.abs(expected), 1.0);
	const relDiff = diff / maxVal;
	const pass = diff <= tolerance || relDiff <= tolerance;
	assert.ok(
		pass,
		`${msg ? msg + ': ' : ''}Expected ${actual} to be close to ${expected} (diff: ${diff.toExponential(4)}, tol: ${tolerance})`
	);
};

/**
 * Creates a standard Falcon 9 multi-stage rocket configuration for tests.
 */
export const createFalcon9Config = () => {
	return {
		name: 'Falcon 9 Test Vehicle',
		totalStages: 2,
		stages: [
			{
				stageNumber: 1,
				dryMassT: 25.0,
				fuelMassT: 140.0,
				oxidMassT: 280.0,
				maxThrustN: 7607000,
				thrustKN: 7607,
				burnTime: 162,
				ispSec: 300,
				separationDelaySec: 1.5,
				ignitionDelaySec: 2.0,
				jettisonSpeedM_S: 18.0,
				radius: 1.85,
				isIgnited: true,
				tankPresFuel: 350,
				tankPresOxid: 350
			},
			{
				stageNumber: 2,
				dryMassT: 4.5,
				fuelMassT: 32.0,
				oxidMassT: 64.0,
				maxThrustN: 981000,
				thrustKN: 981,
				burnTime: 397,
				ispSec: 348,
				separationDelaySec: 1.5,
				ignitionDelaySec: 0,
				jettisonSpeedM_S: 1.5,
				radius: 1.85,
				isIgnited: false,
				tankPresFuel: 350,
				tankPresOxid: 350
			}
		],
		payload: {
			name: 'Dragon Cargo',
			massT: 8.0,
			radius: 1.5
		},
		fairing: {
			enabled: true,
			massT: 1.7,
			separationAltKm: 110,
			isSeparated: false
		}
	};
};

/**
 * Minimal mock element factory for headless browser-less testing
 */
export const createMockElement = (tag = 'div') => {
	const classListSet = new Set();
	const attributes = new Map();
	const eventListeners = new Map();
	const children = [];

	const mockGradient = {
		addColorStop: () => {}
	};

	const element = {
		tagName: tag.toUpperCase(),
		width: 1920,
		height: 1080,
		clientWidth: 1920,
		clientHeight: 1080,
		scrollWidth: 1920,
		scrollHeight: 1080,
		offsetWidth: 1920,
		offsetHeight: 1080,
		scrollLeft: 0,
		scrollTop: 0,
		value: '',
		checked: false,
		textContent: '',
		innerText: '',
		children,
		dataset: {},
		classList: {
			add: (cls) => classListSet.add(cls),
			remove: (cls) => classListSet.delete(cls),
			toggle: (cls, force) => {
				if (force === undefined) {
					if (classListSet.has(cls)) classListSet.delete(cls);
					else classListSet.add(cls);
				} else if (force) {
					classListSet.add(cls);
				} else {
					classListSet.delete(cls);
				}
			},
			contains: (cls) => classListSet.has(cls)
		},
		style: {},
		setAttribute: (k, v) => attributes.set(k, String(v)),
		getAttribute: (k) => attributes.get(k) || null,
		hasAttribute: (k) => attributes.has(k),
		removeAttribute: (k) => attributes.delete(k),
		appendChild: (child) => {
			children.push(child);
			return child;
		},
		removeChild: (child) => {
			const idx = children.indexOf(child);
			if (idx >= 0) children.splice(idx, 1);
			return child;
		},
		addEventListener: (evt, handler) => {
			if (!eventListeners.has(evt)) eventListeners.set(evt, []);
			eventListeners.get(evt).push(handler);
		},
		removeEventListener: (evt, handler) => {
			if (eventListeners.has(evt)) {
				const list = eventListeners.get(evt);
				const idx = list.indexOf(handler);
				if (idx >= 0) list.splice(idx, 1);
			}
		},
		dispatchEvent: (event) => {
			if (event) {
				try {
					if (!event.target) event.target = element;
				} catch (_) {
					Object.defineProperty(event, 'target', { value: element, configurable: true });
				}
			}
			const handlers = eventListeners.get(event?.type || '') || [];
			for (const h of handlers) h(event);
			return true;
		},
		click: () => {
			const handlers = eventListeners.get('click') || [];
			for (const h of handlers) h({ type: 'click', target: element });
		},
		scrollIntoView: () => {},
		closest: () => createMockElement('div'),
		querySelectorAll: (selector) => {
			const res = [];
			const matchClass = selector && selector.startsWith('.') ? selector.slice(1) : null;
			const traverse = (node) => {
				for (const child of (node.children || [])) {
					if (matchClass && (child.classList?.contains(matchClass) || (child.className && child.className.includes(matchClass)))) {
						res.push(child);
					} else if (selector && selector.includes('input') && child.tagName === 'INPUT') {
						res.push(child);
					} else if (selector && selector.includes('tr') && child.tagName === 'TR') {
						res.push(child);
					} else if (selector && child.tagName && child.tagName.toLowerCase() === selector.toLowerCase()) {
						res.push(child);
					}
					traverse(child);
				}
			};
			traverse(element);
			return res;
		},
		querySelector: (selector) => {
			const list = element.querySelectorAll(selector);
			return list.length > 0 ? list[0] : createMockElement('div');
		},
		getContext: () => ({
			canvas: element,
			clearRect: () => {},
			fillRect: () => {},
			strokeRect: () => {},
			beginPath: () => {},
			closePath: () => {},
			stroke: () => {},
			fill: () => {},
			arc: () => {},
			roundRect: () => {},
			ellipse: () => {},
			moveTo: () => {},
			lineTo: () => {},
			quadraticCurveTo: () => {},
			bezierCurveTo: () => {},
			clip: () => {},
			setTransform: () => {},
			transform: () => {},
			scale: () => {},
			translate: () => {},
			rotate: () => {},
			save: () => {},
			restore: () => {},
			measureText: (txt) => ({ width: (txt || '').length * 8 }),
			fillText: () => {},
			strokeText: () => {},
			drawImage: () => {},
			createRadialGradient: () => mockGradient,
			createLinearGradient: () => mockGradient,
			setLineDash: () => {},
			getLineDash: () => []
		})
	};

	let innerHTMLVal = '';
	Object.defineProperty(element, 'innerHTML', {
		get: () => innerHTMLVal,
		set: (val) => {
			innerHTMLVal = val;
			if (val === '') {
				children.length = 0;
			}
		}
	});

	return element;
};

/**
 * Set up comprehensive DOM, Canvas, and Web Audio mocks in pure Node.js environment
 */
export const setupMockDOM = () => {
	if (typeof globalThis.window === 'undefined') {
		globalThis.window = {
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => true,
			getComputedStyle: () => ({ flexDirection: 'row', display: 'block' }),
			innerWidth: 1920,
			innerHeight: 1080,
			requestAnimationFrame: (cb) => setTimeout(cb, 16),
			cancelAnimationFrame: (id) => clearTimeout(id),
			AudioContext: class MockAudioContext {
				constructor() {
					this.state = 'running';
					this.currentTime = 0;
					this.destination = {};
				}
				createGain() {
					return {
						gain: { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
						connect: () => {},
						disconnect: () => {}
					};
				}
				createOscillator() {
					return {
						type: 'sine',
						frequency: { value: 440, setValueAtTime: () => {} },
						connect: () => {},
						start: () => {},
						stop: () => {}
					};
				}
				createBufferSource() {
					return {
						buffer: null,
						loop: false,
						playbackRate: { value: 1.0 },
						connect: () => {},
						start: () => {},
						stop: () => {}
					};
				}
				decodeAudioData(data, success) {
					if (success) success({ duration: 1.0 });
					return Promise.resolve({ duration: 1.0 });
				}
			}
		};
	}

	if (typeof globalThis.requestAnimationFrame === 'undefined') {
		globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
	}
	if (typeof globalThis.cancelAnimationFrame === 'undefined') {
		globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
	}

	if (typeof globalThis.IntersectionObserver === 'undefined') {
		globalThis.IntersectionObserver = class MockIntersectionObserver {
			constructor(callback) {
				this.callback = callback;
				this.targets = [];
			}
			observe(el) {
				this.targets.push(el);
				if (this.callback) {
					try {
						this.callback([{ target: el, isIntersecting: true }]);
					} catch (_) {}
				}
			}
			unobserve(el) {
				this.targets = this.targets.filter(t => t !== el);
			}
			disconnect() {
				this.targets = [];
			}
		};
	}

	globalThis.fetch = async (url) => {
		const urlStr = String(url);
		if (urlStr.includes('presets/')) {
			try {
				const cleanPath = urlStr.replace(/^https?:\/\/[^\/]+\//, '').replace(/^\.\//, '');
				const filePath = path.resolve(process.cwd(), cleanPath);
				if (fs.existsSync(filePath)) {
					const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
					return {
						ok: true,
						status: 200,
						json: async () => data,
						text: async () => JSON.stringify(data)
					};
				}
			} catch (e) {
				// fallback
			}
		}
		if (urlStr.endsWith('manifest.json')) {
			return {
				ok: true,
				json: async () => ['voice_liftoff', 'voice_meco', 'voice_max_q', 'voice_seco']
			};
		}
		// mp3 or other assets
		return {
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(1024),
			json: async () => ({})
		};
	};

	if (typeof globalThis.FileReader === 'undefined') {
		globalThis.FileReader = class MockFileReader {
			constructor() {
				this.onload = null;
				this.onerror = null;
			}
			readAsText(file) {
				const text = file?.content !== undefined ? file.content : JSON.stringify({ version: 2, universe: { objects: [] } });
				if (this.onload) {
					this.onload({ target: { result: text } });
				}
			}
		};
	}

	if (typeof globalThis.confirm === 'undefined') {
		globalThis.confirm = () => true;
	}

	if (typeof globalThis.Worker === 'undefined') {
		globalThis.Worker = class MockWorker {
			constructor() {
				this.onmessage = null;
				this.onerror = null;
			}
			postMessage() {}
			terminate() {}
		};
	}

	if (typeof globalThis.document === 'undefined') {
		const elementRegistry = new Map();
		const docListeners = new Map();

		globalThis.document = {
			getElementById: (id) => {
				if (!elementRegistry.has(id)) {
					const el = createMockElement('div');
					if (id === 'pred-duration') {
						el.setAttribute('min', '0.2');
						el.setAttribute('max', '36');
						el.setAttribute('step', '0.1');
						el.setAttribute('value', '1');
						el.value = '1';
					}
					elementRegistry.set(id, el);
				}
				return elementRegistry.get(id);
			},
			createElement: (tag) => createMockElement(tag),
			querySelectorAll: () => [],
			querySelector: () => createMockElement('div'),
			addEventListener: (type, handler) => {
				if (!docListeners.has(type)) docListeners.set(type, []);
				docListeners.get(type).push(handler);
			},
			removeEventListener: (type, handler) => {
				if (docListeners.has(type)) {
					const list = docListeners.get(type);
					const idx = list.indexOf(handler);
					if (idx >= 0) list.splice(idx, 1);
				}
			},
			dispatchEvent: (event) => {
				const handlers = docListeners.get(event?.type || '') || [];
				for (const h of handlers) h(event);
				return true;
			},
			body: createMockElement('body')
		};
	}

	if (typeof globalThis.localStorage === 'undefined') {
		const store = new Map();
		globalThis.localStorage = {
			getItem: (k) => store.get(k) || null,
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
			clear: () => store.clear()
		};
	}
};

/**
 * Creates a mock CelestialBody object
 */
export const createMockCelestialBody = (overrides = {}) => {
	return {
		id: overrides.id || 1,
		name: overrides.name || 'Earth',
		type: 0, // CELESTIAL_BODY
		x: overrides.x || 0,
		y: overrides.y || 0,
		vx: overrides.vx || 0,
		vy: overrides.vy || 0,
		mass: overrides.mass !== undefined ? overrides.mass : 5.972e24,
		radius: overrides.radius !== undefined ? overrides.radius : 6371000,
		color: overrides.color || '#4477aa',
		fixed: overrides.fixed || false,
		trail: [],
		draw: () => {},
		...overrides
	};
};

/**
 * Creates a mock Rocket object
 */
export const createMockRocket = (overrides = {}) => {
	return {
		id: overrides.id || 101,
		name: overrides.name || 'Falcon 9',
		type: 1, // ROCKET
		state: 0, // ACTIVE
		x: overrides.x || 0,
		y: overrides.y || -6371000,
		vx: overrides.vx || 0,
		vy: overrides.vy || 0,
		mass: overrides.mass !== undefined ? overrides.mass : 550, // t
		radius: overrides.radius !== undefined ? overrides.radius : 20,
		isHoldDown: overrides.isHoldDown !== undefined ? overrides.isHoldDown : true,
		fuelMass: overrides.fuelMass !== undefined ? overrides.fuelMass : 400,
		burnTime: overrides.burnTime !== undefined ? overrides.burnTime : 160,
		thrustForce: overrides.thrustForce !== undefined ? overrides.thrustForce : 7607000,
		thrustRatio: overrides.thrustRatio !== undefined ? overrides.thrustRatio : 1.0,
		draw: () => {},
		trail: [],
		...overrides
	};
};

/**
 * Creates a mock Universe instance with essential submodules
 */
export const createMockUniverse = (overrides = {}) => {
	const objects = overrides.objects || [];
	return {
		objects,
		timeScale: 1,
		isPaused: false,
		canvas: createMockElement('canvas'),
		getState() { return { objects: [] }; },
		loadState(state) {},
		addObject(obj) {
			this.objects.push(obj);
			if (this.ObjectManager) this.ObjectManager.addObject(obj);
		},
		camera: {
			x: 0,
			y: 0,
			zoom: 1,
			trackingTarget: null,
			targetOffset: { x: 0, y: 0 },
			setTargetOffset: (x, y) => {},
			toScreenX: (x) => x,
			toScreenY: (y) => y,
			toWorldX: (x) => x,
			toWorldY: (y) => y,
			getRenderState: () => ({ zoomScale: 1.0, basis: null, cameraOffset: { x: 0, y: 0 }, rotation: 0 }),
			...(overrides.camera || {})
		},
		RocketLauncher: {
			flightProfile: [{ type: 'alt', value: 0, thrust: 100, angle: 0 }],
			stages: [{ stageNumber: 1, fuelType: 'liquid', fuelMassT: 100, oxidMassT: 200, thrustKN: 5000, ispSec: 300, dryMassT: 20 }],
			payload: { name: 'Payload', massT: 5 },
			fairing: { enabled: true, massT: 1 },
			mode: 'host',
			currentPresetId: 'FALCON9',
			rollout: () => {},
			ignite: () => {},
			abortRollout: () => {},
			requestPreviewUpdate: () => {},
			setRolloutMode: () => {},
			togglePreview: () => {},
			drawPreview: () => {},
			...(overrides.RocketLauncher || {})
		},
		LaunchSequencer: {
			isActive: false,
			timer: 0,
			tMinusOffset: 0,
			start: () => {},
			abort: () => {},
			...(overrides.LaunchSequencer || {})
		},
		workerManager: {
			postMessage: () => {}
		},
		physicsWorker: {
			postMessage: () => {}
		},
		ObjectPlacer: {
			placeObject: (name, x, y, vx, vy, optParams) => {
				const r = createMockRocket({ id: 999, ...(optParams || {}), x: x || 0, y: y || 0, vx: vx || 0, vy: vy || 0 });
				objects.push(r);
				return r;
			}
		},
		ObjectManager: {
			removeObject: (obj) => {
				const idx = objects.indexOf(obj);
				if (idx >= 0) objects.splice(idx, 1);
			},
			addObject: (obj) => { objects.push(obj); },
			getNextId: () => Math.floor(Math.random() * 100000) + 1,
			updateObject: (obj) => {}
		},
		renderer: {
			render: () => {}
		},
		ControlPanel: {
			rocketTab: {
				setRolloutState: () => {},
				updateThrustGauge: () => {}
			},
			systemTab: {
				updateCenterOptions: () => {},
				getTimeScale: () => 1
			},
			naviTab: {
				updateCenterOptions: () => {}
			}
		},
		InfoPanel: {
			updateCamera: () => {}
		},
		TelemetryPanel: {
			open: () => {},
			close: () => {},
			targetId: null
		},
		...(overrides || {})
	};
};

