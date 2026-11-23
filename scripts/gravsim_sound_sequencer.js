
// gravsim_sound_sequencer.js

import { EVENT_PRIORITY } from './gravsim_const.js';
import { EventBus } from './gravsim_event_bus.js';
import { normalizeMissionStatus } from './gravsim_utils.js';

export class SoundSequencer {
	constructor(universe) {
		this.universe = universe;
		this.previousMET = null;
		// The last whole second of the T clock whose time callout has been considered. The clock changes its source at
		// the end of the countdown (the sequencer's T to the Worker MET, which runs a frame or so behind) and starts again
		// after a load: a second is never voiced twice
		this.lastTimeKeySecond = null;
		// After a load: the first valid MET marks what the loaded flight has already passed (see resyncAfterLoad)
		this.isResyncPending = false;

		// Initialize empty profile
		this.audioProfile = { events: {}, times: {}, conditions: [] };
		this.conditionFlags = {};

		this._bindEvents();

		// Register update hook to monitor time for audio triggers
		EventBus.onUpdate(() => this.update(), EVENT_PRIORITY.LOGIC);
	}

	_bindEvents() {
		// Listen to sequencer events to play corresponding audio based on profile
		EventBus.on('sequencer-event', (eventName) => {
			if (this.audioProfile.events && this.audioProfile.events[eventName]) {
				EventBus.emit('audio:play', this.audioProfile.events[eventName]);
			}
		});

		// Reset time tracking and set audio profile on start
		EventBus.on('sequencer-start', (sequenceData) => {
			if (this.universe.LaunchSequencer) {
				// Subtract a tiny fraction to ensure the initial integer second is triggered
				this.previousMET = -this.universe.LaunchSequencer.tMinusOffset - 0.001;

				// Load external audio profile
				if (sequenceData && sequenceData.audioProfile) {
					this.audioProfile = sequenceData.audioProfile;
				} else {
					this.audioProfile = { events: {}, times: {}, conditions: [] };
				}
				// Reset once flags
				this.conditionFlags = {};
				this.lastTimeKeySecond = null;
				this.isResyncPending = false;
			}
		});

		EventBus.on('sequencer-abort', () => this.clearFlight());

		// Reset removes every rocket, so the flight the profile and its once-only flags belong to is gone (a later load or
		// rocket starts as on a new page). The end of the countdown ('sequencer-end') keeps them: the flight's callouts
		// (MECO, SES, SECO ...) come after it
		EventBus.on('simulation:reset', () => this.clearFlight());
	}

	/** Forget the flight: its audio profile, the once-only flags and the clock. */
	clearFlight() {
		this.previousMET = null;
		this.lastTimeKeySecond = null;
		this.isResyncPending = false;
		this.audioProfile = { events: {}, times: {}, conditions: [] };
		this.conditionFlags = {};
	}

	/**
	 * A saved world was loaded (Universe.loadState). The loaded rocket continues its flight at the saved MET (the Worker
	 * runtime state, design §4.7), so what it passed before the save must not be voiced again, and what it has not passed
	 * must still be: the once-only flags of the earlier flight are cleared, and the first valid MET of the loaded flight
	 * marks every once-only condition that already holds, and every whole second up to it, as done without playing
	 * them. Earlier the T clock (the main thread's rocket.flightTime, not saved) restarted at 0, so the T+1..5 count
	 * played again, and the flags of the earlier flight stayed (design §4.14-6).
	 */
	resyncAfterLoad() {
		this.previousMET = null;
		this.lastTimeKeySecond = null;
		this.conditionFlags = {};
		this.isResyncPending = true;
	}

	update() {
		const currentMET = this._calculateCurrentMET();
		if (currentMET === null) {
			this.previousMET = null;
			return;
		}

		if (this.isResyncPending) {
			this.isResyncPending = false;
			this._markPassed(currentMET);
		} else if (this.previousMET !== null) {
			this._checkTimeTriggers(this.previousMET, currentMET);
			this._checkConditions(currentMET);
		}

		this.previousMET = currentMET;
	}

	/**
	 * Mark the part of the flight before `currentMET` as voiced (after a load): every whole second up to it, and every
	 * once-only condition that holds now. Nothing is played.
	 * @param {number} currentMET
	 */
	_markPassed(currentMET) {
		this.lastTimeKeySecond = Math.floor(currentMET);
		if (currentMET < 0 || !this.audioProfile.conditions) { return; }
		const rocket = this._getTargetRocket();
		if (!rocket || !rocket.telemetry) { return; }
		for (const cond of this.audioProfile.conditions) {
			if (cond.once && this._isConditionMatched(cond, currentMET, rocket)) {
				this.conditionFlags[cond.id] = true;
			}
		}
	}

	/** The rocket the callouts follow: the telemetry panel's target. */
	_getTargetRocket() {
		const targetId = this.universe.TelemetryPanel ? this.universe.TelemetryPanel.targetId : null;
		if (targetId === null || targetId === undefined) { return null; }
		return this.universe.objects.find(o => o.id === targetId) || null;
	}

	_calculateCurrentMET() {
		// Priority 1: LaunchSequencer is active (Pre-launch T- time)
		if (this.universe.LaunchSequencer && this.universe.LaunchSequencer.isActive) {
			return this.universe.LaunchSequencer.timer - this.universe.LaunchSequencer.tMinusOffset;
		}

		// Priority 2: the target rocket's MET (T+ time) as the HUD shows it: the Worker's flight time (telemetry), which a
		// load continues (design §4.7). The main thread's rocket.flightTime is not the flight's clock: it runs on the pad
		// and restarted at 0 after a load. It is used only when it is a finite positive number (design §4.14-6 (a)): the
		// frame buffer always gives a number, and a value of another type is not read as one (a numeric string is not a
		// MET, as it is not a status, §4.13-21)
		const rocket = this._getTargetRocket();
		const met = rocket?.telemetry?.flightTime;
		if (typeof met === 'number' && Number.isFinite(met) && met > 0) {
			return met;
		}

		return null;
	}

	_checkTimeTriggers(prevT, currT) {
		if (!this.audioProfile.times) { return; }

		const prevFloor = Math.floor(prevT);
		const currFloor = Math.floor(currT);
		// A second already considered is not voiced again when the clock steps back (see lastTimeKeySecond)
		const fromSecond = this.lastTimeKeySecond === null ? prevFloor + 1 : Math.max(prevFloor, this.lastTimeKeySecond) + 1;

		// Loop through all integer seconds crossed in the current frame
		for (let t = fromSecond; t <= currFloor; t++) {
			const timeKey = t.toString();
			if (this.audioProfile.times[timeKey]) {
				EventBus.emit('audio:play', this.audioProfile.times[timeKey]);
			}
		}
		if (this.lastTimeKeySecond === null || currFloor > this.lastTimeKeySecond) {
			this.lastTimeKeySecond = currFloor;
		}
	}

	_checkConditions(currentMET) {
		// Only check flight conditions after liftoff
		if (currentMET < 0) { return; }

		if (!this.audioProfile.conditions) { return; }

		const rocket = this._getTargetRocket();
		if (!rocket || !rocket.telemetry) { return; }

		// Evaluate each condition defined in the profile
		for (const cond of this.audioProfile.conditions) {
			// Skip if it should only run once and has already been triggered
			if (cond.once && this.conditionFlags[cond.id]) {
				continue;
			}

			// Fire audio if matched
			if (this._isConditionMatched(cond, currentMET, rocket)) {
				EventBus.emit('audio:play', cond.audio);
				if (cond.once) {
					this.conditionFlags[cond.id] = true;
				}
			}
		}
	}

	/**
	 * @param {any} cond a condition of the audio profile
	 * @param {number} currentMET
	 * @param {any} rocket the target rocket (with telemetry)
	 * @returns {boolean}
	 */
	_isConditionMatched(cond, currentMET, rocket) {
		let valueToCompare = null;

		// Resolve the target value based on condition type
		if (cond.type === 'met') {
			valueToCompare = currentMET;
		} else if (cond.type === 'status') {
			// The mission status as the telemetry panel reads it: a value that is not a status code is PRE_LAUNCH
			// (design §4.13-25)
			valueToCompare = normalizeMissionStatus(rocket.telemetry.status);
		} else if (rocket.telemetry[cond.type] !== undefined) {
			valueToCompare = rocket.telemetry[cond.type];
		}

		if (valueToCompare === null) { return false; }

		// Evaluate operator
		switch (cond.operator) {
			case '>': return valueToCompare > cond.value;
			case '<': return valueToCompare < cond.value;
			case '>=': return valueToCompare >= cond.value;
			case '<=': return valueToCompare <= cond.value;
			case '==': return valueToCompare === cond.value;
			case '!=': return valueToCompare !== cond.value;
		}
		return false;
	}
}
