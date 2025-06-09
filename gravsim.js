
const HISTORY_LENGTH = 512; // 最大履歴数

// 万有引力定数 (m^3 kg^-1 s^-2)
const G = 6.67430e-11;
const METERS_PER_AU = 149597870700; // 1 AU in meters
const YEARS_PER_SECOND = 60*60*24*365.25; // 1 year in seconds

const DISTANCE_SCALE = 100; // AU/px
const THROW_SCALE = 3e17;
const TIME_SCALE = 1e3;
const COLLIDED_RADIUS_PX = AU2PIX(1/7);

const DEFAULT_OBJECT_PARAMS = {
	"Sun": {
		"NAME" : "Sun",
		"MASS" : 1.9891e30 / 1e3, // ton (Sun's mass)
		"COLOR": "#FF4500",
		"SIZE" : 6,
	},
	"Saturn": {
		"NAME" : "Saturn",
		"MASS" : 5.6834e26 / 1e3, // ton
		"COLOR": "#FFD700",
		"SIZE" : 2.5,
		"VELOCITY": AU2PIX(M2AU(9.69 *1e3)),
		"ORBIT_RADIUS": AU2PIX(9.58)
	},
	"Jupiter": {
		"NAME" : "Jupiter",
		"MASS" : 1.898e27 / 1e3, // ton
		"COLOR": "#FF8C00",
		"SIZE" : 2.8,
		"VELOCITY": AU2PIX(M2AU(13.07 *1e3)),
		"ORBIT_RADIUS": AU2PIX(5.2)
	},
	"Mars": {
		"NAME" : "Mars",
		"MASS" : 6.4171e23 / 1e3, // ton
		"COLOR": "#FF6347",
		"SIZE" : 1.5,
		"VELOCITY": AU2PIX(M2AU(24.077 *1e3)),
		"ORBIT_RADIUS": AU2PIX(1.524)
	},
	"Earth": {
		"NAME" : "Earth",
		"MASS" : 5.972e24 / 1e3, // ton
		"COLOR": "#1E90FF",
		"SIZE" : 2,
		"VELOCITY": AU2PIX(M2AU(29.78 *1e3)),
		"ORBIT_RADIUS": AU2PIX(1)
	},
	"Venus": {
		"NAME" : "Venus",
		"MASS" : 4.867e24 / 1e3, // ton
		"COLOR": "#FFD700",
		"SIZE" : 1.8,
		"VELOCITY": AU2PIX(M2AU(35.02 *1e3)),
		"ORBIT_RADIUS": AU2PIX(0.723)
	},
	"Mercury": {
		"NAME" : "Mercury",
		"MASS" : 3.3011e23 / 1e3, // ton
		"COLOR": "#B8860B",
		"SIZE" : 1.2,
		"VELOCITY": AU2PIX(M2AU(47.36 *1e3)),
		"ORBIT_RADIUS": AU2PIX(0.387)
	},
	"Moon": {
		"NAME" : "Moon",
		"MASS" : 7.34767309e22 / 1e3, // ton
		"COLOR": "#C0C0C0",
		"SIZE" : 1,
		"VELOCITY": AU2PIX(M2AU(1.022 *1e3)),
		"ORBIT_RADIUS": AU2PIX(0.00257)
	},
	"Asteroid": {
		"NAME" : "Asteroid",
		"MASS" : 1e10 / 1e3, // ton
		"COLOR": "#808080",
		"SIZE" : 0.8,
	},
	"Rocket": {
		"NAME" : "Rocket",
		"MASS" : 5.75e4 / 1e3, // ton
		"COLOR": "#32CD32",
		"SIZE" : 0.6,
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
function PIX2AU(px) {
	return px / DISTANCE_SCALE;
}
function AU2PIX(au) {
	return au * DISTANCE_SCALE;
}
function M2PIX(m) {
	return AU2PIX(M2AU(m));
}
function PIX2M(px) {
	return AU2M(PIX2AU(px));
}

class Object {
	constructor(name, x, y, dx, dy, mass, color, size) {
		this.name = name;
		this.x = x;
		this.y = y;
		this.dx = dx;
		this.dy = dy;
		this.ax = 0;
		this.ay = 0;
		this.mass = mass;       // ton
		this.color = color;
		this.size = size;
		this.state = OBJECT_STATE.ACTIVE;
		this.history = [];
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

	setVelocity(dx, dy) {
		this.dx = dx;
		this.dy = dy;
	}

	getXinMeters() {
		return AU2M(PIX2AU(this.x));
	}
	getYinMeters() {
		return AU2M(PIX2AU(this.y));
	}

	getMassInKg() {
		return this.mass * 1e3; // ton to kg
	}

	resetGravity() {
		this.ax = 0;
		this.ay = 0;
	}

	applyGravity(obj) {
		if( this.state != OBJECT_STATE.ACTIVE || obj.state != OBJECT_STATE.ACTIVE ) {
			return;
		}

		const dx = obj.getXinMeters() - this.getXinMeters();
		const dy = obj.getYinMeters() - this.getYinMeters();
		const distSq = dx * dx + dy * dy;
		const dist = Math.max(Math.sqrt(distSq), PIX2M(this.size + obj.size)); // div by zero avoidance
		const force = G * this.getMassInKg() * obj.getMassInKg() / distSq;
		const accel = force / this.getMassInKg();
		
		this.ax += AU2PIX(M2AU(accel * dx / dist));
		this.ay += AU2PIX(M2AU(accel * dy / dist));
	}

	accelerate(dt) {
		this.dx += this.ax * dt;
		this.dy += this.ay * dt;
	}

	move(dt) {
		// dt: elapsed time (seconds)
		if( this.state != OBJECT_STATE.ACTIVE) {
			// remove from history if in removed state
			this.history.shift();
			return;
		}

		this.addHistory();
		this.x += this.dx * dt;
		this.y += this.dy * dt;
	}

	collided(obj) {
		const dx = this.x - obj.x;
		const dy = this.y - obj.y;
		const dist = Math.sqrt(dx * dx + dy * dy);
		return dist <= (this.size + obj.size);
	}

	rel_cordinate_transform(basis) {
		if( this.state != OBJECT_STATE.ACTIVE || basis.state != OBJECT_STATE.ACTIVE ) {
			return;
		}

		this.x += basis.dx;
		this.y += basis.dy;

		for (let i = 0; i < this.history.length; i++) {
			this.history[i].x += basis.dx;
			this.history[i].y += basis.dy;
		}
	}

	draw(ctx) {
		ctx.fillStyle = this.color;

		if( this.state === OBJECT_STATE.ACTIVE) {
			ctx.beginPath();
			ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
			ctx.fill();
		}

		// Draw history with fading color and thinning line
		for (let i = 1; i < this.history.length; i++) {
			const prev = this.history[i - 1];
			const curr = this.history[i];
			const t = i / this.history.length; // 0 (oldest) to 1 (newest)
			const alpha = t * 0.5 + 0.1; // fade in (0.2~1.0)
			const width = this.size * (0.5 + 0.8 * t); // thin to thick

			ctx.strokeStyle = hexToRgba(this.color, alpha);
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(prev.x, prev.y);
			ctx.lineTo(curr.x, curr.y);
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

class InfoPanel {
	constructor() {
		this.panel = document.getElementById('info-panel');
		if (!this.panel) {
			throw new Error("Info panel element with id 'info-panel' not found.");
		}

		this.elapsedTime = 0; // in years
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
}

class Universe {
	constructor(_canvas) {
		this.canvas = _canvas;
		this.ctx = _canvas.getContext('2d');
		this.objects = [];
		this._initInput();
		this.timeScale = 0.2;
		this.InfoPanel = new InfoPanel();

		this.reset();
	}

	destroy() {
		for (let i = 0; i < this.objects.length; i++) {
			delete this.objects[i];
		}
		this.objects = [];
	}

	_initInput() {
		let isDragging = false;
		let startX = 0, startY = 0, startTime = 0;

		const getPos = (e) => {
			if (e.touches) {
				return {
					x: e.touches[0].clientX,
					y: e.touches[0].clientY
				};
			} else {
				return {
					x: e.clientX,
					y: e.clientY
				};
			}
		};

		const onStart = (e) => {
			isDragging = true;
			const pos = getPos(e);
			startX = pos.x;
			startY = pos.y;
			startTime = Date.now();
		};

		const onEnd = (e) => {
			if (!isDragging) return;
			isDragging = false;
			// mass-selectの内容に応じて、DEFAULT_OBJECT_PARAMSからパラメータを設定する
			let pos;
			if (e.changedTouches && e.changedTouches.length > 0) {
				pos = {
					x: e.changedTouches[0].clientX,
					y: e.changedTouches[0].clientY
				};
			} else {
				pos = getPos(e);
			}
			const massSelect = document.getElementById('mass-select');
			let param = DEFAULT_OBJECT_PARAMS['earth'];
			if (massSelect && DEFAULT_OBJECT_PARAMS[massSelect.value]) {
				param = DEFAULT_OBJECT_PARAMS[massSelect.value];
			}
			const endX = pos.x;
			const endY = pos.y;
			const endTime = Date.now();
			const dt = Math.max((endTime - startTime) / 1000, 0.01); // 秒
			const dx = PIX2AU(AU2M((endX - startX) / dt / THROW_SCALE));
			const dy = PIX2AU(AU2M((endY - startY) / dt / THROW_SCALE));
			const obj = new Object(
				param.NAME,
				startX, startY,
				dx, dy,
				param.MASS,
				param.COLOR,
				param.SIZE
			);
			this.objects.push(obj);
		};

		this.canvas.addEventListener('mousedown', onStart);
		this.canvas.addEventListener('touchstart', onStart);
		this.canvas.addEventListener('mouseup', onEnd);
		this.canvas.addEventListener('touchend', onEnd);

		this.canvas.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.reset();
		});
	}

	reset() {
		this.destroy();

		const centerX = this.canvas.width / 2;
		const centerY = this.canvas.height / 2;
		const sunObj = DEFAULT_OBJECT_PARAMS['Sun'];
		const massiveObj = new Object(
			sunObj.NAME,
			centerX,
			centerY,
			0, 0,
			sunObj.MASS,
			sunObj.COLOR,
			sunObj.SIZE
		);
		this.objects.push(massiveObj);
	}

	draw() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		for (const obj of this.objects) {
			obj.draw(this.ctx);
		}
	}

	applyGravity(dt) {
		for (let i = 0; i < this.objects.length; i++) {
			const objA = this.objects[i];
			objA.resetGravity();
			for (let j = 0; j < this.objects.length; j++) {
				if (i === j) continue;
				const objB = this.objects[j];
				objA.applyGravity(objB);
			}
		}
	}

	heliocentric_transform() {
		const sunObj = this.objects.find(obj => obj.name === DEFAULT_OBJECT_PARAMS["Sun"].NAME);
		if (!sunObj) return;

		for (const obj of this.objects) {
			if (obj.name === DEFAULT_OBJECT_PARAMS["Sun"].NAME) continue;
			obj.rel_cordinate_transform(sunObj);
		}

		sunObj.resetGravity();
		sunObj.setPosition(
			this.canvas.width / 2,
			this.canvas.height / 2
		);
		sunObj.setVelocity(0, 0);
	}

	putDefaultObject(objName) {
		const param = DEFAULT_OBJECT_PARAMS[objName] || DEFAULT_OBJECT_PARAMS['Earth'];
		let x = 0;
		let y = 0;
		let dx = 0;
		let dy = 0;

		// For other objects, we put them in orbit around the Sun
		x = this.canvas.width / 2;
		y = this.canvas.height / 2 - param.ORBIT_RADIUS;
		dx = param.VELOCITY;

		const obj = new Object(
			param.NAME,
			x,
			y,
			dx, 0,
			param.MASS,
			param.COLOR,
			param.SIZE
		);
		this.objects.push(obj);
	}

	removeCollided() {
		for (let i = 0; i < this.objects.length; i++) {
			const objA = this.objects[i];
			if (objA.state != OBJECT_STATE.ACTIVE) continue;

			for (let j = i + 1; j < this.objects.length; j++) {
				const objB = this.objects[j];
				if (objB.state != OBJECT_STATE.ACTIVE) continue;

				if (objA.collided(objB)) {
					if( objA.mass < objB.mass ) {
						objA.setCollided();
					}
					else if( objA.mass > objB.mass ) {
						objB.setCollided();
					}
				}
			}
		}

		// Remove objects that are marked as removed
		this.objects = this.objects.filter(obj => !obj.finished());
	}

	setTimeScale() {
		const timeScaleInput = document.getElementById('time-scale');
		if (timeScaleInput) {
			this.timeScale = parseFloat(timeScaleInput.value);
		}
	}

	update(dt) {
		dt *= YEARS_PER_SECOND /TIME_SCALE *this.timeScale;

		if( this.objects.length == 1 ) {
			this.InfoPanel.resetElapsedTime();
		}
		this.InfoPanel.updateElapsedTime(dt);
		this.InfoPanel.updateObjectCount(this.objects.length);
		
		this.applyGravity(dt);
		for (const obj of this.objects) {
			obj.accelerate(dt);
			obj.move(dt);
		}

		this.removeCollided();
		this.heliocentric_transform();
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
			const dx = (newWidth - prevWidth) / 2;
			const dy = (newHeight - prevHeight) / 2;

			const sun = window.universe.objects.find(obj => obj.name === DEFAULT_OBJECT_PARAMS["Sun"].NAME);
			sun.setVelocity(dx, dy);
			
			window.universe.heliocentric_transform();
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
		universe.setTimeScale();
		universe.update(dt);
		universe.draw();
		requestAnimationFrame(animate);
	}
	requestAnimationFrame(animate);

	const massSelect = document.getElementById('mass-select');

	// <option>で並べる
	if (massSelect) {
		massSelect.innerHTML = '';
		for (const key in DEFAULT_OBJECT_PARAMS) {
			const param = DEFAULT_OBJECT_PARAMS[key];
			const option = document.createElement('option');
			option.value = key;
			option.textContent = `${param.NAME} (mass: ${param.MASS.toExponential(2)} t)`;
			massSelect.appendChild(option);

			if (param.NAME === "Earth") {
				option.selected = true;
			}
		}
	}

	document.getElementById('put-saturn-btn').addEventListener('click', () => {
		universe.putDefaultObject("Saturn");
	});
	document.getElementById('put-jupiter-btn').addEventListener('click', () => {
		universe.putDefaultObject("Jupiter");
	});
	document.getElementById('put-earth-btn').addEventListener('click', () => {
		universe.putDefaultObject("Earth");
	});
	document.getElementById('put-venus-btn').addEventListener('click', () => {
		universe.putDefaultObject("Venus");
	});
	document.getElementById('put-mars-btn').addEventListener('click', () => {
		universe.putDefaultObject("Mars");
	});
	document.getElementById('put-mercury-btn').addEventListener('click', () => {
		universe.putDefaultObject("Mercury");
	});
};
