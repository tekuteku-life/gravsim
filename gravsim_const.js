// gravsim_const.js

// Unit
export const METERS_PER_AU = 149597870700;			// 1 AU in meters
export const YEARS_PER_SECOND = 60*60*24*365.25;	// 1 year in seconds

// physical constant
export const G = 6.67430e-11;						// Gravitational constant (m^3 kg^-1 s^-2)
export const C = 2.99792458e8;						// speed of light (m/s)
export const G0 = 9.80665;							// gravitational acceleration of the Earth (m/s^2)

// Roche limit physical thresholds
export const ROCHE_MIN_MASS_TO_DESTROY = 1e15;		// ton: Minimum mass required to tear another object apart
export const ROCHE_UNBREAKABLE_DENSITY = 1e10;		// ton/m^3: Objects with density higher than this cannot be destroyed (e.g., Black holes)
export const ROCHE_RIGID_BODY_RADIUS = 10000;		// m: Objects smaller than this radius are considered rigid bodies
export const ROCHE_RIGID_DESTROYER_MASS = 1e25;		// ton: Minimum mass required to tear apart rigid bodies (e.g., Stars, Black holes)

// UI setting
export const UI_DOUBLE_TAP_DURATION = 400;			// Duration which double tap detected

export const UI_NAVI_UPDATE_UPDATE_INTERVAL = 500;	// Update interval for Navi tab (ms)

export const UI_TM_MAX_Q_TH = 80;					// Max-Q message indication threshold (%)

// Program setting
export const TIME_SCALE = 1e3;
export const THROW_SCALE = 4e16;

export const REMOVE_DISTANCE_AU = 120;

export const TARGET_TRAIL_LENGTH_AU = 3;			// Trail length (AU)
export const HISTORY_LENGTH = 512;					// History length
export const DISTANCE_SCALE = 180;					// AU/px

export const DEBRIS_MIN_FRAG = 3;					// The min number of fragment
export const DEBRIS_GRAY_MIX_RATIO = 0.6;			// gray blending ratio of becoming debris (0.0=original, 1.0=gray)
export const DEBRIS_SHOCKWAVE_TIME = 800;			// Duration of shock-wave when debris generated
export const DEBRIS_SHOCKWAVE_RADIUS = 100;			// Max radius of shock-wave
export const DEBRIS_MAX_GENERATION = 3;				// Max generation of shattering
export const DEBRIS_MIN_MASS_TO_SHATTER = 1e21;		// minimum mass to shatter (kg) (Earth / 6)
export const DEBRIS_FRAG_DECAY_RATE = 4;			// Decrease ratio per generation
export const DEBRIS_IMPACT_SCATTER_BASE = 2000;		// Impact scatter base (m/s)
export const DEBRIS_IMPACT_SCATTER_VAR = 3000;		// Impact scatter variation (m/s)
export const DEBRIS_SHATTER_SCATTER_BASE = 1000;	// Shatter scatter base (m/s)
export const DEBRIS_SHATTER_SCATTER_VAR = 2000;		// Shatter scatter variation (m/s)
export const DEBRIS_MASS_VAR_BASE = 0.8;			// Debris's mass variation base
export const DEBRIS_MASS_VAR_RANGE = 0.4;			// Debris's mass variation range

export const SCALE_BAR_WIDTH = 150;					// scale bar width (px)
export const SCALE_BAR_LINE_WIDTH = 2;				// scale bar line width (px)
export const SCALE_BAR_RIGHT = 20;					// position from right-side (px)
export const SCALE_BAR_BOTTOM = 20;					// position from bottom (px)

export const CALC_EXPAND_DIV_NUM = 20;				// The number of division for expanding collision detection
export const CALC_SUB_STEPS_BASE = 600;				// Base sub-step
export const CALC_SUB_STEPS_MAX = 480;				// Max sub-step

export const SPARKLE_ANIM_SPEED = 80;				// Sparkle blinking speed
export const SPARKLE_ROTATE_SPEED = 500;			// Sparkle rotate speed
export const SPARKLE_STAR_SIZE_RATIO = 3.0;			// Sparkle star size ration (based on object's radius)
export const SPARKLE_STAR_INNER_SIZE_RATIO = 0.4;	// Sparkle star inner-size ration (based on object's radius)

export const TELEMETRY_UPDATE_INTERVAL_MS = 100;	// Telemetry update interval（ms）
export const TELEMETRY_SUB_VIEW_TARGET_RADIUS = 20;	// Target radius on sub-screen（px）
export const TELEMETRY_SUB_VIEW_MAX_ZOOM = 1e8;		// Max zoom-level on sub-screen

// constant definition
export const OBJECT_STATE = {
	"ACTIVE": 0,
	"REMOVED": 1,
	"HISTORY_DONE": 2,
};

// Object parameter
// mass: [ton]
// radius: [m]
// A: semi-major axis
// E: orbital eccentricity
// PERIHELION_DEG: Longitude of Perihelion degree
export const DEFAULT_OBJECT_PARAMS = {
	"SgrAStar": {
		"NAME" : "Sagittarius A*",
		"MASS" : 1.9891e30 * 4.31e6 / 1e3, // 4.31 million times of the sun
		"COLOR" : "#000000",
		"RADIUS": 1.27e10,
		"BORDER_COLOR": "#FF4500",
		"BORDER_WIDTH": 0.1,
	},
	"BlackHole": {
		"NAME" : "BlackHole",
		"MASS" : 1.9891e30 *20 / 1e3, // 20 times of the sun
		"COLOR" : "#333333",
		"RADIUS": 3e4,
		"BORDER_COLOR": "#FF8C00",
		"BORDER_WIDTH": 0.3,
	},
	"Sun": {
		"NAME" : "Sun",
		"MASS" : 1.9891e30 / 1e3,
		"COLOR": "#FF4500",
		"RADIUS": 6.96340e8,
	},
	"Mercury": {
		"NAME" : "Mercury",
		"MASS" : 3.3011e23 / 1e3,
		"COLOR": "#B8860B",
		"RADIUS": 2.4397e6,
		"A": 0.387,
		"E": 0.2056,
		"PERIHELION_DEG": 77.46,
	},
	"Venus": {
		"NAME" : "Venus",
		"MASS" : 4.867e24 / 1e3,
		"COLOR": "#FFD700",
		"RADIUS": 6.0518e6,
		"A": 0.723,
		"E": 0.0067,
		"PERIHELION_DEG": 131.53,
		"ATM_COLOR": "rgba(255, 200, 100, 0.6)",
		"ATM_LIMIT_ALT": 250000,
		"ATM_DENSITY_0": 65,
		"ATM_SCALE_HEIGHT": 15900,
		"ROTATION_PERIOD": 20996800
	},
	"Earth": {
		"NAME" : "Earth",
		"MASS" : 5.972e24 / 1e3,
		"COLOR": "#1E90FF",
		"RADIUS": 6.378e6,
		"A": 1.000,
		"E": 0.0167,
		"PERIHELION_DEG": 102.95,
		"ATM_COLOR": "rgba(100, 150, 255, 0.5)",
		"ATM_LIMIT_ALT": 100000,
		"ATM_DENSITY_0": 1.225,
		"ATM_SCALE_HEIGHT": 8500,
		"ROTATION_PERIOD": 86164
	},
	"Mars": {
		"NAME" : "Mars",
		"MASS" : 6.4171e23 / 1e3,
		"COLOR": "#FF6347",
		"RADIUS": 3.3895e6,
		"A": 1.524,
		"E": 0.0934,
		"PERIHELION_DEG": 336.04,
		"ATM_COLOR": "rgba(255, 140, 0, 0.4)",
		"ATM_LIMIT_ALT": 50000,
		"ATM_DENSITY_0": 0.02,
		"ATM_SCALE_HEIGHT": 11100,
		"ROTATION_PERIOD": 88642
	},
	"Jupiter": {
		"NAME" : "Jupiter",
		"MASS" : 1.898e27 / 1e3,
		"COLOR": "#FF8C00",
		"RADIUS": 6.9911e7,
		"A": 5.204,
		"E": 0.0489,
		"PERIHELION_DEG": 14.75,
		"ATM_COLOR": "rgba(200, 180, 150, 0.4)",
		"ATM_LIMIT_ALT": 3000000,
		"ATM_DENSITY_0": 0.16,
		"ATM_SCALE_HEIGHT": 27000,
		"ROTATION_PERIOD": 35730
	},
	"Saturn": {
		"NAME" : "Saturn",
		"MASS" : 5.6834e26 / 1e3,
		"COLOR": "#FFD700",
		"RADIUS": 5.8232e7,
		"A": 9.582,
		"E": 0.0565,
		"PERIHELION_DEG": 92.43,
	},
	"Uranus": {
		"NAME" : "Uranus",
		"MASS" : 8.6810e25 / 1e3,
		"COLOR": "#AFEEEE",
		"RADIUS": 2.5362e7,
		"A": 19.191,
		"E": 0.0457,
		"PERIHELION_DEG": 170.96,
	},
	"Neptune": {
		"NAME" : "Neptune",
		"MASS" : 1.02413e26 / 1e3,
		"COLOR": "#4169E1",
		"RADIUS": 2.4622e7,
		"A": 30.070,
		"E": 0.0113,
		"PERIHELION_DEG": 44.97,
	},
	"Moon": {
		"NAME" : "Moon",
		"MASS" : 7.34767309e22 / 1e3,
		"COLOR": "#C0C0C0",
		"RADIUS": 1.7374e6,
		"A": 0.00257,
		"E": 0.0549,
		"PERIHELION_DEG": 0,
	},
	"Asteroid": {
		"NAME" : "Asteroid",
		"MASS" : 1e10 / 1e3,
		"COLOR": "#808080",
		"RADIUS": 90,
	},
	"Rocket": {
		"NAME" : "Rocket",
		"MASS" : 5.75e4 / 1e3,
		"COLOR": "#32CD32",
		"RADIUS": 63,
		"MIN_DRAW_SIZE": 2,
		"AERO_AREA_FRONT": 10,
		"AERO_AREA_SIDE": 126,
		"DRAG_COEF": 0.2,
		"MAX_DYNAMIC_PRESSURE": 50000
	},
};

export const ROCKET_FUELS = {
	"solid": { name: "Solid", isp: 250, density: 1.8 },
	"liquid": { name: "Liquid", isp: 320, density: 1.0 },
	"hydro": { name: "Cryogenic", isp: 450, density: 0.3 },
	"ion": { name: "Ion", isp: 3000, density: 0.5 }
};

export const MISSION_STATUS = {
	PRE_LAUNCH: "PRE-LAUNCH",
	LIFTOFF: "LIFTOFF",
	ASCENT: "ASCENT",
	MAX_Q: "MAX-Q",
	MECO: "MECO",
	COASTING: "COASTING",
	TRACKING: "TRACKING"
};
