
const METERS_PER_AU = 149597870700; // 1 AU in meters
const YEARS_PER_SECOND = 60*60*24*365.25; // 1 year in seconds

const HISTORY_LENGTH = 512; // History length
const DISTANCE_SCALE = 180; // AU/px
const THROW_SCALE = 4e16;
const TIME_SCALE = 1e3;

const DEFAULT_OBJECT_PARAMS = {
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

const OBJECT_STATE = {
	"ACTIVE": 0,
	"REMOVED": 1,
	"HISTORY_DONE": 2,
};

function AU2M(au) {
	return au * METERS_PER_AU;
}
function M2AU(m) {
	return m / METERS_PER_AU;
}

/*******************************************************************
 * GravSimObject class that represents a celestial object in the universe.
 * @property {string} name - The name of the object.
 * @property {number} x - The x-coordinate of the object in pixels.
 * @property {number} y - The y-coordinate of the object in pixels.
 * @property {number} vx - The x-component of the object's velocity in pix/sec.
 * @property {number} vy - The y-component of the object's velocity in pix/sec.
 * @property {number} ax - The x-component of the object's acceleration in pix/sec^2.
 * @property {number} ay - The y-component of the object's acceleration in pix/sec^2.
 * @property {number} mass - The mass of the object in tons.
 * @property {string} color - The color of the object in hex format.
 * @property {number} size - The size of the object in pixels.
 * @property {number} state - The state of the object (active, removed, etc.).
 * @property {Array} history - The history of the object's positions, stored as an array of objects with x and y properties.
*******************************************************************/
class GravSimObject {
	constructor(name, x, y, vx, vy, mass, color, size, radius) {
		GravSimObject._idCounter = (GravSimObject._idCounter || 0);

		this.name = name;
		this.id = GravSimObject._idCounter;
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.ax = 0;
		this.ay = 0;
		this.mass = mass;       // ton
		this.color = color;
		this.size = size;
		this.radius = radius;	// meters
		this.state = OBJECT_STATE.ACTIVE;
		this.history = [];

		GravSimObject._idCounter++;
	}

	addHistory() {
		if (this.state !== OBJECT_STATE.ACTIVE) {
			return;
		}

		if( this.name == DEFAULT_OBJECT_PARAMS["Sun"].NAME ) {
			return;
		}

		if (this.history.length >= HISTORY_LENGTH) {
			this.history.shift();
		}
		this.history.push({ x: this.x, y: this.y });
	}

	updateHistory() {
		if (this.state === OBJECT_STATE.ACTIVE) {
			return;
		}

		if( this.name == DEFAULT_OBJECT_PARAMS["Sun"].NAME ) {
			return;
		}

		if (this.history.length > 0) {
			this.history.shift();
		}
	}

	finished() {
		if( this.state === OBJECT_STATE.REMOVED
			&& this.history.length === 0
		) {
			return true;
		}
		return false;
	}

	setCollided() {
		if( this.name == DEFAULT_OBJECT_PARAMS["Sun"].NAME ) {
			return;
		}

		this.state = OBJECT_STATE.REMOVED;
	}

	setPosition(x, y) {
		this.x = x;
		this.y = y;
	}

	setVelocity(vx, vy) {
		this.vx = vx;
		this.vy = vy;
	}

	resetGravity() {
		this.ax = 0;
		this.ay = 0;
	}

	getRelativeX(basis) {
		if( basis ) {
			return this.x - basis.x;
		} else {
			return this.x;
		}
	}
	getRelativeY(basis) {
		if( basis ) {
			return this.y - basis.y;
		} else {
			return this.y;
		}
	}

	getRelativeHistryX(i, basis) {
		if( basis ) {
			return this.history[i].x - basis.x;
		} else {
			return this.history[i].x;
		}
	}
	getRelativeHistryY(i, basis) {
		if( basis ) {
			return this.history[i].y - basis.y;
		} else {
			return this.history[i].y;
		}
	}

	transformRelativeCordinate(basis) {
		if( this.state != OBJECT_STATE.ACTIVE || basis.state != OBJECT_STATE.ACTIVE ) {
			return;
		}

		this.x += basis.vx;
		this.y += basis.vy;

		for (let i = 0; i < this.history.length; i++) {
			this.history[i].x += basis.vx;
			this.history[i].y += basis.vy;
		}
	}

	draw(ctx, basis, scale) {
		ctx.fillStyle = this.color;

		if( this.state === OBJECT_STATE.ACTIVE) {
			ctx.beginPath();
			ctx.arc(this.getRelativeX(basis), this.getRelativeY(basis), this.size *scale, 0, Math.PI * 2);
			ctx.fill();
		}

		// Draw history with fading color and thinning line
		for (let i = 1; i < this.history.length; i++) {
			const t = i / this.history.length; // 0 (oldest) to 1 (newest)
			const alpha = t * 0.4 + 0.2; // fade in (0.2~1.0)
			const width = this.size * (0.2 + 0.8 * t) *scale; // thin to thick

			ctx.strokeStyle = hexToRgba(this.color, alpha);
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(this.getRelativeHistryX(i - 1, basis), this.getRelativeHistryY(i - 1, basis));
			ctx.lineTo(this.getRelativeHistryX(i, basis), this.getRelativeHistryY(i, basis));
			ctx.stroke();
		}
		ctx.lineWidth = 1;

		// Helper: convert hex color to rgba
		function hexToRgba(hex, alpha) {
			let c = hex.replace('#', '');
			if (c.length === 3) c = c.split('').map(x => x + x).join('');
			const num = parseInt(c, 16);
			const r = (num >> 16) & 255;
			const g = (num >> 8) & 255;
			const b = num & 255;
			return `rgba(${r},${g},${b},${alpha})`;
		}
		ctx.stroke();
	}
}

/*******************************************************************
 * InfoPanel class that manages the information panel.
 * @property {HTMLElement} panel - The HTML element for the info panel.
 * @property {number} elapsedTime - The elapsed time in years.
*******************************************************************/
class InfoPanel {
	constructor() {
		this.panel = document.getElementById('info-panel');
		if (!this.panel) {
			throw new Error("Info panel element with id 'info-panel' not found.");
		}

		this.elapsedTime = 0; // in years
		this.lastTime = new Date();
		this.fpsCount = 0;
	}

	resetElapsedTime() {
		this.elapsedTime = 0;
	}

	updateElapsedTime(dt) {
		const elapsedTimeSpan = document.getElementById('elapsed-time');
		this.elapsedTime += dt /YEARS_PER_SECOND;
		if (elapsedTimeSpan) {
			const years = (this.elapsedTime).toFixed(2);
			elapsedTimeSpan.textContent = `${years}`;
		}
	}

	updateObjectCount(counts) {
		const objectCountSpan = document.getElementById('object-count');
		if( objectCountSpan ) {
			objectCountSpan.textContent = `${counts}`;
		}
	}

	updateFPS() {
		const fpsSpan = document.getElementById('fps');
		if (!fpsSpan) {
			console.error("FPS element with id 'fps' not found.");
			return;
		}

		const now = new Date();
		const elapsed = now - this.lastTime;

		this.fpsCount++;
		if( elapsed >= 500 ) {
			const fps = (this.fpsCount / (elapsed / 1e3)).toFixed(1);
			fpsSpan.textContent = `${fps}`;
			
			this.lastTime = now;
			this.fpsCount = 0;
		}
	}
}

/*******************************************************************
 * ControlPanel class that manages the simulation control panel UI.
 * 
 * @property {HTMLInputElement} timeScaleInput - The input element for adjusting the simulation time scale.
 * @property {HTMLElement} timeScaleIndicator - The element displaying the current time scale value.
 * @property {HTMLSelectElement} massSelect - The select element for choosing the type of object to place.
*******************************************************************/
class ControlPanel {
	constructor(universe) {
		this.universe = universe;

		this.timeScaleInput = document.getElementById('time-scale');
		this.timeScaleIndicator = document.getElementById('time-scale-indicator');
		this.zoomScaleInput = document.getElementById('zoom-scale');
		this.zoomScaleIndicator = document.getElementById('zoom-scale-indicator');
		this.massSelect = document.getElementById('mass-select');

		this.generateMassSelect();
	
		this.timeScaleInput.addEventListener('input', function(e) {
			this.updateTimeScaleIndicator(this.timeScaleInput.value);
		}.bind(this));
	
		this.zoomScaleInput.addEventListener('input', function(e) {
			this.updateZoomScaleIndicator(this.zoomScaleInput.value);
		}.bind(this));

		this.universe.canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			let val = parseFloat(this.zoomScaleInput.value);
			const max = this.zoomScaleInput.max;
			const min = this.zoomScaleInput.min;
			const step = ((e.deltaY < 0) ? 1 : -1) *this.zoomScaleInput.step;
			val += step;
			if( val > max ) { val = max *1.0; }
			else if( val < min ) { val = min *1.0; }
			this.zoomScaleInput.value = val.toFixed(2);
			this.updateZoomScaleIndicator(val);
			this.universe.updateZoomScale();
		});
		
		document.getElementById('put-saturn-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Saturn");
		}.bind(this));
		document.getElementById('put-jupiter-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Jupiter");
		}.bind(this));
		document.getElementById('put-earth-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Earth");
		}.bind(this));
		document.getElementById('put-venus-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Venus");
		}.bind(this));
		document.getElementById('put-mars-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Mars");
		}.bind(this));
		document.getElementById('put-mercury-btn').addEventListener('click', function(e) {
			this.universe.ObjectPlacer.placeAtOrbitAroundSun("Mercury");
		}.bind(this));
	}

	updateTimeScaleIndicator(val) {
		if (this.timeScaleIndicator) {
			this.timeScaleIndicator.textContent = parseFloat(val).toFixed(2);
		}
	}

	updateZoomScaleIndicator(val) {
		if (this.zoomScaleIndicator) {
			this.zoomScaleIndicator.textContent = parseFloat(val).toFixed(2);
		}
	}

	generateMassSelect() {
		if(!this.massSelect) {
			return;
		}

		this.massSelect.innerHTML = '';
		for (const key in DEFAULT_OBJECT_PARAMS) {
			const param = DEFAULT_OBJECT_PARAMS[key];
			const option = document.createElement('option');
			option.value = key;
			option.textContent = `${param.NAME} (mass: ${param.MASS.toExponential(2)} t)`;
			this.massSelect.appendChild(option);

			if (param.NAME === "Rocket") {
				option.selected = true;
			}
		}
	}

	getTimeScale() {
		if (this.timeScaleInput) {
			return parseFloat(this.timeScaleInput.value);
		}
		return 0.1; // Default time scale
	}

	getZoomScale() {
		if (this.zoomScaleInput) {
			return parseFloat(this.zoomScaleInput.value);
		}
		return 1; // Default zoom scale
	}
}

/*******************************************************************
 * ObjectPlacer class that manages the placement of objects in the universe.
 * @property {Universe} universe - The universe instance where objects are placed.
*******************************************************************/
class ObjectPlacer {
	constructor(universe) {
		this.universe = universe;
	
		universe.canvas.addEventListener('mousedown', this.setReadyForLaunch.bind(this));
		universe.canvas.addEventListener('touchstart', this.setReadyForLaunch.bind(this));
		universe.canvas.addEventListener('mouseup', this.goLaunch.bind(this));
		universe.canvas.addEventListener('touchend', this.goLaunch.bind(this));
	}

	placeObject(objName, x, y, vx = 0, vy = 0) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];
		const obj = new GravSimObject(
			param.NAME,
			x, y,
			vx, vy,
			param.MASS,
			param.COLOR,
			Math.log10((param.RADIUS || 1)*8)/2.5,
			param.RADIUS || 1,
		);
		this.universe.addObject(obj);
		return obj;
	}

	placeAtOrbit(objName, orbitCenterX, orbitCenterY) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];
		const x = orbitCenterX;
		const y = orbitCenterY - this.universe.au2pix(param.ORBIT_RADIUS || 0);
		const vx = this.universe.m2pix(param.VELOCITY || 0);
		const vy = 0;
		return this.placeObject(objName, x, y, vx, vy);
	}

	placeAtOrbitAroundHost(hostName, objName) {
		const hostObj = this.universe.objects.find(obj => obj.name === hostName);
		if (!hostObj) {
			throw new Error("Sun object not found in the universe.");
		}
		return this.placeAtOrbit(objName, hostObj.x, hostObj.y);
	}

	placeAtOrbitAroundSun(objName) {
		const sunObj = this.universe.objects.find(obj => obj.id === this.universe.centerObject.id);
		if (!sunObj) {
			throw new Error("Sun object not found in the universe.");
		}
		return this.placeAtOrbit(objName, sunObj.x, sunObj.y);
	}
	
	getLaunchPosition(e) {
		const centerX = this.universe.centerObject.x;
		const centerY = this.universe.centerObject.y;
		const zoomScale = this.universe.zoomScale;
		let x = 0, y = 0;

		if (e.touches) {
			if(e.changedTouches) {
				x = e.changedTouches[0].clientX;
				y = e.changedTouches[0].clientY;
			}
			else {
				x = e.touches[0].clientX;
				y = e.touches[0].clientY;
			}
		} else {
			x = e.clientX;
			y = e.clientY;
		}
		
		return {
			x: (x - centerX) / zoomScale + centerX,
			y: (y - centerY) / zoomScale + centerY,
		};
	}

	getLaunchObjectName() {
		const massSelect = document.getElementById('mass-select');
		if (massSelect && DEFAULT_OBJECT_PARAMS[massSelect.value]) {
			return massSelect.value;
		}
		return 'Earth'; // Default object name
	}

	setReadyForLaunch(e) {
		const pos = this.getLaunchPosition(e);
		this.startX = pos.x;
		this.startY = pos.y;
		this.startTime = Date.now();
		this.isDragging = true;
	}

	goLaunch(e) {
		if (!this.isDragging) return; // Ensure we are in dragging state
		this.isDragging = false; // Reset dragging state
		
		const name = this.getLaunchObjectName();
		const pos = this.getLaunchPosition(e);
		const endX = pos.x;
		const endY = pos.y;
		const endTime = Date.now();
		const dt = Math.max((endTime - this.startTime) / TIME_SCALE, 0.01);
		const vx = this.universe.pix2m((endX - this.startX) / dt / THROW_SCALE);
		const vy = this.universe.pix2m((endY - this.startY) / dt / THROW_SCALE);
		
		this.placeObject(
			name,
			endX, endY,
			vx, vy
		);
		
		this.startX = null; // Reset start position
		this.startY = null;
	}

}

/*******************************************************************
 * CalcWorkerManager class that manages the calculation worker for physics simulation.
 * @property {Worker} worker - The Web Worker instance for handling calculations.
*******************************************************************/
class CalcWorkerManager {
	constructor() {
		this.worker = new Worker('./gravsim_calc.js');
		this.worker.onmessage = this.handleMessage.bind(this);
	}

	handleMessage(e) {
		const data = e.data;
		switch(data.cmd) {
		case 'update':
			window.universe.updateObjectParams(data);
			break;
		default:
			console.error('Unknown command from worker:', data.cmd);
		}
	}

	postMessage(msg) {
		this.worker.postMessage(msg);
	}

	setTimeScale(timeScale) {
		this.worker.postMessage({
			cmd: 'setTimeScale',
			timeScale: timeScale
		});
	}

	destroy() {
		this.worker.terminate();
	}
}

/*******************************************************************
 * Universe class that manages the simulation of celestial objects.
 * @property {HTMLCanvasElement} canvas - The canvas element for rendering.
 * @property {CanvasRenderingContext2D} ctx - The 2D rendering context for the canvas.
 * @property {Array} objects - The array of celestial objects in the universe.
 * @property {InfoPanel} InfoPanel - The information panel for displaying simulation data.
 * @property {ControlPanel} ControlPanel - The control panel for simulation settings.
 * @property {ObjectPlacer} ObjectPlacer - The object placer for adding new objects to the universe.
 * @property {number} timeScale - The scale factor for time progression in the simulation.
*******************************************************************/
class Universe {
	constructor(_canvas) {
		this.canvas = _canvas;
		this.ctx = _canvas.getContext('2d');
		this.objects = [];
		this.centerObject = null;
		this._initInput();
		this.InfoPanel = new InfoPanel();
		this.ControlPanel = new ControlPanel(this);
		this.ObjectPlacer = new ObjectPlacer(this);
		this.CalcWorkerManager = new CalcWorkerManager();
		this.timeScale = this.ControlPanel.getTimeScale();
		this.zoomScale = this.ControlPanel.getZoomScale();

		this.reset();
	}
	
	pix2au(px) {
		return px / DISTANCE_SCALE;
	}
	au2pix(au) {
		return au * DISTANCE_SCALE;
	}
	m2pix(m) {
		return this.au2pix(M2AU(m));
	}
	pix2m(px) {
		return AU2M(this.pix2au(px));
	}

	updateObjectParams(data) {
		data.objects.forEach(obj => {
			const target = this.objects.find(target => target.id === obj.id);
			if (target) {
				target.x = this.m2pix(obj.x);
				target.y = this.m2pix(obj.y);
				target.vx = this.m2pix(obj.vx);
				target.vy = this.m2pix(obj.vy);
				target.ax = this.m2pix(obj.ax);
				target.ay = this.m2pix(obj.ay);
				target.mass = obj.mass /1e3;
				target.radius = obj.radius;
				target.addHistory();

				if( obj.collided === true ) {
					target.setCollided();
				}
			}
		});
	}

	destroy() {
		for (let i = 0; i < this.objects.length; i++) {
			this.removeObject(this.objects[i]);
			delete this.objects[i];
		}
		this.objects = [];
	}

	_initInput() {
		this.canvas.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.reset();
		});
	}

	reset() {
		this.destroy();

		const centerX = this.canvas.width / 2;
		const centerY = this.canvas.height / 2;
		this.ObjectPlacer.placeObject('Sun', centerX, centerY, 0, 0);
		this.centerObject = this.objects[0];
	}

	draw() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.save();
		this.ctx.translate(this.centerObject.x, this.centerObject.y);
		this.ctx.scale(this.zoomScale, this.zoomScale);
		for (const obj of this.objects) {
			obj.draw(this.ctx, this.centerObject, 1/this.zoomScale);
		}
		this.ctx.restore();
	}

	addObject(obj) {
		if (!(obj instanceof GravSimObject)) {
			throw new Error("Invalid object type. Must be an instance of GravSimObject class.");
		}
		this.objects.push(obj);
		this.CalcWorkerManager.postMessage({
			cmd: 'add',
			id: obj.id,
			x: this.pix2m(obj.x), y: this.pix2m(obj.y),
			vx: this.pix2m(obj.vx), vy: this.pix2m(obj.vy),
			ax: this.pix2m(obj.ax), ay: this.pix2m(obj.ay),
			mass: obj.mass *1e3,
			radius: obj.radius,
		});
	}

	removeObject(obj) {
		if (!(obj instanceof GravSimObject)) {
			throw new Error("Invalid object type. Must be an instance of GravSimObject class.");
		}
		obj.setCollided();
		this.CalcWorkerManager.postMessage({
			cmd: 'remove',
			id: obj.id,
		});
	}

	updateObject(obj) {
		if (!(obj instanceof GravSimObject)) {
			throw new Error("Invalid object type. Must be an instance of GravSimObject class.");
		}
		this.CalcWorkerManager.postMessage({
			cmd: 'update',
			id: obj.id,
			x: this.pix2m(obj.x), y: this.pix2m(obj.y),
			vx: this.pix2m(obj.vx), vy: this.pix2m(obj.vy),
			ax: this.pix2m(obj.ax), ay: this.pix2m(obj.ay),
			mass: obj.mass *1e3,
			radius: obj.radius,
		});
	}

	transformRelativeToCenterObject() {
		if (!this.centerObject) return;

		for (const obj of this.objects) {
			obj.transformRelativeCordinate(this.centerObject);
			this.updateObject(obj);
		}

		this.centerObject.resetGravity();
		this.centerObject.setPosition(
			this.canvas.width / 2,
			this.canvas.height / 2
		);
		this.centerObject.setVelocity(0, 0);
		this.updateObject(this.centerObject);
	}

	removeFinished() {
		this.objects = this.objects.filter(obj => !obj.finished());
	}

	updateTimeScale() {
		this.timeScale = this.ControlPanel.getTimeScale();
		this.CalcWorkerManager.setTimeScale(this.timeScale);
	}

	updateZoomScale() {
		this.zoomScale = this.ControlPanel.getZoomScale();
	}

	update(dt) {
		dt *= YEARS_PER_SECOND /TIME_SCALE *this.timeScale;

		if( this.objects.length == 1 ) {
			this.InfoPanel.resetElapsedTime();
		}
		else {
			this.InfoPanel.updateElapsedTime(dt);
		}
		this.InfoPanel.updateObjectCount(this.objects.length);
		this.InfoPanel.updateFPS();

		for (const obj of this.objects) {
			obj.updateHistory();
		}

		this.updateTimeScale();
		this.updateZoomScale();
		this.removeFinished();
		this.transformRelativeToCenterObject();
	}
}

window.onload = function() {
	const canvas = document.getElementById('gravsim-canvas');
	if (!canvas) {
		throw new Error("Canvas element with id 'gravsim-canvas' not found.");
	}

	function resizeCanvas() {
		if (window.universe && window.universe.objects.length > 0)
		{
			const prevWidth = window.universe.canvas.width;
			const prevHeight = window.universe.canvas.height;

			const newWidth = window.innerWidth;
			const newHeight = window.innerHeight;
			const vx = (newWidth - prevWidth) / 2;
			const vy = (newHeight - prevHeight) / 2;

			const sun = window.universe.objects.find(obj => obj.name === DEFAULT_OBJECT_PARAMS["Sun"].NAME);
			sun.setVelocity(vx, vy);
			
			window.universe.transformRelativeToCenterObject();
		}

		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
	}

	window.addEventListener('resize', resizeCanvas);
	resizeCanvas();

	window.universe = new Universe(canvas);

	let lastTime = performance.now();
	function animate(now) {
		const dt = now - lastTime;
		lastTime = now;
		universe.update(dt);
		universe.draw();
		requestAnimationFrame(animate);
	}
	requestAnimationFrame(animate);
};
