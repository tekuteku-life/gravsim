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

	/**
	 * Save the simulation. When the universe can supply the Worker runtime snapshot the file is
	 * written after it arrives (or after its timeout); otherwise it is written synchronously.
	 * @returns {Promise<void>}
	 */
	save() {
		const capture = (typeof this.universe.captureRuntimeSnapshot === 'function')
			? this.universe.captureRuntimeSnapshot()
			: null;
		if (capture && typeof capture.then === 'function') {
			return capture
				.then((snapshot) => this._writeSaveFile(snapshot), (err) => {
					console.error("Failed to capture runtime state:", err);
					this._writeSaveFile(null);
				});
		}
		this._writeSaveFile(null);
		return Promise.resolve();
	}

	/** @param {Map<number, any> | null} runtimeSnapshot */
	_writeSaveFile(runtimeSnapshot) {
		const state = {
			version: 2,
			universe: this.universe.getState(runtimeSnapshot)
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
				const raw = event?.target?.result;
				if (typeof raw !== 'string') {
					if (typeof alert === 'function') {
						alert("Invalid save file.");
					}
					return;
				}
				const state = JSON.parse(raw);

				if (!state || typeof state !== 'object' || Array.isArray(state) || !state.universe || typeof state.universe !== 'object' || Array.isArray(state.universe)) {
					if (typeof alert === 'function') {
						alert("Invalid save file.");
					}
					return;
				}
				this.universe.loadState(state.universe);
			} catch (err) {
				console.error("Failed to load state:", err);
				if (typeof alert === 'function') {
					alert("Invalid save file.");
				}
			} finally {
				if (e?.target) e.target.value = '';
			}
		};
		reader.readAsText(file);
	}
}
