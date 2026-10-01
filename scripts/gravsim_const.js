
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
	MIN_DEBRIS_RATIO: 1e-4,
	MASSIVE_SEARCH_MARGIN_M: 100000
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
	IMPACT_SPAWN_JITTER_PX: 5,
	ID_RANDOM_RANGE: 10000000
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
		FLAME_INNER_Y_MULT: 0.4,
		SMOKE_NOZZLE_OFFSET_STAGE1: 3.1,
		SMOKE_NOZZLE_OFFSET_STAGE2: 1.0
	},
	DEBRIS_RENDER: {
		MIN_VERTICES: 5,
		VAR_VERTICES: 4,
		RAD_RATIO_MIN: 0.6,
		RAD_RATIO_VAR: 0.6,
		ROT_SPEED_VAR: 0.005
	},
	DEBRIS_HARDWARE: {
		STAGE1_LEN_RATIO: 2.8,
		STAGE1_WIDTH_RATIO: 0.7,
		STAGE1_NOZZLE_RATIO: 0.35,
		STAGE1_NOZZLE_WIDTH_RATIO: 0.95,
		STAGE1_FIN_SPAN_RATIO: 0.65,
		STAGE2_LEN_RATIO: 1.6,
		STAGE2_WIDTH_RATIO: 0.65,
		STAGE2_NOZZLE_RATIO: 0.35,
		FAIRING_LEN_RATIO: 1.3,
		FAIRING_WIDTH_RATIO: 0.65,
		BOOSTER_LEN_RATIO: 1.70,
		BOOSTER_WIDTH_RATIO: 0.26,
		BOOSTER_NOZZLE_RATIO: 0.20,
		BOOSTER_NOSE_RATIO: 0.35,
		DEFAULT_ROTATION_SPEED: 0.0015,
		LOD_RADIUS_THRESHOLD: 2.0,
		LOD_LEN_RATIO: 2.0,
		LOD_WIDTH_RATIO: 0.7
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
	},
	PREDICTED_TRAJECTORY: {
		LINE_WIDTH_PRE: 2.0,
		LINE_WIDTH_FLIGHT: 2.2,
		LINE_DASH_PRE: [14, 10],
		LINE_DASH_FLIGHT: [14, 10],
		COLOR_PRE: "rgba(0, 200, 160, 0.65)",
		COLOR_SOLID: "rgba(0, 255, 204, 0.95)",
		COLOR_FLIGHT: "rgba(0, 200, 160, 0.65)",
		COLOR_ORBIT: "rgba(100, 200, 255, 0.6)",
		COLOR_FALL: "rgba(255, 100, 100, 0.6)",
		MIN_SCREEN_DIST_SQ: 4.0,
		SMOOTH_CURVE_ENABLED: false,
		MIN_SMOOTH_SEGMENTS: 3,
		ACTUAL_SAMPLE_MIN_DIST_M: 5.0,
		ACTUAL_MAX_POINTS: 6000,
		EVENT_RADIUS: 4.5,
		EVENT_RING_WIDTH: 1.5,
		EVENT_COLOR_UNPASSED: "#00ffff",
		EVENT_FILL_UNPASSED: "rgba(0, 20, 30, 0.85)",
		EVENT_COLOR_PASSED: "#00ff66",
		EVENT_FILL_PASSED: "#00ff66",
		EVENT_TEXT_COLOR: "#ffffff",
		EVENT_FONT: "bold 10px 'Courier New', monospace",
		EVENT_LABEL_OFFSET_X: 8,
		EVENT_LABEL_OFFSET_Y: -6,
		LABEL_PAD_X: 3,
		LABEL_PAD_Y: 2,
		LABEL_BOX_OFFSET_Y: -6,
		LABEL_BOX_HEIGHT: 12,
		LABEL_BG_COLOR: "rgba(0, 15, 20, 0.75)",
		EVENT_IMPACT_COLOR: "#ff3333",
		EVENT_IMPACT_FILL: "rgba(255, 30, 30, 0.25)",
		EVENT_IMPACT_SIZE: 6.0,
		EVENT_IMPACT_LINE_WIDTH: 2.2,
		EVENT_IMPACT_TEXT_COLOR: "#ff5555",
		EVENT_IMPACT_BOX_BG: "rgba(40, 10, 10, 0.85)"
	}
};


// Trajectory Prediction & Simulation Constants
export const TRAJECTORY_PREDICTION = {
	MAX_SIM_TIME_SEC: 365.25 * 24 * 60 * 60, // 1 year (365.25 days)
	DEFAULT_DURATION_MONTHS: 1.0,
	MIN_DURATION_MONTHS: 0.2,
	MAX_POINTS: 3000,
	MAX_STEPS: 100000,
	DUMMY_ROCKET_ID: 999999,
	DEFAULT_MAX_G: 4.0,
	UPDATE_THROTTLE_MS: 150,

	// Adaptive dt criteria (seconds)
	DT: {
		POWERED_OR_ATM: 0.05,
		POST_BURNOUT_COOL: 0.1,
		SURFACE_CLOSE: 0.1,
		SURFACE_MEDIUM: 0.25,
		SURFACE_FAR: 0.5,
		INSIDE_MOON: 1.0,
		DEEP_SPACE: 5.0,
		DEEP_SPACE_MAX_CAP: 1800.0,
		DYN_SCALE_ETA: 0.04
	},

	DIST_THRESHOLDS_M: {
		CLOSE: 1000000,       // 1,000 km
		MEDIUM: 10000000,     // 10,000 km
		FAR: 50000000,        // 50,000 km
		MOON_ORBIT: 500000000 // 500,000 km
	},
	// Sampling intervals and delta thresholds
	SAMPLING: {
		TIME_LIFTOFF_S: 0.1,
		LIFTOFF_PHASE_TIME_S: 15.0,
		LIFTOFF_PHASE_ALT_M: 10000,
		TIME_POWERED_S: 1.0,
		POST_BURNOUT_DURATION_S: 120.0,
		TIME_POST_BURNOUT_S: 1.0,
		TIME_COAST_S: 1800.0,
		ANGLE_DELTA_RAD: 0.02,
		TIME_ANGLE_S: 5.0,
		NEAR_BODY_DIST_M: 10000000,
		TIME_NEAR_BODY_S: 15.0
	},
	// Event detection thresholds
	EVENTS: {
		IMPACT_MIN_TIME_S: 5.0,
		PITCH_MIN_TIME_S: 1.0,
		PITCH_ANGLE_RAD: 0.03,
		PITCH_MIN_ALT_M: 1000,
		PITCH_DEFAULT_ALT_M: 500,
		MAX_Q_DEFAULT_ALT_M: 15000,
		APOAPSIS_MIN_TIME_S: 30.0,
		APOAPSIS_MIN_ALT_M: 20000,
		APOAPSIS_DESCENDING_VV_M_S: -1.0,
		APOAPSIS_MIN_STEP: 20,
		ORBIT_MIN_ALT_M: 100000,
		ORBIT_CIRC_RATIO: 0.95,
		ORBIT_RADIAL_VEL_MIN: -50.0,
		ORBIT_HORIZONTAL_VEL_MIN_M_S: 7500.0
	},
	// Fallback synchronous simulation limits
	SYNC: {
		MAX_STEPS: 400,
		MAX_FLIGHT_TIME_S: 3600,
		DT_LOW_ALT: 0.5,
		DT_MID_ALT: 2.0,
		DT_HIGH_ALT: 6.0,
		ALT_BOUNDARY_LOW_M: 80000,
		ALT_BOUNDARY_MID_M: 500000,
		POWERED_CUTOFF_S: 200
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
		ORBITAL_VELOCITY_KM_S: 7.5 // km/s
	}
};

// Flight computer
export const FLIGHT_COMPUTER_CONFIG = {
	TOWER_CLEARANCE_TIME: 10,
	TOWER_CLEARANCE_MIN_Q: 0.1,
	TOWER_CLEARANCE_MAX_ALT: 1000,
	MAX_TURN_RATE_PER_SEC: 0.1,
	COAST_TURN_RATE_PER_SEC: 1.5,
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
	DEFAULT_ISP: 320,
	APOGEE_MIN_ALT_M: 100000,
	ORBITAL_CUTOFF_MIN_ALT_M: 140000,
	ORBITAL_CUTOFF_SAFE_PE_KM: 180.0,
	ORBITAL_CUTOFF_MAX_ECC: 0.03,
	ORBITAL_CUTOFF_CIRCULAR_MIN_PE_KM: 140.0,
	COMMANDED_CUTOFF_MIN_FLIGHT_TIME_SEC: 15.0,
	SUN_POINTING_TURN_RATE_PER_SEC: 1.5,
	MIN_SUN_DIST_SQ: 1.0
};

// Communication buffer structure
export const CALC_BUFFER_CONFIG = {
	OBJ_ATTR_COUNT: 45
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
	TM_TANK_PRES_FUEL: 40, TM_TANK_PRES_OXID: 41,
	TM_STAGE_INDEX: 42, TM_TOTAL_STAGES: 43, DEBRIS_SUB_TYPE: 44
};

export const OBJECT_STATE = {
	"ACTIVE": 0,
	"REMOVED": 1,
	"HISTORY_DONE": 2,
};

export const OBJECT_TYPES = { CELESTIAL: 0, ROCKET: 1, DEBRIS: 2 };
export const TRAIL_MODE = { NORMAL: 0, ATMOSPHERE: 1, ESCAPE: 2 };

export const LAUNCH_SEQUENCES = {
	LAUNCH_TO_COMPLETION_TIME: 10,
	LEGACY_QUICK: {
		tMinusOffset: 3,
		events: [
			{ time: 0, name: "TERMINAL COUNTDOWN START", command: "START_COUNTDOWN" },
			{ time: 1, name: "TANK PRESSURIZATION", command: "PRESSURIZE_TANK" },
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
				{ id: "tower_clear", type: "relativeAltM", operator: ">", value: 120, audio: "fl_tower_clear", once: true },
				{ id: "pitch_roll", type: "relativeAltM", operator: ">", value: 500, audio: "fl_pitch_roll", once: true },
				{ id: "pitch_downrange", type: "relativeAltM", operator: ">", value: 2000, audio: "fl_pitch_downrange", once: true },
				{ id: "approach_maxq", type: "status", operator: "==", value: 2, audio: "fl_approach_maxq", once: true },
				{ id: "traj_nominal", type: "met", operator: ">", value: 45, audio: "fl_traj_nominal", once: true },
				{ id: "telemetry_good", type: "met", operator: ">", value: 80, audio: "fl_telemetry_good", once: true },
				{ id: "srb_sep", type: "isBoosterSeparated", operator: "==", value: true, audio: "fl_srb_sep", once: true },
				{ id: "meco", type: "isMeco", operator: "==", value: true, audio: "fl_meco", once: true },
				{ id: "stage1_sep", type: "isStage1Separated", operator: "==", value: true, audio: "fl_1-stage_sep", once: true },
				{ id: "ses", type: "isSes", operator: "==", value: true, audio: "fl_ses", once: true },
				{ id: "fairing_sep", type: "isFairingSeparated", operator: "==", value: true, audio: "fl_fairing_sep", once: true },
				{ id: "seco", type: "isSeco", operator: "==", value: true, audio: "fl_seco", once: true },
				{ id: "stage2_sep", type: "isStage2Separated", operator: "==", value: true, audio: "fl_2-stage_sep", once: true },
				{ id: "pes", type: "isPes", operator: "==", value: true, audio: "fl_pes", once: true },
				{ id: "peco", type: "isPeco", operator: "==", value: true, audio: "fl_peco", once: true }
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
				{ id: "tower_clear", type: "relativeAltM", operator: ">", value: 120, audio: "fl_tower_clear", once: true },
				{ id: "pitch_roll", type: "relativeAltM", operator: ">", value: 500, audio: "fl_pitch_roll", once: true },
				{ id: "pitch_downrange", type: "relativeAltM", operator: ">", value: 2000, audio: "fl_pitch_downrange", once: true },
				{ id: "approach_maxq", type: "status", operator: "==", value: 2, audio: "fl_approach_maxq", once: true },
				{ id: "traj_nominal", type: "met", operator: ">", value: 45, audio: "fl_traj_nominal", once: true },
				{ id: "telemetry_good", type: "met", operator: ">", value: 80, audio: "fl_telemetry_good", once: true },
				{ id: "srb_sep", type: "isBoosterSeparated", operator: "==", value: true, audio: "fl_srb_sep", once: true },
				{ id: "meco", type: "isMeco", operator: "==", value: true, audio: "fl_meco", once: true },
				{ id: "stage1_sep", type: "isStage1Separated", operator: "==", value: true, audio: "fl_1-stage_sep", once: true },
				{ id: "ses", type: "isSes", operator: "==", value: true, audio: "fl_ses", once: true },
				{ id: "fairing_sep", type: "isFairingSeparated", operator: "==", value: true, audio: "fl_fairing_sep", once: true },
				{ id: "seco", type: "isSeco", operator: "==", value: true, audio: "fl_seco", once: true },
				{ id: "stage2_sep", type: "isStage2Separated", operator: "==", value: true, audio: "fl_2-stage_sep", once: true },
				{ id: "pes", type: "isPes", operator: "==", value: true, audio: "fl_pes", once: true },
				{ id: "peco", type: "isPeco", operator: "==", value: true, audio: "fl_peco", once: true }
			]
		}
	}
};

// Flight Event Definitions (Table-driven markers for trajectory prediction & telemetry)
export const DEFAULT_FLIGHT_EVENTS = [
	{
		id: 'liftoff',
		name: 'LIFTOFF',
		type: 'liftoff',
		enabled: false,
		description: 'Liftoff and release of hold-down'
	},
	{
		id: 'pitch',
		name: 'PITCH',
		type: 'pitch',
		minAngleDeg: 0.5,
		enabled: true,
		description: 'Pitch maneuver start (Gravity turn program)'
	},
	{
		id: 'maxq',
		name: 'MAX-Q',
		type: 'maxq',
		enabled: true,
		description: 'Maximum dynamic pressure'
	},
	{
		id: 'staging',
		name: 'STG-SEP',
		type: 'alt',
		value: 65000,
		enabled: false,
		description: 'First stage separation'
	},
	{
		id: 'fairing',
		name: 'FAIRING',
		type: 'alt',
		value: 110000,
		enabled: false,
		description: 'Payload fairing separation (Karman line / 110km)'
	},
	{
		id: 'meco',
		name: 'MECO',
		type: 'meco',
		enabled: true,
		description: 'Main engine cutoff'
	},
	{
		id: 'ap',
		name: 'AP',
		type: 'apoapsis',
		enabled: true,
		description: 'Apoapsis (highest orbital point)'
	},
	{
		id: 'orbit',
		name: 'ORBIT',
		type: 'orbit',
		enabled: true,
		description: 'Orbital velocity reached'
	},
	{
		id: 'impact',
		name: 'IMPACT',
		type: 'impact',
		enabled: true,
		description: 'Surface impact point'
	}
];

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

// Multi-stage rocket parameters and presets
export const MULTISTAGE_ROCKET = {
	DEFAULT_SEPARATION_DELAY_SEC: 3.0,
	DEFAULT_IGNITION_DELAY_SEC: 2.0,
	DEFAULT_JETTISON_SPEED_M_S: 18.0,
	STAGE2_DEORBIT_DELTA_V_M_S: 180.0,
	STAGE2_DEORBIT_BURN_ENABLED: true,
	ORBITAL_CUTOFF_MIN_ALT_M: 140000,
	ORBITAL_CUTOFF_SAFE_PE_KM: 180.0,
	ORBITAL_CUTOFF_MAX_ECC: 0.03,
	ORBITAL_CUTOFF_CIRCULAR_MIN_PE_KM: 140.0,
	COMMANDED_CUTOFF_MIN_FLIGHT_TIME_SEC: 15.0,
	FAIRING_DEFAULT_ALT_KM: 110,
	STG_SEP_LAMP_DURATION_SEC: 3.5,
	STAGE_SEP_FORWARD_PUSH_M_S: 1.5,
	FAIRING_SEP_LATERAL_SPEED_M_S: 8.0,
	FAIRING_SEP_BACKWARD_SPEED_M_S: -2.0,
	BOOSTER_SEP_LATERAL_SPEED_M_S: 12.0,
	BOOSTER_SEP_BACKWARD_SPEED_M_S: -1.0,
	STAGE1_RADIUS_RATIO: 1.0,
	STAGE2_RADIUS_RATIO: 1.0,
	FAIRING_RADIUS_RATIO: 1.0,
	DEFAULT_STAGE_RADIUS_M: 63.0,
	PAYLOAD_DEFAULT_RADIUS_M: 2.0,
	DEBRIS_SPECS: {
		1: {
			name: 'Stage 1 Booster',
			color: '#c85a1a',
			size: 5.5,
			rotationSpeedRand: 0.0015
		},
		2: {
			name: 'Stage 2 Upper Stage',
			color: '#e2e6ea',
			size: 4.5,
			rotationSpeedRand: 0.0015
		},
		3: {
			name: 'Fairing Half',
			color: '#e8ebed',
			size: 4.0,
			rotationSpeedRand: 0.0015
		},
		4: {
			name: 'SRB-3 Booster',
			color: '#f0f2f5',
			size: 4.8,
			rotationSpeedRand: 0.002
		}
	},
};


// Pad Effect Constants
export const PAD_EFFECT = {
	STRUCTURE: {
		STRONGBACK_RETRACT_SPEED: 8,
		STRONGBACK_MAX_ANGLE: 25,
		UMBILICAL_RETRACT_SPEED: 40,
		UMBILICAL_MAX_ANGLE: 22,
		UMBILICAL_OFFSET_X: -0.6,
		UMBILICAL_OFFSET_Y: -1.4,
		BASE_COLOR: "#333333",
		TRUSS_COLOR: "#555555",
		TRUSS_HIGHLIGHT: "#777777",
		CABLE_BASE_COLOR: "#222222",
		CABLE_HIGH_COLOR: "#ff6600",
		JOINT_COLOR: "#aaaaaa",
		GLOW_COLOR: "#ffaa00",
		GLOW_BLUR_MULT: 1.5,
		BASE_X_MULT: -3.5,
		BASE_X_OFFSET_MULT: -1.0,
		BASE_Y_MULT: -2.2,
		BASE_W_MULT: 1.2,
		BASE_H_MULT: 4.4,
		MOUNT_COLOR: "#222222",
		MOUNT_THICKNESS_MULT: 0.35,
		MOUNT_WIDTH_HALF_MULT: 0.9,
		MOUNT_WIDTH_MULT: 1.8,
		PEDESTAL_OFFSET_X_MULT: 0.2,
		PEDESTAL_HALF_MULT: 0.7,
		PEDESTAL_W_MULT: 0.4,
		PEDESTAL_H_MULT: 1.4,
		JOINT_RADIUS_MULT: 0.08,
		STRONGBACK_X_MULT: -1.5,
		STRONGBACK_TOP_X_MULT: 2.2,
		STRONGBACK_Y_MULT: 1.3,
		STRONGBACK_W_MULT: 2.5,
		STRONGBACK_H_MULT: 0.55,
		STRONGBACK_TRUSS_CROSS: 4,
		STRONGBACK_TRUSS_WIDTH_MULT: 0.08,
		STRONGBACK_MIN_BAYS: 5,
		STRONGBACK_BAY_INTERVAL_MULT: 0.6,
		UMBILICAL_TOP_X_MULT: 1.6,
		UMBILICAL_W_MULT: 1.5,
		UMBILICAL_H_MULT: 0.5,
		UMBILICAL_ARM_LEN_MULT: 0.7,
		UMBILICAL_ARM_THICK_MULT: 0.65,
		UMBILICAL_MIN_BAYS: 4,
		UMBILICAL_BAY_INTERVAL_MULT: 0.6,
		UMBILICAL_TRUSS_WIDTH_MULT: 0.04,
		ARM_STRUT_ROOT_MULT: 2.2,
		ARM_STRUT_TIP_MULT: 0.85,
		CABLE_CONN_X_MULT: 0.8,
		CABLE_CONN_Y_MULT: -0.7,
		CABLE_SAG_X_MULT: -0.2,
		CABLE_SAG_Y_MULT: -1.15,
		CABLE_DEFAULT_SAG_OFFSET_X: 0.7,
		CABLE_DEFAULT_SAG_OFFSET_Y: 0.35,
		CABLE_WIDTH_MULT: 0.10,
		CABLE_HIGH_WIDTH_MULT: 0.045,
		CABLE_MIN_WIDTH_PX: 3.5,
		CABLE_MIN_HIGH_WIDTH_PX: 1.8,
		CABLE_JOINT_SIZE_MULT: 0.45,
		CABLE_JOINT_OFFSET_X_MULT: 0.3,
		CABLE_JOINT_OFFSET_Y_MULT: 0.5,
		CABLE_NODES: 10,
		CABLE_MAX_SUB_DT: 0.05,
		CABLE_PHYSICS_FREQ: 60,
		CABLE_GRAVITY: 8.0,
		CABLE_DAMPING: 0.99,
		CABLE_CONSTRAINT_ITERATIONS: 10,
		CABLE_SWING_IMPULSE: 0.5,
		CABLE_IMPULSE_Y_MULT: 0.15,
		CABLE_IMPULSE_X_MULT: 0.08
	},
	PHYSICS: {
		FALL_V_MULT: 5,
		DRAG_NORM_DT: 60,
		NOZZLE_OFFSET_MULT: 3.1,
		SIDE_OFFSET_MULT: 1,
		MIN_VISUAL_RADIUS_PX: 2,
		DEFAULT_ROCKET_RADIUS_M: 63,
		DEFAULT_PARTICLE_SIZE: 0.2,
		MIN_PARTICLE_DRAW_SIZE: 0.5,
		MAX_STRETCH_FACTOR: 8.0,
		MIN_STRETCH_FACTOR: 1.0,
		STRETCH_SPEED_SCALE: 0.03
	},
	EMITTER: {
		ICE: { COUNT: 30, OFFSET_MULT: 1.5, V_RAND: 5, SPREAD_RAND: 2, LIFE_BASE: 0.5, LIFE_RAND: 1.5 },
		PURGE_SPARK: { COUNT: 15, V_RAND: 20, LIFE_BASE: 0.5 },
		VENT: { RATE: 0.06, PRESSURIZED_RATE: 0.02, COUNT: 5, V_BASE: 6, V_RAND: 60, SPREAD_ANGLE_RAD: Math.PI / 2, OFFSET_X_MULT: 0.8, OFFSET_Y_MULT: 0.2, LIFE_BASE: 2.5, LIFE_RAND: 1.0, SIZE: 0.02, SIZE_RAND: 0.05 },
		CHILL: { RATE: 0.3, COUNT: 1, V_RAND: 2, LIFE_BASE: 1.2, SIZE: 0.2 },
		DELUGE: {
			COUNT: 6,
			V_SIDE_BASE: 18,
			V_SIDE_RAND: 14,
			V_UP_BASE: 12,
			V_UP_RAND: 8,
			LIFE_BASE: 3.5,
			LIFE_RAND: 0.5,
			SIZE: 0.35,
			SIZE_RAND: 0.1,
			LATERAL_OFFSET_MULT: 1.15,
			HEAD_SPREAD_MULT: 0.4,
			SPREAD_ANGLE_RAD: 0.35,
			SIDE_HEADS: 3
		},
		ROFI: { COUNT: 3, V_RAND: 15, LIFE_BASE: 0.8, SIZE: 0.1 }
	},
	PARTICLES: {
		'smoke_white': { COLOR: "#dddddd", SHAPE: 'circle', DRAG: 0.94, GROW_SPEED: 0.25, GRAVITY_MULT: 0.1, SIZE_MULT: 0.25, MAX_ALPHA: 0.35 },
		'chill':       { COLOR: "#aaddff", SHAPE: 'circle', DRAG: 0.98, GROW_SPEED: 0.2, GRAVITY_MULT: 0, SIZE_MULT: 0.5, MAX_ALPHA: 1.0 },
		'deluge':      { COLOR: "#d4f0ff", SHAPE: 'stretch', DRAG: 0.98, GROW_SPEED: 0.45, GRAVITY_MULT: 0.05, SIZE_MULT: 0.6, MAX_ALPHA: 0.45 },
		'spark':       { COLOR: "#ffdd55", SHAPE: 'circle', DRAG: 1.0, GROW_SPEED: 0.0, GRAVITY_MULT: 0, SIZE_MULT: 0.2, MAX_ALPHA: 1.0 },
		'ice':         { COLOR: "#ffffff", SHAPE: 'square', DRAG: 1.0, GROW_SPEED: 0.0, GRAVITY_MULT: 0.5, SIZE_MULT: 0.2, MAX_ALPHA: 1.0 }
	}
};

export const SOUND = {
	BASEDIR: "./sounds",
};

// Pressure simulation parameters
export const TANK_PRESSURE_SIM = {
	GROUND_KPA: 101.3,
	UNPRESSURIZED_KPA: 101.3,
	TARGET_KPA: 350.0,
	PRESS_LAMP_THRESHOLD_KPA: 300.0,
	MAX_SCALE_KPA: 500.0,
	ROLLOUT_FILL_TIME_SEC: 3.5,
	PRESSURIZE_TIME_SEC: 4.0,
	BASE_NOISE_KPA: 1.5,
	Q_NOISE_RATIO: 0.03,
	Q_NORMALIZATION_KPA: 40.0,
	Q_FACTOR_MAX: 1.5,
	NOISE_LPF_ALPHA: 0.7,
	RESONANCE_FREQ_F: 15.0,
	RESONANCE_FREQ_O: 18.0,
	RESONANCE_PHASE_O: 1.2,
	RESONANCE_AMP_RATIO: 0.4,
	RAW_NOISE_AMP_RATIO: 0.6,
	FIRING_DETECT_THROTTLE: 0.05,
	IGNITION_DROP_RATIO: 0.88,
	IGNITION_TRANSIENT_TIME_SEC: 1.2,
	IGNITION_DROP_PHASE: 0.25,
	IGNITION_OVERSHOOT_PHASE: 0.60,
	IGNITION_OVERSHOOT_RATIO: 0.04,
	OXIDIZER_OVERSHOOT_FACTOR: 1.05,
	MECO_SPIKE_RATIO: 1.12,
	MECO_TRANSIENT_TIME_SEC: 1.0,
	MECO_SPIKE_PHASE: 0.20,
	MECO_DECAY_RATE: 3.5,
	OXIDIZER_MECO_FACTOR: 1.08,
	POST_MECO_SAFE_KPA: 110.0,
	POST_MECO_VENT_TIME_SEC: 2.0,
	DEPLETION_DROP_RATE: 120.0
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

/**
 * Common Object Physics Flags (Bits 0-4)
 */
export const OBJECT_FLAG = Object.freeze({
	COLLIDED:      1 << 0,
	SHATTERED:     1 << 1,
	IMPACT:        1 << 2,
	IN_ATMOSPHERE: 1 << 3,
	ESCAPING:      1 << 4
});

/**
 * Rocket Telemetry Bitmask Flags (Bits 5-15)
 */
export const ROCKET_FLAG = Object.freeze({
	HOLD_DOWN:          1 << 5,
	IGNITED:            1 << 6,
	ANTI_STALL:         1 << 7,
	Q_LIMIT_NEAR:       1 << 8,
	G_LIMIT_NEAR:       1 << 9,
	BOOSTER_BURNOUT:    1 << 10,
	BOOSTER_SEPARATED:  1 << 11,
	FAIRING_SEPARATED:  1 << 12,
	STAGE1_SEPARATED:   1 << 13,
	STAGE2_SEPARATED:   1 << 14,
	PAYLOAD_SEPARATED:  1 << 15
});
