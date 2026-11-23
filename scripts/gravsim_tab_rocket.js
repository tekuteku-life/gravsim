
// gravsim_tab_rocket.js

import { PHYSICS, OBJECT_TYPES, OBJECT_STATE, MULTISTAGE_ROCKET } from './gravsim_const.js';
import { DOMUtils, UnitConvertUtils, isLiveObject } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';
import { presetManager, ROCKET_FUELS } from './gravsim_preset_manager.js';
import { RocketLauncher } from './gravsim_rocket_launcher.js';

// Base upper bound of the launch-thrust slider (index.html static max); raised dynamically for heavier vehicles
const THRUST_SLIDER_BASE_MAX_KN = 10000;
/** The step of the stage mass sliders (#rl-fuel-mass, #rl-oxid-mass, #rl-launch-mass): the sizing's 0.1 t */
const STAGE_MASS_STEP_T = 0.1;
/** Flight-plan cell value: a finite number, otherwise 0 (rows with non-finite fields are dropped at rollout, §3.4-1). */
const finiteOr0 = (/** @type {any} */ raw) => { const v = parseFloat(raw); return Number.isFinite(v) ? v : 0; };

export class RocketTab {
	constructor(universe) {
		this.universe = universe;
		this.presetManager = universe?.presetManager || presetManager;
		this.previousTimeScaleVal = null;
		this.previousZoomScaleVal = null;
		this.previousCameraTarget = null;
		this.previousCameraOffset = null;
		/** @type {number | string} */
		this.currentTab = 0;
		this._initElements();
		this._bindEvents();
		this.isOpened = false;

		// Subscribe to object list changes
		EventBus.on('object-list-changed', () => {
			this._updateRocketHostOptions();
		});
	}

	_initElements() {
		/** @type {Record<string, any>} */
		this.ui = {
			rlModeSelect: document.getElementById('rl-mode-select'),
			rlHostOptions: document.getElementById('rl-host-options'),
			rlHostSelect: document.getElementById('rl-host-select'),
			rlHostAngle: document.getElementById('rl-host-angle'),
			rlHostAngleVal: document.getElementById('rl-host-angle-val'),
			rlHostAlt: document.getElementById('rl-host-alt'),
			rlHostAltVal: document.getElementById('rl-host-alt-val'),
			rlVehicleSelect: document.getElementById('rl-vehicle-select'),
			rlPayloadSelect: document.getElementById('rl-payload-select'),
			rlMissionSelect: document.getElementById('rl-mission-select'),
			rlApplyConfigBtn: document.getElementById('rl-apply-config-btn'),
			rlPresetSelect: document.getElementById('rl-preset-select'),
			rlColorTheme: document.getElementById('rl-color-theme'),
			rlLoadPresetBtn: document.getElementById('rl-load-preset-btn'),
			rlStageTabs: document.getElementById('rl-stage-tabs'),
			rlStageConfigPanel: document.getElementById('rl-stage-config-panel'),
			rlStageTitle: document.getElementById('rl-stage-title'),
			rlFuelType: document.getElementById('rl-fuel-type'),
			rlFuelMass: document.getElementById('rl-fuel-mass'),
			rlFuelMassVal: document.getElementById('rl-fuel-mass-val'),
			rlOxidMass: document.getElementById('rl-oxid-mass'),
			rlOxidMassVal: document.getElementById('rl-oxid-mass-val'),
			rlLaunchMass: document.getElementById('rl-launch-mass'),
			rlLaunchMassVal: document.getElementById('rl-launch-mass-val'),
			rlLaunchThrust: document.getElementById('rl-launch-thrust'),
			rlLaunchThrustVal: document.getElementById('rl-launch-thrust-val'),
			rlSepDelay: document.getElementById('rl-sep-delay'),
			rlSepDelayVal: document.getElementById('rl-sep-delay-val'),
			rlSepDelayLabel: document.getElementById('rl-sep-delay-label'),
			rlIgnDelay: document.getElementById('rl-ign-delay'),
			rlIgnDelayVal: document.getElementById('rl-ign-delay-val'),
			rlIgnDelayLabel: document.getElementById('rl-ign-delay-label'),
			rlPayloadConfigPanel: document.getElementById('rl-payload-config-panel'),
			rlPayloadMass: document.getElementById('rl-payload-mass'),
			rlPayloadMassVal: document.getElementById('rl-payload-mass-val'),
			rlFairingEnabled: document.getElementById('rl-fairing-enabled'),
			rlFairingOptions: document.getElementById('rl-fairing-options'),
			rlFairingMass: document.getElementById('rl-fairing-mass'),
			rlFairingMassVal: document.getElementById('rl-fairing-mass-val'),
			rlFairingAlt: document.getElementById('rl-fairing-alt'),
			rlFairingAltVal: document.getElementById('rl-fairing-alt-val'),
			rlPayloadPropPanel: document.getElementById('rl-payload-propulsion-panel'),
			rlPayloadPropName: document.getElementById('rl-payload-prop-name'),
			rlPayloadThrustVal: document.getElementById('rl-payload-thrust-val'),
			rlPayloadBurnTimeVal: document.getElementById('rl-payload-burntime-val'),
			rlPayloadFuel: document.getElementById('rl-payload-fuel'),
			rlPayloadFuelVal: document.getElementById('rl-payload-fuel-val'),
			rlPayloadOxidLabel: document.getElementById('rl-payload-oxid-label'),
			rlPayloadOxid: document.getElementById('rl-payload-oxid'),
			rlPayloadOxidVal: document.getElementById('rl-payload-oxid-val'),
			rlLaunchMaxG: document.getElementById('rl-launch-maxg'),
			rlLaunchMaxGVal: document.getElementById('rl-launch-maxg-val'),
			rlAutoControl: document.getElementById('rl-auto-control'),
			rlFlightProfileBody: document.getElementById('rl-flight-profile-body'),
			rlAddProfileBtn: document.getElementById('rl-add-profile-btn'),
			rlStatDv: document.getElementById('rl-stat-dv'),
			rlStatHostName: document.getElementById('rl-stat-host-name'),
			rlStatTwrY: document.getElementById('rl-stat-twr-y'),
			rlStatTwrX: document.getElementById('rl-stat-twr-x'),
			rlStatTotalMass: document.getElementById('rl-stat-total-mass'),
			rlStatStageCount: document.getElementById('rl-stat-stage-count'),
			rlStageDvBreakdown: document.getElementById('rl-stage-dv-breakdown'),
			massSelect: document.getElementById('mass-select'),
			rlRolloutBtn: document.getElementById('rl-rollout-btn'),
			rlIgnitionGroup: document.getElementById('rl-ignition-group'),
			rlIgniteQuickBtn: document.getElementById('rl-ignite-quick-btn'),
			rlIgniteFullBtn: document.getElementById('rl-ignite-full-btn'),
			rlAbortBtn: document.getElementById('rl-abort-btn'),
		};
		DOMUtils.verifyElements(this.ui, 'RocketTab');
	}

	_bindEvents() {
		this.ui.rlAddProfileBtn.addEventListener('click', () => {
			this.universe.RocketLauncher.flightProfile.push({ type: 'alt', value: 0, thrust: 100, angle: 0, action: '' });
			this._renderProfileTable();
			this._updateRocketStats();
		});
		this._renderProfileTable();

		this.ui.rlModeSelect.addEventListener('change', (/** @type {any} */ e) => {
			this.universe.RocketLauncher.mode = e.target.value;
			this.ui.rlHostOptions.style.display = e.target.value === 'host' ? 'block' : 'none';
			this._updateRocketStats();
		});

		// Preset Load & Orthogonal 3-Way Selection
		this._initPresetSelectors();

		if (this.ui.rlPayloadSelect) {
			this.ui.rlPayloadSelect.addEventListener('change', (/** @type {any} */ e) => {
				const pId = e.target.value;
				const recMission = this.presetManager.getRecommendedMissionForPayload(pId);
				if (this.ui.rlMissionSelect && recMission) {
					this.ui.rlMissionSelect.value = recMission;
				}
				this.applyOrthogonalConfig({ payloadId: pId, missionId: recMission });
			});
		}

		if (this.ui.rlMissionSelect) {
			this.ui.rlMissionSelect.addEventListener('change', (/** @type {any} */ e) => {
				this.applyOrthogonalConfig({ missionId: e.target.value });
			});
		}

		if (this.ui.rlVehicleSelect) {
			this.ui.rlVehicleSelect.addEventListener('change', (/** @type {any} */ e) => {
				this.applyOrthogonalConfig({ vehicleId: e.target.value });
			});
		}

		if (this.ui.rlApplyConfigBtn) {
			this.ui.rlApplyConfigBtn.addEventListener('click', () => {
				this.applyOrthogonalConfig({
					vehicleId: this.ui.rlVehicleSelect?.value,
					payloadId: this.ui.rlPayloadSelect?.value,
					missionId: this.ui.rlMissionSelect?.value
				});
			});
		}

		if (this.ui.rlLoadPresetBtn) {
			this.ui.rlLoadPresetBtn.addEventListener('click', () => {
				this.loadPreset(this.ui.rlPresetSelect.value);
			});
		}
		if (this.ui.rlPresetSelect) {
			this.ui.rlPresetSelect.addEventListener('change', (/** @type {any} */ e) => {
				this.loadPreset(e.target.value);
			});
		}

		// Theme Color
		this.ui.rlColorTheme.value = this.universe.RocketLauncher.colorTheme;
		this.ui.rlColorTheme.addEventListener('change', (/** @type {any} */ e) => {
			this.universe.RocketLauncher.colorTheme = e.target.value;
			this._updateRocketStats();
		});

		// Initial stage tab rendering
		this._renderStageTabs();
		this.selectTab(0);

		this.ui.rlFuelType.addEventListener('change', (/** @type {any} */ e) => {
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			const oldFuelType = stg.fuelType || 'liquid';
			const newFuelType = e.target.value;
			stg.fuelType = newFuelType;
			const oldFuelDef = ROCKET_FUELS[oldFuelType] || ROCKET_FUELS['liquid'];
			const newFuelDef = ROCKET_FUELS[newFuelType] || ROCKET_FUELS['liquid'];

			// 1. Calculate propellant mass scaled by density ratio (conserving tank volume)
			const currentPropT = (stg.fuelMassT || 0) + (stg.oxidMassT || 0);
			const basePropT = currentPropT > 0 ? currentPropT : 100;
			const densityRatio = (newFuelDef.density && oldFuelDef.density) ? (newFuelDef.density / oldFuelDef.density) : 1.0;
			let scaledPropT = Math.max(1, Math.round(basePropT * densityRatio));

			// 2. Allocate fuel and oxidizer based on ofRatio
			if (newFuelDef.ofRatio === 0) {
				// Solid or Ion: No separate oxidizer
				stg.fuelMassT = Math.min(scaledPropT, 1500);
				stg.oxidMassT = 0;
				this.ui.rlOxidMass.value = 0;
				this.ui.rlOxidMass.disabled = true;
			} else {
				this.ui.rlOxidMass.disabled = false;
				const fuelPart = Math.max(1, Math.round(scaledPropT / (1 + newFuelDef.ofRatio)));
				const oxidPart = Math.max(0, Math.round(fuelPart * newFuelDef.ofRatio));
				stg.fuelMassT = Math.min(fuelPart, 1500);
				stg.oxidMassT = Math.min(oxidPart, 3000);
				this.ui.rlOxidMass.value = stg.oxidMassT;
			}
			this.ui.rlFuelMass.value = stg.fuelMassT;
			if (this.ui.rlFuelMassVal) this.ui.rlFuelMassVal.textContent = stg.fuelMassT;
			if (this.ui.rlOxidMassVal) this.ui.rlOxidMassVal.textContent = stg.oxidMassT;

			// 3. For stage 1: Safeguard liftoff TWR >= 1.25 on Earth
			if (this.currentTab === 0) {
				const rl = this.universe.RocketLauncher;
				const payloadM = (rl.payload?.massT !== undefined) ? rl.payload.massT : 8.0;
				const fairingM = (rl.fairing?.enabled ? rl.fairing.massT : 0) || 0;
				let totalLiftoffMassT = payloadM + fairingM + stg.dryMassT + stg.fuelMassT + stg.oxidMassT;
				for (let i = 1; i < (rl.stages?.length || 0); i++) {
					const s = rl.stages[i];
					totalLiftoffMassT += (s.dryMassT + s.fuelMassT + s.oxidMassT);
				}
				const targetTwr = (newFuelType === 'ion') ? 0.05 : 1.35;
				const minThrustKN = Math.round((totalLiftoffMassT * PHYSICS.G0 * targetTwr) / 50) * 50;
				if (newFuelType !== 'ion' && stg.thrustKN < minThrustKN) {
					// Raise toward the TWR floor, but never lower a vehicle already above the slider's base range
					const thrustCapKN = Math.max(THRUST_SLIDER_BASE_MAX_KN, Math.ceil(stg.thrustKN));
					stg.thrustKN = Math.min(Math.max(stg.thrustKN, minThrustKN), thrustCapKN);
				}
				this._syncThrustSlider(stg.thrustKN);
			}

			// 4. Recalculate burn time
			this._recalculateStageBurnTime(stg);

			this._syncStageZero();
			this._updateRocketStats();
		});

		// The stage sliders step by the resolution of the preset and mission sizing (0.1 t, 1 kN; index.html), so they
		// show the sized values exactly (design §4.14-4): the values are read as decimals, and the propellant that follows
		// the O/F ratio is rounded to the same 0.1 t
		this.ui.rlFuelMass.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.fuelMassT = val;
			this.ui.rlFuelMassVal.textContent = val;

			const fuelDef = ROCKET_FUELS[stg.fuelType || 'liquid'];
			if (fuelDef && fuelDef.ofRatio > 0) {
				const newOxid = RocketTab.roundToSliderStep(val * fuelDef.ofRatio, STAGE_MASS_STEP_T);
				stg.oxidMassT = newOxid;
				this.ui.rlOxidMass.value = newOxid;
				this.ui.rlOxidMassVal.textContent = newOxid;
			}
			this._recalculateStageBurnTime(stg);
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlOxidMass.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.oxidMassT = val;
			this.ui.rlOxidMassVal.textContent = val;

			const fuelDef = ROCKET_FUELS[stg.fuelType || 'liquid'];
			if (fuelDef && fuelDef.ofRatio > 0) {
				const newFuel = RocketTab.roundToSliderStep(val / fuelDef.ofRatio, STAGE_MASS_STEP_T);
				stg.fuelMassT = newFuel;
				this.ui.rlFuelMass.value = newFuel;
				this.ui.rlFuelMassVal.textContent = newFuel;
			}
			this._recalculateStageBurnTime(stg);
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlLaunchMass.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.dryMassT = val;
			this.ui.rlLaunchMassVal.textContent = val;
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlLaunchThrust.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.thrustKN = val;
			this.ui.rlLaunchThrustVal.textContent = val;
			this._recalculateStageBurnTime(stg);
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlSepDelay.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.separationDelaySec = val;
			if (this.ui.rlSepDelayVal) this.ui.rlSepDelayVal.textContent = val.toFixed(1);
			this._updateRocketStats();
		});

		this.ui.rlIgnDelay.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.ignitionDelaySec = val;
			if (this.ui.rlIgnDelayVal) this.ui.rlIgnDelayVal.textContent = val.toFixed(1);
			this._updateRocketStats();
		});

		// Payload & Fairing Inputs
		this.ui.rlPayloadMass.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const rl = this.universe.RocketLauncher;
			if (!rl.payload) rl.payload = {};
			rl.payload.massT = val;
			// 0.01 t, the resolution of the payload sizing (as the slider steps)
			if (this.ui.rlPayloadMassVal) this.ui.rlPayloadMassVal.textContent = val.toFixed(2);
			this._updateRocketStats();
		});

		this.ui.rlFairingEnabled.addEventListener('change', (/** @type {any} */ e) => {
			const rl = this.universe.RocketLauncher;
			if (!rl.fairing) rl.fairing = {};
			rl.fairing.enabled = e.target.checked;
			if (this.ui.rlFairingOptions) {
				this.ui.rlFairingOptions.style.display = e.target.checked ? 'block' : 'none';
			}
			this._updateRocketStats();
		});

		this.ui.rlFairingMass.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseFloat(e.target.value);
			const rl = this.universe.RocketLauncher;
			if (!rl.fairing) rl.fairing = {};
			rl.fairing.massT = val;
			if (this.ui.rlFairingMassVal) this.ui.rlFairingMassVal.textContent = val.toFixed(1);
			this._updateRocketStats();
		});

		this.ui.rlFairingAlt.addEventListener('input', (/** @type {any} */ e) => {
			const val = parseInt(e.target.value, 10);
			const rl = this.universe.RocketLauncher;
			if (!rl.fairing) rl.fairing = {};
			rl.fairing.separationAltKm = val;
			if (this.ui.rlFairingAltVal) this.ui.rlFairingAltVal.textContent = val;
			this._updateRocketStats();
		});

		if (this.ui.rlPayloadFuel) {
			this.ui.rlPayloadFuel.addEventListener('input', (/** @type {any} */ e) => {
				const val = Number(e.target.value);
				if (this.ui.rlPayloadFuelVal) this.ui.rlPayloadFuelVal.textContent = val.toFixed(2);
				const rl = this.universe.RocketLauncher;
				if (rl.payload?.propulsion) {
					rl.payload.propulsion.fuelMassT = val;
					this._syncPayloadPropulsion();
				}
			});
		}

		if (this.ui.rlPayloadOxid) {
			this.ui.rlPayloadOxid.addEventListener('input', (/** @type {any} */ e) => {
				const val = Number(e.target.value);
				if (this.ui.rlPayloadOxidVal) this.ui.rlPayloadOxidVal.textContent = val.toFixed(2);
				const rl = this.universe.RocketLauncher;
				if (rl.payload?.propulsion) {
					rl.payload.propulsion.oxidMassT = val;
					this._syncPayloadPropulsion();
				}
			});
		}

		this.ui.rlHostSelect.addEventListener('change', (/** @type {any} */ e) => {
			const newHostId = parseInt(e.target.value, 10);
			this.universe.RocketLauncher.hostId = newHostId;
			// The user's choice: kept when bodies are added, even the world center (design §4.13-27)
			this.universe.RocketLauncher.hostAutoSelected = false;
			this._setupLaunchEnvironment(newHostId);
			this._updateRocketStats();
		});
		this.ui.rlHostSelect.addEventListener('focus', () => {
			this._updateRocketStats();
		});
		this.ui.rlAutoControl.addEventListener('change', (/** @type {any} */ e) => {
			this.universe.RocketLauncher.autoControl = e.target.checked;
		});
		this.ui.rlRolloutBtn.addEventListener('click', () => this.universe.RocketLauncher.rollout());

		const triggerIgnite = (sequenceType) => {
			// Resume simulation to ensure physics worker runs during sequence
			EventBus.emit('simulation:resume');

			// Real time for the launch; the camera and zoom stay on the pad
			this.applyLaunchView();

			this.universe.RocketLauncher.ignite(sequenceType);
		};

		this.ui.rlIgniteQuickBtn.addEventListener('click', () => triggerIgnite('LEGACY_QUICK'));
		this.ui.rlIgniteFullBtn.addEventListener('click', () => triggerIgnite('FULL_COUNTDOWN'));
		this.ui.rlAbortBtn.addEventListener('click', () => {
			this.universe.RocketLauncher.abortRollout();
			let hostId = this.universe.RocketLauncher.hostId;
			if (this._isReplaceableHost(hostId)) {
				hostId = this._assignDefaultHost();
			}
			this._setupLaunchEnvironment(hostId);
			this._updateRocketHostOptions();
			this._updateRocketStats();
		});

		EventBus.on('ui:set-controls-locked', (isLocked) => {
			this.ui.rlIgniteQuickBtn.disabled = isLocked;
			this.ui.rlIgniteFullBtn.disabled = isLocked;
		});

		EventBus.on('ui:set-rollout-state', (isRollouted) => {
			this.setRolloutState(isRollouted);
		});

		// Helper to bind range inputs to RocketLauncher properties
		const bindSlider = (sliderId, valId, propName, isFloat = false) => {
			if (this.ui[sliderId]) {
				this.ui[sliderId].addEventListener('input', (/** @type {any} */ e) => {
					const val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
					this.universe.RocketLauncher[propName] = val;
					if (this.ui[valId]) {
						this.ui[valId].textContent = val;
					}
					this._updateRocketStats();
				});
			}
		};

		// Bind Rocket Launcher global sliders
		bindSlider('rlHostAngle', 'rlHostAngleVal', 'hostAngleDeg');
		bindSlider('rlHostAlt', 'rlHostAltVal', 'hostAltitudeM', true);
		bindSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', 'maxGLimit', true);

		this.ui.massSelect.addEventListener('change', () => this._updateRocketStats());

		document.addEventListener('rocket-preview-updated', () => {
			this._updateRocketStats();
		});
	}

	/**
	 * Round a value to a decimal slider step (0.1, 0.01 ...) as the sizing rounds (Math.round(v * 10) / 10 for 0.1), so
	 * the result is the decimal the slider holds and not v / step * step with its binary error.
	 * @param {number} value
	 * @param {number} step a power of ten at most 1
	 * @returns {number}
	 */
	static roundToSliderStep(value, step) {
		const perUnit = Math.round(1 / step);
		return Math.round(value * perUnit) / perUnit;
	}

	_syncThrustSlider(thrustKN) {
		const val = Number(thrustKN) || 0;
		if (this.ui.rlLaunchThrust) {
			this.ui.rlLaunchThrust.max = String(Math.max(THRUST_SLIDER_BASE_MAX_KN, Math.ceil(val)));
			this.ui.rlLaunchThrust.value = val;
		}
		if (this.ui.rlLaunchThrustVal) {
			this.ui.rlLaunchThrustVal.textContent = val;
		}
	}

	_renderProfileTable() {
		if (!this.ui.rlFlightProfileBody) { return; }
		this.ui.rlFlightProfileBody.innerHTML = '';
		const profile = this.universe.RocketLauncher.flightProfile;
		
		profile.forEach((step, index) => {
			const tr = document.createElement('tr');
			
			const tdType = document.createElement('td');
			const selType = document.createElement('select');
			selType.className = 'fp-trigger';
			selType.innerHTML = `<option value="alt" ${step.type==='alt'?'selected':''}>Alt(m)</option><option value="time" ${step.type==='time'?'selected':''}>Time(s)</option><option value="vel" ${step.type==='vel'?'selected':''}>Vel(m/s)</option><option value="apogee" ${step.type==='apogee'?'selected':''}>Apogee(s)</option>`;
			selType.onchange = (/** @type {any} */ e) => { step.type = e.target.value; this._updateRocketStats(); };
			tdType.appendChild(selType);
			
			const tdVal = document.createElement('td');
			const inpVal = document.createElement('input');
			inpVal.type = 'number'; inpVal.className = 'fp-val'; inpVal.value = step.value; inpVal.min = '0';
			inpVal.onchange = (/** @type {any} */ e) => { step.value = finiteOr0(e.target.value); this._updateRocketStats(); };
			tdVal.appendChild(inpVal);
			
			const tdThrust = document.createElement('td');
			const inpThrust = document.createElement('input');
			inpThrust.type = 'number'; inpThrust.className = 'fp-thrust'; inpThrust.value = step.thrust; inpThrust.min = '0'; inpThrust.max = '100';
			inpThrust.onchange = (/** @type {any} */ e) => { step.thrust = finiteOr0(e.target.value); this._updateRocketStats(); };
			tdThrust.appendChild(inpThrust);
			
			const tdAngle = document.createElement('td');
			const inpAngle = document.createElement('input');
			inpAngle.type = 'number'; inpAngle.className = 'fp-angle'; inpAngle.value = step.angle; inpAngle.min = '-90'; inpAngle.max = '90';
			inpAngle.onchange = (/** @type {any} */ e) => { step.angle = finiteOr0(e.target.value); this._updateRocketStats(); };
			tdAngle.appendChild(inpAngle);

			const tdAction = document.createElement('td');
			const selAction = document.createElement('select');
			selAction.className = 'fp-action';
			const curAction = step.action || '';
			selAction.innerHTML = `<option value="" ${curAction===''?'selected':''}>-</option><option value="sep_stage1" ${curAction==='sep_stage1'?'selected':''}>Stg1</option><option value="sep_stage2" ${curAction==='sep_stage2'?'selected':''}>Stg2</option><option value="sep_payload" ${curAction==='sep_payload'?'selected':''}>Pay</option>`;
			selAction.onchange = (/** @type {any} */ e) => { step.action = e.target.value; this._updateRocketStats(); };
			tdAction.appendChild(selAction);
			
			const tdAct = document.createElement('td');
			const btnDel = document.createElement('button');
			btnDel.type = 'button'; btnDel.className = 'remove-step-btn fp-del'; btnDel.textContent = '✕';
			btnDel.onclick = () => { 
				this.universe.RocketLauncher.flightProfile.splice(index, 1);
				this._renderProfileTable();
				this._updateRocketStats();
			};
			tdAct.appendChild(btnDel);
			
			tr.appendChild(tdType);
			tr.appendChild(tdVal);
			tr.appendChild(tdThrust);
			tr.appendChild(tdAngle);
			tr.appendChild(tdAction);
			tr.appendChild(tdAct);
			
			this.ui.rlFlightProfileBody.appendChild(tr);
		});
	}

	_getCurrentStage() {
		const rl = this.universe.RocketLauncher;
		if (!rl.stages) return null;
		if (typeof this.currentTab === 'number') {
			return rl.stages[this.currentTab] || null;
		}
		return null;
	}

	_recalculateStageBurnTime(stg) {
		if (!stg) return;
		const fuelDef = ROCKET_FUELS[stg.fuelType || 'liquid'] || ROCKET_FUELS['liquid'];
		const totalPropT = (stg.fuelMassT || 0) + (stg.oxidMassT || 0);
		const thrustKN = stg.thrustKN || 0;
		if (thrustKN > 0 && totalPropT > 0) {
			const isp = stg.ispVac || stg.isp || fuelDef.ispVac || fuelDef.isp || 320;
			const burnTime = (totalPropT * isp * PHYSICS.G0) / thrustKN;
			stg.burnTime = Math.round(burnTime * 10) / 10;
		}
		if (this.currentTab === 0) {
			this.universe.RocketLauncher.calculatedBurnTime = stg.burnTime || 0;
		}
	}

	_syncStageZero() {
		if (this.currentTab === 0) {
			const rl = this.universe.RocketLauncher;
			const stg0 = rl.stages?.[0];
			if (stg0) {
				rl.dryMassT = stg0.dryMassT;
				rl.fuelMassT = stg0.fuelMassT;
				rl.oxidMassT = stg0.oxidMassT;
				rl.thrustKN = stg0.thrustKN;
				rl.fuelType = stg0.fuelType;
				if (stg0.burnTime !== undefined) {
					rl.calculatedBurnTime = stg0.burnTime;
				}
			}
		}
	}

	_syncPayloadPropulsion() {
		const rl = this.universe.RocketLauncher;
		const prop = rl.payload?.propulsion;
		if (!prop || !prop.enabled) return;
		const fuelDef = ROCKET_FUELS[prop.fuelType || 'liquid'] || { isp: 320, ispVac: 320, ispSl: 282 };
		const isp = prop.ispVac || prop.isp || fuelDef.ispVac || fuelDef.isp || 320;
		const thrustN = (prop.thrustKN || 10) * 1000;
		const totalPropKg = ((prop.fuelMassT || 0) + (prop.oxidMassT || 0)) * 1000;
		prop.burnTime = thrustN > 0 ? Math.round(((totalPropKg * isp * PHYSICS.G0) / thrustN) * 10) / 10 : 0;
		rl.payload.massT = Math.round(((prop.dryMassT || 0) + (prop.fuelMassT || 0) + (prop.oxidMassT || 0)) * 100) / 100;
		if (this.ui.rlPayloadMass) this.ui.rlPayloadMass.value = rl.payload.massT;
		if (this.ui.rlPayloadMassVal) this.ui.rlPayloadMassVal.textContent = rl.payload.massT;
		if (this.ui.rlPayloadBurnTimeVal) this.ui.rlPayloadBurnTimeVal.textContent = prop.burnTime;
		this._updateRocketStats();
	}

	_renderStageTabs() {
		if (!this.ui.rlStageTabs) return;
		this.ui.rlStageTabs.innerHTML = '';
		const rl = this.universe.RocketLauncher;
		const stages = rl.stages || [];
		stages.forEach((stg, i) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = `rl-stage-tab-btn ${this.currentTab === i ? 'active' : ''}`;
			btn.style.cssText = 'flex: 1; padding: 5px 2px; font-size: 11px;';
			btn.textContent = `Stage ${i + 1}`;
			btn.onclick = () => this.selectTab(i);
			this.ui.rlStageTabs.appendChild(btn);
		});

		const pBtn = document.createElement('button');
		pBtn.type = 'button';
		pBtn.className = `rl-stage-tab-btn ${this.currentTab === 'payload' ? 'active' : ''}`;
		pBtn.style.cssText = 'flex: 1; padding: 5px 2px; font-size: 11px;';
		pBtn.textContent = 'Payload';
		pBtn.onclick = () => this.selectTab('payload');
		this.ui.rlStageTabs.appendChild(pBtn);
	}

	selectTab(tabKey) {
		this.currentTab = tabKey;
		const rl = this.universe.RocketLauncher;

		if (this.ui.rlStageTabs) {
			const buttons = this.ui.rlStageTabs.querySelectorAll('.rl-stage-tab-btn');
			buttons.forEach(btn => {
				const isP = btn.textContent.toLowerCase().includes('payload');
				if (tabKey === 'payload' && isP) {
					btn.classList.add('active');
				} else if (tabKey !== 'payload' && !isP && btn.textContent.includes(`${Number(tabKey) + 1}`)) {
					btn.classList.add('active');
				} else {
					btn.classList.remove('active');
				}
			});
		}

		if (tabKey === 'payload') {
			if (this.ui.rlStageConfigPanel) this.ui.rlStageConfigPanel.style.display = 'none';
			if (this.ui.rlPayloadConfigPanel) this.ui.rlPayloadConfigPanel.style.display = 'block';
			const pMass = rl.payload?.massT !== undefined ? rl.payload.massT : 8.0;
			if (this.ui.rlPayloadMass) this.ui.rlPayloadMass.value = pMass;
			if (this.ui.rlPayloadMassVal) this.ui.rlPayloadMassVal.textContent = pMass;
			const fEnabled = !!rl.fairing?.enabled;
			if (this.ui.rlFairingEnabled) this.ui.rlFairingEnabled.checked = fEnabled;
			if (this.ui.rlFairingOptions) this.ui.rlFairingOptions.style.display = fEnabled ? 'block' : 'none';
			const fMass = rl.fairing?.massT !== undefined ? rl.fairing.massT : 1.7;
			if (this.ui.rlFairingMass) this.ui.rlFairingMass.value = fMass;
			if (this.ui.rlFairingMassVal) this.ui.rlFairingMassVal.textContent = fMass;
			const fAlt = rl.fairing?.separationAltKm !== undefined ? rl.fairing.separationAltKm : MULTISTAGE_ROCKET.FAIRING_DEFAULT_ALT_KM;
			if (this.ui.rlFairingAlt) this.ui.rlFairingAlt.value = fAlt;
			if (this.ui.rlFairingAltVal) this.ui.rlFairingAltVal.textContent = fAlt;

			if (rl.payload?.propulsion?.enabled) {
				const prop = rl.payload.propulsion;
				if (this.ui.rlPayloadPropPanel) this.ui.rlPayloadPropPanel.style.display = 'block';
				if (this.ui.rlPayloadPropName) this.ui.rlPayloadPropName.textContent = prop.name || 'On-board Spacecraft Propulsion';
				if (this.ui.rlPayloadThrustVal) this.ui.rlPayloadThrustVal.textContent = prop.thrustKN || 0;
				if (this.ui.rlPayloadBurnTimeVal) this.ui.rlPayloadBurnTimeVal.textContent = prop.burnTime || 0;
				if (this.ui.rlPayloadFuel) {
					this.ui.rlPayloadFuel.value = prop.fuelMassT || 0;
					if (this.ui.rlPayloadFuelVal) this.ui.rlPayloadFuelVal.textContent = (prop.fuelMassT || 0).toFixed(2);
				}
				if (this.ui.rlPayloadOxid) {
					this.ui.rlPayloadOxid.value = prop.oxidMassT || 0;
					if (this.ui.rlPayloadOxidVal) this.ui.rlPayloadOxidVal.textContent = (prop.oxidMassT || 0).toFixed(2);
					const isSolid = prop.fuelType === 'solid' || prop.ofRatio === 0;
					this.ui.rlPayloadOxid.disabled = isSolid;
					if (this.ui.rlPayloadOxidLabel) this.ui.rlPayloadOxidLabel.style.display = isSolid ? 'none' : 'block';
				}
			} else {
				if (this.ui.rlPayloadPropPanel) this.ui.rlPayloadPropPanel.style.display = 'none';
			}
		} else {
			const stgIdx = Number(tabKey);
			const stg = rl.stages?.[stgIdx];
			if (!stg) { return; }
			if (this.ui.rlStageConfigPanel) this.ui.rlStageConfigPanel.style.display = 'block';
			if (this.ui.rlPayloadConfigPanel) this.ui.rlPayloadConfigPanel.style.display = 'none';
			const titleText = stg.name ? stg.name.toUpperCase() : (stgIdx === 0 ? 'BOOSTER' : 'UPPER');
			if (this.ui.rlStageTitle) this.ui.rlStageTitle.textContent = `-- STAGE ${stgIdx + 1}: ${titleText} --`;
			if (this.ui.rlFuelType) this.ui.rlFuelType.value = stg.fuelType || 'liquid';
			if (this.ui.rlFuelMass) this.ui.rlFuelMass.value = stg.fuelMassT;
			if (this.ui.rlFuelMassVal) this.ui.rlFuelMassVal.textContent = stg.fuelMassT;
			const fuelDef = ROCKET_FUELS[stg.fuelType || 'liquid'];
			if (this.ui.rlOxidMass) {
				this.ui.rlOxidMass.value = stg.oxidMassT;
				this.ui.rlOxidMass.disabled = Boolean(fuelDef && fuelDef.ofRatio === 0);
			}
			if (this.ui.rlOxidMassVal) this.ui.rlOxidMassVal.textContent = stg.oxidMassT;
			if (this.ui.rlLaunchMass) this.ui.rlLaunchMass.value = stg.dryMassT;
			if (this.ui.rlLaunchMassVal) this.ui.rlLaunchMassVal.textContent = stg.dryMassT;
			this._syncThrustSlider(stg.thrustKN);
			if (this.ui.rlSepDelay) {
				this.ui.rlSepDelay.value = stg.separationDelaySec !== undefined ? stg.separationDelaySec : 2.0;
				if (this.ui.rlSepDelayVal) this.ui.rlSepDelayVal.textContent = Number(this.ui.rlSepDelay.value).toFixed(1);
			}
			if (this.ui.rlIgnDelay) {
				this.ui.rlIgnDelay.value = stg.ignitionDelaySec !== undefined ? stg.ignitionDelaySec : 2.0;
				if (this.ui.rlIgnDelayVal) this.ui.rlIgnDelayVal.textContent = Number(this.ui.rlIgnDelay.value).toFixed(1);
			}
			const isFirstStage = stgIdx === 0;
			if (this.ui.rlIgnDelayLabel) this.ui.rlIgnDelayLabel.style.display = isFirstStage ? 'none' : 'block';
			if (this.ui.rlIgnDelay) this.ui.rlIgnDelay.style.display = isFirstStage ? 'none' : 'block';
			const isLastStage = stgIdx + 1 >= (rl.stages?.length || 1);
			if (this.ui.rlSepDelayLabel) this.ui.rlSepDelayLabel.style.display = isLastStage ? 'none' : 'block';
			if (this.ui.rlSepDelay) this.ui.rlSepDelay.style.display = isLastStage ? 'none' : 'block';
		}
	}

	_initPresetSelectors() {
		const rl = this.universe?.RocketLauncher;
		const selectPreferred = (selectEl, items, preferredId) => {
			if (!selectEl || items.length === 0) return;
			const hasPreferred = preferredId && items.some(item => item.id === preferredId);
			selectEl.value = hasPreferred ? preferredId : items[0].id;
		};

		if (this.ui.rlVehicleSelect) {
			const vehicles = this.presetManager.getVehicles();
			this.ui.rlVehicleSelect.innerHTML = '';
			vehicles.forEach(v => {
				const opt = document.createElement('option');
				opt.value = v.id;
				opt.textContent = v.name;
				this.ui.rlVehicleSelect.appendChild(opt);
			});
			selectPreferred(this.ui.rlVehicleSelect, vehicles, rl?.currentVehicleId);
		}

		if (this.ui.rlPayloadSelect) {
			const payloads = this.presetManager.getPayloads();
			this.ui.rlPayloadSelect.innerHTML = '';
			payloads.forEach(p => {
				const opt = document.createElement('option');
				opt.value = p.id;
				opt.textContent = p.name;
				this.ui.rlPayloadSelect.appendChild(opt);
			});
			selectPreferred(this.ui.rlPayloadSelect, payloads, rl?.currentPayloadId);
		}

		if (this.ui.rlMissionSelect) {
			const missions = this.presetManager.getMissions();
			this.ui.rlMissionSelect.innerHTML = '';
			missions.forEach(m => {
				const opt = document.createElement('option');
				opt.value = m.id;
				opt.textContent = `${m.name} [${m.targetOrbit || ''}]`;
				this.ui.rlMissionSelect.appendChild(opt);
			});
			selectPreferred(this.ui.rlMissionSelect, missions, rl?.currentMissionId);
		}
	}

	/** @param {{ vehicleId?: string, payloadId?: string, missionId?: string }} [opts] */
	applyOrthogonalConfig({ vehicleId, payloadId, missionId } = {}) {
		const rl = this.universe.RocketLauncher;
		this.presetManager.applyToLauncher(rl, { vehicleId, payloadId, missionId });

		if (this.ui.rlColorTheme) {
			this.ui.rlColorTheme.value = rl.colorTheme || 'classic';
		}
		if (vehicleId && this.ui.rlPresetSelect) {
			const legacyKey = vehicleId.toUpperCase();
			if (this.ui.rlPresetSelect.querySelector(`option[value="${legacyKey}"]`)) {
				this.ui.rlPresetSelect.value = legacyKey;
			}
		}
		this._syncStageZero();
		this._renderStageTabs();
		this.selectTab(this.currentTab || 0);
		this._renderProfileTable();
		this._updateRocketStats();
		// The mission sets the prediction period (applyToLauncher); the System-tab slider shows it
		EventBus.emit('ui:sync-prediction-duration', rl.predictionDurationMonths);
	}

	loadPreset(presetKey) {
		const preset = this.presetManager.getLegacyPreset(presetKey);
		if (!preset) return;
		const rl = this.universe.RocketLauncher;
		rl.currentPresetId = presetKey;
		rl.colorTheme = preset.colorTheme || 'classic';
		if (this.ui.rlColorTheme) {
			this.ui.rlColorTheme.value = rl.colorTheme;
		}
		rl.stages = JSON.parse(JSON.stringify(preset.stages));
		rl.payload = JSON.parse(JSON.stringify(preset.payload || { massT: 0 }));
		rl.fairing = JSON.parse(JSON.stringify(preset.fairing || { enabled: false, massT: 0, separationAltKm: MULTISTAGE_ROCKET.FAIRING_DEFAULT_ALT_KM }));
		rl.boosters = (preset.boosters || preset.rendering?.boosters) ? {
			...(preset.rendering?.boosters || {}),
			...(preset.boosters || {})
		} : null;
		rl.rendering = preset.rendering ? JSON.parse(JSON.stringify(preset.rendering)) : null;
		if (rl.stages?.[0]) {
			rl.calculatedBurnTime = rl.stages[0].burnTime;
		}
		if (preset.flightProfile) {
			rl.flightProfile = JSON.parse(JSON.stringify(preset.flightProfile));
			this._renderProfileTable();
		}
		if (this.ui.rlVehicleSelect) {
			const vId = String(presetKey).toLowerCase();
			if (this.ui.rlVehicleSelect.querySelector(`option[value="${vId}"]`)) {
				this.ui.rlVehicleSelect.value = vId;
			}
		}
		this._syncStageZero();
		this.currentTab = 0;
		this._renderStageTabs();
		this.selectTab(0);
		this._updateRocketStats();
	}

	_getDefaultHostId() {
		// Bodies still in the simulation: a removed one stays listed until its trail has faded (design §4.13-30)
		const celestials = this.universe.objects.filter(o => o.type === OBJECT_TYPES.CELESTIAL && o.state === OBJECT_STATE.ACTIVE);
		const earth = celestials.find(o => o.name === 'Earth' || o.name?.toLowerCase() === 'earth');
		if (earth) {
			return earth.id;
		}
		// Any body but the world center (earlier "id !== 0", which after a Reset no longer named it, design §4.13-27)
		const nonCenterCelestials = celestials.filter(o => !o.isWorldCenter);
		if (nonCenterCelestials.length > 0) {
			return nonCenterCelestials[nonCenterCelestials.length - 1].id;
		}
		if (celestials.length > 0) {
			return celestials[celestials.length - 1].id;
		}
		// No celestial body: no host (null), not the id 0 of an object that may exist (design §4.13-24)
		return null;
	}

	/**
	 * Set the launcher host to the default host (_getDefaultHostId) as an automatic choice.
	 * @returns {number | null} the new host id
	 */
	_assignDefaultHost() {
		const rl = this.universe.RocketLauncher;
		rl.hostId = this._getDefaultHostId();
		rl.hostAutoSelected = true;
		return rl.hostId;
	}

	/**
	 * Whether the launcher host is to be replaced by the default host: no host, or the world center chosen
	 * automatically because no other body existed (then a body added later becomes the host, as at startup). A host the
	 * user chose (the world center too) is kept. Earlier "hostId === 0", which took the user's choice of the Sun of the
	 * first world for an automatic one and missed the Sun of a Reset (design §4.13-27).
	 * @param {any} hostId
	 */
	_isReplaceableHost(hostId) {
		if (hostId === null || hostId === undefined) { return true; }
		if (this.universe.RocketLauncher.hostAutoSelected !== true) { return false; }
		const host = this.universe.objects.find(o => o.id === hostId && o.type === OBJECT_TYPES.CELESTIAL);
		return Boolean(host && host.isWorldCenter);
	}

	_updateRocketHostOptions() {
		let currentHostId = this.universe.RocketLauncher.hostId;
		if (this._isReplaceableHost(currentHostId)) {
			currentHostId = this._assignDefaultHost();
		}
		this.ui.rlHostSelect.innerHTML = '';

		// Launch hosts: the celestial bodies in the simulation. Earlier every object but rockets, so debris and removed
		// bodies still fading out were offered too (design §4.13-31; a host is a celestial body, as _getDefaultHostId and
		// open() already required)
		for (const obj of this.universe.objects) {
			if (obj.type !== OBJECT_TYPES.CELESTIAL || !isLiveObject(obj)) { continue; }

			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name} (ID: ${obj.id})`;

			if (obj.id === currentHostId) {
				option.selected = true;
			}
			this.ui.rlHostSelect.appendChild(option);
		}
		if (this.ui.rlHostSelect.value !== String(currentHostId)) {
			this.ui.rlHostSelect.value = String(currentHostId);
		}
	}

	_updateRocketStats() {
		const rl = this.universe.RocketLauncher;
		const objName = 'Rocket';
		const param = this.presetManager.getObjectParam(objName) || this.presetManager.getObjectParam('Rocket');
		
		const stages = rl.stages || [{
			dryMassT: rl.dryMassT, fuelMassT: rl.fuelMassT, oxidMassT: rl.oxidMassT,
			thrustKN: rl.thrustKN, fuelType: rl.fuelType, name: 'Core Stage'
		}];
		const numStages = stages.length;
		const payloadMassT = (rl.payload?.massT !== undefined) ? rl.payload.massT : 8.0;
		const fairingMassT = (rl.fairing?.enabled ? rl.fairing.massT : 0) || 0;

		let totalDvKmS = 0;
		const stageDvs = [];

		for (let i = 0; i < numStages; i++) {
			const stg = stages[i];
			const fuel = ROCKET_FUELS[stg.fuelType] || ROCKET_FUELS['liquid'] || { isp: 320, ispVac: 320, ispSl: 282 };
			const isp = stg.ispVac || stg.isp || fuel.ispVac || fuel.isp || 320;
			const ve = isp * PHYSICS.G0;

			// Initial mass for stage i (payload + fairing (if stage 1) + this stage + upper stages)
			let m0_T = payloadMassT + (i === 0 ? fairingMassT : 0);
			for (let j = i; j < numStages; j++) {
				m0_T += stages[j].dryMassT + stages[j].fuelMassT + stages[j].oxidMassT;
			}
			const propT = stg.fuelMassT + stg.oxidMassT;
			const mf_T = m0_T - propT;

			let stgDv = 0;
			if (propT > 0 && mf_T > 0 && stg.thrustKN > 0) {
				stgDv = UnitConvertUtils.m2km(ve * Math.log(m0_T / mf_T));
			}
			totalDvKmS += stgDv;

			const stgTwr = (UnitConvertUtils.kn2n(stg.thrustKN)) / (UnitConvertUtils.ton2kg(m0_T) * PHYSICS.G0);
			stageDvs.push({
				stageNum: i + 1,
				name: stg.name || `Stage ${i + 1}`,
				dv: stgDv,
				twr: stgTwr
			});
		}

		// Initial liftoff total mass
		let initialTotalMassT = payloadMassT + fairingMassT;
		for (const stg of stages) {
			initialTotalMassT += stg.dryMassT + stg.fuelMassT + stg.oxidMassT;
		}

		// Calculate Local Gravity and Direction
		let host;
		let rMeters = 0;

		if (rl.mode === 'host') {
			// The launcher's rule: the host in the simulation, else the camera's target (design §4.13-31)
			host = RocketLauncher.resolveHost(this.universe, rl.hostId);
			if (host) {
				rMeters = host.radius + (param.RADIUS || 1) + rl.hostAltitudeM;
			}
		} else {
			// Center Object is regarded as host
			host = this.universe.camera.trackingTarget;
			if (host) {
				const dx = rl.freeX - host.x;
				const dy = rl.freeY - host.y;
				const distPx = Math.sqrt(dx * dx + dy * dy);
				rMeters = UnitConvertUtils.pix2m(distPx);
			}
		}

		let twrY = 0;
		let twrX = 0;
		let hostName = "Unknown";

		// Calculate Vector TWR for Stage 1
		const stg0ThrustKN = stages[0]?.thrustKN || rl.thrustKN;
		if (host && rMeters > 0) {
			hostName = host.name;
			const hostMassKg = UnitConvertUtils.ton2kg(host.mass);

			// Calculate local gravity (g = GM / r^2)
			const localG = (PHYSICS.G * hostMassKg) / (rMeters * rMeters);
			const weightN = UnitConvertUtils.ton2kg(initialTotalMassT) * localG;
			const thrustN = UnitConvertUtils.kn2n(stg0ThrustKN);

			const relAngleDeg = rl.flightProfile.length > 0 ? Number(rl.flightProfile[0].angle) : 0;
			const relAngleRad = UnitConvertUtils.deg2rad(relAngleDeg);

			const thrustY = thrustN * Math.cos(relAngleRad);
			const thrustX = thrustN * Math.sin(relAngleRad);

			twrY = thrustY / weightN;
			twrX = thrustX / weightN;
		}

		if (this.ui.rlStatDv) this.ui.rlStatDv.textContent = totalDvKmS.toFixed(2);
		if (this.ui.rlStatHostName) this.ui.rlStatHostName.textContent = hostName;
		if (this.ui.rlStatTwrY) this.ui.rlStatTwrY.textContent = twrY.toFixed(2);
		if (this.ui.rlStatTwrX) this.ui.rlStatTwrX.textContent = twrX.toFixed(2);
		if (this.ui.rlStatTotalMass) this.ui.rlStatTotalMass.textContent = initialTotalMassT.toFixed(1);
		if (this.ui.rlStatStageCount) this.ui.rlStatStageCount.textContent = numStages;

		if (this.ui.rlStageDvBreakdown) {
			const breakdownHtml = stageDvs.map(s => `<div>${s.name}: ${s.dv.toFixed(2)} km/s <span style="color:#aaa;">(TWR: ${s.twr.toFixed(2)})</span></div>`).join('');
			this.ui.rlStageDvBreakdown.innerHTML = breakdownHtml;
		}

		// Trigger debounced trajectory prediction update on configuration change
		if (this.universe?.RocketLauncher?.requestPreviewUpdate) {
			this.universe.RocketLauncher.requestPreviewUpdate();
		}
	}

	_setupLaunchEnvironment(hostId) {
		const host = this.universe.objects.find(o => o.id === hostId && isLiveObject(o));
		if (!host) { return; }

		EventBus.emit('camera:set-tracking-target', host);

		EventBus.emit('ui:set-time-scale-min');
		EventBus.emit('camera:fit-to-target', host);
	}

	open() {
		const wasOpened = this.isOpened;
		this.isOpened = true;

		// Save the time scale, zoom and camera target from before the tab opened, which close() restores. This must come
		// before the launch setup below (it sets the minimum time scale, fits the zoom to the host and tracks the host),
		// and only when the tab was closed: a click on the already open tab must not replace them with the tab's own view.
		if (!wasOpened) {
			this.saveTimeScale();
			this.saveZoomScale();
			this.saveCameraTarget();
		}

		// Pause simulation while setting up rocket
		EventBus.emit('simulation:pause');

		// Resolve and setup target host FIRST
		let targetHostId = this.universe.RocketLauncher.hostId;
		// A body still in the simulation (a removed one stays listed until its trail has faded, design §4.13-30)
		const hostStillExists = this.universe.objects.some(o => o.id === targetHostId && o.type === OBJECT_TYPES.CELESTIAL && o.state === OBJECT_STATE.ACTIVE);

		if (!hostStillExists || this._isReplaceableHost(targetHostId)) {
			targetHostId = this._assignDefaultHost();
		}
		this._setupLaunchEnvironment(targetHostId);
		this._updateRocketHostOptions(); 
		this._updateRocketStats();

		// Activate launcher pad preview and update prediction immediately
		this.universe.RocketLauncher.togglePreview(true);
		if (typeof this.universe.RocketLauncher.updatePredictionSync === 'function') {
			this.universe.RocketLauncher.updatePredictionSync();
		} else if (typeof this.universe.RocketLauncher.requestPreviewUpdate === 'function') {
			this.universe.RocketLauncher.requestPreviewUpdate(0);
		}
	}

	close() {
		if (!this.isOpened) { return; }

		// Resume simulation when leaving rocket tab
		EventBus.emit('simulation:resume');

		this.universe.RocketLauncher.togglePreview(false);

		// Stop auto tracking gracefully
		if (this.universe.camera.autoTrackHost) {
			const host = this.universe.objects.find(o => o.id === this.universe.RocketLauncher.hostId && isLiveObject(o));
			EventBus.emit('camera:stop-auto-tracking', host);
		} else if (this.universe.RocketLauncher.rolloutedRocketId !== null || this.universe.LaunchSequencer.isActive) {
			// A rocket on the pad or a launch sequence running: real time for the launch instead of the view from before
			// the tab opened, as when igniting (git e02858f / 3734026; git 5998ab1 moved the restore calls of this branch
			// into the else branch, which left these values assigned but never applied, design §4.13-15)
			this.applyLaunchView();
		} else {
			// Restore time & zoom scale & camera target
			this.restoreTimeScale();
			this.restoreZoomScale();
			this.restoreCameraTarget();
		}

		this.isOpened = false;
	}

	saveTimeScale() {
		// The exponent the System tab runs the simulation at, read through the ControlPanel instead of the slider (which
		// shows real time as -7.5). Not log10 of universe.timeScale: the restore applies the saved exponent exactly, and
		// log10(10^x) can differ from x in the last bit (log10(10^0.3) = 0.29999999999999993). Design §4.13-20. Without a
		// ControlPanel (a universe stub) it falls back to log10 of the time scale, as before.
		const exp = this.universe.ControlPanel?.getTimeScaleExp?.();
		this.previousTimeScaleVal = (typeof exp === 'number' && Number.isFinite(exp)) ? exp : Math.log10(this.universe.timeScale);
	}

	saveZoomScale() {
		this.previousZoomScaleVal = this.universe.camera.targetZoomExp;
	}

	saveCameraTarget() {
		// No tracked object before the tab opened: nothing to restore (a target kept from an earlier opening must not be)
		const target = this.universe.camera.trackingTarget ?? null;
		this.previousCameraTarget = target;
		this.previousCameraOffset = target ? { ...this.universe.camera.targetOffset } : null;
	}

	/**
	 * A save loaded while this tab is open: the tab keeps its minimum time scale and its zoom until it closes, and the
	 * loaded values replace the ones saved at open(), so closing the tab applies them like any value from before it opened.
	 * @param {{ timeScaleVal: number | null, zoomScaleVal: number | null }} view validated by SystemTab.normalizeViewState
	 */
	deferViewState(view) {
		if (!view) { return; }
		if (view.timeScaleVal !== null && view.timeScaleVal !== undefined) { this.previousTimeScaleVal = view.timeScaleVal; }
		if (view.zoomScaleVal !== null && view.zoomScaleVal !== undefined) { this.previousZoomScaleVal = view.zoomScaleVal; }
	}

	restoreTimeScale() {
		if (this.previousTimeScaleVal !== null) {
			EventBus.emit('ui:set-time-scale', this.previousTimeScaleVal);
			this.previousTimeScaleVal = null;
		}
	}

	restoreZoomScale() {
		if (this.previousZoomScaleVal !== null) {
			const exp = parseFloat(this.previousZoomScaleVal);
			EventBus.emit('camera:set-target-zoom-exp', exp);
			// The System-tab slider and indicator follow the camera (the same path as camera.fitToTarget): the tab fitted
			// the zoom to the host, so without this they would keep showing the fitted zoom
			EventBus.emit('camera:zoom-changed', exp);
			this.previousZoomScaleVal = null;
		}
	}

	/**
	 * The view for a launch (igniting, or closing the tab with a rocket on the pad or a launch sequence running): the
	 * time scale goes to real time (1 s/s), the camera target and the zoom stay as they are (on the pad or the rocket),
	 * and nothing saved at open() is restored later.
	 */
	applyLaunchView() {
		this.previousCameraTarget = null;
		this.previousCameraOffset = null;
		this.previousZoomScaleVal = null;
		this.previousTimeScaleVal = Math.log10(1 / PHYSICS.YEARS_PER_SECOND);
		this.restoreTimeScale();
	}

	/**
	 * Track the object saved at open() again, with its offset, if it is still in the universe. The saved reference is
	 * compared by identity, not by id: a load while the tab is open (the Load button is on the System tab, but
	 * deferViewState handles that case) replaces every object with a new one carrying the saved id, and an id of the
	 * replaced universe may name another object in the loaded one; an object removed meanwhile is gone too. Then the
	 * camera stays where the load or the tab put it (design §4.13-16).
	 */
	restoreCameraTarget() {
		const target = this.previousCameraTarget;
		const offset = this.previousCameraOffset;
		this.previousCameraTarget = null;
		this.previousCameraOffset = null;
		// Listed and still in the simulation: a removed object stays listed until its trail has faded (design §4.13-31)
		if (target === null || !this.universe.objects.includes(target) || !isLiveObject(target)) { return; }
		EventBus.emit('camera:set-tracking-target', target);
		if (offset) {
			EventBus.emit('camera:set-target-offset', offset.x, offset.y);
		}
	}

	setRolloutState(isRollouted) {
		const sliders = this.ui.rlModeSelect.closest('.tab-content').querySelectorAll('input[type="range"]');

		if (isRollouted) {
			EventBus.emit('ui:set-tabs-locked', true);
			this.ui.rlRolloutBtn.style.display = 'none';
			this.ui.rlIgnitionGroup.style.display = 'flex';
			this.ui.rlAbortBtn.style.display = 'block';

			// Ensure launch buttons are enabled ONLY IF sequence is NOT active
			const isSequencerActive = this.universe.LaunchSequencer && this.universe.LaunchSequencer.isActive;
			if (!isSequencerActive) {
				this.ui.rlIgniteQuickBtn.disabled = false;
				this.ui.rlIgniteFullBtn.disabled = false;
			}

			sliders.forEach(slider => slider.disabled = true);
			this.ui.rlModeSelect.disabled = true;
			this.ui.rlFuelType.disabled = true;
			this.ui.rlHostSelect.disabled = true;
			this.ui.rlAutoControl.disabled = true;
			this.ui.rlAddProfileBtn.disabled = true;
			const profileInputs = this.ui.rlFlightProfileBody ? this.ui.rlFlightProfileBody.querySelectorAll('input, select, button') : [];
			profileInputs.forEach(el => el.disabled = true);
		} else {
			if (!this.universe.LaunchSequencer || !this.universe.LaunchSequencer.isActive) {
				EventBus.emit('ui:set-tabs-locked', false);
			}
			this.ui.rlRolloutBtn.style.display = 'block';
			this.ui.rlIgnitionGroup.style.display = 'none';
			this.ui.rlAbortBtn.style.display = 'none';

			// Reset disabled states just in case
			this.ui.rlIgniteQuickBtn.disabled = false;
			this.ui.rlIgniteFullBtn.disabled = false;

			sliders.forEach(slider => slider.disabled = false);
			this.ui.rlModeSelect.disabled = false;
			this.ui.rlFuelType.disabled = false;
			this.ui.rlHostSelect.disabled = false;
			this.ui.rlAutoControl.disabled = false;
			this.ui.rlAddProfileBtn.disabled = false;
			const profileInputs = this.ui.rlFlightProfileBody ? this.ui.rlFlightProfileBody.querySelectorAll('input, select, button') : [];
			profileInputs.forEach(el => el.disabled = false);
		}
	}

	loadState(rlState) {
		if (!rlState) { return; }
		if (rlState.mode) {
			this.ui.rlModeSelect.value = rlState.mode;
			this.ui.rlHostOptions.style.display = rlState.mode === 'host' ? 'block' : 'none';
		}
		
		this._updateRocketHostOptions(); 

		const updateSlider = (sliderId, valId, val) => {
			if (val === undefined || val === null) { return; }
			if (this.ui[sliderId]) { this.ui[sliderId].value = val; }
			if (this.ui[valId]) { this.ui[valId].textContent = val; }
		};

		if (rlState.colorTheme) {
			this.universe.RocketLauncher.colorTheme = rlState.colorTheme;
			if (this.ui.rlColorTheme) {
				this.ui.rlColorTheme.value = rlState.colorTheme;
			}
		}

		if (rlState.hostAngleDeg !== undefined) {
			let hAngle = Number(rlState.hostAngleDeg) || 0;
			// Normalize to -180 ~ 180 to fit the new specification
			while (hAngle > 180) hAngle -= 360;
			while (hAngle <= -180) hAngle += 360;
			this.universe.RocketLauncher.hostAngleDeg = hAngle;

			this.ui.rlHostAngle.value = this.universe.RocketLauncher.hostAngleDeg;
			this.ui.rlHostAngleVal.textContent = this.universe.RocketLauncher.hostAngleDeg;
		}
		updateSlider('rlHostAlt', 'rlHostAltVal', rlState.hostAltitudeM);
		if (rlState.flightProfile !== undefined) {
			this.universe.RocketLauncher.flightProfile = Array.isArray(rlState.flightProfile)
				? JSON.parse(JSON.stringify(rlState.flightProfile)).filter(step => step !== null && typeof step === 'object' && Number.isFinite(step.value) && Number.isFinite(step.thrust) && Number.isFinite(step.angle))
				: [];
			this._renderProfileTable();
		}
		updateSlider('rlLaunchMass', 'rlLaunchMassVal', rlState.dryMassT);
		this._syncThrustSlider(rlState.thrustKN ?? this.universe.RocketLauncher.thrustKN);
		updateSlider('rlFuelMass', 'rlFuelMassVal', rlState.fuelMassT);
		updateSlider('rlOxidMass', 'rlOxidMassVal', rlState.oxidMassT);
		if (rlState.fuelType) { this.ui.rlFuelType.value = rlState.fuelType; }
		if (rlState.currentVehicleId && this.ui.rlVehicleSelect?.querySelector(`option[value="${rlState.currentVehicleId}"]`)) {
			this.ui.rlVehicleSelect.value = rlState.currentVehicleId;
		}
		if (rlState.currentPayloadId && this.ui.rlPayloadSelect?.querySelector(`option[value="${rlState.currentPayloadId}"]`)) {
			this.ui.rlPayloadSelect.value = rlState.currentPayloadId;
		}
		if (rlState.currentMissionId && this.ui.rlMissionSelect?.querySelector(`option[value="${rlState.currentMissionId}"]`)) {
			this.ui.rlMissionSelect.value = rlState.currentMissionId;
		}
		if (Array.isArray(rlState.stages) && rlState.stages.length > 0) {
			this._renderStageTabs();
			this.selectTab(0);
		}
		updateSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', rlState.maxGLimit);

		if (rlState.autoControl !== undefined) {
			this.ui.rlAutoControl.checked = rlState.autoControl;
			this.universe.RocketLauncher.autoControl = rlState.autoControl;
		}

		this._updateRocketStats();
	}
}
