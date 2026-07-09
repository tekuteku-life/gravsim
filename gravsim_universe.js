
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

	placeAtOrbit(objName, orbitCenterX, orbitCenterY, hostVx = 0, hostVy = 0) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];
		const x = orbitCenterX;
		const y = orbitCenterY - this.universe.au2pix(param.ORBIT_RADIUS || 0);
		const vx = this.universe.m2pix(param.VELOCITY || 0) + hostVx;
		const vy = hostVy;
		return this.placeObject(objName, x, y, vx, vy);
	}

	placeAtOrbitAroundHost(hostName, objName) {
		const hostObj = this.universe.objects.find(obj => obj.name === hostName);
		if (!hostObj) {
			throw new Error(hostName + " object not found in the universe.");
		}
		return this.placeAtOrbit(objName, hostObj.x, hostObj.y, hostObj.vx, hostObj.vy);
	}

	placeAtOrbitAroundSun(objName) {
		const sunObj = this.universe.objects.find(obj => obj.name === "Sun") || this.universe.centerObject;
		if (!sunObj) {
			throw new Error("Sun object not found in the universe.");
		}
		return this.placeAtOrbit(objName, sunObj.x, sunObj.y, sunObj.vx, sunObj.vy);
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
 * Universe class that manages the simulation of celestial objects.
 * @property {HTMLCanvasElement} canvas - The canvas element for rendering.
 * @property {CanvasRenderingContext2D} ctx - The 2D rendering context for the canvas.
 * @property {Array} objects - The array of celestial objects in the universe.
 * @property {InfoPanel} InfoPanel - The information panel for displaying simulation data.
 * @property {ControlPanel} ControlPanel - The control panel for simulation settings.
 * @property {ObjectPlacer} ObjectPlacer - The object placer for adding new objects to the universe.
 * @property {number} timeScale - The scale factor for time progression in the simulation.
*******************************************************************/
export class Universe {
	constructor(_canvas) {
		this.canvas = _canvas;
		this.ctx = _canvas.getContext('2d');
		this.objects = [];
		this.centerObject = null;
		this._initInput();
		this.InfoPanel = new InfoPanel();
		this.ControlPanel = new ControlPanel(this);
		this.ObjectPlacer = new ObjectPlacer(this);
		this.CalcWorkerManager = new CalcWorkerManager();
		this.timeScale = this.ControlPanel.getTimeScale();
		this.zoomScale = this.ControlPanel.getZoomScale();
		this.ignoreUpdatesUntil = 0;

		this.reset();
	}
	
	pix2au(px) {
		return px / DISTANCE_SCALE;
	}
	au2pix(au) {
		return au * DISTANCE_SCALE;
	}
	m2pix(m) {
		return this.au2pix(M2AU(m));
	}
	pix2m(px) {
		return AU2M(this.pix2au(px));
	}

	updateObjectParams(data) {
		if (Date.now() < this.ignoreUpdatesUntil) { return; }

		data.objects.forEach(obj => {
			const target = this.objects.find(target => target.id === obj.id);
			if (target) {
				target.x = this.m2pix(obj.x);
				target.y = this.m2pix(obj.y);
				target.vx = this.m2pix(obj.vx);
				target.vy = this.m2pix(obj.vy);
				target.ax = this.m2pix(obj.ax);
				target.ay = this.m2pix(obj.ay);
				target.mass = obj.mass /1e3;
				target.radius = obj.radius;
				target.addHistory();

				if( obj.collided === true ) {
					target.setCollided();
				}
			}
		});
	}

	destroy() {
		for (let i = 0; i < this.objects.length; i++) {
			this.removeObject(this.objects[i]);
			delete this.objects[i];
		}
		this.objects = [];
	}

	_initInput() {
		this.canvas.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.reset();
		});
	}

	reset() {
		this.destroy();

		const centerX = this.canvas.width / 2;
		const centerY = this.canvas.height / 2;
		this.ObjectPlacer.placeObject('Sun', centerX, centerY, 0, 0);
		this.centerObject = this.objects[0];
	}

	draw() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
		this.ctx.scale(this.zoomScale, this.zoomScale);
		for (const obj of this.objects) {
			obj.draw(this.ctx, this.centerObject, 1/this.zoomScale);
		}
		this.ctx.restore();
	}

	addObject(obj) {
		if (!(obj instanceof GravSimObject)) {
			throw new Error("Invalid object type. Must be an instance of GravSimObject class.");
		}
		this.objects.push(obj);
		this.CalcWorkerManager.postMessage({
			cmd: 'add',
			id: obj.id,
			x: this.pix2m(obj.x), y: this.pix2m(obj.y),
			vx: this.pix2m(obj.vx), vy: this.pix2m(obj.vy),
			ax: this.pix2m(obj.ax), ay: this.pix2m(obj.ay),
			mass: obj.mass *1e3,
			radius: obj.radius,
		});
	}

	removeObject(obj) {
		if (!(obj instanceof GravSimObject)) {
			throw new Error("Invalid object type. Must be an instance of GravSimObject class.");
		}
		obj.setCollided();
		this.CalcWorkerManager.postMessage({
			cmd: 'remove',
			id: obj.id,
		});
	}

	updateObject(obj) {
		if (!(obj instanceof GravSimObject)) {
			throw new Error("Invalid object type. Must be an instance of GravSimObject class.");
		}
		this.CalcWorkerManager.postMessage({
			cmd: 'update',
			id: obj.id,
			x: this.pix2m(obj.x), y: this.pix2m(obj.y),
			vx: this.pix2m(obj.vx), vy: this.pix2m(obj.vy),
			ax: this.pix2m(obj.ax), ay: this.pix2m(obj.ay),
			mass: obj.mass *1e3,
			radius: obj.radius,
		});
	}

	removeFinished() {
		this.objects = this.objects.filter(obj => !obj.finished());
	}

	removeFarObjects() {
		if (!this.centerObject) return;

		for (const obj of this.objects) {
			if (obj.id === this.centerObject.id) continue;
			if (obj.state !== OBJECT_STATE.ACTIVE) continue;

			const dx = obj.x - this.centerObject.x;
			const dy = obj.y - this.centerObject.y;
			const distPx = Math.sqrt(dx * dx + dy * dy);
			
			const distAu = this.pix2au(distPx);
			if (distAu > REMOVE_DISTANCE_AU) {
				const r = this.pix2m(distPx);
				const dvx = this.pix2m(obj.vx - this.centerObject.vx);
				const dvy = this.pix2m(obj.vy - this.centerObject.vy);
				const v2 = dvx * dvx + dvy * dvy;

				const totalMass = (this.centerObject.mass + obj.mass) * 1e3;

				const escapeV2 = (2 * G * totalMass) / r;

				if (v2 >= escapeV2) {
					this.removeObject(obj);
					console.debug(`${obj.name} (id:${obj.id}) got out from heliosphere`);
				}
			}
		}
	}

	updateTimeScale() {
		this.timeScale = this.ControlPanel.getTimeScale();
		this.CalcWorkerManager.setTimeScale(this.timeScale);
	}

	updateZoomScale() {
		this.zoomScale = this.ControlPanel.getZoomScale();
	}

	update(dt) {
		if (this.centerObject && this.centerObject.state !== OBJECT_STATE.ACTIVE) {
			const maxMassObj = this.objects.reduce((max, obj) => obj.mass > max.mass ? obj : max, this.objects[0]);
			this.centerObject = maxMassObj;
			
			this.ControlPanel.updateCenterOptions();
		}

		dt *= YEARS_PER_SECOND /TIME_SCALE *this.timeScale;

		if( this.objects.length == 1 ) {
			this.InfoPanel.resetElapsedTime();
		}
		else {
			this.InfoPanel.updateElapsedTime(dt);
		}
		this.InfoPanel.updateObjectCount(this.objects.length);
		this.InfoPanel.updateFPS();

		for (const obj of this.objects) {
			obj.updateHistory();
		}

		this.updateTimeScale();
		this.updateZoomScale();
		this.removeFarObjects();
		this.removeFinished();
	}
}
