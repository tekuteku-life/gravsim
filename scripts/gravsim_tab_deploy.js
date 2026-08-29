
// gravsim_tab_deploy.js

import { DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';
import { DOMUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';

export class DeployTab {
	constructor(universe) {
		this.universe = universe;
		this.deployButtons = {
			'put-neptune-btn': 'Neptune',
			'put-uranus-btn': 'Uranus',
			'put-saturn-btn': 'Saturn',
			'put-jupiter-btn': 'Jupiter',
			'put-mars-btn': 'Mars',
			'put-earth-btn': 'Earth',
			'put-venus-btn': 'Venus',
			'put-mercury-btn': 'Mercury'
		};
		this._initElements();
		this._bindEvents();
		this.generateMassSelect();
	}

	_initElements() {
		this.ui = {
			massSelect: document.getElementById('mass-select'),
			moonBtn: document.getElementById('put-moon-btn'),
			stressTestBtn: document.getElementById('stress-test-btn'),
		};
		DOMUtils.verifyElements(this.ui, 'DeployTab');
	}

	_bindEvents() {
		// Orbital deploy buttons via EventBus
		for (const [btnId, objName] of Object.entries(this.deployButtons)) {
			const btn = document.getElementById(btnId);
			if (btn) {
				btn.addEventListener('click', () => EventBus.emit('object:deploy-orbit-sun', objName));
			}
		}

		this.ui.moonBtn.addEventListener('click', () => this._deployMoon());

		this.ui.stressTestBtn.addEventListener('click', () => {
			// Trigger the profile deployer with the debug stress test profile
			EventBus.emit('object:deploy-profile', 'DEBUG_STRESS_TEST');
		});
	}

	_deployMoon() {
		EventBus.emit('object:deploy-orbit-host', "Earth", "Moon");
	}

	generateMassSelect() {
		this.ui.massSelect.innerHTML = '';
		for (const key in DEFAULT_OBJECT_PARAMS) {
			const param = DEFAULT_OBJECT_PARAMS[key];
			const option = document.createElement('option');
			option.value = key;
			option.textContent = `${param.NAME} (mass: ${param.MASS.toExponential(2)} t)`;
			this.ui.massSelect.appendChild(option);

			if (param.NAME === "Rocket") {
				option.selected = true;
			}
		}
	}
}
