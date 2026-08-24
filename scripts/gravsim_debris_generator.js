
// gravsim_debris_generator.js

import { DEBRIS } from './gravsim_const.js';
import { Debris } from './gravsim_object.js';
import { ColorUtils } from './gravsim_utils.js';

export class DebrisGenerator {
	// Generate debris from impact with another object
	static generateFromImpact(loserObj, totalDebrisMass, baseVx, baseVy, winnerX, winnerY, winnerRadiusPx, m2pixFunc, getNextIdFunc) {
		const result = { shockwave: null, debrisList: [] };
		
		result.shockwave = { x: loserObj.x, y: loserObj.y, color: loserObj.color };

		if (totalDebrisMass <= 0) { return result; }

		const fragmentCount = Math.max(DEBRIS.MIN_FRAG, Math.floor(Math.log10(totalDebrisMass) * 1.5));
		const baseMass = totalDebrisMass / fragmentCount;
		const debrisColor = ColorUtils.mixWithGray(loserObj.color, DEBRIS.GRAY_MIX_RATIO);

		let dx = loserObj.x - winnerX;
		let dy = loserObj.y - winnerY;
		let dist = Math.sqrt(dx * dx + dy * dy);
		if (dist === 0) { dx = 1; dy = 0; dist = 1; }
		const nx = dx / dist;
		const ny = dy / dist;
		const baseAngle = Math.atan2(ny, nx);

		result.debrisList = this._spawnParticles(
			loserObj, fragmentCount, baseMass, debrisColor, 1,
			baseVx, baseVy, winnerX, winnerY,
			DEBRIS.IMPACT_SCATTER_BASE, DEBRIS.IMPACT_SCATTER_VAR,
			{ nx, ny, baseAngle, winnerRadiusPx }, m2pixFunc, getNextIdFunc
		);

		return result;
	}

	// Generate debris from shattering by tidal force or dynamic pressure
	static generateFromShatter(obj, m2pixFunc, getNextIdFunc) {
		const result = { shockwave: null, debrisList: [] };
		
		result.shockwave = { x: obj.x, y: obj.y, color: obj.color };

		const nextGen = obj.generation + 1;
		const baseCount = Math.floor(Math.log10(obj.mass));
		const decay = Math.pow(DEBRIS.FRAG_DECAY_RATE, nextGen - 1);
		const fragmentCount = Math.max(DEBRIS.MIN_FRAG, Math.floor(baseCount / decay));
		const baseMass = obj.mass / fragmentCount;
		const debrisColor = ColorUtils.mixWithGray(obj.color, DEBRIS.GRAY_MIX_RATIO);

		result.debrisList = this._spawnParticles(
			obj, fragmentCount, baseMass, debrisColor, nextGen,
			obj.vx, obj.vy, obj.x, obj.y,
			DEBRIS.SHATTER_SCATTER_BASE, DEBRIS.SHATTER_SCATTER_VAR,
			null, m2pixFunc, getNextIdFunc
		);

		return result;
	}

	// Common logic for calculating parameters and instantiating fragments
	static _spawnParticles(sourceObj, fragmentCount, baseMass, debrisColor, nextGen,
		baseVx, baseVy, centerX, centerY, scatterBaseM, scatterVarM, impactData, m2pixFunc, getNextIdFunc) {
		
		const list = [];
		for (let i = 0; i < fragmentCount; i++) {
			const massVariation = DEBRIS.MASS_VAR_BASE + (Math.random() * DEBRIS.MASS_VAR_RANGE);
			const fragMass = baseMass * massVariation;
			const fragRadius = sourceObj.radius * Math.cbrt(fragMass / sourceObj.mass);

			let angle, fragX, fragY;
			if (impactData) {
				const marginPx = m2pixFunc(fragRadius * 2);
				const spawnRadiusPx = impactData.winnerRadiusPx + Math.max(marginPx, 2);
				const spreadAngle = (Math.random() - 0.5) * Math.PI;
				angle = impactData.baseAngle + spreadAngle;
				fragX = centerX + impactData.nx * spawnRadiusPx + Math.cos(angle) * (Math.random() * 5);
				fragY = centerY + impactData.ny * spawnRadiusPx + Math.sin(angle) * (Math.random() * 5);
			} else {
				const spreadPx = m2pixFunc(sourceObj.radius * 2);
				angle = (i / fragmentCount) * Math.PI * 2;
				fragX = centerX + Math.cos(angle) * spreadPx;
				fragY = centerY + Math.sin(angle) * spreadPx;
			}

			const scatterPx = m2pixFunc(scatterBaseM + (Math.random() * scatterVarM));
			const fragVx = baseVx + (Math.cos(angle) * scatterPx);
			const fragVy = baseVy + (Math.sin(angle) * scatterPx);

			const fragName = sourceObj.name.endsWith(' Debris') ? sourceObj.name : `${sourceObj.name} Debris`;

			const nextId = getNextIdFunc();
			const fragment = new Debris(
				nextId, fragName, fragX, fragY, fragVx, fragVy, fragMass, debrisColor, 
				Math.log10(fragRadius * 8) / 2.5, fragRadius, nextGen, null, 0
			);
			list.push(fragment);
		}
		return list;
	}
}
