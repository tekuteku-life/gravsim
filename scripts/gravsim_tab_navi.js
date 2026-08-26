
// gravsim_tab_navi.js

import { PHYSICS, UI, OBJECT_TYPES, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';
import { DOMUtils, UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

export class NaviTab {
	constructor(universe) {
		this.universe = universe;
		this.naviTargetId = undefined;
		this._initElements();
		this._bindEvents();

		// Register to the main Pub/Sub manager instead of setInterval
		EventBus.registerInterval(UI.UPDATE_INTERVAL.NAVI, () => {
			if (this.ui.nvTab && this.ui.nvTab.classList.contains('active')) {
				this._updateNaviStats();
			}
		});

		// Subscribe to object list changes
		EventBus.on('object-list-changed', () => {
			this.updateTargetOptions();
		});
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
		DOMUtils.verifyElements(this.ui, 'NaviTab');
	}

	_bindEvents() {
		this.ui.nvTargetSelect.addEventListener('change', (e) => {
			this.naviTargetId = parseInt(e.target.value, 10);
			this._updateNaviStats();
		});
	}

	updateTargetOptions() {
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

		DOMUtils.setText(this.ui.nvMass, target.mass.toExponential(2) + " t");
		DOMUtils.setText(this.ui.nvRadius, UnitConvertUtils.m2km(target.radius).toLocaleString('en-US') + " km");

		const surfaceG_ms2 = (PHYSICS.G * UnitConvertUtils.ton2kg(target.mass)) / (target.radius * target.radius);
		DOMUtils.setText(this.ui.nvSurfaceG, (surfaceG_ms2 / PHYSICS.G0).toFixed(2) + " G (" + surfaceG_ms2.toFixed(2) + " m/s²)");

		const escapeV = Math.sqrt(2 * PHYSICS.G * UnitConvertUtils.ton2kg(target.mass) / target.radius);
		DOMUtils.setText(this.ui.nvEscapeV, UnitConvertUtils.m2km(escapeV).toFixed(2) + " km/s");

		let refBody = null;
		let distToRefM = 0;
		if (target.dominantBodyId !== undefined && target.dominantBodyId !== -1) {
			refBody = this.universe.objects.find(o => o.id === target.dominantBodyId);
			distToRefM = target.distToDominantM || 0;
		}

		if (refBody) {
			DOMUtils.setText(this.ui.nvRefBody, refBody.name);
			DOMUtils.setText(this.ui.nvAlt, UnitConvertUtils.m2km(distToRefM - refBody.radius).toLocaleString('en-US', {maximumFractionDigits:0}) + " km");
			const vx = UnitConvertUtils.pix2m(target.vx - refBody.vx);
			const vy = UnitConvertUtils.pix2m(target.vy - refBody.vy);
			DOMUtils.setText(this.ui.nvVel, UnitConvertUtils.m2km(Math.sqrt(vx*vx + vy*vy)).toFixed(2) + " km/s");
		} else {
			DOMUtils.setText(this.ui.nvRefBody, "NONE");
			DOMUtils.setText(this.ui.nvAlt, "--- km");
			DOMUtils.setText(this.ui.nvVel, "--- km/s");
		}

		const param = DEFAULT_OBJECT_PARAMS[target.name];
		if (param && param.ATM_LIMIT_ALT) {
			DOMUtils.setText(this.ui.nvAtmAlt, UnitConvertUtils.m2km(param.ATM_LIMIT_ALT).toLocaleString() + " km");
			DOMUtils.setText(this.ui.nvAtmRho, param.ATM_DENSITY_0.toLocaleString() + " kg/m³");
			DOMUtils.setText(this.ui.nvAtmScale, param.ATM_SCALE_HEIGHT.toLocaleString() + " m");
		} else {
			DOMUtils.setText(this.ui.nvAtmAlt, "--- km");
			DOMUtils.setText(this.ui.nvAtmRho, "--- kg/m³");
			DOMUtils.setText(this.ui.nvAtmScale, "--- m");
		}
	}
}
