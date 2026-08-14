
// gravsim_tab_navi.js

import { PHYSICS, UI, OBJECT_TYPES, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';

export class NaviTab {
	constructor(universe) {
		this.universe = universe;
		this.naviTargetId = undefined;
		this._initElements();
		this._bindEvents();
		this.update();
	}

	_initElements() {
		this.ui = {
			nvTab: document.getElementById('tab-navi'),
			nvTargetSelect: document.getElementById('nv-target-select'),
			nvMass: document.getElementById('nv-mass'),
			nvRadius: document.getElementById('nv-radius'),
			nvSurfaceG: document.getElementById('nv-surface-g'),
			nvEscapeV: document.getElementById('nv-escape-v'),
			nvRefBody: document.getElementById('nv-ref-body'),
			nvAlt: document.getElementById('nv-alt'),
			nvVel: document.getElementById('nv-vel'),
			nvAtmAlt: document.getElementById('nv-atm-alt'),
			nvAtmRho: document.getElementById('nv-atm-rho'),
			nvAtmScale: document.getElementById('nv-atm-scale'),
		};
	}

	_bindEvents() {
		if (this.ui.nvTargetSelect) {
			this.ui.nvTargetSelect.addEventListener('change', (e) => {
				this.naviTargetId = parseInt(e.target.value, 10);
				this._updateNaviStats();
			});
			this.ui.nvTargetSelect.addEventListener('focus', () => {
				this.updateTargetOptions();
			});
		}

		// Update Navi stats periodically if active
		setInterval(() => {
			if (this.ui.nvTab && this.ui.nvTab.classList.contains('active')) {
				this._updateNaviStats();
			}
		}, UI.UPDATE_INTERVAL.NAVI);
	}

	update() {
		this._updateNaviStats();
		this.updateTargetOptions();
	}

	updateTargetOptions() {
		if (!this.ui.nvTargetSelect) { return; }

		const currentId = this.naviTargetId;
		this.ui.nvTargetSelect.innerHTML = '';
		for (const obj of this.universe.objects) {
			if (obj.type === OBJECT_TYPES.ROCKET) { continue; }

			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name.substring(0, 10)} (ID:${obj.id})`;
			if (obj.id === currentId || (currentId === undefined && this.universe.centerObject && obj.id === this.universe.centerObject.id)) {
				option.selected = true;
				this.naviTargetId = obj.id;
			}
			this.ui.nvTargetSelect.appendChild(option);
		}
	}

	_updateNaviStats() {
		let target = this.universe.objects.find(o => o.id === this.naviTargetId);
		if (!target) {
			target = this.universe.centerObject;
			if(target) { this.naviTargetId = target.id; }
			else { return; }
		}

		this.ui.nvMass.innerText = target.mass.toExponential(2) + " t";
		this.ui.nvRadius.innerText = (target.radius/1000).toLocaleString('en-US') + " km";

		const surfaceG_ms2 = (PHYSICS.G * (target.mass*1e3)) / (target.radius * target.radius);
		this.ui.nvSurfaceG.innerText = (surfaceG_ms2 / PHYSICS.G0).toFixed(2) + " G (" + surfaceG_ms2.toFixed(2) + " m/s²)";

		const escapeV = Math.sqrt(2 * PHYSICS.G * (target.mass*1e3) / target.radius);
		this.ui.nvEscapeV.innerText = (escapeV/1000).toFixed(2) + " km/s";

		let refBody = null;
		let distToRefM = 0;
		if (target.dominantBodyId !== undefined && target.dominantBodyId !== -1) {
			refBody = this.universe.objects.find(o => o.id === target.dominantBodyId);
			distToRefM = target.distToDominantM || 0;
		}

		if (refBody) {
			this.ui.nvRefBody.innerText = refBody.name;
			this.ui.nvAlt.innerText = ((distToRefM - refBody.radius)/1000).toLocaleString('en-US', {maximumFractionDigits:0}) + " km";
			const vx = this.universe.pix2m(target.vx - refBody.vx);
			const vy = this.universe.pix2m(target.vy - refBody.vy);
			this.ui.nvVel.innerText = (Math.sqrt(vx*vx + vy*vy)/1000).toFixed(2) + " km/s";
		} else {
			this.ui.nvRefBody.innerText = "NONE";
			this.ui.nvAlt.innerText = "--- km";
			this.ui.nvVel.innerText = "--- km/s";
		}

		const param = DEFAULT_OBJECT_PARAMS[target.name];
		if (param && param.ATM_LIMIT_ALT) {
			this.ui.nvAtmAlt.innerText = (param.ATM_LIMIT_ALT/1000).toLocaleString() + " km";
			this.ui.nvAtmRho.innerText = param.ATM_DENSITY_0.toLocaleString() + " kg/m³";
			this.ui.nvAtmScale.innerText = param.ATM_SCALE_HEIGHT.toLocaleString() + " m";
		} else {
			this.ui.nvAtmAlt.innerText = "--- km";
			this.ui.nvAtmRho.innerText = "--- kg/m³";
			this.ui.nvAtmScale.innerText = "--- m";
		}
	}
}
