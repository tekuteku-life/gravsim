
// gravsim_universe.js

import {
	PHYSICS, SIMULATION, OBJECT_STATE,
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
		this.Renderer = new Renderer(_canvas);
		this.CalcWorkerManager = new CalcWorkerManager((data) => this.updateObjectParams(data));
		this.InputManager = new InputManager(this.canvas);
		this.ObjectManager = new ObjectManager(this.Renderer, this.CalcWorkerManager);
		
		this.OverlayRenderer = new OverlayRenderer(this);
		EventBus.on('draw:overlay', (ctx, rc) => this.OverlayRenderer.drawOverlay(ctx, rc));
		EventBus.on('draw:after', (ctx, rc) => this.OverlayRenderer.drawAfter(ctx, rc));

		this.InfoPanel = new InfoPanel(this);
		this.TelemetryPanel = new TelemetryPanel(this);
		this.RocketLauncher = new RocketLauncher(this);
		this.ControlPanel = new ControlPanel(this);
		this.ObjectPlacer = new ObjectPlacer(this);
		this.LaunchSequencer = new LaunchSequencer(this);
		this.SaveManager = new SaveManager(this);
		this.AudioManager = new AudioManager(this);
		this.SoundSequencer = new SoundSequencer(this);

		this.timeScale = this.ControlPanel.getTimeScale();
		
		// Hook for Camera interpolation
		EventBus.on('simulation:update', (dt, scaledDt) => {
			this.camera.update(dt / 1000); // dt is in ms

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
					this.camera.setTrackingTarget(nextCenter);
					this.ControlPanel.systemTab.updateCenterOptions();
					this.InfoPanel.updateCamera(nextCenter.name);
				}
			}
		});

		// Hook for rocket flight time update
		EventBus.on('simulation:update', (dt, scaledDt) => {
			this.objects.forEach(obj => {
				if (obj.type === OBJECT_TYPES.ROCKET && obj.state === OBJECT_STATE.ACTIVE) {
					obj.flightTime += scaledDt;
				}
			});
		});

		// Hook for celestial body rotation update
		EventBus.on('simulation:update', (dt, scaledDt) => {
			this.objects.forEach(obj => {
				if (obj.type === OBJECT_TYPES.CELESTIAL && obj.state === OBJECT_STATE.ACTIVE) {
					const param = DEFAULT_OBJECT_PARAMS[obj.name];
					if (param && param.ROTATION_PERIOD) {
						const omega = (2 * Math.PI) / param.ROTATION_PERIOD;
						obj.rotationAngle = (obj.rotationAngle || 0) + omega * scaledDt;
					}
				}
			});
		});

		// Hook for UI Updates
		EventBus.on('simulation:update', () => this.updateUI(Date.now()));

		// Hook for Object Cleanup
		EventBus.on('simulation:update', () => this.ObjectManager.cleanupObjects());

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
	set centerObject(obj) {
		this.camera.setTrackingTarget(obj);
		this.ControlPanel.systemTab.updateCenterOptions();
		this.InfoPanel.updateCamera(obj ? obj.name : 'None');
	}
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
		const centerX = this.canvas.width / 2;
		const centerY = this.canvas.height / 2;
		this.ObjectPlacer.placeObject('Sun', centerX, centerY, 0, 0);
		this.centerObject = this.objects[0];
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
		this.timeScale = this.ControlPanel.getTimeScale();
		this.CalcWorkerManager.setTimeScale(this.timeScale);
		let scaledDt = dt * (PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE) * this.timeScale;

		// If paused, halt simulation time (stops rotation, sequences, animations)
		if (this.isPaused) {
			scaledDt = 0;
		}

		// Process decoupled update hooks (Camera, Modules, Flight time, UI, Cleanup)
		EventBus.emit('simulation:update', dt, scaledDt);
	}

	draw() {
		const renderState = this.camera.getRenderState();
		
		this.Renderer.draw(this.objects, renderState, this.trailLengthAU);

		this.ctx = this.canvas.getContext('2d');
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);

		// Apply rotation FIRST, then pan offset
		if (renderState.rotation !== 0) {
			this.ctx.rotate(renderState.rotation);
		}
		this.ctx.translate(-renderState.cameraOffset.x * renderState.zoomScale, -renderState.cameraOffset.y * renderState.zoomScale);

		this.RocketLauncher.drawPreview(this.ctx, renderState.basis, renderState.zoomScale);
		this.ObjectPlacer.drawPreview(this.ctx, renderState.basis, renderState.zoomScale);

		this.ctx.restore();

		this.TelemetryPanel.draw();
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
			this.centerObject = target || (this.objects.length > 0 ? this.objects[0] : null);
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
