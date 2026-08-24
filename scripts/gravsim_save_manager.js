// gravsim_save_manager.js

export class SaveManager {
	constructor(universe) {
		this.universe = universe;
		this._initElements();
		this._bindEvents();
	}

	_initElements() {
		this.saveBtn = document.getElementById('save-state-btn');
		this.loadBtn = document.getElementById('load-state-btn');
		this.loadFileInput = document.getElementById('load-file-input');
	}

	_bindEvents() {
		if (this.saveBtn) {
			this.saveBtn.addEventListener('click', () => this.save());
		}
		if (this.loadBtn) {
			this.loadBtn.addEventListener('click', () => {
				if (this.loadFileInput) this.loadFileInput.click();
			});
		}
		if (this.loadFileInput) {
			this.loadFileInput.addEventListener('change', (e) => this.load(e));
		}
	}

	save() {
		const state = {
			version: 2,
			universe: this.universe.getState()
		};

		const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		
		const now = new Date();
		const pad = (n) => String(n).padStart(2, '0');
		const timeStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
		a.download = `GravSim_Data_${timeStr}.json`;
		
		a.click();
		URL.revokeObjectURL(url);
	}

	load(e) {
		const file = e.target.files[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (event) => {
			try {
				const state = JSON.parse(event.target.result);

				if (state.universe) {
					this.universe.loadState(state.universe);
				}
			} catch (err) {
				console.error("Failed to load state:", err);
				alert("Invalid save file.");
			}
			e.target.value = '';
		};
		reader.readAsText(file);
	}
}
