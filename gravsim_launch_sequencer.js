
// gravsim_launch_sequencer.js

import { PHYSICS, LAUNCH_SEQUENCES } from './gravsim_const.js';

export class LaunchSequencer {
	constructor(universe) {
		this.universe = universe;
		this.isActive = false;
		this.isAutoSequence = false;
		this.sequence = [];
		this.tMinusOffset = 0;
		this.timer = 0;
		this.rocketId = null;
		this.eventIndex = 0;
	}

	start(sequenceData, rocketId) {
		this.sequence = sequenceData.events || sequenceData;
		this.tMinusOffset = sequenceData.tMinusOffset || 0;
		this.rocketId = rocketId;
		this.isActive = true;
		this.isAutoSequence = false;
		this.eventIndex = 0;
		this.timer = 0; 

		const sysTab = this.universe.ControlPanel.systemTab;
		if (sysTab && sysTab.ui.timeScale) {
			const realTimeScaleVal = Math.log10(1 / PHYSICS.YEARS_PER_SECOND);
			sysTab.ui.timeScale.value = realTimeScaleVal;
			const realTimeScale = Math.pow(10, realTimeScaleVal);
			sysTab.updateTimeScaleIndicator(realTimeScale);
			this.universe.timeScale = realTimeScale;
			this.universe.CalcWorkerManager.setTimeScale(realTimeScale);
		}
		
		this.universe.emit('sequencer-start');
	}

	abort() {
		if (!this.isActive) { return; }
		this.isActive = false;
		this.isAutoSequence = false;
		this.universe.emit('sequencer-abort');
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

		this.universe.emit('sequencer-tick', { timeText, eventName: latestEventName });

		while (this.eventIndex < this.sequence.length && this.timer >= this.sequence[this.eventIndex].time) {
			const evt = this.sequence[this.eventIndex];
			this.executeCommand(evt.command, evt.name);
			this.eventIndex++;
		}

		if (this.eventIndex >= this.sequence.length && currentT > LAUNCH_SEQUENCES.LAUNCH_TO_COMPLETION_TIME) {
			// Turn off sequencer X seconds after liftoff
			this.isActive = false;
			this.isAutoSequence = false;
			this.universe.emit('sequencer-end');
		}
	}

	executeCommand(cmd, name) {
		if (name) {
			this.universe.emit('sequencer-event', name);
		}

		switch (cmd) {
			case 'START_COUNTDOWN':
				this.universe.ControlPanel.rocketTab.setRolloutState(true);
				break;
			case 'AUTO_SEQUENCE_START':
				this.isAutoSequence = true;
				this.universe.emit('auto-sequence-start');
				break;
			case 'IGNITE_ENGINE':
				// Ignite but keep holding down
				this.universe.ObjectManager.updateRocketState(this.rocketId, true, true);
				break;
			case 'RELEASE_HOLD_DOWN':
				// Release vehicle
				this.universe.ObjectManager.updateRocketState(this.rocketId, true, false);
				this.universe.ControlPanel.rocketTab.setRolloutState(false);
				this.isAutoSequence = false;
				this.universe.emit('liftoff');
				break;
			case 'IGNITE_AND_RELEASE':
				this.universe.ObjectManager.updateRocketState(this.rocketId, true, false);
				this.universe.ControlPanel.rocketTab.setRolloutState(false);
				this.universe.emit('liftoff');
				break;
			case 'WATER_DELUGE':
			case 'ROFI_IGNITION':
				break;
		}
	}
}
