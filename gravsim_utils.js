
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
