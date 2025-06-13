// gravsim_calc.js

const G = 6.67430e-11;	// Gravitational constant (m^3 kg^-1 s^-2)
const YEARS_PER_SECOND = 60*60*24*365.25; // 1 year in seconds
const C = 2.99792458e8;			// speed of light (m/s)

const TIME_SCALE = 1e3;
const CALC_INTERVAL = 60;


class GravSimObject {
	constructor(id, x, y, vx, vy, ax, ay, mass, radius) {
		this.id = id;
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.ax = ax;
		this.ay = ay;
		this.mass = mass;
		this.radius = radius;
	}
	
	getXt(dt) {
		return this.x + this.vx*dt + 1/2*this.ax*dt*dt;
	}
	getYt(dt) {
		return this.y + this.vy*dt + 1/2*this.ay*dt*dt;
	}

	getVXt(dt) {
		return this.vx + this.ax*dt;
	}
	getVYt(dt) {
		return this.vy + this.ay*dt;
	}

	getV() {
		return Math.sqrt(this.vx*this.vx + this.vy*this.vy);
	}
	
	applyGravity(other) {
		const dx = other.x - this.x;
		const dy = other.y - this.y;
		const radiusSum = this.radius + other.radius;
		const distSq = Math.max(dx * dx + dy * dy, radiusSum * radiusSum);
		const dist = Math.sqrt(distSq);
		const mass1 = this.mass;
		const mass2 = other.mass;

		const force = (G * mass1 * mass2) / distSq;
		const accel = force / mass1;

		this.ax += accel * dx / dist;
		this.ay += accel * dy / dist;
	}

	isColliding(other, dt) {
		const dx = other.x - this.x;
		const dy = other.y - this.y;
		const distSq = dx * dx + dy * dy;
		const radiusSum = this.radius + other.radius;

		if( distSq < radiusSum * radiusSum ) {
			true;
		}

		const max_v1 = Math.max(Math.abs(this.getVXt(dt)), Math.abs(this.getVYt(dt)));
		const max_v2 = Math.max(Math.abs(other.getVXt(dt)), Math.abs(other.getVYt(dt)));
		const expandRadiusSum = radiusSum + (max_v1 + max_v2)*dt;
		
		if( distSq < expandRadiusSum * expandRadiusSum ) {
			const EXPAND_DIV_NUM = 20;
			for( let i = 1; i < EXPAND_DIV_NUM; i++ ) {
				const dts = dt/EXPAND_DIV_NUM*i;
				const dxs = other.getXt(dts) - this.getXt(dts);
				const dys = other.getYt(dts) - this.getYt(dts);
				const distSqs = dxs * dxs + dys * dys;
				
				if( distSqs < radiusSum * radiusSum ) {
					return true;
				}
			}
		}

		return false;
	}
}


class GravSimCalc {
	constructor() {
		this.lastTime = 0;
		this.objects = [];
		this.timeScale = 1;

		self.onmessage = this.onmessage.bind(this);

		setInterval(() => {
			this.update();
		}, 1000 / CALC_INTERVAL);
	}

	onmessage(e) {
		const data = e.data;
		switch (data.cmd) {
			case 'add':
				const newObj = new GravSimObject(
					data.id,
					data.x, data.y,
					data.vx || 0, data.vy || 0,
					data.ax || 0, data.ay || 0,
					data.mass || 1,
					data.radius || 1,
				);
				this.objects.push(newObj);
				break;
			case 'remove':
				this.objects = this.objects.filter(obj => obj.id !== data.id);
				break;
			case 'update':
				const objToUpdate = this.objects.find(obj => obj.id === data.id);
				if (objToUpdate) {
					objToUpdate.x = data.x;
					objToUpdate.y = data.y;
					objToUpdate.vx = data.vx || 0;
					objToUpdate.vy = data.vy || 0;
					objToUpdate.ax = data.ax || 0;
					objToUpdate.ay = data.ay || 0;
					objToUpdate.mass = data.mass || objToUpdate.mass; // Update mass if provided
				}
				break;
			case 'setTimeScale':
				if (typeof data.timeScale === 'number' && data.timeScale > 0) {
					this.timeScale = data.timeScale;
				} else {
					console.error('Invalid time scale:', data.timeScale);
				}
				break;
			default:
				console.error('Unknown command:', data.cmd);
		}
	}

	convertToMessage() {
		return this.objects.map(obj => {
			return {
				id: obj.id,
				x: obj.x || 0,
				y: obj.y || 0,
				vx: obj.vx || 0,
				vy: obj.vy || 0,
				ax: obj.ax || 0,
				ay: obj.ay || 0,
				collided: obj.collided || false,
			};
		});
	}

	collisionCheck(dt) {
		for (let i = 0; i < this.objects.length; i++) {
			const obj = this.objects[i];
			for (let j = i+1; j < this.objects.length; j++) {
				const other = this.objects[j];

				if (obj.id !== other.id) {
					if( obj.isColliding(other, dt) ) {
						if( obj.mass < other.mass ) {
							obj.collided = true;
						}
						else {
							other.collided = true;
						}
					}
				}
			}
		}
	}

	updateGravity(obj) {
		obj.ax = 0;
		obj.ay = 0;

		for (let j = 0; j < this.objects.length; j++) {
			const other = this.objects[j];

			if (obj.id !== other.id) {
				obj.applyGravity(other);
			}
		}
	}

	moveObject(dt) {
		for (let i = 0; i < this.objects.length; i++) {
			const obj = this.objects[i];

			if( obj.collided ) continue;

			this.updateGravity(obj);
			const half_vx = obj.vx + obj.ax * dt/2;
			const half_vy = obj.vy + obj.ay * dt/2;
			obj.x += half_vx * dt;
			obj.y += half_vy * dt;

			this.updateGravity(obj);
			obj.vx = half_vx + obj.ax * dt/2;
			obj.vy = half_vy + obj.ay * dt/2;

			const v = obj.getV();
			if(v > C) {
				obj.vx = C *(obj.vx/v);
				obj.vy = C *(obj.vy/v);
			}
		}

	}

	update() {
		const now = Date.now();
		const dt = (now - this.lastTime) *YEARS_PER_SECOND /TIME_SCALE *this.timeScale;
		this.lastTime = now;

		this.moveObject(dt);
		this.collisionCheck(dt);
			
		self.postMessage({
			cmd: 'update',
			deltaTime: dt,
			objects: this.convertToMessage()
		});

		this.objects = this.objects.filter(obj => !obj.collided);
	}
}

const calc = new GravSimCalc();
