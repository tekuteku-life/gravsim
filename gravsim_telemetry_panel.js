// gravsim_telemetry_panel.js

import { Renderer } from './gravsim_renderer.js';
import {
	TELEMETRY_UPDATE_INTERVAL_MS,
	TELEMETRY_SUB_VIEW_TARGET_RADIUS,
	TELEMETRY_SUB_VIEW_MAX_ZOOM,
	DEFAULT_OBJECT_PARAMS
} from './gravsim_const.js';

export class TelemetryPanel {
	constructor(universe) {
		this.universe = universe;
		this.isOpen = false;
		this.lastUpdate = 0;
		this.intervalMs = TELEMETRY_UPDATE_INTERVAL_MS;

		this.targetId = null;
		this.lastObjCount = -1;

		this.ui = {
			toggleBtn: document.getElementById('telemetry-toggle-btn'),
			panel: document.getElementById('telemetry-panel'),
			targetSelect: document.getElementById('tm-target-select'),
			refBody: document.getElementById('tm-refbody'),
			mass: document.getElementById('tm-mass'),

			alt: document.getElementById('tm-alt'),
			vel: document.getElementById('tm-vel'),
			gforce: document.getElementById('tm-gforce'),

			atm: document.getElementById('tm-atm'),
			aoa: document.getElementById('tm-aoa'),
			dyn: document.getElementById('tm-dyn'),
			struct: document.getElementById('tm-struct'),
			drag: document.getElementById('tm-drag'),

			rocketData: document.getElementById('tm-rocket-data'),
			prop: document.getElementById('tm-prop'),
			burn: document.getElementById('tm-burn'),

			subCanvas: document.getElementById('sub-canvas'),
		};
		
		if (this.ui.subCanvas) {
			this.subRenderer = new Renderer(this.ui.subCanvas);
		}

		this._bindEvents();
	}

	_bindEvents() {
		if (this.ui.toggleBtn) {
			this.ui.toggleBtn.addEventListener('click', () => {
				this.isOpen = !this.isOpen;
				this.ui.panel.style.display = this.isOpen ? 'block' : 'none';
				this.ui.toggleBtn.textContent = this.isOpen ? 'TELEMETRY: ON' : 'TELEMETRY: OFF';
				this.ui.toggleBtn.style.color = this.isOpen ? '#ff5555' : '#00ffcc';
				this.ui.toggleBtn.style.borderColor = this.isOpen ? '#ff5555' : '#00ffcc';
				
				if (this.isOpen) {
					this.lastUpdate = 0;
					this.update();
				}
			});
		}

		if (this.ui.targetSelect) {
			this.ui.targetSelect.addEventListener('change', (e) => {
				this.targetId = parseInt(e.target.value, 10);
				this.lastUpdate = 0;
			});
		}
	}

	_updateTargetOptions() {
		if (!this.ui.targetSelect) return;
		
		this.ui.targetSelect.innerHTML = '';
		for (const obj of this.universe.objects) {
			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name.substring(0, 10)} (ID:${obj.id})`;
			
			if (obj.id === this.targetId) {
				option.selected = true;
			}
			this.ui.targetSelect.appendChild(option);
		}
	}

	update() {
		if (!this.isOpen) return;

		const now = Date.now();
		if (now - this.lastUpdate < this.intervalMs) return;
		this.lastUpdate = now;

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
				if (this.ui.targetSelect) this.ui.targetSelect.value = target.id;
			} else {
				return;
			}
		}

		// Find Reference Body
		let refBody = null;
		let maxG = -1;
		let distToRefPx = 0;
		
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
				distToRefPx = Math.sqrt(distSqPx);
			}
		}

		// Update Orbit Info
		if (refBody) {
			this.ui.refBody.innerText = refBody.name.substring(0, 14);
			
			const distM = this.universe.pix2m(distToRefPx);
			const altM = distM - refBody.radius;
			this.ui.alt.innerText = (altM / 1000).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(10, ' ');

			const dvx = this.universe.pix2m(target.vx - refBody.vx);
			const dvy = this.universe.pix2m(target.vy - refBody.vy);
			const velM = Math.sqrt(dvx * dvx + dvy * dvy);
			this.ui.vel.innerText = (velM / 1000).toLocaleString('en-US', {minimumFractionDigits: 3, maximumFractionDigits: 3}).padStart(9, ' ');
		} else {
			this.ui.refBody.innerText = "NONE";
			this.ui.alt.innerText = "---".padStart(10, ' ');
			this.ui.vel.innerText = "---".padStart(9, ' ');
		}

		this.ui.mass.innerText = target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' ');

		// G-Force Calculation
		let gForce = 0;
		if (target.burnTime > 0 && target.thrustForce > 0) {
			const thrustN = target.thrustForce;
			const massKg = target.mass * 1000;
			gForce = (thrustN / massKg) / 9.80665;
		}
		this.ui.gforce.innerText = gForce.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(7, ' ');

		// Update Aerodynamics Info
		let rho = 0, aoaDeg = 0, q = 0, dragKN = 0, structRatio = 0;
		if (refBody) {
			const refParam = DEFAULT_OBJECT_PARAMS[refBody.name];
			const distM = this.universe.pix2m(distToRefPx);
			const altM = distM - refBody.radius;
			
			if (refParam && refParam.ATM_LIMIT_ALT && altM < refParam.ATM_LIMIT_ALT && altM > 0) {
				rho = refParam.ATM_DENSITY_0 * Math.exp(-altM / refParam.ATM_SCALE_HEIGHT);
				
				let vAtmM_x = this.universe.pix2m(refBody.vx);
				let vAtmM_y = this.universe.pix2m(refBody.vy);
				
				if (refParam.ROTATION_PERIOD) {
					const omega = (2 * Math.PI) / refParam.ROTATION_PERIOD;
					const dxRef = this.universe.pix2m(target.x - refBody.x);
					const dyRef = this.universe.pix2m(target.y - refBody.y);
					vAtmM_x += -omega * dyRef;
					vAtmM_y += omega * dxRef;
				}
				
				const vRelX = this.universe.pix2m(target.vx) - vAtmM_x;
				const vRelY = this.universe.pix2m(target.vy) - vAtmM_y;
				const vRelSq = vRelX * vRelX + vRelY * vRelY;
				
				q = 0.5 * rho * vRelSq;
				
				let area = Math.PI * target.radius * target.radius;
				let cd = 0.47;
				const objParam = DEFAULT_OBJECT_PARAMS[target.name];
				
				if (objParam && objParam.AERO_AREA_FRONT) {
					cd = objParam.DRAG_COEF || 0.2;
					const velAngle = Math.atan2(vRelY, vRelX);
					let angleDiff = Math.abs(target.thrustAngle - velAngle);
					while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
					while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
					angleDiff = Math.abs(angleDiff);
					
					const aoa = Math.min(angleDiff, Math.PI - angleDiff);
					aoaDeg = aoa * (180 / Math.PI);
					const sinAoA = Math.sin(aoa);
					
					area = objParam.AERO_AREA_FRONT * (1 - sinAoA) + objParam.AERO_AREA_SIDE * sinAoA;
				}
				
				dragKN = (q * cd * area) / 1000;
				
				const maxQ = objParam?.MAX_DYNAMIC_PRESSURE || Infinity;
				if (maxQ !== Infinity) {
					structRatio = (q / maxQ) * 100;
				}
			}
		}

		if (this.ui.atm) {
			this.ui.atm.innerText = rho.toLocaleString('en-US', {minimumFractionDigits: 4, maximumFractionDigits: 4}).padStart(8, ' ');
			this.ui.aoa.innerText = rho > 0 ? aoaDeg.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(6, ' ') : "---".padStart(6, ' ');
			this.ui.dyn.innerText = (q / 1000).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(8, ' ');
			
			if (structRatio > 0) {
				this.ui.struct.innerText = structRatio.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(6, ' ');
				if (structRatio > 80) {
					this.ui.struct.style.color = '#ffaa00';
				} else {
					this.ui.struct.style.color = '#00ffcc';
				}
			} else {
				this.ui.struct.innerText = "---".padStart(6, ' ');
				this.ui.struct.style.color = '#00ffcc';
			}
			
			this.ui.drag.innerText = dragKN.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(8, ' ');
		}

		// Rocket Specific Data
		if (target.emptyMass > 0 && target.massLossRate > 0) {
			this.ui.rocketData.style.display = 'block';
			const currentProp = Math.max(0, target.mass - target.emptyMass);
			this.ui.prop.innerText = currentProp.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(8, ' ');
			this.ui.burn.innerText = target.burnTime.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(8, ' ');
		} else {
			this.ui.rocketData.style.display = 'none';
		}
	}

	draw() {
		if (!this.isOpen || !this.subRenderer) return;

		const canvas = this.subRenderer.canvas;
		if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
			canvas.width = canvas.clientWidth;
			canvas.height = canvas.clientHeight;
		}

		let targetObj = this.universe.objects.find(o => o.id === this.targetId);
		if (!targetObj) targetObj = this.universe.centerObject;

		if (targetObj) {
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
				this.universe.RocketLauncher.drawPreview(subCtx, targetObj, subZoom);
				subCtx.restore();
			}
		}
	}
}
