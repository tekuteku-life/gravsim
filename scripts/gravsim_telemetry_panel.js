// gravsim_telemetry_panel.js

import { UI, OBJECT_TYPES, TELEMETRY, EVENT_PRIORITY } from './gravsim_const.js';
import { Renderer } from './gravsim_renderer.js';
import { DOMUtils, UnitConvertUtils, FormatUtils } from './gravsim_utils.js';
import { EventBus } from './gravsim_event_bus.js';
import {
	TelemetryCard,
	FlightDynamicsCard,
	AeroGuidanceCard,
	PropulsionCard,
	NavigationCameraCard
} from './gravsim_telemetry_card.js';

/*******************************************************************
 * Telemetry Panel Coordinator Class
 *******************************************************************/
export class TelemetryPanel {
	constructor(universe) {
		this.universe = universe;
		this.isOpen = false;
		this.targetId = 0;
		this.activeCardIndex = 0;

		this.lampTestTimer = 0;
		this.lastUpdateTime = performance.now();

		this.ui = {
			toggleBtn: document.getElementById('telemetry-toggle-btn'),
			panel: document.getElementById('telemetry-panel'),
			targetSelect: document.getElementById('tm-target-select'),
			missionStatus: document.getElementById('tm-mission-status'),
			missionTime: document.getElementById('tm-met'),
			annunciator: document.getElementById('tm-annunciator'),
			lampQlim: document.getElementById('tm-lamp-qlim'),
			lampGlim: document.getElementById('tm-lamp-glim'),
			lampStall: document.getElementById('tm-lamp-stall'),
			lampWarn: document.getElementById('tm-lamp-warn'),
			lampAuto: document.getElementById('tm-lamp-auto'),
			lampTwr: document.getElementById('tm-lamp-twr'),
			lampPitch: document.getElementById('tm-lamp-pitch'),
			lampOrbit: document.getElementById('tm-lamp-orbit'),
			lampPress: document.getElementById('tm-lamp-press'),
			lampEng: document.getElementById('tm-lamp-eng'),
			lampMeco: document.getElementById('tm-lamp-meco'),
			lampSep: document.getElementById('tm-lamp-sep'),
			carousel: document.getElementById('tm-carousel'),
			dots: document.getElementById('tm-dots'),
			minimalHud: document.getElementById('minimal-hud-bar'),
			mHudMet: document.getElementById('m-hud-met'),
			mHudStat: document.getElementById('m-hud-stat'),
			mHudAlt: document.getElementById('m-hud-alt'),
			mHudVel: document.getElementById('m-hud-vel'),
			mHudAlert: document.getElementById('m-hud-alert'),
			subCanvas: document.getElementById('sub-canvas'),
			countdownDisplay: document.getElementById('countdown-display'),
			cdTime: document.getElementById('cd-time'),
			cdEvent: document.getElementById('cd-event'),
		};
		DOMUtils.verifyElements(this.ui, 'TelemetryPanel');

		this.lamps = {
			qlim: this.ui.lampQlim,
			glim: this.ui.lampGlim,
			stall: this.ui.lampStall,
			warn: this.ui.lampWarn,
			auto: this.ui.lampAuto,
			twr: this.ui.lampTwr,
			pitch: this.ui.lampPitch,
			orbit: this.ui.lampOrbit,
			press: this.ui.lampPress,
			eng: this.ui.lampEng,
			meco: this.ui.lampMeco,
			sep: this.ui.lampSep,
		};

		this.subRenderer = new Renderer(this.ui.subCanvas, 'telemetry');

		// Initialize modular cards
		this.cards = [
			new FlightDynamicsCard('dynamics', 'Flight & Dynamics', document.getElementById('tm-card-dynamics')),
			new AeroGuidanceCard('aero', 'Aero & Guidance', document.getElementById('tm-card-aero')),
			new PropulsionCard('propulsion', 'Propulsion & Tanks', document.getElementById('tm-card-propulsion')),
			new NavigationCameraCard('navigation', 'Navigation & Camera', document.getElementById('tm-card-navigation'), this.subRenderer),
		];

		for (const card of this.cards) {
			card.initElements();
		}

		this._dotElements = Array.from(this.ui.dots.querySelectorAll('.tm-dot'));

		this._initCarouselObserver();
		this._bindEvents();

		// Register to the main logic update loop
		EventBus.registerInterval(UI.UPDATE_INTERVAL.TELEMETRY, () => {
			this.update();
		});

		// Subscribe to object list changes
		EventBus.on('object-list-changed', () => {
			this._updateTargetOptions();
		});

		// Hook into the main draw pipeline
		EventBus.onDrawOverlay((ctx, rc) => {
			if (rc.name === 'main') {
				this.draw();
			}
		}, EVENT_PRIORITY.DRAW_HUD);
	}

	_initCarouselObserver() {
		// Pre-wake detection margin to prepare card before entering viewport (both horizontal and vertical)
		const observerOptions = {
			root: this.ui.carousel,
			rootMargin: '40px 40px 40px 40px',
			threshold: 0.1
		};

		if (typeof IntersectionObserver !== 'undefined') {
			this._cardObserver = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					const cardEl = entry.target;
					const card = this.cards.find(c => c.element === cardEl);
					if (!card) continue;

					const wasVisible = card.isVisible;
					card.isVisible = entry.isIntersecting;

					// Wake-up / Force Sync on visible transition
					if (!wasVisible && card.isVisible) {
						const target = this._resolveTarget();
						if (target && target.type === OBJECT_TYPES.ROCKET && target.telemetry) {
							card.onBecameVisible(target, target.telemetry);
						}
					}
				}
			}, observerOptions);

			for (const card of this.cards) {
				this._cardObserver.observe(card.element);
			}
		} else {
			// Fallback: mark all cards visible
			for (const card of this.cards) {
				card.isVisible = true;
			}
		}
	}

	_bindEvents() {
		this.ui.toggleBtn.addEventListener('click', () => {
			if (!this.isOpen) { this.open(); }
			else { this.close(); }
		});

		this.ui.targetSelect.addEventListener('change', (e) => {
			this.targetId = parseInt(e.target.value, 10);
		});

		// Scroll listener on carousel to sync active pagination dot
		this.ui.carousel.addEventListener('scroll', () => {
			this._syncActiveDotFromScroll();
		}, { passive: true });

		// Mouse wheel / trackpad scroll listener to switch cards seamlessly
		let isWheelThrottled = false;
		this.ui.panel.addEventListener('wheel', (e) => {
			// Determine dominant scroll direction
			const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			if (Math.abs(delta) < 12) return;

			// Prevent background canvas zooming / scrolling while hovering telemetry panel
			e.preventDefault();
			e.stopPropagation();

			if (isWheelThrottled) return;

			if (delta > 0) {
				this.nextCard();
			} else {
				this.prevCard();
			}

			isWheelThrottled = true;
			setTimeout(() => {
				isWheelThrottled = false;
			}, 240);
		}, { passive: false });

		// Touch swipe listeners for mobile swipe navigation
		let touchStartX = 0;
		let touchStartY = 0;
		let touchStartTime = 0;

		this.ui.panel.addEventListener('touchstart', (e) => {
			if (e.touches.length === 1) {
				touchStartX = e.touches[0].clientX;
				touchStartY = e.touches[0].clientY;
				touchStartTime = Date.now();
			}
		}, { passive: true });

		this.ui.panel.addEventListener('touchend', (e) => {
			if (e.changedTouches.length === 1) {
				const diffX = e.changedTouches[0].clientX - touchStartX;
				const diffY = e.changedTouches[0].clientY - touchStartY;
				const elapsed = Date.now() - touchStartTime;

				const absX = Math.abs(diffX);
				const absY = Math.abs(diffY);

				if (elapsed < 500) {
					if (absX > 25 && absX >= absY) {
						if (diffX < 0) {
							this.nextCard();
						} else {
							this.prevCard();
						}
					} else if (absY > 25 && absY > absX) {
						if (diffY < 0) {
							this.nextCard();
						} else {
							this.prevCard();
						}
					}
				}
			}
		}, { passive: true });

		// Click on pagination dots to jump to card
		for (const dot of this._dotElements) {
			dot.addEventListener('click', (e) => {
				const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
				if (!isNaN(idx)) {
					this.goToCard(idx);
				}
			});
		}

		// Click on annunciator to trigger Lamp Test
		this.ui.annunciator.addEventListener('click', () => {
			this.startLampTest(TELEMETRY.ANNUNCIATOR?.LAMP_TEST_DURATION_SEC || 1.5);
		});

		// Event listeners for launch sequence updates and animations
		EventBus.on('sequencer-start', () => {
			this.ui.countdownDisplay.style.display = 'block';
			this.startLampTest(2.0);
		});

		const resetSequenceUI = () => {
			this.ui.countdownDisplay.style.display = 'none';
			this.ui.panel.classList.remove('auto-sequence-mode');
		};
		EventBus.on('sequencer-end', resetSequenceUI);
		EventBus.on('sequencer-abort', resetSequenceUI);

		EventBus.on('sequencer-tick', (data) => {
			DOMUtils.setText(this.ui.cdTime, data.timeText);
			DOMUtils.setText(this.ui.cdEvent, data.eventName);
		});

		EventBus.on('sequencer-event', () => {
			this.ui.countdownDisplay.classList.remove('flash');
			void this.ui.countdownDisplay.offsetWidth; 
			this.ui.countdownDisplay.classList.add('flash');
		});

		EventBus.on('auto-sequence-start', () => {
			this.ui.panel.classList.add('auto-sequence-mode');
			this.startLampTest(2.0);
		});

		EventBus.on('liftoff', () => {
			this.ui.panel.classList.remove('auto-sequence-mode');
		});
	}

	goToCard(index) {
		const targetIdx = Math.max(0, Math.min(index, this.cards.length - 1));
		this.activeCardIndex = targetIdx;

		if (this.cards[targetIdx]?.element) {
			this.cards[targetIdx].element.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
				inline: 'start'
			});
		}

		this._dotElements.forEach((dot, idx) => {
			dot.classList.toggle('active', idx === targetIdx);
		});
	}

	nextCard() {
		if (this.activeCardIndex < this.cards.length - 1) {
			this.goToCard(this.activeCardIndex + 1);
		}
	}

	prevCard() {
		if (this.activeCardIndex > 0) {
			this.goToCard(this.activeCardIndex - 1);
		}
	}

	_syncActiveDotFromScroll() {
		const scrollLeft = this.ui.carousel.scrollLeft;
		const scrollTop = this.ui.carousel.scrollTop;
		const width = this.ui.carousel.clientWidth || 1;
		const height = this.ui.carousel.clientHeight || 1;

		let activeIndex = 0;
		if (this.ui.carousel.scrollHeight > this.ui.carousel.clientHeight && scrollTop > 10) {
			activeIndex = Math.round(scrollTop / (this.cards[0]?.element?.offsetHeight || height));
		} else {
			activeIndex = Math.round(scrollLeft / width);
		}

		activeIndex = Math.max(0, Math.min(activeIndex, this.cards.length - 1));

		if (activeIndex !== this.activeCardIndex) {
			this.activeCardIndex = activeIndex;
			this._dotElements.forEach((dot, idx) => {
				dot.classList.toggle('active', idx === activeIndex);
			});
		}
	}

	_updateTargetOptions() {
		this.ui.targetSelect.innerHTML = '';
		for (const obj of this.universe.objects) {
			if (obj.type === OBJECT_TYPES.CELESTIAL) { continue; }

			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name.substring(0, 10)} (ID:${obj.id})`;

			if (obj.id === this.targetId) {
				option.selected = true;
			}
			this.ui.targetSelect.appendChild(option);
		}
	}

	_openCloseCtl(_open) {
		this.isOpen = _open;
		this.ui.panel.classList.toggle('open', _open);

		if (_open) {
			this.ui.minimalHud.style.display = 'none';
			this.update();
		} else {
			this._updateMinimalHud();
		}
	}

	open() { this._openCloseCtl(true); }
	close() { this._openCloseCtl(false); }

	_resolveTarget() {
		let target = this.universe.objects.find(o => o.id === this.targetId && o.type === OBJECT_TYPES.ROCKET);
		if (!target) {
			target = this.universe.camera.trackingTarget;
			if (target && target.type === OBJECT_TYPES.ROCKET) {
				this.targetId = target.id;
				this.ui.targetSelect.value = target.id;
			} else {
				this.targetId = parseInt(this.ui.targetSelect.value, 10);
				target = this.universe.objects.find(o => o.id === this.targetId && o.type === OBJECT_TYPES.ROCKET);
				if (!target) {
					target = null;
				}
			}
		}
		return target;
	}

	update() {
		const now = performance.now();
		const dt = Math.min(0.2, (now - this.lastUpdateTime) / 1000);
		this.lastUpdateTime = now;

		if (this.lampTestTimer > 0) {
			this.lampTestTimer -= dt;
		}

		const target = this._resolveTarget();

		// Minimal HUD Bar when telemetry panel is closed
		if (!this.isOpen) {
			this._updateMinimalHud(target);
			return;
		}

		if (!target) {
			this._resetPinnedHeader(null);
			this._resetAnnunciator();
			return;
		}

		const isRocketWithTelemetry = target.type === OBJECT_TYPES.ROCKET && target.telemetry;

		if (isRocketWithTelemetry) {
			this._updatePinnedHeader(target);
			this._updateAnnunciator(target, target.telemetry);
			for (const card of this.cards) {
				if (card.isVisible) {
					card.update(target, target.telemetry);
				}
			}
		} else {
			this._resetPinnedHeader(target);
			this._resetAnnunciator();
			for (const card of this.cards) {
				if (card.isVisible) {
					card.resetUI(target);
				}
			}
		}
	}

	_updatePinnedHeader(target) {
		const tm = target.telemetry;

		let mStat = TELEMETRY.STATUS_MAP[tm.status] || TELEMETRY.STATUS_MAP[0];
		if (tm.status === TELEMETRY.STATUS.PRE_LAUNCH && this.universe.LaunchSequencer.isAutoSequence) {
			mStat = "AUTO-SEQUENCE";
		}

		DOMUtils.setText(this.ui.missionStatus, mStat);

		if (tm.status === TELEMETRY.STATUS.MAX_Q) {
			DOMUtils.setStyle(this.ui.missionStatus, 'color', TELEMETRY.STYLE.MISSION_STATUS.MAX_Q_COLOR);
		} else {
			DOMUtils.setStyle(this.ui.missionStatus, 'color', TELEMETRY.STYLE.MISSION_STATUS.NORMAL_COLOR);
		}

		let displayTimeSec = tm.flightTime;
		if (this.universe.LaunchSequencer.isActive && this.universe.LaunchSequencer.rocketId === target.id) {
			displayTimeSec = this.universe.LaunchSequencer.timer - this.universe.LaunchSequencer.tMinusOffset;
		}

		DOMUtils.setText(this.ui.missionTime, FormatUtils.timeMission(displayTimeSec));
	}

	_resetPinnedHeader(target) {
		DOMUtils.setText(this.ui.missionStatus, TELEMETRY.STATUS_MAP[6]);
		DOMUtils.setStyle(this.ui.missionStatus, 'color', TELEMETRY.STYLE.MISSION_STATUS.NORMAL_COLOR);
		DOMUtils.setText(this.ui.missionTime, "T+ ---y ---d --:--:--");
	}

	_updateMinimalHud(target) {
		if (this.isOpen || !target || target.type !== OBJECT_TYPES.ROCKET || !target.telemetry) {
			this.ui.minimalHud.style.display = 'none';
			if (this.ui.mHudAlert) this.ui.mHudAlert.style.display = 'none';
			return;
		}

		const tm = target.telemetry;
		this.ui.minimalHud.style.display = 'block';

		let mStat = TELEMETRY.STATUS_MAP[tm.status] || TELEMETRY.STATUS_MAP[0];
		if (tm.status === TELEMETRY.STATUS.PRE_LAUNCH && this.universe.LaunchSequencer.isAutoSequence) {
			mStat = "AUTO-SEQ";
		}

		let displayTimeSec = tm.flightTime;
		if (this.universe.LaunchSequencer.isActive && this.universe.LaunchSequencer.rocketId === target.id) {
			displayTimeSec = this.universe.LaunchSequencer.timer - this.universe.LaunchSequencer.tMinusOffset;
		}

		const totalVelKmS = Math.sqrt(tm.vV * tm.vV + tm.vH * tm.vH) / 1000;

		DOMUtils.setText(this.ui.mHudMet, FormatUtils.timeMission(displayTimeSec));
		DOMUtils.setText(this.ui.mHudStat, mStat);
		DOMUtils.setText(this.ui.mHudAlt, (UnitConvertUtils.m2km(tm.altM)).toFixed(1));
		DOMUtils.setText(this.ui.mHudVel, totalVelKmS.toFixed(2));

		// Minimal HUD Alert badge
		if (this.ui.mHudAlert) {
			const maxG = target.maxGLimit || 0;
			const isQLimit = Boolean(tm.isQLimitNear || (tm.structRatio >= (TELEMETRY.ANNUNCIATOR?.Q_LIM_TH || 75)) || (tm.status === TELEMETRY.STATUS.MAX_Q));
			const isGLimit = Boolean(tm.isGLimitNear || (maxG > 0 && tm.currentG >= maxG * (TELEMETRY.ANNUNCIATOR?.G_LIM_RATIO || 0.85)));
			const isStall = Boolean(tm.isAntiStallActive);

			if (isQLimit) {
				DOMUtils.setText(this.ui.mHudAlert, '[Q-LIM]');
				this.ui.mHudAlert.style.display = 'inline';
			} else if (isGLimit) {
				DOMUtils.setText(this.ui.mHudAlert, '[G-LIM]');
				this.ui.mHudAlert.style.display = 'inline';
			} else if (isStall) {
				DOMUtils.setText(this.ui.mHudAlert, '[STALL]');
				this.ui.mHudAlert.style.display = 'inline';
			} else {
				this.ui.mHudAlert.style.display = 'none';
			}
		}
	}

	startLampTest(durationSec = 1.5) {
		this.lampTestTimer = durationSec;
	}

	_updateAnnunciator(target, tm) {
		if (!this.lamps) return;

		// Lamp Test mode: Light all lamps solidly
		if (this.lampTestTimer > 0) {
			for (const lamp of Object.values(this.lamps)) {
				lamp.classList.add('on');
				lamp.classList.remove('blink');
			}
			return;
		}

		const conf = TELEMETRY.ANNUNCIATOR || {};
		const qLimitTh = conf.Q_LIM_TH || 75;
		const gRatioTh = conf.G_LIM_RATIO || 0.85;
		const twrAltTh = conf.TOWER_CLEARANCE_ALT || 1000;
		const twrTimeTh = conf.TOWER_CLEARANCE_TIME || 10;
		const fairingAltTh = conf.FAIRING_SEP_ALT || 100000;
		const orbitVelKmS = conf.ORBITAL_VELOCITY_KM_S || 7.5;

		const maxG = target.maxGLimit || 0;
		const totalVelKmS = Math.sqrt(tm.vV * tm.vV + tm.vH * tm.vH) / 1000;

		// 1. Q-LIM (Dynamic Pressure Limit approaching)
		const isQLimit = Boolean(tm.isQLimitNear || tm.structRatio >= qLimitTh || tm.status === TELEMETRY.STATUS.MAX_Q);
		this._setLamp('qlim', isQLimit, isQLimit);

		// 2. G-LIM (G-Force Limit approaching)
		const isGLimit = Boolean(tm.isGLimitNear || (maxG > 0 && tm.currentG >= maxG * gRatioTh));
		this._setLamp('glim', isGLimit, isGLimit);

		// 3. STALL (Anti-Stall / Load Relief active)
		const isStall = Boolean(tm.isAntiStallActive);
		this._setLamp('stall', isStall, false);

		// 4. WARN (Master Caution / Warning)
		const isLowPropellant = target.isIgnited && target.fuelMass > 0 && target.fuelMass <= 0.05 * (target.maxFuel || target.fuelMass);
		const isMasterWarn = isQLimit || isGLimit || isStall || isLowPropellant;
		this._setLamp('warn', isMasterWarn, isMasterWarn);

		// 5. AUTO (Automatic Flight Guidance active)
		const isAuto = Boolean(target.autoControl || (this.universe.LaunchSequencer.isActive && this.universe.LaunchSequencer.isAutoSequence));
		this._setLamp('auto', isAuto, false);

		// 6. TWR-C (Tower Cleared)
		const isLaunched = tm.status !== TELEMETRY.STATUS.PRE_LAUNCH;
		const isTowerCleared = isLaunched && (tm.altM >= twrAltTh || tm.flightTime >= twrTimeTh);
		this._setLamp('twr', isTowerCleared, false);

		// 7. PITCH (Pitch / Gravity turn program)
		const isPitching = isTowerCleared && (tm.status === TELEMETRY.STATUS.ASCENT || tm.status === TELEMETRY.STATUS.MAX_Q);
		this._setLamp('pitch', isPitching, false);

		// 8. ORBIT (Orbital velocity acquired / Insertion)
		const isOrbit = isLaunched && (totalVelKmS >= orbitVelKmS && tm.altM >= 80000);
		this._setLamp('orbit', isOrbit, false);

		// 9. PRESS (Tank pressure nominal)
		const isPress = target.presState === 'NOMINAL' || (tm.tankPresFuel >= 250 && tm.tankPresOxid >= 250);
		this._setLamp('press', isPress, false);

		// 10. ENG-ON (Main engine thrusting)
		const isEngOn = Boolean(target.thrustRatio > 0.01 && target.fuelMass > 0.01 && (target.burnTime > 0 || target.isIgnited));
		this._setLamp('eng', isEngOn, false);

		// 11. MECO (Main engine cutoff)
		const isMeco = isLaunched && (tm.status === TELEMETRY.STATUS.MECO || tm.status === TELEMETRY.STATUS.COASTING || tm.status === TELEMETRY.STATUS.TRACKING || (target.fuelMass <= 0.01 && !isEngOn));
		this._setLamp('meco', isMeco, false);

		// 12. STG-SEP (Fairing / Stage separation)
		const isStageSep = isLaunched && (tm.altM >= fairingAltTh || (isMeco && tm.flightTime > 15));
		this._setLamp('sep', isStageSep, false);
	}

	_setLamp(lampKey, isOn, isBlink = false) {
		const lamp = this.lamps[lampKey];
		if (!lamp) return;
		lamp.classList.toggle('on', isOn);
		lamp.classList.toggle('blink', isOn && isBlink);
	}

	_resetAnnunciator() {
		if (!this.lamps) return;
		for (const lamp of Object.values(this.lamps)) {
			lamp.classList.remove('on');
			lamp.classList.remove('blink');
		}
	}

	draw() {
		if (!this.isOpen) return;

		// Card 4 handles drawing target camera only when visible
		const navCard = this.cards.find(c => c.id === 'navigation');
		if (navCard) {
			navCard.draw(this.universe, this.targetId);
		}
	}
}
