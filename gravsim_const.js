
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
	LAUNCH_TO_COMPLETION_TIME: 5,
	LEGACY_QUICK: {
		tMinusOffset: 3,
		events: [
			{ time: 0, name: "TERMINAL COUNTDOWN START", command: "START_COUNTDOWN" },
			{ time: 3, name: "Ignition & Liftoff", command: "IGNITE_AND_RELEASE" }
		]
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
			{ time: 115, name: "MAIN ENGINE START", command: "IGNITE_ENGINE" },
			{ time: 120, name: "LIFTOFF", command: "RELEASE_HOLD_DOWN" }
		]
	}
};

export const ROCKET_LAUNCHER_CONFIG = {
	EFFECT_STOP_ALT_M: 3000,
	ZOOM_SCREEN_DIV: 4
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
		CABLE_HIGH_WIDTH_MULT: 0.08
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
