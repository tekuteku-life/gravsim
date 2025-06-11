// gravsim_calc.js

const G = 6.67430e-11;	// Gravitational constant (m^3 kg^-1 s^-2)
const YEARS_PER_SECOND = 60*60*24*365.25; // 1 year in seconds
const C = 2.99792458e8;			// speed of light (m/s)

const TIME_SCALE = 1e3;
const CALC_INTERVAL = 60;


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
				const newObj = {
					id: data.id,
					x: data.x,
					y: data.y,
					vx: data.vx || 0,
					vy: data.vy || 0,
					ax: data.ax || 0,
					ay: data.ay || 0,
					mass: data.mass || 1,
					radius: data.radius || 1,
				};
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

	applyGravity(obj1, obj2) {
		const dx = obj2.x - obj1.x;
		const dy = obj2.y - obj1.y;
		const distSq = Math.max(dx * dx + dy * dy, (obj1.radius + obj2.radius)*(obj1.radius + obj2.radius));
		const dist = Math.sqrt(distSq);

		const force = (G * obj1.mass * obj2.mass) / distSq;
		const accel = force / obj1.mass;

		obj1.ax += accel * dx / dist;
		obj1.ay += accel * dy / dist;
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

	isColliding(obj1, obj2) {
		const dx = obj2.x - obj1.x;
		const dy = obj2.y - obj1.y;
		const distSq = dx * dx + dy * dy;
		const radiusSum = obj1.radius + obj2.radius;

		return distSq < radiusSum * radiusSum;
	}

	collisionCheck() {
		for (let i = 0; i < this.objects.length; i++) {
			const obj = this.objects[i];
			for (let j = i+1; j < this.objects.length; j++) {
				const other = this.objects[j];

				if (obj.id !== other.id) {
					if( this.isColliding(obj, other) ) {
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
				this.applyGravity(obj, other);
			}
		}
	}

	update() {
		const now = Date.now();
		const dt = (now - this.lastTime) *YEARS_PER_SECOND /TIME_SCALE *this.timeScale;
		this.lastTime = now;

		for (let i = 0; i < this.objects.length; i++) {
			const obj = this.objects[i];

			this.updateGravity(obj);
			const half_vx = obj.vx + obj.ax * dt/2;
			const half_vy = obj.vy + obj.ay * dt/2;
			obj.x += half_vx * dt;
			obj.y += half_vy * dt;

			this.updateGravity(obj);
			obj.vx = half_vx + obj.ax * dt/2;
			obj.vy = half_vy + obj.ay * dt/2;

			const v = Math.sqrt(obj.vx*obj.vx + obj.vy*obj.vy);
			console.log(v);
			if(v > C) {
				obj.vx = C *(obj.vx/v);
				obj.vy = C *(obj.vy/v);
			}
		}

		this.collisionCheck();
			
		self.postMessage({
			cmd: 'update',
			deltaTime: dt,
			objects: this.convertToMessage()
		});

		this.objects = this.objects.filter(obj => !obj.collided);
	}
}

const calc = new GravSimCalc();
