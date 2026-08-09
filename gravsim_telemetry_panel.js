
// gravsim_telemetry_panel.js

import { Renderer } from './gravsim_renderer.js';
import {
	TELEMETRY_UPDATE_INTERVAL_MS,
	TELEMETRY_SUB_VIEW_TARGET_RADIUS,
	TELEMETRY_SUB_VIEW_MAX_ZOOM,
	G, G0, UI_TM_MAX_Q_TH,
	DEFAULT_OBJECT_PARAMS,
	MISSION_STATUS, OBJECT_TYPES,
} from './gravsim_const.js';

const TM_STYLE = {
	display: { open: 'block', close : 'none' },
	text: { open: 'TELEMETRY: ON', close: 'TELEMETRY: OFF' },
	color: { open: '#ff5555', close: '#00ffcc' },
	bColor: { open: '#ff5555', close: '#00ffcc' },
	missionStatusColor: { normal: '#00ffcc', max_q: '#ff5555' },
};

export class TelemetryPanel {
	constructor(universe) {
		this.universe = universe;
		this.isOpen = false;
		this.lastUpdate = 0;
		this.intervalMs = TELEMETRY_UPDATE_INTERVAL_MS;

		this.targetId = null;
		this.lastObjCount = -1;
		this.maxProp = {};

		this.ui = {
			toggleBtn: document.getElementById('telemetry-toggle-btn'),
			panel: document.getElementById('telemetry-panel'),
			targetSelect: document.getElementById('tm-target-select'),

			missionStatus: document.getElementById('tm-mission-status'),

			mass: document.getElementById('tm-mass'),
			remDv: document.getElementById('tm-rem-dv'),
			twr: document.getElementById('tm-twr'),

			alt: document.getElementById('tm-alt'),
			velV: document.getElementById('tm-vel-v'),
			velH: document.getElementById('tm-vel-h'),
			accV: document.getElementById('tm-acc-v'),
			accH: document.getElementById('tm-acc-h'),

			pitch: document.getElementById('tm-pitch'),
			aoa: document.getElementById('tm-aoa'),
			dyn: document.getElementById('tm-dyn'),

			thrtl: document.getElementById('tm-thrtl'),
			prop: document.getElementById('tm-prop'),
			fuelBar: document.getElementById('tm-fuel-bar'),

			navPrograde: document.getElementById('tm-nav-prograde'),
			navGravity: document.getElementById('tm-nav-gravity'),

			subCanvas: document.getElementById('sub-canvas'),
		};
		
		if (this.ui.subCanvas) {
			this.subRenderer = new Renderer(this.ui.subCanvas);
		}

		this._bindEvents();
	}

	_bindEvents() {
		if (this.ui.toggleBtn) {
			this.ui.toggleBtn.addEventListener('click', () => { this.open(); });
		}

		if (this.ui.targetSelect) {
			this.ui.targetSelect.addEventListener('change', (e) => {
				this.targetId = parseInt(e.target.value, 10);
				this.lastUpdate = 0;
			});
		}
	}

	_updateTargetOptions() {
		if (!this.ui.targetSelect) { return; }
		
		this.ui.targetSelect.innerHTML = '';
		for (const obj of this.universe.objects) {
			if (obj.type === OBJECT_TYPES.CELESTIAL) { continue; }

			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name.substring(0, 10)} (ID:${obj.id})`;
			
			if (obj.id === this.targetId) {
				option.selected = true;
			}
			this.ui.targetSelect.appendChild(option);
		}
	}

	open() {
		this.isOpen = !this.isOpen;
		this.ui.panel.style.display = this.isOpen ? TM_STYLE.display.open : TM_STYLE.display.close;
		this.ui.toggleBtn.textContent = this.isOpen ? TM_STYLE.text.open : TM_STYLE.text.close;
		this.ui.toggleBtn.style.color = this.isOpen ? TM_STYLE.color.open : TM_STYLE.color.close;
		this.ui.toggleBtn.style.borderColor = this.isOpen ? TM_STYLE.bColor.open : TM_STYLE.bColor.close;

		if (this.isOpen) {
			this.lastUpdate = 0;
			this.update();
		}
	}

	update() {
		if (!this.isOpen) { return; }

		const now = Date.now();
		if (now - this.lastUpdate < this.intervalMs) {return; }
		this.lastUpdate = now;

		const target = this._resolveTarget();
		if (!target) { return; }

		const refData = this._calculateReferenceData(target);

		this._updateVesselStateUI(target, refData.localG_ms2);
		const flightDynamics = this._updateFlightDynamicsUI(target, refData.refBody, refData.distToRefM);
		const aerodynamics = this._updateAerodynamicsUI(target, refData.refBody, refData.distToRefM);
		this._updatePropulsionAndStatusUI(target, aerodynamics.structRatio);
		this._updateFlightDirectorUI(target, flightDynamics.progradeAngle, flightDynamics.gravityAngle);
	}

	_resolveTarget() {
		if (this.lastObjCount !== this.universe.objects.length) {
			if (this.lastObjCount !== -1 && this.universe.objects.length > this.lastObjCount) {
				const newestObj = this.universe.objects[this.universe.objects.length - 1];
				this.targetId = newestObj.id;
			}
			this._updateTargetOptions();
			this.lastObjCount = this.universe.objects.length;
		}

		let target = this.universe.objects.find(o => o.id === this.targetId);
		if (!target) {
			target = this.universe.centerObject;
			if (target) {
				this.targetId = target.id;
				if (this.ui.targetSelect) { this.ui.targetSelect.value = target.id; }
			}
		}

		if (target.type === OBJECT_TYPES.CELESTIAL) {
			target = null;
		}
		return target;
	}

	_calculateReferenceData(target) {
		let refBody = null;
		let maxG = -1;
		let distToRefM = 0;
		
		for (const obj of this.universe.objects) {
			if (obj.id === target.id) continue;
			const dx = target.x - obj.x;
			const dy = target.y - obj.y;
			const distSqPx = dx * dx + dy * dy;
			const distSqM = Math.pow(this.universe.pix2m(Math.sqrt(distSqPx)), 2);
			if (distSqM === 0) continue;
			
			const gForce = obj.mass / distSqM; 
			if (gForce > maxG) {
				maxG = gForce;
				refBody = obj;
				distToRefM = Math.sqrt(distSqM);
			}
		}

		// Calculate Basic Local G
		let localG_ms2 = 0;
		if (refBody) {
			const hostMassKg = refBody.mass * 1e3;
			localG_ms2 = (G * hostMassKg) / (distToRefM * distToRefM);
		}

		return { refBody, distToRefM, localG_ms2 };
	}

	_updateVesselStateUI(target, localG_ms2) {
		this.ui.mass.innerText = target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' ');
		
		let thrustN = target.burnTime > 0 ? target.thrustForce * (target.thrustRatio || 0) : 0;
		const twr = localG_ms2 > 0 ? thrustN / (target.mass * 1000 * localG_ms2) : 0;
		this.ui.twr.innerText = twr.toFixed(2).padStart(6, ' ');

		let remDv = 0;
		if (target.type === OBJECT_TYPES.ROCKET && target.dryMass > 0) {
			let ve = 320 * G0; // Default assumption if no flow rate
			if (target.thrustForce > 0 && target.massLossRate > 0) {
				ve = target.thrustForce / (target.massLossRate * 1000);
			}
			remDv = (ve * Math.log(target.mass / target.dryMass)) / 1000;
		}
		this.ui.remDv.innerText = remDv.toFixed(2).padStart(6, ' ');
	}

	_updateFlightDynamicsUI(target, refBody, distToRefM) {
		let vV = 0, vH = 0, aV = 0, aH = 0;
		let progradeAngle = 0, gravityAngle = 0;

		if (refBody) {
			const altM = distToRefM - refBody.radius;
			this.ui.alt.innerText = (altM / 1000).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(10, ' ');

			const dx = target.x - refBody.x;
			const dy = target.y - refBody.y;
			const rPx = Math.sqrt(dx*dx + dy*dy);
			
			if (rPx > 0) {
				const uRx = dx/rPx;
				const uRy = dy/rPx;
				const uHx = -uRy;
				const uHy = uRx;

				const dvx = this.universe.pix2m(target.vx - refBody.vx);
				const dvy = this.universe.pix2m(target.vy - refBody.vy);
				vV = (dvx * uRx + dvy * uRy) / 1000;
				vH = (dvx * uHx + dvy * uHy) / 1000;

				const dax = this.universe.pix2m(target.ax); 
				const day = this.universe.pix2m(target.ay);
				aV = (dax * uRx + day * uRy) / G0;
				aH = (dax * uHx + day * uHy) / G0;
				
				progradeAngle = Math.atan2(dvy, dvx);
				gravityAngle = Math.atan2(-dy, -dx);
			}
		} else {
			this.ui.alt.innerText = "---".padStart(10, ' ');
			progradeAngle = Math.atan2(target.vy, target.vx);
		}

		this.ui.velV.innerText = vV.toFixed(2).padStart(7, ' ');
		this.ui.velH.innerText = vH.toFixed(2).padStart(7, ' ');
		this.ui.accV.innerText = aV.toFixed(2).padStart(7, ' ');
		this.ui.accH.innerText = aH.toFixed(2).padStart(7, ' ');

		return { progradeAngle, gravityAngle };
	}

	_updateAerodynamicsUI(target, refBody, distToRefM) {
		let pitchDeg = (target.thrustAngle * 180 / Math.PI) % 360;
		if (pitchDeg < 0) { pitchDeg += 360; }
		this.ui.pitch.innerText = pitchDeg.toFixed(1).padStart(6, ' ');

		let aoaDeg = 0, structRatio = 0;
		if (refBody) {
			const refParam = DEFAULT_OBJECT_PARAMS[refBody.name];
			const altM = distToRefM - refBody.radius;
			if (refParam && refParam.ATM_LIMIT_ALT && altM < refParam.ATM_LIMIT_ALT && altM > 0) {
				const rho = refParam.ATM_DENSITY_0 * Math.exp(-altM / refParam.ATM_SCALE_HEIGHT);
				let vAtmM_x = this.universe.pix2m(refBody.vx);
				let vAtmM_y = this.universe.pix2m(refBody.vy);
				
				if (refParam.ROTATION_PERIOD) {
					const omega = (2 * Math.PI) / refParam.ROTATION_PERIOD;
					vAtmM_x += -omega * this.universe.pix2m(target.y - refBody.y);
					vAtmM_y += omega * this.universe.pix2m(target.x - refBody.x);
				}
				
				const vRelX = this.universe.pix2m(target.vx) - vAtmM_x;
				const vRelY = this.universe.pix2m(target.vy) - vAtmM_y;
				const vRelSq = vRelX * vRelX + vRelY * vRelY;
				const q = 0.5 * rho * vRelSq;
				
				const velAngle = Math.atan2(vRelY, vRelX);
				let angleDiff = Math.abs(target.thrustAngle - velAngle);
				while (angleDiff > Math.PI) { angleDiff -= 2 * Math.PI; }
				while (angleDiff < -Math.PI) { angleDiff += 2 * Math.PI; }
				aoaDeg = Math.abs(angleDiff) * (180 / Math.PI);
				
				const objParam = DEFAULT_OBJECT_PARAMS[target.name];
				const maxQ = objParam?.MAX_DYNAMIC_PRESSURE || Infinity;
				if (maxQ !== Infinity) {
					structRatio = (q / maxQ) * 100;
				}
			}
		}

		this.ui.aoa.innerText = aoaDeg.toFixed(1).padStart(5, ' ');
		this.ui.dyn.innerText = structRatio.toFixed(1).padStart(5, ' ');

		return { structRatio };
	}

	_updatePropulsionAndStatusUI(target, structRatio) {
		let mStat = MISSION_STATUS.PRE_LAUNCH;
		if (target.type === OBJECT_TYPES.ROCKET) {
			if (target.burnTime > 0) {
				if (structRatio > UI_TM_MAX_Q_TH) { mStat = MISSION_STATUS.MAX_Q; }
				else { mStat = MISSION_STATUS.ASCENT; }
			} else {
				if (target.massLossRate > 0 && target.fuelMass <= 0) { mStat = MISSION_STATUS.MECO; }
				else { mStat = MISSION_STATUS.COASTING; }
			}

			const thrtlPercent = (target.thrustRatio || 0) * 100;
			this.ui.thrtl.innerText = thrtlPercent.toFixed(1).padStart(6, ' ');

			const propRem = target.fuelMass;
			const displayProp = propRem < 0.01 ? 0 : propRem;
			this.ui.prop.innerText = displayProp.toFixed(2).padStart(6, ' ');

			if (!this.maxProp[target.id] || propRem > this.maxProp[target.id]) this.maxProp[target.id] = propRem;
			let pct = this.maxProp[target.id] > 0 ? (propRem / this.maxProp[target.id]) * 100 : 0;
			if (pct < 0.5) { pct = 0; }
			this.ui.fuelBar.style.width = `${pct}%`;
		} else {
			mStat = MISSION_STATUS.TRACKING;
			this.ui.thrtl.innerText = "---".padStart(6, ' ');
			this.ui.prop.innerText = "---".padStart(6, ' ');
			this.ui.fuelBar.style.width = `0%`;
		}
		
		this.ui.missionStatus.innerText = mStat;
		if (mStat === MISSION_STATUS.MAX_Q) { this.ui.missionStatus.style.color = TM_STYLE.missionStatusColor.max_q; }
		else { this.ui.missionStatus.style.color = TM_STYLE.missionStatusColor.normal; }
	}

	_updateFlightDirectorUI(target, progradeAngle, gravityAngle) {
		const getOffsetPct = (angle, refAngle) => {
			let diff = angle - refAngle;
			while(diff > Math.PI) { diff -= 2*Math.PI; }
			while(diff < -Math.PI) { diff += 2*Math.PI; }
			return 50 + (diff / Math.PI) * 50; 
		};

		const progOffset = getOffsetPct(progradeAngle, target.thrustAngle);
		const gravOffset = getOffsetPct(gravityAngle, target.thrustAngle);

		this.ui.navPrograde.style.left = `${progOffset}%`;
		this.ui.navGravity.style.left = `${gravOffset}%`;

		this.subRenderer.setRotation(-Math.PI/2 - progradeAngle);
	}

	draw() {
		if (!this.isOpen || !this.subRenderer) return;

		const canvas = this.subRenderer.canvas;
		if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
			canvas.width = canvas.clientWidth;
			canvas.height = canvas.clientHeight;
		}

		let targetObj = this.universe.objects.find(o => o.id === this.targetId);
		if (!targetObj) { targetObj = this.universe.centerObject; }

		if (targetObj && targetObj.type === OBJECT_TYPES.ROCKET) {
			const realRadiusPx = this.universe.m2pix(targetObj.radius);

			// Keep the radius of the object 20px on Sub screen
			let subZoom = TELEMETRY_SUB_VIEW_TARGET_RADIUS / Math.max(realRadiusPx, 1e-10);
			subZoom = Math.min(subZoom, TELEMETRY_SUB_VIEW_MAX_ZOOM);

			this.subRenderer.setZoomScale(subZoom);
			this.subRenderer.draw(this.universe.objects, targetObj);

			// Draw rocket preview
			if (this.universe.RocketLauncher) {
				const subCtx = this.subRenderer.canvas.getContext('2d');
				subCtx.save();
				subCtx.translate(this.subRenderer.canvas.width / 2, this.subRenderer.canvas.height / 2);
				if (this.subRenderer.rotation !== undefined) {
					subCtx.rotate(this.subRenderer.rotation);
				}
				this.universe.RocketLauncher.drawPreview(subCtx, targetObj, subZoom);
				subCtx.restore();
			}
		}
	}
}
