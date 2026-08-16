
// gravsim_utils.js

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
	// Normalize angle
	normalizeAngle(radians) {
		let angle = radians;
		while (angle > Math.PI) angle -= 2 * Math.PI;
		while (angle < -Math.PI) angle += 2 * Math.PI;
		return angle;
	}
};

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
		const t = this.parseSeconds(totalSec);
		const pad = (n, len = 2) => String(n).padStart(len, '0');
		return `T+ ${pad(t.years, 3)}y ${pad(t.days, 3)}d ${pad(t.hours)}:${pad(t.minutes)}:${pad(t.seconds)}`;
	}

	// Format number with fixed fraction digits and left padding
	static numFixPad(val, fractionDigits, totalLength) {
		if (val === undefined || val === null || isNaN(val)) {
			return "---".padStart(totalLength, ' ');
		}
		return Number(val).toFixed(fractionDigits).padStart(totalLength, ' ');
	}
}
