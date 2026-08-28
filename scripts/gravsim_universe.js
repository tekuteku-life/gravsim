
// gravsim_universe.js

import {
	EVENT_PRIORITY, PHYSICS, SIMULATION, OBJECT_STATE,
	OBJECT_TYPES, DEFAULT_OBJECT_PARAMS
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
import { DestructionManager } from './gravsim_destruction_manager.js';
import { VisualEffectManager } from './gravsim_visual_effect_manager.js';
import { EventBus } from './gravsim_event_bus.js';

const GRAVSIM_CALC_JS_FILE = './scripts/gravsim_calc.js';

/*******************************************************************
 * CalcWorkerManager class that manages the calculation worker for physics simulation.
*******************************************************************/
class CalcWorkerManager {
	constructor(onUpdateCallback) {
		this.worker = new Worker(GRAVSIM_CALC_JS_FILE, {type: 'module'});
		this.onUpdateCallback = onUpdateCallback;
		this.worker.onmessage = this.handleMessage.bind(this);
	}

	handleMessage(e) {
		const data = e.data;
		switch(data.cmd) {
		case 'update':
			if (this.onUpdateCallback) {
				this.onUpdateCallback(data);
			}
			break;
		default:
			console.error('Unknown command from worker:', data.cmd);
		}
	}

	postMessage(msg, transferables = []) {
		this.worker.postMessage(msg, transferables);
	}

	setTimeScale(timeScale) {
		this.worker.postMessage({
			cmd: 'setTimeScale',
			timeScale: timeScale
		});
	}

	// New interface for sending commands to a specific rocket in the worker
	sendRocketCommand(rocketId, command) {
		this.worker.postMessage({
			cmd: 'rocketCommand',
			id: rocketId,
			command: command
		});
	}

	destroy() {
		this.worker.terminate();
	}
}

/*******************************************************************
 * Universe Class
*******************************************************************/
export class Universe {
	constructor(_canvas) {
		this.canvas = _canvas;
		this.isPaused = false;
		this.trailLengthAU = 3.0;

		// Initialize Modules
		this.camera = new Camera();
		this.Renderer = new Renderer(_canvas, 'main');
		this.CalcWorkerManager = new CalcWorkerManager((data) => this.updateObjectParams(data));
		this.InputManager = new InputManager(this.canvas);
		this.ObjectManager = new ObjectManager(this.Renderer, this.CalcWorkerManager);
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

		this.timeScale = this.ControlPanel.getTimeScale();

		// Handle Simulation global commands
		EventBus.on('simulation:pause', () => this.pauseSimulation());
		EventBus.on('simulation:resume', () => this.resumeSimulation());
		EventBus.on('simulation:reset', () => this.reset());
		EventBus.on('simulation:clear-objects', (clearD, clearR, clearC) => this.clearObjects(clearD, clearR, clearC));
		EventBus.on('simulation:set-time-scale', (val) => { this.timeScale = val; });

		// Hook for worker command
		EventBus.on('worker:send-rocket-command', (id, cmd) => {
			this.CalcWorkerManager.sendRocketCommand(id, cmd);
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

				// Select lergest object
				if (!nextCenter && this.objects.length > 0) {
					nextCenter = this.objects.reduce((max, obj) => obj.mass > max.mass ? obj : max, this.objects[0]);
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

		// Hook for celestial body rotation update
		EventBus.onUpdate((dt, scaledDt) => {
			this.objects.forEach(obj => {
				if (obj.type === OBJECT_TYPES.CELESTIAL && obj.state === OBJECT_STATE.ACTIVE) {
					const param = DEFAULT_OBJECT_PARAMS[obj.name];
					if (param && param.ROTATION_PERIOD) {
						const omega = (2 * Math.PI) / param.ROTATION_PERIOD;
						obj.rotationAngle = (obj.rotationAngle || 0) + omega * scaledDt;
					}
				}
			});
		}, EVENT_PRIORITY.LOGIC);

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
	// Getters/Setters
	// ------------------------------------------
	get objects() { return this.ObjectManager.objects; }
	
	// Proxy for backward compatibility
	get centerObject() { return this.camera.trackingTarget; }
	get zoomScale() { return Math.pow(10, this.camera.currentZoomExp); }
	
	// ------------------------------------------
	// Delegates
	// ------------------------------------------
	addObject(obj) {
		this.ObjectManager.addObject(obj);
	}
	removeObject(obj) {
		this.ObjectManager.removeObject(obj);
	}
	updateObject(obj) { this.ObjectManager.updateObject(obj); }
	updateObjectParams(data) { this.ObjectManager.updateObjectParams(data); }

	reset() {
		this.ObjectManager.destroy();
		if (this.VisualEffectManager) {
			this.VisualEffectManager.destroy();
		}
		const centerX = this.canvas.width / 2;
		const centerY = this.canvas.height / 2;
		this.ObjectPlacer.placeObject('Sun', centerX, centerY, 0, 0);

		EventBus.emit('camera:set-tracking-target', this.objects[0]);
	}

	destroy() {
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
			if (clearDebris && obj.type === OBJECT_TYPES.DEBRIS) {
				toRemove.push(obj);
			} else if (clearRocket && obj.type === OBJECT_TYPES.ROCKET) {
				toRemove.push(obj);
			} else if (clearCelestial && obj.type === OBJECT_TYPES.CELESTIAL) {
				// Prevent removing the Sun (id:0) to avoid crashing
				if (obj.id !== 0) {
					toRemove.push(obj);
				}
			}
		}
		toRemove.forEach(obj => this.removeObject(obj));
	}

	// Execute registered updaters (Call this method in the main simulation loop)
	updateUI(now) {
		// Detect changes in object count to trigger list updates safely once per frame
		if (this.ObjectManager) {
			const currentCount = this.ObjectManager.objects.length;
			if (this._lastObjCount !== currentCount) {
				EventBus.emit('object-list-changed', currentCount);
				this._lastObjCount = currentCount;
			}
		}
	}

	update(dt) {
		// Time Management
		this.CalcWorkerManager.setTimeScale(this.timeScale);
		let scaledDt = dt * (PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE) * this.timeScale;

		// If paused, halt simulation time (stops rotation, sequences, animations)
		if (this.isPaused) {
			scaledDt = 0;
		}

		// Process decoupled update hooks (Camera, Modules, Flight time, UI, Cleanup)
		EventBus.emitUpdate(dt, scaledDt);
	}

	draw() {
		const renderState = this.camera.getRenderState();

		this.Renderer.draw(this.objects, renderState, this.trailLengthAU);
	}

	getState() {
		return {
			centerObjectId: this.centerObject ? this.centerObject.id : null,
			cameraOffset: this.camera.targetOffset,
			objectManager: this.ObjectManager.getState(),
			rocketLauncher: this.RocketLauncher.getState(),
			controlPanel: this.ControlPanel.getState()
		};
	}

	loadState(state) {
		if (!state) return;

		if (state.objectManager) {
			this.ObjectManager.loadState(state.objectManager);
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
