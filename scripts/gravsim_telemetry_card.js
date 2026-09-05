// gravsim_telemetry_card.js

import { OBJECT_TYPES, TELEMETRY, TANK_PRESSURE_SIM } from './gravsim_const.js';
import { MathUtils, DOMUtils, UnitConvertUtils, FormatUtils } from './gravsim_utils.js';

/*******************************************************************
 * Base Class for Telemetry Cards
 *******************************************************************/
export class TelemetryCard {
	constructor(id, title, element) {
		this.id = id;
		this.title = title;
		this.element = element;
		this.isVisible = false;
	}

	initElements() {}
	update(target, tm) {}
	resetUI(target) {}
	draw(universe) {}

	onBecameVisible(target, tm) {
		if (target && tm) {
			this.update(target, tm);
		} else if (target) {
			this.resetUI(target);
		}
	}
}

/*******************************************************************
 * Card 1: Flight Status & Dynamics
 *******************************************************************/
export class FlightDynamicsCard extends TelemetryCard {
	initElements() {
		this.ui = {
			mass: document.getElementById('tm-mass'),
			alt: document.getElementById('tm-alt'),
			velV: document.getElementById('tm-vel-v'),
			velH: document.getElementById('tm-vel-h'),
			accV: document.getElementById('tm-acc-v'),
			accH: document.getElementById('tm-acc-h'),
		};
		DOMUtils.verifyElements(this.ui, 'FlightDynamicsCard');
	}

	update(target, tm) {
		DOMUtils.setText(this.ui.mass, target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' '));
		DOMUtils.setText(this.ui.alt, UnitConvertUtils.m2km(tm.altM).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(10, ' '));
		DOMUtils.setText(this.ui.velV, FormatUtils.numFixPad(UnitConvertUtils.m2km(tm.vV), 2, 7));
		DOMUtils.setText(this.ui.velH, FormatUtils.numFixPad(UnitConvertUtils.m2km(tm.vH), 2, 7));
		DOMUtils.setText(this.ui.accV, FormatUtils.numFixPad(tm.aV, 2, 7));
		DOMUtils.setText(this.ui.accH, FormatUtils.numFixPad(tm.aH, 2, 7));
	}

	resetUI(target) {
		DOMUtils.setText(this.ui.mass, "---".padStart(9, ' '));
		DOMUtils.setText(this.ui.alt, "---".padStart(10, ' '));
		DOMUtils.setText(this.ui.velV, "---".padStart(7, ' '));
		DOMUtils.setText(this.ui.velH, "---".padStart(7, ' '));
		DOMUtils.setText(this.ui.accV, "---".padStart(7, ' '));
		DOMUtils.setText(this.ui.accH, "---".padStart(7, ' '));
	}
}

/*******************************************************************
 * Card 2: Aerodynamics & Guidance
 *******************************************************************/
export class AeroGuidanceCard extends TelemetryCard {
	initElements() {
		this.ui = {
			pitch: document.getElementById('tm-pitch'),
			aoa: document.getElementById('tm-aoa'),
			dyn: document.getElementById('tm-dyn'),
			dynAx: document.getElementById('tm-dyn-ax'),
			dynLat: document.getElementById('tm-dyn-lat'),
			navPrograde: document.getElementById('tm-nav-prograde'),
			navGravity: document.getElementById('tm-nav-gravity'),
		};
		DOMUtils.verifyElements(this.ui, 'AeroGuidanceCard');
	}

	update(target, tm) {
		const pitchDeg = MathUtils.normalizeAngle360(UnitConvertUtils.rad2deg(target.thrustAngle));
		DOMUtils.setText(this.ui.pitch, FormatUtils.numFixPad(pitchDeg, 1, 6));
		DOMUtils.setText(this.ui.aoa, FormatUtils.numFixPad(tm.aoaDeg, 1, 5));
		DOMUtils.setText(this.ui.dyn, FormatUtils.numFixPad(tm.structRatio, 1, 5));
		DOMUtils.setText(this.ui.dynAx, FormatUtils.numFixPad(tm.qAxialKpa, 1, 6));
		DOMUtils.setText(this.ui.dynLat, FormatUtils.numFixPad(tm.qLateralKpa, 1, 6));

		this._updateFlightDirector(target.thrustAngle, tm.progradeAngle, tm.gravityAngle);
	}

	resetUI(target) {
		DOMUtils.setText(this.ui.pitch, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.aoa, "---".padStart(5, ' '));
		DOMUtils.setText(this.ui.dyn, "---".padStart(5, ' '));
		DOMUtils.setText(this.ui.dynAx, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.dynLat, "---".padStart(6, ' '));
		DOMUtils.setStyle(this.ui.navPrograde, 'left', `50%`);
		DOMUtils.setStyle(this.ui.navGravity, 'left', `50%`);
	}

	_updateFlightDirector(thrustAngle, progradeAngle, gravityAngle) {
		const getOffsetPct = (angle, refAngle) => {
			let diff = MathUtils.normalizeAngle(angle - refAngle);
			if (Math.abs(diff) > Math.PI - 0.005) {
				diff = Math.PI;
			}
			return 50 + (diff / Math.PI) * 50; 
		};

		const progOffset = getOffsetPct(progradeAngle, thrustAngle);
		const gravOffset = getOffsetPct(gravityAngle, thrustAngle);

		DOMUtils.setStyle(this.ui.navPrograde, 'left', `${progOffset}%`);
		DOMUtils.setStyle(this.ui.navGravity, 'left', `${gravOffset}%`);
	}
}

/*******************************************************************
 * Card 3: Propulsion & Consumables
 *******************************************************************/
export class PropulsionCard extends TelemetryCard {
	constructor(id, title, element) {
		super(id, title, element);
		this.maxFuel = {};
		this.maxOxid = {};
		this._skipBarTransitionOnce = false;
	}

	initElements() {
		this.ui = {
			remDv: document.getElementById('tm-rem-dv'),
			twr: document.getElementById('tm-twr'),
			thrtl: document.getElementById('tm-thrtl'),
			fuelMass: document.getElementById('tm-fuel-mass'),
			oxidMass: document.getElementById('tm-oxid-mass'),
			tankPresFuel: document.getElementById('tm-tank-pres-fuel'),
			tankPresOxid: document.getElementById('tm-tank-pres-oxid'),
			fuelBar: document.getElementById('tm-fuel-bar'),
			oxidBar: document.getElementById('tm-oxid-bar'),
			presFuelBar: document.getElementById('tm-pres-fuel-bar'),
			presOxidBar: document.getElementById('tm-pres-oxid-bar'),
		};
		DOMUtils.verifyElements(this.ui, 'PropulsionCard');
	}

	onBecameVisible(target, tm) {
		this._skipBarTransitionOnce = true;
		super.onBecameVisible(target, tm);
	}

	update(target, tm) {
		DOMUtils.setText(this.ui.remDv, FormatUtils.numFixPad(UnitConvertUtils.m2km(tm.remDv), 2, 6));
		DOMUtils.setText(this.ui.twr, FormatUtils.numFixPad(tm.twr, 2, 6));

		const thrtlPercent = (target.thrustRatio || 0) * 100;
		DOMUtils.setText(this.ui.thrtl, FormatUtils.numFixPad(thrtlPercent, 1, 6));

		const fuelRem = target.fuelMass;
		const displayFuel = fuelRem < 0.01 ? 0 : fuelRem;
		DOMUtils.setText(this.ui.fuelMass, FormatUtils.numFixPad(displayFuel, 2, 6));

		const oxidRem = target.oxidMass;
		const displayOxid = oxidRem < 0.01 ? 0 : oxidRem;
		DOMUtils.setText(this.ui.oxidMass, FormatUtils.numFixPad(displayOxid, 2, 6));

		const presFuel = tm.tankPresFuel || 0;
		const presOxid = tm.tankPresOxid || 0;
		DOMUtils.setText(this.ui.tankPresFuel, presFuel > 0 ? presFuel.toFixed(0) : "0");
		DOMUtils.setText(this.ui.tankPresOxid, presOxid > 0 ? presOxid.toFixed(0) : "0");

		if (!this.maxFuel[target.id] || fuelRem > this.maxFuel[target.id]) this.maxFuel[target.id] = fuelRem;
		let pctF = this.maxFuel[target.id] > 0 ? (fuelRem / this.maxFuel[target.id]) * 100 : 0;
		if (pctF < 0.5) { pctF = 0; }

		if (!this.maxOxid[target.id] || oxidRem > this.maxOxid[target.id]) this.maxOxid[target.id] = oxidRem;
		let pctO = this.maxOxid[target.id] > 0 ? (oxidRem / this.maxOxid[target.id]) * 100 : 0;
		if (pctO < 0.5) { pctO = 0; }

		const maxPresScale = TANK_PRESSURE_SIM.MAX_SCALE_KPA;
		const pctPresF = Math.min(Math.max((presFuel / maxPresScale) * 100, 0), 100);
		const pctPresO = Math.min(Math.max((presOxid / maxPresScale) * 100, 0), 100);

		// Suppress visual transition jump when restored from hidden state
		if (this._skipBarTransitionOnce) {
			this._skipBarTransitionOnce = false;
			this.ui.fuelBar.style.transition = 'none';
			this.ui.oxidBar.style.transition = 'none';
			this.ui.presFuelBar.style.transition = 'none';
			this.ui.presOxidBar.style.transition = 'none';
			DOMUtils.setStyle(this.ui.fuelBar, 'width', `${pctF}%`);
			DOMUtils.setStyle(this.ui.oxidBar, 'width', `${pctO}%`);
			DOMUtils.setStyle(this.ui.presFuelBar, 'width', `${pctPresF}%`);
			DOMUtils.setStyle(this.ui.presOxidBar, 'width', `${pctPresO}%`);
			requestAnimationFrame(() => {
				this.ui.fuelBar.style.transition = '';
				this.ui.oxidBar.style.transition = '';
				this.ui.presFuelBar.style.transition = '';
				this.ui.presOxidBar.style.transition = '';
			});
		} else {
			DOMUtils.setStyle(this.ui.fuelBar, 'width', `${pctF}%`);
			DOMUtils.setStyle(this.ui.oxidBar, 'width', `${pctO}%`);
			DOMUtils.setStyle(this.ui.presFuelBar, 'width', `${pctPresF}%`);
			DOMUtils.setStyle(this.ui.presOxidBar, 'width', `${pctPresO}%`);
		}
	}

	resetUI(target) {
		DOMUtils.setText(this.ui.remDv, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.twr, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.thrtl, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.fuelMass, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.oxidMass, "---".padStart(6, ' '));
		DOMUtils.setText(this.ui.tankPresFuel, "---");
		DOMUtils.setText(this.ui.tankPresOxid, "---");
		DOMUtils.setStyle(this.ui.fuelBar, 'width', `0%`);
		DOMUtils.setStyle(this.ui.oxidBar, 'width', `0%`);
		DOMUtils.setStyle(this.ui.presFuelBar, 'width', `0%`);
		DOMUtils.setStyle(this.ui.presOxidBar, 'width', `0%`);
	}
}

/*******************************************************************
 * Card 4: Navigation & Camera Sub-View
 *******************************************************************/
export class NavigationCameraCard extends TelemetryCard {
	constructor(id, title, element, subRenderer) {
		super(id, title, element);
		this.subRenderer = subRenderer;
	}

	initElements() {
		this.ui = {
			dominantBody: document.getElementById('tm-dominant-body'),
			distRef: document.getElementById('tm-dist-ref'),
			subCanvas: document.getElementById('sub-canvas'),
		};
		DOMUtils.verifyElements(this.ui, 'NavigationCameraCard');
	}

	onBecameVisible(target, tm) {
		this._syncCanvasResolution();
		super.onBecameVisible(target, tm);
	}

	update(target, tm) {
		const dominantName = target.dominantBody?.name || "---";
		const distRefKm = target.distToDominantM > 0 ? UnitConvertUtils.m2km(target.distToDominantM) : 0;

		DOMUtils.setText(this.ui.dominantBody, dominantName);
		DOMUtils.setText(this.ui.distRef, distRefKm > 0 ? distRefKm.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(10, ' ') : "---".padStart(10, ' '));

		if (this.subRenderer && tm.progradeAngle !== undefined) {
			this.subRenderer.setRotation(-Math.PI / 2 - tm.progradeAngle);
		}
	}

	resetUI(target) {
		DOMUtils.setText(this.ui.dominantBody, "---");
		DOMUtils.setText(this.ui.distRef, "---".padStart(10, ' '));
	}

	_syncCanvasResolution() {
		if (!this.subRenderer) return;
		const canvas = this.subRenderer.canvas;
		if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
			if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
				canvas.width = canvas.clientWidth;
				canvas.height = canvas.clientHeight;
			}
		}
	}

	draw(universe, targetId) {
		if (!this.isVisible || !this.subRenderer) return;

		this._syncCanvasResolution();

		let targetObj = universe.objects.find(o => o.id === targetId);
		if (!targetObj) { targetObj = universe.camera.trackingTarget; }

		if (targetObj && targetObj.type === OBJECT_TYPES.ROCKET) {
			const realRadiusPx = UnitConvertUtils.m2pix(targetObj.radius);
			let subZoom = TELEMETRY.SUB_VIEW_TARGET_RADIUS / Math.max(realRadiusPx, 1e-10);
			subZoom = Math.min(subZoom, TELEMETRY.SUB_VIEW_MAX_ZOOM);

			this.subRenderer.setZoomScale(subZoom);

			const subRenderState = {
				basis: targetObj,
				cameraOffset: { x: 0, y: 0 },
				zoomScale: subZoom,
				zoomExp: Math.log10(subZoom),
				rotation: this.subRenderer.rotation || 0,
				showPredictedTrajectory: universe.showPredictedTrajectory !== false,
				showActualFlightPath: universe.showActualFlightPath !== false
			};

			this.subRenderer.draw(universe.objects, subRenderState);

			if (universe.RocketLauncher) {
				const subCtx = this.subRenderer.canvas.getContext('2d');
				subCtx.save();
				subCtx.translate(this.subRenderer.canvas.width / 2, this.subRenderer.canvas.height / 2);
				if (this.subRenderer.rotation !== undefined) {
					subCtx.rotate(this.subRenderer.rotation);
				}
				universe.RocketLauncher.drawPreview(subCtx, targetObj, subZoom, this.subRenderer.renderContext);
				subCtx.restore();
			}
		}
	}
}
