
// gravsim_sound_sequencer.js

export class SoundSequencer {
	constructor(universe) {
		this.universe = universe;
		this.previousMET = null;

		// Initialize empty profile
		this.audioProfile = { events: {}, times: {}, conditions: [] };
		this.conditionFlags = {};

		this._bindEvents();
		
		// Register update hook to monitor time for audio triggers
		this.universe.addUpdateHook(() => this.update());
	}

	_bindEvents() {
		// Listen to sequencer events to play corresponding audio based on profile
		this.universe.on('sequencer-event', (eventName) => {
			const am = this.universe.AudioManager;
			if (am && this.audioProfile.events && this.audioProfile.events[eventName]) {
				am.play(this.audioProfile.events[eventName]);
			}
		});

		// Reset time tracking and set audio profile on start
		this.universe.on('sequencer-start', (sequenceData) => {
			if (this.universe.LaunchSequencer) {
				// Subtract a tiny fraction to ensure the initial integer second is triggered
				this.previousMET = -this.universe.LaunchSequencer.tMinusOffset - 0.001;
			}

			// Load external audio profile
			if (sequenceData && sequenceData.audioProfile) {
				this.audioProfile = sequenceData.audioProfile;
			} else {
				this.audioProfile = { events: {}, times: {}, conditions: [] };
			}

			// Reset once flags
			this.conditionFlags = {};
		});

		this.universe.on('sequencer-abort', () => {
			this.previousMET = null;
			this.audioProfile = { events: {}, times: {}, conditions: [] };
			this.conditionFlags = {};
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

		this._checkConditions(currentMET);

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
		if (!am || !this.audioProfile.times) { return; }

		const prevFloor = Math.floor(prevT);
		const currFloor = Math.floor(currT);

		// Loop through all integer seconds crossed in the current frame
		for (let t = prevFloor + 1; t <= currFloor; t++) {
			const timeKey = t.toString();
			if (this.audioProfile.times[timeKey]) {
				am.play(this.audioProfile.times[timeKey]);
			}
		}
	}

	_checkConditions(currentMET) {
		// Only check flight conditions after liftoff
		if (currentMET < 0) { return; }

		const am = this.universe.AudioManager;
		if (!am || !this.audioProfile.conditions) { return; }

		const targetId = this.universe.TelemetryPanel ? this.universe.TelemetryPanel.targetId : null;
		if (targetId === null) { return; }

		const rocket = this.universe.objects.find(o => o.id === targetId);
		if (!rocket || !rocket.telemetry) { return; }

		// Evaluate each condition defined in the profile
		for (const cond of this.audioProfile.conditions) {
			// Skip if it should only run once and has already been triggered
			if (cond.once && this.conditionFlags[cond.id]) {
				continue;
			}

			let valueToCompare = null;
			
			// Resolve the target value based on condition type
			if (cond.type === 'met') {
				valueToCompare = currentMET;
			} else if (rocket.telemetry[cond.type] !== undefined) {
				valueToCompare = rocket.telemetry[cond.type];
			}

			if (valueToCompare === null) { continue; }

			// Evaluate operator
			let isMatched = false;
			switch(cond.operator) {
				case '>': isMatched = valueToCompare > cond.value; break;
				case '<': isMatched = valueToCompare < cond.value; break;
				case '>=': isMatched = valueToCompare >= cond.value; break;
				case '<=': isMatched = valueToCompare <= cond.value; break;
				case '==': isMatched = valueToCompare === cond.value; break;
				case '!=': isMatched = valueToCompare !== cond.value; break;
			}

			// Fire audio if matched
			if (isMatched) {
				am.play(cond.audio);
				if (cond.once) {
					this.conditionFlags[cond.id] = true;
				}
			}
		}
	}
}
