
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
		this.lastTouchDist = null;
		this.lastTouchCenter = null;
		this.isPanning = false;
		this.hasPanned = false;
		this.lastPanPos = { x: 0, y: 0 };

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
		// Canvas Zoom Events (Wheel & Touch)
		const canvas = this.universe.canvas;
		canvas.addEventListener('wheel', (e) => this._handleWheelZoom(e));
		canvas.addEventListener('touchmove', (e) => this._handleTouchZoom(e), { passive: false });
		canvas.addEventListener('touchend', (e) => this._resetTouchDist(e));
		canvas.addEventListener('touchcancel', () => this._resetTouchDist(null));

		// Pan Events (Right click or Middle click)
		canvas.addEventListener('mousedown', (e) => {
			if (e.button === 1 || e.button === 2) {
				this.isPanning = true;
				this.hasPanned = false;
				this.lastPanPos = { x: e.clientX, y: e.clientY };
			}
		});
		canvas.addEventListener('mousemove', (e) => {
			if (this.isPanning) {
				const dx = e.clientX - this.lastPanPos.x;
				const dy = e.clientY - this.lastPanPos.y;
				
				if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
					this.hasPanned = true;
				}
				
				const zoomScale = this.universe.zoomScale;
				this.universe.cameraOffset.x -= dx / zoomScale;
				this.universe.cameraOffset.y -= dy / zoomScale;
				
				this.lastPanPos = { x: e.clientX, y: e.clientY };
			}
		});
		canvas.addEventListener('mouseup', (e) => {
			if (e.button === 1 || e.button === 2) {
				this.isPanning = false;
			}
		});
		canvas.addEventListener('mouseleave', () => {
			this.isPanning = false;
		});

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

	_handleWheelZoom(e) {
		e.preventDefault();
		let step = this.systemTab.getZoomStep();
		step = (e.deltaY < 0) ? step : -step;
		this.systemTab.setZoomScaleByStep(step);
	}

	_handleTouchZoom(e) {
		if (e.touches.length === 2) {
			e.preventDefault();
			const touch1 = e.touches[0];
			const touch2 = e.touches[1];
			
			const dx = touch1.clientX - touch2.clientX;
			const dy = touch1.clientY - touch2.clientY;
			const dist = Math.sqrt(dx * dx + dy * dy);

			const cx = (touch1.clientX + touch2.clientX) / 2;
			const cy = (touch1.clientY + touch2.clientY) / 2;

			if (this.lastTouchDist !== null && this.lastTouchCenter !== null) {
				// Zoom
				const delta = dist - this.lastTouchDist;
				let step = this.systemTab.getZoomStep() || 0.1;
				step = (delta > 0 ? step : -step) * Math.abs(delta) * 0.05;
				this.systemTab.setZoomScaleByStep(step);

				// Pan
				const panX = cx - this.lastTouchCenter.x;
				const panY = cy - this.lastTouchCenter.y;
				
				if (Math.abs(panX) > 2 || Math.abs(panY) > 2) {
					this.hasPanned = true;
				}

				const zoomScale = this.universe.zoomScale;
				this.universe.cameraOffset.x -= panX / zoomScale;
				this.universe.cameraOffset.y -= panY / zoomScale;
			}
			
			this.lastTouchDist = dist;
			this.lastTouchCenter = { x: cx, y: cy };
		}
	}

	_resetTouchDist(e) {
		if (!e || e.touches.length < 2) {
			this.lastTouchDist = null;
			this.lastTouchCenter = null;
		}
	}

	updateCenterOptions() {
		this.systemTab.updateCenterOptions();
	}

	updateNaviTab() {
		this.naviTab.update();
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
