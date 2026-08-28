
// gravsim_control_panel.js

import { SystemTab } from './gravsim_tab_system.js';
import { DeployTab } from './gravsim_tab_deploy.js';
import { RocketTab } from './gravsim_tab_rocket.js';
import { NaviTab } from './gravsim_tab_navi.js';
import { EventBus } from './gravsim_event_bus.js';

/*******************************************************************
 * ControlPanel class that manages the simulation control panel UI.
 *******************************************************************/
export class ControlPanel {
	constructor(universe) {
		this.universe = universe;
		this._initElements();

		this.systemTab = new SystemTab(universe);
		this.deployTab = new DeployTab(universe);
		this.rocketTab = new RocketTab(universe);
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

		EventBus.on('ui:set-tabs-locked', (isLocked) => {
			this.ui.tabBtns.forEach(btn => {
				btn.disabled = isLocked;
				btn.style.pointerEvents = isLocked ? 'none' : 'auto';
				btn.style.opacity = isLocked ? '0.5' : '1.0';
			});
		});
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

	getTimeScale() {
		return this.systemTab.getTimeScale();
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
