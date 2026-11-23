
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
			this.ui.tabBtns.forEach((/** @type {any} */ btn) => {
				btn.disabled = isLocked;
				btn.style.pointerEvents = isLocked ? 'none' : 'auto';
				btn.style.opacity = isLocked ? '0.5' : '1.0';
			});
		});
	}

	/** @param {any} e */
	_tabBtnClick(e) {
		if (e.target.disabled) { return; }

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
			if (targetId === 'tab-sys') {
				this.systemTab.updateCenterOptions();
			}
		}
	}

	getTimeScale() {
		return this.systemTab.getTimeScale();
	}

	/** The time-scale exponent the simulation runs at (SystemTab.getTimeScaleExp). */
	getTimeScaleExp() {
		return this.systemTab.getTimeScaleExp();
	}

	getState() {
		return {
			controlPanel: this.systemTab.getState(),
		};
	}

	/**
	 * The System-tab state inside a saved `controlPanel` entry. getState() nests it ({ controlPanel: { timeScaleVal,
	 * zoomScaleVal } }, written since the tabs were split into classes); saves written before that keep the two values
	 * at the top level. Both carry `version: 2`, so the shape decides.
	 * @param {any} cpState
	 * @returns {{ timeScaleVal?: any, zoomScaleVal?: any } | null}
	 */
	static resolveSystemTabState(cpState) {
		if (!cpState || typeof cpState !== 'object' || Array.isArray(cpState)) { return null; }
		const nested = cpState.controlPanel;
		if (nested && typeof nested === 'object' && !Array.isArray(nested)) { return nested; }
		return cpState;
	}

	loadState(cpState, rlState) {
		if (!cpState) { return; }
		const sysState = ControlPanel.resolveSystemTabState(cpState);
		if (sysState) {
			const view = this.systemTab.normalizeViewState(sysState);
			if (this.rocketTab.isOpened) {
				// The Rocket tab keeps the minimum time scale (and its own zoom) while it is open; the loaded values
				// replace the ones it restores when it closes
				this.rocketTab.deferViewState(view);
			} else {
				this.systemTab.applyViewState(view);
			}
			this.systemTab.updateCenterOptions();
		}
		if (rlState) { this.rocketTab.loadState(rlState); }
	}
}
