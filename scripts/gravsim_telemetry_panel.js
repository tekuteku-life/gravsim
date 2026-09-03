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

		this.ui = {
			toggleBtn: document.getElementById('telemetry-toggle-btn'),
			panel: document.getElementById('telemetry-panel'),
			targetSelect: document.getElementById('tm-target-select'),
			missionStatus: document.getElementById('tm-mission-status'),
			missionTime: document.getElementById('tm-met'),
			carousel: document.getElementById('tm-carousel'),
			dots: document.getElementById('tm-dots'),
			minimalHud: document.getElementById('minimal-hud-bar'),
			mHudMet: document.getElementById('m-hud-met'),
			mHudStat: document.getElementById('m-hud-stat'),
			mHudAlt: document.getElementById('m-hud-alt'),
			mHudVel: document.getElementById('m-hud-vel'),
			subCanvas: document.getElementById('sub-canvas'),
			countdownDisplay: document.getElementById('countdown-display'),
			cdTime: document.getElementById('cd-time'),
			cdEvent: document.getElementById('cd-event'),
		};
		DOMUtils.verifyElements(this.ui, 'TelemetryPanel');

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

		// Event listeners for launch sequence updates and animations
		EventBus.on('sequencer-start', () => {
			this.ui.countdownDisplay.style.display = 'block';
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
		const target = this._resolveTarget();

		// Minimal HUD Bar when telemetry panel is closed
		if (!this.isOpen) {
			this._updateMinimalHud(target);
			return;
		}

		if (!target) { return; }

		const isRocketWithTelemetry = target.type === OBJECT_TYPES.ROCKET && target.telemetry;

		if (isRocketWithTelemetry) {
			this._updatePinnedHeader(target);
			for (const card of this.cards) {
				if (card.isVisible) {
					card.update(target, target.telemetry);
				}
			}
		} else {
			this._resetPinnedHeader(target);
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
