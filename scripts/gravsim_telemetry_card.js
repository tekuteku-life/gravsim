// gravsim_telemetry_card.js

import { OBJECT_TYPES, TELEMETRY, TANK_PRESSURE_SIM } from './gravsim_const.js';
import { MathUtils, DOMUtils, UnitConvertUtils, FormatUtils, isLiveObject } from './gravsim_utils.js';

/**
 * True once the payload flies alone: separated (Worker flag or telemetry), or no stage is left at the stage index (after
 * the payload separation the Worker sets the stage index to the stage count, one past the last stage).
 * @param {any} target rocket
 * @param {any} tm its telemetry
 * @param {number} curStg stage index shown
 * @param {number} totalStg stage count shown
 * @returns {boolean}
 */
export function isPayloadPhase(target, tm, curStg, totalStg) {
	return Boolean(target?.isPayloadSeparated || tm?.isPayloadSeparated) || curStg >= totalStg;
}

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
		this._lastStageIndex = null;
		this._skipBarTransitionOnce = false;
	}

	initElements() {
		this.ui = {
			header: this.element.querySelector('.tm-section-header'),
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
		// Stage transition tracking for fuel/oxidizer bar max values
		const curStgIdx = (tm.stageIndex !== undefined ? tm.stageIndex : target.currentStageIndex) || 0;
		const totalStg = tm.totalStages || target.stages?.length || 1;
		// After the payload separation the stage index is the stage count (no stage left): the tanks shown are the
		// payload's own propulsion system (none for a passive payload)
		const payloadPhase = isPayloadPhase(target, tm, curStgIdx, totalStg);
		if (this._lastStageIndex !== curStgIdx) {
			this._lastStageIndex = curStgIdx;
			this._skipBarTransitionOnce = true;
			const prop = target.payload?.propulsion;
			const curStg = payloadPhase
				? { fuelMassT: prop?.enabled ? (prop.fuelMassT || 0) : 0, oxidMassT: prop?.enabled ? (prop.oxidMassT || 0) : 0 }
				: (target.stages && target.stages[curStgIdx]);
			if (curStg) {
				this.maxFuel[target.id] = curStg.fuelMassT;
				this.maxOxid[target.id] = curStg.oxidMassT;
			}
		}

		if (this.ui.header && target.stages && target.stages.length > 1) {
			const stgNum = curStgIdx + 1;
			const curStg = target.stages[curStgIdx];
			const stgTitle = payloadPhase ? 'PAYLOAD' : (curStg?.name ? curStg.name.toUpperCase() : `STAGE ${stgNum}`);
			DOMUtils.setText(this.ui.header, `[ PROPULSION: ${stgTitle} ]`);
		} else if (this.ui.header) {
			DOMUtils.setText(this.ui.header, `[ PROPULSION & TANKS ]`);
		}

		DOMUtils.setText(this.ui.remDv, FormatUtils.numFixPad(UnitConvertUtils.m2km(tm.remDv), 2, 6));
		DOMUtils.setText(this.ui.twr, FormatUtils.numFixPad(tm.twr, 2, 6));

		const thrtlPercent = (target.thrustRatio || 0) * 100;
		DOMUtils.setText(this.ui.thrtl, FormatUtils.numFixPad(thrtlPercent, 1, 6));

		const isStageCutoff = target.stageState === 'STG_MECO' || target.stageState === 'ORBITAL_COAST' || (target.burnTime !== undefined && target.burnTime <= 0);
		const fuelRem = isStageCutoff ? 0 : (target.fuelMass || 0);
		const displayFuel = fuelRem < 0.01 ? 0 : fuelRem;
		DOMUtils.setText(this.ui.fuelMass, FormatUtils.numFixPad(displayFuel, 2, 6));

		const oxidRem = isStageCutoff ? 0 : (target.oxidMass || 0);
		const displayOxid = oxidRem < 0.01 ? 0 : oxidRem;
		DOMUtils.setText(this.ui.oxidMass, FormatUtils.numFixPad(displayOxid, 2, 6));

		const presFuel = tm.tankPresFuel || 0;
		const presOxid = tm.tankPresOxid || 0;
		DOMUtils.setText(this.ui.tankPresFuel, presFuel > 0 ? presFuel.toFixed(0) : "0");
		DOMUtils.setText(this.ui.tankPresOxid, presOxid > 0 ? presOxid.toFixed(0) : "0");

		if (!this.maxFuel[target.id] || fuelRem > this.maxFuel[target.id]) this.maxFuel[target.id] = fuelRem;
		let pctF = (!isStageCutoff && this.maxFuel[target.id] > 0) ? (fuelRem / this.maxFuel[target.id]) * 100 : 0;
		if (pctF < 0.5) { pctF = 0; }

		if (!this.maxOxid[target.id] || oxidRem > this.maxOxid[target.id]) this.maxOxid[target.id] = oxidRem;
		let pctO = (!isStageCutoff && this.maxOxid[target.id] > 0) ? (oxidRem / this.maxOxid[target.id]) * 100 : 0;
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
	/**
	 * @param {any} id
	 * @param {string} title
	 * @param {any} element
	 * @param {any} subRenderer
	 * @param {any} [universe] whose objects resolve the dominant body (REF BODY)
	 */
	constructor(id, title, element, subRenderer, universe = null) {
		super(id, title, element);
		this.subRenderer = subRenderer;
		this.universe = universe;
	}

	/**
	 * The dominant body of a main-thread object: the celestial body of `objects` whose id is `target.dominantBodyId`,
	 * which the Worker sends in the frame buffer (-1 for none). The Worker's own reference (CalcObject.dominantBody)
	 * never reaches the main thread: git 9efd5e3 read it here, so REF BODY always read "---". Null for a missing, -1 or
	 * unknown id, and for an id that names no celestial body (the Worker picks the dominant body among them only), or a
	 * body no longer in the simulation (removed while paused: the frame that names another body has not come yet, and
	 * the body stays listed until its trail has faded, design §4.13-31).
	 * @param {any} target
	 * @param {any} objects
	 * @returns {any}
	 */
	static resolveDominantBody(target, objects) {
		const id = target?.dominantBodyId;
		if (typeof id !== 'number' || !Array.isArray(objects)) { return null; }
		return objects.find((o) => o.id === id && o.type === OBJECT_TYPES.CELESTIAL && isLiveObject(o)) ?? null;
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
		// DIST REF is the distance from REF BODY: without a resolved body (none, or its id names no body of the universe,
		// e.g. one removed while paused) both read "---" (design §4.13-26)
		const dominantBody = NavigationCameraCard.resolveDominantBody(target, this.universe?.objects);
		const dominantName = dominantBody?.name || "---";
		const distRefKm = (dominantBody && target.distToDominantM > 0) ? UnitConvertUtils.m2km(target.distToDominantM) : 0;

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
