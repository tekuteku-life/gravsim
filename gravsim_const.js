// gravsim_const.js

// Unit
export const METERS_PER_AU = 149597870700;			// 1 AU in meters
export const YEARS_PER_SECOND = 60*60*24*365.25;	// 1 year in seconds

// physical constant
export const G = 6.67430e-11;						// Gravitational constant (m^3 kg^-1 s^-2)
export const C = 2.99792458e8;						// speed of light (m/s)

// Program setting
export const TIME_SCALE = 1e3;
export const THROW_SCALE = 4e16;

export const REMOVE_DISTANCE_AU = 80;

export const TARGET_TRAIL_LENGTH_AU = 3;			// Trail length (AU)
export const HISTORY_LENGTH = 512;					// History length
export const DISTANCE_SCALE = 180;					// AU/px

// constant definition
export const OBJECT_STATE = {
	"ACTIVE": 0,
	"REMOVED": 1,
	"HISTORY_DONE": 2,
};

// Object parameter
export const DEFAULT_OBJECT_PARAMS = {
	"BlackHole": {
		"NAME" : "BlackHole",
		"MASS" : 1.9891e30 *10 / 1e3,	// ton (10 sun)
		"COLOR" : "#333333",
		"RADIUS": 3e4,					// meters
	},
	"Sun": {
		"NAME" : "Sun",
		"MASS" : 1.9891e30 / 1e3,		// ton
		"COLOR": "#FF4500",
		"RADIUS": 6.96340e8,			// meters
	},
	"Saturn": {
		"NAME" : "Saturn",
		"MASS" : 5.6834e26 / 1e3,		// ton
		"COLOR": "#FFD700",
		"RADIUS": 5.8232e7,				// meters
		"VELOCITY": 9.69 *1e3,			// m/s
		"ORBIT_RADIUS": 9.58,			// AU
	},
	"Jupiter": {
		"NAME" : "Jupiter",
		"MASS" : 1.898e27 / 1e3,		// ton
		"COLOR": "#FF8C00",
		"RADIUS": 6.9911e7,				// meters
		"VELOCITY": 13.07 *1e3,			// m/s
		"ORBIT_RADIUS": 5.2,			// AU
	},
	"Mars": {
		"NAME" : "Mars",
		"MASS" : 6.4171e23 / 1e3,		// ton
		"COLOR": "#FF6347",
		"RADIUS": 3.3895e6,				// meters
		"VELOCITY": 24.077 *1e3,		// m/s
		"ORBIT_RADIUS": 1.524,			// AU
	},
	"Earth": {
		"NAME" : "Earth",
		"MASS" : 5.972e24 / 1e3,		// ton
		"COLOR": "#1E90FF",
		"RADIUS": 6.378e6,				// meters
		"VELOCITY": 29.78 *1e3,			// m/s
		"ORBIT_RADIUS": 1,				// AU
	},
	"Venus": {
		"NAME" : "Venus",
		"MASS" : 4.867e24 / 1e3,		// ton
		"COLOR": "#FFD700",
		"RADIUS": 6.0518e6,				// meters
		"VELOCITY": 35.02 *1e3,			// m/s
		"ORBIT_RADIUS": 0.723,			// AU
	},
	"Mercury": {
		"NAME" : "Mercury",
		"MASS" : 3.3011e23 / 1e3,		// ton
		"COLOR": "#B8860B",
		"RADIUS": 2.4397e6,				// meters
		"VELOCITY": 47.36 *1e3,			// m/s
		"ORBIT_RADIUS": 0.387,			// AU
	},
	"Moon": {
		"NAME" : "Moon",
		"MASS" : 7.34767309e22 / 1e3,	// ton
		"COLOR": "#C0C0C0",
		"RADIUS": 1.7374e6,				// meters
		"VELOCITY": 1.022 *1e3,			// m/s
		"ORBIT_RADIUS": 0.00257,		// AU
	},
	"Asteroid": {
		"NAME" : "Asteroid",
		"MASS" : 1e10 / 1e3, // ton
		"COLOR": "#808080",
		"RADIUS": 90,
	},
	"Rocket": {
		"NAME" : "Rocket",
		"MASS" : 5.75e4 / 1e3, // ton
		"COLOR": "#32CD32",
		"RADIUS": 63,
	},
};
