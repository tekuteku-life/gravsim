
// gravsim_rocket_launcher.js

import { PHYSICS, RENDER, DEFAULT_OBJECT_PARAMS, ROCKET_FUELS } from './gravsim_const.js';

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
				
				const distPx = this.universe.m2pix(distance);
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

	drawPreview(ctx, centerObject, zoomScale) {
		if (!this.isActive) return;

		const transform = this._calculateTransform();
		if (!transform) return;

		// Convert to screen space
		const relX = (transform.x - centerObject.x) * zoomScale;
		const relY = (transform.y - centerObject.y) * zoomScale;

		ctx.save();

		// Draw Ghost Rocket
		ctx.fillStyle = "rgba(50, 205, 50, 0.6)";
		ctx.beginPath();
		ctx.arc(relX, relY, 5, 0, Math.PI * 2); // screen pixels
		ctx.fill();

		// Estimate total Delta-v visually for the arrow length
		// dV = (Thrust * BurnTime) / avgMass
		const baseMassTon = DEFAULT_OBJECT_PARAMS['Rocket'].MASS;
		const estDv = (this.thrustKN * this.calculatedBurnTime) / baseMassTon;
		const arrowLen = Math.max(20, Math.min(300, (estDv / 1000) * 2)); // screen pixels
		
		const launchRad = this.launchAngleDeg * (Math.PI / 180);
		const endX = relX + Math.cos(launchRad) * arrowLen;
		const endY = relY + Math.sin(launchRad) * arrowLen;

		// Draw Vector Arrow
		ctx.strokeStyle = "rgba(255, 50, 50, 0.8)";
		ctx.lineWidth = 2; // screen pixels
		ctx.beginPath();
		ctx.moveTo(relX, relY);
		ctx.lineTo(endX, endY);

		// Arrow head
		const headlen = 10;
		ctx.lineTo(endX - headlen * Math.cos(launchRad - Math.PI / 6), endY - headlen * Math.sin(launchRad - Math.PI / 6));
		ctx.moveTo(endX, endY);
		ctx.lineTo(endX - headlen * Math.cos(launchRad + Math.PI / 6), endY - headlen * Math.sin(launchRad + Math.PI / 6));

		ctx.stroke();

		// Draw Target Reticle for Free Mode
		if (this.mode === 'free') {
			ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(relX, relY, 15, 0, Math.PI * 2);
			ctx.moveTo(relX - 20, relY);
			ctx.lineTo(relX + 20, relY);
			ctx.moveTo(relX, relY - 20);
			ctx.lineTo(relX, relY + 20);
			ctx.stroke();
		}

		ctx.restore();
	}

	executeLaunch() {
		if (!this.isActive) { return; }

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
			autoControl: this.autoControl
		};

		const newRocket = this.universe.ObjectPlacer.placeObject(massName, t.x, t.y, t.vx, t.vy, optParams);

		// Set new rocket to center object
		this.universe.ObjectManager.centerObject = newRocket;
		this.universe.cameraOffset = { x: 0, y: 0 };
		this.universe.ControlPanel.updateCenterOptions();
		this.universe.InfoPanel.updateCamera(newRocket.name);

		// Zoom the rocket
		const systemTab = this.universe.ControlPanel.systemTab;
		if (systemTab && systemTab.ui.zoomScale) {
			const realRadiusPx = (newRocket.radius / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
			const targetSize = Math.min(this.universe.canvas.width, this.universe.canvas.height) / 2.2;
			let idealExp = Math.log10(targetSize / realRadiusPx);

			const maxZoom = parseFloat(systemTab.ui.zoomScale.max);
			const minZoom = parseFloat(systemTab.ui.zoomScale.min);
			idealExp = Math.max(minZoom, Math.min(maxZoom, idealExp));

			systemTab.ui.zoomScale.value = idealExp.toFixed(2);
			systemTab.updateZoomScaleIndicator(systemTab.getZoomScale());
			this.universe.updateZoomScale();
		}
		
		// Fix time & zoom scale & camera target
		this.universe.ControlPanel.rocketTab.saveTimeScale();
		this.universe.ControlPanel.rocketTab.saveZoomScale();
		this.universe.ControlPanel.rocketTab.saveCameraTarget();

		// Open telemetry
		this.universe.TelemetryPanel.open();

		this.togglePreview(false);
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
