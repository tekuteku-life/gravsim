
// gravsim_rocket_launcher.js

import {
	PHYSICS, RENDER, DEFAULT_OBJECT_PARAMS,
	ROCKET_FUELS, LAUNCH_SEQUENCES, EVENT_PRIORITY,
	TRAJECTORY_PREDICTION, OBJECT_TYPES, OBJECT_STATE
} from './gravsim_const.js';
import { UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';
import { TrajectoryPredictor } from './gravsim_trajectory_predictor.js';

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

		// Host mode relative parameters (0: zenith/up, 90: right, 180/-180: down, -90: left)
		this.hostAngleDeg = 0;
		this.hostAltitudeM = 10; // (m)

		// Rocket parameters
		this.dryMassT = 7;	// (t) Payload + empty structure
		this.fuelMassT = 88; // (t)
		this.oxidMassT = 220; // (t)
		this.fuelType = 'liquid';

		// Default Flight Profile
		this.flightProfile = [
			{ type: 'alt', value: 0, thrust: 100, angle: 0 },
			{ type: 'alt', value: 25000, thrust: 100, angle: 45 },
			{ type: 'alt', value: 70000, thrust: 100, angle: 90 }
		];

		this.thrustKN = 7600;	// (kN)
		this.calculatedBurnTime = 0;
		this.maxGLimit = 4.0;	// G
		this.predictionDurationMonths = 6;
		this.maxSimTimeSec = 6 * (365.25 / 12) * 86400; // 6 months in seconds
		this.autoControl = true; // Auto Flight Computer flag

		this.rolloutedRocketId = null;

		EventBus.on('sequencer-event', (eventName) => {
			if (eventName.includes('INTERNAL POWER') && this.rolloutedRocketId !== null) {
				const rocket = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
				if (rocket) { rocket.isInternalPower = true; }
			}
		});

		EventBus.on('liftoff', () => {
			if (this.rolloutedRocketId !== null) {
				const rocketId = this.rolloutedRocketId;
				const rocket = this.universe.objects.find(o => o.id === rocketId);
				if (rocket) {
					rocket.isInternalPower = false;
					rocket.flightTime = 0;
					if (rocket.telemetry) {
						rocket.telemetry.flightTime = 0;
					}
					const host = this.universe.objects.find(o => o.id === this.hostId) || this.universe.camera.trackingTarget;
					if (this.currentPrediction && host) {
						// Zero simulation cost: geometrically bake rotation difference from rollout to liftoff (0.05ms)
						const currentAngle = Math.atan2(rocket.y - host.y, rocket.x - host.x);
						const baseAngle = this.currentPrediction.baseHostAngleRad !== undefined
							? this.currentPrediction.baseHostAngleRad
							: currentAngle;
						const rotOffset = currentAngle - baseAngle;
						rocket.predictedTrajectory = TrajectoryPredictor.rotatePrediction(this.currentPrediction, rotOffset);
					}
				}
				// Release pad for next launch
				this.rolloutedRocketId = null;
				this.currentPrediction = null;
				this.isActive = false;
				if (this.universe.ControlPanel?.rocketTab) {
					this.universe.ControlPanel.rocketTab.setRolloutState(false);
				}
			}
		});

		EventBus.on('sequencer-start', () => {
			EventBus.emit('ui:set-tabs-locked', true);
			EventBus.emit('ui:set-controls-locked', true);
		});
		
		const unlockUI = () => {
			EventBus.emit('ui:set-tabs-locked', false);
			EventBus.emit('ui:set-controls-locked', false);
		};
		EventBus.on('sequencer-end', unlockUI);
		EventBus.on('sequencer-abort', unlockUI);

		this.predictor = new TrajectoryPredictor(this.universe);
		this.currentPrediction = null;

		// Hook into the main draw pipeline
		EventBus.onDrawAfter((ctx, rc) => {
			if (rc.name === 'main') {
				this.drawPreview(ctx, rc.basis, rc.zoomScale, rc);
			}
		}, EVENT_PRIORITY.DRAW_WORLD_FX);
	}

	togglePreview(forceState = null) {
		this.isActive = forceState !== null ? forceState : !this.isActive;
		if (this.isActive) {
			if (this.mode === 'free') {
				this.freeX = this.universe.camera.trackingTarget ? this.universe.camera.trackingTarget.x : 0;
				this.freeY = this.universe.camera.trackingTarget ? this.universe.camera.trackingTarget.y : 0;
			}
			this.requestPreviewUpdate(0);
		}
	}

	requestPreviewUpdate(delayMs = 150) {
		if (this.rolloutedRocketId !== null) {
			// Do not re-simulate while rocket is already on pad (rotation is handled by geometric plot)
			return;
		}
		clearTimeout(this._previewDebounceTimer);
		if (delayMs <= 0) {
			this.updatePrediction();
		} else {
			this._previewDebounceTimer = setTimeout(() => {
				this.updatePrediction();
			}, delayMs);
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

		const massName = 'Rocket';
		const param = DEFAULT_OBJECT_PARAMS[massName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		const fuel = ROCKET_FUELS[this.fuelType] || ROCKET_FUELS['liquid'];
		const ve = fuel.isp * PHYSICS.G0; // Exhaust velocity
		const m0 = UnitConvertUtils.ton2kg(this.dryMassT + this.fuelMassT + this.oxidMassT); // Initial mass in kg
		const mf = UnitConvertUtils.ton2kg(this.dryMassT); // Final mass in kg

		// Calculate Max Burn Time based on Thrust and Isp
		const massFlowRateKgS = UnitConvertUtils.kn2n(this.thrustKN) / ve;
		const totalPropellantT = this.fuelMassT + this.oxidMassT;
		this.calculatedBurnTime = massFlowRateKgS > 0 ? UnitConvertUtils.ton2kg(totalPropellantT) / massFlowRateKgS : 0;
		
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
		if (this.rolloutedRocketId !== null) { return; }

		const host = this.universe.objects.find(o => o.id === this.hostId);
		if (!host) { return; }

		const t = this._calculateTransform();
		if (!t) { return; }

		const relX = (t.x - centerObject.x) * zoomScale;
		const relY = (t.y - centerObject.y) * zoomScale;
		
		const objName = 'Rocket';
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

	_getPredictionContext() {
		if (this.mode !== 'host') { return null; }

		const host = this.universe.objects.find(o => o.id === this.hostId) || this.universe.camera.trackingTarget;
		if (!host) { return null; }

		const t = this._calculateTransform();
		if (!t) { return null; }

		let posX = t.x;
		let posY = t.y;
		let posVx = t.vx;
		let posVy = t.vy;
		let relX = t.x - host.x;
		let relY = t.y - host.y;
		let relVx = t.vx - host.vx;
		let relVy = t.vy - host.vy;

		const hAngleCanvas = (Number(this.hostAngleDeg) || 0) - 90;
		let hostAngleRad = UnitConvertUtils.deg2rad(hAngleCanvas);
		let currentThrustAngle = hostAngleRad;

		const rolloutedRocket = this.rolloutedRocketId !== null
			? this.universe.objects.find(o => o.id === this.rolloutedRocketId)
			: null;

		// If rocket is placed on the pad, use its actual rotating position and velocity on host surface
		if (rolloutedRocket) {
			posX = rolloutedRocket.x;
			posY = rolloutedRocket.y;
			posVx = rolloutedRocket.vx;
			posVy = rolloutedRocket.vy;
			relX = rolloutedRocket.x - host.x;
			relY = rolloutedRocket.y - host.y;
			relVx = rolloutedRocket.vx - host.vx;
			relVy = rolloutedRocket.vy - host.vy;
			hostAngleRad = Math.atan2(relY, relX);
			currentThrustAngle = rolloutedRocket.thrustAngle !== undefined ? rolloutedRocket.thrustAngle : hostAngleRad;
		}

		const config = {
			host: host,
			x: posX,
			y: posY,
			relX: relX,
			relY: relY,
			vx: posVx,
			vy: posVy,
			relVx: relVx,
			relVy: relVy,
			dryMassT: this.dryMassT,
			fuelMassT: this.fuelMassT,
			oxidMassT: this.oxidMassT,
			fuelType: this.fuelType,
			thrustKN: this.thrustKN,
			maxGLimit: this.maxGLimit,
			flightProfile: this.flightProfile,
			hostAngleRad: hostAngleRad,
			thrustAngle: currentThrustAngle,
			maxSimTime: this.maxSimTimeSec
		};

		return { host, hostAngleRad, config };
	}

	updatePredictionSync() {
		const ctx = this._getPredictionContext();
		if (!ctx) {
			this.currentPrediction = null;
			return null;
		}

		const prediction = this.predictor.calculateSync(ctx.config);
		if (prediction) {
			prediction.baseHostAngleRad = ctx.hostAngleRad;
		}
		this.currentPrediction = prediction;
		return prediction;
	}

	updatePrediction(force = false, onComplete = null) {
		const ctx = this._getPredictionContext();
		if (!ctx) {
			this.currentPrediction = null;
			if (onComplete) onComplete(null);
			return null;
		}

		const now = Date.now();
		const profileKey = this.flightProfile.map(s => `${s.type}:${s.value}:${s.thrust}:${s.angle}`).join('|');
		const currentKey = `${this.hostId}_${this.hostAngleDeg}_${this.hostAltitudeM}_${this.dryMassT}_${this.fuelMassT}_${this.oxidMassT}_${this.thrustKN}_${this.fuelType}_${this.maxGLimit}_${this.maxSimTimeSec}_${profileKey}`;

		if (!force && this.currentPrediction && currentKey === this._lastPredictKey && (now - (this._lastPredictTime || 0)) < TRAJECTORY_PREDICTION.UPDATE_THROTTLE_MS) {
			if (onComplete) onComplete(this.currentPrediction);
			return this.currentPrediction;
		}

		if (force) {
			const syncResult = this.predictor.calculateSync(ctx.config);
			if (syncResult) {
				syncResult.baseHostAngleRad = ctx.hostAngleRad;
			}
			this.currentPrediction = syncResult;
			this._lastPredictKey = currentKey;
			this._lastPredictTime = now;
			if (onComplete) onComplete(syncResult);
			return syncResult;
		}

		// Optimistic UI: Only show processing spinner overlay if prediction computation takes longer than 80ms
		let spinnerTimer = setTimeout(() => {
			const overlay = document.getElementById('prediction-processing-overlay');
			if (overlay) { overlay.style.display = 'flex'; }
		}, 80);

		this.predictor.requestPrediction(ctx.config, (prediction) => {
			clearTimeout(spinnerTimer);
			const overlay = document.getElementById('prediction-processing-overlay');
			if (overlay) { overlay.style.display = 'none'; }

			if (prediction) {
				prediction.baseHostAngleRad = ctx.hostAngleRad;
			}
			this.currentPrediction = prediction;
			if (onComplete) {
				onComplete(prediction);
			}
		});

		this.currentPrediction = this.predictor.prediction || this.predictor.calculateSync(ctx.config);
		if (this.currentPrediction) {
			this.currentPrediction.baseHostAngleRad = ctx.hostAngleRad;
		}
		this._lastPredictKey = currentKey;
		this._lastPredictTime = now;
		return this.currentPrediction;
	}

	drawPreview(ctx, centerObject, zoomScale, renderContext) {
		const isRollouted = this.rolloutedRocketId !== null;
		if (!this.isActive && !isRollouted) { return; }

		// Safeguard: If an active rocket is already flying with predicted trajectory, suppress launcher pad preview to prevent duplicate lines
		if (!isRollouted && this.universe.objects.some(
			o => o.type === OBJECT_TYPES.ROCKET && o.state === OBJECT_STATE.ACTIVE && !o.isHoldDown && o.predictedTrajectory
		)) {
			return;
		}

		if (this.mode === 'host') {
			this.drawTargetMarker(ctx, centerObject, zoomScale);

			// Render predicted trajectory: zero simulation overhead on draw loop!
			if (isRollouted) {
				const rolloutedRocket = this.universe.objects.find(o => o.id === this.rolloutedRocketId);
				const host = this.universe.objects.find(o => o.id === this.hostId) || this.universe.camera.trackingTarget;
				if (rolloutedRocket && rolloutedRocket.isHoldDown && this.currentPrediction && renderContext && host) {
					// Geometrically rotate cached prediction to match current rotating pad position
					const currentAngle = Math.atan2(rolloutedRocket.y - host.y, rolloutedRocket.x - host.x);
					const baseAngle = this.currentPrediction.baseHostAngleRad !== undefined
						? this.currentPrediction.baseHostAngleRad
						: currentAngle;
					const rotOffset = currentAngle - baseAngle;
					this.predictor.render(ctx, renderContext, {
						mode: 'preview',
						rotationOffset: rotOffset
					});
				}
				// Once launched (!isHoldDown), prediction preview stops to eliminate overhead; Rocket.draw handles in-flight guide
			} else {
				if (this.currentPrediction && renderContext) {
					this.predictor.render(ctx, renderContext, { mode: 'preview' });
				}
			}
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

		const hAngleCanvas = (Number(this.hostAngleDeg) || 0) - 90;
		const initialAngleRad = UnitConvertUtils.deg2rad(hAngleCanvas);

		const prediction = this.updatePredictionSync() || this.updatePrediction();
		if (prediction) {
			prediction.baseHostAngleRad = initialAngleRad;
			this.currentPrediction = prediction;
		}
		const t = this._calculateTransform();
		const massName = 'Rocket';

		const fuelDef = ROCKET_FUELS[this.fuelType] || ROCKET_FUELS['liquid'];
		const initialMassTon = this.dryMassT + this.fuelMassT + this.oxidMassT;
		const finalMassTon = this.dryMassT;
		const massLossRateTon = this.calculatedBurnTime > 0 ? (initialMassTon - finalMassTon) / this.calculatedBurnTime : 0;

		const optParams = {
			force: UnitConvertUtils.kn2n(this.thrustKN),
			mass: initialMassTon,
			emptyMass: finalMassTon,
			fuelMass: this.fuelMassT,
			oxidMass: this.oxidMassT,
			ofRatio: fuelDef.ofRatio,
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
		newRocket.predictedTrajectory = prediction ? JSON.parse(JSON.stringify(prediction)) : null;
		this.rolloutedRocketId = newRocket.id;

		// Emit event to start pad effect
		EventBus.emit('effect:pad-start', newRocket.id, this.hostId);

		// Activate dynamic auto tracking
		EventBus.emit('camera:set-auto-tracking', newRocket, host);

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

			// Emit event to stop pad effect
			EventBus.emit('effect:pad-stop');

			this.universe.ControlPanel.rocketTab.setRolloutState(false);

			const host = this.universe.objects.find(o => o.id === this.hostId);
			EventBus.emit('camera:stop-auto-tracking', host);
		}
	}

	ignite(sequenceType) {
		if (this.rolloutedRocketId === null) { return; }
		const sequence = LAUNCH_SEQUENCES[sequenceType];
		if (!sequence) { return; }
		this.universe.LaunchSequencer.start(sequence, this.rolloutedRocketId);
	}

	getState() {
		return {
			mode: this.mode,
			hostId: this.hostId,
			hostAngleDeg: Number(this.hostAngleDeg) || 0,
			hostAltitudeM: this.hostAltitudeM,
			flightProfile: JSON.parse(JSON.stringify(this.flightProfile)),
			initialMassT: this.dryMassT,
			fuelMassT: this.fuelMassT,
			oxidMassT: this.oxidMassT,
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
		if (state.fuelMassT !== undefined) this.fuelMassT = state.fuelMassT;
		if (state.oxidMassT !== undefined) this.oxidMassT = state.oxidMassT;
		if (state.thrustKN !== undefined) this.thrustKN = state.thrustKN;
		if (state.burnTime !== undefined) this.calculatedBurnTime = state.burnTime;
		if (state.maxGLimit !== undefined) this.maxGLimit = state.maxGLimit;
		if (state.autoControl !== undefined) this.autoControl = state.autoControl;
	}
}
