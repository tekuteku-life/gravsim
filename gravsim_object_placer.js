
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

		// Relative position to the center object
		this.startRelX = null;
		this.startRelY = null;
		
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
			this.universe.resumeSimulation();
			this.isSlingshotting = false;
			this.startRelX = null;
			this.startRelY = null;
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
		const centerObj = this.universe.centerObject;
		const zoomScale = this.universe.zoomScale;
		
		return {
			x: (clientX - screenCenterX) / zoomScale + centerObj.x + this.universe.cameraOffset.x,
			y: (clientY - screenCenterY) / zoomScale + centerObj.y + this.universe.cameraOffset.y,
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

		// Pause simulation during slingshot dragging
		this.universe.pauseSimulation();

		this.isSlingshotting = true;
		this.screenCursorX = clientX;
		this.screenCursorY = clientY;
		this.startScreenX = clientX;
		this.startScreenY = clientY;

		const pos = this.getLaunchPosition(clientX, clientY);

		// Keep as relative position
		this.startRelX = pos.x - this.universe.centerObject.x;
		this.startRelY = pos.y - this.universe.centerObject.y;
	}

	updateDrag(clientX, clientY) {
		if (!this.isSlingshotting) return;
		this.screenCursorX = clientX;
		this.screenCursorY = clientY;
	}

	goLaunch(clientX, clientY) {
		if (!this.isSlingshotting || this.startRelX == null || this.startRelY == null) {
			return;
		}

		const name = this.getLaunchObjectName();
		const v = this._calculateSlingshotVelocity(this.startScreenX, this.startScreenY, clientX, clientY);

		const launchX = this.universe.centerObject.x + this.startRelX;
		const launchY = this.universe.centerObject.y + this.startRelY;
		
		this.placeObject(
			name,
			launchX, launchY,
			this.universe.Renderer.m2pix(v.vx) + this.universe.centerObject.vx,
			this.universe.Renderer.m2pix(v.vy) + this.universe.centerObject.vy,
			{ angle: Math.atan2(v.vy, v.vx) }
		);
		
		this.isSlingshotting = false;
		this.startRelX = null;
		this.startRelY = null;
		this.startScreenX = null;
		this.startScreenY = null;

		// Resume simulation after launching
		this.universe.resumeSimulation();
	}

	drawPreview(ctx, centerObject, zoomScale) {
		if (!this.isSlingshotting || this.startRelX == null) { return; }

		const v = this._calculateSlingshotVelocity(this.startScreenX, this.startScreenY, this.screenCursorX, this.screenCursorY);
		const speed_kms = Math.sqrt(v.vx * v.vx + v.vy * v.vy) / 1000;
		const angle_deg = Math.atan2(v.vy, v.vx) * (180 / Math.PI);
		const displayAngle = angle_deg < 0 ? angle_deg + 360 : angle_deg;

		const relStartX = this.startRelX * zoomScale;
		const relStartY = this.startRelY * zoomScale;

		const screenCenterX = this.universe.canvas.width / 2;
		const screenCenterY = this.universe.canvas.height / 2;
		const relCurX = (this.screenCursorX - screenCenterX) + this.universe.cameraOffset.x * zoomScale;
		const relCurY = (this.screenCursorY - screenCenterY) + this.universe.cameraOffset.y * zoomScale;

		const lineLength = Math.sqrt(Math.pow(relStartX - relCurX, 2) + Math.pow(relStartY - relCurY, 2));
		const endX = relStartX + Math.cos(Math.atan2(v.vy, v.vx)) * lineLength;
		const endY = relStartY + Math.sin(Math.atan2(v.vy, v.vx)) * lineLength;

		ctx.save();

		// Guide circle
		ctx.strokeStyle = "rgba(0, 255, 204, 0.4)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(relStartX, relStartY, 12, 0, Math.PI * 2);
		ctx.moveTo(relStartX - 16, relStartY);
		ctx.lineTo(relStartX + 16, relStartY);
		ctx.moveTo(relStartX, relStartY - 16);
		ctx.lineTo(relStartX, relStartY + 16);
		ctx.stroke();

		// Indicator opposite side to direction
		ctx.strokeStyle = "rgba(0, 255, 204, 0.3)";
		ctx.lineWidth = 1;
		ctx.setLineDash([4, 4]);
		ctx.beginPath();
		ctx.moveTo(relStartX, relStartY);
		ctx.lineTo(relCurX, relCurY);
		ctx.stroke();

		// Vector of direction
		ctx.setLineDash([]);
		ctx.strokeStyle = "rgba(0, 255, 204, 0.9)";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(relStartX, relStartY);
		ctx.lineTo(endX, endY);
		ctx.stroke();

		// Top of arrow
		if (lineLength > 5) {
			const headlen = 8;
			const launchRad = Math.atan2(v.vy, v.vx);
			ctx.fillStyle = "rgba(0, 255, 204, 0.9)";
			ctx.beginPath();
			ctx.moveTo(endX, endY);
			ctx.lineTo(endX - headlen * Math.cos(launchRad - Math.PI / 6), endY - headlen * Math.sin(launchRad - Math.PI / 6));
			ctx.lineTo(endX - (headlen * 0.6) * Math.cos(launchRad), endY - (headlen * 0.6) * Math.sin(launchRad));
			ctx.lineTo(endX - headlen * Math.cos(launchRad + Math.PI / 6), endY - headlen * Math.sin(launchRad + Math.PI / 6));
			ctx.closePath();
			ctx.fill();
		}

		// Floating HUD
		const objName = this.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[objName];
		const massText = param.MASS.toExponential(2) + " t";

		// Adjust center offset
		const hudX = (this.screenCursorX - this.universe.canvas.width / 2) + 20;
		const hudY = (this.screenCursorY - this.universe.canvas.height / 2) - 80;

		// HUD background
		ctx.fillStyle = "rgba(0, 20, 0, 0.85)";
		ctx.strokeStyle = "rgba(0, 255, 204, 0.6)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.roundRect(hudX, hudY, 140, 75, 4);
		ctx.fill();
		ctx.stroke();

		//Text
		ctx.fillStyle = "#00ffcc";
		ctx.font = "bold 12px 'Courier New', Courier, monospace";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText(`[ LAUNCH: ${objName.toUpperCase()} ]`, hudX + 8, hudY + 8);

		ctx.font = "11px 'Courier New', Courier, monospace";
		ctx.fillStyle = "#00aa88";
		ctx.fillText(`MASS: ${massText}`, hudX + 8, hudY + 26);
		ctx.fillStyle = "#00ffcc";
		ctx.fillText(`VEL : ${speed_kms.toFixed(2)} km/s`, hudX + 8, hudY + 42);
		ctx.fillText(`ANG : ${displayAngle.toFixed(1)}°`, hudX + 8, hudY + 56);

		ctx.restore();
	}
}
