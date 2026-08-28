
// gravsim_audio_manager.js

import { SOUND } from './gravsim_const.js';
import { EventBus } from './gravsim_event_bus.js';

export class AudioManager {
	constructor(universe) {
		this.universe = universe;
		this.context = null;
		this.buffers = new Map();
		this.isLoaded = false;
		this.currentDir = null;

		EventBus.on('audio:play', (key) => this.play(key));
		EventBus.on('audio:load', (dirName) => this.load(dirName));
		EventBus.on('audio:unload', () => { this.isLoaded = false; });
	}

	_initContext() {
		if (!this.context) {
			this.context = new (window.AudioContext || window.webkitAudioContext)();
			// AudioContext must be resumed if it was suspended (browser autoplay policy)
			if (this.context.state === 'suspended') {
				this.context.resume();
			}
		}
	}

	async load(dirName) {
		EventBus.emit('ui:set-loading-overlay', true);

		this._initContext();
		this.currentDir = `${SOUND.BASEDIR}/${dirName}`;
		this.buffers.clear();
		this.isLoaded = false;

		try {
			const response = await fetch(`${this.currentDir}/manifest.json`);
			if (!response.ok) {
				console.warn(`[AudioManager] manifest.json not found in ${this.currentDir}`);
				return;
			}
			const manifest = await response.json();

			const loadPromises = manifest.map(async (key) => {
				const res = await fetch(`${this.currentDir}/${key}.mp3`);
				const arrayBuffer = await res.arrayBuffer();
				const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
				this.buffers.set(key, audioBuffer);
			});

			await Promise.all(loadPromises);
			this.isLoaded = true;
			console.info(`[AudioManager] Audio loaded from ${this.currentDir} (${manifest.length} files)`);
		} catch (error) {
			console.error("[AudioManager] Failed to load audio", error);
		} finally {
			EventBus.emit('ui:set-loading-overlay', false);
		}
	}

	play(key) {
		if (!this.isLoaded || !this.buffers.has(key)) { return; }
		this._initContext();

		const source = this.context.createBufferSource();
		source.buffer = this.buffers.get(key);
		source.connect(this.context.destination);
		source.start(0);
	}
}
