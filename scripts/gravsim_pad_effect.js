
// gravsim_pad_effect.js

import { PAD_EFFECT, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';
import { UnitConvertUtils } from './gravsim_utils.js';

class UmbilicalCable {
	constructor() {
		this.isDisconnected = false;
		this.nodes = [];
		this.restLengths = [];
		this.isInitialized = false;
	}

	reset() {
		this.isDisconnected = false;
		this.nodes = [];
		this.restLengths = [];
		this.isInitialized = false;
	}

	_initNodes(conf, nozzleMult = PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT) {
		const numNodes = conf.CABLE_NODES || PAD_EFFECT.STRUCTURE.CABLE_NODES;
		this.nodes = [];
		this.restLengths = [];

		const p0 = this.getAttachPos(conf, 0, nozzleMult);
		const connX = conf.CABLE_CONN_X_MULT !== undefined ? conf.CABLE_CONN_X_MULT : PAD_EFFECT.STRUCTURE.CABLE_CONN_X_MULT;
		const connY = conf.CABLE_CONN_Y_MULT !== undefined ? conf.CABLE_CONN_Y_MULT : PAD_EFFECT.STRUCTURE.CABLE_CONN_Y_MULT;
		const p2 = { x: connX, y: connY };
		const p1 = {
			x: conf.CABLE_SAG_X_MULT !== undefined ? conf.CABLE_SAG_X_MULT : (p0.x + p2.x) * 0.5 - (conf.CABLE_DEFAULT_SAG_OFFSET_X || PAD_EFFECT.STRUCTURE.CABLE_DEFAULT_SAG_OFFSET_X),
			y: conf.CABLE_SAG_Y_MULT !== undefined ? conf.CABLE_SAG_Y_MULT : Math.min(p0.y, p2.y) - (conf.CABLE_DEFAULT_SAG_OFFSET_Y || PAD_EFFECT.STRUCTURE.CABLE_DEFAULT_SAG_OFFSET_Y)
		};

		for (let i = 0; i < numNodes; i++) {
			const t = i / (numNodes - 1);
			const it = 1 - t;
			const bx = it * it * p0.x + 2 * it * t * p1.x + t * t * p2.x;
			const by = it * it * p0.y + 2 * it * t * p1.y + t * t * p2.y;
			this.nodes.push({
				x: bx,
				y: by,
				prevX: bx,
				prevY: by
			});
		}

		for (let i = 0; i < numNodes - 1; i++) {
			const dx = this.nodes[i + 1].x - this.nodes[i].x;
			const dy = this.nodes[i + 1].y - this.nodes[i].y;
			this.restLengths.push(Math.hypot(dx, dy));
		}

		this.isInitialized = true;
	}

	getAttachPos(conf, armAngleDeg, nozzleMult = PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT) {
		const groundX = -nozzleMult;
		const towerH = (conf.UMBILICAL_TOP_X_MULT || PAD_EFFECT.STRUCTURE.UMBILICAL_TOP_X_MULT) - groundX;
		const armLen = conf.UMBILICAL_ARM_LEN_MULT !== undefined ? conf.UMBILICAL_ARM_LEN_MULT : PAD_EFFECT.STRUCTURE.UMBILICAL_ARM_LEN_MULT;

		const armAngleRad = UnitConvertUtils.deg2rad(-armAngleDeg);
		const cosA = Math.cos(armAngleRad);
		const sinA = Math.sin(armAngleRad);

		const localX = towerH * cosA - armLen * sinA;
		const localY = towerH * sinA + armLen * cosA;

		return {
			x: groundX + localX,
			y: (conf.UMBILICAL_OFFSET_Y !== undefined ? conf.UMBILICAL_OFFSET_Y : PAD_EFFECT.STRUCTURE.UMBILICAL_OFFSET_Y) + localY
		};
	}

	update(dt, conf, armAngleDeg, isHoldDown, nozzleMult = PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT) {
		if (!this.isInitialized) {
			this._initNodes(conf, nozzleMult);
		}

		const numNodes = this.nodes.length;
		const attachPos = this.getAttachPos(conf, armAngleDeg, nozzleMult);
		const subDt = Math.min(dt, conf.CABLE_MAX_SUB_DT || PAD_EFFECT.STRUCTURE.CABLE_MAX_SUB_DT);

		if (isHoldDown) {
			this.nodes[0].x = attachPos.x;
			this.nodes[0].y = attachPos.y;
			this.nodes[0].prevX = attachPos.x;
			this.nodes[0].prevY = attachPos.y;

			const connX = conf.CABLE_CONN_X_MULT;
			const connY = conf.CABLE_CONN_Y_MULT;
			this.nodes[numNodes - 1].x = connX;
			this.nodes[numNodes - 1].y = connY;
			this.nodes[numNodes - 1].prevX = connX;
			this.nodes[numNodes - 1].prevY = connY;
			return;
		}

		if (!this.isDisconnected) {
			this.isDisconnected = true;
			const impulse = conf.CABLE_SWING_IMPULSE || PAD_EFFECT.STRUCTURE.CABLE_SWING_IMPULSE;
			this.nodes[numNodes - 1].prevY = this.nodes[numNodes - 1].y + impulse * (conf.CABLE_IMPULSE_Y_MULT || PAD_EFFECT.STRUCTURE.CABLE_IMPULSE_Y_MULT);
			this.nodes[numNodes - 1].prevX = this.nodes[numNodes - 1].x + impulse * (conf.CABLE_IMPULSE_X_MULT || PAD_EFFECT.STRUCTURE.CABLE_IMPULSE_X_MULT);
		}

		const damping = Math.pow(conf.CABLE_DAMPING || PAD_EFFECT.STRUCTURE.CABLE_DAMPING, subDt * (conf.CABLE_PHYSICS_FREQ || PAD_EFFECT.STRUCTURE.CABLE_PHYSICS_FREQ));
		const gravity = conf.CABLE_GRAVITY || PAD_EFFECT.STRUCTURE.CABLE_GRAVITY;

		this.nodes[0].x = attachPos.x;
		this.nodes[0].y = attachPos.y;
		this.nodes[0].prevX = attachPos.x;
		this.nodes[0].prevY = attachPos.y;

		for (let i = 1; i < numNodes; i++) {
			const node = this.nodes[i];
			const vx = (node.x - node.prevX) * damping;
			const vy = (node.y - node.prevY) * damping;

			node.prevX = node.x;
			node.prevY = node.y;

			const ax = -gravity;
			const ay = 0;

			node.x += vx + ax * subDt * subDt;
			node.y += vy + ay * subDt * subDt;
		}

		const iterations = conf.CABLE_CONSTRAINT_ITERATIONS || PAD_EFFECT.STRUCTURE.CABLE_CONSTRAINT_ITERATIONS;
		for (let it = 0; it < iterations; it++) {
			for (let i = 0; i < numNodes - 1; i++) {
				const n1 = this.nodes[i];
				const n2 = this.nodes[i + 1];
				const dx = n2.x - n1.x;
				const dy = n2.y - n1.y;
				const dist = Math.hypot(dx, dy);
				if (dist < 1e-6) continue;

				const targetDist = this.restLengths[i];
				const diff = (dist - targetDist) / dist;

				if (i === 0) {
					n2.x -= dx * diff;
					n2.y -= dy * diff;
				} else {
					n1.x += dx * diff * 0.5;
					n1.y += dy * diff * 0.5;
					n2.x -= dx * diff * 0.5;
					n2.y -= dy * diff * 0.5;
				}
			}
		}
	}

	draw(ctx, rPx, conf = PAD_EFFECT.STRUCTURE) {
		if (!this.isInitialized || this.nodes.length < 2) return;

		const numNodes = this.nodes.length;

		ctx.save();
		ctx.beginPath();
		ctx.moveTo(this.nodes[0].x * rPx, this.nodes[0].y * rPx);
		for (let i = 1; i < numNodes; i++) {
			ctx.lineTo(this.nodes[i].x * rPx, this.nodes[i].y * rPx);
		}

		ctx.strokeStyle = conf.CABLE_BASE_COLOR;
		ctx.lineWidth = Math.max(conf.CABLE_MIN_WIDTH_PX, rPx * conf.CABLE_WIDTH_MULT);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.stroke();

		ctx.strokeStyle = conf.CABLE_HIGH_COLOR;
		ctx.lineWidth = Math.max(conf.CABLE_MIN_HIGH_WIDTH_PX, rPx * conf.CABLE_HIGH_WIDTH_MULT);
		ctx.stroke();

		const tip = this.nodes[numNodes - 1];
		const prevTip = this.nodes[numNodes - 2];
		const jointAngle = Math.atan2(tip.y - prevTip.y, tip.x - prevTip.x);

		ctx.save();
		ctx.translate(tip.x * rPx, tip.y * rPx);
		ctx.rotate(jointAngle);
		ctx.fillStyle = conf.JOINT_COLOR;
		const jointSize = rPx * conf.CABLE_JOINT_SIZE_MULT;
		ctx.fillRect(-jointSize * conf.CABLE_JOINT_OFFSET_X_MULT, -jointSize * conf.CABLE_JOINT_OFFSET_Y_MULT, jointSize, jointSize);
		ctx.restore();

		ctx.restore();
	}
}

export class PadEffectRenderer {
	constructor() {
		this.isActive = false;
		this.targetRocketId = null;
		this.hostId = null;
		this.particles = [];
		this.flags = {
			isVenting: false,
			isChilldown: false,
			isWaterDeluge: false,
			isROFI: false,
			isInternalPower: false,
			isPressurized: false,
			isLiftoff: false
		};
		this.strongbackAngle = 0;
		this.umbilicalAngle = 0;
		this.umbilicalCable = new UmbilicalCable();
		
		// For storing local relative coordinates to avoid global lag
		this.startRelPadX = 0;
		this.startRelPadY = 0;
		this.startLaunchAngle = 0;
		this.rocketRadius = 0;
		this.bottomOffsetM = 0;
		this.lastContext = null;
	}

	start(rocketId, hostId) {
		this.targetRocketId = rocketId;
		this.hostId = hostId;
		this.isActive = true;
		this.particles = [];
		this.flags = {
			isVenting: false,
			isChilldown: false,
			isWaterDeluge: false,
			isROFI: false,
			isInternalPower: false,
			isPressurized: false,
			isLiftoff: false
		};
		this.strongbackAngle = 0;
		this.umbilicalAngle = 0;
		this.umbilicalCable.reset();
		this.bottomOffsetM = 0;
		this.lastContext = null;
	}

	stop() {
		this.isActive = false;
		this.targetRocketId = null;
		this.hostId = null;
		this.particles = [];
		this.umbilicalCable.reset();
	}

	handleEvent(eventName) {
		if (eventName.includes('COUNTDOWN START')) { this.flags.isVenting = true; }
		else if (eventName.includes('CHILLDOWN')) { this.flags.isChilldown = true; }
		else if (eventName.includes('PRESSURIZATION')) { this.flags.isPressurized = true; }
		else if (eventName.includes('INTERNAL POWER')) { this.flags.isInternalPower = true; }
		else if (eventName.includes('WATER DELUGE')) { this.flags.isWaterDeluge = true; }
		else if (eventName.includes('ROFI')) { this.flags.isROFI = true; }
		else if (eventName.includes('MAIN ENGINE START')) { this.flags.isChilldown = false; }
		else if (eventName.includes('LIFTOFF')) { this.flags.isLiftoff = true; }
	}

	handleLiftoff() {
		this.flags.isLiftoff = true;
		this.flags.isVenting = false;
		this.flags.isROFI = false;
		
		if (this.lastContext) {
			this._spawnIceShedding(this.lastContext);
			this._spawnPurgeSpark(this.lastContext);
		}
	}

	_getVisualMultiplier(context) {
		const rPx = context.m2pix(this.rocketRadius);
		const zoomScale = context.zoomScale;
		let visualMultiplier = 1.0;
		if (rPx > 0 && zoomScale > 0) {
			const physicalScreenRadius = rPx * zoomScale;
			const minRadius = PAD_EFFECT.PHYSICS.MIN_VISUAL_RADIUS_PX;
			const visualScreenRadius = Math.max(minRadius, physicalScreenRadius);
			visualMultiplier = visualScreenRadius / physicalScreenRadius;
		}
		return visualMultiplier;
	}

	_getVectors() {
		const fx = Math.cos(this.startLaunchAngle);
		const fy = Math.sin(this.startLaunchAngle);
		return {
			F: { x: fx, y: fy },
			B: { x: -fx, y: -fy },
			R: { x: -fy, y: fx },
			L: { x: fy, y: -fx }
		};
	}

	_spawnIceShedding(context) {
		const conf = PAD_EFFECT.EMITTER.ICE;
		const rPx = context.m2pix(this.rocketRadius);
		const visualMultiplier = this._getVisualMultiplier(context);
		const vec = this._getVectors();
		
		for(let i = 0; i < conf.COUNT; i++) {
			const offsetRange = rPx * conf.OFFSET_MULT * visualMultiplier;
			const dx = (Math.random() - 0.5) * offsetRange;
			const dy = (Math.random() - 0.5) * offsetRange;
			
			const spreadRand = conf.SPREAD_RAND;
			const dropVx = vec.B.x * conf.V_RAND * Math.random() + (Math.random() - 0.5) * spreadRand;
			const dropVy = vec.B.y * conf.V_RAND * Math.random() + (Math.random() - 0.5) * spreadRand;

			this.particles.push({
				type: 'ice',
				x: dx,
				y: dy,
				vx: context.m2pix(dropVx) * visualMultiplier,
				vy: context.m2pix(dropVy) * visualMultiplier,
				life: 1.0,
				maxLife: Math.random() * conf.LIFE_RAND + conf.LIFE_BASE
			});
		}
	}

	_spawnPurgeSpark(context) {
		const conf = PAD_EFFECT.EMITTER.PURGE_SPARK;
		const rPx = context.m2pix(this.rocketRadius);
		const visualMultiplier = this._getVisualMultiplier(context);
		const visualRadius = rPx * visualMultiplier;
		const vec = this._getVectors();
		const nozzleMult = (this.bottomOffsetM && this.rocketRadius)
			? (this.bottomOffsetM / this.rocketRadius)
			: PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT;
		const nozzleOffset = visualRadius * nozzleMult;
		for(let i = 0; i < conf.COUNT; i++) {
			this.particles.push({
				type: 'spark',
				x: vec.B.x * nozzleOffset,
				y: vec.B.y * nozzleOffset,
				vx: context.m2pix((Math.random() - 0.5) * conf.V_RAND) * visualMultiplier,
				vy: context.m2pix((Math.random() - 0.5) * conf.V_RAND) * visualMultiplier,
				life: 1.0,
				maxLife: conf.LIFE_BASE
			});
		}
	}

	update(dt, context) {
		if (!this.isActive) { return; }
		const { rocket, host, m2pix } = context;
		this.lastContext = context;

		// Track relative origin to avoid drift from fast-moving planets
		if (rocket && rocket.isHoldDown && host) {
			this.startRelPadX = rocket.x - host.x;
			this.startRelPadY = rocket.y - host.y;
			this.startLaunchAngle = rocket.thrustAngle;
			this.rocketRadius = rocket.baseRadiusM || rocket.radius;
			if (rocket.bottomOffsetM !== undefined) {
				this.bottomOffsetM = rocket.bottomOffsetM;
			}
		} else if (host && rocket && !rocket.isHoldDown) {
			// Update pad position by rotation even after liftoff
			const hostParam = DEFAULT_OBJECT_PARAMS[host.name];
			if (hostParam && hostParam.ROTATION_PERIOD) {
				const omega = (2 * Math.PI) / hostParam.ROTATION_PERIOD;
				const angleDelta = omega * dt;
				
				const cosA = Math.cos(angleDelta);
				const sinA = Math.sin(angleDelta);
				const newX = this.startRelPadX * cosA - this.startRelPadY * sinA;
				const newY = this.startRelPadX * sinA + this.startRelPadY * cosA;
				
				this.startRelPadX = newX;
				this.startRelPadY = newY;
				this.startLaunchAngle += angleDelta;
			}
		}

		const isLiftoff = this.flags.isLiftoff || (rocket ? !rocket.isHoldDown : false);
		if (this.flags.isInternalPower || isLiftoff) {
			this.strongbackAngle += PAD_EFFECT.STRUCTURE.STRONGBACK_RETRACT_SPEED * dt;
			if (this.strongbackAngle > PAD_EFFECT.STRUCTURE.STRONGBACK_MAX_ANGLE) {
				this.strongbackAngle = PAD_EFFECT.STRUCTURE.STRONGBACK_MAX_ANGLE;
			}
		}

		if (isLiftoff) {
			this.umbilicalAngle += PAD_EFFECT.STRUCTURE.UMBILICAL_RETRACT_SPEED * dt;
			if (this.umbilicalAngle > PAD_EFFECT.STRUCTURE.UMBILICAL_MAX_ANGLE) {
				this.umbilicalAngle = PAD_EFFECT.STRUCTURE.UMBILICAL_MAX_ANGLE;
			}
		}

		const isHoldDown = rocket ? rocket.isHoldDown : false;
		const rPx = m2pix(this.rocketRadius);
		const visualMultiplier = this._getVisualMultiplier(context);
		const visualRadius = rPx * visualMultiplier;
		const vec = this._getVectors();

		const nozzleMult = (this.bottomOffsetM && this.rocketRadius)
			? (this.bottomOffsetM / this.rocketRadius)
			: PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT;

		this.umbilicalCable.update(dt, PAD_EFFECT.STRUCTURE, this.umbilicalAngle, isHoldDown, nozzleMult);

		const localNozzleX = vec.B.x * visualRadius * nozzleMult;
		const localNozzleY = vec.B.y * visualRadius * nozzleMult;
		
		const localSideX = vec.R.x * visualRadius * PAD_EFFECT.PHYSICS.SIDE_OFFSET_MULT;
		const localSideY = vec.R.y * visualRadius * PAD_EFFECT.PHYSICS.SIDE_OFFSET_MULT;
		
		const fallVx = m2pix(vec.B.x * PAD_EFFECT.PHYSICS.FALL_V_MULT) * visualMultiplier;
		const fallVy = m2pix(vec.B.y * PAD_EFFECT.PHYSICS.FALL_V_MULT) * visualMultiplier;

		const currentVentRate = this.flags.isPressurized ? PAD_EFFECT.EMITTER.VENT.PRESSURIZED_RATE : PAD_EFFECT.EMITTER.VENT.RATE;
		if (this.flags.isVenting && Math.random() < currentVentRate) {
			const conf = PAD_EFFECT.EMITTER.VENT;
			for(let i = 0; i < conf.COUNT; i++) {
				const vSpeed = conf.V_BASE + Math.random() * conf.V_RAND;
				const angleSpread = (Math.random() - 0.5) * conf.SPREAD_ANGLE_RAD;
				const dirX = vec.R.x * Math.cos(angleSpread) - vec.R.y * Math.sin(angleSpread);
				const dirY = vec.R.x * Math.sin(angleSpread) + vec.R.y * Math.cos(angleSpread);
				
				const offsetX = (Math.random() - 0.5) * visualRadius * conf.OFFSET_X_MULT;
				const offsetY = (Math.random() - 0.5) * visualRadius * conf.OFFSET_Y_MULT;

				this.particles.push({
					type: 'smoke_white',
					x: localSideX + offsetX,
					y: localSideY + offsetY,
					vx: m2pix(dirX * vSpeed) * visualMultiplier,
					vy: m2pix(dirY * vSpeed) * visualMultiplier,
					life: 1.0,
					maxLife: conf.LIFE_BASE + Math.random() * conf.LIFE_RAND,
					size: conf.SIZE + Math.random() * conf.SIZE_RAND
				});
			}
		}

		if (this.flags.isChilldown && Math.random() < PAD_EFFECT.EMITTER.CHILL.RATE) {
			const conf = PAD_EFFECT.EMITTER.CHILL;
			for(let i = 0; i < conf.COUNT; i++) {
				this.particles.push({
					type: 'chill',
					x: localNozzleX + (Math.random() - 0.5) * visualRadius,
					y: localNozzleY + (Math.random() - 0.5) * visualRadius,
					vx: fallVx + m2pix((Math.random() - 0.5) * conf.V_RAND) * visualMultiplier,
					vy: fallVy + m2pix((Math.random() - 0.5) * conf.V_RAND) * visualMultiplier,
					life: 1.0, maxLife: conf.LIFE_BASE, size: conf.SIZE
				});
			}
		}

		if (this.flags.isWaterDeluge) {
			const conf = PAD_EFFECT.EMITTER.DELUGE;
			const lateralOffset = conf.LATERAL_OFFSET_MULT;
			const sideHeads = conf.SIDE_HEADS;
			for (let i = 0; i < conf.COUNT; i++) {
				const isRight = (i % 2 === 0);
				const sideDir = isRight ? vec.R : vec.L;
				const headIdx = Math.floor(Math.random() * sideHeads);
				const headFraction = (headIdx / Math.max(1, sideHeads - 1)) - 0.5;
				
				const emitX = localNozzleX + sideDir.x * visualRadius * lateralOffset + vec.B.x * visualRadius * (headFraction * conf.HEAD_SPREAD_MULT);
				const emitY = localNozzleY + sideDir.y * visualRadius * lateralOffset + vec.B.y * visualRadius * (headFraction * conf.HEAD_SPREAD_MULT);

				const vSide = conf.V_SIDE_BASE + Math.random() * conf.V_SIDE_RAND;
				const vUp = conf.V_UP_BASE + Math.random() * conf.V_UP_RAND;
				const spreadAngle = (Math.random() - 0.5) * conf.SPREAD_ANGLE_RAD;
				
				const cosS = Math.cos(spreadAngle);
				const sinS = Math.sin(spreadAngle);
				const vxSide = sideDir.x * cosS - sideDir.y * sinS;
				const vySide = sideDir.x * sinS + sideDir.y * cosS;

				this.particles.push({
					type: 'deluge',
					x: emitX,
					y: emitY,
					vx: m2pix(vxSide * vSide + vec.F.x * vUp) * visualMultiplier,
					vy: m2pix(vySide * vSide + vec.F.y * vUp) * visualMultiplier,
					life: 1.0,
					maxLife: conf.LIFE_BASE + Math.random() * conf.LIFE_RAND,
					size: conf.SIZE + Math.random() * conf.SIZE_RAND
				});
			}
		}

		if (this.flags.isROFI) {
			const conf = PAD_EFFECT.EMITTER.ROFI;
			for(let i = 0; i < conf.COUNT; i++) {
				this.particles.push({
					type: 'spark',
					x: localNozzleX + (Math.random() - 0.5) * visualRadius,
					y: localNozzleY + (Math.random() - 0.5) * visualRadius,
					vx: m2pix((Math.random() - 0.5) * conf.V_RAND) * visualMultiplier + fallVx,
					vy: m2pix((Math.random() - 0.5) * conf.V_RAND) * visualMultiplier + fallVy,
					life: 1.0, maxLife: conf.LIFE_BASE, size: conf.SIZE
				});
			}
		}

		for (let i = this.particles.length - 1; i >= 0; i--) {
			let p = this.particles[i];
			const pDef = PAD_EFFECT.PARTICLES[p.type];

			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.life -= dt / p.maxLife;
			
			const dragFactor = Math.pow(pDef.DRAG, dt * PAD_EFFECT.PHYSICS.DRAG_NORM_DT);
			p.vx *= dragFactor;
			p.vy *= dragFactor;
			
			if (p.size !== undefined) {
				p.size += dt * pDef.GROW_SPEED;
			}
			
			if (pDef.GRAVITY_MULT !== 0) {
				p.vx += fallVx * dt * pDef.GRAVITY_MULT;
				p.vy += fallVy * dt * pDef.GRAVITY_MULT;
			}
			
			if (p.life <= 0) {
				this.particles.splice(i, 1);
			}
		}
	}

	_getAbsPadPosition(context) {
		const { rocket, host } = context;
		if (rocket && rocket.isHoldDown) {
			return { x: rocket.x, y: rocket.y, angle: rocket.thrustAngle };
		} else if (host) {
			return { x: host.x + this.startRelPadX, y: host.y + this.startRelPadY, angle: this.startLaunchAngle };
		}
		return { x: 0, y: 0, angle: 0 };
	}

	getTowerLayout(context) {
		const rocket = context?.rocket;
		const rMeters = rocket?.baseRadiusM || this.rocketRadius || PAD_EFFECT.PHYSICS.DEFAULT_ROCKET_RADIUS_M;
		const bottomOffsetM = rocket?.bottomOffsetM || this.bottomOffsetM;
		const nozzleMult = (bottomOffsetM && rMeters)
			? (bottomOffsetM / rMeters)
			: (PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT !== undefined ? PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT : 3.10);
		const groundXM = -rMeters * nozzleMult;

		const conf = PAD_EFFECT.STRUCTURE;
		const strongbackTopXM = rMeters * conf.STRONGBACK_TOP_X_MULT;
		const strongbackHeightM = strongbackTopXM - groundXM;

		const umbTopXM = rMeters * conf.UMBILICAL_TOP_X_MULT;
		const umbilicalTowerHeightM = umbTopXM - groundXM;

		const baseOffsetMult = conf.BASE_X_OFFSET_MULT !== undefined ? conf.BASE_X_OFFSET_MULT : -1.0;

		return {
			rMeters,
			nozzleMult,
			groundXM,
			strongback: {
				baseXM: groundXM,
				topXM: strongbackTopXM,
				heightM: strongbackHeightM,
				yM: rMeters * conf.STRONGBACK_Y_MULT,
				thicknessM: rMeters * conf.STRONGBACK_H_MULT,
				isGrounded: true
			},
			umbilicalTower: {
				baseXM: groundXM,
				topXM: umbTopXM,
				heightM: umbilicalTowerHeightM,
				yM: rMeters * (conf.UMBILICAL_OFFSET_Y !== undefined ? conf.UMBILICAL_OFFSET_Y : -1.4),
				thicknessM: rMeters * conf.UMBILICAL_H_MULT,
				hingeXM: groundXM,
				isGrounded: true
			},
			base: {
				baseXM: groundXM + baseOffsetMult * rMeters,
				topXM: groundXM + (baseOffsetMult + conf.BASE_W_MULT) * rMeters,
				widthM: conf.BASE_W_MULT * rMeters,
				yM: conf.BASE_Y_MULT * rMeters,
				heightM: conf.BASE_H_MULT * rMeters
			}
		};
	}

	drawBackground(ctx, renderContext, context) {
		if (!this.isActive) return;
		const conf = PAD_EFFECT.STRUCTURE;
		const zoomScale = renderContext.zoomScale;
		const basis = renderContext.basis;
		
		const absPos = this._getAbsPadPosition(context);
		const relX = (absPos.x - basis.x) * zoomScale;
		const relY = (absPos.y - basis.y) * zoomScale;
		
		const rPx = (context.rocket && typeof context.rocket._getDrawRadius === 'function')
			? context.rocket._getDrawRadius(zoomScale)
			: Math.max(PAD_EFFECT.PHYSICS.MIN_VISUAL_RADIUS_PX, context.m2pix(this.rocketRadius) * zoomScale);

		const bottomOffsetM = context.rocket?.bottomOffsetM || this.bottomOffsetM;
		const baseRadiusM = context.rocket?.baseRadiusM || this.rocketRadius || PAD_EFFECT.PHYSICS.DEFAULT_ROCKET_RADIUS_M;
		const nozzleMult = (bottomOffsetM && baseRadiusM)
			? (bottomOffsetM / baseRadiusM)
			: PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT;
		const groundXPx = -rPx * nozzleMult;

		ctx.save();
		ctx.translate(relX, relY);
		ctx.rotate(absPos.angle);

		// Pad base (Ground platform / concrete foundation embedded firmly in the ground)
		ctx.fillStyle = conf.BASE_COLOR;
		const baseOffsetMult = conf.BASE_X_OFFSET_MULT;
		const baseXPx = groundXPx + baseOffsetMult * rPx;
		const baseWPx = rPx * conf.BASE_W_MULT;
		const baseYPx = rPx * conf.BASE_Y_MULT;
		const baseHPx = rPx * conf.BASE_H_MULT;
		ctx.fillRect(baseXPx, baseYPx, baseWPx, baseHPx);

		// Launch Mount / Hold-down Table (Directly beneath rocket, supporting hold-down clamps)
		ctx.fillStyle = conf.MOUNT_COLOR;
		const mountThickness = rPx * conf.MOUNT_THICKNESS_MULT;
		ctx.fillRect(groundXPx - mountThickness, -rPx * conf.MOUNT_WIDTH_HALF_MULT, mountThickness, rPx * conf.MOUNT_WIDTH_MULT);

		// Strongback Ground Pedestal & Hinge (Firmly anchored to ground platform)
		const sbY = rPx * conf.STRONGBACK_Y_MULT;
		const sbThickPx = rPx * conf.STRONGBACK_H_MULT;
		const sbTopX = rPx * conf.STRONGBACK_TOP_X_MULT;
		const sbHeightPx = sbTopX - groundXPx;

		const pedOffsetX = rPx * conf.PEDESTAL_OFFSET_X_MULT;
		const pedHalfW = sbThickPx * conf.PEDESTAL_HALF_MULT;
		const pedW = rPx * conf.PEDESTAL_W_MULT;
		const pedH = sbThickPx * conf.PEDESTAL_H_MULT;
		const jointRadius = rPx * conf.JOINT_RADIUS_MULT;

		ctx.fillStyle = conf.BASE_COLOR;
		ctx.fillRect(groundXPx - pedOffsetX, sbY - pedHalfW, pedW, pedH);
		ctx.fillStyle = conf.JOINT_COLOR;
		ctx.beginPath();
		if (typeof ctx.arc === 'function') {
			ctx.arc(groundXPx, sbY, jointRadius, 0, Math.PI * 2);
			ctx.fill();
		} else if (typeof ctx.fillRect === 'function') {
			ctx.fillRect(groundXPx - jointRadius, sbY - jointRadius, jointRadius * 2, jointRadius * 2);
		}

		// Main Strongback (Tower 1: Rooted at ground, pivots around ground hinge)
		ctx.save();
		ctx.translate(groundXPx, sbY);
		ctx.rotate(UnitConvertUtils.deg2rad(this.strongbackAngle));
		ctx.fillStyle = conf.TRUSS_COLOR;
		ctx.fillRect(0, -sbThickPx * 0.5, sbHeightPx, sbThickPx);
		
		ctx.strokeStyle = conf.TRUSS_HIGHLIGHT;
		ctx.lineWidth = Math.max(1, rPx * conf.STRONGBACK_TRUSS_WIDTH_MULT);
		ctx.beginPath();
		const sbBays = Math.max(conf.STRONGBACK_MIN_BAYS, Math.round(sbHeightPx / (rPx * conf.STRONGBACK_BAY_INTERVAL_MULT)));
		const sbBayLen = sbHeightPx / sbBays;
		for (let i = 0; i < sbBays; i++) {
			const sx = i * sbBayLen;
			const ex = (i + 1) * sbBayLen;
			ctx.moveTo(sx, -sbThickPx * 0.5); ctx.lineTo(ex, sbThickPx * 0.5);
			ctx.moveTo(sx, sbThickPx * 0.5); ctx.lineTo(ex, -sbThickPx * 0.5);
		}
		ctx.stroke();
		ctx.restore();

		// Umbilical Tower Ground Pedestal & Hinge (Firmly anchored to ground platform)
		const umbY = rPx * conf.UMBILICAL_OFFSET_Y;
		const umbTowerW = rPx * conf.UMBILICAL_H_MULT;
		const umbTopX = rPx * conf.UMBILICAL_TOP_X_MULT;
		const umbTowerHeightPx = umbTopX - groundXPx;
		const umbArmLenPx = rPx * conf.UMBILICAL_ARM_LEN_MULT;

		ctx.fillStyle = conf.BASE_COLOR;
		ctx.fillRect(groundXPx - pedOffsetX, umbY - umbTowerW * conf.PEDESTAL_HALF_MULT, pedW, umbTowerW * conf.PEDESTAL_H_MULT);
		ctx.fillStyle = conf.JOINT_COLOR;
		ctx.beginPath();
		if (typeof ctx.arc === 'function') {
			ctx.arc(groundXPx, umbY, jointRadius, 0, Math.PI * 2);
			ctx.fill();
		} else if (typeof ctx.fillRect === 'function') {
			ctx.fillRect(groundXPx - jointRadius, umbY - jointRadius, jointRadius * 2, jointRadius * 2);
		}

		// Umbilical Tower (Tower 2: Pivots from the ground hinge at liftoff!)
		ctx.save();
		ctx.translate(groundXPx, umbY);
		ctx.rotate(UnitConvertUtils.deg2rad(-this.umbilicalAngle));

		// Vertical Truss Column (from ground to tower top)
		ctx.fillStyle = conf.TRUSS_COLOR;
		ctx.fillRect(0, -umbTowerW * 0.5, umbTowerHeightPx, umbTowerW);

		// Umbilical Tower Cross-bracing
		ctx.strokeStyle = conf.TRUSS_HIGHLIGHT;
		ctx.lineWidth = Math.max(1, rPx * conf.UMBILICAL_TRUSS_WIDTH_MULT);
		ctx.beginPath();
		const umbBays = Math.max(conf.UMBILICAL_MIN_BAYS, Math.round(umbTowerHeightPx / (rPx * conf.UMBILICAL_BAY_INTERVAL_MULT)));
		const umbBayLen = umbTowerHeightPx / umbBays;
		for (let i = 0; i < umbBays; i++) {
			const sx = i * umbBayLen;
			const ex = sx + umbBayLen;
			ctx.moveTo(sx, -umbTowerW * 0.5); ctx.lineTo(ex, umbTowerW * 0.5);
			ctx.moveTo(sx, umbTowerW * 0.5); ctx.lineTo(ex, -umbTowerW * 0.5);
		}
		ctx.stroke();

		// Upper Service Arm (Extending towards the rocket from the tower top)
		const armThickPx = umbTowerW * conf.UMBILICAL_ARM_THICK_MULT;
		ctx.fillStyle = conf.TRUSS_COLOR;
		ctx.fillRect(umbTowerHeightPx - armThickPx, 0, armThickPx, umbArmLenPx);

		// Arm diagonal support strut
		ctx.beginPath();
		ctx.moveTo(umbTowerHeightPx - armThickPx * conf.ARM_STRUT_ROOT_MULT, 0);
		ctx.lineTo(umbTowerHeightPx - armThickPx, umbArmLenPx * conf.ARM_STRUT_TIP_MULT);
		ctx.stroke();

		ctx.restore();

		// Umbilical Cable (Physics-based swing and hang from arm tip)
		this.umbilicalCable.draw(ctx, rPx, conf);

		ctx.restore();

		this._drawParticles(ctx, renderContext, context, ['deluge']);
	}

	drawForeground(ctx, renderContext, context) {
		if (!this.isActive) return;
		this._drawParticles(ctx, renderContext, context, ['smoke_white', 'chill', 'spark', 'ice']);
	}

	_drawParticles(ctx, renderContext, context, types) {
		const zoomScale = renderContext.zoomScale;
		const basis = renderContext.basis;

		const visualScreenRadius = Math.max(PAD_EFFECT.PHYSICS.MIN_VISUAL_RADIUS_PX, context.m2pix(this.rocketRadius) * zoomScale);
		const absPos = this._getAbsPadPosition(context);

		ctx.save();
		for (const p of this.particles) {
			if (!types.includes(p.type)) continue;

			const absX = absPos.x + p.x;
			const absY = absPos.y + p.y;
			const px = (absX - basis.x) * zoomScale;
			const py = (absY - basis.y) * zoomScale;
			
			const pDef = PAD_EFFECT.PARTICLES[p.type];
			
			const baseSizeRatio = p.size !== undefined ? p.size : PAD_EFFECT.PHYSICS.DEFAULT_PARTICLE_SIZE;
			const drawSize = Math.max(PAD_EFFECT.PHYSICS.MIN_PARTICLE_DRAW_SIZE, visualScreenRadius * baseSizeRatio * pDef.SIZE_MULT);

			ctx.beginPath();
			
			let alpha = Math.max(0, Math.min(1, p.life));
			if (pDef.MAX_ALPHA !== undefined) {
				alpha = alpha * pDef.MAX_ALPHA;
			}
			ctx.globalAlpha = alpha;
			
			ctx.fillStyle = pDef.COLOR;

			if (pDef.SHAPE === 'square') {
				ctx.fillRect(px - drawSize / 2, py - drawSize / 2, drawSize, drawSize);
			} else if (pDef.SHAPE === 'stretch') {
				const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
				const angle = Math.atan2(p.vy, p.vx);
				const stretchFactor = Math.min(PAD_EFFECT.PHYSICS.MAX_STRETCH_FACTOR, Math.max(PAD_EFFECT.PHYSICS.MIN_STRETCH_FACTOR, speed * PAD_EFFECT.PHYSICS.STRETCH_SPEED_SCALE));

				ctx.save();
				ctx.translate(px, py);
				ctx.rotate(angle);
				ctx.ellipse(0, 0, drawSize * stretchFactor, drawSize, 0, 0, Math.PI * 2);
				ctx.fill();
				ctx.restore();
			} else {
				ctx.arc(px, py, drawSize, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		ctx.restore();
	}
}
