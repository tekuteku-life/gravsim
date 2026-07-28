
// gravsim_universe.js

import {
	METERS_PER_AU, YEARS_PER_SECOND, G,
	TIME_SCALE, THROW_SCALE, REMOVE_DISTANCE_AU, 
	HISTORY_LENGTH, DISTANCE_SCALE, OBJECT_STATE,
	DEFAULT_OBJECT_PARAMS
} from './gravsim_const.js';
import { InfoPanel } from './gravsim_info_panel.js';
import { ControlPanel } from './gravsim_control_panel.js';
import { GravSimObject } from './gravsim_object.js';

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
		const pos = this.getLaunchPosition(e);
		this.startX = pos.x;
		this.startY = pos.y;
		this.startTime = Date.now();
		this.isDragging = true;
	}

	goLaunch(e) {
		if (!this.isDragging) return; // Ensure we are in dragging state
		this.isDragging = false; // Reset dragging state
		
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
 * Renderer Class
*******************************************************************/
class Renderer {
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.zoomScale = 1;
	}

	setZoomScale(scale) {
		this.zoomScale = scale;
	}

	pix2au(px) { return px / DISTANCE_SCALE; }
	au2pix(au) { return au * DISTANCE_SCALE; }
	m2pix(m) { return this.au2pix(M2AU(m)); }
	pix2m(px) { return AU2M(this.pix2au(px)); }

	draw(objects, centerObject) {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
		this.ctx.scale(this.zoomScale, this.zoomScale);
		
		objects.forEach(obj => obj.draw(this.ctx, centerObject, 1 / this.zoomScale));
		
		this.ctx.restore();
	}
}

/*******************************************************************
 * ObjectManager Class
*******************************************************************/
class ObjectManager {
	constructor(renderer, workerManager) {
		this.renderer = renderer;
		this.workerManager = workerManager;
		this.objects = [];
		this.centerObject = null;
	}

	ensureCenterObject() {
		if (this.centerObject && this.centerObject.state !== OBJECT_STATE.ACTIVE) {
			const maxMassObj = this.objects.reduce((max, obj) => obj.mass > max.mass ? obj : max, this.objects[0]);
			this.centerObject = maxMassObj;
			return true;
		}
		return false;
	}

	addObject(obj) {
		if (!(obj instanceof GravSimObject)) throw new Error("Invalid object type.");
		this.objects.push(obj);
		this.workerManager.postMessage({
			cmd: 'add',
			id: obj.id,
			x: this.renderer.pix2m(obj.x), y: this.renderer.pix2m(obj.y),
			vx: this.renderer.pix2m(obj.vx), vy: this.renderer.pix2m(obj.vy),
			ax: this.renderer.pix2m(obj.ax), ay: this.renderer.pix2m(obj.ay),
			mass: obj.mass * 1e3,
			radius: obj.radius,
		});
	}

	removeObject(obj) {
		if (!(obj instanceof GravSimObject)) throw new Error("Invalid object type.");
		obj.setCollided();
		this.workerManager.postMessage({ cmd: 'remove', id: obj.id });
	}

	updateObject(obj) {
		if (!(obj instanceof GravSimObject)) throw new Error("Invalid object type.");
		this.workerManager.postMessage({
			cmd: 'update',
			id: obj.id,
			x: this.renderer.pix2m(obj.x), y: this.renderer.pix2m(obj.y),
			vx: this.renderer.pix2m(obj.vx), vy: this.renderer.pix2m(obj.vy),
			ax: this.renderer.pix2m(obj.ax), ay: this.renderer.pix2m(obj.ay),
			mass: obj.mass * 1e3,
			radius: obj.radius,
		});
	}

	updateObjectParams(data) {
		data.objects.forEach(workerObj => {
			const target = this.objects.find(t => t.id === workerObj.id);
			if (target) {
				target.x = this.renderer.m2pix(workerObj.x);
				target.y = this.renderer.m2pix(workerObj.y);
				target.vx = this.renderer.m2pix(workerObj.vx);
				target.vy = this.renderer.m2pix(workerObj.vy);
				target.ax = this.renderer.m2pix(workerObj.ax);
				target.ay = this.renderer.m2pix(workerObj.ay);
				target.mass = workerObj.mass / 1e3;
				target.radius = workerObj.radius;
				target.addHistory();

				if (workerObj.collided) {
					target.setCollided();
				}
			}
		});
	}

	cleanupObjects() {
		this._checkEscapeAndRemove();
		this.objects = this.objects.filter(obj => !obj.finished());
	}

	_checkEscapeAndRemove() {
		if (!this.centerObject) { return; }

		for (const obj of this.objects) {
			if (obj.id === this.centerObject.id || obj.state !== OBJECT_STATE.ACTIVE) {
				obj.isEscaping = false;
				continue;
			}

			const dx = obj.x - this.centerObject.x;
			const dy = obj.y - this.centerObject.y;
			const distPx = Math.sqrt(dx * dx + dy * dy);

			const r = this.renderer.pix2m(distPx);
			if (r === 0) { continue; }

			const dvx = this.renderer.pix2m(obj.vx - this.centerObject.vx);
			const dvy = this.renderer.pix2m(obj.vy - this.centerObject.vy);

			// Relative velocity squared
			const v2 = dvx * dvx + dvy * dvy;

			const totalMass = (this.centerObject.mass + obj.mass) * 1e3;
			const escapeV2 = (2 * G * totalMass) / r; // Escape velocity squared (v_e^2 = 2GM / r)

			// Check if the object is escaping the center object's gravity
			obj.isEscaping = (v2 >= escapeV2);

			// Remove the object if it is escaping and far enough
			if (obj.isEscaping && this.renderer.pix2au(distPx) > REMOVE_DISTANCE_AU) {
				this.removeObject(obj);
				console.debug(`${obj.name} (id:${obj.id}) got out from heliosphere`);
			}
		}
	}

	destroy() {
		this.objects.forEach(obj => this.removeObject(obj));
		this.objects = [];
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
		this.canvas.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.reset();
		});
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
		// 1. Center Object Check
		const centerChanged = this.ObjectManager.ensureCenterObject();
		if (centerChanged) {
			this.ControlPanel.updateCenterOptions();
		}

		// 2. Time Management
		this.timeScale = this.ControlPanel.getTimeScale();
		this.CalcWorkerManager.setTimeScale(this.timeScale);
		const scaledDt = dt * (YEARS_PER_SECOND / TIME_SCALE) * this.timeScale;

		// 3. UI Update
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
