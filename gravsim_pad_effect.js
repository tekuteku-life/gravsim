
// gravsim_pad_effect.js

import { PAD_EFFECT, DEFAULT_OBJECT_PARAMS } from './gravsim_const.js';

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
			isPressurized: false
		};
		this.strongbackAngle = 0;
		this.umbilicalAngle = 0;
		
		// For storing local relative coordinates to avoid global lag
		this.startRelPadX = 0;
		this.startRelPadY = 0;
		this.startLaunchAngle = 0;
		this.rocketRadius = 0;
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
			isPressurized: false
		};
		this.strongbackAngle = 0;
		this.umbilicalAngle = 0;
		this.lastContext = null;
	}

	stop() {
		this.isActive = false;
		this.targetRocketId = null;
		this.hostId = null;
		this.particles = [];
	}

	handleEvent(eventName) {
		if (eventName.includes('COUNTDOWN START')) { this.flags.isVenting = true; }
		else if (eventName.includes('CHILLDOWN')) { this.flags.isChilldown = true; }
		else if (eventName.includes('PRESSURIZATION')) { this.flags.isPressurized = true; }
		else if (eventName.includes('INTERNAL POWER')) { this.flags.isInternalPower = true; }
		else if (eventName.includes('WATER DELUGE')) { this.flags.isWaterDeluge = true; }
		else if (eventName.includes('ROFI')) { this.flags.isROFI = true; }
		else if (eventName.includes('MAIN ENGINE START')) { this.flags.isChilldown = false; }
	}

	handleLiftoff() {
		console.log("liftoff!");
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
			const visualScreenRadius = Math.max(2, physicalScreenRadius);
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
			
			const dropVx = vec.B.x * conf.V_RAND * Math.random() + (Math.random() - 0.5) * 2;
			const dropVy = vec.B.y * conf.V_RAND * Math.random() + (Math.random() - 0.5) * 2;

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

		for(let i = 0; i < conf.COUNT; i++) {
			this.particles.push({
				type: 'spark',
				x: vec.B.x * visualRadius,
				y: vec.B.y * visualRadius,
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
			this.rocketRadius = rocket.radius;
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

		if (this.flags.isInternalPower) {
			this.strongbackAngle += PAD_EFFECT.STRUCTURE.STRONGBACK_RETRACT_SPEED * dt;
			if (this.strongbackAngle > PAD_EFFECT.STRUCTURE.STRONGBACK_MAX_ANGLE) {
				this.strongbackAngle = PAD_EFFECT.STRUCTURE.STRONGBACK_MAX_ANGLE;
			}
		}

		if (rocket && !rocket.isHoldDown) {
			this.umbilicalAngle += PAD_EFFECT.STRUCTURE.UMBILICAL_RETRACT_SPEED * dt;
			if (this.umbilicalAngle > PAD_EFFECT.STRUCTURE.UMBILICAL_MAX_ANGLE) {
				this.umbilicalAngle = PAD_EFFECT.STRUCTURE.UMBILICAL_MAX_ANGLE;
			}
		}

		const rPx = m2pix(this.rocketRadius);
		const visualMultiplier = this._getVisualMultiplier(context);
		const visualRadius = rPx * visualMultiplier;
		const vec = this._getVectors();

		const localNozzleX = vec.B.x * visualRadius * PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT;
		const localNozzleY = vec.B.y * visualRadius * PAD_EFFECT.PHYSICS.NOZZLE_OFFSET_MULT;
		
		const localSideX = vec.R.x * visualRadius * PAD_EFFECT.PHYSICS.SIDE_OFFSET_MULT;
		const localSideY = vec.R.y * visualRadius * PAD_EFFECT.PHYSICS.SIDE_OFFSET_MULT;
		
		const fallVx = m2pix(vec.B.x * PAD_EFFECT.PHYSICS.FALL_V_MULT) * visualMultiplier;
		const fallVy = m2pix(vec.B.y * PAD_EFFECT.PHYSICS.FALL_V_MULT) * visualMultiplier;

		const currentVentRate = this.flags.isPressurized ? PAD_EFFECT.EMITTER.VENT.PRESSURIZED_RATE : PAD_EFFECT.EMITTER.VENT.RATE;
		if (this.flags.isVenting && Math.random() < currentVentRate) {
			const conf = PAD_EFFECT.EMITTER.VENT;
			for(let i = 0; i < conf.COUNT; i++) {
				const vSpeed = conf.V_BASE + Math.random() * conf.V_RAND;
				const angleSpread = (Math.random() - 0.5) * (Math.PI / 2);
				const dirX = vec.R.x * Math.cos(angleSpread) - vec.R.y * Math.sin(angleSpread);
				const dirY = vec.R.x * Math.sin(angleSpread) + vec.R.y * Math.cos(angleSpread);
				
				const offsetX = (Math.random() - 0.5) * visualRadius * 0.8;
				const offsetY = (Math.random() - 0.5) * visualRadius * 0.2;

				this.particles.push({
					type: 'smoke_white',
					x: localSideX + offsetX,
					y: localSideY + offsetY,
					vx: m2pix(dirX * vSpeed) * visualMultiplier,
					vy: m2pix(dirY * vSpeed) * visualMultiplier,
					life: 1.0,
					maxLife: conf.LIFE_BASE + Math.random(),
					size: conf.SIZE + Math.random() * 0.05
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
			for(let i = 0; i < conf.COUNT; i++) {
				const isRight = Math.random() < 0.5;
				const sideDir = isRight ? vec.R : vec.L;
				const vSide = conf.V_BASE + Math.random() * conf.V_RAND;
				const vUp = (Math.random() * conf.V_BASE) * 0.5;
				
				this.particles.push({
					type: 'deluge',
					x: localNozzleX + vec.B.x * visualRadius * 0.5,
					y: localNozzleY + vec.B.y * visualRadius * 0.5,
					vx: m2pix(sideDir.x * vSide + vec.F.x * vUp) * visualMultiplier,
					vy: m2pix(sideDir.y * vSide + vec.F.y * vUp) * visualMultiplier,
					life: 1.0, maxLife: conf.LIFE_BASE, size: conf.SIZE
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

	drawBackground(ctx, renderContext, context) {
		if (!this.isActive) return;
		const conf = PAD_EFFECT.STRUCTURE;
		const zoomScale = renderContext.zoomScale;
		const basis = renderContext.basis;
		
		const absPos = this._getAbsPadPosition(context);
		const relX = (absPos.x - basis.x) * zoomScale;
		const relY = (absPos.y - basis.y) * zoomScale;
		
		const rPx = Math.max(2, context.m2pix(this.rocketRadius) * zoomScale);

		ctx.save();
		ctx.translate(relX, relY);
		ctx.rotate(absPos.angle);

		// Pad base
		ctx.fillStyle = conf.BASE_COLOR;
		ctx.fillRect(
			rPx * conf.BASE_X_MULT,
			rPx * conf.BASE_Y_MULT,
			rPx * conf.BASE_W_MULT,
			rPx * conf.BASE_H_MULT
		);

		const b = rPx * 2;

		// Main Strongback (Truss)
		ctx.save();
		ctx.translate(rPx * conf.STRONGBACK_X_MULT, rPx * conf.STRONGBACK_Y_MULT);
		ctx.rotate(this.strongbackAngle * Math.PI / 180);
		ctx.fillStyle = conf.TRUSS_COLOR;
		ctx.fillRect(-b * 0.5, -b * 0.2, b * conf.STRONGBACK_W_MULT, b * conf.STRONGBACK_H_MULT);
		
		ctx.strokeStyle = conf.TRUSS_HIGHLIGHT;
		ctx.lineWidth = Math.max(1, rPx * conf.STRONGBACK_TRUSS_WIDTH_MULT);
		ctx.beginPath();
		for(let i=0; i<conf.STRONGBACK_TRUSS_CROSS; i++) {
			const sx = -b * 0.5 + i * (b * conf.STRONGBACK_W_MULT / conf.STRONGBACK_TRUSS_CROSS);
			const ex = sx + (b * conf.STRONGBACK_W_MULT / conf.STRONGBACK_TRUSS_CROSS);
			ctx.moveTo(sx, -b * 0.2); ctx.lineTo(ex, b * 0.2);
			ctx.moveTo(sx, b * 0.2); ctx.lineTo(ex, -b * 0.2);
		}
		ctx.stroke();
		ctx.restore();

		// Umbilical Tower & Cables (Placed on the right side)
		ctx.save();
		ctx.translate(rPx * conf.UMBILICAL_OFFSET_X, rPx * conf.UMBILICAL_OFFSET_Y);
		ctx.rotate(-this.umbilicalAngle * Math.PI / 180);
		ctx.fillStyle = conf.TRUSS_COLOR;
		ctx.fillRect(-b * 0.3, -b * 0.1, b * conf.UMBILICAL_W_MULT, b * conf.UMBILICAL_H_MULT);

		if (context.rocket && context.rocket.isHoldDown) {
			ctx.strokeStyle = conf.CABLE_BASE_COLOR;
			ctx.lineWidth = Math.max(2, rPx * conf.CABLE_WIDTH_MULT);
			ctx.beginPath();
			ctx.moveTo(b * 1, 0.2);
			ctx.quadraticCurveTo(-b * 0.2, b * 0.2, rPx * 1.5, rPx * 0.8);
			ctx.stroke();
			
			ctx.strokeStyle = conf.CABLE_HIGH_COLOR;
			ctx.lineWidth = Math.max(1, rPx * conf.CABLE_HIGH_WIDTH_MULT);
			ctx.stroke();

			ctx.fillStyle = conf.JOINT_COLOR;
			ctx.fillRect(rPx * 1.2, rPx * 0.7, rPx * 0.4, rPx * 0.4);
		}
		ctx.restore();

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

		const visualScreenRadius = Math.max(2, context.m2pix(this.rocketRadius) * zoomScale);
		const absPos = this._getAbsPadPosition(context);

		ctx.save();
		for (const p of this.particles) {
			if (!types.includes(p.type)) continue;

			const absX = absPos.x + p.x;
			const absY = absPos.y + p.y;
			const px = (absX - basis.x) * zoomScale;
			const py = (absY - basis.y) * zoomScale;
			
			const pDef = PAD_EFFECT.PARTICLES[p.type];
			
			const baseSizeRatio = p.size !== undefined ? p.size : 0.2;
			const drawSize = Math.max(0.5, visualScreenRadius * baseSizeRatio * pDef.SIZE_MULT);

			ctx.beginPath();
			
			let alpha = Math.max(0, Math.min(1, p.life));
			if (pDef.MAX_ALPHA !== undefined) {
				alpha = alpha * pDef.MAX_ALPHA;
			}
			ctx.globalAlpha = alpha;
			
			ctx.fillStyle = pDef.COLOR;

			if (pDef.SHAPE === 'square') {
				ctx.fillRect(px - drawSize / 2, py - drawSize / 2, drawSize, drawSize);
			} else {
				ctx.arc(px, py, drawSize, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		ctx.restore();
	}
}
