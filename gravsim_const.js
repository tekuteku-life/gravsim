
// gravsim_const.js

// Physics unit / constant
export const PHYSICS = {
	METERS_PER_AU: 149597870700,
	YEARS_PER_SECOND: 60 * 60 * 24 * 365.25,
	G: 6.67430e-11,
	C: 2.99792458e8,
	G0: 9.80665
};

// Simulation base
export const SIMULATION = {
	TIME_SCALE: 1e3,
	THROW_SCALE: 4e16,
	SLINGSHOT_POWER: 500, // (m/s/px)
	REMOVE_DISTANCE_AU: 120,
	CALC_INTERVAL: 60,
	CALC_EXPAND_DIV_NUM: 20,
	CALC_SUB_STEPS_BASE: 600,
	CALC_SUB_STEPS_MAX: 480
};

// Shattering / Roche limit
export const ROCHE_LIMIT = {
	MIN_MASS_TO_DESTROY: 1e15,
	UNBREAKABLE_DENSITY: 1e10,
	RIGID_BODY_RADIUS: 10000,
	RIGID_DESTROYER_MASS: 1e25
};

// Aero Dynamics
export const AERO_DYNAMIC = {
	DEFAULT_CD: 0.47,
};

// Debris generation
export const DEBRIS = {
	MIN_FRAG: 3,
	GRAY_MIX_RATIO: 0.6,
	SHOCKWAVE_TIME: 800,
	SHOCKWAVE_RADIUS: 100,
	MAX_GENERATION: 3,
	MIN_MASS_TO_SHATTER: 1e21,
	FRAG_DECAY_RATE: 4,
	IMPACT_SCATTER_BASE: 2000,
	IMPACT_SCATTER_VAR: 3000,
	SHATTER_SCATTER_BASE: 1000,
	SHATTER_SCATTER_VAR: 2000,
	MASS_VAR_BASE: 0.8,
	MASS_VAR_RANGE: 0.4
};

// Drawing / Visualization
export const RENDER = {
	DISTANCE_SCALE: 180,
	TRAIL_HISTORY_LENGTH: 1500,
	SCALE_BAR: {
		WIDTH: 150,
		LINE_WIDTH: 2,
		RIGHT: 20,
		BOTTOM: 20,
		COLOR: "rgba(255, 255, 255, 0.9)",
		VERTICAL_LINE_WIDTH: 5,
	},
	SCALE_BAR_TEXT: {
		COLOR: "rgba(255, 255, 255, 0.9)",
		FONT_FAMILY: "12px sans-serif",
		ALIGN: "right",
		BASE_LINE: "bottom",
		BOTTOM_OFFSET: 8,
	},
	TRAJECTORY: {
		ALPHA_BASE: 0.2,
		ALPHA_RATE: 0.4,
		TAPER_BASE: 0.2,
		TAPER_RATE: 0.8,
	},
	SPARKLE: {
		COUNT: 10,
		ANIM_SPEED: 80,
		ROTATE_SPEED: 500,
		STAR_SIZE_RATIO: 3.0,
		STAR_INNER_SIZE_RATIO: 0.4,
		MAX_SIZE_PX: 30,
		COLOR: "#FFFFFF"
	},
	SMOKE: {
		ALPHA_BASE: 0,
		ALPHA_RATE: 0.6,
		RADIUS_BASE: 2,
		RADIUS_RATE: 3,
		DEVIATION_RATE: 10,
		DRAW_MAX_LEN: 300,
	},
	LABEL: {
		FONT: "10px sans-serif",
		BG_COLOR: "rgba(0, 0, 0, 0.5)",
		OFFSET_X: 10,
		OFFSET_Y: -10,
		MARGIN: 100
	},
	DEBUG: {
		FONT: "10px monospace",
		LINE_COLOR: "rgba(0, 255, 100, 0.15)",
		TEXT_COLOR: "rgba(0, 255, 100, 0.5)",
		CROSS_SIZE: 10
	}
};

// UI
export const UI = {
	DOUBLE_TAP_DURATION: 400,
	UPDATE_INTERVAL: {
		NAVI: 500,
		INFO_PANEL: 500,
		TELEMETRY: 100
	},
	BUTTON_COLOR: {
		ACTIVE: "#00ffcc",
		DEFAULT: ""
	}
};

// Telemetry panel
export const TELEMETRY = {
	SUB_VIEW_TARGET_RADIUS: 20,
	SUB_VIEW_MAX_ZOOM: 1e8,
	MAX_Q_TH: 80,
	STYLE: {
		MISSION_STATUS: {
			NORMAL_COLOR: '#00ffcc',
			MAX_Q_COLOR: '#ff5555'
		},
	},
	STATUS: {
		PRE_LAUNCH: -1,
		LIFTOFF: 0,
		ASCENT: 1,
		MAX_Q: 2,
		MECO: 3,
		COASTING: 4,
		TRACKING: 5
	},
	STATUS_MAP: {
		"-1": "PRE-LAUNCH",
		"0": "LIFTOFF",
		"1": "ASCENT",
		"2": "MAX-Q",
		"3": "MECO",
		"4": "COASTING",
		"5": "TRACKING"
	}
};

// Flight computer
export const FLIGHT_COMPUTER_CONFIG = {
	TOWER_CLEARANCE_TIME: 3.0,
	TOWER_CLEARANCE_MIN_Q: 0.1,
	TOWER_CLEARANCE_MAX_ALT: 1000,
	MAX_TURN_RATE_PER_SEC: 0.1,
	PITCH_KICK_TURN_RATE: 0.5,
	THROTTLE_DOWN_Q_RATIO: 0.8,
	THROTTLE_DOWN_MIN_Vv: 0,
	ANTI_STALL_Vv_THRESHOLD: 100,
	ANTI_STALL_MAX_PITCH_UP: 45,
	LOAD_RELIEF_SAFE_MARGIN: 0.8
};

// Communication buffer structure
export const CALC_BUFFER_CONFIG = {
	OBJ_ATTR_COUNT: 39
};

export const BUFFER_INDEX = {
	ID: 0, TYPE: 1, X: 2, Y: 3, VX: 4, VY: 5, AX: 6, AY: 7,
	MASS: 8, FUEL_MASS: 9, RADIUS: 10, BURN_TIME: 11, THRUST_RATIO: 12,
	FLAGS: 13, DEBRIS_MASS: 14, IMPACT_VX: 15, IMPACT_VY: 16,
	IMPACT_WINNER_X: 17, IMPACT_WINNER_Y: 18, IMPACT_WINNER_RADIUS: 19,
	TM_STATUS: 20, TM_Q_AXIAL: 21, TM_Q_LATERAL: 22, TM_STRUCT_RATIO: 23,
	TM_AOA_DEG: 24, TM_PROGRADE_ANGLE: 25, TM_GRAVITY_ANGLE: 26,
	TM_REM_DV: 27, TM_TWR: 28, TM_ALT_M: 29, TM_VV: 30, TM_VH: 31,
	TM_AV: 32, TM_AH: 33, TM_CURRENT_G: 34, TM_FLIGHT_TIME: 35, THRUST_ANGLE: 36,
	DOMINANT_BODY_ID: 37, DIST_TO_DOMINANT: 38
};

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
		"MASS" : 1.9891e30 * 20 / 1e3, // 20 times of the sun
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
		"ATM_COLOR": "rgba(240, 220, 130, 0.4)",
		"ATM_LIMIT_ALT": 4000000,
		"ATM_DENSITY_0": 0.19,
		"ATM_SCALE_HEIGHT": 59500,
		"ROTATION_PERIOD": 38360
	},
	"Uranus": {
		"NAME" : "Uranus",
		"MASS" : 8.6810e25 / 1e3,
		"COLOR": "#AFEEEE",
		"RADIUS": 2.5362e7,
		"A": 19.191,
		"E": 0.0457,
		"PERIHELION_DEG": 170.96,
		"ATM_COLOR": "rgba(175, 238, 238, 0.4)",
		"ATM_LIMIT_ALT": 2000000,
		"ATM_DENSITY_0": 0.42,
		"ATM_SCALE_HEIGHT": 27700,
		"ROTATION_PERIOD": 62064
	},
	"Neptune": {
		"NAME" : "Neptune",
		"MASS" : 1.02413e26 / 1e3,
		"COLOR": "#4169E1",
		"RADIUS": 2.4622e7,
		"A": 30.070,
		"E": 0.0113,
		"PERIHELION_DEG": 44.97,
		"ATM_COLOR": "rgba(65, 105, 225, 0.4)",
		"ATM_LIMIT_ALT": 2000000,
		"ATM_DENSITY_0": 0.45,
		"ATM_SCALE_HEIGHT": 19700,
		"ROTATION_PERIOD": 57996
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
		"MAX_DYNAMIC_PRESSURE": 5000000,
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
		"MAX_Q_AXIAL": 50000,
		"MAX_Q_LATERAL": 5000,
	},
};

export const ROCKET_FUELS = {
	"solid": { name: "Solid", isp: 250, density: 1.8 },
	"liquid": { name: "Liquid", isp: 320, density: 1.0 },
	"hydro": { name: "Cryogenic", isp: 450, density: 0.3 },
	"ion": { name: "Ion", isp: 3000, density: 0.5 }
};

export const OBJECT_TYPES = { CELESTIAL: 0, ROCKET: 1, DEBRIS: 2 };

export const TRAIL_MODE = {
	NORMAL: 0,
	ATMOSPHERE: 1,
	ESCAPE: 2
};

export const LAUNCH_SEQUENCES = {
	LEGACY_QUICK: [
		{ time: 0.0, name: "Ignition & Liftoff", command: "IGNITE_AND_RELEASE" }
	]
};
