
// gravsim_destruction_manager.js

import { EventBus } from './gravsim_event_bus.js';
import { DebrisGenerator } from './gravsim_debris_generator.js';
import { UnitConvertUtils } from './gravsim_utils.js';

/*******************************************************************
 * DestructionManager Class
 * Handles domain logic for object destruction (impact, shattered).
 *******************************************************************/
export class DestructionManager {
	constructor(universe) {
		this.universe = universe;
		this._bindEvents();
	}

	_bindEvents() {
		EventBus.on('object:impacted', (target, objData) => this._handleImpact(target, objData));
		EventBus.on('object:shattered', (target) => this._handleShattered(target));
	}

	_handleImpact(target, objData) {
		// Generate debris and effects via DebrisGenerator
		const debrisData = DebrisGenerator.generateFromImpact(
			target,
			UnitConvertUtils.kg2ton(objData.debrisMass),
			UnitConvertUtils.m2pix(objData.impactVx),
			UnitConvertUtils.m2pix(objData.impactVy),
			UnitConvertUtils.m2pix(objData.impactWinnerX),
			UnitConvertUtils.m2pix(objData.impactWinnerY),
			UnitConvertUtils.m2pix(objData.impactWinnerRadius),
			UnitConvertUtils.m2pix,
			() => this.universe.ObjectManager.getNextId()
		);

		this._processDebrisData(debrisData);
	}

	_handleShattered(target) {
		// Generate debris and effects via DebrisGenerator
		const debrisData = DebrisGenerator.generateFromShatter(
			target,
			UnitConvertUtils.m2pix,
			() => this.universe.ObjectManager.getNextId()
		);

		this._processDebrisData(debrisData);
	}

	_processDebrisData(debrisData) {
		// Emit shockwave event to VisualEffectManager
		if (debrisData.shockwave) {
			EventBus.emit(
				'effect:shockwave',
				debrisData.shockwave.x,
				debrisData.shockwave.y,
				debrisData.shockwave.color
			);
		}

		// Add generated debris to the universe
		if (debrisData.debrisList) {
			debrisData.debrisList.forEach(debris => this.universe.addObject(debris));
		}
	}
}
