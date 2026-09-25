
// gravsim_sound_effects.js

import { OBJECT_TYPES, EVENT_PRIORITY } from './gravsim_const.js';
import { EventBus } from './gravsim_event_bus.js';

/*******************************************************************
 * Sound Effect Parameter Configuration Table
 *******************************************************************/
export const SOUND_FX_CONFIG = Object.freeze({
	// Heavy rocket exhaust roar (Engine Roar)
	engineRoar: {
		type: 'noise',
		baseGain: 2.50,
		vacFloorGain: 0.05,        // Residual hull-transmitted vibration floor in vacuum
		scaleHeightM: 18000.0,     // Barometric decay scale height for smooth atmospheric fadeout
		rampTime: 0.08,
		filter1: { type: 'lowpass', freq: 110, q: 3.2 },
		filter2: { type: 'peaking', freq: 65, q: 2.2, gain: 14.0 }, // Heavy sub-bass boost
		throttleFreqBase: 90,
		throttleFreqRange: 90
	},

	// Launch pad sound suppression spray (Water Deluge)
	waterDeluge: {
		type: 'noise',
		baseGain: 0.07,
		rampTime: 0.18,
		filter1: { type: 'bandpass', freq: 2800, q: 1.1 },
		filter2: { type: 'highpass', freq: 1400, q: 0.7, gain: 0 },
		towerClearAltM: 90.0       // Fade out target altitude around tower clearance
	},

	// Aerodynamic supersonic whine (Mach shockwave whistle)
	supersonicWhine: {
		type: 'oscillator',
		baseGain: 0.30,
		rampTime: 0.12,
		waveform: 'sawtooth',      // Rich harmonics without harsh single-tone piercing
		baseFreq: 880,             // Lowered from 2800Hz to eliminate mosquito-like screeching
		freqRange: 480,            // Dynamic frequency modulation span (880Hz - 1360Hz)
		detuneHz: 16.0,            // Dual oscillator beat frequency
		filter: { type: 'bandpass', freq: 1100, q: 2.2 },
		machMin: 1.0,
		machMax: 3.5,
		qRatioNorm: 35.0           // Normalized against max aerodynamic pressure (kPa)
	}
});

/*******************************************************************
 * Generic Noise-Driven Filter Voice (Roar / Deluge)
 *******************************************************************/
class NoiseFilterVoice {
	constructor(audioCtx, outNode, config) {
		this.ctx = audioCtx;
		this.outNode = outNode;
		this.config = config;
		this.isRunning = false;

		this.source = null;
		this.f1 = null;
		this.f2 = null;
		this.gainNode = null;
	}

	start(sharedNoiseBuffer) {
		if (this.isRunning) { return; }
		this.isRunning = true;

		this.source = this.ctx.createBufferSource();
		this.source.buffer = sharedNoiseBuffer;
		this.source.loop = true;

		this.f1 = this.ctx.createBiquadFilter();
		this.f1.type = this.config.filter1.type;
		this.f1.frequency.value = this.config.filter1.freq;
		this.f1.Q.value = this.config.filter1.q;

		this.f2 = this.ctx.createBiquadFilter();
		this.f2.type = this.config.filter2.type;
		this.f2.frequency.value = this.config.filter2.freq;
		this.f2.Q.value = this.config.filter2.q;
		if (this.config.filter2.gain) {
			this.f2.gain.value = this.config.filter2.gain;
		}

		this.gainNode = this.ctx.createGain();
		this.gainNode.gain.setValueAtTime(0.0001, this.ctx.currentTime);

		this.source.connect(this.f1);
		this.f1.connect(this.f2);
		this.f2.connect(this.gainNode);
		this.gainNode.connect(this.outNode);

		this.source.start(0);
	}

	setGain(targetGain) {
		if (!this.isRunning || !this.gainNode) { return; }

		this.gainNode.gain.setTargetAtTime(targetGain, this.ctx.currentTime, this.config.rampTime);
	}

	setFreq(filterIdx, freq) {
		if (!this.isRunning) { return; }

		const filter = filterIdx === 1 ? this.f1 : this.f2;
		if (filter) {
			filter.frequency.setTargetAtTime(freq, this.ctx.currentTime, this.config.rampTime);
		}
	}

	stop() {
		if (!this.isRunning) { return; }

		const now = this.ctx.currentTime;
		if (this.gainNode) {
			this.gainNode.gain.setTargetAtTime(0.0001, now, 0.08);
		}

		setTimeout(() => {
			if (this.source) {
				try { this.source.stop(); } catch (_) {}
				this.source.disconnect();
				this.source = null;
			}
			if (this.f1) { this.f1.disconnect(); this.f1 = null; }
			if (this.f2) { this.f2.disconnect(); this.f2 = null; }
			if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
			this.isRunning = false;
		}, 120);
	}
}

/*******************************************************************
 * Dual Oscillator-Driven Harmonic Voice (Supersonic Whine)
 *******************************************************************/
class DualOscVoice {
	constructor(audioCtx, outNode, config) {
		this.ctx = audioCtx;
		this.outNode = outNode;
		this.config = config;
		this.isRunning = false;

		this.osc1 = null;
		this.osc2 = null;
		this.filter = null;
		this.gainNode = null;
	}

	start() {
		if (this.isRunning) { return; }
		this.isRunning = true;

		this.osc1 = this.ctx.createOscillator();
		this.osc1.type = this.config.waveform;
		this.osc1.frequency.value = this.config.baseFreq;

		this.osc2 = this.ctx.createOscillator();
		this.osc2.type = this.config.waveform;
		this.osc2.frequency.value = this.config.baseFreq + this.config.detuneHz;

		this.filter = this.ctx.createBiquadFilter();
		this.filter.type = this.config.filter.type;
		this.filter.frequency.value = this.config.filter.freq;
		this.filter.Q.value = this.config.filter.q;

		this.gainNode = this.ctx.createGain();
		this.gainNode.gain.setValueAtTime(0.0001, this.ctx.currentTime);

		this.osc1.connect(this.filter);
		this.osc2.connect(this.filter);
		this.filter.connect(this.gainNode);
		this.gainNode.connect(this.outNode);

		this.osc1.start(0);
		this.osc2.start(0);
	}

	setGain(targetGain) {
		if (!this.isRunning || !this.gainNode) { return; }

		this.gainNode.gain.setTargetAtTime(targetGain, this.ctx.currentTime, this.config.rampTime);
	}

	setFreq(baseFreq) {
		if (!this.isRunning) { return; }

		const now = this.ctx.currentTime;
		this.osc1.frequency.setTargetAtTime(baseFreq, now, this.config.rampTime);
		this.osc2.frequency.setTargetAtTime(baseFreq + this.config.detuneHz, now, this.config.rampTime);
		this.filter.frequency.setTargetAtTime(baseFreq, now, this.config.rampTime);
	}

	stop() {
		if (!this.isRunning) { return; }

		const now = this.ctx.currentTime;
		if (this.gainNode) {
			this.gainNode.gain.setTargetAtTime(0.0001, now, 0.08);
		}

		setTimeout(() => {
			if (this.osc1) {
				try { this.osc1.stop(); } catch (_) {}
				this.osc1.disconnect();
				this.osc1 = null;
			}
			if (this.osc2) {
				try { this.osc2.stop(); } catch (_) {}
				this.osc2.disconnect();
				this.osc2 = null;
			}
			if (this.filter) { this.filter.disconnect(); this.filter = null; }
			if (this.gainNode) { this.gainNode.disconnect(); this.gainNode = null; }
			this.isRunning = false;
		}, 120);
	}
}

/*******************************************************************
 * Master SoundEffects Engine
 * Autonomous sound loop registering itself to EventBus.
 *******************************************************************/
export class SoundEffects {
	constructor(universe) {
		this.universe = universe;
		this.audioCtx = null;
		this.masterBus = null;
		this.sharedNoiseBuf = null;

		this.voices = {};
		this.isDelugeTriggered = false;
		this.isLiftoffOccurred = false;

		this._bindEvents();

		// Self-register to EventBus update loop for autonomous per-frame synthesis
		EventBus.onUpdate((dt, scaledDt) => this.update(dt, scaledDt), EVENT_PRIORITY.LOGIC);
	}

	_initAudio() {
		if (!this.audioCtx) {
			const AudioContextClass = window.AudioContext || window.webkitAudioContext;
			if (!AudioContextClass) { return; }

			this.audioCtx = new AudioContextClass();

			// Master limiter/compressor to cleanly prevent digital clipping
			this.masterBus = this.audioCtx.createDynamicsCompressor();
			this.masterBus.threshold.value = -6.0;
			this.masterBus.knee.value = 8.0;
			this.masterBus.ratio.value = 12.0;
			this.masterBus.attack.value = 0.003;
			this.masterBus.release.value = 0.15;
			this.masterBus.connect(this.audioCtx.destination);

			// Pre-render looped 2-second white noise buffer (shared across noise voices)
			const length = this.audioCtx.sampleRate * 2;
			this.sharedNoiseBuf = this.audioCtx.createBuffer(1, length, this.audioCtx.sampleRate);
			const chData = this.sharedNoiseBuf.getChannelData(0);
			for (let i = 0; i < length; i++) {
				chData[i] = Math.random() * 2 - 1;
			}

			// Instantiate table-driven voice channels
			this.voices.engineRoar = new NoiseFilterVoice(this.audioCtx, this.masterBus, SOUND_FX_CONFIG.engineRoar);
			this.voices.waterDeluge = new NoiseFilterVoice(this.audioCtx, this.masterBus, SOUND_FX_CONFIG.waterDeluge);
			this.voices.supersonicWhine = new DualOscVoice(this.audioCtx, this.masterBus, SOUND_FX_CONFIG.supersonicWhine);
		}

		if (this.audioCtx && this.audioCtx.state === 'suspended') {
			this.audioCtx.resume();
		}
	}

	_bindEvents() {
		const resumeAudio = () => this._initAudio();
		window.addEventListener('click', resumeAudio, { once: true });
		window.addEventListener('touchstart', resumeAudio, { once: true });

		EventBus.on('sequencer-start', resumeAudio);
		EventBus.on('auto-sequence-start', resumeAudio);
		EventBus.on('simulation:resume', resumeAudio);

		// Deluge water curtain activation
		EventBus.on('sequencer-event', (eventName) => {
			if (eventName.includes('WATER DELUGE')) {
				this.isDelugeTriggered = true;
				this.isLiftoffOccurred = false;
			}
		});

		// Liftoff trigger for water deluge clearance fadeout
		EventBus.on('liftoff', () => {
			this.isLiftoffOccurred = true;
		});

		// Stop all audio on reset, abort, or destruction
		EventBus.on('simulation:reset', () => this.stopAll());
		EventBus.on('sequencer-abort', () => this.stopAll());
		EventBus.on('rocket:destroyed', () => this.stopAll());
		EventBus.on('audio:stop-all', () => this.stopAll());
	}

	/**
	 * Self-updating per-frame synthesis loop
	 */
	update(dt, scaledDt) {
		if (!this.audioCtx) { return; }

		const rocket = this._getActiveRocket();

		// 1. Engine Roar Synthesis (Barometric pressure proportional fadeout)
		const roarCfg = SOUND_FX_CONFIG.engineRoar;
		const roarVoice = this.voices.engineRoar;

		if (rocket && rocket.type === OBJECT_TYPES.ROCKET && !rocket.collided && !rocket.shattered) {
			const throttle = Number(rocket.thrustRatio) || 0;
			const isFiring = Boolean(rocket.isIgnited && throttle > 0.01);
			const inAtmosphere = Boolean(rocket.inAtmosphere);
			const altM = Math.max(0, rocket.telemetry?.altM || 0);

			if (isFiring) {
				if (!roarVoice.isRunning) {
					roarVoice.start(this.sharedNoiseBuf);
				}
				// Barometric pressure proportional decay curve (approximate e^(-alt / H))
				const baroRatio = inAtmosphere ? Math.exp(-altM / roarCfg.scaleHeightM) : 0;
				const envGain = roarCfg.vacFloorGain + (1.0 - roarCfg.vacFloorGain) * baroRatio;
				const targetGain = roarCfg.baseGain * envGain * Math.min(throttle, 1.0);
				const targetFreq = roarCfg.throttleFreqBase + throttle * roarCfg.throttleFreqRange;

				roarVoice.setGain(targetGain);
				roarVoice.setFreq(1, targetFreq);
			} else {
				if (roarVoice.isRunning) roarVoice.stop();
			}

			// 2. Supersonic Whine Synthesis (Mach 1.0 - 3.5 in atmosphere)
			const whineCfg = SOUND_FX_CONFIG.supersonicWhine;
			const whineVoice = this.voices.supersonicWhine;

			const vV = rocket.telemetry?.vV || 0;
			const vH = rocket.telemetry?.vH || 0;
			const mach = Math.hypot(vV, vH) / 340.0;
			const qRatio = (rocket.telemetry?.qAxialKpa || 0) / whineCfg.qRatioNorm;

			if (mach > whineCfg.machMin && inAtmosphere && qRatio > 0.03) {
				if (!whineVoice.isRunning) {
					whineVoice.start();
				}
				const progress = Math.min((mach - whineCfg.machMin) / (whineCfg.machMax - whineCfg.machMin), 1.0);
				const targetGain = whineCfg.baseGain * progress * Math.min(qRatio, 1.2);
				const targetFreq = whineCfg.baseFreq + progress * whineCfg.freqRange;

				whineVoice.setGain(targetGain);
				whineVoice.setFreq(targetFreq);
			} else {
				if (whineVoice.isRunning) whineVoice.stop();
			}
		} else {
			if (roarVoice.isRunning) roarVoice.stop();
			if (this.voices.supersonicWhine.isRunning) this.voices.supersonicWhine.stop();
		}

		// 3. Water Deluge Curtain Spray Synthesis (Pad start to tower clearance fadeout)
		const delugeCfg = SOUND_FX_CONFIG.waterDeluge;
		const delugeVoice = this.voices.waterDeluge;

		if (this.isDelugeTriggered) {
			const isHoldingDown = rocket?.isHoldDown ?? true;
			const isLiftoff = this.isLiftoffOccurred || !isHoldingDown;
			const altM = Math.max(0, rocket?.telemetry?.relativeAltM || 0);

			let distFactor = 1.0;
			if (isLiftoff) {
				// Smoothly fade out as rocket ascends towards tower clearance altitude (~90m)
				distFactor = Math.max(0, 1.0 - (altM / delugeCfg.towerClearAltM));
			}

			if (isLiftoff && distFactor <= 0.005) {
				this.isDelugeTriggered = false;
				if (delugeVoice.isRunning) { delugeVoice.stop(); }
			} else {
				if (!delugeVoice.isRunning) {
					delugeVoice.start(this.sharedNoiseBuf);
				}
				delugeVoice.setGain(delugeCfg.baseGain * distFactor);
			}
		} else {
			if (delugeVoice.isRunning) { delugeVoice.stop(); }
		}
	}

	_getActiveRocket() {
		if (!this.universe) { return null; }
		const targetId = this.universe.LaunchSequencer?.rocketId || this.universe.camera?.trackingTarget?.id;

		if (targetId !== null && targetId !== undefined) {
			const obj = this.universe.objects.find(o => o.id === targetId);
			if (obj && obj.type === OBJECT_TYPES.ROCKET) { return obj; }
		}

		return this.universe.objects.find(o => o.type === OBJECT_TYPES.ROCKET) || null;
	}

	stopAll() {
		this.isDelugeTriggered = false;
		this.isLiftoffOccurred = false;
		for (const key in this.voices) {
			this.voices[key].stop();
		}
	}

	destroy() {
		this.stopAll();
		if (this.audioCtx) {
			try { this.audioCtx.close(); } catch (_) {}
			this.audioCtx = null;
		}
	}
}
