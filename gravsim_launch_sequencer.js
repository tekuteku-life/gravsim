
// gravsim_launch_sequencer.js

export class LaunchSequencer {
	constructor(universe) {
		this.universe = universe;
		this.isActive = false;
		this.sequence = [];
		this.timer = 0;
		this.rocketId = null;
		this.eventIndex = 0;
	}

	start(sequence, rocketId) {
		this.sequence = sequence;
		this.rocketId = rocketId;
		this.isActive = true;
		this.eventIndex = 0;
		if (this.sequence.length > 0) {
			this.timer = this.sequence[0].time;
		}
	}

	update(dtSec) {
		if (!this.isActive) return;

		this.timer += dtSec;

		while (this.eventIndex < this.sequence.length && this.timer >= this.sequence[this.eventIndex].time) {
			const evt = this.sequence[this.eventIndex];
			this.executeCommand(evt.command);
			this.eventIndex++;
		}

		if (this.eventIndex >= this.sequence.length) {
			this.isActive = false;
		}
	}

	executeCommand(cmd) {
		switch (cmd) {
			case 'IGNITE_AND_RELEASE':
				this.universe.ObjectManager.updateRocketState(this.rocketId, true, false);
				this.universe.ControlPanel.rocketTab.setRolloutState(false);
				break;
		}
	}
}
