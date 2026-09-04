
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
			solarSystemBtn: document.getElementById('put-solar-system-btn'),
		};
		DOMUtils.verifyElements(this.ui, 'DeployTab');

		// Hide stress test button initially
		this.ui.stressTestBtn.style.display = 'none';
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

		// Jupiter moons (orbit around Jupiter)
		const jupiterMoons = {
			'put-io-btn': 'Io',
			'put-europa-btn': 'Europa',
			'put-ganymede-btn': 'Ganymede',
			'put-callisto-btn': 'Callisto'
		};
		for (const [btnId, moonName] of Object.entries(jupiterMoons)) {
			const btn = document.getElementById(btnId);
			if (btn) {
				btn.addEventListener('click', () => EventBus.emit('object:deploy-orbit-host', "Jupiter", moonName));
			}
		}

		// Saturn moons (orbit around Saturn)
		const saturnMoons = {
			'put-titan-btn': 'Titan',
			'put-enceladus-btn': 'Enceladus',
			'put-mimas-btn': 'Mimas',
			'put-rhea-btn': 'Rhea'
		};
		for (const [btnId, moonName] of Object.entries(saturnMoons)) {
			const btn = document.getElementById(btnId);
			if (btn) {
				btn.addEventListener('click', () => EventBus.emit('object:deploy-orbit-host', "Saturn", moonName));
			}
		}

		// Dwarf planets (orbit around Sun)
		const dwarfPlanets = {
			'put-pluto-btn': 'Pluto',
			'put-ceres-btn': 'Ceres',
			'put-eris-btn': 'Eris'
		};
		for (const [btnId, objName] of Object.entries(dwarfPlanets)) {
			const btn = document.getElementById(btnId);
			if (btn) {
				btn.addEventListener('click', () => EventBus.emit('object:deploy-orbit-sun', objName));
			}
		}

		// Other stars (place at center / free placement)
		const otherStars = {
			'put-betelgeuse-btn': 'Betelgeuse',
			'put-sirius-btn': 'Sirius',
			'put-alphacentauri-btn': 'AlphaCentauriA',
			'put-proxima-btn': 'ProximaCentauri',
			'put-rigel-btn': 'Rigel',
			'put-vega-btn': 'Vega',
			'put-polaris-btn': 'Polaris'
		};
		for (const [btnId, objName] of Object.entries(otherStars)) {
			const btn = document.getElementById(btnId);
			if (btn) {
				btn.addEventListener('click', () => EventBus.emit('object:deploy-orbit-sun', objName));
			}
		}

		this.ui.solarSystemBtn.addEventListener('click', () => {
			EventBus.emit('object:deploy-profile', 'SOLAR_SYSTEM');
		});

		this.ui.stressTestBtn.addEventListener('click', () => {
			// Trigger the profile deployer with the debug stress test profile
			EventBus.emit('object:deploy-profile', 'DEBUG_STRESS_TEST');
		});

		EventBus.on('debug:mode-on', () => {
			if (this.ui.stressTestBtn) {
				this.ui.stressTestBtn.style.display = 'block';
			}
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
