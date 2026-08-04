
// gravsim_universe.js

import {
	YEARS_PER_SECOND, TIME_SCALE,
	UI_DOUBLE_TAP_DURATION,
} from './gravsim_const.js';
import { Renderer } from './gravsim_renderer.js';
import { InfoPanel } from './gravsim_info_panel.js';
import { TelemetryPanel } from './gravsim_telemetry_panel.js';
import { ControlPanel } from './gravsim_control_panel.js';
import { ObjectManager } from './gravsim_object_manager.js';
import { ObjectPlacer } from './gravsim_object_placer.js';
import { RocketLauncher } from './gravsim_rocket_launcher.js';

const GRAVSIM_CALC_JS_FILE = './gravsim_calc.js';

/*******************************************************************
 * CalcWorkerManager class that manages the calculation worker for physics simulation.
 * @property {Worker} worker - The Web Worker instance for handling calculations.
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
		
		// Initialize Modules
		this.Renderer = new Renderer(_canvas);
		this.CalcWorkerManager = new CalcWorkerManager();
		this.ObjectManager = new ObjectManager(this.Renderer, this.CalcWorkerManager);
		
		this.InfoPanel = new InfoPanel();
		this.TelemetryPanel = new TelemetryPanel(this);
		this.ControlPanel = new ControlPanel(this);
		this.ObjectPlacer = new ObjectPlacer(this);
		this.RocketLauncher = new RocketLauncher(this);

		this.timeScale = this.ControlPanel.getTimeScale();
		
		this._initInput();
		this.reset();
	}

	// ------------------------------------------
	// Getters/Setters
	// ------------------------------------------
	get objects() { return this.ObjectManager.objects; }
	get centerObject() { return this.ObjectManager.centerObject; }
	set centerObject(obj) { this.ObjectManager.centerObject = obj; }
	get zoomScale() { return this.Renderer.zoomScale; }
	
	// ------------------------------------------
	// Delegates
	// ------------------------------------------
	addObject(obj) { this.ObjectManager.addObject(obj); }
	removeObject(obj) { this.ObjectManager.removeObject(obj); }
	updateObject(obj) { this.ObjectManager.updateObject(obj); }
	updateObjectParams(data) { this.ObjectManager.updateObjectParams(data); }

	pix2au(px) { return this.Renderer.pix2au(px); }
	au2pix(au) { return this.Renderer.au2pix(au); }
	m2pix(m) { return this.Renderer.m2pix(m); }
	pix2m(px) { return this.Renderer.pix2m(px); }

	// ------------------------------------------
	// Core Loop & Control
	// ------------------------------------------
	_initInput() {
		// Reset for PC
		this.canvas.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.reset();
		});

		// Reset for smart phone (double tap with 2 fingers)
		let lastTwoFingerTapTime = 0;
		this.canvas.addEventListener('touchstart', (e) => {
			if (e.touches && e.touches.length === 2) {
				const now = Date.now();

				if (now - lastTwoFingerTapTime < UI_DOUBLE_TAP_DURATION) {
					e.preventDefault();
					this.reset();
					lastTwoFingerTapTime = 0; 
				} else {
					lastTwoFingerTapTime = now;
				}
			}
		}, { passive: false });
	}

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
		const centerChanged = this.ObjectManager.ensureCenterObject();
		if (centerChanged) {
			this.ControlPanel.updateCenterOptions();
		}

		// Time Management
		this.timeScale = this.ControlPanel.getTimeScale();
		this.CalcWorkerManager.setTimeScale(this.timeScale);
		const scaledDt = dt * (YEARS_PER_SECOND / TIME_SCALE) * this.timeScale;

		// UI Update
		if (this.objects.length === 1) {
			this.InfoPanel.resetElapsedTime();
		} else {
			this.InfoPanel.updateElapsedTime(scaledDt);
		}
		this.InfoPanel.updateObjectCount(this.objects.length);
		this.InfoPanel.updateFPS();

		// Object Update
		this.objects.forEach(obj => obj.updateHistory());
		
		this.updateZoomScale();
		this.ObjectManager.cleanupObjects();

		this.TelemetryPanel.update();
	}

	draw() {
		this.Renderer.draw(this.objects, this.centerObject);

		this.ctx = this.canvas.getContext('2d');
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
		this.ctx.scale(this.zoomScale, this.zoomScale);
		this.RocketLauncher.drawPreview(this.ctx, this.centerObject, 1 / this.zoomScale);
		this.ctx.restore();
	}
}
