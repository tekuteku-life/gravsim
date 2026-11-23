
// gravsim_tab_navi.js

import { PHYSICS, UI, OBJECT_TYPES } from './gravsim_const.js';
import { DOMUtils, UnitConvertUtils, isLiveObject } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';
import { presetManager } from './gravsim_preset_manager.js';
import { NavigationCameraCard } from './gravsim_telemetry_card.js';

export class NaviTab {
	constructor(universe) {
		this.universe = universe;
		this.naviTargetId = undefined;
		this.currentCameraTargetId = undefined;

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

		// Track camera target changes
		EventBus.on('camera:set-tracking-target', (target) => {
			this.currentCameraTargetId = target ? target.id : undefined;
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
		this.ui.nvTargetSelect.addEventListener('change', (/** @type {any} */ e) => {
			this.naviTargetId = parseInt(e.target.value, 10);
			this._updateNaviStats();
		});
	}

	updateTargetOptions() {
		const currentId = this.naviTargetId;
		this.ui.nvTargetSelect.innerHTML = '';
		// Bodies and debris in the simulation (a removed one stays listed until its trail has faded, design §4.13-31)
		for (const obj of this.universe.objects) {
			if (obj.type === OBJECT_TYPES.ROCKET || !isLiveObject(obj)) { continue; }

			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name.substring(0, 10)} (ID:${obj.id})`;
			if (obj.id === currentId || (currentId === undefined && obj.id === this.currentCameraTargetId)) {
				option.selected = true;
				this.naviTargetId = obj.id;
			}
			this.ui.nvTargetSelect.appendChild(option);
		}
	}

	_updateNaviStats() {
		let target = this.universe.objects.find(o => o.id === this.naviTargetId && isLiveObject(o));
		if (!target) {
			target = this.universe.objects.find(o => o.id === this.currentCameraTargetId && isLiveObject(o));
			if(target) {
				this.naviTargetId = target.id;
			} else {
				return;
			}
		}

		DOMUtils.setText(this.ui.nvMass, target.mass.toExponential(2) + " t");
		DOMUtils.setText(this.ui.nvRadius, UnitConvertUtils.m2km(target.radius).toLocaleString('en-US') + " km");

		const surfaceG_ms2 = (PHYSICS.G * UnitConvertUtils.ton2kg(target.mass)) / (target.radius * target.radius);
		DOMUtils.setText(this.ui.nvSurfaceG, (surfaceG_ms2 / PHYSICS.G0).toFixed(2) + " G (" + surfaceG_ms2.toFixed(2) + " m/s²)");

		const escapeV = Math.sqrt(2 * PHYSICS.G * UnitConvertUtils.ton2kg(target.mass) / target.radius);
		DOMUtils.setText(this.ui.nvEscapeV, UnitConvertUtils.m2km(escapeV).toFixed(2) + " km/s");

		// The reference body by the rule of the Navigation & Camera card (the celestial body the Worker's dominantBodyId
		// names). ALT and VEL are relative to it: without a resolved body (none, or an id naming no body of the universe,
		// e.g. one removed while paused) all three read as for none, instead of keeping the values of the last body
		// (design §4.13-26)
		const refBody = NavigationCameraCard.resolveDominantBody(target, this.universe.objects);
		if (refBody) {
			const distToRefM = target.distToDominantM || 0;
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

		const param = target.param || (typeof this.universe?.getObjectParams === 'function' ? this.universe.getObjectParams(target.name) : null) || (typeof presetManager !== 'undefined' ? presetManager.getObjectParam(target.name) : null);
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
