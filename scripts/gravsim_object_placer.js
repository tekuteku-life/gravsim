
// gravsim_object_placer.js

import {
	PHYSICS, SIMULATION, DEFAULT_OBJECT_PARAMS,
	DEPLOY_PROFILES, RENDER, EVENT_PRIORITY
} from './gravsim_const.js';
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
		
		// Map the deploy-profile command
		EventBus.on('object:deploy-profile', (profileId) => this.deployProfile(profileId));

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
			const name = options.name || param.NAME;
			const mass = options.mass !== undefined ? options.mass : param.MASS;
			const color = options.color || param.COLOR;
			const radius = options.radius !== undefined ? options.radius : (param.RADIUS || 1);
			const minDraw = options.minDrawSize !== undefined ? options.minDrawSize : minDrawSize;
			obj = new CelestialBody(
				nextId, name,
				x, y,
				vx, vy,
				mass, 
				color,
				minDraw,
				radius,
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

	// Profile Deployer Engine
	deployProfile(profileId) {
		const profile = DEPLOY_PROFILES[profileId];
		if (!profile) {
			console.error(`Deployment profile '${profileId}' not found.`);
			return;
		}

		EventBus.emit('simulation:pause');

		if (profile.clearPrevious) {
			// Clear debris, rockets, and celestials (excluding Sun)
			EventBus.emit('simulation:clear-objects', true, true, true);
		}

		// 1. Process Static Objects
		if (profile.staticObjects) {
			profile.staticObjects.forEach(objDef => {
				if (objDef.host) {
					this.placeAtOrbitAroundHost(objDef.host, objDef.template);
				} else {
					this.placeObject(objDef.template, objDef.x || 0, objDef.y || 0, objDef.vx || 0, objDef.vy || 0, objDef.options || {});
				}
			});
		}

		// 2. Process Procedural Generators (Swarms, Binary, ThreeBody)
		if (profile.generators) {
			profile.generators.forEach(gen => {
				if (gen.type === 'binary_system') {
					this._deployBinarySystem(gen);
					return;
				} else if (gen.type === 'three_body') {
					this._deployThreeBody(gen);
					return;
				}

				const hostObj = this.universe.objects.find(obj => obj.name === gen.host);
				if (!hostObj) return;

				if (gen.type === 'elliptical_swarm') {
					this._deployEllipticalSwarm(hostObj, gen);
				} else if (gen.type === 'circular_swarm') {
					this._deployCircularSwarm(hostObj, gen);
				}
			});
		}

		EventBus.emit('simulation:resume');
		console.info(`Profile deployed: ${profile.name}`);
	}

	_deployEllipticalSwarm(hostObj, genConfig) {
		const templateMass = DEFAULT_OBJECT_PARAMS[genConfig.template].MASS;
		const totalMassKg = UnitConvertUtils.ton2kg(hostObj.mass + templateMass);

		for (let i = 0; i < genConfig.count; i++) {
			const rp_au = genConfig.perihelionAuMin + Math.random() * (genConfig.perihelionAuMax - genConfig.perihelionAuMin);
			const ra_au = genConfig.aphelionAuMin + Math.random() * (genConfig.aphelionAuMax - genConfig.aphelionAuMin);

			const a_m = UnitConvertUtils.au2m((rp_au + ra_au) / 2);
			const rp_m = UnitConvertUtils.au2m(rp_au);

			const vp_m = Math.sqrt(PHYSICS.G * totalMassKg * (2 / rp_m - 1 / a_m));

			// Random direction (360 degrees)
			const phi = Math.random() * Math.PI * 2;
			
			const rp_px = UnitConvertUtils.m2pix(rp_m);
			const vp_px = UnitConvertUtils.m2pix(vp_m);

			const relX = rp_px * Math.cos(phi);
			const relY = rp_px * Math.sin(phi);
			const relVx = -vp_px * Math.sin(phi);
			const relVy = vp_px * Math.cos(phi);

			const angle = Math.atan2(relVy, relVx);
			const options = Object.assign({ angle: angle }, genConfig.options || {});

			this.placeObject(genConfig.template, hostObj.x + relX, hostObj.y + relY, hostObj.vx + relVx, hostObj.vy + relVy, options);
		}
	}

	_deployCircularSwarm(hostObj, genConfig) {
		for (let i = 0; i < genConfig.count; i++) {
			const template = genConfig.templates[Math.floor(Math.random() * genConfig.templates.length)];
			const templateMass = DEFAULT_OBJECT_PARAMS[template].MASS;
			
			const r_au = genConfig.radiusAuMin + Math.random() * (genConfig.radiusAuMax - genConfig.radiusAuMin);
			const r_m = UnitConvertUtils.au2m(r_au);

			const totalMassKg = UnitConvertUtils.ton2kg(hostObj.mass + templateMass);
			const vc_m = Math.sqrt(PHYSICS.G * totalMassKg / r_m);

			const theta = Math.random() * Math.PI * 2;

			const r_px = UnitConvertUtils.m2pix(r_m);
			const vc_px = UnitConvertUtils.m2pix(vc_m);

			const relX = r_px * Math.cos(theta);
			const relY = r_px * Math.sin(theta);
			const relVx = -vc_px * Math.sin(theta);
			const relVy = vc_px * Math.cos(theta);

			const options = Object.assign({}, genConfig.options || {});

			this.placeObject(template, hostObj.x + relX, hostObj.y + relY, hostObj.vx + relVx, hostObj.vy + relVy, options);
		}
	}

	_deployBinarySystem(genConfig) {
		const canvas = this.universe.canvas;
		let cx = canvas.width / 2;
		let cy = canvas.height / 2;

		const existingObj = this.universe.objects[0];
		if (existingObj) {
			cx = existingObj.x;
			cy = existingObj.y;
		}

		const pConf = genConfig.primary || { template: 'Sun', name: 'Sun A' };
		const sConf = genConfig.secondary || { template: 'Sun', name: 'Sun B' };

		const pParam = DEFAULT_OBJECT_PARAMS[pConf.template] || DEFAULT_OBJECT_PARAMS['Sun'];
		const sParam = DEFAULT_OBJECT_PARAMS[sConf.template] || DEFAULT_OBJECT_PARAMS['Sun'];

		const m1 = pConf.mass !== undefined ? pConf.mass : pParam.MASS;
		const m2 = sConf.mass !== undefined ? sConf.mass : sParam.MASS;
		const mTotalKg = UnitConvertUtils.ton2kg(m1 + m2);

		const sepAu = genConfig.separationAu || 3.0;
		const d_m = UnitConvertUtils.au2m(sepAu);

		const r1_m = d_m * (m2 / (m1 + m2));
		const r2_m = d_m * (m1 / (m1 + m2));

		const vRel_m = Math.sqrt(PHYSICS.G * mTotalKg / d_m);
		const v1_m = vRel_m * (m2 / (m1 + m2));
		const v2_m = vRel_m * (m1 / (m1 + m2));

		const r1_px = UnitConvertUtils.m2pix(r1_m);
		const r2_px = UnitConvertUtils.m2pix(r2_m);
		const v1_px = UnitConvertUtils.m2pix(v1_m);
		const v2_px = UnitConvertUtils.m2pix(v2_m);

		let primaryObj = null;
		if (existingObj) {
			primaryObj = existingObj;
			primaryObj.name = pConf.name || "Sun A";
			primaryObj.color = pConf.color || pParam.COLOR;
			primaryObj._mass = m1;
			primaryObj.x = cx - r1_px;
			primaryObj.y = cy;
			primaryObj.vx = 0;
			primaryObj.vy = v1_px;
			primaryObj.ax = 0;
			primaryObj.ay = 0;
			if (primaryObj.trajectory) primaryObj.trajectory.clear();
			this.universe.ObjectManager.updateObject(primaryObj);
		} else {
			primaryObj = this.placeObject(pConf.template, cx - r1_px, cy, 0, v1_px, {
				name: pConf.name || "Sun A",
				color: pConf.color,
				mass: m1
			});
		}

		this.placeObject(sConf.template, cx + r2_px, cy, 0, -v2_px, {
			name: sConf.name || "Sun B",
			color: sConf.color,
			mass: m2
		});

		if (genConfig.planets && Array.isArray(genConfig.planets)) {
			genConfig.planets.forEach(pDef => {
				if (pDef.host === 'primary') {
					const m1Kg = UnitConvertUtils.ton2kg(m1);
					const dist_m = UnitConvertUtils.au2m(pDef.distanceAu || 0.35);
					const vOrb_m = Math.sqrt(PHYSICS.G * m1Kg / dist_m);
					const dist_px = UnitConvertUtils.m2pix(dist_m);
					const vOrb_px = UnitConvertUtils.m2pix(vOrb_m);

					const px = primaryObj.x;
					const py = primaryObj.y - dist_px;
					const pvx = primaryObj.vx - vOrb_px;
					const pvy = primaryObj.vy;

					const planet = this.placeObject(pDef.template, px, py, pvx, pvy, pDef.options || {});

					if (pDef.hasMoon) {
						const moonDist_m = UnitConvertUtils.au2m(0.00257);
						const moonV_m = Math.sqrt(PHYSICS.G * UnitConvertUtils.ton2kg(planet.mass) / moonDist_m);
						this.placeObject(
							"Moon",
							planet.x,
							planet.y - UnitConvertUtils.m2pix(moonDist_m),
							planet.vx - UnitConvertUtils.m2pix(moonV_m),
							planet.vy
						);
					}
				} else if (pDef.host === 'barycenter') {
					const dist_m = UnitConvertUtils.au2m(pDef.distanceAu || 7.0);
					const vOrb_m = Math.sqrt(PHYSICS.G * mTotalKg / dist_m);
					const dist_px = UnitConvertUtils.m2pix(dist_m);
					const vOrb_px = UnitConvertUtils.m2pix(vOrb_m);

					const px = cx;
					const py = cy + dist_px;
					const pvx = vOrb_px;
					const pvy = 0;

					this.placeObject(pDef.template, px, py, pvx, pvy, pDef.options || {});
				}
			});
		}

		EventBus.emit('camera:set-tracking-target', primaryObj);
	}

	_deployThreeBody(genConfig) {
		const canvas = this.universe.canvas;
		let cx = canvas.width / 2;
		let cy = canvas.height / 2;

		const existingObj = this.universe.objects[0];
		if (existingObj) {
			cx = existingObj.x;
			cy = existingObj.y;
		}

		const stars = genConfig.stars || [
			{ template: "Sun", name: "Sun A (Trisolaris 1)", color: "#FF4500" },
			{ template: "Sun", name: "Sun B (Trisolaris 2)", color: "#00E5FF" },
			{ template: "Sun", name: "Sun C (Trisolaris 3)", color: "#FFD700" }
		];

		const sunParam = DEFAULT_OBJECT_PARAMS['Sun'];
		const massTon = sunParam.MASS;
		const massKg = UnitConvertUtils.ton2kg(massTon);

		const radiusAu = genConfig.radiusAu || 3.0;
		const R_m = UnitConvertUtils.au2m(radiusAu);
		const R_px = UnitConvertUtils.m2pix(R_m);

		// Lagrange circular speed for equilateral triangle: v0 = sqrt(G * M / (sqrt(3) * R))
		const vLagrange_m = Math.sqrt(PHYSICS.G * massKg / (Math.sqrt(3) * R_m));
		const velRatio = genConfig.velocityRatio !== undefined ? genConfig.velocityRatio : 0.75;
		const vBase_m = vLagrange_m * velRatio;

		// 3 vertices at 90 deg, 210 deg, 330 deg
		const angles = [
			Math.PI / 2,
			Math.PI / 2 + (2 * Math.PI / 3),
			Math.PI / 2 + (4 * Math.PI / 3)
		];

		const deployedStars = [];

		for (let i = 0; i < 3; i++) {
			const theta = angles[i];
			const sConf = stars[i] || {};
			const color = sConf.color || sunParam.COLOR;
			const name = sConf.name || `Sun ${String.fromCharCode(65 + i)}`;

			// Coordinates (canvas y axis is downward)
			const posX = cx + R_px * Math.cos(theta);
			const posY = cy - R_px * Math.sin(theta);

			// Add small asymmetry to star B for rich chaotic evolution
			const speedMult = i === 1 ? 1.005 : 1.0;
			const v_m = vBase_m * speedMult;
			const v_px = UnitConvertUtils.m2pix(v_m);

			// Counter-clockwise velocity vector
			const velX = -v_px * Math.sin(theta);
			const velY = -v_px * Math.cos(theta);

			if (i === 0 && existingObj) {
				existingObj.name = name;
				existingObj.color = color;
				existingObj._mass = massTon;
				existingObj.x = posX;
				existingObj.y = posY;
				existingObj.vx = velX;
				existingObj.vy = velY;
				existingObj.ax = 0;
				existingObj.ay = 0;
				if (existingObj.trajectory) existingObj.trajectory.clear();
				this.universe.ObjectManager.updateObject(existingObj);
				deployedStars.push(existingObj);
			} else {
				const starObj = this.placeObject(sConf.template || "Sun", posX, posY, velX, velY, {
					name: name,
					color: color,
					mass: massTon
				});
				deployedStars.push(starObj);
			}
		}

		// Optional: Add Trisolaris planet (Earth) orbiting Star A
		if (genConfig.includePlanet) {
			const starA = deployedStars[0];
			const pDist_m = UnitConvertUtils.au2m(genConfig.planetDistanceAu || 0.35);
			const pDist_px = UnitConvertUtils.m2pix(pDist_m);
			const vOrb_m = Math.sqrt(PHYSICS.G * massKg / pDist_m);
			const vOrb_px = UnitConvertUtils.m2pix(vOrb_m);

			this.placeObject(
				"Earth",
				starA.x,
				starA.y - pDist_px,
				starA.vx - vOrb_px,
				starA.vy,
				{ name: "Earth (Trisolaris)" }
			);
		}

		EventBus.emit('camera:set-tracking-target', deployedStars[0]);
	}

	// --- Below are internal calculation/rendering methods ---

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
