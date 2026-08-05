
// gravsim_object_placer.js

import {
	METERS_PER_AU, G,
	TIME_SCALE, THROW_SCALE, DEFAULT_OBJECT_PARAMS
} from './gravsim_const.js';
import { GravSimObject } from './gravsim_object.js';
import { RocketLauncher } from './gravsim_rocket_launcher.js';

function AU2M(au) {
	return au * METERS_PER_AU;
}

/*******************************************************************
 * ObjectPlacer class that manages the placement of objects in the universe.
 * @property {Universe} universe - The universe instance where objects are placed.
*******************************************************************/
export class ObjectPlacer {
	constructor(universe) {
		this.universe = universe;
		this.isDragging = false;
		this.wasMultiTouch = false;

		this.boundSetReady = this.setReadyForLaunch.bind(this);
		this.boundGoLaunch = this.goLaunch.bind(this);

		universe.canvas.addEventListener('mousedown', this.boundSetReady);
		universe.canvas.addEventListener('touchstart', this.boundSetReady);
		universe.canvas.addEventListener('mouseup', this.boundGoLaunch);
		universe.canvas.addEventListener('touchend', this.boundGoLaunch);
	}

	destroy() {
		this.universe.canvas.removeEventListener('mousedown', this.boundSetReady);
		this.universe.canvas.removeEventListener('touchstart', this.boundSetReady);
		this.universe.canvas.removeEventListener('mouseup', this.boundGoLaunch);
		this.universe.canvas.removeEventListener('touchend', this.boundGoLaunch);
	}

	placeObject(objName, x, y, vx = 0, vy = 0, options = {}) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];

		const minDrawSize = param.MIN_DRAW_SIZE !== undefined
			? param.MIN_DRAW_SIZE
			: Math.log10((param.RADIUS || 1) * 8) / 2.5;

		const obj = new GravSimObject(
			param.NAME,
			x, y,
			vx, vy,
			param.MASS,
			param.COLOR,
			minDrawSize,
			param.RADIUS || 1,
			0,
			param.BORDER_COLOR || null,
			param.BORDER_WIDTH || 0
		);

		// Apply active rocket engine parameters if specified
		if (options.time > 0) {
			obj.thrustForce = options.force || 0;
			obj.burnTime = options.time || 0;
			obj.thrustAngle = options.angle || 0;
			obj.massLossRate = options.lossRate || 0;
			obj.mass = options.mass || param.mass;
		}

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

		if (this.universe.RocketLauncher && this.universe.RocketLauncher.isActive && this.universe.RocketLauncher.mode === 'free') {
			const pos = this.getLaunchPosition(e);
			this.universe.RocketLauncher.setFreePosition(pos.x, pos.y);
			
			document.dispatchEvent(new Event('rocket-preview-updated'));
			return; 
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
