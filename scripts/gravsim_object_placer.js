
// gravsim_object_placer.js

import { PHYSICS, SIMULATION, DEFAULT_OBJECT_PARAMS, RENDER, EVENT_PRIORITY } from './gravsim_const.js';
import { CelestialBody, Rocket } from './gravsim_object.js';
import { UnitConvertUtils, MathUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

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

		// Bind event handlers
		this._onDragStart = this.setReadyForLaunch.bind(this);
		this._onDragMove = this.updateDrag.bind(this);
		this._onDragEnd = this.goLaunch.bind(this);
		this._onDragCancel = () => {
			EventBus.emit('simulation:resume');
			this.isSlingshotting = false;
			this.startRelX = null;
			this.startRelY = null;
			this.startScreenX = null;
			this.startScreenY = null;
		};

		// Register input events via EventBus
		EventBus.on('input:drag-start', this._onDragStart);
		EventBus.on('input:drag-move', this._onDragMove);
		EventBus.on('input:drag-end', this._onDragEnd);
		EventBus.on('input:drag-cancel', this._onDragCancel);

		// Commands from DeployTab
		EventBus.on('object:deploy-orbit-sun', (objName) => this.placeAtOrbitAroundSun(objName));
		EventBus.on('object:deploy-orbit-host', (hostName, objName) => this.placeAtOrbitAroundHost(hostName, objName));

		// Hook into the main draw pipeline
		EventBus.onDrawAfter((ctx, rc) => {
			if (rc.name === 'main') {
				this.drawPreview(ctx, rc.basis, rc.zoomScale);
			}
		}, EVENT_PRIORITY.DRAW_WORLD_FX);
	}

	destroy() {
		EventBus.off('input:drag-start', this._onDragStart);
		EventBus.off('input:drag-move', this._onDragMove);
		EventBus.off('input:drag-end', this._onDragEnd);
		EventBus.off('input:drag-cancel', this._onDragCancel);
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
				options.fuelMass !== undefined ? options.fuelMass : (options.mass || param.MASS) - (options.emptyMass || param.MASS),
				options.oxidMass || 0,
				param.COLOR,
				minDrawSize,
				param.RADIUS || 1,
				0,
				param.BORDER_COLOR || null,
				param.BORDER_WIDTH || 0
			);

			if (options.ofRatio !== undefined) {
				obj.ofRatio = options.ofRatio;
			}

			// Apply initial angle if specified
			if (options.angle !== undefined) {
				obj.thrustAngle = options.angle;
			}

			if (options.flightProfile !== undefined) {
				obj.flightProfile = options.flightProfile;
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
			if (options.hostId !== undefined) { obj.hostId = options.hostId; }
			if (options.hostAngleRad !== undefined) { obj.hostAngleRad = options.hostAngleRad; }
			if (options.hostAltM !== undefined) { obj.hostAltM = options.hostAltM; }
			if (options.isHoldDown !== undefined) { obj.isHoldDown = options.isHoldDown; }
			if (options.isIgnited !== undefined) { obj.isIgnited = options.isIgnited; }

			this.universe.TelemetryPanel.targetId = obj.id;
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
		const a_m = UnitConvertUtils.au2m(a_au);
		const r_p_m = a_m * (1 - e); // perihelion distance (m)

		// Calculate velocity at perihelion by using Vis-viva equation
		const totalMassKg = UnitConvertUtils.ton2kg(hostObj.mass + param.MASS);
		const v_p_m = Math.sqrt(PHYSICS.G * totalMassKg * (2 / r_p_m - 1 / a_m));

		const perihelionDeg = param.PERIHELION_DEG || 0;
		const theta = UnitConvertUtils.deg2rad(perihelionDeg);

		const r_p_px = UnitConvertUtils.m2pix(r_p_m);
		const relX = r_p_px * Math.cos(theta);
		const relY = r_p_px * Math.sin(theta);

		// Calculate velocity vector
		// (At perihelion, the velocity vector is perpendicular to the radius vector)
		const v_p_px = UnitConvertUtils.m2pix(v_p_m);
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
		const sunObj = this.universe.objects.find(obj => obj.name === "Sun") || this.universe.camera.trackingTarget;
		if (!sunObj) {
			throw new Error("Sun object not found in the universe.");
		}
		return this.placeAtOrbit(objName, sunObj);
	}

	getLaunchPosition(clientX, clientY) {
		const screenCenterX = this.universe.canvas.width / 2;
		const screenCenterY = this.universe.canvas.height / 2;
		const renderState = this.universe.camera.getRenderState();
		const centerObj = renderState.basis;
		const zoomScale = renderState.zoomScale;
		
		let dx = (clientX - screenCenterX) / zoomScale;
		let dy = (clientY - screenCenterY) / zoomScale;

		// Apply inverse rotation
		if (renderState.rotation !== 0) {
			const cosA = Math.cos(-renderState.rotation);
			const sinA = Math.sin(-renderState.rotation);
			const rDx = dx * cosA - dy * sinA;
			const rDy = dx * sinA + dy * cosA;
			dx = rDx;
			dy = rDy;
		}

		return {
			x: dx + centerObj.x + renderState.cameraOffset.x,
			y: dy + centerObj.y + renderState.cameraOffset.y,
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
		EventBus.emit('simulation:pause');

		this.isSlingshotting = true;
		this.screenCursorX = clientX;
		this.screenCursorY = clientY;
		this.startScreenX = clientX;
		this.startScreenY = clientY;

		const pos = this.getLaunchPosition(clientX, clientY);
		const basis = this.universe.camera.getRenderState().basis;

		// Keep as relative position
		this.startRelX = pos.x - basis.x;
		this.startRelY = pos.y - basis.y;
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
		const basis = this.universe.camera.getRenderState().basis;

		const launchX = basis.x + this.startRelX;
		const launchY = basis.y + this.startRelY;
		
		this.placeObject(
			name,
			launchX, launchY,
			UnitConvertUtils.m2pix(v.vx) + basis.vx,
			UnitConvertUtils.m2pix(v.vy) + basis.vy,
			{ angle: Math.atan2(v.vy, v.vx) }
		);
		
		this.isSlingshotting = false;
		this.startRelX = null;
		this.startRelY = null;
		this.startScreenX = null;
		this.startScreenY = null;

		// Resume simulation after launching
		EventBus.emit('simulation:resume');
	}

	drawPreview(ctx, centerObject, zoomScale) {
		if (!this.isSlingshotting || this.startRelX == null) { return; }

		const v = this._calculateSlingshotVelocity(this.startScreenX, this.startScreenY, this.screenCursorX, this.screenCursorY);
		const speed_kms = UnitConvertUtils.m2km(Math.sqrt(v.vx * v.vx + v.vy * v.vy));
		const angle_deg = UnitConvertUtils.rad2deg(Math.atan2(v.vy, v.vx));
		const displayAngle = MathUtils.normalizeAngle360(angle_deg);

		const renderState = this.universe.camera.getRenderState();

		const relStartX = this.startRelX * zoomScale;
		const relStartY = this.startRelY * zoomScale;

		const screenCenterX = this.universe.canvas.width / 2;
		const screenCenterY = this.universe.canvas.height / 2;
		
		let dxCur = (this.screenCursorX - screenCenterX) / zoomScale;
		let dyCur = (this.screenCursorY - screenCenterY) / zoomScale;

		if (renderState.rotation !== 0) {
			const cosA = Math.cos(-renderState.rotation);
			const sinA = Math.sin(-renderState.rotation);
			const rDx = dxCur * cosA - dyCur * sinA;
			const rDy = dxCur * sinA + dyCur * cosA;
			dxCur = rDx;
			dyCur = rDy;
		}

		const relCurX = (dxCur + renderState.cameraOffset.x) * zoomScale;
		const relCurY = (dyCur + renderState.cameraOffset.y) * zoomScale;

		const lineLength = Math.sqrt(Math.pow(relStartX - relCurX, 2) + Math.pow(relStartY - relCurY, 2));
		const endX = relStartX + Math.cos(Math.atan2(v.vy, v.vx)) * lineLength;
		const endY = relStartY + Math.sin(Math.atan2(v.vy, v.vx)) * lineLength;

		const conf = RENDER.SLINGSHOT;

		ctx.save();

		// Guide circle
		ctx.strokeStyle = conf.GUIDE_COLOR;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(relStartX, relStartY, conf.GUIDE_RADIUS, 0, Math.PI * 2);
		ctx.moveTo(relStartX - conf.GUIDE_CROSS, relStartY);
		ctx.lineTo(relStartX + conf.GUIDE_CROSS, relStartY);
		ctx.moveTo(relStartX, relStartY - conf.GUIDE_CROSS);
		ctx.lineTo(relStartX, relStartY + conf.GUIDE_CROSS);
		ctx.stroke();

		// Indicator opposite side to direction
		ctx.strokeStyle = conf.LINE_OPPOSITE_COLOR;
		ctx.lineWidth = 1;
		ctx.setLineDash(conf.LINE_DASH);
		ctx.beginPath();
		ctx.moveTo(relStartX, relStartY);
		ctx.lineTo(relCurX, relCurY);
		ctx.stroke();

		// Vector of direction
		ctx.setLineDash([]);
		ctx.strokeStyle = conf.LINE_VECTOR_COLOR;
		ctx.lineWidth = conf.LINE_WIDTH;
		ctx.beginPath();
		ctx.moveTo(relStartX, relStartY);
		ctx.lineTo(endX, endY);
		ctx.stroke();

		// Top of arrow
		if (lineLength > conf.ARROW_MIN_LEN) {
			const headlen = conf.ARROW_HEAD_LEN;
			const launchRad = Math.atan2(v.vy, v.vx);
			ctx.fillStyle = conf.LINE_VECTOR_COLOR;
			ctx.beginPath();
			ctx.moveTo(endX, endY);
			ctx.lineTo(endX - headlen * Math.cos(launchRad - conf.ARROW_ANGLE), endY - headlen * Math.sin(launchRad - conf.ARROW_ANGLE));
			ctx.lineTo(endX - (headlen * conf.ARROW_INDENT_MULT) * Math.cos(launchRad), endY - (headlen * conf.ARROW_INDENT_MULT) * Math.sin(launchRad));
			ctx.lineTo(endX - headlen * Math.cos(launchRad + conf.ARROW_ANGLE), endY - headlen * Math.sin(launchRad + conf.ARROW_ANGLE));
			ctx.closePath();
			ctx.fill();
		}

		// Floating HUD
		const objName = this.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[objName];
		const massText = param.MASS.toExponential(2) + " t";

		// Adjust center offset natively based on screen cursor
		// Note: The UI is rendered in the rotated and translated context here,
		// so HUD remains fixed to the world grid instead of the screen borders.
		const hudX = relCurX + conf.HUD_OFFSET_X;
		const hudY = relCurY + conf.HUD_OFFSET_Y;

		// HUD background
		ctx.fillStyle = conf.HUD_BG_COLOR;
		ctx.strokeStyle = conf.HUD_BORDER_COLOR;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.roundRect(hudX, hudY, conf.HUD_WIDTH, conf.HUD_HEIGHT, conf.HUD_RAD);
		ctx.fill();
		ctx.stroke();

		//Text
		ctx.fillStyle = conf.HUD_TEXT_COLOR_MAIN;
		ctx.font = conf.HUD_FONT_TITLE;
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText(`[ LAUNCH: ${objName.toUpperCase()} ]`, hudX + conf.HUD_PAD_X, hudY + conf.HUD_PAD_Y_TITLE);

		ctx.font = conf.HUD_FONT_BODY;
		ctx.fillStyle = conf.HUD_TEXT_COLOR_SUB;
		ctx.fillText(`MASS: ${massText}`, hudX + conf.HUD_PAD_X, hudY + conf.HUD_PAD_Y_MASS);
		ctx.fillStyle = conf.HUD_TEXT_COLOR_MAIN;
		ctx.fillText(`VEL : ${speed_kms.toFixed(2)} km/s`, hudX + conf.HUD_PAD_X, hudY + conf.HUD_PAD_Y_VEL);
		ctx.fillText(`ANG : ${displayAngle.toFixed(1)}°`, hudX + conf.HUD_PAD_X, hudY + conf.HUD_PAD_Y_ANG);

		ctx.restore();
	}
}
