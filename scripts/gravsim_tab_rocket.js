
// gravsim_tab_rocket.js

import { PHYSICS, RENDER, OBJECT_TYPES, DEFAULT_OBJECT_PARAMS, ROCKET_FUELS, MULTISTAGE_PRESETS } from './gravsim_const.js';
import { DOMUtils, UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

export class RocketTab {
	constructor(universe) {
		this.universe = universe;
		this.previousTimeScaleVal = null;
		this.previousZoomScaleVal = null;
		this.previousCameraTarget = null;
		this.previousCameraOffset = null;
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
		this.ui = {
			rlModeSelect: document.getElementById('rl-mode-select'),
			rlHostOptions: document.getElementById('rl-host-options'),
			rlHostSelect: document.getElementById('rl-host-select'),
			rlHostAngle: document.getElementById('rl-host-angle'),
			rlHostAngleVal: document.getElementById('rl-host-angle-val'),
			rlHostAlt: document.getElementById('rl-host-alt'),
			rlHostAltVal: document.getElementById('rl-host-alt-val'),
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
			this.universe.RocketLauncher.flightProfile.push({ type: 'alt', value: 0, thrust: 100, angle: 0 });
			this._renderProfileTable();
			this._updateRocketStats();
		});
		this._renderProfileTable();

		this.ui.rlModeSelect.addEventListener('change', (e) => {
			this.universe.RocketLauncher.mode = e.target.value;
			this.ui.rlHostOptions.style.display = e.target.value === 'host' ? 'block' : 'none';
			this._updateRocketStats();
		});

		// Preset Load
		this.ui.rlLoadPresetBtn.addEventListener('click', () => {
			this.loadPreset(this.ui.rlPresetSelect.value);
		});
		this.ui.rlPresetSelect.addEventListener('change', (e) => {
			this.loadPreset(e.target.value);
		});

		// Theme Color
		this.ui.rlColorTheme.value = this.universe.RocketLauncher.colorTheme;
		this.ui.rlColorTheme.addEventListener('change', (e) => {
			this.universe.RocketLauncher.colorTheme = e.target.value;
			this._updateRocketStats();
		});

		// Initial stage tab rendering
		this._renderStageTabs();
		this.selectTab(0);

		this.ui.rlFuelType.addEventListener('change', (e) => {
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.fuelType = e.target.value;
			const fuelDef = ROCKET_FUELS[e.target.value];
			if (fuelDef && fuelDef.ofRatio === 0) {
				stg.oxidMassT = 0;
				this.ui.rlOxidMass.value = 0;
				this.ui.rlOxidMass.disabled = true;
			} else if (fuelDef) {
				this.ui.rlOxidMass.disabled = false;
				stg.oxidMassT = Math.round(stg.fuelMassT * fuelDef.ofRatio);
				this.ui.rlOxidMass.value = stg.oxidMassT;
			}
			if (this.ui.rlOxidMassVal) {
				this.ui.rlOxidMassVal.textContent = this.ui.rlOxidMass.value;
			}
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlFuelMass.addEventListener('input', (e) => {
			const val = parseInt(e.target.value, 10);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.fuelMassT = val;
			this.ui.rlFuelMassVal.textContent = val;

			const fuelDef = ROCKET_FUELS[stg.fuelType || 'liquid'];
			if (fuelDef && fuelDef.ofRatio > 0) {
				const newOxid = Math.round(val * fuelDef.ofRatio);
				stg.oxidMassT = newOxid;
				this.ui.rlOxidMass.value = newOxid;
				this.ui.rlOxidMassVal.textContent = newOxid;
			}
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlOxidMass.addEventListener('input', (e) => {
			const val = parseInt(e.target.value, 10);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.oxidMassT = val;
			this.ui.rlOxidMassVal.textContent = val;

			const fuelDef = ROCKET_FUELS[stg.fuelType || 'liquid'];
			if (fuelDef && fuelDef.ofRatio > 0) {
				const newFuel = Math.round(val / fuelDef.ofRatio);
				stg.fuelMassT = newFuel;
				this.ui.rlFuelMass.value = newFuel;
				this.ui.rlFuelMassVal.textContent = newFuel;
			}
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlLaunchMass.addEventListener('input', (e) => {
			const val = parseInt(e.target.value, 10);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.dryMassT = val;
			this.ui.rlLaunchMassVal.textContent = val;
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlLaunchThrust.addEventListener('input', (e) => {
			const val = parseInt(e.target.value, 10);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.thrustKN = val;
			this.ui.rlLaunchThrustVal.textContent = val;
			this._syncStageZero();
			this._updateRocketStats();
		});

		this.ui.rlSepDelay.addEventListener('input', (e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.separationDelaySec = val;
			if (this.ui.rlSepDelayVal) this.ui.rlSepDelayVal.textContent = val.toFixed(1);
			this._updateRocketStats();
		});

		this.ui.rlIgnDelay.addEventListener('input', (e) => {
			const val = parseFloat(e.target.value);
			const stg = this._getCurrentStage();
			if (!stg) { return; }
			stg.ignitionDelaySec = val;
			if (this.ui.rlIgnDelayVal) this.ui.rlIgnDelayVal.textContent = val.toFixed(1);
			this._updateRocketStats();
		});

		// Payload & Fairing Inputs
		this.ui.rlPayloadMass.addEventListener('input', (e) => {
			const val = parseFloat(e.target.value);
			const rl = this.universe.RocketLauncher;
			if (!rl.payload) rl.payload = {};
			rl.payload.massT = val;
			if (this.ui.rlPayloadMassVal) this.ui.rlPayloadMassVal.textContent = val.toFixed(1);
			this._updateRocketStats();
		});

		this.ui.rlFairingEnabled.addEventListener('change', (e) => {
			const rl = this.universe.RocketLauncher;
			if (!rl.fairing) rl.fairing = {};
			rl.fairing.enabled = e.target.checked;
			if (this.ui.rlFairingOptions) {
				this.ui.rlFairingOptions.style.display = e.target.checked ? 'block' : 'none';
			}
			this._updateRocketStats();
		});

		this.ui.rlFairingMass.addEventListener('input', (e) => {
			const val = parseFloat(e.target.value);
			const rl = this.universe.RocketLauncher;
			if (!rl.fairing) rl.fairing = {};
			rl.fairing.massT = val;
			if (this.ui.rlFairingMassVal) this.ui.rlFairingMassVal.textContent = val.toFixed(1);
			this._updateRocketStats();
		});

		this.ui.rlFairingAlt.addEventListener('input', (e) => {
			const val = parseInt(e.target.value, 10);
			const rl = this.universe.RocketLauncher;
			if (!rl.fairing) rl.fairing = {};
			rl.fairing.separationAltKm = val;
			if (this.ui.rlFairingAltVal) this.ui.rlFairingAltVal.textContent = val;
			this._updateRocketStats();
		});

		this.ui.rlHostSelect.addEventListener('change', (e) => {
			const newHostId = parseInt(e.target.value, 10);
			this.universe.RocketLauncher.hostId = newHostId;
			this._setupLaunchEnvironment(newHostId);
			this._updateRocketStats();
		});
		this.ui.rlHostSelect.addEventListener('focus', () => {
			this._updateRocketStats();
		});
		this.ui.rlAutoControl.addEventListener('change', (e) => {
			this.universe.RocketLauncher.autoControl = e.target.checked;
		});
		this.ui.rlRolloutBtn.addEventListener('click', () => this.universe.RocketLauncher.rollout());

		const triggerIgnite = (sequenceType) => {
			// Resume simulation to ensure physics worker runs during sequence
			EventBus.emit('simulation:resume');

			// Change system setting
			this.previousCameraTarget = null;
			this.previousTimeScaleVal = Math.log10(1 / PHYSICS.YEARS_PER_SECOND);
			this.previousZoomScaleVal = null;

			// Restore time & zoom scale & camera target
			this.restoreTimeScale();
			this.restoreZoomScale();
			this.restoreCameraTarget();

			this.universe.RocketLauncher.ignite(sequenceType);
		};

		this.ui.rlIgniteQuickBtn.addEventListener('click', () => triggerIgnite('LEGACY_QUICK'));
		this.ui.rlIgniteFullBtn.addEventListener('click', () => triggerIgnite('FULL_COUNTDOWN'));
		this.ui.rlAbortBtn.addEventListener('click', () => this.universe.RocketLauncher.abortRollout());

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
				this.ui[sliderId].addEventListener('input', (e) => {
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

	_renderProfileTable() {
		if (!this.ui.rlFlightProfileBody) { return; }
		this.ui.rlFlightProfileBody.innerHTML = '';
		const profile = this.universe.RocketLauncher.flightProfile;
		
		profile.forEach((step, index) => {
			const tr = document.createElement('tr');
			
			const tdType = document.createElement('td');
			const selType = document.createElement('select');
			selType.innerHTML = `<option value="alt" ${step.type==='alt'?'selected':''}>Alt(m)</option><option value="time" ${step.type==='time'?'selected':''}>Time(s)</option>`;
			selType.onchange = (e) => { step.type = e.target.value; this._updateRocketStats(); };
			tdType.appendChild(selType);
			
			const tdVal = document.createElement('td');
			const inpVal = document.createElement('input');
			inpVal.type = 'number'; inpVal.value = step.value; inpVal.min = 0;
			inpVal.onchange = (e) => { step.value = parseFloat(e.target.value) || 0; this._updateRocketStats(); };
			tdVal.appendChild(inpVal);
			
			const tdThrust = document.createElement('td');
			const inpThrust = document.createElement('input');
			inpThrust.type = 'number'; inpThrust.value = step.thrust; inpThrust.min = 0; inpThrust.max = 100;
			inpThrust.onchange = (e) => { step.thrust = parseFloat(e.target.value) || 0; this._updateRocketStats(); };
			tdThrust.appendChild(inpThrust);
			
			const tdAngle = document.createElement('td');
			const inpAngle = document.createElement('input');
			inpAngle.type = 'number'; inpAngle.value = step.angle; inpAngle.min = -90; inpAngle.max = 90;
			inpAngle.onchange = (e) => { step.angle = parseFloat(e.target.value) || 0; this._updateRocketStats(); };
			tdAngle.appendChild(inpAngle);
			
			const tdAct = document.createElement('td');
			const btnDel = document.createElement('button');
			btnDel.type = 'button'; btnDel.className = 'remove-step-btn'; btnDel.textContent = 'X';
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
			}
		}
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
			const fAlt = rl.fairing?.separationAltKm !== undefined ? rl.fairing.separationAltKm : 100;
			if (this.ui.rlFairingAlt) this.ui.rlFairingAlt.value = fAlt;
			if (this.ui.rlFairingAltVal) this.ui.rlFairingAltVal.textContent = fAlt;
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
			if (this.ui.rlOxidMass) this.ui.rlOxidMass.value = stg.oxidMassT;
			if (this.ui.rlOxidMassVal) this.ui.rlOxidMassVal.textContent = stg.oxidMassT;
			if (this.ui.rlLaunchMass) this.ui.rlLaunchMass.value = stg.dryMassT;
			if (this.ui.rlLaunchMassVal) this.ui.rlLaunchMassVal.textContent = stg.dryMassT;
			if (this.ui.rlLaunchThrust) this.ui.rlLaunchThrust.value = stg.thrustKN;
			if (this.ui.rlLaunchThrustVal) this.ui.rlLaunchThrustVal.textContent = stg.thrustKN;
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

	loadPreset(presetKey) {
		const preset = MULTISTAGE_PRESETS[presetKey];
		if (!preset) return;
		const rl = this.universe.RocketLauncher;
		rl.currentPresetId = presetKey;
		rl.colorTheme = preset.colorTheme || 'orange';
		rl.stages = JSON.parse(JSON.stringify(preset.stages));
		rl.payload = JSON.parse(JSON.stringify(preset.payload || { massT: 0 }));
		rl.fairing = JSON.parse(JSON.stringify(preset.fairing || { enabled: false, massT: 0, separationAltKm: 100 }));
		this._syncStageZero();
		this.currentTab = 0;
		this._renderStageTabs();
		this.selectTab(0);
		this._updateRocketStats();
	}

	_updateRocketHostOptions() {
		const currentHostId = this.universe.RocketLauncher.hostId;
		this.ui.rlHostSelect.innerHTML = '';

		for (const obj of this.universe.objects) {
			if (obj.type === OBJECT_TYPES.ROCKET) { continue; }

			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name} (ID: ${obj.id})`;

			if (obj.id === currentHostId || (currentHostId === null && this.universe.camera.trackingTarget && obj.id === this.universe.camera.trackingTarget.id)) {
				option.selected = true;
				this.universe.RocketLauncher.hostId = obj.id;
			}
			this.ui.rlHostSelect.appendChild(option);
		}
	}

	_updateRocketStats() {
		const rl = this.universe.RocketLauncher;
		const objName = 'Rocket';
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		
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
			const fuel = ROCKET_FUELS[stg.fuelType] || ROCKET_FUELS['liquid'];
			const ve = fuel.isp * PHYSICS.G0;

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
			host = this.universe.objects.find(o => o.id === rl.hostId) || this.universe.camera.trackingTarget;
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
		const host = this.universe.objects.find(o => o.id === hostId);
		if (!host) { return; }

		EventBus.emit('camera:set-tracking-target', host);

		EventBus.emit('ui:set-time-scale-min');
		EventBus.emit('camera:fit-to-target', host);
	}

	open() {
		this.isOpened = true;

		// Pause simulation while setting up rocket
		EventBus.emit('simulation:pause');

		this.universe.RocketLauncher.togglePreview(true);

		// Save time & zoom scale & camera target
		this.saveTimeScale();
		this.saveZoomScale();
		this.saveCameraTarget();

		let targetHostId = this.universe.RocketLauncher.hostId;
		if (targetHostId === null || targetHostId === 0) { 
			const nonSunObjects = this.universe.objects.filter(o => o.id !== 0 && o.type === OBJECT_TYPES.CELESTIAL);
			if (nonSunObjects.length > 0) {
				targetHostId = Math.max(...nonSunObjects.map(o => o.id));
			} else {
				targetHostId = 0;
			}
			this.universe.RocketLauncher.hostId = targetHostId;
		}
		this._setupLaunchEnvironment(targetHostId);
		this._updateRocketHostOptions(); 
		this._updateRocketStats();
	}

	close() {
		if (!this.isOpened) { return; }

		// Resume simulation when leaving rocket tab
		EventBus.emit('simulation:resume');

		this.universe.RocketLauncher.togglePreview(false);

		// Stop auto tracking gracefully
		if (this.universe.camera.autoTrackHost) {
			const host = this.universe.objects.find(o => o.id === this.universe.RocketLauncher.hostId);
			EventBus.emit('camera:stop-auto-tracking', host);
		} else if (this.universe.RocketLauncher.rolloutedRocketId !== null || this.universe.LaunchSequencer.isActive) {
			this.previousCameraTarget = null;
			this.previousTimeScaleVal = Math.log10(1 / PHYSICS.YEARS_PER_SECOND);
			this.previousZoomScaleVal = null;
		} else {
			// Restore time & zoom scale & camera target
			this.restoreTimeScale();
			this.restoreZoomScale();
			this.restoreCameraTarget();
		}

		this.isOpened = false;
	}

	saveTimeScale() {
		// Read directly from ControlPanel/Universe instead of SystemTab UI DOM
		this.previousTimeScaleVal = Math.log10(this.universe.timeScale);
	}

	saveZoomScale() {
		this.previousZoomScaleVal = this.universe.camera.targetZoomExp;
	}

	saveCameraTarget() {
		if (this.universe.camera.trackingTarget !== null) {
			this.previousCameraTarget = this.universe.camera.trackingTarget;
			this.previousCameraOffset = { ...this.universe.camera.targetOffset };
		}
	}

	restoreTimeScale() {
		if (this.previousTimeScaleVal !== null) {
			EventBus.emit('ui:set-time-scale', this.previousTimeScaleVal);
			this.previousTimeScaleVal = null;
		}
	}

	restoreZoomScale() {
		if (this.previousZoomScaleVal !== null) {
			EventBus.emit('camera:set-target-zoom-exp', parseFloat(this.previousZoomScaleVal));
			this.previousZoomScaleVal = null;
		}
	}

	restoreCameraTarget() {
		if (this.previousCameraTarget !== null) {
			EventBus.emit('camera:set-tracking-target', this.previousCameraTarget);
			if (this.previousCameraOffset) {
				EventBus.emit('camera:set-target-offset', this.previousCameraOffset.x, this.previousCameraOffset.y);
			}

			this.previousCameraTarget = null;
			this.previousCameraOffset = null;
		}
	}

	setRolloutState(isRollouted) {
		const sliders = this.ui.rlModeSelect.closest('.tab-content').querySelectorAll('input[type="range"]');

		if (isRollouted) {
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
			this.universe.RocketLauncher.flightProfile = JSON.parse(JSON.stringify(rlState.flightProfile));
			this._renderProfileTable();
		}
		updateSlider('rlLaunchMass', 'rlLaunchMassVal', rlState.dryMassT);
		updateSlider('rlLaunchThrust', 'rlLaunchThrustVal', rlState.thrustKN);
		updateSlider('rlFuelMass', 'rlFuelMassVal', rlState.fuelMassT);
		updateSlider('rlOxidMass', 'rlOxidMassVal', rlState.oxidMassT);
		if (rlState.fuelType) { this.ui.rlFuelType.value = rlState.fuelType; }
		updateSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', rlState.maxGLimit);

		if (rlState.autoControl !== undefined) {
			this.ui.rlAutoControl.checked = rlState.autoControl;
			this.universe.RocketLauncher.autoControl = rlState.autoControl;
		}

		this._updateRocketStats();
	}
}
