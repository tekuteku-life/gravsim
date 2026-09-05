
// gravsim_tab_rocket.js

import { PHYSICS, RENDER, OBJECT_TYPES, DEFAULT_OBJECT_PARAMS, ROCKET_FUELS } from './gravsim_const.js';
import { DOMUtils, UnitConvertUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

export class RocketTab {
	constructor(universe) {
		this.universe = universe;
		this.previousTimeScaleVal = null;
		this.previousZoomScaleVal = null;
		this.previousCameraTarget = null;
		this.previousCameraOffset = null;
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
			rlFlightProfileBody: document.getElementById('rl-flight-profile-body'),
			rlAddProfileBtn: document.getElementById('rl-add-profile-btn'),
			rlLaunchMass: document.getElementById('rl-launch-mass'),
			rlLaunchMassVal: document.getElementById('rl-launch-mass-val'),
			rlFuelType: document.getElementById('rl-fuel-type'),
			rlFuelMass: document.getElementById('rl-fuel-mass'),
			rlFuelMassVal: document.getElementById('rl-fuel-mass-val'),
			rlOxidMass: document.getElementById('rl-oxid-mass'),
			rlOxidMassVal: document.getElementById('rl-oxid-mass-val'),
			rlLaunchThrust: document.getElementById('rl-launch-thrust'),
			rlLaunchThrustVal: document.getElementById('rl-launch-thrust-val'),
			rlLaunchMaxG: document.getElementById('rl-launch-maxg'),
			rlLaunchMaxGVal: document.getElementById('rl-launch-maxg-val'),
			rlAutoControl: document.getElementById('rl-auto-control'),
			rlStatDv: document.getElementById('rl-stat-dv'),
			rlStatHostName: document.getElementById('rl-stat-host-name'),
			rlStatTwrY: document.getElementById('rl-stat-twr-y'),
			rlStatTwrX: document.getElementById('rl-stat-twr-x'),
			rlStatFuelType: document.getElementById('rl-stat-fuel-type'),
			rlStatFuelAmount: document.getElementById('rl-stat-fuel-amount'),
			rlStatFuelIsp: document.getElementById('rl-stat-fuel-isp'),
			rlStatFuelMaxBurn: document.getElementById('rl-stat-fuel-max-burn'),
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

		this.ui.rlFuelType.addEventListener('change', (e) => {
			this.universe.RocketLauncher.fuelType = e.target.value;
			const fuelDef = ROCKET_FUELS[e.target.value];
			if (fuelDef && fuelDef.ofRatio === 0) {
				this.ui.rlOxidMass.value = 0;
				this.ui.rlOxidMass.disabled = true;
				this.universe.RocketLauncher.oxidMassT = 0;
			} else if (fuelDef) {
				this.ui.rlOxidMass.disabled = false;
				const currentFuel = parseFloat(this.ui.rlFuelMass.value);
				const newOxid = Math.round(currentFuel * fuelDef.ofRatio);
				this.ui.rlOxidMass.value = newOxid;
				this.universe.RocketLauncher.oxidMassT = newOxid;
			}
			if (this.ui.rlOxidMassVal) {
				this.ui.rlOxidMassVal.textContent = this.ui.rlOxidMass.value;
			}
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

		// Bind all Rocket Launcher sliders
		bindSlider('rlHostAngle', 'rlHostAngleVal', 'hostAngleDeg');
		bindSlider('rlHostAlt', 'rlHostAltVal', 'hostAltitudeM', true);
		bindSlider('rlLaunchMass', 'rlLaunchMassVal', 'dryMassT');
		bindSlider('rlLaunchThrust', 'rlLaunchThrustVal', 'thrustKN');
		bindSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', 'maxGLimit', true);

		// Custom binding for Fuel and Oxidizer to keep ratio
		this.ui.rlFuelMass.addEventListener('input', (e) => {
			const val = parseInt(e.target.value, 10);
			this.universe.RocketLauncher.fuelMassT = val;
			this.ui.rlFuelMassVal.textContent = val;
			
			const fuelDef = ROCKET_FUELS[this.universe.RocketLauncher.fuelType];
			if (fuelDef && fuelDef.ofRatio > 0) {
				const newOxid = Math.round(val * fuelDef.ofRatio);
				this.universe.RocketLauncher.oxidMassT = newOxid;
				this.ui.rlOxidMass.value = newOxid;
				this.ui.rlOxidMassVal.textContent = newOxid;
			}
			this._updateRocketStats();
		});

		this.ui.rlOxidMass.addEventListener('input', (e) => {
			const val = parseInt(e.target.value, 10);
			this.universe.RocketLauncher.oxidMassT = val;
			this.ui.rlOxidMassVal.textContent = val;
			
			const fuelDef = ROCKET_FUELS[this.universe.RocketLauncher.fuelType];
			if (fuelDef && fuelDef.ofRatio > 0) {
				const newFuel = Math.round(val / fuelDef.ofRatio);
				this.universe.RocketLauncher.fuelMassT = newFuel;
				this.ui.rlFuelMass.value = newFuel;
				this.ui.rlFuelMassVal.textContent = newFuel;
			}
			this._updateRocketStats();
		});

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
		
		const fuel = ROCKET_FUELS[rl.fuelType] || ROCKET_FUELS['liquid'];
		const ve = fuel.isp * PHYSICS.G0;
		const totalPropellantT = rl.fuelMassT + rl.oxidMassT;
		const m0 = UnitConvertUtils.ton2kg(rl.dryMassT + totalPropellantT);
		const mf = UnitConvertUtils.ton2kg(rl.dryMassT);
		
		const massFlowRateKgS = UnitConvertUtils.kn2n(rl.thrustKN) / ve;
		const maxBurnTime = massFlowRateKgS > 0 ? UnitConvertUtils.ton2kg(totalPropellantT) / massFlowRateKgS : 0;
		
		let dvKmS = 0;
		if (maxBurnTime > 0 && rl.thrustKN > 0) {
			dvKmS = UnitConvertUtils.m2km(ve * Math.log(m0 / mf));
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

		// Calculate Vector TWR
		if (host && rMeters > 0) {
			hostName = host.name;
			const hostMassKg = UnitConvertUtils.ton2kg(host.mass);

			// Calculate local gravity (g = GM / r^2)
			const localG = (PHYSICS.G * hostMassKg) / (rMeters * rMeters);
			const weightN = UnitConvertUtils.ton2kg(rl.dryMassT + totalPropellantT) * localG;
			const thrustN = UnitConvertUtils.kn2n(rl.thrustKN);

			// Since launchAngleDeg is relative to zenith, we can resolve directly
			const relAngleDeg = rl.flightProfile.length > 0 ? Number(rl.flightProfile[0].angle) : 0;
			const relAngleRad = UnitConvertUtils.deg2rad(relAngleDeg);

			const thrustY = thrustN * Math.cos(relAngleRad);
			const thrustX = thrustN * Math.sin(relAngleRad);

			twrY = thrustY / weightN;
			twrX = thrustX / weightN;
		}

		this.ui.rlStatDv.textContent = dvKmS.toFixed(2);
		this.ui.rlStatHostName.textContent = hostName;
		this.ui.rlStatTwrY.textContent = twrY.toFixed(2);
		this.ui.rlStatTwrX.textContent = twrX.toFixed(2);

		if (totalPropellantT > 0 && fuel) {
			this.ui.rlStatFuelType.textContent = fuel.name;
			this.ui.rlStatFuelAmount.textContent = totalPropellantT.toLocaleString();
			this.ui.rlStatFuelIsp.textContent = fuel.isp;
			this.ui.rlStatFuelMaxBurn.textContent = maxBurnTime.toFixed(1);
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
