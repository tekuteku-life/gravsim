
// gravsim_tab_rocket.js

import { PHYSICS, RENDER, OBJECT_TYPES, DEFAULT_OBJECT_PARAMS, ROCKET_FUELS } from './gravsim_const.js';
import { DOMUtils, UnitConvertUtils } from './gravsim_utils.js';

export class RocketTab {
	constructor(universe, systemTab) {
		this.universe = universe;
		this.systemTab = systemTab;
		this.previousTimeScaleVal = null;
		this.previousZoomScaleVal = null;
		this.previousCameraTarget = null;
		this.previousCameraOffset = null;
		this._initElements();
		this._bindEvents();
		this.isOpened = false;

		// Subscribe to object list changes
		this.universe.on('object-list-changed', () => {
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
			rlLaunchAngle: document.getElementById('rl-launch-angle'),
			rlLaunchAngleVal: document.getElementById('rl-launch-angle-val'),
			rlLaunchMass: document.getElementById('rl-launch-mass'),
			rlLaunchMassVal: document.getElementById('rl-launch-mass-val'),
			rlFuelType: document.getElementById('rl-fuel-type'),
			rlFuelAmount: document.getElementById('rl-fuel-amount'),
			rlFuelAmountVal: document.getElementById('rl-fuel-amount-val'),
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
		this.ui.rlModeSelect.addEventListener('change', (e) => {
			this.universe.RocketLauncher.mode = e.target.value;
			this.ui.rlHostOptions.style.display = e.target.value === 'host' ? 'block' : 'none';
			this._updateRocketStats();
		});
		this.ui.rlFuelType.addEventListener('change', (e) => {
			this.universe.RocketLauncher.fuelType = e.target.value;
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
			this.universe.resumeSimulation();

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

		// Disable ignition buttons during launch sequence
		this.universe.on('sequencer-start', () => {
			this.ui.rlIgniteQuickBtn.disabled = true;
			this.ui.rlIgniteFullBtn.disabled = true;
		});

		const unlockIgnition = () => {
			this.ui.rlIgniteQuickBtn.disabled = false;
			this.ui.rlIgniteFullBtn.disabled = false;
		};
		this.universe.on('sequencer-end', unlockIgnition);
		this.universe.on('sequencer-abort', unlockIgnition);

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
		bindSlider('rlLaunchAngle', 'rlLaunchAngleVal', 'launchAngleDeg');
		bindSlider('rlLaunchMass', 'rlLaunchMassVal', 'dryMassT');
		bindSlider('rlFuelAmount', 'rlFuelAmountVal', 'fuelAmountT');
		bindSlider('rlLaunchThrust', 'rlLaunchThrustVal', 'thrustKN');
		bindSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', 'maxGLimit', true);

		this.ui.massSelect.addEventListener('change', () => this._updateRocketStats());

		document.addEventListener('rocket-preview-updated', () => {
			this._updateRocketStats();
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
		const objName = this.universe.ObjectPlacer.getLaunchObjectName();
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Rocket'];
		
		const fuel = ROCKET_FUELS[rl.fuelType] || ROCKET_FUELS['liquid'];
		const ve = fuel.isp * PHYSICS.G0;
		const m0 = UnitConvertUtils.ton2kg(rl.dryMassT + rl.fuelAmountT);
		const mf = UnitConvertUtils.ton2kg(rl.dryMassT);
		
		const massFlowRateKgS = UnitConvertUtils.kn2n(rl.thrustKN) / ve;
		const maxBurnTime = massFlowRateKgS > 0 ? UnitConvertUtils.ton2kg(rl.fuelAmountT) / massFlowRateKgS : 0;
		
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
			const weightN = UnitConvertUtils.ton2kg(rl.dryMassT + rl.fuelAmountT) * localG;
			const thrustN = UnitConvertUtils.kn2n(rl.thrustKN);

			// Since launchAngleDeg is relative to zenith, we can resolve directly
			const relAngleRad = UnitConvertUtils.deg2rad(Number(rl.launchAngleDeg) || 0);

			const thrustY = thrustN * Math.cos(relAngleRad);
			const thrustX = thrustN * Math.sin(relAngleRad);

			twrY = thrustY / weightN;
			twrX = thrustX / weightN;
		}

		this.ui.rlStatDv.textContent = dvKmS.toFixed(2);
		this.ui.rlStatHostName.textContent = hostName;
		this.ui.rlStatTwrY.textContent = twrY.toFixed(2);
		this.ui.rlStatTwrX.textContent = twrX.toFixed(2);

		if (rl.fuelAmountT > 0 && fuel) {
			this.ui.rlStatFuelType.textContent = fuel.name;
			this.ui.rlStatFuelAmount.textContent = rl.fuelAmountT.toLocaleString();
			this.ui.rlStatFuelIsp.textContent = fuel.isp;
			this.ui.rlStatFuelMaxBurn.textContent = maxBurnTime.toFixed(1);
		}
	}

	_setupLaunchEnvironment(hostId) {
		const host = this.universe.objects.find(o => o.id === hostId);
		if (!host) { return; }

		this.universe.camera.setTrackingTarget(host);
		this.systemTab.updateCenterOptions();
		this.universe.InfoPanel.updateCamera(host.name);

		this.systemTab.ui.timeScale.value = this.systemTab.ui.timeScale.min;
		this.systemTab.updateTimeScaleIndicator(this.systemTab.getTimeScale());

		if (this.systemTab.ui.zoomScale) {
			// Adjust zoom-level which the radius of the host is specific value
			const realRadiusPx = (host.radius / PHYSICS.METERS_PER_AU) * RENDER.DISTANCE_SCALE;
			const targetSize = Math.min(this.universe.canvas.width, this.universe.canvas.height) / 2.2;
			let idealExp = Math.log10(targetSize / realRadiusPx);

			const maxZoom = parseFloat(this.systemTab.ui.zoomScale.max);
			const minZoom = parseFloat(this.systemTab.ui.zoomScale.min);
			idealExp = Math.max(minZoom, Math.min(maxZoom, idealExp));

			this.systemTab.ui.zoomScale.value = idealExp.toFixed(2);
			this.universe.camera.setTargetZoomExp(idealExp);
			this.systemTab.updateZoomScaleIndicator(this.systemTab.getZoomScale());
		}
	}

	open() {
		this.isOpened = true;

		// Pause simulation while setting up rocket
		this.universe.pauseSimulation();

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
		this._updateRocketStats();
	}

	close() {
		if (!this.isOpened) { return; }

		// Resume simulation when leaving rocket tab
		this.universe.resumeSimulation();

		this.universe.RocketLauncher.togglePreview(false);

		// Stop auto tracking gracefully
		if (this.universe.RocketLauncher.isAutoTracking) {
			const host = this.universe.objects.find(o => o.id === this.universe.RocketLauncher.hostId);
			this.universe.RocketLauncher._stopAutoTracking(host);
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
		this.previousTimeScaleVal = this.systemTab.ui.timeScale.value;
	}

	saveZoomScale() {
		this.previousZoomScaleVal = this.systemTab.ui.zoomScale.value;
	}

	saveCameraTarget() {
		if (this.universe.camera.trackingTarget !== null) {
			this.previousCameraTarget = this.universe.camera.trackingTarget;
			this.previousCameraOffset = { ...this.universe.camera.targetOffset };
		}
	}

	restoreTimeScale() {
		if (this.previousTimeScaleVal !== null) {
			this.systemTab.ui.timeScale.value = this.previousTimeScaleVal;
			this.systemTab.updateTimeScaleIndicator(this.systemTab.getTimeScale());
			this.previousTimeScaleVal = null;
		}
	}

	restoreZoomScale() {
		if (this.previousZoomScaleVal !== null) {
			this.systemTab.ui.zoomScale.value = this.previousZoomScaleVal;
			this.universe.camera.setTargetZoomExp(parseFloat(this.previousZoomScaleVal));
			this.systemTab.updateZoomScaleIndicator(this.systemTab.getZoomScale());
			this.previousZoomScaleVal = null;
		}
	}

	restoreCameraTarget() {
		if (this.previousCameraTarget !== null) {
			this.universe.camera.setTrackingTarget(this.previousCameraTarget);
			if (this.previousCameraOffset) {
				this.universe.camera.setTargetOffset(this.previousCameraOffset.x, this.previousCameraOffset.y);
			}
			this.universe.ControlPanel.systemTab.updateCenterOptions();
			this.universe.InfoPanel.updateCamera(this.previousCameraTarget.name);

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
			sliders.forEach(slider => slider.disabled = true);
			this.ui.rlModeSelect.disabled = true;
			this.ui.rlFuelType.disabled = true;
			this.ui.rlHostSelect.disabled = true;
			this.ui.rlAutoControl.disabled = true;
		} else {
			this.ui.rlRolloutBtn.style.display = 'block';
			this.ui.rlIgnitionGroup.style.display = 'none';
			this.ui.rlAbortBtn.style.display = 'none';
			sliders.forEach(slider => slider.disabled = false);
			this.ui.rlModeSelect.disabled = false;
			this.ui.rlFuelType.disabled = false;
			this.ui.rlHostSelect.disabled = false;
			this.ui.rlAutoControl.disabled = false;
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

		updateSlider('rlHostAngle', 'rlHostAngleVal', rlState.hostAngleDeg);
		updateSlider('rlHostAlt', 'rlHostAltVal', rlState.hostAltitudeM);
		updateSlider('rlLaunchAngle', 'rlLaunchAngleVal', rlState.launchAngleDeg);
		updateSlider('rlLaunchMass', 'rlLaunchMassVal', rlState.dryMassT);
		updateSlider('rlLaunchThrust', 'rlLaunchThrustVal', rlState.thrustKN);
		updateSlider('rlFuelAmount', 'rlFuelAmountVal', rlState.fuelAmountT);
		if (rlState.fuelType) { this.ui.rlFuelType.value = rlState.fuelType; }
		updateSlider('rlLaunchMaxG', 'rlLaunchMaxGVal', rlState.maxGLimit);

		if (rlState.autoControl !== undefined) {
			this.ui.rlAutoControl.checked = rlState.autoControl;
			this.universe.RocketLauncher.autoControl = rlState.autoControl;
		}

		this._updateRocketStats();
	}
}
