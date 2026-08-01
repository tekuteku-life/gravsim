
// gravsim_universe.js

import {
	METERS_PER_AU, YEARS_PER_SECOND, G,
	TIME_SCALE, THROW_SCALE, REMOVE_DISTANCE_AU, 
	UI_DOUBLE_TAP_DUARATION,
	HISTORY_LENGTH, DEBRIS_MIN_FRAG,
	DEBRIS_MAX_GENERATION, DEBRIS_FRAG_DECAY_RATE,
	OBJECT_STATE, DEFAULT_OBJECT_PARAMS
} from './gravsim_const.js';
import { Renderer } from './gravsim_renderer.js';
import { InfoPanel } from './gravsim_info_panel.js';
import { ControlPanel } from './gravsim_control_panel.js';
import { GravSimObject } from './gravsim_object.js';
import { ObjectManager } from './gravsim_object_manager.js';

const GRAVSIM_CALC_JS_FILE = './gravsim_calc.js';

function AU2M(au) {
	return au * METERS_PER_AU;
}
function M2AU(m) {
	return m / METERS_PER_AU;
}

/*******************************************************************
 * ObjectPlacer class that manages the placement of objects in the universe.
 * @property {Universe} universe - The universe instance where objects are placed.
*******************************************************************/
class ObjectPlacer {
	constructor(universe) {
		this.universe = universe;
		this.isDragging = false;
		this.wasMultiTouch = false;
	
		universe.canvas.addEventListener('mousedown', this.setReadyForLaunch.bind(this));
		universe.canvas.addEventListener('touchstart', this.setReadyForLaunch.bind(this));
		universe.canvas.addEventListener('mouseup', this.goLaunch.bind(this));
		universe.canvas.addEventListener('touchend', this.goLaunch.bind(this));
	}

	placeObject(objName, x, y, vx = 0, vy = 0) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];
		const obj = new GravSimObject(
			param.NAME,
			x, y,
			vx, vy,
			param.MASS,
			param.COLOR,
			Math.log10((param.RADIUS || 1)*8)/2.5,
			param.RADIUS || 1,
			0,
			param.BORDER_COLOR || null,
			param.BORDER_WIDTH || 0
		);
		this.universe.addObject(obj);
		return obj;
	}

	placeAtOrbit(objName, hostObj) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];
		
		// Get A/E (circular orbit by default)
		const a_au = param.A || 1;
		const e = param.E || 0;
		const a_m = AU2M(a_au);
		const r_p_m = a_m * (1 - e); // perihelion distance (m)
		
		// Calculate velocity at perihelion by using Vis-viva equation
		const totalMassKg = (hostObj.mass + param.MASS) * 1e3;
		const v_p_m = Math.sqrt(G * totalMassKg * (2 / r_p_m - 1 / a_m));

		const perihelionDeg = param.PERIHELION_DEG || 0;
		const theta = perihelionDeg * (Math.PI / 180);
		
		const r_p_px = this.universe.m2pix(r_p_m);
		const relX = r_p_px * Math.cos(theta);
		const relY = r_p_px * Math.sin(theta);
		
		// Calculate velocity vector
		// (At perihelion, the velocity vector is perpendicular to the radius vector)
		const v_p_px = this.universe.m2pix(v_p_m);
		const relVx = -v_p_px * Math.sin(theta);
		const relVy = v_p_px * Math.cos(theta);

		const x = hostObj.x + relX;
		const y = hostObj.y + relY;
		const vx = hostObj.vx + relVx;
		const vy = hostObj.vy + relVy;

		return this.placeObject(objName, x, y, vx, vy);
	}

	placeAtOrbitAroundHost(hostName, objName) {
		const hostObj = this.universe.objects.find(obj => obj.name === hostName);
		if (!hostObj) {
			throw new Error(hostName + " object not found in the universe.");
		}
		return this.placeAtOrbit(objName, hostObj);
	}

	placeAtOrbitAroundSun(objName) {
		const sunObj = this.universe.objects.find(obj => obj.name === "Sun") || this.universe.centerObject;
		if (!sunObj) {
			throw new Error("Sun object not found in the universe.");
		}
		return this.placeAtOrbit(objName, sunObj);
	}
	
	getLaunchPosition(e) {
		const screenCenterX = this.universe.canvas.width / 2;
		const screenCenterY = this.universe.canvas.height / 2;
		const centerObjX = this.universe.centerObject.x;
		const centerObjY = this.universe.centerObject.y;
		const zoomScale = this.universe.zoomScale;
		let x = 0, y = 0;

		if (e.touches) {
			if(e.changedTouches) {
				x = e.changedTouches[0].clientX;
				y = e.changedTouches[0].clientY;
			}
			else {
				x = e.touches[0].clientX;
				y = e.touches[0].clientY;
			}
		} else {
			x = e.clientX;
			y = e.clientY;
		}
		
		return {
			x: (x - screenCenterX) / zoomScale + centerObjX,
			y: (y - screenCenterY) / zoomScale + centerObjY,
		};
	}

	getLaunchObjectName() {
		const massSelect = document.getElementById('mass-select');
		if (massSelect && DEFAULT_OBJECT_PARAMS[massSelect.value]) {
			return massSelect.value;
		}
		return 'Earth'; // Default object name
	}

	setReadyForLaunch(e) {
		if (e.touches) {
			if (e.touches.length > 1) {
				this.isDragging = false;
				this.wasMultiTouch = true;
				return;
			}
			if (e.touches.length === 1) {
				this.wasMultiTouch = false;
			}
		}

		const pos = this.getLaunchPosition(e);
		this.startX = pos.x;
		this.startY = pos.y;
		this.startTime = Date.now();
		this.isDragging = true;
	}

	goLaunch(e) {
		if (!this.isDragging || this.wasMultiTouch) {
			this.isDragging = false;
			return; 
		}
		this.isDragging = false;
		
		const name = this.getLaunchObjectName();
		const pos = this.getLaunchPosition(e);
		const endX = pos.x;
		const endY = pos.y;
		const endTime = Date.now();
		const dt = Math.max((endTime - this.startTime) / TIME_SCALE, 0.01);
		const vx = this.universe.pix2m((endX - this.startX) / dt / THROW_SCALE);
		const vy = this.universe.pix2m((endY - this.startY) / dt / THROW_SCALE);
		
		this.placeObject(
			name,
			endX, endY,
			vx + this.universe.centerObject.vx,
			vy + this.universe.centerObject.vy
		);
		
		this.startX = null; // Reset start position
		this.startY = null;
	}

}

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
		this.ControlPanel = new ControlPanel(this);
		this.ObjectPlacer = new ObjectPlacer(this);

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

				if (now - lastTwoFingerTapTime < UI_DOUBLE_TAP_DUARATION) {
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

		// 4. Object Update
		this.objects.forEach(obj => obj.updateHistory());
		
		this.updateZoomScale();
		this.ObjectManager.cleanupObjects();
	}

	draw() {
		this.Renderer.draw(this.objects, this.centerObject);
	}
}
