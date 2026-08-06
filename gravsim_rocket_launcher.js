// gravsim_rocket_launcher.js

import { DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';

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
		this.hostAngleDeg = 0;
		this.hostAltitudeM = 10; // (m)

		// Rocket parameters
		this.initialMassT = 60;	// (t)
		this.launchAngleDeg = 90;
		this.thrustKN = 1000;	// (kN)
		this.burnTime = 300;	// (seconds)
		this.payloadRatio = 20;	// %
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
		const m0 = param.MASS * 1e3;
		
		// Calculate final mass (mf) based on payload ratio
		const mf = m0 * (this.payloadRatio / 100);
		
		if (this.burnTime > 0 && this.payloadRatio < 100 && this.thrustKN > 0) {
			const mDot = (m0 - mf) / this.burnTime;
			const F = this.thrustKN * 1e3;
			deltaVM = (F / mDot) * Math.log(m0 / mf);
		} else if (this.thrustKN > 0 && this.payloadRatio === 100) {
			deltaVM = (this.thrustKN * 1e3 / m0) * this.burnTime;
		}

		if (this.mode === 'host') {
			const host = this.universe.objects.find(o => o.id === this.hostId) || this.universe.centerObject;
			if (host) {
				const angleRad = this.hostAngleDeg * (Math.PI / 180);
				const distance = host.radius + (param.RADIUS || 1) + this.hostAltitudeM;
				
				const distPx = this.universe.m2pix(distance);
				posX = host.x + Math.cos(angleRad) * distPx;
				posY = host.y + Math.sin(angleRad) * distPx;
				
				baseVx = host.vx;
				baseVy = host.vy;
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
		const estDv = (this.thrustKN * this.burnTime) / baseMassTon;
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
		const param = DEFAULT_OBJECT_PARAMS[massName] || DEFAULT_OBJECT_PARAMS['Rocket'];

		const initialMassTon = this.initialMassT;
		const finalMassTon = initialMassTon * (this.payloadRatio / 100);
		const massLossRateTon = this.burnTime > 0 ? (initialMassTon - finalMassTon) / this.burnTime : 0;

		const optParams = {
			force: this.thrustKN * 1e3,
			mass: initialMassTon,
			angle: this.launchAngleDeg * (Math.PI / 180),
			time: this.burnTime,
			lossRate: massLossRateTon
		};

		this.universe.ObjectPlacer.placeObject(massName, t.x, t.y, t.vx, t.vy, optParams);
		this.togglePreview(false);
	}

	getState() {
		return {
			mode: this.mode,
			hostId: this.hostId,
			hostAngleDeg: this.hostAngleDeg,
			hostAltitudeM: this.hostAltitudeM,
			launchAngleDeg: this.launchAngleDeg,
			initialMassT: this.initialMassT,
			thrustKN: this.thrustKN,
			burnTime: this.burnTime,
			payloadRatio: this.payloadRatio
		};
	}

	loadState(state) {
		if (!state) return;
		if (state.mode !== undefined) this.mode = state.mode;
		if (state.hostId !== undefined) this.hostId = state.hostId;
		if (state.hostAngleDeg !== undefined) this.hostAngleDeg = state.hostAngleDeg;
		if (state.hostAltitudeM !== undefined) this.hostAltitudeM = state.hostAltitudeM;
		if (state.launchAngleDeg !== undefined) this.launchAngleDeg = state.launchAngleDeg;
		if (state.initialMassT !== undefined) this.initialMassT = state.initialMassT;
		if (state.thrustKN !== undefined) this.thrustKN = state.thrustKN;
		if (state.burnTime !== undefined) this.burnTime = state.burnTime;
		if (state.payloadRatio !== undefined) this.payloadRatio = state.payloadRatio;
	}
}
