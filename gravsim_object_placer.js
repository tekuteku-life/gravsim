
// gravsim_object_placer.js

import { PHYSICS, SIMULATION, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';
import { CelestialBody, Rocket } from './gravsim_object.js';

function AU2M(au) {
	return au * PHYSICS.METERS_PER_AU;
}

/*******************************************************************
 * ObjectPlacer class that manages the placement of objects in the universe.
*******************************************************************/
export class ObjectPlacer {
	constructor(universe) {
		this.universe = universe;

		this.isSlingshotting = false;
		this.startX = null;
		this.startY = null;
		this.currentX = null;
		this.currentY = null;
		
		// Store screen coordinates for UI dragging calculation
		this.startScreenX = null;
		this.startScreenY = null;

		this.screenCursorX = 0;
		this.screenCursorY = 0;

		// Register input events
		this.universe.InputManager.onDragStart = this.setReadyForLaunch.bind(this);
		this.universe.InputManager.onDragMove = this.updateDrag.bind(this);
		this.universe.InputManager.onDragEnd = this.goLaunch.bind(this);
		this.universe.InputManager.onDragCancel = () => {
			this.isSlingshotting = false;
			this.startX = null;
			this.startY = null;
			this.startScreenX = null;
			this.startScreenY = null;
		};
	}

	destroy() {
		this.universe.InputManager.onDragStart = null;
		this.universe.InputManager.onDragMove = null;
		this.universe.InputManager.onDragEnd = null;
		this.universe.InputManager.onDragCancel = null;
	}

	placeObject(objName, x, y, vx = 0, vy = 0, options = {}) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];

		const minDrawSize = param.MIN_DRAW_SIZE !== undefined
			? param.MIN_DRAW_SIZE
			: Math.log10((param.RADIUS || 1) * 8) / 2.5;

		let obj;
		const nextId = this.universe.ObjectManager.getNextId();

		if (param.NAME === 'Rocket' || objName === 'Rocket') {
			obj = new Rocket(
				nextId, param.NAME,
				x, y,
				vx, vy,
				options.emptyMass || param.MASS,
				(options.mass || param.MASS) - (options.emptyMass || param.MASS),
				param.COLOR,
				minDrawSize,
				param.RADIUS || 1,
				0,
				param.BORDER_COLOR || null,
				param.BORDER_WIDTH || 0
			);

			// Apply initial angle if specified
			if (options.angle !== undefined) {
				obj.thrustAngle = options.angle;
			}

			// Apply active rocket engine parameters if specified
			if (options.time > 0) {
				obj.thrustForce = options.force || 0;
				obj.burnTime = options.time || 0;
				obj.massLossRate = options.lossRate || 0;
				obj.maxGLimit = options.maxGLimit || 0;
			}

			if (options.autoControl !== undefined) {
				obj.autoControl = options.autoControl;
			}
		} else {
			obj = new CelestialBody(
				nextId, param.NAME,
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
		const v_p_m = Math.sqrt(PHYSICS.G * totalMassKg * (2 / r_p_m - 1 / a_m));

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

		// Calculate object's direction
		const angle = Math.atan2(relVy, relVx);

		return this.placeObject(objName, x, y, vx, vy, { angle: angle });
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

	getLaunchPosition(clientX, clientY) {
		const screenCenterX = this.universe.canvas.width / 2;
		const screenCenterY = this.universe.canvas.height / 2;
		const centerObjX = this.universe.centerObject.x;
		const centerObjY = this.universe.centerObject.y;
		const zoomScale = this.universe.zoomScale;
		
		return {
			x: (clientX - screenCenterX) / zoomScale + centerObjX + this.universe.cameraOffset.x,
			y: (clientY - screenCenterY) / zoomScale + centerObjY + this.universe.cameraOffset.y,
		};
	}

	getLaunchObjectName() {
		const massSelect = document.getElementById('mass-select');
		if (massSelect && DEFAULT_OBJECT_PARAMS[massSelect.value]) {
			return massSelect.value;
		}
		return 'Earth'; // Default object name
	}

	_calculateSlingshotVelocity(startScreenX, startScreenY, currentScreenX, currentScreenY) {
		// Initial velocity vector opposite to dragging direction using screen pixels
		const dxPx = startScreenX - currentScreenX;
		const dyPx = startScreenY - currentScreenY;

		// Calculate velocity directly from screen delta to prevent light-speed issue
		const rawVx = dxPx * SIMULATION.SLINGSHOT_POWER;
		const rawVy = dyPx * SIMULATION.SLINGSHOT_POWER;

		return { vx: rawVx, vy: rawVy };
	}

	setReadyForLaunch(clientX, clientY) {
		if (this.universe.RocketLauncher && this.universe.RocketLauncher.isActive && this.universe.RocketLauncher.mode === 'free') {
			const pos = this.getLaunchPosition(clientX, clientY);
			this.universe.RocketLauncher.setFreePosition(pos.x, pos.y);

			document.dispatchEvent(new Event('rocket-preview-updated'));
			return; 
		}

		this.isSlingshotting = true;
		this.screenCursorX = clientX;
		this.screenCursorY = clientY;
		this.startScreenX = clientX;
		this.startScreenY = clientY;

		const pos = this.getLaunchPosition(clientX, clientY);
		this.startX = pos.x;
		this.startY = pos.y;
		this.currentX = pos.x;
		this.currentY = pos.y;
	}

	updateDrag(clientX, clientY) {
		if (!this.isSlingshotting) return;
		
		this.screenCursorX = clientX;
		this.screenCursorY = clientY;

		const pos = this.getLaunchPosition(clientX, clientY);
		this.currentX = pos.x;
		this.currentY = pos.y;
	}

	goLaunch(clientX, clientY) {
		if (!this.isSlingshotting || this.startX == null || this.startY == null) {
			return;
		}

		const name = this.getLaunchObjectName();
		
		const v = this._calculateSlingshotVelocity(this.startScreenX, this.startScreenY, clientX, clientY);
		
		this.placeObject(
			name,
			this.startX, this.startY,
			this.universe.Renderer.m2pix(v.vx) + this.universe.centerObject.vx,
			this.universe.Renderer.m2pix(v.vy) + this.universe.centerObject.vy,
			{ angle: Math.atan2(v.vy, v.vx) }
		);
		
		this.isSlingshotting = false;
		this.startX = null;
		this.startY = null;
		this.startScreenX = null;
		this.startScreenY = null;
	}

	drawPreview(ctx, centerObject, zoomScale) {
		if (!this.isSlingshotting || this.startX == null) return;

		const v = this._calculateSlingshotVelocity(this.startScreenX, this.startScreenY, this.screenCursorX, this.screenCursorY);
		const speed_kms = Math.sqrt(v.vx * v.vx + v.vy * v.vy) / 1000;
		const angle_deg = Math.atan2(v.vy, v.vx) * (180 / Math.PI);
		const displayAngle = angle_deg < 0 ? angle_deg + 360 : angle_deg;

		const relStartX = (this.startX - centerObject.x) * zoomScale;
		const relStartY = (this.startY - centerObject.y) * zoomScale;
		
		const relCurX = (this.currentX - centerObject.x) * zoomScale;
		const relCurY = (this.currentY - centerObject.y) * zoomScale;

		const lineLength = Math.sqrt(Math.pow(relStartX - relCurX, 2) + Math.pow(relStartY - relCurY, 2));
		const endX = relStartX + Math.cos(Math.atan2(v.vy, v.vx)) * lineLength;
		const endY = relStartY + Math.sin(Math.atan2(v.vy, v.vx)) * lineLength;

		ctx.save();

		ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
		ctx.lineWidth = 1;
		ctx.setLineDash([5, 5]);
		ctx.beginPath();
		ctx.moveTo(relStartX, relStartY);
		ctx.lineTo(relCurX, relCurY);
		ctx.stroke();

		// Vector of direction
		ctx.strokeStyle = "rgba(255, 50, 50, 0.9)";
		ctx.lineWidth = 2;
		ctx.setLineDash([]);
		ctx.beginPath();
		ctx.moveTo(relStartX, relStartY);
		ctx.lineTo(endX, endY);
		
		// Top of arrow
		if (lineLength > 5) {
			const headlen = 10;
			const launchRad = Math.atan2(v.vy, v.vx);
			ctx.lineTo(endX - headlen * Math.cos(launchRad - Math.PI / 6), endY - headlen * Math.sin(launchRad - Math.PI / 6));
			ctx.moveTo(endX, endY);
			ctx.lineTo(endX - headlen * Math.cos(launchRad + Math.PI / 6), endY - headlen * Math.sin(launchRad + Math.PI / 6));
		}
		ctx.stroke();

		// Floating HUD
		const objName = this.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[objName];
		const massText = param.MASS.toExponential(2) + " t";
		
		// Adjust center offset
		const hudX = (this.screenCursorX - this.universe.canvas.width / 2) + 20;
		const hudY = (this.screenCursorY - this.universe.canvas.height / 2) - 80;

		// background
		ctx.fillStyle = "rgba(10, 20, 30, 0.85)";
		ctx.strokeStyle = "rgba(0, 255, 204, 0.6)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.roundRect(hudX, hudY, 130, 75, 5); // x, y, width, height, radii
		ctx.fill();
		ctx.stroke();

		// Text
		ctx.fillStyle = "#ffffff";
		ctx.font = "bold 12px sans-serif";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";

		ctx.fillText(`[ ${objName} ]`, hudX + 8, hudY + 8);

		ctx.font = "11px monospace";
		ctx.fillStyle = "#aaddff";
		ctx.fillText(`Mass: ${massText}`, hudX + 8, hudY + 26);

		ctx.fillStyle = "#ffcc00";
		ctx.fillText(`Vel : ${speed_kms.toFixed(2)} km/s`, hudX + 8, hudY + 42);
		ctx.fillText(`Ang : ${displayAngle.toFixed(1)}°`, hudX + 8, hudY + 56);

		ctx.restore();
	}
}
