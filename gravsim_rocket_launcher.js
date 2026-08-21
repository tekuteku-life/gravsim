
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
		
		// Setup parameters
		this.mode = 'host'; // 'free' or 'host'
		this.hostId = null;
		
		// Free mode coords
		this.freeX = 0;
		this.freeY = 0;

		// Host mode relative parameters
		this.hostAngleDeg = 270;
		this.hostAltitudeM = 10; // (m)

		// Rocket parameters
		this.dryMassT = 7;	// (t) Payload + empty structure
		this.fuelAmountT = 550; // (t)
		this.fuelType = 'liquid';
		this.launchAngleDeg = 270;
		this.thrustKN = 7000;	// (kN)
		this.calculatedBurnTime = 0;
		this.maxGLimit = 4.0;	// G
		this.autoControl = true; // Auto Flight Computer flag

		this.rolloutedRocketId = null;
		
		this.padEffect = new PadEffectRenderer();

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

		// Clear rollout state on liftoff so that the marker can be displayed for the next launch
		this.universe.on('liftoff', () => {
			if (this.rolloutedRocketId !== null) {
				const rocket = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
				if (rocket) rocket.isInternalPower = false;
			}
			this.rolloutedRocketId = null;
			this.padEffect.handleLiftoff();
		});
	}

	togglePreview(forceState = null) {
		this.isActive = forceState !== null ? forceState : !this.isActive;
		if (this.isActive && this.mode === 'free') {
			this.freeX = this.universe.centerObject.x;
			this.freeY = this.universe.centerObject.y;
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
		const m0 = (this.dryMassT + this.fuelAmountT) * 1e3; // Initial mass in kg
		const mf = this.dryMassT * 1e3; // Final mass in kg

		// Calculate Max Burn Time based on Thrust and Isp
		const massFlowRateKgS = (this.thrustKN * 1e3) / ve;
		this.calculatedBurnTime = massFlowRateKgS > 0 ? (this.fuelAmountT * 1e3) / massFlowRateKgS : 0;
		
		if (this.calculatedBurnTime > 0 && this.thrustKN > 0) {
			deltaVM = ve * Math.log(m0 / mf);
		}

		if (this.mode === 'host') {
			const host = this.universe.objects.find(o => o.id === this.hostId) || this.universe.centerObject;
			if (host) {
				const angleRad = this.hostAngleDeg * (Math.PI / 180);
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

		// Launch vector line
		ctx.rotate(this.launchAngleDeg * (Math.PI / 180));
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

	rollout() {
		if (this.mode !== 'host' || this.hostId === null) { return; }

		const host = this.universe.objects.find(o => o.id === this.hostId);
		if (!host) { return; }

		const t = this._calculateTransform();
		const massName = this.universe.ObjectPlacer.getLaunchObjectName();

		const initialMassTon = this.dryMassT + this.fuelAmountT;
		const finalMassTon = this.dryMassT;
		const massLossRateTon = this.calculatedBurnTime > 0 ? (initialMassTon - finalMassTon) / this.calculatedBurnTime : 0;

		const optParams = {
			force: this.thrustKN * 1e3,
			mass: initialMassTon,
			emptyMass: finalMassTon,
			angle: this.launchAngleDeg * (Math.PI / 180),
			time: this.calculatedBurnTime,
			lossRate: massLossRateTon,
			maxGLimit: this.maxGLimit,
			autoControl: this.autoControl,
			hostId: this.hostId,
			hostAngleRad: this.hostAngleDeg * (Math.PI / 180),
			hostAltM: this.hostAltitudeM,
			isHoldDown: true,
			isIgnited: false
		};

		const newRocket = this.universe.ObjectPlacer.placeObject(massName, t.x, t.y, t.vx, t.vy, optParams);
		this.rolloutedRocketId = newRocket.id;

		this.padEffect.start(newRocket.id, this.hostId);

		// Set new rocket to center object
		this.universe.ObjectManager.centerObject = newRocket;
		this.universe.ControlPanel.systemTab.updateCenterOptions();
		this.universe.InfoPanel.updateCamera(newRocket.name);

		// Zoom the rocket
		const systemTab = this.universe.ControlPanel.systemTab;
		if (systemTab && systemTab.ui.zoomScale) {
			const realRadiusPx = (newRocket.radius / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
			const targetSize = Math.min(this.universe.canvas.width, this.universe.canvas.height) / ROCKET_LAUNCHER_CONFIG.ZOOM_SCREEN_DIV;
			let idealExp = Math.log10(targetSize / realRadiusPx);

			const maxZoom = parseFloat(systemTab.ui.zoomScale.max);
			const minZoom = parseFloat(systemTab.ui.zoomScale.min);
			idealExp = Math.max(minZoom, Math.min(maxZoom, idealExp));

			systemTab.ui.zoomScale.value = idealExp.toFixed(2);
			systemTab.updateZoomScaleIndicator(systemTab.getZoomScale());
			this.universe.updateZoomScale();
		}

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

			this.universe.ControlPanel.rocketTab._setupLaunchEnvironment(this.hostId);
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
			zoomScale: this.universe.zoomScale
		};
	}

	update(dt) {
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
			hostAngleDeg: this.hostAngleDeg,
			hostAltitudeM: this.hostAltitudeM,
			launchAngleDeg: this.launchAngleDeg,
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
		if (state.hostAngleDeg !== undefined) this.hostAngleDeg = state.hostAngleDeg;
		if (state.hostAltitudeM !== undefined) this.hostAltitudeM = state.hostAltitudeM;
		if (state.launchAngleDeg !== undefined) this.launchAngleDeg = state.launchAngleDeg;
		if (state.initialMassT !== undefined) this.dryMassT = state.initialMassT;
		if (state.thrustKN !== undefined) this.thrustKN = state.thrustKN;
		if (state.burnTime !== undefined) this.calculatedBurnTime = state.burnTime;
		if (state.maxGLimit !== undefined) this.maxGLimit = state.maxGLimit;
		if (state.autoControl !== undefined) this.autoControl = state.autoControl;
	}
}
