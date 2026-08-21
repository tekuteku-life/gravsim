
// gravsim_utils.js

import { RENDER, PHYSICS } from './gravsim_const.js';

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
