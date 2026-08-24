
// gravsim_telemetry_panel.js

import { PHYSICS, UI, OBJECT_TYPES, TELEMETRY } from './gravsim_const.js';
import { Renderer } from './gravsim_renderer.js';
import { MathUtils, DOMUtils, UnitConvertUtils, FormatUtils } from './gravsim_utils.js';

export class TelemetryPanel {
	constructor(universe) {
		this.universe = universe;
		this.isOpen = false;
		
		this.targetId = 0;
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
			countdownDisplay: document.getElementById('countdown-display'),
			cdTime: document.getElementById('cd-time'),
			cdEvent: document.getElementById('cd-event'),
		};
		DOMUtils.verifyElements(this.ui, 'TelemetryPanel');
		
		if (this.ui.subCanvas) {
			this.subRenderer = new Renderer(this.ui.subCanvas);
		}

		this._bindEvents();

		// Register to the main logic update loop
		this.universe.registerUIUpdater(UI.UPDATE_INTERVAL.TELEMETRY, () => {
			if (this.isOpen) {
				this.update();
			}
		});

		// Subscribe to object list changes
		this.universe.on('object-list-changed', () => {
			this._updateTargetOptions();
		});
	}

	_bindEvents() {
		this.ui.toggleBtn.addEventListener('click', () => {
			if (!this.isOpen) { this.open(); }
			else { this.close(); }
		});

		this.ui.targetSelect.addEventListener('change', (e) => {
			this.targetId = parseInt(e.target.value, 10);
		});

		// Event listeners for launch sequence updates and animations
		this.universe.on('sequencer-start', () => {
			if (this.ui.countdownDisplay) this.ui.countdownDisplay.style.display = 'block';
		});

		const resetSequenceUI = () => {
			if (this.ui.countdownDisplay) this.ui.countdownDisplay.style.display = 'none';
			if (this.ui.panel) this.ui.panel.classList.remove('auto-sequence-mode');
		};
		this.universe.on('sequencer-end', resetSequenceUI);
		this.universe.on('sequencer-abort', resetSequenceUI);

		this.universe.on('sequencer-tick', (data) => {
			DOMUtils.setText(this.ui.cdTime, data.timeText);
			DOMUtils.setText(this.ui.cdEvent, data.eventName);
		});

		this.universe.on('sequencer-event', () => {
			if (this.ui.countdownDisplay) {
				// Re-trigger CSS animation
				this.ui.countdownDisplay.classList.remove('flash');
				void this.ui.countdownDisplay.offsetWidth; 
				this.ui.countdownDisplay.classList.add('flash');
			}
		});

		this.universe.on('auto-sequence-start', () => {
			if (this.ui.panel) this.ui.panel.classList.add('auto-sequence-mode');
		});

		this.universe.on('liftoff', () => {
			if (this.ui.panel) this.ui.panel.classList.remove('auto-sequence-mode');
		});
	}

	_updateTargetOptions() {
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
			this.update();
		}
	}
	open() { this._openCloseCtl(true); }
	close() { this._openCloseCtl(false); }

	update() {
		const target = this._resolveTarget();
		if (!target) { return; }

		if (target.type === OBJECT_TYPES.ROCKET && target.telemetry) {
			this._updateUIFromTelemetry(target);
		} else {
			this._resetUIForTracking(target);
		}
	}

	_resolveTarget() {
		let target = this.universe.objects.find(o => o.id === this.targetId && o.type === OBJECT_TYPES.ROCKET);
		if (!target) {
			target = this.universe.camera.trackingTarget;
			if (target && target.type === OBJECT_TYPES.ROCKET) {
				this.targetId = target.id;
				this.ui.targetSelect.value = target.id;
			}
			else {
				this.targetId = parseInt(this.ui.targetSelect.value, 10);
				target = this.universe.objects.find(o => o.id === this.targetId && o.type === OBJECT_TYPES.ROCKET);
				if (!target) {
					target = null;
				}
			}
		}
		return target;
	}

	_updateUIFromTelemetry(target) {
		const tm = target.telemetry;

		DOMUtils.setText(this.ui.mass, target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' '));
		DOMUtils.setText(this.ui.twr, FormatUtils.numFixPad(tm.twr, 2, 6));
		DOMUtils.setText(this.ui.remDv, FormatUtils.numFixPad(UnitConvertUtils.m2km(tm.remDv), 2, 6));

		DOMUtils.setText(this.ui.alt, UnitConvertUtils.m2km(tm.altM).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(10, ' '));
		DOMUtils.setText(this.ui.velV, FormatUtils.numFixPad(UnitConvertUtils.m2km(tm.vV), 2, 7));
		DOMUtils.setText(this.ui.velH, FormatUtils.numFixPad(UnitConvertUtils.m2km(tm.vH), 2, 7));
		DOMUtils.setText(this.ui.accV, FormatUtils.numFixPad(tm.aV, 2, 7));
		DOMUtils.setText(this.ui.accH, FormatUtils.numFixPad(tm.aH, 2, 7));

		const pitchDeg = MathUtils.normalizeAngle360(UnitConvertUtils.rad2deg(target.thrustAngle));
		DOMUtils.setText(this.ui.pitch, FormatUtils.numFixPad(pitchDeg, 1, 6));
		DOMUtils.setText(this.ui.aoa, FormatUtils.numFixPad(tm.aoaDeg, 1, 5));
		DOMUtils.setText(this.ui.dyn, FormatUtils.numFixPad(tm.structRatio, 1, 5));
		DOMUtils.setText(this.ui.dynAx, FormatUtils.numFixPad(tm.qAxialKpa, 1, 6));
		DOMUtils.setText(this.ui.dynLat, FormatUtils.numFixPad(tm.qLateralKpa, 1, 6));

		const thrtlPercent = (target.thrustRatio || 0) * 100;
		DOMUtils.setText(this.ui.thrtl, FormatUtils.numFixPad(thrtlPercent, 1, 6));

		const propRem = target.fuelMass;
		const displayProp = propRem < 0.01 ? 0 : propRem;
		DOMUtils.setText(this.ui.prop, FormatUtils.numFixPad(displayProp, 2, 6));

		if (!this.maxProp[target.id] || propRem > this.maxProp[target.id]) this.maxProp[target.id] = propRem;
		let pct = this.maxProp[target.id] > 0 ? (propRem / this.maxProp[target.id]) * 100 : 0;
		if (pct < 0.5) { pct = 0; }
		DOMUtils.setStyle(this.ui.fuelBar, 'width', `${pct}%`);

		let mStat = TELEMETRY.STATUS_MAP[tm.status] || TELEMETRY.STATUS_MAP[0];
		
		// Override UI status with AUTO-SEQUENCE if under automatic control
		if (tm.status === TELEMETRY.STATUS.PRE_LAUNCH && this.universe.LaunchSequencer.isAutoSequence) {
			mStat = "AUTO-SEQUENCE";
		}
		
		DOMUtils.setText(this.ui.missionStatus, mStat);
		
		if (mStat === TELEMETRY.STATUS_MAP[3]) { 
			DOMUtils.setStyle(this.ui.missionStatus, 'color', TELEMETRY.STYLE.MISSION_STATUS.MAX_Q_COLOR);
		} else { 
			// Will be overridden by CSS in auto-sequence mode
			DOMUtils.setStyle(this.ui.missionStatus, 'color', TELEMETRY.STYLE.MISSION_STATUS.NORMAL_COLOR);
		}

		// Sync MET with sequencer time during countdown
		let displayTimeSec = tm.flightTime;
		if (this.universe.LaunchSequencer.isActive && this.universe.LaunchSequencer.rocketId === target.id) {
			displayTimeSec = this.universe.LaunchSequencer.timer - this.universe.LaunchSequencer.tMinusOffset;
		}

		DOMUtils.setText(this.ui.missionTime, FormatUtils.timeMission(displayTimeSec));
		this._updateFlightDirectorUI(target.thrustAngle, tm.progradeAngle, tm.gravityAngle);
	}

	_resetUIForTracking(target) {
		DOMUtils.setText(this.ui.mass, target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' '));
		DOMUtils.setText(this.ui.twr, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.remDv, "---".padStart(6, ' '));

		DOMUtils.setText(this.ui.alt, "---".padStart(10, ' '));
		DOMUtils.setText(this.ui.velV, "---".padStart(7, ' '));
		DOMUtils.setText(this.ui.velH, "---".padStart(7, ' '));
		DOMUtils.setText(this.ui.accV, "---".padStart(7, ' '));
		DOMUtils.setText(this.ui.accH, "---".padStart(7, ' '));

		DOMUtils.setText(this.ui.pitch, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.aoa, "---".padStart(5, ' '));
		DOMUtils.setText(this.ui.dyn, "---".padStart(5, ' '));
		if (this.ui.dynAx) { DOMUtils.setText(this.ui.dynAx, "---".padStart(6, ' ')); }
		if (this.ui.dynLat) { DOMUtils.setText(this.ui.dynLat, "---".padStart(6, ' ')); }

		DOMUtils.setText(this.ui.thrtl, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.prop, "---".padStart(6, ' '));
		DOMUtils.setStyle(this.ui.fuelBar, 'width', `0%`);

		DOMUtils.setText(this.ui.missionStatus, TELEMETRY.STATUS_MAP[6]);
		DOMUtils.setStyle(this.ui.missionStatus, 'color', TELEMETRY.STYLE.MISSION_STATUS.NORMAL_COLOR);

		DOMUtils.setText(this.ui.missionTime, "T+ ---y ---d --:--:--");
		DOMUtils.setStyle(this.ui.navPrograde, 'left', `50%`);
		DOMUtils.setStyle(this.ui.navGravity, 'left', `50%`);
	}

	_updateFlightDirectorUI(thrustAngle, progradeAngle, gravityAngle) {
		const getOffsetPct = (angle, refAngle) => {
			let diff = MathUtils.normalizeAngle(angle - refAngle);
			// Stabilize the boundary to prevent the indicator from wildly jumping between 0% and 100%
			if (Math.abs(diff) > Math.PI - 0.005) {
				diff = Math.PI;
			}
			return 50 + (diff / Math.PI) * 50; 
		};

		const progOffset = getOffsetPct(progradeAngle, thrustAngle);
		const gravOffset = getOffsetPct(gravityAngle, thrustAngle);

		DOMUtils.setStyle(this.ui.navPrograde, 'left', `${progOffset}%`);
		DOMUtils.setStyle(this.ui.navGravity, 'left', `${gravOffset}%`);

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
		if (!targetObj) { targetObj = this.universe.camera.trackingTarget; }

		if (targetObj && targetObj.type === OBJECT_TYPES.ROCKET) {
			const realRadiusPx = UnitConvertUtils.m2pix(targetObj.radius);

			// Keep the radius of the object specified size on Sub screen
			let subZoom = TELEMETRY.SUB_VIEW_TARGET_RADIUS / Math.max(realRadiusPx, 1e-10);
			subZoom = Math.min(subZoom, TELEMETRY.SUB_VIEW_MAX_ZOOM);

			this.subRenderer.setZoomScale(subZoom);

			// Create a specific render state for the sub canvas
			const subRenderState = {
				basis: targetObj,
				cameraOffset: { x: 0, y: 0 },
				zoomScale: subZoom,
				zoomExp: Math.log10(subZoom),
				rotation: this.subRenderer.rotation || 0
			};

			this.subRenderer.draw(this.universe.objects, subRenderState);

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
