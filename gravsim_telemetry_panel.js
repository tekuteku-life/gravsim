
// gravsim_telemetry_panel.js

import { Renderer } from './gravsim_renderer.js';
import {
	TELEMETRY_UPDATE_INTERVAL_MS,
	TELEMETRY_SUB_VIEW_TARGET_RADIUS,
	TELEMETRY_SUB_VIEW_MAX_ZOOM,
	MISSION_STATUS, OBJECT_TYPES,
} from './gravsim_const.js';

const TM_STYLE = {
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
			missionTime: document.getElementById('tm-met'),

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
			dynAx: document.getElementById('tm-dyn-ax'),
			dynLat: document.getElementById('tm-dyn-lat'),

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
			this.ui.toggleBtn.addEventListener('click', () => {
				if (!this.isOpen) { this.open(); }
				else { this.close(); }
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

	_openCloseCtl(_open) {
		this.isOpen = _open;

		this.ui.panel.classList.toggle('open', _open);

		if (_open) {
			this.lastUpdate = 0;
			this.update();
		}
	}
	open() { this._openCloseCtl(true); }
	close() { this._openCloseCtl(false); }

	update() {
		if (!this.isOpen) { return; }

		const now = Date.now();
		if (now - this.lastUpdate < this.intervalMs) {return; }
		this.lastUpdate = now;

		const target = this._resolveTarget();
		if (!target) { return; }

		if (target.type === OBJECT_TYPES.ROCKET && target.telemetry) {
			this._updateUIFromTelemetry(target);
		} else {
			this._resetUIForTracking(target);
		}
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

		if (target && target.type === OBJECT_TYPES.CELESTIAL) {
			target = null;
		}
		return target;
	}

	_updateUIFromTelemetry(target) {
		const tm = target.telemetry;

		this.ui.mass.innerText = target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' ');
		this.ui.twr.innerText = tm.twr.toFixed(2).padStart(6, ' ');
		this.ui.remDv.innerText = (tm.remDv / 1e3).toFixed(2).padStart(6, ' ');

		this.ui.alt.innerText = (tm.altM / 1000).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(10, ' ');
		this.ui.velV.innerText = (tm.vV / 1e3).toFixed(2).padStart(7, ' ');
		this.ui.velH.innerText = (tm.vH / 1e3).toFixed(2).padStart(7, ' ');
		this.ui.accV.innerText = tm.aV.toFixed(2).padStart(7, ' ');
		this.ui.accH.innerText = tm.aH.toFixed(2).padStart(7, ' ');

		let pitchDeg = (target.thrustAngle * 180 / Math.PI) % 360;
		if (pitchDeg < 0) { pitchDeg += 360; }
		this.ui.pitch.innerText = pitchDeg.toFixed(1).padStart(6, ' ');
		this.ui.aoa.innerText = tm.aoaDeg.toFixed(1).padStart(5, ' ');
		this.ui.dyn.innerText = tm.structRatio.toFixed(1).padStart(5, ' ');
		if (this.ui.dynAx) { this.ui.dynAx.innerText = tm.qAxialKpa.toFixed(1).padStart(6, ' '); }
		if (this.ui.dynLat) { this.ui.dynLat.innerText = tm.qLateralKpa.toFixed(1).padStart(6, ' '); }

		const thrtlPercent = (target.thrustRatio || 0) * 100;
		this.ui.thrtl.innerText = thrtlPercent.toFixed(1).padStart(6, ' ');

		const propRem = target.fuelMass;
		const displayProp = propRem < 0.01 ? 0 : propRem;
		this.ui.prop.innerText = displayProp.toFixed(2).padStart(6, ' ');

		if (!this.maxProp[target.id] || propRem > this.maxProp[target.id]) this.maxProp[target.id] = propRem;
		let pct = this.maxProp[target.id] > 0 ? (propRem / this.maxProp[target.id]) * 100 : 0;
		if (pct < 0.5) { pct = 0; }
		this.ui.fuelBar.style.width = `${pct}%`;

		// Status Mapping
		const statusMap = {
			0: MISSION_STATUS.PRE_LAUNCH,
			1: MISSION_STATUS.LIFTOFF,
			2: MISSION_STATUS.ASCENT,
			3: MISSION_STATUS.MAX_Q,
			4: MISSION_STATUS.MECO,
			5: MISSION_STATUS.COASTING,
			6: MISSION_STATUS.TRACKING
		};
		const mStat = statusMap[tm.status] || MISSION_STATUS.PRE_LAUNCH;
		this.ui.missionStatus.innerText = mStat;
		if (mStat === MISSION_STATUS.MAX_Q) { this.ui.missionStatus.style.color = TM_STYLE.missionStatusColor.max_q; }
		else { this.ui.missionStatus.style.color = TM_STYLE.missionStatusColor.normal; }

		this._updateMissionTimeUI(tm.flightTime);
		this._updateFlightDirectorUI(target.thrustAngle, tm.progradeAngle, tm.gravityAngle);
	}

	_resetUIForTracking(target) {
		this.ui.mass.innerText = target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' ');
		this.ui.twr.innerText = "---".padStart(6, ' ');
		this.ui.remDv.innerText = "---".padStart(6, ' ');

		this.ui.alt.innerText = "---".padStart(10, ' ');
		this.ui.velV.innerText = "---".padStart(7, ' ');
		this.ui.velH.innerText = "---".padStart(7, ' ');
		this.ui.accV.innerText = "---".padStart(7, ' ');
		this.ui.accH.innerText = "---".padStart(7, ' ');

		this.ui.pitch.innerText = "---".padStart(6, ' ');
		this.ui.aoa.innerText = "---".padStart(5, ' ');
		this.ui.dyn.innerText = "---".padStart(5, ' ');
		if (this.ui.dynAx) { this.ui.dynAx.innerText = "---".padStart(6, ' '); }
		if (this.ui.dynLat) { this.ui.dynLat.innerText = "---".padStart(6, ' '); }

		this.ui.thrtl.innerText = "---".padStart(6, ' ');
		this.ui.prop.innerText = "---".padStart(6, ' ');
		this.ui.fuelBar.style.width = `0%`;

		this.ui.missionStatus.innerText = MISSION_STATUS.TRACKING;
		this.ui.missionStatus.style.color = TM_STYLE.missionStatusColor.normal;

		this.ui.missionTime.innerText = "T+ ---y ---d --:--:--";
		this.ui.navPrograde.style.left = `50%`;
		this.ui.navGravity.style.left = `50%`;
	}

	_updateMissionTimeUI(flightTime) {
		const totalSec = Math.floor(flightTime || 0);

		const SEC_PER_DAY = 86400;
		const SEC_PER_YEAR = 365.25 * SEC_PER_DAY;

		const years = Math.floor(totalSec / SEC_PER_YEAR);
		let remSec = totalSec % SEC_PER_YEAR;

		const days = Math.floor(remSec / SEC_PER_DAY);
		remSec %= SEC_PER_DAY;

		const hours = Math.floor(remSec / 3600);
		remSec %= 3600;

		const mins = Math.floor(remSec / 60);
		const secs = remSec % 60;

		const pad = (num, len = 2) => String(num).padStart(len, '0');

		const timeStr = `T+ ${pad(years, 3)}y ${pad(days, 3)}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
		this.ui.missionTime.innerText = timeStr;
	}

	_updateFlightDirectorUI(thrustAngle, progradeAngle, gravityAngle) {
		const getOffsetPct = (angle, refAngle) => {
			let diff = angle - refAngle;
			while(diff > Math.PI) { diff -= 2*Math.PI; }
			while(diff < -Math.PI) { diff += 2*Math.PI; }
			return 50 + (diff / Math.PI) * 50; 
		};

		const progOffset = getOffsetPct(progradeAngle, thrustAngle);
		const gravOffset = getOffsetPct(gravityAngle, thrustAngle);

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
