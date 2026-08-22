
// gravsim_rocket_launcher.js

import {
	PHYSICS, RENDER, DEFAULT_OBJECT_PARAMS,
	ROCKET_FUELS, LAUNCH_SEQUENCES,
	ROCKET_LAUNCHER_CONFIG
} from './gravsim_const.js';
import { UnitConvertUtils } from './gravsim_utils.js';
import { PadEffectRenderer } from './gravsim_pad_effect.js';

/*******************************************************************
 * RocketLauncher Class
 * Manages the preview state and rendering for continuous-thrust rocket launches.
*******************************************************************/
export class RocketLauncher {
	constructor(universe) {
		this.universe = universe;
		this.isActive = false;
		this.isAutoTracking = false;
		
		// Setup parameters
		this.mode = 'host'; // 'free' or 'host'
		this.hostId = null;
		
		// Free mode coords
		this.freeX = 0;
		this.freeY = 0;

		// Host mode relative parameters (0: zenith/up, 90: right, 180/-180: down, -90: left)
		this.hostAngleDeg = 0;
		this.hostAltitudeM = 10; // (m)

		// Rocket parameters
		this.dryMassT = 7;	// (t) Payload + empty structure
		this.fuelAmountT = 550; // (t)
		this.fuelType = 'liquid';

		// Default Flight Profile
		this.flightProfile = [
			{ type: 'alt', value: 0, thrust: 100, angle: 0 },
			{ type: 'alt', value: 10000, thrust: 100, angle: 45 },
			{ type: 'alt', value: 50000, thrust: 100, angle: 90 }
		];

		this.thrustKN = 7000;	// (kN)
		this.calculatedBurnTime = 0;
		this.maxGLimit = 4.0;	// G
		this.autoControl = true; // Auto Flight Computer flag

		this.rolloutedRocketId = null;
		
		this.padEffect = new PadEffectRenderer();

		// Register update hook
		this.universe.addUpdateHook((dt, scaledDt) => this.update(scaledDt));

		// Register hooks using Pub/Sub
		this.universe.Renderer.addDrawHook('before', (ctx, rc) => {
			if (!this.isActive || !this.padEffect.isActive) { return; }
			const context = this._buildPadContext();
			if (context) { this.padEffect.drawBackground(ctx, rc, context); }
		});

		this.universe.Renderer.addDrawHook('after', (ctx, rc) => {
			if (!this.isActive || !this.padEffect.isActive) { return; }
			const context = this._buildPadContext();
			if (context) { this.padEffect.drawForeground(ctx, rc, context); }
		});

		this.universe.on('sequencer-event', (eventName) => {
			this.padEffect.handleEvent(eventName);
			if (eventName.includes('INTERNAL POWER') && this.rolloutedRocketId !== null) {
				const rocket = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
				if (rocket) { rocket.isInternalPower = true; }
			}
		});

		this.universe.on('liftoff', () => {
			if (this.rolloutedRocketId !== null) {
				const rocket = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
				if (rocket) rocket.isInternalPower = false;
			}
			this.padEffect.handleLiftoff();
		});
	}

	togglePreview(forceState = null) {
		this.isActive = forceState !== null ? forceState : !this.isActive;
		if (this.isActive && this.mode === 'free') {
			this.freeX = this.universe.camera.trackingTarget ? this.universe.camera.trackingTarget.x : 0;
			this.freeY = this.universe.camera.trackingTarget ? this.universe.camera.trackingTarget.y : 0;
		}
	}

	setFreePosition(x, y) {
		this.freeX = x;
		this.freeY = y;
	}

	// Calculate absolute position and base velocity
	_calculateTransform() {
		let posX = this.freeX;
		let posY = this.freeY;
		let baseVx = 0;
		let baseVy = 0;
		let deltaVM = 0;

		const massName = this.universe.ObjectPlacer.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[massName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		const fuel = ROCKET_FUELS[this.fuelType] || ROCKET_FUELS['liquid'];
		const ve = fuel.isp * PHYSICS.G0; // Exhaust velocity
		const m0 = UnitConvertUtils.ton2kg(this.dryMassT + this.fuelAmountT); // Initial mass in kg
		const mf = UnitConvertUtils.ton2kg(this.dryMassT); // Final mass in kg

		// Calculate Max Burn Time based on Thrust and Isp
		const massFlowRateKgS = UnitConvertUtils.kn2n(this.thrustKN) / ve;
		this.calculatedBurnTime = massFlowRateKgS > 0 ? UnitConvertUtils.ton2kg(this.fuelAmountT) / massFlowRateKgS : 0;
		
		if (this.calculatedBurnTime > 0 && this.thrustKN > 0) {
			deltaVM = ve * Math.log(m0 / mf);
		}

		if (this.mode === 'host') {
			const host = this.universe.objects.find(o => o.id === this.hostId) || this.universe.camera.trackingTarget;
			if (host) {
				// Canvas 0 deg is right, -90 deg is up. Convert user zenith(0) to canvas(-90).
				const hAngleCanvas = (Number(this.hostAngleDeg) || 0) - 90;
				const angleRad = UnitConvertUtils.deg2rad(hAngleCanvas);
				const distance = host.radius + (param.RADIUS || 1) + this.hostAltitudeM;
				
				const distPx = UnitConvertUtils.m2pix(distance);
				const dxPx = Math.cos(angleRad) * distPx;
				const dyPx = Math.sin(angleRad) * distPx;
				
				posX = host.x + dxPx;
				posY = host.y + dyPx;
				
				baseVx = host.vx;
				baseVy = host.vy;

				// Add host's rotation speed to rocket initial speed
				const hostParam = DEFAULT_OBJECT_PARAMS[host.name];
				if (hostParam && hostParam.ROTATION_PERIOD) {
					const omega = (2 * Math.PI) / hostParam.ROTATION_PERIOD;
					baseVx += -omega * dyPx;
					baseVy += omega * dxPx;
				}
			}
		}

		return {
			x: posX, y: posY, vx: baseVx, vy: baseVy, deltaVM: deltaVM
		};
	}

	drawTargetMarker(ctx, centerObject, zoomScale) {
		if (this.mode !== 'host' || this.hostId === null) { return; }
		if (this.rolloutedRocketId !== null || this.padEffect.isActive) { return; }

		const host = this.universe.objects.find(o => o.id === this.hostId);
		if (!host) { return; }

		const t = this._calculateTransform();
		if (!t) { return; }

		const relX = (t.x - centerObject.x) * zoomScale;
		const relY = (t.y - centerObject.y) * zoomScale;
		
		const objName = this.universe.ObjectPlacer.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		const rocketRadiusM = param.RADIUS || 1;
		const screenRadiusPx = UnitConvertUtils.m2pix(rocketRadiusM) * zoomScale;
		const conf = RENDER.MARKER;
		const mSize = Math.max(conf.HOST_MIN_SIZE, screenRadiusPx);
		
		ctx.save();
		ctx.translate(relX, relY);

		// Blueprint-style bounding box
		ctx.strokeStyle = conf.HOST_COLOR;
		ctx.lineWidth = 1.5;
		
		const b = mSize * conf.HOST_BOX_MULT;
		const l = b * conf.HOST_LINE_FRAC;

		ctx.beginPath();
		ctx.moveTo(-b, -b + l); ctx.lineTo(-b, -b); ctx.lineTo(-b + l, -b);
		ctx.moveTo(b - l, -b); ctx.lineTo(b, -b); ctx.lineTo(b, -b + l);
		ctx.moveTo(b, b - l); ctx.lineTo(b, b); ctx.lineTo(b - l, b);
		ctx.moveTo(-b + l, b); ctx.lineTo(-b, b); ctx.lineTo(-b, b - l);
		ctx.stroke();

		// Center dot
		ctx.fillStyle = conf.HOST_FILL;
		ctx.beginPath();
		ctx.arc(0, 0, 2, 0, Math.PI * 2);
		ctx.fill();

		// Launch vector line (Absolute angle = Canvas Host Angle + Relative Launch Angle)
		const hAngleCanvas = (Number(this.hostAngleDeg) || 0) - 90;
		const lAngle = this.flightProfile.length > 0 ? Number(this.flightProfile[0].angle) : 0;
		const absLaunchAngleDeg = hAngleCanvas + lAngle;

		ctx.rotate(UnitConvertUtils.deg2rad(absLaunchAngleDeg));
		ctx.strokeStyle = conf.HOST_FILL;
		ctx.setLineDash(conf.HOST_DASH);
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(b * conf.HOST_VECTOR_MULT, 0);
		ctx.stroke();

		ctx.restore();
	}

	drawPreview(ctx, centerObject, zoomScale) {
		if (!this.isActive) { return; }

		if (this.mode === 'host') {
			this.drawTargetMarker(ctx, centerObject, zoomScale);
		} else if (this.mode === 'free') {
			const transform = this._calculateTransform();
			if (!transform) { return; }

			const relX = (transform.x - centerObject.x) * zoomScale;
			const relY = (transform.y - centerObject.y) * zoomScale;
			const conf = RENDER.MARKER;

			ctx.save();
			ctx.strokeStyle = conf.FREE_COLOR;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(relX, relY, conf.FREE_RADIUS, 0, Math.PI * 2);
			ctx.moveTo(relX - conf.FREE_CROSS, relY);
			ctx.lineTo(relX + conf.FREE_CROSS, relY);
			ctx.moveTo(relX, relY - conf.FREE_CROSS);
			ctx.lineTo(relX, relY + conf.FREE_CROSS);
			ctx.stroke();
			ctx.restore();
		}
	}

	_stopAutoTracking(host) {
		this.isAutoTracking = false;
		
		const rocket = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
		if (!rocket || !rocket.isHoldDown) {
			this.rolloutedRocketId = null;
		}

		if (host) {
			this.universe.camera.setTrackingTarget(host);
			this.universe.camera.setTargetRotation(0);
			
			// Calculate zoom to fit host gracefully
			const hostRadiusPx = UnitConvertUtils.m2pix(host.radius);
			const targetSize = Math.min(this.universe.canvas.width, this.universe.canvas.height) / 2.2;
			let idealExp = Math.log10(targetSize / hostRadiusPx);

			const maxZoom = parseFloat(this.universe.ControlPanel.systemTab.ui.zoomScale.max);
			const minZoom = parseFloat(this.universe.ControlPanel.systemTab.ui.zoomScale.min);
			idealExp = Math.max(minZoom, Math.min(maxZoom, idealExp));
			
			this.universe.camera.setTargetZoomExp(idealExp);
			
			// Sync UI
			this.universe.ControlPanel.systemTab.ui.zoomScale.value = idealExp.toFixed(2);
			this.universe.ControlPanel.systemTab.updateZoomScaleIndicator(Math.pow(10, idealExp));
		}
	}

	rollout() {
		if (this.mode !== 'host' || this.hostId === null) { return; }

		const host = this.universe.objects.find(o => o.id === this.hostId);
		if (!host) { return; }

		const t = this._calculateTransform();
		const massName = this.universe.ObjectPlacer.getLaunchObjectName();

		const initialMassTon = this.dryMassT + this.fuelAmountT;
		const finalMassTon = this.dryMassT;
		const massLossRateTon = this.calculatedBurnTime > 0 ? (initialMassTon - finalMassTon) / this.calculatedBurnTime : 0;

		const hAngleCanvas = (Number(this.hostAngleDeg) || 0) - 90;

		const initialAngleRad = UnitConvertUtils.deg2rad(hAngleCanvas);

		const optParams = {
			force: UnitConvertUtils.kn2n(this.thrustKN),
			mass: initialMassTon,
			emptyMass: finalMassTon,
			angle: initialAngleRad, // Initially set to zenith direction
			flightProfile: this.flightProfile, // Profile is handled dynamically by FlightComputer
			time: this.calculatedBurnTime,
			lossRate: massLossRateTon,
			maxGLimit: this.maxGLimit,
			autoControl: this.autoControl,
			hostId: this.hostId,
			hostAngleRad: UnitConvertUtils.deg2rad(hAngleCanvas),
			hostAltM: this.hostAltitudeM,
			isHoldDown: true,
			isIgnited: false
		};

		const newRocket = this.universe.ObjectPlacer.placeObject(massName, t.x, t.y, t.vx, t.vy, optParams);
		this.rolloutedRocketId = newRocket.id;

		this.padEffect.start(newRocket.id, this.hostId);

		// Activate dynamic auto tracking
		this.isAutoTracking = true;

		// Set new rocket to center object
		this.universe.camera.setTrackingTarget(newRocket);
		this.universe.camera.setTargetOffset(0, 0);

		this.universe.ControlPanel.systemTab.updateCenterOptions();
		this.universe.InfoPanel.updateCamera(newRocket.name);

		// Open telemetry
		this.universe.TelemetryPanel.open();

		this.universe.ControlPanel.rocketTab.setRolloutState(true);
	}

	abortRollout() {
		if (this.rolloutedRocketId !== null) {
			this.universe.LaunchSequencer.abort();

			const obj = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
			if (obj) {
				this.universe.ObjectManager.removeObject(obj);
			}
			this.rolloutedRocketId = null;
			this.padEffect.stop();
			this.universe.ControlPanel.rocketTab.setRolloutState(false);

			const host = this.universe.objects.find(o => o.id === this.hostId);
			this._stopAutoTracking(host);
		}
	}

	ignite(sequenceType) {
		if (this.rolloutedRocketId === null) { return; }
		const sequence = LAUNCH_SEQUENCES[sequenceType];
		if (!sequence) { return; }
		this.universe.LaunchSequencer.start(sequence, this.rolloutedRocketId);
	}

	_buildPadContext() {
		const rocket = this.universe.objects.find(o => o.id === this.padEffect.targetRocketId);
		const host = this.universe.objects.find(o => o.id === this.padEffect.hostId);
		return {
			rocket: rocket,
			host: host,
			m2pix: (m) => UnitConvertUtils.m2pix(m),
			zoomScale: this.universe.camera.getRenderState().zoomScale
		};
	}

	_autoTracking(dt) {
		if (this.isAutoTracking) {
			const rocket = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
			const host = this.universe.objects.find(o => o.id === this.hostId);
			
			if (rocket && host) {
				this.universe.camera.setTrackingTarget(rocket);
				this.universe.camera.setTargetOffset(0, 0);

				const dx = rocket.x - host.x;
				const dy = rocket.y - host.y;
				
				// Apply rotation to keep the earth at the bottom of the screen
				const angle = Math.atan2(dy, dx);
				this.universe.camera.setTargetRotation(-angle - Math.PI / 2);

				// Calculate zoom to keep ground around the bottom 10%
				const altM = UnitConvertUtils.pix2m(Math.sqrt(dx * dx + dy * dy)) - host.radius;
				const canvasHeight = this.universe.canvas.height;
				const minAltM = 200; // clamp minimum virtual altitude for zoom
				const clampedAltM = Math.max(minAltM, altM);
				const clampedDistPx = UnitConvertUtils.m2pix(clampedAltM);
				
				let targetZoom = (canvasHeight * 0.4) / clampedDistPx;

				// Restrict zoom out limit
				const minZoom = Math.pow(10, parseFloat(this.universe.ControlPanel.systemTab.ui.zoomScale.min));
				const maxZoom = Math.pow(10, parseFloat(this.universe.ControlPanel.systemTab.ui.zoomScale.max));
				targetZoom = Math.max(minZoom, Math.min(maxZoom, targetZoom));
				
				this.universe.camera.setTargetZoomExp(Math.log10(targetZoom));
				
				// Sync UI slider during tracking
				this.universe.ControlPanel.systemTab.ui.zoomScale.value = Math.log10(targetZoom).toFixed(2);
				this.universe.ControlPanel.systemTab.updateZoomScaleIndicator(targetZoom);

				// Reached max altitude limit, stop tracking
				if (altM > host.radius * 0.2) {
					this._stopAutoTracking(host);
				}
			} else {
				this._stopAutoTracking(host);
			}
		}
	}

	update(dt) {
		this._autoTracking();

		if (this.padEffect && this.padEffect.isActive) {
			const context = this._buildPadContext();
			if (context) this.padEffect.update(dt, context);
			
			if (this.padEffect.targetRocketId) {
				const rocket = this.universe.objects.find(o => o.id === this.padEffect.targetRocketId);
				if (rocket && rocket.telemetry && rocket.telemetry.altM > ROCKET_LAUNCHER_CONFIG.EFFECT_STOP_ALT_M) {
					this.padEffect.stop();
				} else if (!rocket) {
					this.padEffect.stop();
				}
			}
		}
	}

	getState() {
		return {
			mode: this.mode,
			hostId: this.hostId,
			hostAngleDeg: Number(this.hostAngleDeg) || 0,
			hostAltitudeM: this.hostAltitudeM,
			flightProfile: JSON.parse(JSON.stringify(this.flightProfile)),
			initialMassT: this.dryMassT,
			thrustKN: this.thrustKN,
			burnTime: this.calculatedBurnTime,
			maxGLimit: this.maxGLimit,
			autoControl: this.autoControl
		};
	}

	loadState(state) {
		if (!state) return;
		if (state.mode !== undefined) this.mode = state.mode;
		if (state.hostId !== undefined) this.hostId = state.hostId;
		if (state.hostAngleDeg !== undefined) this.hostAngleDeg = Number(state.hostAngleDeg) || 0;
		if (state.hostAltitudeM !== undefined) this.hostAltitudeM = state.hostAltitudeM;
		if (state.flightProfile !== undefined) { this.flightProfile = JSON.parse(JSON.stringify(state.flightProfile)); }
		if (state.initialMassT !== undefined) this.dryMassT = state.initialMassT;
		if (state.thrustKN !== undefined) this.thrustKN = state.thrustKN;
		if (state.burnTime !== undefined) this.calculatedBurnTime = state.burnTime;
		if (state.maxGLimit !== undefined) this.maxGLimit = state.maxGLimit;
		if (state.autoControl !== undefined) this.autoControl = state.autoControl;
	}
}
