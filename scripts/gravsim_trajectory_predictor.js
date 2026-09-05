// gravsim_trajectory_predictor.js

import {
	PHYSICS, SIMULATION, RENDER, DEFAULT_OBJECT_PARAMS,
	ROCKET_FUELS, OBJECT_TYPES, DEFAULT_FLIGHT_EVENTS,
	TRAJECTORY_PREDICTION, TELEMETRY, OBJECT_STATE
} from './gravsim_const.js';
import { UnitConvertUtils, MathUtils } from './gravsim_utils.js';
import { runMultiBodySimulation } from './gravsim_calc_predictor.js';

/*******************************************************************
 * TrajectoryPredictor Class
 * Manages trajectory prediction using a dedicated fast-forward
 * Predictor Web Worker in Host-Centered reference frame.
 * Renders predicted paths and H3-style flight event markers.
 *******************************************************************/
export class TrajectoryPredictor {
	constructor(universe) {
		this.universe = universe;

		// Cache of predicted trajectory data
		this.prediction = null;
		this.isStale = true;

		// Worker management
		this._worker = null;
		this._requestId = 0;
		this._latestProcessedId = 0;
		this._pendingCallbacks = new Map();
		this._isBusy = false;
		this._nextPendingRequest = null;

		if (this.universe) {
			this._initWorker();
		}
	}

	_initWorker() {
		try {
			const workerUrl = new URL('./gravsim_calc_predictor.js', import.meta.url);
			this._worker = new Worker(workerUrl, { type: 'module' });

			this._worker.onmessage = (e) => {
				const data = e.data;
				if (data.cmd === 'predictionResult') {
					this._isBusy = false;

					if (data.requestId >= this._latestProcessedId) {
						this._latestProcessedId = data.requestId;
						this.prediction = {
							hostId: data.hostId,
							points: data.points,
							events: data.events,
							isOrbital: data.isOrbital,
							maxSimTime: data.maxSimTime || TRAJECTORY_PREDICTION.MAX_SIM_TIME_SEC,
							maxAltM: data.maxAltM,
							maxQ: data.maxQ
						};
						this.isStale = false;

						const cb = this._pendingCallbacks.get(data.requestId);
						if (cb) {
							cb(this.prediction);
						}
					}
					this._pendingCallbacks.delete(data.requestId);

					// Process coalesced pending request if exists
					if (this._nextPendingRequest) {
						const { config, callback } = this._nextPendingRequest;
						this._nextPendingRequest = null;
						this.requestPrediction(config, callback);
					}
				}
			};

			this._worker.onerror = (err) => {
				console.warn('[TrajectoryPredictor] Worker error, falling back to sync:', err);
				this._isBusy = false;
			};
		} catch (err) {
			console.warn('[TrajectoryPredictor] Could not create Worker, will use sync calculation:', err);
			this._worker = null;
		}
	}

	/**
	 * Build simulation input parameters from high-level launch configuration.
	 * Shared between asynchronous Worker requests and synchronous calculation.
	 * @private
	 */
	_buildSimulationParams(config) {
		const host = config.host;
		if (!host) { return null; }

		const hostParam = DEFAULT_OBJECT_PARAMS[host.name] || DEFAULT_OBJECT_PARAMS['Earth'];
		const hostOmega = hostParam.ROTATION_PERIOD ? (2 * Math.PI) / hostParam.ROTATION_PERIOD : 0;

		const fuelDef = ROCKET_FUELS[config.fuelType] || ROCKET_FUELS['liquid'];
		const isp = fuelDef.isp || 320;
		const ve = isp * PHYSICS.G0;
		const thrustN = UnitConvertUtils.kn2n(config.thrustKN || 7600);
		const massFlowRateKgS = ve > 0 ? thrustN / ve : 0;
		const totalPropellantKg = UnitConvertUtils.ton2kg((config.fuelMassT || 88) + (config.oxidMassT || 220));
		const calculatedBurnTime = massFlowRateKgS > 0 ? totalPropellantKg / massFlowRateKgS : 0;

		const hostX_m = UnitConvertUtils.pix2m(host.x);
		const hostY_m = UnitConvertUtils.pix2m(host.y);
		const hostVx_m = UnitConvertUtils.pix2m(host.vx);
		const hostVy_m = UnitConvertUtils.pix2m(host.vy);

		let rocketX_m;
		let rocketY_m;
		if (config.x !== undefined && config.y !== undefined) {
			rocketX_m = UnitConvertUtils.pix2m(config.x);
			rocketY_m = UnitConvertUtils.pix2m(config.y);
		} else {
			const relX_px = config.relX !== undefined ? config.relX : 0;
			const relY_px = config.relY !== undefined ? config.relY : 0;
			rocketX_m = hostX_m + UnitConvertUtils.pix2m(relX_px);
			rocketY_m = hostY_m + UnitConvertUtils.pix2m(relY_px);
		}

		const dx_m = rocketX_m - hostX_m;
		const dy_m = rocketY_m - hostY_m;

		let rocketVx_m;
		let rocketVy_m;
		if (config.vx !== undefined && config.vy !== undefined) {
			rocketVx_m = UnitConvertUtils.pix2m(config.vx);
			rocketVy_m = UnitConvertUtils.pix2m(config.vy);
		} else if (config.relVx !== undefined && config.relVy !== undefined) {
			rocketVx_m = hostVx_m + UnitConvertUtils.pix2m(config.relVx);
			rocketVy_m = hostVy_m + UnitConvertUtils.pix2m(config.relVy);
		} else {
			// Surface fixed velocity due to host planetary rotation
			rocketVx_m = hostVx_m - hostOmega * dy_m;
			rocketVy_m = hostVy_m + hostOmega * dx_m;
		}

		const initialZenithRad = Math.atan2(dy_m, dx_m);
		const thrustAngle = config.thrustAngle !== undefined
			? config.thrustAngle
			: (config.hostAngleRad !== undefined ? config.hostAngleRad : initialZenithRad);

		const rocketConfig = {
			name: config.name || 'Rocket',
			x: rocketX_m,
			y: rocketY_m,
			vx: rocketVx_m,
			vy: rocketVy_m,
			radius: config.radius || 1,
			dryMassKg: UnitConvertUtils.ton2kg(config.dryMassT || 7),
			fuelMassKg: UnitConvertUtils.ton2kg(config.fuelMassT || 88),
			oxidMassKg: UnitConvertUtils.ton2kg(config.oxidMassT || 220),
			ofRatio: config.ofRatio || fuelDef.ofRatio || 0,
			thrustForceN: thrustN,
			burnTime: config.burnTime !== undefined ? config.burnTime : calculatedBurnTime,
			thrustAngle: thrustAngle,
			flightProfile: config.flightProfile || [],
			maxGLimit: config.maxGLimit || 4.0,
			massLossRateKg: massFlowRateKgS,
			hostAngleRad: config.hostAngleRad !== undefined ? config.hostAngleRad : initialZenithRad,
			hostAltM: config.hostAltitudeM || 0
		};

		// Collect all celestial bodies with full inertial coordinates and velocities
		const celestialBodies = [];
		if (this.universe && this.universe.objects) {
			for (const obj of this.universe.objects) {
				if (obj.type === OBJECT_TYPES.CELESTIAL) {
					celestialBodies.push({
						id: obj.id,
						name: obj.name,
						radius: obj.radius,
						massKg: UnitConvertUtils.ton2kg(obj.mass),
						x: UnitConvertUtils.pix2m(obj.x),
						y: UnitConvertUtils.pix2m(obj.y),
						vx: UnitConvertUtils.pix2m(obj.vx),
						vy: UnitConvertUtils.pix2m(obj.vy)
					});
				}
			}
		}

		return {
			hostId: host.id,
			celestialBodies: celestialBodies,
			rocketConfig: rocketConfig,
			eventDefinitions: config.eventDefinitions || DEFAULT_FLIGHT_EVENTS,
			options: {
				maxSimTime: config.maxSimTime || TRAJECTORY_PREDICTION.MAX_SIM_TIME_SEC,
				maxSteps: config.maxSteps,
				maxPoints: config.maxPoints || TRAJECTORY_PREDICTION.MAX_POINTS
			}
		};
	}

	/**
	 * Send fast-forward simulation request to the Predictor Worker.
	 * Coalesces rapid sequential requests to prevent thread congestion.
	 * @param {Object} config - Initial rocket and launch configuration.
	 * @param {Function} [callback] - Optional callback upon receiving results.
	 * @returns {number} requestId
	 */
	requestPrediction(config, callback = null) {
		const host = config.host;
		if (!host) { return 0; }

		// If Worker is busy computing, store as next pending request
		if (this._isBusy) {
			this._nextPendingRequest = { config, callback };
			return this._requestId;
		}

		const simParams = this._buildSimulationParams(config);
		if (!simParams) { return 0; }

		const requestId = ++this._requestId;
		if (callback) {
			this._pendingCallbacks.set(requestId, callback);
		}

		if (this._worker) {
			this._isBusy = true;
			this._worker.postMessage({
				cmd: 'predict',
				requestId: requestId,
				...simParams
			});
		} else {
			// Synchronous fallback
			const res = this.calculateSync(config);
			if (callback) {
				callback(res);
			}
		}

		return requestId;
	}

	/**
	 * Synchronous calculate method (provides immediate return and triggers worker update)
	 * @param {Object} config - Initial rocket and launch configuration.
	 * @returns {Object} Current or synchronously computed prediction.
	 */
	calculate(config) {
		this.requestPrediction(config);
		if (this.prediction && this.prediction.points && this.prediction.points.length > 0) {
			return this.prediction;
		}
		return this.calculateSync(config);
	}

	/**
	 * Run synchronous forward numerical integration in the inertial multi-body frame.
	 * @param {Object} config - Initial rocket and launch configuration.
	 * @returns {Object} Calculated trajectory points and events.
	 */
	calculateSync(config) {
		const simParams = this._buildSimulationParams(config);
		if (!simParams) { return null; }

		const result = runMultiBodySimulation(simParams);
		this.prediction = result;
		this.isStale = false;
		return this.prediction;
	}

	/**
	 * Instance rendering method for current prediction.
	 * @param {CanvasRenderingContext2D} ctx
	 * @param {Object} renderContext
	 * @param {Object} [options]
	 */
	render(ctx, renderContext, options = {}) {
		if (!this.prediction) { return; }
		const opts = {
			showPredictedTrajectory: renderContext?.showPredictedTrajectory !== false,
			showActualPath: renderContext?.showActualFlightPath !== false,
			...options
		};
		TrajectoryPredictor.renderTrajectory(ctx, renderContext, this.prediction, opts);
	}

	/**
	 * Update passed status of predicted flight events against in-flight rocket telemetry.
	 * Decouples event detection rules from Rocket instance rendering.
	 * @param {Object} rocket - Flying rocket instance.
	 * @param {Object} [renderContext] - Optional canvas render state.
	 */
	static updateRocketFlightEvents(rocket, renderContext = null) {
		if (!rocket || !rocket.predictedTrajectory || !rocket.predictedTrajectory.events) { return; }

		const status = rocket.telemetry?.status;
		const altM = rocket.telemetry?.altM || 0;
		const vV = rocket.telemetry?.vV || 0;
		const flightTime = rocket.telemetry?.flightTime || rocket.flightTime || 0;

		rocket.predictedTrajectory.events.forEach(ev => {
			if (rocket.passedEventIds.has(ev.id)) { return; }

			let passed = false;
			const eventType = ev.type || ev.id;

			switch (eventType) {
				case 'liftoff':
					if (!rocket.isHoldDown) {
						passed = true;
					}
					break;
				case 'pitch':
					if (flightTime >= 1.0 && (altM >= (ev.altM || TRAJECTORY_PREDICTION.EVENTS.PITCH_MIN_ALT_M) || (ev.time && flightTime >= ev.time))) {
						passed = true;
					}
					break;
				case 'maxq':
					if (status >= TELEMETRY.STATUS.MAX_Q || altM >= (ev.altM || TRAJECTORY_PREDICTION.EVENTS.MAX_Q_DEFAULT_ALT_M)) {
						passed = true;
					}
					break;
				case 'meco':
					if (status >= TELEMETRY.STATUS.MECO || rocket.fuelMass <= 0 || rocket.burnTime <= 0) {
						passed = true;
					}
					break;
				case 'alt': {
					const targetAlt = ev.value !== undefined ? ev.value : ev.altM;
					if (targetAlt !== undefined && altM >= targetAlt) {
						passed = true;
					}
					break;
				}
				case 'time': {
					const targetTime = ev.value !== undefined ? ev.value : ev.time;
					if (targetTime !== undefined && flightTime >= targetTime) {
						passed = true;
					}
					break;
				}
				case 'apoapsis':
				case 'ap':
					if (vV < TRAJECTORY_PREDICTION.EVENTS.APOAPSIS_DESCENDING_VV_M_S && altM > TRAJECTORY_PREDICTION.EVENTS.APOAPSIS_MIN_ALT_M) {
						passed = true;
					}
					break;
				case 'orbit': {
					const hostObj = (renderContext && renderContext.objectsMap && rocket.hostId !== null)
						? renderContext.objectsMap.get(rocket.hostId)
						: renderContext?.basis;
					if (hostObj) {
						const dx_m = UnitConvertUtils.pix2m(rocket.x - hostObj.x);
						const dy_m = UnitConvertUtils.pix2m(rocket.y - hostObj.y);
						const dist_m = Math.sqrt(dx_m * dx_m + dy_m * dy_m);
						const uRx = dist_m > 0 ? dx_m / dist_m : 0;
						const uRy = dist_m > 0 ? dy_m / dist_m : 1;
						const uHx = -uRy;
						const uHy = uRx;
						const relVx_m = UnitConvertUtils.pix2m(rocket.vx - hostObj.vx);
						const relVy_m = UnitConvertUtils.pix2m(rocket.vy - hostObj.vy);
						const vTangential = Math.abs(relVx_m * uHx + relVy_m * uHy);
						const hostMassKg = UnitConvertUtils.ton2kg(hostObj.mass);
						const vCirc = Math.sqrt((PHYSICS.G * hostMassKg) / dist_m);
						const isOrbitalSpeed = vTangential >= vCirc * TRAJECTORY_PREDICTION.EVENTS.ORBIT_CIRC_RATIO;
						if (altM >= TRAJECTORY_PREDICTION.EVENTS.ORBIT_MIN_ALT_M && isOrbitalSpeed) {
							passed = true;
						}
					}
					if (!passed && ev.time && flightTime >= ev.time && altM >= TRAJECTORY_PREDICTION.EVENTS.ORBIT_MIN_ALT_M) {
						passed = true;
					}
					break;
				}
				case 'impact':
					if (rocket.state === OBJECT_STATE.REMOVED || rocket.isDestroyed || altM <= 0) {
						passed = true;
					}
					break;
			}

			if (passed) {
				rocket.passedEventIds.add(ev.id);
				ev.passed = true;
			}
		});
	}

	/**
	 * Static rendering method for predicted path and flight event markers.
	 * Can be called by Rocket instances without creating separate Worker instances.
	 */
	static renderTrajectory(ctx, renderContext, prediction, options = {}) {
		if (!prediction || !prediction.points || prediction.points.length < 2) {
			return;
		}

		const hostId = prediction.hostId;
		let hostObj = null;
		if (renderContext.objectsMap) {
			hostObj = renderContext.objectsMap.get(hostId);
		}
		if (!hostObj && renderContext.objects) {
			hostObj = renderContext.objects.find(o => o.id === hostId);
		}
		if (!hostObj) {
			return;
		}

		const mode = options.mode || 'preview';
		const passedEventIds = options.passedEventIds || new Set();
		const basis = renderContext.basis;
		const zoomScale = renderContext.zoomScale;
		const conf = RENDER.PREDICTED_TRAJECTORY;

		const points = prediction.points;
		const events = prediction.events;

		// Check if trajectory reached its end or valid duration (e.g. 1 year)
		const maxTime = prediction.maxSimTime || (points[points.length - 1]?.time || 0);
		if (mode === 'flight' && options.currentFlightTime !== undefined && options.currentFlightTime >= maxTime) {
			// Rocket has reached or exceeded prediction end: erase predicted trajectory
			return;
		}

		ctx.save();

		const rotationOffset = options.rotationOffset || 0;
		const hasRotation = rotationOffset !== 0;
		const cosR = hasRotation ? Math.cos(rotationOffset) : 1;
		const sinR = hasRotation ? Math.sin(rotationOffset) : 0;

		// Compute host screen position relative to camera basis
		const hostScreenX = (hostObj.x - basis.x) * zoomScale;
		const hostScreenY = (hostObj.y - basis.y) * zoomScale;

		// Viewport Frustum Culling bounds
		// In renderContext coordinates, screen center is at (cx, cy)
		const cx = renderContext.cameraOffset ? renderContext.cameraOffset.x * zoomScale : 0;
		const cy = renderContext.cameraOffset ? renderContext.cameraOffset.y * zoomScale : 0;
		const canvasW = ctx.canvas?.width || 2000;
		const canvasH = ctx.canvas?.height || 2000;
		// Screen diagonal radius ensures camera rotation at any angle never clips visible area
		const halfDiag = Math.hypot(canvasW, canvasH) / 2;
		const MARGIN = 150;
		const maxExtent = halfDiag + MARGIN;
		const minX = cx - maxExtent;
		const maxX = cx + maxExtent;
		const minY = cy - maxExtent;
		const maxY = cy + maxExtent;

		// Screen-space decimation helper: avoids collapsing line dashes when sample density is high
		const MIN_SCREEN_DIST_SQ = conf.MIN_SCREEN_DIST_SQ || 4.0;

		const filterScreenPoints = (startIndex, endIndex) => {
			if (startIndex > endIndex) return [];
			const res = [];
			let lastX = -999999;
			let lastY = -999999;

			for (let i = startIndex; i <= endIndex; i++) {
				const pt = points[i];
				let relX = pt.relX;
				let relY = pt.relY;
				if (hasRotation) {
					const rx = relX * cosR - relY * sinR;
					const ry = relX * sinR + relY * cosR;
					relX = rx;
					relY = ry;
				}
				const sx = hostScreenX + relX * zoomScale;
				const sy = hostScreenY + relY * zoomScale;

				const dx = sx - lastX;
				const dy = sy - lastY;
				if (i === startIndex || i === endIndex || (dx * dx + dy * dy) >= MIN_SCREEN_DIST_SQ) {
					res.push({ x: sx, y: sy });
					lastX = sx;
					lastY = sy;
				}
			}
			return res;
		};

		// Helper to render only visible segments of polyline across screen viewport
		const drawClippedPolyline = (pts) => {
			if (!pts || pts.length < 2) return;

			let inSubpath = false;
			let prev = pts[0];
			let prevIn = (prev.x >= minX && prev.x <= maxX && prev.y >= minY && prev.y <= maxY);

			for (let i = 1; i < pts.length; i++) {
				const cur = pts[i];
				const curIn = (cur.x >= minX && cur.x <= maxX && cur.y >= minY && cur.y <= maxY);

				// Check if line segment intersects or enters viewport bounding box
				const minPx = prev.x < cur.x ? prev.x : cur.x;
				const maxPx = prev.x > cur.x ? prev.x : cur.x;
				const minPy = prev.y < cur.y ? prev.y : cur.y;
				const maxPy = prev.y > cur.y ? prev.y : cur.y;
				const crosses = !(maxPx < minX || minPx > maxX || maxPy < minY || minPy > maxY);

				if (crosses) {
					if (!inSubpath) {
						ctx.moveTo(prev.x, prev.y);
						inSubpath = true;
					}
					ctx.lineTo(cur.x, cur.y);
				} else {
					inSubpath = false;
				}

				prev = cur;
				prevIn = curIn;
			}
		};

		// Current rocket screen position
		let rocketScreenPos = null;
		if (options.rocketX !== undefined && options.rocketY !== undefined) {
			rocketScreenPos = {
				x: (options.rocketX - basis.x) * zoomScale,
				y: (options.rocketY - basis.y) * zoomScale
			};
		}

		// 1. Draw Actual Trajectory (Solid line for real flight path from pad to current rocket)
		// Completely independent of planned prediction line
		if (options.showActualPath !== false && mode === 'flight' && options.actualFlightPath && options.actualFlightPath.length > 0) {
			const actualPts = [];
			let lastAx = -999999;
			let lastAy = -999999;
			for (let i = 0; i < options.actualFlightPath.length; i++) {
				const pt = options.actualFlightPath[i];
				let relX = pt.relX;
				let relY = pt.relY;
				if (hasRotation) {
					const rx = relX * cosR - relY * sinR;
					const ry = relX * sinR + relY * cosR;
					relX = rx;
					relY = ry;
				}
				const sx = hostScreenX + relX * zoomScale;
				const sy = hostScreenY + relY * zoomScale;

				const dx = sx - lastAx;
				const dy = sy - lastAy;
				if (i === 0 || (dx * dx + dy * dy) >= MIN_SCREEN_DIST_SQ) {
					actualPts.push({ x: sx, y: sy });
					lastAx = sx;
					lastAy = sy;
				}
			}
			// Attach current rocket position to the tip of actual trajectory
			if (rocketScreenPos) {
				const last = actualPts[actualPts.length - 1];
				if (!last || Math.hypot(last.x - rocketScreenPos.x, last.y - rocketScreenPos.y) >= 1.0) {
					actualPts.push(rocketScreenPos);
				} else {
					actualPts[actualPts.length - 1] = rocketScreenPos;
				}
			}
			if (actualPts.length >= 2) {
				ctx.beginPath();
				ctx.setLineDash([]); // Solid line for actual flight path
				ctx.lineWidth = conf.LINE_WIDTH_FLIGHT || 2.2;
				ctx.strokeStyle = conf.COLOR_SOLID || "rgba(0, 255, 204, 0.95)";
				drawClippedPolyline(actualPts);
				ctx.stroke();
			}
		}

		// 2. Draw Predicted Trajectory (Pure planned trajectory, completely independent of rocket pos)
		if (options.showPredictedTrajectory !== false && !options.isDestroyed) {
			const predPoints = filterScreenPoints(0, points.length - 1);
			if (predPoints.length >= 2) {
				ctx.beginPath();
				ctx.setLineDash(mode === 'flight' ? (conf.LINE_DASH_FLIGHT || [14, 10]) : (conf.LINE_DASH_PRE || [14, 10]));
				ctx.lineWidth = conf.LINE_WIDTH_PRE || 2.0;
				ctx.strokeStyle = (mode === 'flight' ? conf.COLOR_FLIGHT : conf.COLOR_PRE) || "rgba(0, 200, 160, 0.65)";
				drawClippedPolyline(predPoints);
				ctx.stroke();
			}
		}

		// 3. Draw H3-style event markers anchored to host
		if (options.showPredictedTrajectory !== false && events && events.length > 0) {
			ctx.setLineDash([]);
			ctx.font = conf.EVENT_FONT;
			ctx.textBaseline = 'middle';

			events.forEach(ev => {
				let evRelX = ev.relX;
				let evRelY = ev.relY;
				if (hasRotation) {
					const rx = evRelX * cosR - evRelY * sinR;
					const ry = evRelX * sinR + evRelY * cosR;
					evRelX = rx;
					evRelY = ry;
				}
				const evScreenX = hostScreenX + evRelX * zoomScale;
				const evScreenY = hostScreenY + evRelY * zoomScale;

				// Skip drawing event markers that are completely offscreen
				if (evScreenX < minX || evScreenX > maxX || evScreenY < minY || evScreenY > maxY) {
					return;
				}

				const isPassed = ev.passed || passedEventIds.has(ev.id);

				if (ev.type === 'impact') {
					// Draw high-visibility Red Cross (X) for Impact
					const crossSize = conf.EVENT_IMPACT_SIZE || 6.0;
					ctx.beginPath();
					ctx.strokeStyle = conf.EVENT_IMPACT_COLOR || "#ff3333";
					ctx.lineWidth = conf.EVENT_IMPACT_LINE_WIDTH || 2.2;
					ctx.moveTo(evScreenX - crossSize, evScreenY - crossSize);
					ctx.lineTo(evScreenX + crossSize, evScreenY + crossSize);
					ctx.moveTo(evScreenX + crossSize, evScreenY - crossSize);
					ctx.lineTo(evScreenX - crossSize, evScreenY + crossSize);
					ctx.stroke();

					// Subtle red glow under cross
					ctx.beginPath();
					ctx.arc(evScreenX, evScreenY, crossSize * 1.4, 0, Math.PI * 2);
					ctx.fillStyle = conf.EVENT_IMPACT_FILL || "rgba(255, 30, 30, 0.25)";
					ctx.fill();

					// Impact Event Label
					const labelText = isPassed ? `✖ ${ev.name}` : `✕ ${ev.name}`;
					const textX = evScreenX + conf.EVENT_LABEL_OFFSET_X;
					const textY = evScreenY + conf.EVENT_LABEL_OFFSET_Y;

					const metrics = ctx.measureText(labelText);
					const padX = conf.LABEL_PAD_X || 3;
					const padY = conf.LABEL_PAD_Y || 2;
					const boxOffsetY = conf.LABEL_BOX_OFFSET_Y || -6;
					const boxHeight = conf.LABEL_BOX_HEIGHT || 12;
					ctx.fillStyle = conf.EVENT_IMPACT_BOX_BG || "rgba(40, 10, 10, 0.85)";
					ctx.fillRect(textX - padX, textY + boxOffsetY - padY, metrics.width + padX * 2, boxHeight + padY * 2);

					ctx.fillStyle = conf.EVENT_IMPACT_TEXT_COLOR || "#ff5555";
					ctx.fillText(labelText, textX, textY);
				} else {
					// Normal circular event marker (liftoff, pitch, maxq, meco, apoapsis, orbit, etc.)
					ctx.beginPath();
					ctx.arc(evScreenX, evScreenY, conf.EVENT_RADIUS, 0, Math.PI * 2);

					if (isPassed) {
						ctx.fillStyle = conf.EVENT_FILL_PASSED;
						ctx.fill();
						ctx.lineWidth = conf.EVENT_RING_WIDTH;
						ctx.strokeStyle = conf.EVENT_COLOR_PASSED;
						ctx.stroke();
					} else {
						ctx.fillStyle = conf.EVENT_FILL_UNPASSED;
						ctx.fill();
						ctx.lineWidth = conf.EVENT_RING_WIDTH;
						ctx.strokeStyle = conf.EVENT_COLOR_UNPASSED;
						ctx.stroke();
					}

					// Event Label
					const labelText = isPassed ? `● ${ev.name}` : `○ ${ev.name}`;
					const textX = evScreenX + conf.EVENT_LABEL_OFFSET_X;
					const textY = evScreenY + conf.EVENT_LABEL_OFFSET_Y;

					// Label backdrop box for readability
					const metrics = ctx.measureText(labelText);
					const padX = conf.LABEL_PAD_X || 3;
					const padY = conf.LABEL_PAD_Y || 2;
					const boxOffsetY = conf.LABEL_BOX_OFFSET_Y || -6;
					const boxHeight = conf.LABEL_BOX_HEIGHT || 12;
					ctx.fillStyle = conf.LABEL_BG_COLOR || "rgba(0, 15, 20, 0.75)";
					ctx.fillRect(textX - padX, textY + boxOffsetY - padY, metrics.width + padX * 2, boxHeight + padY * 2);

					// Label text color
					ctx.fillStyle = isPassed ? conf.EVENT_COLOR_PASSED : conf.EVENT_TEXT_COLOR;
					ctx.fillText(labelText, textX, textY);
				}
			});
		}

		ctx.restore();
	}

	/**
	 * Fast geometric rotation of trajectory points and events around host origin.
	 * Used at liftoff to bake rotation offset with zero physics simulation overhead.
	 * @param {Object} prediction - Source prediction object.
	 * @param {number} rotationAngle - Angle in radians to rotate.
	 * @returns {Object} Rotated prediction object clone.
	 */
	static rotatePrediction(prediction, rotationAngle) {
		if (!prediction || !prediction.points) { return prediction; }
		if (!rotationAngle || Math.abs(rotationAngle) < 1e-7) {
			return JSON.parse(JSON.stringify(prediction));
		}

		const cosR = Math.cos(rotationAngle);
		const sinR = Math.sin(rotationAngle);

		const newPoints = new Array(prediction.points.length);
		for (let i = 0; i < prediction.points.length; i++) {
			const p = prediction.points[i];
			newPoints[i] = {
				relX: p.relX * cosR - p.relY * sinR,
				relY: p.relX * sinR + p.relY * cosR,
				altM: p.altM,
				time: p.time
			};
		}

		const newEvents = (prediction.events || []).map(ev => ({
			...ev,
			relX: ev.relX * cosR - ev.relY * sinR,
			relY: ev.relX * sinR + ev.relY * cosR
		}));

		return {
			...prediction,
			points: newPoints,
			events: newEvents
		};
	}

	render(ctx, renderContext, options = {}) {
		TrajectoryPredictor.renderTrajectory(ctx, renderContext, this.prediction, options);
	}

	destroy() {
		if (this._worker) {
			this._worker.terminate();
			this._worker = null;
		}
	}
}