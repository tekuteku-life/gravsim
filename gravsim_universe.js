
// gravsim_universe.js

import { PHYSICS, SIMULATION, OBJECT_STATE, OBJECT_TYPES } from './gravsim_const.js';
import { Renderer } from './gravsim_renderer.js';
import { InfoPanel } from './gravsim_info_panel.js';
import { TelemetryPanel } from './gravsim_telemetry_panel.js';
import { ControlPanel } from './gravsim_control_panel.js';
import { ObjectManager } from './gravsim_object_manager.js';
import { ObjectPlacer } from './gravsim_object_placer.js';
import { RocketLauncher } from './gravsim_rocket_launcher.js';
import { SaveManager } from './gravsim_save_manager.js';
import { InputManager } from './gravsim_input_manager.js';

const GRAVSIM_CALC_JS_FILE = './gravsim_calc.js';

/*******************************************************************
 * CalcWorkerManager class that manages the calculation worker for physics simulation.
*******************************************************************/
class CalcWorkerManager {
	constructor() {
		this.worker = new Worker(GRAVSIM_CALC_JS_FILE, {type: 'module'});
		this.worker.onmessage = this.handleMessage.bind(this);
	}

	handleMessage(e) {
		const data = e.data;
		switch(data.cmd) {
		case 'update':
			window.universe.updateObjectParams(data);
			break;
		default:
			console.error('Unknown command from worker:', data.cmd);
		}
	}

	postMessage(msg) {
		this.worker.postMessage(msg);
	}

	setTimeScale(timeScale) {
		this.worker.postMessage({
			cmd: 'setTimeScale',
			timeScale: timeScale
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
		this.cameraOffset = { x: 0, y: 0 };

		// Initialize Modules
		this.Renderer = new Renderer(_canvas);
		this.CalcWorkerManager = new CalcWorkerManager();
		this.InputManager = new InputManager(this.canvas);
		this.ObjectManager = new ObjectManager(this.Renderer, this.CalcWorkerManager);

		this.InfoPanel = new InfoPanel();
		this.TelemetryPanel = new TelemetryPanel(this);
		this.ControlPanel = new ControlPanel(this);
		this.ObjectPlacer = new ObjectPlacer(this);
		this.RocketLauncher = new RocketLauncher(this);
		this.SaveManager = new SaveManager(this);

		this.timeScale = this.ControlPanel.getTimeScale();
		
		this.reset();
	}

	// ------------------------------------------
	// Getters/Setters
	// ------------------------------------------
	get objects() { return this.ObjectManager.objects; }
	get centerObject() { return this.ObjectManager.centerObject; }
	set centerObject(obj) {
		this.ObjectManager.centerObject = obj;
		this.cameraOffset = { x: 0, y: 0 }; // Reset offset when camera target changed
		this.ControlPanel.systemTab.updateCenterOptions();
		this.InfoPanel.updateCamera(obj ? obj.name : 'None');
	}
	get zoomScale() { return this.Renderer.zoomScale; }
	
	// ------------------------------------------
	// Delegates
	// ------------------------------------------
	addObject(obj) {
		this.ObjectManager.addObject(obj);
		this.ControlPanel.updateNaviTab();
	}
	removeObject(obj) {
		this.ObjectManager.removeObject(obj);
		this.ControlPanel.updateNaviTab();
	}
	updateObject(obj) { this.ObjectManager.updateObject(obj); }
	updateObjectParams(data) { this.ObjectManager.updateObjectParams(data); }

	pix2au(px) { return this.Renderer.pix2au(px); }
	au2pix(au) { return this.Renderer.au2pix(au); }
	m2pix(m) { return this.Renderer.m2pix(m); }
	pix2m(px) { return this.Renderer.pix2m(px); }

	reset() {
		this.ObjectManager.destroy();
		const centerX = this.canvas.width / 2;
		const centerY = this.canvas.height / 2;
		this.ObjectPlacer.placeObject('Sun', centerX, centerY, 0, 0);
		this.centerObject = this.objects[0];
	}

	updateZoomScale() {
		this.Renderer.setZoomScale(this.ControlPanel.getZoomScale());
	}

	update(dt) {
		// Center Object Check
		const centerStatus = this.ObjectManager.ensureCenterObject(this.cameraOffset);
		if (centerStatus.changed) {
			// By pass setter to keep offset
			this.ObjectManager.centerObject = centerStatus.newCenter;
			this.cameraOffset = centerStatus.newOffset;
			this.ControlPanel.updateCenterOptions();
			this.InfoPanel.updateCamera(this.centerObject ? this.centerObject.name : 'None');
		}

		// Time Management
		this.timeScale = this.ControlPanel.getTimeScale();
		this.CalcWorkerManager.setTimeScale(this.timeScale);
		const scaledDt = dt * (PHYSICS.YEARS_PER_SECOND / SIMULATION.TIME_SCALE) * this.timeScale;

		// Update flight time for rocket
		this.objects.forEach(obj => {
			if (obj.type === OBJECT_TYPES.ROCKET && obj.state === OBJECT_STATE.ACTIVE) {
				obj.flightTime += scaledDt;
			}
		});

		// UI Update
		if (this.objects.length === 1) {
			this.InfoPanel.resetElapsedTime();
		} else {
			this.InfoPanel.updateElapsedTime(scaledDt);
		}
		this.InfoPanel.updateObjectCount(this.objects.length);
		this.InfoPanel.updateFPS();
		
		this.updateZoomScale();
		this.ObjectManager.cleanupObjects();

		this.TelemetryPanel.update();
	}

	draw() {
		this.Renderer.draw(this.objects, this.centerObject, this.cameraOffset);

		this.ctx = this.canvas.getContext('2d');
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
		this.ctx.translate(-this.cameraOffset.x * this.zoomScale, -this.cameraOffset.y * this.zoomScale);
		this.RocketLauncher.drawPreview(this.ctx, this.centerObject, this.zoomScale);
		this.ObjectPlacer.drawPreview(this.ctx, this.centerObject, this.zoomScale);

		this.ctx.restore();

		this.TelemetryPanel.draw();
	}

	getState() {
		return {
			centerObjectId: this.centerObject ? this.centerObject.id : null,
			cameraOffset: this.cameraOffset,
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
			this.cameraOffset = state.cameraOffset;
		} else {
			this.cameraOffset = { x: 0, y: 0 };
		}

		if (state.rocketLauncher) {
			this.RocketLauncher.loadState(state.rocketLauncher);
		}

		if (state.controlPanel) {
			this.ControlPanel.loadState(state.controlPanel, state.rocketLauncher);
		}
	}
}
