
// gravsim_tab_deploy.js

import { DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';

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
			moonBtn: document.getElementById('put-moon-btn')
		};
	}

	_bindEvents() {
		// Orbital deploy buttons
		for (const [btnId, objName] of Object.entries(this.deployButtons)) {
			const btn = document.getElementById(btnId);
			if (btn) {
				btn.addEventListener('click', () => this.universe.ObjectPlacer.placeAtOrbitAroundSun(objName));
			}
		}
		if (this.ui.moonBtn) {
			this.ui.moonBtn.addEventListener('click', () => this._deployMoon());
		}
	}

	_deployMoon() {
		try {
			this.universe.ObjectPlacer.placeAtOrbitAroundHost("Earth", "Moon");
		} catch (err) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Earth");
			this.universe.ObjectPlacer.placeAtOrbitAroundHost("Earth", "Moon");
		}
	}

	generateMassSelect() {
		if(!this.ui.massSelect) { return; }

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
