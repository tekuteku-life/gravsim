
// gravsim_control_panel.js

import { SystemTab } from './gravsim_tab_system.js';
import { DeployTab } from './gravsim_tab_deploy.js';
import { RocketTab } from './gravsim_tab_rocket.js';
import { NaviTab } from './gravsim_tab_navi.js';

/*******************************************************************
 * ControlPanel class that manages the simulation control panel UI.
 *******************************************************************/
export class ControlPanel {
	constructor(universe) {
		this.universe = universe;
		this._initElements();
		
		this.systemTab = new SystemTab(universe);
		this.deployTab = new DeployTab(universe);
		this.rocketTab = new RocketTab(universe, this.systemTab);
		this.naviTab = new NaviTab(universe);

		this._bindEvents();
	}

	// Initialize and cache DOM elements
	_initElements() {
		this.ui = {
			mobileMenuToggle: document.getElementById('mobile-menu-toggle'),
			ctrlPanel: document.getElementById('ctrl-panel'),
			tabBtns: document.querySelectorAll('.tab-btn'),
			tabContents: document.querySelectorAll('.tab-content')
		};
	}

	_bindEvents() {
		// Process by handling events from InputManager
		this.universe.InputManager.onWheelZoom = (dir) => {
			let step = this.systemTab.getZoomStep();
			step = (dir > 0) ? step : -step;
			this.systemTab.setZoomScaleByStep(step);
		};

		this.universe.InputManager.onTouchZoom = (delta) => {
			let step = this.systemTab.getZoomStep() || 0.1;
			step = (delta > 0 ? step : -step) * Math.abs(delta) * 0.05;
			this.systemTab.setZoomScaleByStep(step);
		};

		this.universe.InputManager.onPan = (dx, dy) => {
			const zoomScale = this.universe.zoomScale;
			this.universe.cameraOffset.x -= dx / zoomScale;
			this.universe.cameraOffset.y -= dy / zoomScale;
		};

		// Events for UI
		if (this.ui.mobileMenuToggle) {
			this.ui.mobileMenuToggle.addEventListener('click', () => {
				this.ui.ctrlPanel.classList.toggle('open');
			});
		}

		// --- Tab Navigation Events ---
		if (this.ui.tabBtns) {
			this.ui.tabBtns.forEach(btn => {
				btn.addEventListener('click', (e) => this._tabBtnClick(e));
			});
		}

		// Lock tabs during launch sequence
		this.universe.on('sequencer-start', () => {
			this.ui.tabBtns.forEach(btn => {
				btn.disabled = true;
				btn.style.pointerEvents = 'none';
				btn.style.opacity = '0.5';
			});
		});

		const unlockTabs = () => {
			this.ui.tabBtns.forEach(btn => {
				btn.disabled = false;
				btn.style.pointerEvents = 'auto';
				btn.style.opacity = '1.0';
			});
		};
		this.universe.on('sequencer-end', unlockTabs);
		this.universe.on('sequencer-abort', unlockTabs);
	}

	_tabBtnClick(e) {
		// Remove active class from all tabs
		this.ui.tabBtns.forEach(b => b.classList.remove('active'));
		this.ui.tabContents.forEach(c => c.classList.remove('active'));

		// Add active class to clicked tab
		const targetId = e.target.getAttribute('data-target');
		e.target.classList.add('active');
		document.getElementById(targetId).classList.add('active');

		// Special process for Rocket Launch tab opend
		if (targetId === 'tab-rocket') {
			this.rocketTab.open();
		} else {
			// Close tab except for Rocket tab
			this.rocketTab.close();
		}
	}

	updateCenterOptions() {
		this.systemTab.updateCenterOptions();
	}

	getTimeScale() {
		return this.systemTab.getTimeScale();
	}

	getZoomScale() {
		return this.systemTab.getZoomScale();
	}

	getState() {
		return {
			controlPanel: this.systemTab.getState(),
		};
	}

	loadState(cpState, rlState) {
		if (!cpState) { return; }
		if (cpState.timeScaleVal !== undefined) { this.systemTab.loadState(cpState); }
		if (rlState) { this.rocketTab.loadState(rlState); }
	}
}
