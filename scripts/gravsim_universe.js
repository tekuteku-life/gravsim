
// gravsim_universe.js

import {
	EVENT_PRIORITY, PHYSICS, SIMULATION, OBJECT_STATE,
	OBJECT_TYPES
} from './gravsim_const.js';
import { Camera } from './gravsim_camera.js';
import { Renderer } from './gravsim_renderer.js';
import { OverlayRenderer } from './gravsim_overlay_renderer.js';
import { InfoPanel } from './gravsim_info_panel.js';
import { TelemetryPanel } from './gravsim_telemetry_panel.js';
import { ControlPanel } from './gravsim_control_panel.js';
import { ObjectManager } from './gravsim_object_manager.js';
import { ObjectPlacer } from './gravsim_object_placer.js';
import { RocketLauncher } from './gravsim_rocket_launcher.js';
import { LaunchSequencer } from './gravsim_launch_sequencer.js';
import { SaveManager } from './gravsim_save_manager.js';
import { InputManager } from './gravsim_input_manager.js';
import { AudioManager } from './gravsim_audio_manager.js';
import { SoundSequencer } from './gravsim_sound_sequencer.js';
import { SoundEffects } from './gravsim_sound_effects.js';
import { DestructionManager } from './gravsim_destruction_manager.js';
import { VisualEffectManager } from './gravsim_visual_effect_manager.js';
import { presetManager } from './gravsim_preset_manager.js';
import { EventBus } from './gravsim_event_bus.js';
import { isLiveObject } from './gravsim_utils.js';

const GRAVSIM_CALC_JS_FILE = `./scripts/gravsim_calc.js?v=${Date.now()}`;

/*******************************************************************
 * CalcWorkerManager class that manages the calculation worker for physics simulation.
 *******************************************************************/
class CalcWorkerManager {
	constructor(onUpdateCallback) {
		this.worker = new Worker(GRAVSIM_CALC_JS_FILE, {type: 'module'});
		this.onUpdateCallback = onUpdateCallback;
		this.worker.onmessage = this.handleMessage.bind(this);
		/** @type {Map<number, { resolve: (rockets: any[] | null) => void, timer: any }>} */
		this._runtimeRequests = new Map();
		this._nextRuntimeRequestId = 1;
	}

	handleMessage(e) {
		const data = e.data;
		switch(data.cmd) {
		case 'update':
			if (this.onUpdateCallback) {
				this.onUpdateCallback(data);
			}
			break;
		case 'runtimeSnapshot': {
			const pending = this._runtimeRequests.get(data.requestId);
			if (pending) {
				this._runtimeRequests.delete(data.requestId);
				clearTimeout(pending.timer);
				pending.resolve(Array.isArray(data.rockets) ? data.rockets : []);
			}
			break;
		}
		default:
			console.error('Unknown command from worker:', data.cmd);
		}
	}

	postMessage(msg, transferables = []) {
		this.worker.postMessage(msg, transferables);
	}

	setTimeScale(timeScale) {
		this.worker.postMessage({ cmd: 'setTimeScale', timeScale: timeScale });
	}

	sendRocketCommand(rocketId, command) {
		this.worker.postMessage({ cmd: 'rocketCommand', id: rocketId, command: command });
	}

	/**
	 * Ask the Worker for the runtime state of every live rocket. Because Worker messages are
	 * delivered in order and 'update' buffers are applied synchronously on receipt, the reply is
	 * consistent with the kinematic state already applied on the main thread.
	 * Resolves to null when the Worker does not answer within the timeout.
	 * @param {number} [timeoutMs]
	 * @returns {Promise<any[] | null>}
	 */
	requestRuntimeSnapshot(timeoutMs = SIMULATION.RUNTIME_SNAPSHOT_TIMEOUT_MS) {
		const requestId = this._nextRuntimeRequestId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this._runtimeRequests.delete(requestId);
				resolve(null);
			}, timeoutMs);
			this._runtimeRequests.set(requestId, { resolve, timer });
			this.worker.postMessage({ cmd: 'snapshotRuntime', requestId });
		});
	}

	destroy() {
		for (const pending of this._runtimeRequests.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this._runtimeRequests.clear();
		this.worker.terminate();
	}
}

/*******************************************************************
 * Universe Class
 *******************************************************************/
export class Universe {
	constructor(_canvas, options = {}) {
		this.canvas = _canvas;
		this.isPaused = false;
		this.trailLengthAU = 3.0; // AU
		this.presetManager = options.presetManager || (typeof window !== 'undefined' && window.presetManager) || presetManager;

		// Initialize Modules
		this.camera = new Camera();
		this.Renderer = new Renderer(_canvas, 'main');
		this.CalcWorkerManager = new CalcWorkerManager((data) => this.updateObjectParams(data));
		this.CalcWorkerManager.postMessage({
			cmd: 'initDefinitions',
			celestialParams: this.getObjectParamsMap()
		});
		this.InputManager = new InputManager(this.canvas);
		this.ObjectManager = new ObjectManager(this.Renderer, this.CalcWorkerManager);
		this.ObjectManager.universe = this;
		this.DestructionManager = new DestructionManager(this);
		this.VisualEffectManager = new VisualEffectManager(this);
		this.OverlayRenderer = new OverlayRenderer(this);
		this.InfoPanel = new InfoPanel(this);
		this.TelemetryPanel = new TelemetryPanel(this);
		this.RocketLauncher = new RocketLauncher(this);
		this.ControlPanel = new ControlPanel(this);
		this.ObjectPlacer = new ObjectPlacer(this);
		this.LaunchSequencer = new LaunchSequencer();
		this.SaveManager = new SaveManager(this);
		this.AudioManager = new AudioManager(this);
		this.SoundSequencer = new SoundSequencer(this);
		this.SoundEffects = new SoundEffects(this);

		this.timeScale = this.ControlPanel.getTimeScale();
		this.showPredictedTrajectory = true;
		this.showActualFlightPath = true;

		// Handle Simulation global commands
		EventBus.on('simulation:pause', () => this.pauseSimulation());
		EventBus.on('simulation:resume', () => this.resumeSimulation());
		EventBus.on('simulation:reset', () => this.reset());
		EventBus.on('simulation:clear-objects', (clearD, clearR, clearC) => this.clearObjects(clearD, clearR, clearC));
		EventBus.on('simulation:set-time-scale', (val) => { this.timeScale = val; });

		// Handle Trajectory Visibility toggles
		EventBus.on('render:set-show-predicted-path', (visible) => {
			this.showPredictedTrajectory = visible;
		});
		EventBus.on('render:set-show-actual-path', (visible) => {
			this.showActualFlightPath = visible;
		});

		// Hook for worker command
		EventBus.on('worker:send-rocket-command', (id, cmd) => {
			this.CalcWorkerManager.sendRocketCommand(id, cmd);
		});

		EventBus.on('debug:toggle-profiler', (isEnabled) => {
			this.CalcWorkerManager.postMessage({ cmd: 'toggleProfiler', value: isEnabled });
		});

		// Hook for Camera interpolation
		EventBus.onUpdate((dt, scaledDt) => {
			this.camera.update(dt / 1000); // dt is in ms

			// Fallback ensureCenterObject logic (if target dies)
			const currentTarget = this.camera.trackingTarget;
			if (currentTarget && currentTarget.state !== OBJECT_STATE.ACTIVE) {
				const oldCenter = currentTarget;
				let nextCenter = null;

				// Tracking debris
				const debrisName = oldCenter.name.endsWith(' Debris') ? oldCenter.name : `${oldCenter.name} Debris`;
				const debrisList = this.objects.filter(o => o.name === debrisName && o.state === OBJECT_STATE.ACTIVE);
				if (debrisList.length > 0) {
					nextCenter = debrisList.reduce((max, obj) => obj.mass > max.mass ? obj : max, debrisList[0]);
				}

				// If dying object was a rocket with a host, track the host celestial body rather than the world center (the
				// Sun of Reset; earlier "id !== 0", which after a Reset no longer named it, design §4.13-27)
				if (!nextCenter && oldCenter.type === OBJECT_TYPES.ROCKET) {
					const hostId = oldCenter.hostId ?? this.RocketLauncher?.hostId;
					if (hostId !== null && hostId !== undefined) {
						nextCenter = this.objects.find(o => o.id === hostId && o.state === OBJECT_STATE.ACTIVE);
					}
					if (!nextCenter) {
						nextCenter = this.objects.find(o => o.name === 'Earth' && o.state === OBJECT_STATE.ACTIVE)
							|| this.objects.find(o => o.type === OBJECT_TYPES.CELESTIAL && !o.isWorldCenter && o.state === OBJECT_STATE.ACTIVE);
					}
				}

				// Select the largest object still in the simulation (as ultimate fallback). Earlier any listed object: a removed
				// one fading out could be chosen, which this fallback left again at the next update, and so on until it was
				// cleaned up (design §4.13-31)
				const objects = this.objects.filter(o => isLiveObject(o));
				if (!nextCenter && objects.length > 0) {
					nextCenter = objects.reduce((max, obj) => obj.mass > max.mass ? obj : max, objects[0]);
				}

				if (nextCenter) {
					EventBus.emit('camera:set-tracking-target', nextCenter);
				}
			}
		}, EVENT_PRIORITY.CAMERA);

		// Hook for rocket flight time update
		EventBus.onUpdate((dt, scaledDt) => {
			this.objects.forEach(obj => {
				if (obj.type === OBJECT_TYPES.ROCKET && obj.state === OBJECT_STATE.ACTIVE) {
					obj.flightTime += scaledDt;
				}
			});
		}, EVENT_PRIORITY.LOGIC);

		// Celestial body rotation is integrated deterministically inside PhysicsEngine._moveObjects(dt)
		// and synchronized via WorkerBridge BUFFER_INDEX.ROTATION_ANGLE.

		// Hook for UI Updates
		EventBus.onUpdate(() => this.updateUI(Date.now()), EVENT_PRIORITY.UI);

		// Hook for Object Cleanup
		EventBus.onUpdate(() => this.ObjectManager.cleanupObjects(), EVENT_PRIORITY.CLEANUP);

		// Hook for Core Application
		EventBus.on('app:update', (dt) => this.update(dt));
		EventBus.on('app:draw', () => this.draw());

		this.reset();
	}

	// ------------------------------------------
	// Definition and Preset Distribution
	// ------------------------------------------
	getObjectParams(name) {
		return this.presetManager.getObjectParam(name);
	}

	getObjectParamsMap() {
		return this.presetManager.getObjectParamsMap();
	}

	getLegacyPreset(presetKey) {
		return this.presetManager.getLegacyPreset(presetKey);
	}

	// ------------------------------------------
	// Getters/Setters
	// ------------------------------------------
	get objects() { return this.ObjectManager.objects; }

	// Proxy for backward compatibility
	get centerObject() { return this.camera.trackingTarget; }
	get zoomScale() { return Math.pow(10, this.camera.currentZoomExp); }

	// ------------------------------------------
	// Delegates
	// ------------------------------------------
	addObject(obj) { this.ObjectManager.addObject(obj); }
	removeObject(obj) { this.ObjectManager.removeObject(obj); }
	updateObject(obj) { this.ObjectManager.updateObject(obj); }
	updateObjectParams(data) {
		this.ObjectManager.updateObjectParams(data);

		// Measure Physics Worker FPS and propagate subSteps
		this.currentSubSteps = data.subSteps || 0;
		EventBus.emit('physics-updated', data.subSteps);
	}

	reset() {
		this.ObjectManager.destroy();
		if (this.VisualEffectManager) {
			this.VisualEffectManager.destroy();
		}

		const centerX = this.canvas.width / 2; // px
		const centerY = this.canvas.height / 2; // px

		this.ObjectPlacer.placeObject('Sun', centerX, centerY, 0, 0);

		EventBus.emit('camera:set-tracking-target', this.objects[0]);
	}

	destroy() {
		if (this.SoundEffects) {
			this.SoundEffects.destroy();
		}
		EventBus.clearAll();
	}

	// Send pause command to worker
	pauseSimulation() {
		if (!this.isPaused) {
			this.isPaused = true;
			this.CalcWorkerManager.postMessage({ cmd: 'pause', value: true });
		}
	}

	// Send resume command to worker
	resumeSimulation() {
		// Prevent resuming if globally paused by user
		if (this.isPaused) {
			this.isPaused = false;
			this.CalcWorkerManager.postMessage({ cmd: 'pause', value: false });
		}
	}

	clearObjects(clearDebris, clearRocket, clearCelestial) {
		const toRemove = [];
		for (const obj of this.objects) {
			// Objects already removed (fading out) were removed then
			if (!isLiveObject(obj)) { continue; }
			if (clearDebris && obj.type === OBJECT_TYPES.DEBRIS) {
				toRemove.push(obj);
			} else if (clearRocket && obj.type === OBJECT_TYPES.ROCKET) {
				toRemove.push(obj);
			} else if (clearCelestial && obj.type === OBJECT_TYPES.CELESTIAL) {
				// Keep the world center (the Sun of Reset, or the star a generator made of it). Earlier "id !== 0": after a
				// Reset the new Sun has another id, so it was removed too (design §4.13-27)
				if (!obj.isWorldCenter) {
					toRemove.push(obj);
				}
			}
		}
		toRemove.forEach(obj => this.removeObject(obj));

		// If current camera target was removed, switch to a remaining active object or null
		if (this.camera.trackingTarget && toRemove.includes(this.camera.trackingTarget)) {
			const remaining = this.objects.find(o => o.state === OBJECT_STATE.ACTIVE && !toRemove.includes(o));
			EventBus.emit('camera:set-tracking-target', remaining || null);
		}
	}

	// Execute registered updaters (Call this method in the main simulation loop)
	updateUI(now) {
		// Detect changes in object count to trigger list updates safely once per frame. The count is that of the objects
		// in the simulation, and the lists are rebuilt when it changes (an object removed or destroyed) and when an object
		// that was fading out leaves the list; earlier only the second, so removed objects stayed in the lists and the
		// count until their trails had faded (design §4.13-31)
		if (this.ObjectManager) {
			const listedCount = this.ObjectManager.objects.length;
			const liveCount = this.ObjectManager.countLive();
			if (this._lastObjCount !== liveCount || this._lastListedCount !== listedCount) {
				EventBus.emit('object-list-changed', liveCount);
				this._lastObjCount = liveCount;
				this._lastListedCount = listedCount;
			}
		}
	}

	update(dt) {
		EventBus.emit('profile:start', 'Universe.update');

		// Time Management
		this.CalcWorkerManager.setTimeScale(this.timeScale);
		let scaledDt = dt * (PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE) * this.timeScale; // s

		// If paused, halt simulation time (stops rotation, sequences, animations)
		if (this.isPaused) {
			scaledDt = 0;
		}

		// Process decoupled update hooks (Camera, Modules, Flight time, UI, Cleanup)
		EventBus.emitUpdate(dt, scaledDt);

		EventBus.emit('profile:end', 'Universe.update');
	}

	draw() {
		EventBus.emit('profile:start', 'Universe.draw');

		const renderState = this.camera.getRenderState();
		renderState.showPredictedTrajectory = this.showPredictedTrajectory;
		renderState.showActualFlightPath = this.showActualFlightPath;
		this.Renderer.draw(this.objects, renderState, this.trailLengthAU);

		EventBus.emit('profile:end', 'Universe.draw');
	}

	/**
	 * Collect Worker-only rocket runtime state for persistence.
	 * @returns {Promise<Map<number, any> | null>} id -> runtimeState, or null if unavailable
	 */
	async captureRuntimeSnapshot() {
		const rockets = await this.CalcWorkerManager.requestRuntimeSnapshot();
		if (!rockets) { return null; }
		const snapshot = new Map();
		for (const entry of rockets) {
			if (entry && entry.id !== undefined && entry.runtimeState) {
				snapshot.set(entry.id, entry.runtimeState);
			}
		}
		return snapshot;
	}

	/** @param {Map<number, any> | null} [runtimeSnapshot] */
	getState(runtimeSnapshot = null) {
		return {
			centerObjectId: this.centerObject ? this.centerObject.id : null,
			cameraOffset: this.camera.targetOffset,
			objectManager: this.ObjectManager.getState(runtimeSnapshot),
			rocketLauncher: this.RocketLauncher.getState(),
			controlPanel: this.ControlPanel.getState()
		};
	}

	loadState(state) {
		if (!state) return;

		if (state.objectManager) {
			this.ObjectManager.loadState(state.objectManager);
			// The loaded flight continues at its saved MET: the callouts it has passed are not voiced again (design §4.14-6)
			if (this.SoundSequencer) { this.SoundSequencer.resyncAfterLoad(); }
		}

		if (state.centerObjectId !== undefined && state.centerObjectId !== null) {
			const target = this.objects.find(o => o.id === state.centerObjectId);
			const tgt = target || (this.objects.length > 0 ? this.objects[0] : null);
			EventBus.emit('camera:set-tracking-target', tgt);
		}

		if (state.cameraOffset) {
			this.camera.setTargetOffset(state.cameraOffset.x, state.cameraOffset.y);
			this.camera.currentOffset = { ...state.cameraOffset }; // Apply instantly on load
		}

		if (state.rocketLauncher) {
			this.RocketLauncher.loadState(state.rocketLauncher);
		}

		if (state.controlPanel) {
			this.ControlPanel.loadState(state.controlPanel, state.rocketLauncher);
		}
	}
}
