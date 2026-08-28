
// gravsim_launch_sequencer.js

import { PHYSICS, LAUNCH_SEQUENCES, EVENT_PRIORITY } from './gravsim_const.js';
import { EventBus } from './gravsim_event_bus.js';

export class LaunchSequencer {
	constructor() {
		this.isActive = false;
		this.isAutoSequence = false;
		this.sequence = [];
		this.tMinusOffset = 0;
		this.timer = 0;
		this.rocketId = null;
		this.eventIndex = 0;

		// Register update hook
		EventBus.onUpdate((dt, scaledDt) => this.update(scaledDt), EVENT_PRIORITY.LOGIC);
	}

	start(sequenceData, rocketId) {
		this.sequence = sequenceData.events || sequenceData;
		this.tMinusOffset = sequenceData.tMinusOffset || 0;
		this.rocketId = rocketId;
		this.isActive = true;
		this.isAutoSequence = false;
		this.eventIndex = 0;
		this.timer = 0; 

		// Force time scale to real-time via EventBus
		const realTimeScaleVal = Math.log10(1 / PHYSICS.YEARS_PER_SECOND);
		EventBus.emit('ui:set-time-scale', realTimeScaleVal);

		EventBus.emit('sequencer-start', sequenceData);
	}

	abort() {
		if (!this.isActive) { return; }
		this.isActive = false;
		this.isAutoSequence = false;
		EventBus.emit('sequencer-abort');
	}

	update(dtSec) {
		if (!this.isActive) { return; }

		this.timer += dtSec;

		// Calculate T- time
		const currentT = this.timer - this.tMinusOffset;
		const sign = currentT < 0 ? '-' : '+';
		const absT = Math.abs(currentT);
		
		const mins = Math.floor(absT / 60);
		const secs = Math.floor(absT % 60);
		const ms = Math.floor((absT % 1) * 10);
		
		const timeText = `T ${sign} ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${ms}`;

		// Determine the latest displayed event
		let latestEventName = "STANDING BY";
		if (this.eventIndex > 0 && this.eventIndex <= this.sequence.length) {
			latestEventName = this.sequence[this.eventIndex - 1].name;
		}

		EventBus.emit('sequencer-tick', { timeText, eventName: latestEventName });

		while (this.eventIndex < this.sequence.length && this.timer >= this.sequence[this.eventIndex].time) {
			const evt = this.sequence[this.eventIndex];
			this.executeCommand(evt.command, evt.name);
			this.eventIndex++;
		}

		if (this.eventIndex >= this.sequence.length && currentT > LAUNCH_SEQUENCES.LAUNCH_TO_COMPLETION_TIME) {
			// Turn off sequencer X seconds after liftoff
			this.isActive = false;
			this.isAutoSequence = false;
			EventBus.emit('sequencer-end');
		}
	}

	executeCommand(cmd, name) {
		if (name) {
			EventBus.emit('sequencer-event', name);
		}

		// Pass ALL commands to the worker for pressure simulation etc.
		if (this.rocketId !== null && cmd) {
			EventBus.emit('worker:send-rocket-command', this.rocketId, cmd);
		}

		switch (cmd) {
			case 'START_COUNTDOWN':
				EventBus.emit('ui:set-rollout-state', true);
				break;
			case 'AUTO_SEQUENCE_START':
				this.isAutoSequence = true;
				EventBus.emit('auto-sequence-start');
				break;
			case 'IGNITE_ENGINE':
				// Ignite but keep holding down
				EventBus.emit('rocket:update-state', this.rocketId, true, true);
				break;
			case 'RELEASE_HOLD_DOWN':
				// Release vehicle
				EventBus.emit('rocket:update-state', this.rocketId, true, false);
				EventBus.emit('ui:set-rollout-state', false);
				this.isAutoSequence = false;
				EventBus.emit('liftoff');
				break;
			case 'WATER_DELUGE':
			case 'ROFI_IGNITION':
			case 'PRESSURIZE_TANK':
				// Visual effects handled via states or specific systems in the future
				break;
		}
	}
}
