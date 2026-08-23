// gravsim_sound_sequencer.js

export class SoundSequencer {
	constructor(universe) {
		this.universe = universe;
		this.previousMET = null;
		this.eventAudioMap = {};
		this.timeAudioMap = {};

		this._bindEvents();
		
		// Register update hook to monitor time for audio triggers
		this.universe.addUpdateHook(() => this.update());
	}

	_bindEvents() {
		// Listen to sequencer events to play corresponding audio
		this.universe.on('sequencer-event', (eventName) => {
			const am = this.universe.AudioManager;
			if (am && this.eventAudioMap[eventName]) {
				am.play(this.eventAudioMap[eventName]);
			}
		});

		// Reset time tracking and set audio maps on start
		this.universe.on('sequencer-start', (sequenceData) => {
			if (this.universe.LaunchSequencer) {
				// Subtract a tiny fraction to ensure the initial integer second is triggered
				this.previousMET = -this.universe.LaunchSequencer.tMinusOffset - 0.001;
			}
			if (sequenceData) {
				this.eventAudioMap = sequenceData.eventAudioMap || {};
				this.timeAudioMap = sequenceData.timeAudioMap || {};
			}
		});

		this.universe.on('sequencer-abort', () => {
			this.previousMET = null;
			this.eventAudioMap = {};
			this.timeAudioMap = {};
		});
	}

	update() {
		const currentMET = this._calculateCurrentMET();
		if (currentMET === null) {
			this.previousMET = null;
			return;
		}

		if (this.previousMET !== null) {
			this._checkTimeTriggers(this.previousMET, currentMET);
		}

		this.previousMET = currentMET;
	}

	_calculateCurrentMET() {
		// Priority 1: LaunchSequencer is active (Pre-launch T- time)
		if (this.universe.LaunchSequencer && this.universe.LaunchSequencer.isActive) {
			return this.universe.LaunchSequencer.timer - this.universe.LaunchSequencer.tMinusOffset;
		}

		// Priority 2: Track active rocket's flight time (T+ time)
		const targetId = this.universe.TelemetryPanel ? this.universe.TelemetryPanel.targetId : null;
		if (targetId !== null) {
			const rocket = this.universe.objects.find(o => o.id === targetId);
			if (rocket && rocket.flightTime > 0) {
				return rocket.flightTime;
			}
		}

		return null;
	}

	_checkTimeTriggers(prevT, currT) {
		const am = this.universe.AudioManager;
		if (!am || !this.timeAudioMap) { return; }

		const prevFloor = Math.floor(prevT);
		const currFloor = Math.floor(currT);

		// Loop through all integer seconds crossed in the current frame
		for (let t = prevFloor + 1; t <= currFloor; t++) {
			const timeKey = t.toString();
			if (this.timeAudioMap[timeKey]) {
				am.play(this.timeAudioMap[timeKey]);
			}
		}
	}
}
