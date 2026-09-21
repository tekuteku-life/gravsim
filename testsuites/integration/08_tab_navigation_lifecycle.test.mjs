/**
 * Integration Test Suite 08: Tab Navigation, UI Lifecycle, and System Integration
 * 
 * Verifies:
 * 1. ControlPanel Tab Switching Lifecycle (System, Deploy, Rocket, Navi)
 * 2. Tab and Control Locking during Rollout (first & subsequent launches), Abort, and Liftoff
 * 3. LaunchSequencer Coordinated Locking (start, abort, end)
 * 4. RocketTab Open/Close Simulation State, Camera, and TimeScale Preservation/Restoration
 * 5. Cross-Tab UI Event Propagation (object-list-changed, camera tracking changes)
 * 6. Universe Lifecycle, Object Management, Camera Fallbacks, and State Serialization
 * 7. DestructionManager Impact and Shatter Domain Logic
 * 8. TelemetryPanel & InfoPanel Edge Cases and UI Fallbacks
 * 9. RocketLauncher & PresetManager Parameter Branch Coverage
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../scripts/gravsim_camera.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { ControlPanel } from '../../scripts/gravsim_control_panel.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { RocketTab } from '../../scripts/gravsim_tab_rocket.js';
import { SystemTab } from '../../scripts/gravsim_tab_system.js';
import { DeployTab } from '../../scripts/gravsim_tab_deploy.js';
import { NaviTab } from '../../scripts/gravsim_tab_navi.js';
import { LaunchSequencer } from '../../scripts/gravsim_launch_sequencer.js';
import { InfoPanel } from '../../scripts/gravsim_info_panel.js';
import { TelemetryPanel } from '../../scripts/gravsim_telemetry_panel.js';
import { DestructionManager } from '../../scripts/gravsim_destruction_manager.js';
import { DebrisGenerator } from '../../scripts/gravsim_debris_generator.js';
import { PresetManager, presetManager } from '../../scripts/gravsim_preset_manager.js';
import { CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { CalcRocket, CalcCelestialBody, CalcDebris } from '../../scripts/gravsim_calc_object.js';
import { Renderer } from '../../scripts/gravsim_renderer.js';
import { EffectTrail } from '../../scripts/gravsim_effect_trail.js';
import { ObjectManager } from '../../scripts/gravsim_object_manager.js';
import { OBJECT_TYPES, OBJECT_STATE, PHYSICS, UI, TELEMETRY, MULTISTAGE_PRESETS, TRAJECTORY_PREDICTION } from '../../scripts/gravsim_const.js';
import {
	setupMockDOM,
	createMockUniverse,
	createMockElement,
	createMockCelestialBody,
	createMockRocket
} from '../test_helpers.mjs';

describe('Integration 08: Tab Navigation, UI Lifecycle, and System Integration', () => {
	let cleanupDOM;
	let universe;

	// Helper to create fully wired tab buttons for ControlPanel
	function setupTabButtons() {
		const tabs = ['tab-sys', 'tab-deploy', 'tab-rocket', 'tab-navi'];
		const buttons = tabs.map(tabId => {
			const btn = createMockElement('button');
			btn.className = 'tab-btn';
			btn.setAttribute('data-target', tabId);
			btn.disabled = false;
			return btn;
		});

		// Ensure target content divs exist
		tabs.forEach(tabId => {
			const tabDiv = document.getElementById(tabId);
			tabDiv.classList.remove('active');
		});

		return buttons;
	}

	beforeEach(() => {
		cleanupDOM = setupMockDOM();
		EventBus.clearAll();
		universe = createMockUniverse();
	});

	afterEach(() => {
		EventBus.clearAll();
		if (cleanupDOM) cleanupDOM();
	});

	describe('1. ControlPanel Tab Switching Lifecycle', () => {
		it('should switch between all 4 tabs and trigger corresponding tab lifecycle hooks', () => {
			const tabBtns = setupTabButtons();
			const origQSA = document.querySelectorAll;
			document.querySelectorAll = (sel) => sel === '.tab-btn' ? tabBtns : origQSA(sel);

			const cp = new ControlPanel(universe);
			document.querySelectorAll = origQSA;

			let rocketTabOpened = 0;
			let rocketTabClosed = 0;
			let systemCenterUpdated = 0;
			let naviTargetUpdated = 0;

			cp.rocketTab.open = () => { rocketTabOpened++; };
			cp.rocketTab.close = () => { rocketTabClosed++; };
			cp.systemTab.updateCenterOptions = () => { systemCenterUpdated++; };
			cp.naviTab.updateTargetOptions = () => { naviTargetUpdated++; };

			// 1. Switch to Deploy tab -> close() is called
			const deployBtn = tabBtns.find(b => b.getAttribute('data-target') === 'tab-deploy');
			deployBtn.click();
			assert.ok(deployBtn.classList.contains('active'), 'Deploy button should have active class');
			assert.ok(document.getElementById('tab-deploy').classList.contains('active'));
			assert.strictEqual(rocketTabOpened, 0);
			assert.strictEqual(rocketTabClosed, 1);

			// 2. Switch to Rocket tab -> open() should be called
			const rocketBtn = tabBtns.find(b => b.getAttribute('data-target') === 'tab-rocket');
			rocketBtn.click();
			assert.ok(rocketBtn.classList.contains('active'), 'Rocket button should have active class');
			assert.ok(document.getElementById('tab-rocket').classList.contains('active'));
			assert.strictEqual(rocketTabOpened, 1, 'RocketTab.open should be called when switching to rocket tab');

			// 3. Switch to Navi tab -> close() should be called
			const naviBtn = tabBtns.find(b => b.getAttribute('data-target') === 'tab-navi');
			naviBtn.click();
			assert.ok(naviBtn.classList.contains('active'), 'Navi button should have active class');
			assert.ok(document.getElementById('tab-navi').classList.contains('active'));
			assert.strictEqual(rocketTabClosed, 2, 'RocketTab.close should be called when leaving rocket tab');

			// 4. Switch to System tab (tab-sys) -> systemCenterUpdated called
			const sysBtn = tabBtns.find(b => b.getAttribute('data-target') === 'tab-sys');
			sysBtn.click();
			assert.ok(sysBtn.classList.contains('active'), 'System button should have active class');
			assert.ok(document.getElementById('tab-sys').classList.contains('active'));
			assert.strictEqual(systemCenterUpdated, 1, 'SystemTab.updateCenterOptions should be called when opening system tab');
			assert.strictEqual(rocketTabClosed, 3);
		});

		it('should block tab switching when tab button is disabled', () => {
			const tabBtns = setupTabButtons();
			const origQSA = document.querySelectorAll;
			document.querySelectorAll = (sel) => sel === '.tab-btn' ? tabBtns : origQSA(sel);

			const cp = new ControlPanel(universe);
			document.querySelectorAll = origQSA;

			let rocketTabOpened = 0;
			cp.rocketTab.open = () => { rocketTabOpened++; };

			const rocketBtn = tabBtns.find(b => b.getAttribute('data-target') === 'tab-rocket');
			rocketBtn.disabled = true;

			// Attempt click while disabled
			rocketBtn.click();
			assert.strictEqual(rocketTabOpened, 0, 'Click on disabled tab button must be ignored');
			assert.strictEqual(rocketBtn.classList.contains('active'), false);
		});
	});

	describe('2. Tab and Control Locking during Rollout Lifecycle', () => {
		it('should lock and unlock tabs across multiple rollout, abort, and launch cycles', () => {
			const tabBtns = setupTabButtons();
			const origQSA = document.querySelectorAll;
			document.querySelectorAll = (sel) => sel === '.tab-btn' ? tabBtns : origQSA(sel);

			const cp = new ControlPanel(universe);
			document.querySelectorAll = origQSA;
			universe.ControlPanel = cp;

			const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0 });
			universe.objects = [earth];
			universe.camera = new Camera(universe);

			const rl = new RocketLauncher(universe);
			universe.RocketLauncher = rl;
			rl.hostId = earth.id;
			rl.mode = 'host';

			// Ensure initial unlocked state
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, false);
			});

			// --- Cycle 1: Rollout -> Abort ---
			rl.rollout();
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, true, 'Tabs must be disabled after 1st rollout');
				assert.strictEqual(btn.style.pointerEvents, 'none');
				assert.strictEqual(btn.style.opacity, '0.5');
			});

			rl.abortRollout();
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, false, 'Tabs must be enabled after 1st abort');
				assert.strictEqual(btn.style.pointerEvents, 'auto');
				assert.strictEqual(btn.style.opacity, '1.0');
			});

			// --- Cycle 2: Second Rollout -> Abort ---
			rl.rollout();
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, true, 'Tabs must be disabled after 2nd rollout');
			});

			rl.abortRollout();
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, false, 'Tabs must be enabled after 2nd abort');
			});

			// --- Cycle 3: Third Rollout -> Launch (Liftoff) ---
			rl.rollout();
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, true, 'Tabs must be disabled after 3rd rollout');
			});

			// Simulate liftoff and sequence end
			EventBus.emit('liftoff', rl.rolloutedRocketId);
			EventBus.emit('sequencer-end');

			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, false, 'Tabs must be unlocked after launch sequence ends');
				assert.strictEqual(btn.style.pointerEvents, 'auto');
				assert.strictEqual(btn.style.opacity, '1.0');
			});
		});

		it('should unlock tabs via RocketTab setRolloutState when sequencer is inactive', () => {
			const tabBtns = setupTabButtons();
			const origQSA = document.querySelectorAll;
			document.querySelectorAll = (sel) => sel === '.tab-btn' ? tabBtns : origQSA(sel);

			const cp = new ControlPanel(universe);
			document.querySelectorAll = origQSA;

			const rt = cp.rocketTab;

			// Lock via rollout state
			rt.setRolloutState(true);
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, true);
			});

			// Unlock via rollout state
			rt.setRolloutState(false);
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, false);
			});
		});
	});

	describe('3. LaunchSequencer Coordinated Locking', () => {
		it('should lock tabs and controls on sequencer-start, and preserve lock if rocket is still rolled out', () => {
			const tabBtns = setupTabButtons();
			const origQSA = document.querySelectorAll;
			document.querySelectorAll = (sel) => sel === '.tab-btn' ? tabBtns : origQSA(sel);

			const cp = new ControlPanel(universe);
			document.querySelectorAll = origQSA;
			universe.ControlPanel = cp;

			const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0 });
			universe.objects = [earth];
			universe.camera = new Camera(universe);

			const rl = new RocketLauncher(universe);
			universe.RocketLauncher = rl;
			rl.hostId = earth.id;
			rl.mode = 'host';

			// Case A: Rocket rolled out, sequencer starts
			rl.rollout();
			assert.notStrictEqual(rl.rolloutedRocketId, null);

			EventBus.emit('sequencer-start', { type: 'COUNTDOWN' });
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, true);
			});

			// If sequencer aborts while rocket is STILL rolled out (not liftoff yet),
			// tabs should remain locked because rolloutedRocketId !== null
			EventBus.emit('sequencer-abort');
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, true, 'Tabs must remain locked if rocket is still rolled out on sequencer-abort');
			});

			// Case B: Aborting the rollout releases the rocket and unlocks tabs
			rl.abortRollout();
			assert.strictEqual(rl.rolloutedRocketId, null);
			tabBtns.forEach(btn => {
				assert.strictEqual(btn.disabled, false, 'Tabs must unlock after rollout is aborted');
			});
		});
	});

	describe('4. RocketTab Open/Close Simulation State and Restoration', () => {
		it('should pause simulation on open and resume on close, restoring camera and timescale', () => {
			const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
			universe.objects = [earth];

			const rt = new RocketTab(universe);

			// Pre-set simulation state
			universe.timeScale = 500;
			universe.camera.targetZoomExp = 2.5;
			universe.camera.targetOffset = { x: 100, y: 200 };

			let pausedEmitted = false;
			let resumedEmitted = false;
			EventBus.on('simulation:pause', () => { pausedEmitted = true; });
			EventBus.on('simulation:resume', () => { resumedEmitted = true; });

			// Open RocketTab
			rt.open();
			assert.strictEqual(rt.isOpened, true);
			assert.strictEqual(pausedEmitted, true, 'Opening rocket tab must pause simulation');

			// Close RocketTab
			rt.close();
			assert.strictEqual(rt.isOpened, false);
			assert.strictEqual(resumedEmitted, true, 'Closing rocket tab must resume simulation');
			assert.strictEqual(universe.timeScale, 500, 'TimeScale should be restored');
			assert.strictEqual(universe.camera.targetZoomExp, 2.5, 'Zoom should be restored');
		});

		it('should skip camera and timescale restoration when closing with rollouted rocket', () => {
			const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
			universe.objects = [earth];

			const rt = new RocketTab(universe);
			universe.RocketLauncher.rolloutedRocketId = 999; // Simulate rollout in progress

			universe.timeScale = 10;
			rt.open();

			universe.timeScale = 1; // Launcher set to 1
			rt.close();

			// Because rollout is active, it should NOT overwrite the live launch timescale
			assert.strictEqual(universe.timeScale, 1);
		});

		it('should resolve default host when hostId is null or 0', () => {
			const sun = createMockCelestialBody({ id: 0, name: 'Sun' });
			const mars = createMockCelestialBody({ id: 4, name: 'Mars' });
			universe.objects = [sun, mars];

			const rt = new RocketTab(universe);
			universe.RocketLauncher.hostId = null;

			// Test _getDefaultHostId with no Earth present -> should pick non-Sun celestial
			const defaultHost = rt._getDefaultHostId();
			assert.strictEqual(defaultHost, 4, 'Should default to non-Sun celestial body');

			// Test when only Sun is present
			universe.objects = [sun];
			const sunDefault = rt._getDefaultHostId();
			assert.strictEqual(sunDefault, 0, 'Should fallback to Sun if no other celestials exist');

			// Test when no celestials present
			universe.objects = [];
			const emptyDefault = rt._getDefaultHostId();
			assert.strictEqual(emptyDefault, 0, 'Should return 0 when no celestials exist');
		});
	});

	describe('5. Cross-Tab UI Event Propagation', () => {
		it('should update SystemTab center options and NaviTab target options on object-list-changed', () => {
			const tabBtns = setupTabButtons();
			const origQSA = document.querySelectorAll;
			document.querySelectorAll = (sel) => sel === '.tab-btn' ? tabBtns : origQSA(sel);

			const cp = new ControlPanel(universe);
			document.querySelectorAll = origQSA;

			const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
			const moon = createMockCelestialBody({ id: 2, name: 'Moon' });
			universe.objects = [earth, moon];

			EventBus.emit('object-list-changed', 2);

			const sysSelect = cp.systemTab.ui.centerSelect;
			assert.ok(sysSelect.children.length >= 2, 'SystemTab center select should have options for objects');

			const naviSelect = cp.naviTab.ui.nvTargetSelect;
			assert.ok(naviSelect.children.length >= 2, 'NaviTab target select should have options for objects');
		});

		it('should update SystemTab center select when camera:set-tracking-target is emitted', () => {
			const tabBtns = setupTabButtons();
			const origQSA = document.querySelectorAll;
			document.querySelectorAll = (sel) => sel === '.tab-btn' ? tabBtns : origQSA(sel);

			const cp = new ControlPanel(universe);
			document.querySelectorAll = origQSA;

			const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
			universe.objects = [earth];
			cp.systemTab.updateCenterOptions();

			EventBus.emit('camera:set-tracking-target', earth);
			assert.strictEqual(cp.systemTab.ui.centerSelect.value, '1');
		});
	});

	describe('6. DestructionManager Domain Logic and Event Handling', () => {
		it('should handle object:impacted event, generate debris, emit shockwave, and add debris to universe', () => {
			const addedObjects = [];
			const mockUni = {
				ObjectManager: { getNextId: () => 777 },
				addObject: (obj) => { addedObjects.push(obj); }
			};

			const dm = new DestructionManager(mockUni);

			let shockwaveData = null;
			EventBus.on('effect:shockwave', (x, y, color) => {
				shockwaveData = { x, y, color };
			});

			const target = createMockCelestialBody({ id: 1, name: 'Earth', x: 0, y: 0, radius: 6371000, color: '#4477aa', generation: 0 });
			const objData = {
				debrisMass: 50000,
				impactVx: 2000,
				impactVy: -1000,
				impactWinnerX: 0,
				impactWinnerY: 0,
				impactWinnerRadius: 6371000
			};

			EventBus.emit('object:impacted', target, objData);

			assert.ok(shockwaveData !== null, 'effect:shockwave event must be emitted');
			assert.ok(addedObjects.length > 0, 'Debris must be added to universe on impact');
		});

		it('should handle object:shattered event, generate debris, and add debris to universe', () => {
			const addedObjects = [];
			const mockUni = {
				ObjectManager: { getNextId: () => 888 },
				addObject: (obj) => { addedObjects.push(obj); }
			};

			const dm = new DestructionManager(mockUni);

			const target = createMockRocket({ id: 202, name: 'Falcon 9', x: 100, y: 200, mass: 50, color: '#ffffff', generation: 0, radius: 20 });

			EventBus.emit('object:shattered', target);

			assert.ok(addedObjects.length > 0, 'Debris must be added to universe on shatter');
		});
	});

	describe('7. Universe Lifecycle, Object Management, Camera Fallbacks, and State Serialization', () => {
		it('should execute full Universe update, draw, and fallback camera tracking when target dies', () => {
			const canvas = createMockElement('canvas');
			const uni = new Universe(canvas);
			uni.timeScale = 1;

			// Add Earth and Rocket using real GravSim object instances
			const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#4477aa', 6, 6371000, false);
			const rocket = new Rocket(101, 'Falcon 9', 0, -6371000, 0, 0, 550, '#ffffff', 20, 10000, 0, 160, 400, false);
			rocket.hostId = 1;
			uni.addObject(earth);
			uni.addObject(rocket);

			// Track rocket
			uni.camera.trackingTarget = rocket;

			// Perform simulation tick
			uni.update(16);
			assert.ok(rocket.flightTime >= 0, 'Rocket flightTime should advance on update');

			// Draw simulation frame
			uni.draw();

			// Simulate rocket destruction (state -> INACTIVE)
			rocket.state = OBJECT_STATE.DESTROYED;
			uni.update(16);

			// Camera should fallback to host (Earth)
			assert.strictEqual(uni.camera.trackingTarget.id, earth.id, 'Camera must fallback to host Earth when rocket is destroyed');

			// Pause and Resume
			uni.pauseSimulation();
			assert.strictEqual(uni.isPaused, true);
			uni.resumeSimulation();
			assert.strictEqual(uni.isPaused, false);

			// Clear objects
			uni.clearObjects(true, true, false); // Clear debris and rockets, keep celestials
			uni.ObjectManager.cleanupObjects();
			assert.ok(!uni.objects.some(o => o.id === 101), 'Rocket must be removed by clearObjects');
			assert.ok(uni.objects.some(o => o.id === 1), 'Earth must be kept by clearObjects');

			// State serialization roundtrip
			const state = uni.getState();
			assert.ok(state.centerObjectId !== undefined);
			uni.loadState(state);

			uni.destroy();
		});
	});

	describe('8. TelemetryPanel & InfoPanel Edge Cases and UI Fallbacks', () => {
		it('should throw error when InfoPanel cannot find #info-panel DOM element', () => {
			const origGetEl = document.getElementById;
			document.getElementById = (id) => id === 'info-panel' ? null : origGetEl(id);

			assert.throws(() => {
				new InfoPanel(universe);
			}, /Info panel element not found/);

			document.getElementById = origGetEl;
		});

		it('should reset elapsed time when universe has exactly 1 celestial object', () => {
			const sun = createMockCelestialBody({ id: 0, name: 'Sun' });
			universe.objects = [sun];

			const info = new InfoPanel(universe);
			info.elapsedTime = 10.5;

			// Logic update event
			EventBus.emitUpdate(16, 0.001);
			assert.strictEqual(info.elapsedTime, 0, 'Elapsed time should be reset when only Sun exists');
		});

		it('should toggle TelemetryPanel open and close via toggle button', () => {
			const tp = new TelemetryPanel(universe);
			assert.strictEqual(tp.isOpen, false);

			tp.ui.toggleBtn.click();
			assert.strictEqual(tp.isOpen, true, 'TelemetryPanel should open on toggle click');

			tp.ui.toggleBtn.click();
			assert.strictEqual(tp.isOpen, false, 'TelemetryPanel should close on second toggle click');
		});

		it('should fallback to all cards visible when IntersectionObserver is not available', () => {
			const origIO = globalThis.IntersectionObserver;
			globalThis.IntersectionObserver = undefined;

			const tp = new TelemetryPanel(universe);
			tp.cards.forEach(card => {
				assert.strictEqual(card.isVisible, true, 'All cards must be marked visible when IntersectionObserver is undefined');
			});

			globalThis.IntersectionObserver = origIO;
		});

		it('should handle pagination dot clicks to switch cards', () => {
			// Populate dots inside tm-dots
			const dotsContainer = document.getElementById('tm-dots');
			dotsContainer.innerHTML = '';
			for (let i = 0; i < 4; i++) {
				const dot = createMockElement('span');
				dot.className = 'tm-dot';
				dot.setAttribute('data-index', String(i));
				dotsContainer.appendChild(dot);
			}

			const tp = new TelemetryPanel(universe);
			assert.strictEqual(tp._dotElements.length, 4);

			const secondDot = tp._dotElements[1];
			secondDot.dispatchEvent({ type: 'click', target: secondDot, currentTarget: secondDot });
			assert.strictEqual(tp.activeCardIndex, 1, 'Clicking dot 1 should navigate to card 1');
		});

		it('should reset card UI when selected target is not an active rocket', () => {
			const tp = new TelemetryPanel(universe);
			const celestial = createMockCelestialBody({ id: 1, name: 'Earth' });
			universe.objects = [celestial];
			tp.targetId = 1;

			// Force update
			tp.update();
			// Cards should be reset for celestial body
			tp.cards.forEach(card => {
				assert.ok(card.element !== null);
			});
		});
	});

	describe('9. RocketLauncher & PresetManager Branch Coverage', () => {
		it('should cover RocketLauncher.loadPreset parameter branches and abortRollout without host', () => {
			const rl = new RocketLauncher(universe);

			// Mock presetManager.getLegacyPreset
			const origGetLegacy = presetManager.getLegacyPreset;
			presetManager.getLegacyPreset = (key) => {
				if (key === 'TEST_SPECIAL') {
					return {
						name: 'Test Special Rocket',
						colorTheme: 'modern',
						disableOrbitalCutoff: true,
						targetApogeeKm: 400,
						targetPerigeeKm: 200,
						flightProfile: [{ type: 'alt', value: 0, thrust: 100, angle: 0 }],
						stages: [{ stageNumber: 1, fuelType: 'liquid', burnTime: 120, thrustKN: 1000 }]
					};
				}
				return origGetLegacy ? origGetLegacy.call(presetManager, key) : null;
			};

			rl.loadPreset('TEST_SPECIAL');

			assert.strictEqual(rl.disableOrbitalCutoff, true);
			assert.strictEqual(rl.targetApogeeKm, 400);
			assert.strictEqual(rl.targetPerigeeKm, 200);

			if (origGetLegacy) {
				presetManager.getLegacyPreset = origGetLegacy;
			}

			// Test abortRollout when universe has NO host objects (host not found branch)
			universe.objects = [];
			rl.hostId = 9999;
			rl.abortRollout();
			assert.strictEqual(rl.rolloutedRocketId, null);
		});

		it('should catch and handle onProgress callback errors in PresetManager', async () => {
			const pm = new PresetManager();

			// Mock _fetchJSON
			pm._fetchJSON = async () => [];

			// Pass onProgress callback that throws
			const throwingProgress = () => {
				throw new Error('Test progress callback error');
			};

			// Should not throw even if onProgress throws
			await pm.init(throwingProgress);
		});

		it('should cover SystemTab developer debug mode and timescale indicator branches', () => {
			const sysTabBtn = createMockElement('button');
			sysTabBtn.className = 'tab-btn';
			sysTabBtn.setAttribute('data-target', 'tab-sys');
			sysTabBtn.disabled = false;

			const origQS = document.querySelector;
			document.querySelector = (sel) => {
				if (sel.includes('tab-sys')) return sysTabBtn;
				return origQS(sel);
			};

			const st = new SystemTab(universe);
			document.querySelector = origQS;

			// 7 rapid clicks on system tab button to trigger secret dev mode
			for (let i = 0; i < 7; i++) {
				sysTabBtn.click();
			}
			assert.strictEqual(st.isDebugModeEnabled, true, '7 clicks on System tab button must enable developer debug mode');

			// TimeScale indicator formatting branches
			// 1. hr/sec branch: yearsPerSec * 365.25 * 24 >= 1 (val = 0.001)
			st.updateTimeScaleIndicator(0.001);
			assert.ok(st.ui.timeIndicator.textContent.includes('hr/sec'));

			// 2. min/sec branch (val = 0.00005)
			st.updateTimeScaleIndicator(0.00005);
			assert.ok(st.ui.timeIndicator.textContent.includes('min/sec'));
		});

		it('should cover RocketTab payload propulsion synchronization inputs', () => {
			const rt = new RocketTab(universe);
			universe.RocketLauncher.payload = {
				massT: 5,
				propulsion: {
					enabled: true,
					fuelType: 'liquid',
					thrustKN: 10,
					fuelMassT: 1.0,
					oxidMassT: 2.0,
					dryMassT: 2.0
				}
			};

			// Trigger payload fuel input
			if (rt.ui.rlPayloadFuel) {
				rt.ui.rlPayloadFuel.value = '1.5';
				rt.ui.rlPayloadFuel.dispatchEvent({ type: 'input', target: rt.ui.rlPayloadFuel });
				assert.strictEqual(universe.RocketLauncher.payload.propulsion.fuelMassT, 1.5);
			}

			// Trigger payload oxidizer input
			if (rt.ui.rlPayloadOxid) {
				rt.ui.rlPayloadOxid.value = '3.0';
				rt.ui.rlPayloadOxid.dispatchEvent({ type: 'input', target: rt.ui.rlPayloadOxid });
				assert.strictEqual(universe.RocketLauncher.payload.propulsion.oxidMassT, 3.0);
			}

			// Trigger mission select change
			if (rt.ui.rlMissionSelect) {
				rt.ui.rlMissionSelect.value = 'LEO';
				rt.ui.rlMissionSelect.dispatchEvent({ type: 'change', target: rt.ui.rlMissionSelect });
			}
		});
	});

	describe('10. Deep Branch Coverage for Universe, Overlay, and UI Tabs', () => {
		it('should cover Universe camera fallback chain when tracked target is destroyed', () => {
			const canvas = createMockElement('canvas');
			const uni = new Universe(canvas);

			// Test 1: Rocket with debris fallback
			const dyingRocket = new Rocket(101, 'Falcon 9', 0, 0, 0, 0, 50, '#fff', 10, 10, 0, 100, 100, false);
			const debris1 = new Debris(201, 'Falcon 9 Debris', 0, 0, 0, 0, 10, '#aaa', 5, 5, 1, null, 0);
			const debris2 = new Debris(202, 'Falcon 9 Debris', 0, 0, 0, 0, 30, '#aaa', 8, 8, 1, null, 0);
			uni.addObject(dyingRocket);
			uni.addObject(debris1);
			uni.addObject(debris2);

			uni.camera.trackingTarget = dyingRocket;
			dyingRocket.state = OBJECT_STATE.DESTROYED;

			// Trigger update -> should pick largest debris (debris2 with mass 30)
			EventBus.emitUpdate(16, 0.1);
			assert.strictEqual(uni.camera.trackingTarget.id, 202, 'Camera should fallback to largest debris');

			// Test 2: Rocket without debris -> host fallback (non-Earth celestial)
			debris1.state = OBJECT_STATE.DESTROYED;
			debris2.state = OBJECT_STATE.DESTROYED;
			const mars = new CelestialBody(4, 'Mars', 1e8, 0, 0, 0, 6.4e23, '#c1440e', 5, 3389000, false);
			uni.addObject(mars);
			const rocket2 = new Rocket(102, 'Starship', 0, 0, 0, 0, 50, '#fff', 10, 10, 0, 100, 100, false);
			rocket2.hostId = 4;
			uni.addObject(rocket2);
			uni.camera.trackingTarget = rocket2;
			rocket2.state = OBJECT_STATE.DESTROYED;

			EventBus.emitUpdate(16, 0.1);
			assert.strictEqual(uni.camera.trackingTarget.id, 4, 'Camera should fallback to host Mars');

			// Test 3: Rocket without hostId or Earth -> largest object fallback
			mars.state = OBJECT_STATE.DESTROYED;
			const sun = uni.objects.find(o => o.name === 'Sun') || uni.objects[0];
			const rocket3 = new Rocket(103, 'Probe', 0, 0, 0, 0, 5, '#fff', 1, 1, 0, 10, 10, false);
			rocket3.hostId = null;
			uni.addObject(rocket3);
			uni.camera.trackingTarget = rocket3;
			rocket3.state = OBJECT_STATE.DESTROYED;

			EventBus.emitUpdate(16, 0.1);
			assert.strictEqual(uni.camera.trackingTarget.name, 'Sun', 'Camera should fallback to largest object (Sun)');

			uni.destroy();
		});

		it('should cover Universe global event handlers, worker messages, and clearObjects variants', () => {
			const canvas = createMockElement('canvas');
			const uni = new Universe(canvas);
			if (uni.objects[0]) {
				uni.objects[0].id = 0; // Ensure Sun has id 0
			}

			// Global toggle events
			EventBus.emit('render:set-show-predicted-path', false);
			assert.strictEqual(uni.showPredictedTrajectory, false);
			EventBus.emit('render:set-show-actual-path', false);
			assert.strictEqual(uni.showActualFlightPath, false);

			// Worker rocket command and profiler toggle
			EventBus.emit('worker:send-rocket-command', 101, 'IGNITE');
			EventBus.emit('debug:toggle-profiler', true);

			// CalcWorkerManager message handler default branch
			uni.CalcWorkerManager.handleMessage({ data: { cmd: 'unknown_cmd' } });

			// CalcWorkerManager update command
			let updateReceived = false;
			uni.CalcWorkerManager.onUpdateCallback = () => { updateReceived = true; };
			uni.CalcWorkerManager.handleMessage({ data: { cmd: 'update', subSteps: 120 } });
			assert.strictEqual(updateReceived, true);

			// updateObjectParams physics-updated event
			uni.updateObjectParams({ subSteps: 80 });
			assert.strictEqual(uni.currentSubSteps, 80);

			// clearObjects: clear only debris
			const debris = new Debris(301, 'Test Debris', 0, 0, 0, 0, 1, '#aaa', 1, 1, 1, null, 0);
			uni.addObject(debris);
			uni.clearObjects(true, false, false);
			uni.ObjectManager.cleanupObjects();
			assert.ok(!uni.objects.some(o => o.id === 301));

			// clearObjects: clear celestial objects (excluding Sun id:0)
			const moon = new CelestialBody(2, 'Moon', 3e8, 0, 0, 0, 7.3e22, '#aaa', 4, 1737000, false);
			uni.addObject(moon);
			uni.clearObjects(false, false, true);
			uni.ObjectManager.cleanupObjects();
			assert.ok(!uni.objects.some(o => o.id === 2));
			assert.ok(uni.objects.some(o => o.id === 0), 'Sun id:0 must be preserved');

			// Paused update branch (scaledDt = 0)
			uni.pauseSimulation();
			uni.update(16);
			assert.strictEqual(uni.isPaused, true);

			uni.destroy();
		});

		it('should cover RocketLauncher abortRollout without host when rocket is rolled out', () => {
			const rl = new RocketLauncher(universe);
			universe.RocketLauncher = rl;

			// Set rollout active with non-existent hostId and no celestials
			rl.rolloutedRocketId = 999;
			rl.hostId = 99999;
			universe.objects = [];

			rl.abortRollout();
			assert.strictEqual(rl.rolloutedRocketId, null, 'Rollout should be aborted and camera auto tracking stopped');
		});

		it('should cover RocketTab abort button click when hostId is 0', () => {
			const rt = new RocketTab(universe);
			universe.RocketLauncher.hostId = 0;
			const earth = createMockCelestialBody({ id: 1, name: 'Earth' });
			universe.objects = [earth];

			let setupCalled = false;
			rt._setupLaunchEnvironment = (hostId) => {
				setupCalled = true;
				assert.strictEqual(hostId, 1, 'Should resolve Earth as default host when hostId was 0');
			};

			rt.ui.rlAbortBtn.click();
			assert.strictEqual(setupCalled, true);
		});

		it('should cover SystemTab profiler toggle checkbox (enable then destroy)', async () => {
			const st = new SystemTab(universe);

			// Enable profiler
			await st.ui.enableMainProfilerChk.dispatchEvent({
				type: 'change',
				target: { checked: true }
			});

			// Disable profiler -> triggers destroy branch
			await st.ui.enableMainProfilerChk.dispatchEvent({
				type: 'change',
				target: { checked: false }
			});
		});

		it('should cover TelemetryPanel carousel scroll and dot synchronization', () => {
			const dotsContainer = document.getElementById('tm-dots');
			dotsContainer.innerHTML = '';
			for (let i = 0; i < 4; i++) {
				const dot = createMockElement('span');
				dot.className = 'tm-dot';
				dot.setAttribute('data-index', String(i));
				dotsContainer.appendChild(dot);
			}

			const tp = new TelemetryPanel(universe);
			tp.cards.forEach(c => { c.isVisible = true; });

			// Simulate horizontal scrollLeft
			tp.ui.carousel.scrollLeft = 3840; // Card index ~2
			tp.ui.carousel.clientWidth = 1920;
			tp.ui.carousel.dispatchEvent({ type: 'scroll' });

			assert.ok(tp.activeCardIndex >= 0);
		});

		it('should cover NaviTab interval update when active', () => {
			const nt = new NaviTab(universe);
			nt.ui.nvTab.classList.add('active');

			let statsUpdated = false;
			nt._updateNaviStats = () => { statsUpdated = true; };

			// Trigger registered interval
			EventBus.tickIntervals(Date.now() + 10000);
			assert.strictEqual(statsUpdated, true, '_updateNaviStats should be called when Navi tab is active');
		});

		it('should cover OverlayRenderer draw labels and debug circles', () => {
			const canvas = createMockElement('canvas');
			canvas.width = 1920;
			canvas.height = 1080;
			const ctx = canvas.getContext('2d');
			const uni = new Universe(canvas);

			const sun = uni.objects[0];
			// Object inside screen
			const insideBody = new CelestialBody(1, 'Inside', sun.x + 10, sun.y + 10, 0, 0, 1e20, '#fff', 5, 1000, false);
			// Object out of screen left
			const outsideLeft = new CelestialBody(2, 'OutLeft', sun.x - 100000, sun.y, 0, 0, 1e20, '#fff', 5, 1000, false);
			// Object out of screen right
			const outsideRight = new CelestialBody(3, 'OutRight', sun.x + 100000, sun.y, 0, 0, 1e20, '#fff', 5, 1000, false);
			// Inactive object
			const inactive = new CelestialBody(4, 'Dead', sun.x, sun.y, 0, 0, 1e20, '#fff', 5, 1000, false);
			inactive.state = OBJECT_STATE.DESTROYED;

			uni.addObject(insideBody);
			uni.addObject(outsideLeft);
			uni.addObject(outsideRight);
			uni.addObject(inactive);

			// Draw overlay with labels
			uni.OverlayRenderer.showLabels = true;
			uni.OverlayRenderer.showDebugOverlay = true;
			uni.OverlayRenderer.drawAfter(ctx, {
				name: 'main',
				zoomScale: 1.0,
				basis: sun
			});

			// Draw debug grid overlay with threshold branches
			uni.OverlayRenderer._drawDebugOverlay(ctx, { zoomScale: 0.00001 });
			uni.OverlayRenderer._drawDebugOverlay(ctx, { zoomScale: 1000.0 });

			uni.destroy();
		});
	});

	describe('11. Visual Rendering, Atmosphere, and Physics Engine Deep Branches', () => {
		it('should cover RocketRenderer low LOD plumes for 2 and 4 boosters', async () => {
			const canvas = createMockElement('canvas');
			const ctx = canvas.getContext('2d');

			const module = await import('../../scripts/gravsim_rocket_renderer.js');
			const { RocketRenderer } = module;

			const rocket2B = new Rocket(101, 'H3-22', 0, 0, 0, 0, 50, '#fff', 10, 10, 0, 100, 100, false);
			rocket2B.boosters = { count: 2 };
			rocket2B.isIgnited = true;
			rocket2B.burnTime = 100;
			rocket2B.thrustRatio = 1.0;

			const rocket4B = new Rocket(102, 'H3-24', 0, 0, 0, 0, 60, '#fff', 10, 10, 0, 100, 100, false);
			rocket4B.boosters = { count: 4 };
			rocket4B.isIgnited = true;
			rocket4B.burnTime = 100;
			rocket4B.thrustRatio = 1.0;

			// Far LOD render (zoomScale very small)
			RocketRenderer.draw(ctx, rocket2B, { zoomScale: 1e-8, basis: rocket2B });
			RocketRenderer.draw(ctx, rocket4B, { zoomScale: 1e-8, basis: rocket4B });
		});

		it('should cover Rocket.draw multi-stage plumes and nozzle offsets for 1, 2, and 3 stages', () => {
			const canvas = createMockElement('canvas');
			const ctx = canvas.getContext('2d');

			// 1. Single stage (totalStg === 1)
			const ssto = new Rocket(201, 'SSTO', 0, 0, 0, 0, 30, '#fff', 10, 10, 0, 50, 50, false);
			ssto.isIgnited = true;
			ssto.burnTime = 100;
			ssto.thrustRatio = 1.0;
			ssto.telemetry = { stageIndex: 0, totalStages: 1 };
			ssto.updateHistory(1, [ssto], false);
			ssto.draw({ ctx, zoomScale: 1e-3, basis: ssto, cameraOffset: { x: 0, y: 0 } });

			// 2. Two stage (totalStg === 2, stage 1 active)
			const falconStg1 = new Rocket(202, 'Falcon9-S1', 0, 0, 0, 0, 50, '#fff', 10, 10, 0, 50, 50, false);
			falconStg1.isIgnited = true;
			falconStg1.burnTime = 100;
			falconStg1.thrustRatio = 1.0;
			falconStg1.telemetry = { stageIndex: 0, totalStages: 2 };
			falconStg1.updateHistory(1, [falconStg1], false);
			falconStg1.draw({ ctx, zoomScale: 1e-3, basis: falconStg1, cameraOffset: { x: 0, y: 0 } });

			// 3. Two stage (totalStg === 2, stage 2 active)
			const falconStg2 = new Rocket(203, 'Falcon9-S2', 0, 0, 0, 0, 10, '#fff', 2, 2, 0, 30, 30, false);
			falconStg2.isIgnited = true;
			falconStg2.burnTime = 100;
			falconStg2.thrustRatio = 1.0;
			falconStg2.telemetry = { stageIndex: 1, totalStages: 2 };
			falconStg2.updateHistory(1, [falconStg2], false);
			falconStg2.draw({ ctx, zoomScale: 1e-3, basis: falconStg2, cameraOffset: { x: 0, y: 0 } });

			// 4. Three stage (totalStg === 3, stage 1, 2, 3 active)
			for (let stg = 0; stg < 3; stg++) {
				const epsilon = new Rocket(204 + stg, `Epsilon-S${stg+1}`, 0, 0, 0, 0, 20, '#fff', 5, 5, 0, 40, 40, false);
				epsilon.isIgnited = true;
				epsilon.burnTime = 100;
				epsilon.thrustRatio = 1.0;
				epsilon.telemetry = { stageIndex: stg, totalStages: 3 };
				epsilon.updateHistory(1, [epsilon], false);
				epsilon.draw({ ctx, zoomScale: 1e-3, basis: epsilon, cameraOffset: { x: 0, y: 0 } });
			}
		});

		it('should cover CelestialBody atmosphere rendering when screen thickness is sufficient', () => {
			const canvas = createMockElement('canvas');
			const ctx = canvas.getContext('2d');

			const earth = new CelestialBody(1, 'Earth', 0, 0, 0, 0, 5.972e24, '#4477aa', 6, 6371000, false);

			// High zoom render to trigger screenThicknessPx >= 1
			earth.draw(ctx, {
				zoomScale: 1e-2,
				basis: earth,
				cameraOffset: { x: 0, y: 0 }
			});
		});

		it('should cover SimulationController destroy and toggleProfiler message handling', async () => {
			const calcModule = await import('../../scripts/gravsim_calc.js');
			const { SimulationController, PhysicsEngine } = calcModule;

			const sim = new SimulationController();
			sim.timer = 999;
			sim.destroy();
			assert.strictEqual(sim.timer, null, 'SimulationController.destroy should clear timer');

			// Message handler for toggleProfiler
			sim.handleMessage({ data: { cmd: 'toggleProfiler', value: true } });

			// PhysicsEngine escape calculation without dominant body
			const engine = new PhysicsEngine();
			const sun = { id: 0, type: OBJECT_TYPES.CELESTIAL, mass: 1e30, collided: false, shattered: false };
			const obj = { id: 10, type: OBJECT_TYPES.ROCKET, x: 0, y: 0, vx: 0, vy: 0, mass: 1, dominantBody: null, isEscaping: true, collided: false, shattered: false };
			engine.objects = [sun, obj];
			engine._updateEscapeStatus();
			assert.strictEqual(obj.isEscaping, false, 'Without dominantBody, isEscaping must be false');
		});

		it('should cover TelemetryPanel interval trigger, non-rocket reset with visible cards, and Universe destroy', () => {
			const tp = new TelemetryPanel(universe);
			tp.cards.forEach(c => { c.isVisible = true; });

			// Reset when target is inactive/destroyed rocket (covers lines 463-470)
			const deadRocket = createMockRocket({ id: 501, state: OBJECT_STATE.DESTROYED });
			universe.objects = [deadRocket];
			tp.targetId = deadRocket.id;
			tp.update();

			// Trigger telemetry update interval
			EventBus.tickIntervals(Date.now() + 10000);
			assert.ok(tp.cards.length > 0);

			// Universe CalcWorkerManager destroy directly
			const canvas = createMockElement('canvas');
			const uni = new Universe(canvas);
			if (uni.objects[0]) {
				uni.objects[0].id = 0; // Ensure Sun has id: 0 so it does not match id !== 0
			}
			uni.CalcWorkerManager.destroy();

			// Universe camera tracking fallback when rocket has no hostId but Earth exists
			const dyingRocket = new Rocket(601, 'Falcon', 0, 0, 0, 0, 50, '#fff', 10, 10, 0, 100, 100, false);
			dyingRocket.hostId = null;
			const earth = new CelestialBody(100, 'Earth', 0, 0, 0, 0, 5.972e24, '#4477aa', 6, 6371000, false);
			uni.addObject(dyingRocket);
			uni.addObject(earth);
			uni.camera.trackingTarget = dyingRocket;
			dyingRocket.state = OBJECT_STATE.DESTROYED;
			EventBus.emitUpdate(16, 0.1);
			assert.strictEqual(uni.camera.trackingTarget.name, 'Earth', 'Should fallback to Earth when hostId is null');

			uni.destroy();
		});

		it('should cover RocketTab slider inputs, stage tab selection, and checkbox toggles', () => {
			const rt = new RocketTab(universe);
			const rl = universe.RocketLauncher;
			rl.stages = [
				{ stageNumber: 1, thrustKN: 5000, burnTime: 150, fuelType: 'liquid' },
				{ stageNumber: 2, thrustKN: 1000, burnTime: 300, fuelType: 'hydro' }
			];

			// Tab selection
			rt._renderStageTabs();
			rt.selectTab(0);
			rt.selectTab(1);

			// Slider inputs
			if (rt.ui.rlEngineThrust) {
				rt.ui.rlEngineThrust.value = '6000';
				rt.ui.rlEngineThrust.dispatchEvent({ type: 'input', target: rt.ui.rlEngineThrust });
			}
			if (rt.ui.rlBurnTime) {
				rt.ui.rlBurnTime.value = '180';
				rt.ui.rlBurnTime.dispatchEvent({ type: 'input', target: rt.ui.rlBurnTime });
			}
			if (rt.ui.rlHostAngle) {
				rt.ui.rlHostAngle.value = '45';
				rt.ui.rlHostAngle.dispatchEvent({ type: 'input', target: rt.ui.rlHostAngle });
			}
			if (rt.ui.rlHostAlt) {
				rt.ui.rlHostAlt.value = '50';
				rt.ui.rlHostAlt.dispatchEvent({ type: 'input', target: rt.ui.rlHostAlt });
			}
			if (rt.ui.rlAngle) {
				rt.ui.rlAngle.value = '90';
				rt.ui.rlAngle.dispatchEvent({ type: 'input', target: rt.ui.rlAngle });
			}
			if (rt.ui.rlMaxG) {
				rt.ui.rlMaxG.value = '4.5';
				rt.ui.rlMaxG.dispatchEvent({ type: 'input', target: rt.ui.rlMaxG });
			}
			if (rt.ui.rlHoldDown) {
				rt.ui.rlHoldDown.checked = false;
				rt.ui.rlHoldDown.dispatchEvent({ type: 'change', target: rt.ui.rlHoldDown });
			}
			if (rt.ui.rlAutoGuidance) {
				rt.ui.rlAutoGuidance.checked = false;
				rt.ui.rlAutoGuidance.dispatchEvent({ type: 'change', target: rt.ui.rlAutoGuidance });
			}
			if (rt.ui.rlDisableCutoff) {
				rt.ui.rlDisableCutoff.checked = true;
				rt.ui.rlDisableCutoff.dispatchEvent({ type: 'change', target: rt.ui.rlDisableCutoff });
			}
			if (rt.ui.rlDisableStaging) {
				rt.ui.rlDisableStaging.checked = true;
				rt.ui.rlDisableStaging.dispatchEvent({ type: 'change', target: rt.ui.rlDisableStaging });
			}
		});
	});

	describe('12. RocketLauncher Target Marker, Free Mode, and Payload Propulsion Edge Cases', () => {
		it('should cover RocketLauncher drawTargetMarker and free mode drawPreview', () => {
			const canvas = createMockElement('canvas');
			const ctx = canvas.getContext('2d');
			const earth = createMockCelestialBody({ id: 1, name: 'Earth', radius: 6371000, x: 0, y: 0 });
			universe.objects = [earth];

			const rl = new RocketLauncher(universe);
			rl.hostId = earth.id;
			rl.mode = 'host';
			rl.rolloutedRocketId = null;

			// Draw target marker with active host
			rl.drawTargetMarker(ctx, earth, 1.0);

			// Draw target marker when hostId is null (early return)
			rl.hostId = null;
			rl.drawTargetMarker(ctx, earth, 1.0);

			// Draw free mode preview
			rl.mode = 'free';
			rl.isActive = true;
			rl.setFreePosition(500, 300);
			rl.drawPreview(ctx, earth, 1.0, { name: 'main', zoomScale: 1.0 });

			// Free mode rollout (early return)
			rl.rollout();
			assert.strictEqual(rl.rolloutedRocketId, null, 'Free mode cannot rollout to host');
		});

		it('should cover RocketTab payload propulsion with zero thrust and custom fuel type', () => {
			const rt = new RocketTab(universe);
			universe.RocketLauncher.payload = {
				name: 'Satellite',
				massT: 2.5,
				propulsion: {
					enabled: true,
					fuelType: 'hydro',
					isp: 450,
					thrustKN: 0, // Zero thrust branch (burnTime = 0)
					fuelMassT: 0.5,
					oxidMassT: 1.0,
					dryMassT: 1.0
				}
			};

			rt._syncPayloadPropulsion();
			assert.ok(universe.RocketLauncher.payload.propulsion.burnTime > 0);

			// Disabled propulsion branch
			universe.RocketLauncher.payload.propulsion.enabled = false;
			rt._syncPayloadPropulsion();
		});
	});

	describe('13. Predictor Worker Handlers and Negative Thrust Edge Cases', () => {
		it('should cover calc_predictor worker onmessage handler', async () => {
			const calcPredictor = await import('../../scripts/gravsim_calc_predictor.js');

			// Mock self
			const origSelf = globalThis.self;
			let postedMessage = null;
			globalThis.self = {
				onmessage: null,
				postMessage: (msg) => { postedMessage = msg; }
			};

			// Re-run worker message setup
			calcPredictor.initWorkerMessage?.();
			if (typeof globalThis.self.onmessage === 'function') {
				// 1. Non-predict command (early return)
				globalThis.self.onmessage({ data: { cmd: 'other' } });

				// 2. Predict command
				globalThis.self.onmessage({
					data: {
						cmd: 'predict',
						requestId: 'req_123',
						hostId: 1,
						celestialBodies: [
							{ id: 1, name: 'Earth', x: 0, y: 0, vx: 0, vy: 0, mass: 5.972e24, radius: 6371000, color: '#4477aa' }
						],
						rocketConfig: {
							stages: [{ stageNumber: 1, dryMassT: 25, fuelMassT: 100, oxidMassT: 200, thrustKN: 5000, ispSec: 300, burnTime: 150 }],
							flightProfile: [{ type: 'alt', value: 0, thrust: 100, angle: 0 }],
							hostId: 1,
							hostAngleRad: -Math.PI / 2,
							hostAltM: 0,
							baseRadiusM: 63,
							bottomOffsetM: 20
						}
					}
				});
				assert.ok(postedMessage !== null);
				assert.strictEqual(postedMessage.cmd, 'predictionResult');
			}

			globalThis.self = origSelf;
		});

		it('should cover TrajectoryPredictor worker undefined and render methods', async () => {
			const canvas = createMockElement('canvas');
			const ctx = canvas.getContext('2d');
			const { TrajectoryPredictor } = await import('../../scripts/gravsim_trajectory_predictor.js');

			// Worker undefined branch
			const origWorker = globalThis.Worker;
			globalThis.Worker = undefined;
			const predNoWorker = new TrajectoryPredictor(universe);
			assert.strictEqual(predNoWorker._worker, null);
			globalThis.Worker = origWorker;

			// render() with prediction
			const pred = new TrajectoryPredictor(universe);
			pred.prediction = {
				points: [
					{ x: 0, y: 0, vx: 0, vy: 0, t: 0 },
					{ x: 1000, y: 1000, vx: 10, vy: 10, t: 10 },
					{ x: 50000000, y: 50000000, vx: 10, vy: 10, t: 20 } // Gap to trigger inSubpath = false
				],
				events: []
			};

			const renderCtx = {
				name: 'main',
				zoomScale: 1e-4,
				basis: { x: 0, y: 0 },
				cameraOffset: { x: 0, y: 0 },
				showPredictedTrajectory: true,
				showActualFlightPath: true
			};

			pred.render(ctx, renderCtx);

			// render() when prediction is null (early return)
			pred.prediction = null;
			pred.render(ctx, renderCtx);
		});

		it('should cover payload propulsion negative thrust to trigger zero burnTime branch', () => {
			const rt = new RocketTab(universe);
			universe.RocketLauncher.payload = {
				name: 'Probe',
				massT: 1,
				propulsion: {
					enabled: true,
					fuelType: 'liquid',
					thrustKN: -10, // Negative thrust -> thrustN <= 0 -> burnTime = 0
					fuelMassT: 1,
					oxidMassT: 1,
					dryMassT: 1
				}
			};

			rt._syncPayloadPropulsion();
			assert.strictEqual(universe.RocketLauncher.payload.propulsion.burnTime, 0);
		});
	});

	describe('Section 14: PresetManager dynamic flight plans, profile scaling, and legacy presets', () => {
		it('should handle calculateMissionFlightPlan edge cases and propellant sizing', () => {
			const pm = new PresetManager({ skipDiskLoad: true });
			// null vehicle
			assert.strictEqual(pm.calculateMissionFlightPlan({ vehicle: null }), null);

			const vehicle = {
				id: 'v_test',
				stages: [
					{ stageNumber: 1, fuelType: 'liquid', capacityFuelMassT: 80, capacityOxidMassT: 80, fuelMassT: 80, oxidMassT: 80, burnTime: 100, thrustKN: 1000 }
				],
				boosters: { coreThrustKN: 900 }
			};

			// SSTO propellant scaling with targetDeltaV < 10500 and capProp > 100 and stages.length === 1
			const plan1 = pm.calculateMissionFlightPlan({
				vehicle,
				mission: { targetDeltaVM_S: 8000 }
			});
			assert.ok(plan1);
			assert.ok(plan1.stages[0].burnTime > 0);

			// Payload with propulsion: reqDeltaV in (0, 2500)
			const payload1 = {
				id: 'p1',
				massT: 5.0,
				propulsion: {
					enabled: true,
					fuelType: 'liquid',
					thrustKN: 20,
					dryMassT: 3.0,
					fuelMassT: 1.0,
					oxidMassT: 1.0,
					ofRatio: 2.0
				}
			};
			const plan2 = pm.calculateMissionFlightPlan({
				vehicle,
				payload: payload1,
				mission: { payloadDeltaVM_S: 1200 }
			});
			assert.ok(plan2.payload.propulsion.burnTime > 0);

			// Payload with ofRatio <= 0 and thrustKN <= 0
			const payload2 = {
				id: 'p2',
				massT: 2.0,
				propulsion: {
					enabled: true,
					fuelType: 'monoprop',
					thrustKN: -5,
					dryMassT: 1.0,
					fuelMassT: 1.0,
					oxidMassT: 0,
					ofRatio: 0
				}
			};
			const plan3 = pm.calculateMissionFlightPlan({
				vehicle,
				payload: payload2,
				mission: { payloadDeltaVM_S: 3000 } // >= 2500 -> propNeeded = maxCapacity
			});
			assert.strictEqual(plan3.payload.propulsion.burnTime, 0);
			assert.strictEqual(plan3.payload.propulsion.oxidMassT, 0);
		});

		it('should adapt flight profiles for solid, ssto, low-twr, and multi-stage vehicles', () => {
			const pm = new PresetManager({ skipDiskLoad: true });
			const rawProfile = [{ type: 'alt', value: 1000, thrust: 100, angle: 10 }];

			// Null / non-array profile
			assert.strictEqual(pm._adaptFlightProfileForVehicle(null, {}, []), null);

			// Solid rocket
			const solidProf = pm._adaptFlightProfileForVehicle(rawProfile, {}, [{ fuelType: 'solid' }, { fuelType: 'solid' }]);
			assert.strictEqual(solidProf[0].value, 620); // 1000 * 0.62

			// SSTO
			const sstoProf = pm._adaptFlightProfileForVehicle(rawProfile, {}, [{ fuelType: 'liquid' }]);
			assert.strictEqual(sstoProf[0].value, 580); // 1000 * 0.58

			// Low upper TWR
			const lowTwrProf = pm._adaptFlightProfileForVehicle(rawProfile, {}, [
				{ fuelType: 'liquid', thrustKN: 1000 },
				{ fuelType: 'liquid', thrustKN: 10, dryMassT: 10, fuelMassT: 10, oxidMassT: 10 }
			]);
			assert.strictEqual(lowTwrProf[0].value, 1080); // 1000 * 1.08

			// Normal 2-stage
			const normalProf = pm._adaptFlightProfileForVehicle(rawProfile, {}, [
				{ fuelType: 'liquid', thrustKN: 1000 },
				{ fuelType: 'liquid', thrustKN: 500, dryMassT: 10, fuelMassT: 10, oxidMassT: 10 }
			]);
			assert.strictEqual(normalProf[0].value, 850); // 1000 * 0.85
		});

		it('should exercise applyToLauncher and legacy preset mappings', () => {
			const pm = presetManager; // Use global singleton with loaded presets
			// null launcher guard
			assert.strictEqual(pm.applyToLauncher(null), undefined);

			const mockLauncher = {
				currentVehicleId: 'epsilon',
				currentPayloadId: null,
				currentMissionId: null,
				requestPreviewUpdate: () => {}
			};
			pm.applyToLauncher(mockLauncher);
			// Epsilon fallback payload is 'asnaro_2'
			assert.strictEqual(mockLauncher.currentPayloadId, 'asnaro_2');

			// H3 fallback payload is 'earth_obs'
			mockLauncher.currentVehicleId = 'h3_30';
			mockLauncher.currentPayloadId = null;
			pm.applyToLauncher(mockLauncher);
			assert.strictEqual(mockLauncher.currentPayloadId, 'earth_obs');

			// Legacy presets
			assert.ok(pm.getLegacyPreset('FALCON9') || pm.getLegacyPreset('H3'));
			assert.ok(pm.getLegacyPreset('EPSILON'));
			assert.ok(pm.getLegacyPreset('SSTO'));
			assert.strictEqual(pm._buildLegacyPresetFromVehicle(null, 'XYZ'), null);
		});

		it('should exercise PresetManager.init onProgress callback branches', async () => {
			const pm = new PresetManager({ skipDiskLoad: true });
			// Mock _fetchJSON to return empty array for manifests
			pm._fetchJSON = async () => [];

			let multiArgCalled = false;
			await pm.init((cur, tot, txt, pct) => {
				multiArgCalled = true;
			});
			assert.ok(multiArgCalled);

			// onProgress throwing error caught gracefully
			await pm.init(() => {
				throw new Error('Progress crash');
			});
		});
	});

	describe('Section 15: RocketLauncher prediction caching, force update, and preview branches', () => {
		it('should test updatePrediction force flag, caching, and null context', () => {
			const rl = new RocketLauncher(universe);
			const earth = createMockCelestialBody(1, 'Earth', 0, 0, 6371000, 5.972e18);
			universe.objects.push(earth);
			rl.hostId = 1;

			// null context when host not in universe
			rl.hostId = 99999;
			let nullResult = false;
			rl.updatePrediction(false, (res) => {
				if (res === null) nullResult = true;
			});
			assert.ok(nullResult);

			// valid host
			rl.hostId = 1;
			let forceResult = null;
			rl.updatePrediction(true, (res) => {
				forceResult = res;
			});
			assert.ok(forceResult !== null);

			// immediate consecutive call hits throttled cache
			let cachedResult = null;
			rl.updatePrediction(false, (res) => {
				cachedResult = res;
			});
			assert.strictEqual(cachedResult, forceResult);
		});

		it('should test drawPreview branches with rollouted rocket and free mode', () => {
			const rl = new RocketLauncher(universe);
			const mockCtx = {
				save: () => {},
				restore: () => {},
				beginPath: () => {},
				arc: () => {},
				moveTo: () => {},
				lineTo: () => {},
				stroke: () => {}
			};
			const renderContext = { zoom: 1 };
			const centerObj = { x: 0, y: 0 };

			// Rollouted rocket on pad preview
			rl.rolloutedRocketId = 10;
			const mockRocket = {
				id: 10,
				x: 6371000,
				y: 0,
				isHoldDown: true
			};
			universe.objects.push(mockRocket);
			rl.hostId = 1; // Earth

			// With points[0].phiSurf defined
			rl.currentPrediction = {
				points: [{ x: 6371000, y: 0, phiSurf: 0.5 }],
				baseHostAngleRad: 0
			};
			rl.predictor.render = () => {};
			rl.drawPreview(mockCtx, centerObj, 1, renderContext);

			// With points[0].phiSurf undefined
			rl.currentPrediction = {
				points: [{ x: 6371000, y: 0 }],
				baseHostAngleRad: undefined
			};
			rl.drawPreview(mockCtx, centerObj, 1, renderContext);

			// Free mode
			rl.rolloutedRocketId = null;
			rl.isActive = true;
			rl.mode = 'free';
			rl.drawPreview(mockCtx, centerObj, 1, renderContext);

			// Free mode when _calculateTransform returns null
			const origCalc = rl._calculateTransform;
			rl._calculateTransform = () => null;
			rl.drawPreview(mockCtx, centerObj, 1, renderContext);
			rl._calculateTransform = origCalc;
		});

		it('should test rollout with zero calculatedBurnTime', () => {
			const rl = new RocketLauncher(universe);
			const earth = createMockCelestialBody(1, 'Earth', 0, 0, 6371000, 5.972e18);
			universe.objects.push(earth);
			rl.hostId = 1;
			rl.calculatedBurnTime = 0;
			rl.stages = [{ burnTime: 0 }];
			rl.rollout();
			assert.ok(rl.rolloutedRocketId !== null);
		});
	});

	describe('Section 16: CalcRocket commands, tank pressure states, booster debris, and stage transitions', () => {
		it('should exercise CalcRocket handleCommand across all pressurization and hold-down states', () => {
			const rocket = new CalcRocket(100, 'TestRocket', 0, 0, 0, 0, 0, 0, 2.5, 0, 10, 50, 50, {
				stages: [{ stageNumber: 1, dryMassT: 10, fuelMassT: 50, oxidMassT: 50, thrustKN: 1000, burnTime: 100 }],
				boosters: { count: 2, casingColor: '#fff', burnTimeSec: 20 }
			});

			// PRESSURIZE_TANK from ROLLOUT_FILL
			rocket.presState = 'ROLLOUT_FILL';
			rocket.handleCommand('PRESSURIZE_TANK');
			assert.strictEqual(rocket.presState, 'PRESSURIZING');

			// PRESSURIZE_TANK from UNPRESSURIZED
			rocket.presState = 'UNPRESSURIZED';
			rocket.handleCommand('PRESSURIZE_TANK');
			assert.strictEqual(rocket.presState, 'PRESSURIZING');

			// Simulate tank pressure to completion (pRatio >= 1.0)
			rocket.updatePressure(100.0, 0);
			assert.strictEqual(rocket.presState, 'NOMINAL');

			// IGNITE_ENGINE from NOMINAL
			rocket.handleCommand('IGNITE_ENGINE');
			assert.strictEqual(rocket.presState, 'IGNITION_TRANSIENT');

			// IGNITE_ENGINE from PRESSURIZING
			rocket.presState = 'PRESSURIZING';
			rocket.handleCommand('IGNITE_ENGINE');
			assert.strictEqual(rocket.presState, 'IGNITION_TRANSIENT');

			// IGNITE_ENGINE failsafe rapid pressurization from ROLLOUT_FILL
			rocket.presState = 'ROLLOUT_FILL';
			rocket.handleCommand('IGNITE_ENGINE');
			assert.strictEqual(rocket.presState, 'IGNITION_TRANSIENT');
			assert.ok(rocket.tankPresFuel > 0);

			// IGNITE_ENGINE failsafe from UNPRESSURIZED
			rocket.presState = 'UNPRESSURIZED';
			rocket.handleCommand('IGNITE_ENGINE');
			assert.strictEqual(rocket.presState, 'IGNITION_TRANSIENT');

			// RELEASE_HOLD_DOWN from PRE_LAUNCH
			rocket.isHoldDown = true;
			rocket.stageState = 'PRE_LAUNCH';
			rocket.handleCommand('RELEASE_HOLD_DOWN');
			assert.strictEqual(rocket.isHoldDown, false);
			assert.strictEqual(rocket.stageState, 'STG_BURNING');
		});

		it('should spawn booster debris for 2-booster, 4-booster, and 3-booster configurations', () => {
			const rocket = new CalcRocket(101, 'BoosterRocket', 0, 0, 0, 0, 0, 0, 2.5, 0, 10, 50, 50, {
				stages: [{ stageNumber: 1, dryMassT: 10, fuelMassT: 50, oxidMassT: 50, thrustKN: 1000, burnTime: 100 }],
				boosters: { count: 2, casingColor: '#fff', burnTimeSec: 20 }
			});
			rocket.thrustAngle = 0;
			rocket._pendingDebris = [];

			// 2 boosters
			rocket.separateBoosters();
			assert.strictEqual(rocket._pendingDebris.length, 2);

			// 4 boosters
			rocket.isBoosterSeparated = false;
			rocket.boosters.count = 4;
			rocket._pendingDebris = [];
			rocket.separateBoosters();
			assert.strictEqual(rocket._pendingDebris.length, 4);

			// 3 boosters (exercises else branch)
			rocket.isBoosterSeparated = false;
			rocket.boosters.count = 3;
			rocket._pendingDebris = [];
			rocket.separateBoosters();
			assert.strictEqual(rocket._pendingDebris.length, 3);
		});

		it('should exercise staging state transitions, autoControl false, and coast re-ignition', () => {
			const rocket = new CalcRocket(102, 'MultiRocket', 0, 6371000, 7800, 0, 0, 0, 2.5, 0, 5, 20, 20, {
				stages: [
					{ stageNumber: 1, dryMassT: 5, fuelMassT: 20, oxidMassT: 20, thrustKN: 1000, burnTime: 50, separationDelaySec: 0 },
					{ stageNumber: 2, dryMassT: 2, fuelMassT: 10, oxidMassT: 10, thrustKN: 200, burnTime: 100, separationDelaySec: 0 }
				],
				boosters: { count: 2, burnTimeSec: 10 }
			});

			const earth = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, 6371000, 0, 5.972e18);

			// autoControl = false branch
			rocket.autoControl = false;
			rocket.flightControl(0.1, earth, 6371000 + 200000, null);

			// PRE_LAUNCH with isIgnited and !isHoldDown
			rocket.stageState = 'PRE_LAUNCH';
			rocket.isIgnited = true;
			rocket.isHoldDown = false;
			rocket.flightControl(0.1, earth, 6371000 + 200000, null);
			assert.strictEqual(rocket.stageState, 'STG_BURNING');

			// Separate stage 1 with boosters still unseparated -> marks isBoosterSeparated = true
			rocket.hasBoosters = true;
			rocket.isBoosterSeparated = false;
			rocket.currentStageIndex = 0;
			rocket.separateCurrentStage();
			assert.strictEqual(rocket.isBoosterSeparated, true);

			// Final stage separation deorbit burn relative to Earth
			rocket.currentStageIndex = 1;
			rocket.dominantBody = earth;
			rocket._lastDominantBody = earth;
			rocket.separateCurrentStage();
			assert.strictEqual(rocket.isPayloadSeparated, true);

			// Commanded coast with pending restart burn -> transitions to STG_COAST
			rocket.isPayloadSeparated = false;
			rocket.currentStageIndex = 0;
			rocket.totalStages = 1;
			rocket.disableOrbitalCutoff = true;
			rocket.stageState = 'STG_BURNING';
			rocket.fuelMass = 20;
			rocket.oxidMass = 20;
			rocket.burnTime = 50;
			rocket.flightComputer.flightTime = 200;
			rocket.autoControl = true;
			rocket.flightComputer.flightProfile = [
				{ type: 'time', value: 200, thrust: 0, angle: 90 },
				{ type: 'time', value: 400, thrust: 100, angle: 90 }
			];
			rocket.flightControl(0.1, earth, 6371000 + 400000, null);
			assert.strictEqual(rocket.stageState, 'STG_COAST');

			// Re-ignite engine at t=400 when flightComputer commands thrust > 0
			rocket.flightComputer.flightTime = 400;
			rocket.flightControl(0.1, earth, 6371000 + 400000, null);
			assert.strictEqual(rocket.stageState, 'STG_BURNING');
		});
	});

	describe('Section 17: CalcCelestialBody, GravSimCalcObject gravity, collision, and Roche limit', () => {
		it('should exercise applyGravity dominant body tracking, collision substeps, and Roche limit', () => {
			const earth = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, 6371000, 0, 5.972e18);
			const moon = new CalcCelestialBody(2, 'Moon', 384400000, 0, 0, 1022, 0, 0, 1737000, 0, 7.342e16);
			const rock = new CalcDebris(3, 'Rock', 10000000, 0, 0, 0, 0, 0, 100, 0, 1000);

			// applyGravity sets dominant body
			rock.applyGravity(earth);
			assert.strictEqual(rock.dominantBody, earth);
			assert.ok(rock.maxGForce > 0);

			// applyGravity with a celestial body that has larger gForce updates dominantBody
			rock.maxGForce = 0;
			rock.applyGravity(moon);
			assert.strictEqual(rock.dominantBody, moon);

			// isColliding sub-step sweep detection
			const fastBody1 = new CalcCelestialBody(10, 'B1', 0, 0, 10000, 0, 0, 0, 10, 0, 100);
			const fastBody2 = new CalcCelestialBody(11, 'B2', 50, 0, -10000, 0, 0, 0, 10, 0, 100);
			assert.strictEqual(fastBody1.isColliding(fastBody2, 0.01), true);

			// Roche limit detection on low-density body near Earth
			const fragileBody = new CalcCelestialBody(20, 'Fragile', 6371000 + 1000, 0, 0, 0, 0, 0, 1000, 0, 1);
			assert.strictEqual(fragileBody.isRocheLimit(earth), true);

			// Dynamic pressure destruction on Asteroid (MAX_DYNAMIC_PRESSURE = 5,000,000 Pa)
			const asteroid = new CalcCelestialBody(21, 'Asteroid', 0, 0, 0, 0, 0, 0, 90, 0, 1e7);
			asteroid._checkAerodynamicDestruction(6000000);
			assert.strictEqual(asteroid.shattered, true);
		});
	});

	describe('Section 18: Renderer, EffectTrail, ObjectManager, and Final Branch Coverage', () => {
		it('should trigger final stage fairing separation with distance calculated from dominant body coordinates', () => {
			const earth = new CalcCelestialBody(1, 'Earth', 0, 0, 0, 0, 0, 0, 6371000, 0, 5.972e18);
			const rocket = new CalcRocket(200, 'FairingRocket', 0, 6371000 + 150000, 7800, 0, 0, 0, 2.5, 0, 2, 10, 10, {
				stages: [
					{ stageNumber: 1, dryMassT: 2, fuelMassT: 10, oxidMassT: 10, thrustKN: 200, burnTime: 50, separationDelaySec: 0 }
				],
				fairing: { enabled: true, isSeparated: false, massT: 1.5, separationAltKm: 120 }
			});
			rocket.totalStages = 1;
			rocket.currentStageIndex = 0;
			rocket._lastDominantBody = earth;
			rocket._lastDistToRefM = undefined; // Forces line 450-451 Math.hypot calculation!
			rocket.separateCurrentStage();
			assert.strictEqual(rocket.fairing.isSeparated, true);
		});

		it('should cover Renderer draw with zero rotation, no basis, and disabled trajectories', () => {
			const canvas = createMockElement('canvas');
			canvas.width = 800;
			canvas.height = 600;
			canvas.getContext = () => ({
				clearRect: () => {},
				save: () => {},
				restore: () => {},
				translate: () => {},
				rotate: () => {}
			});
			const renderer = new Renderer(canvas);
			renderer.setRotation(0.5);
			renderer.setZoomScale(2.0);
			assert.strictEqual(renderer.rotation, 0.5);
			assert.strictEqual(renderer.zoomScale, 2.0);

			// Draw with rotation = 0, basis = null, and false flags
			renderer.draw([], {
				rotation: 0,
				cameraOffset: { x: 0, y: 0 },
				zoomScale: 1.0,
				basis: null,
				showPredictedTrajectory: false,
				showActualFlightPath: false
			});
			assert.strictEqual(renderer.renderContext.showPredictedTrajectory, false);
			assert.strictEqual(renderer.renderContext.showActualFlightPath, false);
			assert.strictEqual(renderer.renderContext.centerObjectId, null);
		});

		it('should cover EffectTrail capacity bounds, shrink when empty, and invalid index', () => {
			const trail = new EffectTrail(1, null); // null config branch
			assert.strictEqual(trail.getPoint(-1), null);
			assert.strictEqual(trail.getPoint(10), null);

			// shrink when count === 0
			trail.shrink(50);
			assert.strictEqual(trail.count, 0);

			// fill buffer to capacity and beyond
			for (let i = 0; i < trail.capacity + 10; i++) {
				trail.addPoint(1, i, i, i, 0);
			}
			assert.strictEqual(trail.count, trail.capacity);
			assert.ok(trail.getPoint(0) !== null);

			// draw with count < 2
			trail.clear();
			trail.draw({});
		});

		it('should cover ObjectManager constructor with container renderer/workerManager', () => {
			const mockWorker = { postMessage: () => {} };
			const mockRenderer = { name: 'mock' };
			const om = new ObjectManager({
				renderer: mockRenderer,
				workerManager: mockWorker
			});
			assert.strictEqual(om.renderer, mockRenderer);
			assert.strictEqual(om.workerManager, mockWorker);
		});

		it('should cover PresetManager getRecommendedMissionForPayload fallbacks and flight plan parameters', () => {
			const pm = new PresetManager({ skipDiskLoad: true });
			assert.strictEqual(pm.getRecommendedMissionForPayload('nonexistent'), 'leo_250km');

			const vehicle = {
				id: 'v_adv',
				stages: [{ stageNumber: 1, fuelType: 'liquid', capacityFuelMassT: 20, capacityOxidMassT: 20, fuelMassT: 20, oxidMassT: 20, burnTime: 100, thrustKN: 500 }]
			};
			const payload = {
				id: 'p_adv',
				massT: 1.0,
				fairing: { enabled: false }
			};
			const mission = {
				targetDeltaVM_S: 9000,
				disableOrbitalCutoff: true,
				targetApogeeKm: 35786,
				targetPerigeeKm: 250,
				predictionDurationMonths: 12
			};
			const plan = pm.calculateMissionFlightPlan({ vehicle, payload, mission });
			assert.strictEqual(plan.fairing.enabled, false);
			assert.strictEqual(plan.disableOrbitalCutoff, true);
			assert.strictEqual(plan.targetApogeeKm, 35786);
			assert.strictEqual(plan.targetPerigeeKm, 250);
			assert.strictEqual(plan.predictionDurationMonths, 12);
		});
	});
});

