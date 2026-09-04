
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
	REMOVE_DISTANCE_AU: 200,
	CALC_INTERVAL: 60,
	CALC_EXPAND_DIV_NUM: 20,
	CALC_SUB_STEPS_BASE: 600,
	CALC_SUB_STEPS_MAX: 480,
	MIN_GRAVITY_CALC_MASS: 1e10, // t
	DEFAULT_OBJECT_MASS: 1, // t
	DEFAULT_OBJECT_RADIUS: 1, // m
	MAX_FRAME_ELAPSED_MS: 1000, // ms
	// Adaptive sub-step configurations
	SUB_STEPS: {
		MIN: 20,
		MAX: 1200,
		BASE: 40,
		ETA_GRAV: 0.12,        // Dynamical time factor: dt <= eta * sqrt(r / a)
		ETA_SURF: 0.08,        // Surface approach factor: dt <= eta * dist_surf / v_rel
		ETA_VEL: 0.25,         // Movement restriction: dt <= eta * radius / v
		ETA_VEL_ORBITAL: 0.04, // Orbital angular step limit factor: dt <= eta * dist / v_rel
		ETA_ACC: 0.15,         // Acceleration change: dt <= eta * (v + v0) / a
		ETA_ATM: 0.10,         // Atmosphere scale height: dt <= eta * H / v
		SMOOTHING_DECAY: 0.90, // Decay factor for smooth step reduction
		MIN_SURFACE_DIST: 1.0, // m
		VELOCITY_EPSILON: 1e-3, // m/s
		MIN_GRAV_ACCEL: 1e-6,  // m/s^2
		MIN_TINY_ACCEL: 1e-3,  // m/s^2
		ACCEL_VEL_OFFSET: 10.0, // m/s
		ATM_VEL_OFFSET: 1.0,   // m/s
		ATM_BUFFER_ZONE_MIN: 500000, // m (500 km)
		ATM_BUFFER_ZONE_MULT: 5,
		ROCKET_POWERED_MAX_DT: 0.5, // s
		TIME_SCALE_BASE_CAP: 10,
		BODY_COUNT_THRESHOLD: 50,
		BODY_COUNT_MIN_MULT: 2
	}
};

// Shattering / Roche limit
export const ROCHE_LIMIT = {
	COEFFICIENT: 2.44,
	MIN_MASS_TO_DESTROY: 1e15,
	UNBREAKABLE_DENSITY: 1e10,
	MIN_FRAGILE_DENSITY: 1e3,
	RIGID_BODY_RADIUS: 10000,
	RIGID_DESTROYER_MASS: 1e25
};

// Collision & Debris generation configuration
export const COLLISION_CONFIG = {
	QUADTREE_MAX_OBJECTS: 4,
	DEBRIS_ENERGY_FACTOR: 0.5,
	MAX_DEBRIS_RATIO: 0.9,
	MIN_DEBRIS_RATIO: 1e-4
};

// Aero Dynamics
export const AERO_DYNAMIC = {
	DEFAULT_CD: 0.47,
	ROCKET_DEFAULT_CD: 0.2,
	DEFAULT_SCALE_HEIGHT: 8500, // m
	FADE_START_RATIO: 0.8,
	LOW_VELOCITY_SQ: 0.01 // (m/s)^2
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
	MASS_VAR_RANGE: 0.4,
	IMPACT_FRAG_MASS_LOG_MULT: 1.5,
	SPAWN_MARGIN_MIN_PX: 2,
	IMPACT_SPAWN_JITTER_PX: 5
};

// Drawing / Visualization
export const RENDER = {
	DISTANCE_SCALE: 180,
	TRAIL_HISTORY_LENGTH: 1500,
	EFFECT_HISTORY_LENGTH: 400,
	SCALE_BAR: {
		WIDTH: 150,
		LINE_WIDTH: 2,
		RIGHT: 20,
		BOTTOM: 20,
		COLOR: "rgba(255, 255, 255, 0.9)",
		VERTICAL_LINE_WIDTH: 5,
		FRAC_THRESHOLDS: [1.5, 3.5, 7.5]
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
		QUANTIZE_LEVELS: 20,
		THINNING_MIN_DIST_SQ: 4,
		THINNING_MAX_DIST_SQ: 144,
		THINNING_ANGLE_COS_SQ: 0.93
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
		ALPHA_BASE: 0.05,
		ALPHA_RATE: 0.7,
		RADIUS_BASE: 0.5,
		RADIUS_RATE: 4,
		DEVIATION_RATE: 10,
		DRAW_MAX_LEN: 300,
	},
	LABEL: {
		FONT: "10px sans-serif",
		BG_COLOR: "rgba(0, 0, 0, 0.5)",
		OFFSET_X: 10,
		OFFSET_Y: -10,
		MARGIN: 100,
		BG_PAD_X: 2,
		BG_PAD_Y: 6,
		BG_EXTRA_W: 4,
		BG_H: 12
	},
	DEBUG: {
		FONT: "10px monospace",
		LINE_COLOR: "rgba(0, 255, 100, 0.15)",
		TEXT_COLOR: "rgba(0, 255, 100, 0.5)",
		CROSS_SIZE: 10,
		STEP_THRESHOLDS: [
			{ limit: 5, step: 100 },
			{ limit: 10, step: 20 },
			{ limit: 50, step: 10 },
			{ limit: 100, step: 2 }
		],
		STEP_DEFAULT: 0.1,
		STEP_MAX: 1
	},
	MARKER: {
		FREE_RADIUS: 15,
		FREE_CROSS: 20,
		FREE_COLOR: "rgba(255, 255, 255, 0.5)",
		HOST_MIN_SIZE: 10,
		HOST_BOX_MULT: 1.2,
		HOST_LINE_FRAC: 0.3,
		HOST_COLOR: "rgba(0, 255, 255, 0.8)",
		HOST_FILL: "rgba(0, 255, 255, 0.5)",
		HOST_DASH: [4, 4],
		HOST_VECTOR_MULT: 2.5
	},
	ROCKET: {
		BODY_LENGTH_MULT: 2.0,
		BODY_WIDTH_MULT: 0.7,
		FLAME_LEN_MULT: 3.0,
		FLAME_FLICKER_MIN: 0.8,
		FLAME_FLICKER_MAX: 1.2,
		FLAME_OUTER_COLOR: "rgba(255, 100, 0, 0.8)",
		FLAME_INNER_COLOR: "rgba(255, 200, 0, 0.9)",
		FLAME_OUTER_W_MULT: 0.8,
		FLAME_INNER_W_MULT: 0.9,
		FLAME_INNER_H_MULT: 0.6,
		FLAME_INNER_Y_MULT: 0.4
	},
	DEBRIS_RENDER: {
		MIN_VERTICES: 5,
		VAR_VERTICES: 4,
		RAD_RATIO_MIN: 0.6,
		RAD_RATIO_VAR: 0.6,
		ROT_SPEED_VAR: 0.005
	},
	SLINGSHOT: {
		GUIDE_RADIUS: 12,
		GUIDE_CROSS: 16,
		GUIDE_COLOR: "rgba(0, 255, 204, 0.4)",
		LINE_DASH: [4, 4],
		LINE_OPPOSITE_COLOR: "rgba(0, 255, 204, 0.3)",
		LINE_VECTOR_COLOR: "rgba(0, 255, 204, 0.9)",
		LINE_WIDTH: 2,
		ARROW_MIN_LEN: 5,
		ARROW_HEAD_LEN: 8,
		ARROW_INDENT_MULT: 0.6,
		ARROW_ANGLE: Math.PI / 6,
		HUD_OFFSET_X: 20,
		HUD_OFFSET_Y: -80,
		HUD_WIDTH: 140,
		HUD_HEIGHT: 75,
		HUD_RAD: 4,
		HUD_BG_COLOR: "rgba(0, 20, 0, 0.85)",
		HUD_BORDER_COLOR: "rgba(0, 255, 204, 0.6)",
		HUD_TEXT_COLOR_MAIN: "#00ffcc",
		HUD_TEXT_COLOR_SUB: "#00aa88",
		HUD_FONT_TITLE: "bold 12px 'Courier New', Courier, monospace",
		HUD_FONT_BODY: "11px 'Courier New', Courier, monospace",
		HUD_PAD_X: 8,
		HUD_PAD_Y_TITLE: 8,
		HUD_PAD_Y_MASS: 26,
		HUD_PAD_Y_VEL: 42,
		HUD_PAD_Y_ANG: 56
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
	},
	ANNUNCIATOR: {
		Q_LIM_TH: 85, // % of structural limit
		G_LIM_RATIO: 0.90, // % of max G limit
		LAMP_TEST_DURATION_SEC: 1.0,
		TOWER_CLEARANCE_ALT: 1000, // m
		TOWER_CLEARANCE_TIME: 10, // s
		FAIRING_SEP_ALT: 100000, // m (Karman line)
		ORBITAL_VELOCITY_KM_S: 7.5 // km/s
	}
};

// Flight computer
export const FLIGHT_COMPUTER_CONFIG = {
	TOWER_CLEARANCE_TIME: 10,
	TOWER_CLEARANCE_MIN_Q: 0.1,
	TOWER_CLEARANCE_MAX_ALT: 1000,
	MAX_TURN_RATE_PER_SEC: 0.1,
	PITCH_KICK_TURN_RATE: 0.5,
	THROTTLE_DOWN_Q_RATIO: 0.8,
	THROTTLE_DOWN_MIN_Vv: 0,
	ANTI_STALL_Vv_THRESHOLD: 100,
	ANTI_STALL_MAX_PITCH_UP: 45,
	ANTI_STALL_MIN_Q_KPA: 0.05,
	ANTI_STALL_FACTOR_THRESHOLD: 0.05,
	LOAD_RELIEF_SAFE_MARGIN: 0.8,
	LOAD_RELIEF_MIN_Q_PA: 100,
	AOA_TOLERANCE_RAD: 0.001,
	THROTTLE_DOWN_SENSITIVITY: 5.0,
	THROTTLE_DOWN_MIN_THROTTLE_LOW_VV: 0.8,
	THROTTLE_DOWN_MIN_THROTTLE_NORMAL: 0.1,
	MAX_Q_MIN_PRESSURE_KPA: 1.0,
	MAX_Q_PEAK_DROP_RATIO: 0.05,
	MAX_Q_CONFIRM_DELAY_SEC: 0.5,
	MAX_Q_KEEP_DURATION_SEC: 3.0,
	DEFAULT_ISP: 320
};

// Communication buffer structure
export const CALC_BUFFER_CONFIG = {
	OBJ_ATTR_COUNT: 42
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
	DOMINANT_BODY_ID: 37, DIST_TO_DOMINANT: 38, OXID_MASS: 39,
	TM_TANK_PRES_FUEL: 40, TM_TANK_PRES_OXID: 41
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
	// --- Notable Stars ---
	"Betelgeuse": {
		"NAME" : "Betelgeuse",
		"MASS" : 1.9891e30 * 16.5 / 1e3,
		"COLOR": "#FF4500",
		"RADIUS": 8.87e11,
		"A": 3500,
		"E": 0.15,
		"PERIHELION_DEG": 30,
	},
	"Sirius": {
		"NAME" : "Sirius",
		"MASS" : 1.9891e30 * 2.02 / 1e3,
		"COLOR": "#CAE1FF",
		"RADIUS": 1.19e9,
		"A": 1500,
		"E": 0.05,
		"PERIHELION_DEG": 200,
	},
	"AlphaCentauriA": {
		"NAME" : "Alpha Centauri A",
		"MASS" : 1.9891e30 * 1.1 / 1e3,
		"COLOR": "#FFF8DC",
		"RADIUS": 8.51e8,
		"A": 800,
		"E": 0.08,
		"PERIHELION_DEG": 320,
	},
	"ProximaCentauri": {
		"NAME" : "Proxima Centauri",
		"MASS" : 1.9891e30 * 0.122 / 1e3,
		"COLOR": "#FF6347",
		"RADIUS": 1.07e8,
		"A": 500,
		"E": 0.20,
		"PERIHELION_DEG": 110,
	},
	"Rigel": {
		"NAME" : "Rigel",
		"MASS" : 1.9891e30 * 21.0 / 1e3,
		"COLOR": "#B0C4DE",
		"RADIUS": 5.44e10,
		"A": 5000,
		"E": 0.12,
		"PERIHELION_DEG": 260,
	},
	"Vega": {
		"NAME" : "Vega",
		"MASS" : 1.9891e30 * 2.135 / 1e3,
		"COLOR": "#F0F8FF",
		"RADIUS": 1.86e9,
		"A": 2000,
		"E": 0.03,
		"PERIHELION_DEG": 75,
	},
	"Polaris": {
		"NAME" : "Polaris",
		"MASS" : 1.9891e30 * 5.4 / 1e3,
		"COLOR": "#FFFACD",
		"RADIUS": 3.27e10,
		"A": 2500,
		"E": 0.10,
		"PERIHELION_DEG": 160,
	},
	"Sun": {
		"NAME" : "Sun",
		"MASS" : 1.9891e30 / 1e3,
		"COLOR": "#FF4500",
		"RADIUS": 6.96340e8,
		"A": 1000,
		"E": 0.05,
		"PERIHELION_DEG": 0,
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
	// --- Jupiter Moons ---
	"Io": {
		"NAME" : "Io",
		"MASS" : 8.932e22 / 1e3,
		"COLOR": "#FFCC00",
		"RADIUS": 1.8216e6,
		"A": 0.00282,
		"E": 0.0041,
		"PERIHELION_DEG": 0,
	},
	"Europa": {
		"NAME" : "Europa",
		"MASS" : 4.800e22 / 1e3,
		"COLOR": "#F5DEB3",
		"RADIUS": 1.5608e6,
		"A": 0.00449,
		"E": 0.0094,
		"PERIHELION_DEG": 90,
	},
	"Ganymede": {
		"NAME" : "Ganymede",
		"MASS" : 1.4819e23 / 1e3,
		"COLOR": "#C0C0C0",
		"RADIUS": 2.6341e6,
		"A": 0.00716,
		"E": 0.0013,
		"PERIHELION_DEG": 180,
	},
	"Callisto": {
		"NAME" : "Callisto",
		"MASS" : 1.0759e23 / 1e3,
		"COLOR": "#808080",
		"RADIUS": 2.4103e6,
		"A": 0.01259,
		"E": 0.0074,
		"PERIHELION_DEG": 270,
	},
	// --- Saturn Moons ---
	"Titan": {
		"NAME" : "Titan",
		"MASS" : 1.3452e23 / 1e3,
		"COLOR": "#DAA520",
		"RADIUS": 2.5747e6,
		"A": 0.00817,
		"E": 0.0288,
		"PERIHELION_DEG": 0,
		"ATM_COLOR": "rgba(218, 165, 32, 0.5)",
		"ATM_LIMIT_ALT": 600000,
		"ATM_DENSITY_0": 5.3,
		"ATM_SCALE_HEIGHT": 21000,
	},
	"Enceladus": {
		"NAME" : "Enceladus",
		"MASS" : 1.0802e20 / 1e3,
		"COLOR": "#F0FFFF",
		"RADIUS": 2.521e5,
		"A": 0.00159,
		"E": 0.0047,
		"PERIHELION_DEG": 120,
	},
	"Mimas": {
		"NAME" : "Mimas",
		"MASS" : 3.749e19 / 1e3,
		"COLOR": "#D3D3D3",
		"RADIUS": 1.983e5,
		"A": 0.00124,
		"E": 0.0196,
		"PERIHELION_DEG": 240,
	},
	"Rhea": {
		"NAME" : "Rhea",
		"MASS" : 2.307e21 / 1e3,
		"COLOR": "#C0C0C0",
		"RADIUS": 7.638e5,
		"A": 0.00352,
		"E": 0.0013,
		"PERIHELION_DEG": 60,
	},
	// --- Dwarf Planets ---
	"Pluto": {
		"NAME" : "Pluto",
		"MASS" : 1.303e22 / 1e3,
		"COLOR": "#DEB887",
		"RADIUS": 1.1883e6,
		"A": 39.482,
		"E": 0.2488,
		"PERIHELION_DEG": 224.07,
	},
	"Ceres": {
		"NAME" : "Ceres",
		"MASS" : 9.393e20 / 1e3,
		"COLOR": "#A9A9A9",
		"RADIUS": 4.730e5,
		"A": 2.768,
		"E": 0.0758,
		"PERIHELION_DEG": 73.60,
	},
	"Eris": {
		"NAME" : "Eris",
		"MASS" : 1.660e22 / 1e3,
		"COLOR": "#F5F5DC",
		"RADIUS": 1.163e6,
		"A": 67.864,
		"E": 0.4407,
		"PERIHELION_DEG": 151.43,
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
	"solid": { name: "Solid", isp: 250, density: 1.8, ofRatio: 0 },
	"liquid": { name: "Liquid", isp: 320, density: 1.0, ofRatio: 2.5 },
	"hydro": { name: "Cryogenic", isp: 450, density: 0.3, ofRatio: 6.0 },
	"ion": { name: "Ion", isp: 3000, density: 0.5, ofRatio: 0 }
};

export const OBJECT_TYPES = { CELESTIAL: 0, ROCKET: 1, DEBRIS: 2 };

export const TRAIL_MODE = {
	NORMAL: 0,
	ATMOSPHERE: 1,
	ESCAPE: 2
};

export const LAUNCH_SEQUENCES = {
	LAUNCH_TO_COMPLETION_TIME: 10,
	LEGACY_QUICK: {
		tMinusOffset: 3,
		events: [
			{ time: 0, name: "TERMINAL COUNTDOWN START", command: "START_COUNTDOWN" },
			{ time: 1, name: "TRANSFER TO INTERNAL POWER", command: "" },
			{ time: 2, name: "MAIN ENGINE START", command: "IGNITE_ENGINE" },
			{ time: 3, name: "LIFTOFF", command: "RELEASE_HOLD_DOWN" }
		],
		audioProfile: {
			events: {
				"LIFTOFF": "ev_liftoff"
			},
			times: {
				"-3": "num_3",
				"-2": "num_2",
				"-1": "num_1",
				"0": "num_0",
				"1": "num_1",
				"2": "num_2",
				"3": "num_3",
				"4": "num_4",
				"5": "num_5"
			},
			conditions: [
				{ id: "tower_clear", type: "altM", operator: ">", value: 120, audio: "fl_tower_clear", once: true },
				{ id: "pitch_roll", type: "altM", operator: ">", value: 500, audio: "fl_pitch_roll", once: true },
				{ id: "pitch_downrange", type: "altM", operator: ">", value: 2000, audio: "fl_pitch_downrange", once: true },
				{ id: "approach_maxq", type: "status", operator: "==", value: 2, audio: "fl_approach_maxq", once: true },
				{ id: "meco", type: "status", operator: "==", value: 3, audio: "fl_meco", once: true }, // 3 = TELEMETRY.STATUS.MECO
				{ id: "traj_nominal", type: "met", operator: ">", value: 45, audio: "fl_traj_nominal", once: true },
				{ id: "telemetry_good", type: "met", operator: ">", value: 80, audio: "fl_telemetry_good", once: true }
			]
		}
	},
	FULL_COUNTDOWN: {
		tMinusOffset: 120,
		events: [
			{ time: 0, name: "TERMINAL COUNTDOWN START", command: "START_COUNTDOWN" },
			{ time: 5, name: "PROPELLANT LOADING COMPLETE", command: "" },
			{ time: 10, name: "ENGINE CHILLDOWN START", command: "" },
			{ time: 25, name: "TANK PRESSURIZATION START", command: "PRESSURIZE_TANK" },
			{ time: 31, name: "POLL: WEATHER - GO", command: "" },
			{ time: 34, name: "POLL: RANGE - GO", command: "" },
			{ time: 37, name: "POLL: GROUND - GO", command: "" },
			{ time: 40, name: "POLL: AVIONICS - GO", command: "" },
			{ time: 43, name: "POLL: PROPULSION - GO", command: "" },
			{ time: 46, name: "POLL: GUIDANCE - GO", command: "" },
			{ time: 49, name: "POLL: FLIGHT - GO", command: "" },
			{ time: 55, name: "POLL: LD - GO FOR LAUNCH", command: "" },
			{ time: 60, name: "AUTO SEQUENCE START", command: "AUTO_SEQUENCE_START" },
			{ time: 75, name: "TRANSFER TO INTERNAL POWER", command: "" },
			{ time: 95, name: "WATER DELUGE SYSTEM ON", command: "WATER_DELUGE" },
			{ time: 110, name: "ROFI IGNITION", command: "ROFI_IGNITION" },
			{ time: 117, name: "MAIN ENGINE START", command: "IGNITE_ENGINE" },
			{ time: 120, name: "LIFTOFF", command: "RELEASE_HOLD_DOWN" }
		],
		audioProfile: {
			events: {
				"TERMINAL COUNTDOWN START": "ev_terminal_start",
				"PROPELLANT LOADING COMPLETE": "ev_prop_loaded",
				"ENGINE CHILLDOWN START": "ev_chilldown",
				"TANK PRESSURIZATION START": "ev_pressurize",
				"POLL: WEATHER - GO": "ev_weather_go",
				"POLL: RANGE - GO": "ev_range_go",
				"POLL: GROUND - GO": "ev_ground_go",
				"POLL: AVIONICS - GO": "ev_avionics_go",
				"POLL: PROPULSION - GO": "ev_propulsion_go",
				"POLL: GUIDANCE - GO": "ev_guidance_go",
				"POLL: FLIGHT - GO": "ev_flight_go",
				"POLL: LD - GO FOR LAUNCH": "ev_ld_go",
				"AUTO SEQUENCE START": "ev_auto_seq",
				"TRANSFER TO INTERNAL POWER": "ev_internal_pwr",
				"WATER DELUGE SYSTEM ON": "ev_water_deluge",
				"ROFI IGNITION": "ev_rofi",
				"MAIN ENGINE START": "ev_main_engine",
				"LIFTOFF": "ev_liftoff"
			},
			times: {
				"-120": "ms_120",
				"-60": "ms_60",
				"-30": "ms_30",
				"-20": "ms_20",
				"-15": "ms_15",
				"-10": "num_10",
				"-9": "num_9",
				"-8": "num_8",
				"-7": "num_7",
				"-6": "num_6",
				"-5": "num_5",
				"-4": "num_4",
				"-3": "num_3",
				"-2": "num_2",
				"-1": "num_1",
				"0": "num_0",
				"1": "num_1",
				"2": "num_2",
				"3": "num_3",
				"4": "num_4",
				"5": "num_5",
				"6": "num_6",
				"7": "num_7",
				"8": "num_8",
				"9": "num_9",
				"10": "num_10"
			},
			conditions: [
				{ id: "tower_clear", type: "altM", operator: ">", value: 120, audio: "fl_tower_clear", once: true },
				{ id: "pitch_roll", type: "altM", operator: ">", value: 500, audio: "fl_pitch_roll", once: true },
				{ id: "pitch_downrange", type: "altM", operator: ">", value: 2000, audio: "fl_pitch_downrange", once: true },
				{ id: "approach_maxq", type: "status", operator: "==", value: 2, audio: "fl_approach_maxq", once: true },
				{ id: "meco", type: "status", operator: "==", value: 3, audio: "fl_meco", once: true }, // 3 = TELEMETRY.STATUS.MECO
				{ id: "traj_nominal", type: "met", operator: ">", value: 45, audio: "fl_traj_nominal", once: true },
				{ id: "telemetry_good", type: "met", operator: ">", value: 80, audio: "fl_telemetry_good", once: true }
			]
		}
	}
};

export const ROCKET_LAUNCHER_CONFIG = {
	EFFECT_STOP_ALT_M: 3000,
	TRACKING: {
		ALT_PHASE1: 500,
		ALT_PHASE2: 15000,
		ALT_PHASE3: 100000,
		GROUND_HEIGHT_RATIO: 0.45,
		MAX_HEIGHT_RATIO: 0.3,
		TRACKING_ATL_LIMIT_RATIO: 0.2
	}
};

// Pad Effect Constants
export const PAD_EFFECT = {
	STRUCTURE: {
		STRONGBACK_RETRACT_SPEED: 5,
		STRONGBACK_MAX_ANGLE: 25,
		UMBILICAL_RETRACT_SPEED: 100,
		UMBILICAL_MAX_ANGLE: 35,
		UMBILICAL_OFFSET_X: -0.6,
		UMBILICAL_OFFSET_Y: -1.5,
		BASE_COLOR: "#333333",
		TRUSS_COLOR: "#555555",
		TRUSS_HIGHLIGHT: "#777777",
		CABLE_BASE_COLOR: "#222222",
		CABLE_HIGH_COLOR: "#ff6600",
		JOINT_COLOR: "#aaaaaa",
		GLOW_COLOR: "#ffaa00",
		GLOW_BLUR_MULT: 1.5,
		BASE_X_MULT: -3.5,
		BASE_Y_MULT: -1.5,
		BASE_W_MULT: 1.5,
		BASE_H_MULT: 3.0,
		STRONGBACK_X_MULT: -1.5,
		STRONGBACK_Y_MULT: 1.2,
		STRONGBACK_W_MULT: 2.5,
		STRONGBACK_H_MULT: 0.4,
		STRONGBACK_TRUSS_CROSS: 4,
		STRONGBACK_TRUSS_WIDTH_MULT: 0.1,
		UMBILICAL_W_MULT: 1.5,
		UMBILICAL_H_MULT: 0.2,
		CABLE_WIDTH_MULT: 0.2,
		CABLE_HIGH_WIDTH_MULT: 0.08,
		CABLE_NODES: 8,
		CABLE_GRAVITY: 7.0,
		CABLE_DAMPING: 0.99,
		CABLE_CONSTRAINT_ITERATIONS: 8,
		CABLE_SWING_IMPULSE: 0.4
	},
	PHYSICS: {
		FALL_V_MULT: 5,
		DRAG_NORM_DT: 60,
		NOZZLE_OFFSET_MULT: 2.0,
		SIDE_OFFSET_MULT: 1
	},
	EMITTER: {
		ICE: { COUNT: 30, OFFSET_MULT: 1.5, V_RAND: 5, LIFE_BASE: 0.5, LIFE_RAND: 1.5 },
		PURGE_SPARK: { COUNT: 15, V_RAND: 20, LIFE_BASE: 0.5 },
		VENT: { RATE: 0.06, PRESSURIZED_RATE: 0.02, COUNT: 5, V_BASE: 6, V_RAND: 60, LIFE_BASE: 2.5, SIZE: 0.02 },
		CHILL: { RATE: 0.3, COUNT: 1, V_RAND: 2, LIFE_BASE: 1.2, SIZE: 0.2 },
		DELUGE: { COUNT: 5, V_BASE: 20, V_RAND: 30, LIFE_BASE: 4.0, SIZE: 0.5 },
		ROFI: { COUNT: 3, V_RAND: 15, LIFE_BASE: 0.8, SIZE: 0.1 }
	},
	PARTICLES: {
		'smoke_white': { COLOR: "#dddddd", SHAPE: 'circle', DRAG: 0.94, GROW_SPEED: 0.25, GRAVITY_MULT: 0.1, SIZE_MULT: 0.25, MAX_ALPHA: 0.35 },
		'chill':       { COLOR: "#aaddff", SHAPE: 'circle', DRAG: 0.98, GROW_SPEED: 0.2, GRAVITY_MULT: 0, SIZE_MULT: 0.5, MAX_ALPHA: 1.0 },
		'deluge':      { COLOR: "#d4f0ff", SHAPE: 'stretch', DRAG: 0.98, GROW_SPEED: 0.65, GRAVITY_MULT: 0, SIZE_MULT: 0.8, MAX_ALPHA: 0.4 },
		'spark':       { COLOR: "#ffdd55", SHAPE: 'circle', DRAG: 1.0, GROW_SPEED: 0.0, GRAVITY_MULT: 0, SIZE_MULT: 0.2, MAX_ALPHA: 1.0 },
		'ice':         { COLOR: "#ffffff", SHAPE: 'square', DRAG: 1.0, GROW_SPEED: 0.0, GRAVITY_MULT: 0.5, SIZE_MULT: 0.2, MAX_ALPHA: 1.0 }
	}
};

export const SOUND = {
	BASEDIR: "./sounds",
};

// Pressure simulation parameters
export const TANK_PRESSURE_SIM = {
	UNPRESSURIZED_KPA: 101.3,
	TARGET_KPA: 350.0,
	BASE_NOISE_RATIO: 0.005,
	Q_NOISE_RATIO: 0.02,
	PRESSURIZE_TIME_SEC: 5.0,
	IGNITION_DROP_RATIO: 0.92,
	IGNITION_DROP_TIME_SEC: 1.0,
	MECO_SPIKE_RATIO: 1.10,
	MECO_SPIKE_TIME_SEC: 0.5,
	DEPLETION_DROP_RATE: 200.0
};

// Event priority constants
export const EVENT_PRIORITY = {
	LOGIC: 10,
	CAMERA: 20,
	UI: 30,
	CLEANUP: 40,
	
	DRAW_WORLD_FX: 10,
	DRAW_OVERLAY: 20,
	DRAW_HUD: 30
};

// Object Deployment Profiles
export const DEPLOY_PROFILES = {
	"DEBUG_STRESS_TEST": {
		name: "Stress Test",
		clearPrevious: true,
		generators: [
			{
				type: "elliptical_swarm",
				template: "Rocket",
				count: 120,
				host: "Sun",
				perihelionAuMin: 0.05,
				perihelionAuMax: 1.2,
				aphelionAuMin: 1.0,
				aphelionAuMax: 4.8,
				options: { autoControl: true, isIgnited: false }
			},
			{
				type: "circular_swarm",
				templates: ["Moon", "Mars"],
				count: 150,
				host: "Sun",
				radiusAuMin: 5.2,
				radiusAuMax: 9.2
			}
		]
	},
	"SOLAR_SYSTEM": {
		name: "Solar System",
		clearPrevious: false,
		staticObjects: [
			{ template: "Mercury", host: "Sun" },
			{ template: "Venus", host: "Sun" },
			{ template: "Earth", host: "Sun" },
			{ template: "Moon", host: "Earth" },
			{ template: "Mars", host: "Sun" },
			{ template: "Ceres", host: "Sun" },
			{ template: "Jupiter", host: "Sun" },
			{ template: "Io", host: "Jupiter" },
			{ template: "Europa", host: "Jupiter" },
			{ template: "Ganymede", host: "Jupiter" },
			{ template: "Callisto", host: "Jupiter" },
			{ template: "Saturn", host: "Sun" },
			{ template: "Titan", host: "Saturn" },
			{ template: "Enceladus", host: "Saturn" },
			{ template: "Mimas", host: "Saturn" },
			{ template: "Rhea", host: "Saturn" },
			{ template: "Uranus", host: "Sun" },
			{ template: "Neptune", host: "Sun" },
			{ template: "Pluto", host: "Sun" },
			{ template: "Eris", host: "Sun" }
		]
	},
	"BINARY_SYSTEM": {
		name: "Binary Star System",
		clearPrevious: true,
		generators: [
			{
				type: "binary_system",
				primary: { template: "Sun", name: "Sun A", color: "#FF8C00" },
				secondary: { template: "Sun", name: "Sun B", color: "#00BFFF" },
				separationAu: 3.0,
				planets: [
					{ template: "Earth", host: "primary", distanceAu: 0.35, hasMoon: true },
					{ template: "Jupiter", host: "barycenter", distanceAu: 7.0 }
				]
			}
		]
	},
	"THREE_BODY": {
		name: "Three-Body Problem",
		clearPrevious: true,
		generators: [
			{
				type: "three_body",
				stars: [
					{ template: "Sun", name: "Sun A (Trisolaris 1)", color: "#FF4500" },
					{ template: "Sun", name: "Sun B (Trisolaris 2)", color: "#00E5FF" },
					{ template: "Sun", name: "Sun C (Trisolaris 3)", color: "#FFD700" }
				],
				radiusAu: 3.0,
				velocityRatio: 0.75,
				includePlanet: true,
				planetDistanceAu: 0.35
			}
		]
	},
	"GALACTIC_CENTER": {
		name: "Galactic Center",
		clearPrevious: true,
		staticObjects: [
			{ template: "SgrAStar", x: 0, y: 0 },
			{ template: "Sun", host: "Sagittarius A*" },
			{ template: "ProximaCentauri", host: "Sagittarius A*" },
			{ template: "AlphaCentauriA", host: "Sagittarius A*" },
			{ template: "Sirius", host: "Sagittarius A*" },
			{ template: "Vega", host: "Sagittarius A*" },
			{ template: "Polaris", host: "Sagittarius A*" },
			{ template: "Betelgeuse", host: "Sagittarius A*" },
			{ template: "Rigel", host: "Sagittarius A*" }
		]
	}
};
