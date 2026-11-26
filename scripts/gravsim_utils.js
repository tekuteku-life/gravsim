
// gravsim_utils.js

import { RENDER, PHYSICS, MULTISTAGE_ROCKET, AERO_DYNAMIC, TELEMETRY, OBJECT_STATE } from './gravsim_const.js';

/*******************************************************************
 * DOM Utility class for Dirty Checking (Differential Update)
 *******************************************************************/
export class DOMUtils {
	// Update DOM text only if changed
	static setText(element, text) {
		if (!element) return;
		if (element._cachedText !== text) {
			element.textContent = text;
			element._cachedText = text;
		}
	}

	// Update DOM style only if changed
	static setStyle(element, prop, value) {
		if (!element) return;
		if (!element._cachedStyle) {
			element._cachedStyle = {};
		}
		if (element._cachedStyle[prop] !== value) {
			element.style[prop] = value;
			element._cachedStyle[prop] = value;
		}
	}

	// Verify if all elements in the given UI object exist
	static verifyElements(uiObject, panelName) {
		for (const [key, element] of Object.entries(uiObject)) {
			if (!element) {
				console.error(`[${panelName}] DOM element missing: ${key}`);
			}
		}
	}
}

/*******************************************************************
 * Color Utility class
 *******************************************************************/
export const ColorUtils = {
	// Translate hex to RGBA
	hexToRgba(hex, alpha) {
		let c = hex.replace('#', '');
		if (c.length === 3) c = c.split('').map(x => x + x).join('');
		const num = parseInt(c, 16);
		const r = (num >> 16) & 255;
		const g = (num >> 8) & 255;
		const b = num & 255;
		return `rgba(${r},${g},${b},${alpha})`;
	},

	// Mixing hex with gray
	mixWithGray(hexColor, grayRatio) {
		let c = hexColor.replace('#', '');
		if (c.length === 3) c = c.split('').map(x => x + x).join('');
		const num = parseInt(c, 16);
		const r = (num >> 16) & 255;
		const g = (num >> 8) & 255;
		const b = num & 255;

		const gray = 128; // #808080
		const mixR = Math.round(r * (1 - grayRatio) + gray * grayRatio);
		const mixG = Math.round(g * (1 - grayRatio) + gray * grayRatio);
		const mixB = Math.round(b * (1 - grayRatio) + gray * grayRatio);

		return '#' + ((1 << 24) + (mixR << 16) + (mixG << 8) + mixB).toString(16).padStart(6, '0').toUpperCase();
	}
};

/*******************************************************************
 * Math Utility class
 *******************************************************************/
export const MathUtils = {
	// Normalize angle (-PI to PI)
	normalizeAngle(radians) {
		let angle = radians;
		while (angle > Math.PI) angle -= 2 * Math.PI;
		while (angle < -Math.PI) angle += 2 * Math.PI;
		return angle;
	},

	// Normalize angle (0 to 360 degrees)
	normalizeAngle360(degrees) {
		let angle = degrees % 360;
		if (angle < 0) { angle += 360; }
		return angle;
	}
};

/*******************************************************************
 * Unit Convert Utility class for text and numbers
 *******************************************************************/
export class UnitConvertUtils {
	// Screen(Pixel) <=> Astronomical Unit
	static pix2au(px) { return px / RENDER.DISTANCE_SCALE; }
	static au2pix(au) { return au * RENDER.DISTANCE_SCALE; }

	// Screen(Pixel) <=> Meters
	static m2pix(m) { return UnitConvertUtils.au2pix(m / PHYSICS.METERS_PER_AU); }
	static pix2m(px) { return PHYSICS.METERS_PER_AU * (UnitConvertUtils.pix2au(px)); }

	// Angle (Degrees <=> Radians)
	static deg2rad(deg) { return deg * (Math.PI / 180); }
	static rad2deg(rad) { return rad * (180 / Math.PI); }

	// Mass (Tons <=> Kilograms)
	static ton2kg(ton) { return ton * 1000; }
	static kg2ton(kg) { return kg / 1000; }

	// Distance / Velocity (Meters <=> Kilometers)
	static m2km(m) { return m / 1000; }
	static km2m(km) { return km * 1000; }
	static m2au(m) { return m / PHYSICS.METERS_PER_AU; }
	static au2m(au) { return au * PHYSICS.METERS_PER_AU; }

	// Time (Years <=> Seconds)
	static year2sec(year) { return year * PHYSICS.YEARS_PER_SECOND; }
	static sec2year(sec) { return sec / PHYSICS.YEARS_PER_SECOND; }

	// Force (Kilo-Newtons <=> Newtons)
	static kn2n(kn) { return kn * 1000; }
	static n2kn(n) { return n / 1000; }

	// Pressure (Pascals <=> Kilo-Pascals)
	static pa2kpa(pa) { return pa / 1000; }
	static kpa2pa(kpa) { return kpa * 1000; }
}

/*******************************************************************
 * Format Utility class for text and numbers
 *******************************************************************/
export class FormatUtils {
	// Parse total seconds into time components
	static parseSeconds(totalSec) {
		const sec = Math.floor(totalSec || 0);
		const SEC_PER_DAY = 86400;
		const SEC_PER_YEAR = 31557600; // 365.25 * 86400

		const years = Math.floor(sec / SEC_PER_YEAR);
		let rem = sec % SEC_PER_YEAR;

		const days = Math.floor(rem / SEC_PER_DAY);
		rem %= SEC_PER_DAY;

		const hours = Math.floor(rem / 3600);
		rem %= 3600;

		const minutes = Math.floor(rem / 60);
		const seconds = rem % 60;

		return { years, days, hours, minutes, seconds };
	}

	// Format elapsed years to "Y yr, DDD d"
	static timeYearsDays(totalYears) {
		const totalSec = totalYears * 31557600; // Convert years back to seconds for unified parsing
		const t = this.parseSeconds(totalSec);
		return `${t.years} yr, ${String(t.days).padStart(3, '0')} d`;
	}

	// Format total seconds to "T+ YYYy DDDd HH:MM:SS"
	static timeMission(totalSec) {
		const sign = totalSec < 0 ? '-' : '+';
		const t = this.parseSeconds(Math.abs(totalSec));
		const pad = (n, len = 2) => String(n).padStart(len, '0');
		return `T${sign} ${pad(t.years, 3)}y ${pad(t.days, 3)}d ${pad(t.hours)}:${pad(t.minutes)}:${pad(t.seconds)}`;
	}

	// Format number with fixed fraction digits and left padding
	static numFixPad(val, fractionDigits, totalLength) {
		if (val === undefined || val === null || isNaN(val)) {
			return "---".padStart(totalLength, ' ');
		}
		return Number(val).toFixed(fractionDigits).padStart(totalLength, ' ');
	}
}

/**
 * The mission status (a TELEMETRY.STATUS value) a telemetry value stands for. A value that is not one of the status
 * numbers (none the FlightComputer reports: undefined, NaN, a fraction, out of range, a string such as "1") is
 * PRE_LAUNCH, the FlightComputer's initial status; -0 is the LIFTOFF code 0. Every reader of a mission status on the
 * main thread goes through it (the telemetry panel, the flight events of the prediction, the sound rules and the MECO
 * detection of the Worker sync, design §4.13-21 / -25), so they agree on such a value. A status code is returned as is.
 * @param {any} status
 * @returns {number}
 */
export function normalizeMissionStatus(status) {
	return Object.values(TELEMETRY.STATUS).find((code) => code === status) ?? TELEMETRY.STATUS.PRE_LAUNCH;
}

/**
 * Whether a main-thread object is still in the simulation: state ACTIVE and not destroyed (the "flying" rule of design
 * §4.13-23(a); only a rocket has isDestroyed). An object that is removed (System › Clear Selected, abort, escape,
 * Reset, load) or destroyed (a collision, a shatter) stays in universe.objects as REMOVED until its trail has faded:
 * it is drawn while it fades, but nothing may select, save, count, host, forward or revive it (design §4.13-31).
 * A plain record without a state (not a GravSimObject) counts as in the simulation, as ObjectPlacer's lookups take it.
 * @param {any} obj
 * @returns {boolean}
 */
export function isLiveObject(obj) {
	return Boolean(obj) && (obj.state === OBJECT_STATE.ACTIVE || obj.state === undefined) && !obj.isDestroyed;
}

/**
 * Normalizes any rocket config (legacy single-stage or new multi-stage)
 * into a valid multi-stage configuration structure.
 */
export function normalizeRocketConfig(config) {
	if (!config) {
		return null;
	}

	if (config.stages && Array.isArray(config.stages) && config.stages.length > 0) {
		return {
			...config,
			colorTheme: config.colorTheme || 'orange',
			stages: config.stages.map((stg, idx) => ({
				stageNumber: stg.stageNumber || (idx + 1),
				name: stg.name || `Stage ${idx + 1}`,
				fuelType: stg.fuelType || 'liquid',
				thrustKN: stg.thrustKN !== undefined ? stg.thrustKN : 7600,
				ispVac: stg.ispVac !== undefined ? stg.ispVac : stg.isp,
				ispSl: stg.ispSl !== undefined ? stg.ispSl : undefined,
				isp: stg.isp !== undefined ? stg.isp : stg.ispVac,
				dryMassT: stg.dryMassT !== undefined ? stg.dryMassT : 7,
				fuelMassT: stg.fuelMassT !== undefined ? stg.fuelMassT : 88,
				oxidMassT: stg.oxidMassT !== undefined ? stg.oxidMassT : 220,
				burnTime: stg.burnTime !== undefined ? stg.burnTime : 160,
				ofRatio: stg.ofRatio !== undefined ? stg.ofRatio : 2.5,
				radius: stg.radius !== undefined ? stg.radius : 2.5,
				separationDelaySec: stg.separationDelaySec !== undefined ? stg.separationDelaySec : MULTISTAGE_ROCKET.DEFAULT_SEPARATION_DELAY_SEC,
				ignitionDelaySec: stg.ignitionDelaySec !== undefined ? stg.ignitionDelaySec : MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC,
				jettisonSpeedM_S: stg.jettisonSpeedM_S !== undefined ? stg.jettisonSpeedM_S : MULTISTAGE_ROCKET.DEFAULT_JETTISON_SPEED_M_S,
			})),
			payload: config.payload || { name: 'Payload', massT: 0, radius: 1.0 },
			fairing: config.fairing || { enabled: false, massT: 0, separationAltKm: MULTISTAGE_ROCKET.FAIRING_DEFAULT_ALT_KM },
			boosters: config.boosters ? JSON.parse(JSON.stringify(config.boosters)) : null
		};
	}

	// Convert legacy single-stage config to 1-stage multistage config
	const dryMassT = config.dryMassT !== undefined ? config.dryMassT : (config.emptyMass !== undefined ? config.emptyMass : 7);
	const fuelMassT = config.fuelMassT !== undefined ? config.fuelMassT : (config.fuelMass !== undefined ? config.fuelMass : 88);
	const oxidMassT = config.oxidMassT !== undefined ? config.oxidMassT : (config.oxidMass !== undefined ? config.oxidMass : 220);
	const thrustKN = config.thrustKN !== undefined ? config.thrustKN : (config.thrustForce ? config.thrustForce / 1000 : 7600);
	const burnTime = config.burnTime !== undefined ? config.burnTime : (config.time !== undefined ? config.time : 160);
	const ofRatio = config.ofRatio !== undefined ? config.ofRatio : 2.5;

	return {
		...config,
		colorTheme: config.colorTheme || 'orange',
		stages: [
			{
				stageNumber: 1,
				name: 'Core Stage',
				fuelType: config.fuelType || 'liquid',
				thrustKN: thrustKN,
				ispVac: config.ispVac !== undefined ? config.ispVac : config.isp,
				ispSl: config.ispSl !== undefined ? config.ispSl : undefined,
				isp: config.isp !== undefined ? config.isp : config.ispVac,
				dryMassT: dryMassT,
				fuelMassT: fuelMassT,
				oxidMassT: oxidMassT,
				burnTime: burnTime,
				ofRatio: ofRatio,
				radius: config.radius || 2.5,
				separationDelaySec: MULTISTAGE_ROCKET.DEFAULT_SEPARATION_DELAY_SEC,
				ignitionDelaySec: MULTISTAGE_ROCKET.DEFAULT_IGNITION_DELAY_SEC,
				jettisonSpeedM_S: MULTISTAGE_ROCKET.DEFAULT_JETTISON_SPEED_M_S
			}
		],
		payload: config.payload || { name: 'Payload', massT: 0, radius: 1.0 },
		fairing: config.fairing || { enabled: false, massT: 0, separationAltKm: MULTISTAGE_ROCKET.FAIRING_DEFAULT_ALT_KM }
	};
}

/**
 * Shared Aerodynamics & Transonic Flow Utilities (Speed of Sound, Mach, Vapor Cone)
 */
export class AeroUtils {
	static getAtmosphericTemperatureK(altM, atmParam) {
		if (!Number.isFinite(altM) || !atmParam) return 0;
		const density0 = Number(atmParam.ATM_DENSITY_0 ?? atmParam.atmDensity0 ?? 0);
		const scaleH = Number(atmParam.ATM_SCALE_HEIGHT ?? atmParam.atmScaleHeight ?? 0);
		const limitAlt = Number(atmParam.ATM_LIMIT_ALT ?? atmParam.atmLimitAlt ?? 0);
		if (!(density0 > 0 && scaleH > 0) || (limitAlt > 0 && altM > limitAlt)) return 0;

		const clAlt = Math.max(0, altM);
		const scaleRatio = scaleH / 8500;
		const tropopauseM = 11000 * scaleRatio;
		const rawT = (clAlt <= tropopauseM)
			? (288.15 - (0.0065 / scaleRatio) * clAlt)
			: (216.65 + 0.001 * ((clAlt - tropopauseM) / scaleRatio));
		return Math.max(180, Math.min(350, rawT));
	}

	static getSpeedOfSound(altM, atmParam) {
		const tempK = AeroUtils.getAtmosphericTemperatureK(altM, atmParam);
		if (!(tempK > 0)) return 0;
		return Math.sqrt(1.4 * 287.05 * tempK);
	}

	static computeMach(airSpeedMS, altM, atmParam) {
		if (!Number.isFinite(airSpeedMS) || airSpeedMS <= 0) return 0;
		const a = AeroUtils.getSpeedOfSound(altM, atmParam);
		return a > 0 ? (airSpeedMS / a) : 0;
	}

	static computeVaporConeParams(mach, ambientPresRatio) {
		if (
			!Number.isFinite(mach) ||
			!Number.isFinite(ambientPresRatio) ||
			mach < AERO_DYNAMIC.TRANSONIC_MACH_MIN ||
			mach > AERO_DYNAMIC.TRANSONIC_MACH_MAX ||
			ambientPresRatio <= AERO_DYNAMIC.TRANSONIC_MIN_PRES_RATIO
		) {
			return { active: false, intensity: 0, machAngleRad: Math.PI / 2 };
		}
		// Asymmetric smoothstep bell: 0 at TRANSONIC_MACH_MIN / TRANSONIC_MACH_MAX, 1 at TRANSONIC_PEAK_MACH
		const peak = AERO_DYNAMIC.TRANSONIC_PEAK_MACH;
		const span = (mach <= peak)
			? (peak - AERO_DYNAMIC.TRANSONIC_MACH_MIN)
			: (AERO_DYNAMIC.TRANSONIC_MACH_MAX - peak);
		const u = Math.max(0, 1 - Math.abs(mach - peak) / Math.max(0.01, span));
		const machFactor = u * u * (3 - 2 * u);
		const presFactor = Math.min(1, Math.max(0, (ambientPresRatio - AERO_DYNAMIC.TRANSONIC_MIN_PRES_RATIO) / 0.25));
		const intensity = machFactor * presFactor;
		const machAngleRad = Math.asin(Math.min(0.96, 1 / Math.max(1 / 0.96, mach)));
		return {
			active: intensity > 0.01,
			intensity,
			machAngleRad
		};
	}
}

/** Largest SRB count the rules accept: the most strap-ons a real vehicle has flown (Delta II, 9). */
const MAX_BOOSTER_COUNT = 9;

/**
 * Stack state and SRB rules of a rocket. The renderer (both levels of detail), the smoke emission, the HUD (card,
 * stage label, annunciator), the Worker's CalcRocket and the propellant sizing use these single rules
 * (design 2026-11-23 §3.1).
 */
export class RocketStackUtils {
	/**
	 * Stack state of a rocket. The HUD passes the telemetry it shows; everything else uses the rocket's own.
	 * The stage index is normalised by normalizeStageIndex, the rule of the save / restore paths (null / NaN read as
	 * the first stage, as the HUD always did). Out of the payload phase the current stage is one of the vehicle's
	 * stages: an index at or past the stage count (a disableStaging vehicle or an object without stages, whose index
	 * never makes the payload phase) reads as the last stage, so that both levels of detail and the HUD fly the same
	 * stage.
	 * @param {any} rocket
	 * @param {any} [telemetry]
	 * @returns {{ curStgIdx: number, totalStg: number, isPayloadOnly: boolean, hasFairing: boolean }}
	 */
	static resolveStackState(rocket, telemetry = rocket?.telemetry) {
		const totalStg = telemetry?.totalStages || rocket?.stages?.length || 1;
		const stageIndex = RocketStackUtils.normalizeStageIndex(
			telemetry?.stageIndex !== undefined ? telemetry.stageIndex : rocket?.currentStageIndex, totalStg
		);
		const isPayloadOnly = !rocket?.disableStaging && Boolean(
			rocket?.isPayloadSeparated || telemetry?.isPayloadSeparated || (rocket?.stages && stageIndex >= totalStg)
		);
		const curStgIdx = isPayloadOnly ? stageIndex : Math.min(stageIndex, totalStg - 1);
		const hasFairing = Boolean(
			rocket?.disableStaging || (rocket?.fairing?.enabled && !telemetry?.isFairingSeparated && !rocket?.fairing?.isSeparated)
		);
		return { curStgIdx, totalStg, isPayloadOnly, hasFairing };
	}

	/**
	 * Stage index of a rocket from a save file, a Worker restore or the telemetry: a whole number from 0 to the stage
	 * count (the count is the payload phase, one past the last stage). A value that is not a number reads as 0, a
	 * fraction is rounded down, and the result is clamped. A disableStaging vehicle never separates, so it never
	 * reaches the payload phase: at most its last stage. The main-thread load (ObjectManager.loadState), the Worker
	 * restore (CalcRocket), Rocket.mass and resolveStackState use this one rule (design 2026-11-23 §3.1).
	 * @param {any} value
	 * @param {number} stageCount
	 * @param {boolean} [disableStaging]
	 * @returns {number}
	 */
	static normalizeStageIndex(value, stageCount, disableStaging = false) {
		const index = Math.floor(Number(value) || 0);
		const last = disableStaging ? stageCount - 1 : stageCount;
		return Math.max(0, Math.min(index, last));
	}

	/**
	 * The SRB configuration of a main-thread rocket object: its `boosters`, the configuration ObjectManager sends to
	 * the Worker (the launcher and the preset application merge `rendering.boosters` into it).
	 * @param {any} rocket
	 * @returns {any}
	 */
	static resolveBoosters(rocket) {
		return rocket?.boosters || null;
	}

	/**
	 * SRB count of a configuration, an integer from 0 to MAX_BOOSTER_COUNT: its count (rounded down, capped) when it is a
	 * finite number of at least 1, else 2 for a configuration with a finite positive burn time (the count the Worker's
	 * separation has always used), else 0. The cap keeps an absurd count from a preset or an edited save from hanging
	 * the loops over the SRBs. Values that are not finite are invalid: the Worker receives the configuration as a JSON
	 * copy, where they become null, so treating them as missing keeps the drawing, the HUD and the physics on the same
	 * count (design 2026-11-23 §3.1, the user's decision 2026-11-24).
	 * @param {any} boosters
	 * @returns {number}
	 */
	static boosterCount(boosters) {
		if (!boosters) return 0;
		const count = Number(boosters.count);
		if (Number.isFinite(count) && count >= 1) return Math.min(MAX_BOOSTER_COUNT, Math.floor(count));
		const burnTimeSec = Number(boosters.burnTimeSec);
		return (Number.isFinite(burnTimeSec) && burnTimeSec > 0) ? 2 : 0;
	}
}
