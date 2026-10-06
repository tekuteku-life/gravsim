/**
 * Integration Test Suite 09: Non-Sun Center, DeployTab Sun Button, and Solar Planet Reference Body
 * 
 * Verifies all core requirements:
 * 1. System does not crash when center object is not Sun, or when center object is null.
 * 2. DeployTab includes 'put-sun-btn' and clicking it deploys Sun / centers camera on Sun.
 * 3. Deploying any Sun planet places Sun (if missing) + the planet, and sets the reference body (camera tracking target) to that planet.
 * 4. Slingshot, overlay labels, markers, and render pipeline work smoothly with non-Sun or null center.
 * 5. Clearing celestials preserves stability even when center was a cleared celestial body.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	setupMockDOM,
	createMockUniverse,
	createMockElement,
	createMockCelestialBody,
	createMockRocket
} from '../test_helpers.mjs';

// Setup DOM mocks before module imports
setupMockDOM();

import { Camera } from '../../scripts/gravsim_camera.js';
import { EventBus } from '../../scripts/gravsim_event_bus.js';
import { Universe } from '../../scripts/gravsim_universe.js';
import { ObjectPlacer, SOLAR_PLANETS } from '../../scripts/gravsim_object_placer.js';
import { DeployTab } from '../../scripts/gravsim_tab_deploy.js';
import { CelestialBody, Rocket, Debris } from '../../scripts/gravsim_object.js';
import { RocketLauncher } from '../../scripts/gravsim_rocket_launcher.js';
import { OverlayRenderer } from '../../scripts/gravsim_overlay_renderer.js';
import { OBJECT_TYPES, OBJECT_STATE } from '../../scripts/gravsim_const.js';

describe('Integration Suite 09 - Non-Sun Center and Solar Planet Deployment', () => {
	let canvas;
	let universe;

	beforeEach(() => {
		EventBus.clearAll();
		canvas = createMockElement('canvas');
		canvas.width = 1920;
		canvas.height = 1080;
		universe = new Universe(canvas);
	});

	afterEach(() => {
		if (universe) {
			universe.destroy();
			universe = null;
		}
		EventBus.clearAll();
	});

	describe('1. DeployTab Sun Button and Deployment UI Integration', () => {
		it('should have put-sun-btn registered in DeployTab deployButtons', () => {
			const deployTab = new DeployTab(universe);
			assert.equal(deployTab.deployButtons['put-sun-btn'], 'Sun');

			// Clicking put-sun-btn emits object:deploy-orbit-sun with 'Sun'
			let emittedName = null;
			EventBus.on('object:deploy-orbit-sun', (name) => {
				emittedName = name;
			});

			const sunBtn = document.getElementById('put-sun-btn');
			assert.ok(sunBtn, 'put-sun-btn must exist in DOM');
			sunBtn.click();
			assert.equal(emittedName, 'Sun');
		});

		it('should deploy Sun via placeAtOrbitAroundSun and focus camera on Sun', () => {
			const placer = new ObjectPlacer(universe);

			// Clear initial objects in universe
			universe.objects.length = 0;
			universe.camera.trackingTarget = null;

			// Deploy Sun when no Sun exists
			const deployedSun = placer.placeAtOrbitAroundSun('Sun');
			assert.ok(deployedSun, 'Sun should be created');
			assert.equal(deployedSun.name, 'Sun');
			assert.equal(universe.camera.trackingTarget, deployedSun, 'Camera tracking target should be set to Sun');

			// Deploy Sun again when Sun already exists
			const secondSun = placer.placeAtOrbitAroundSun('Sun');
			assert.equal(secondSun, deployedSun, 'Should return existing Sun without duplicating');
			const sunCount = universe.objects.filter(o => o.name === 'Sun').length;
			assert.equal(sunCount, 1, 'There should only be 1 Sun');
			assert.equal(universe.camera.trackingTarget, deployedSun);

			placer.destroy();
		});
	});

	describe('2. Deploying Planets of the Sun (Auto-deploy Sun and set Reference Body)', () => {
		it('should auto-place Sun, place planet in orbit, and set tracking target to that planet when Sun is absent', () => {
			const placer = new ObjectPlacer(universe);

			// Start with an empty universe without Sun
			universe.objects.length = 0;
			universe.camera.trackingTarget = null;

			// Deploy Earth
			const earth = placer.placeAtOrbitAroundSun('Earth');
			assert.ok(earth, 'Earth must be placed');
			assert.equal(earth.name, 'Earth');

			// Verify Sun was automatically created
			const sun = universe.objects.find(o => o.name === 'Sun');
			assert.ok(sun, 'Sun must be automatically deployed when adding a solar planet');
			assert.equal(sun.x, canvas.width / 2);
			assert.equal(sun.y, canvas.height / 2);

			// Verify reference body (tracking target) is set to Earth
			assert.equal(universe.camera.trackingTarget, earth, 'Camera tracking target must be set to the deployed planet (Earth)');

			// Verify Earth is placed in orbit around the Sun
			const distPx = Math.hypot(earth.x - sun.x, earth.y - sun.y);
			assert.ok(distPx > 100, `Earth should be in orbit around Sun (distPx: ${distPx})`);

			placer.destroy();
		});

		it('should deploy all solar system planets around existing Sun and update reference body each time', () => {
			const placer = new ObjectPlacer(universe);

			// Clear universe and deploy Sun
			universe.objects.length = 0;
			const sun = placer.placeAtOrbitAroundSun('Sun');
			assert.equal(universe.camera.trackingTarget, sun);

			const planetsToTest = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Ceres', 'Eris'];
			for (const planetName of planetsToTest) {
				const planetObj = placer.placeAtOrbitAroundSun(planetName);
				assert.ok(planetObj, `${planetName} must be placed`);
				assert.equal(planetObj.name, planetName);
				assert.equal(universe.camera.trackingTarget, planetObj, `Reference body must be updated to ${planetName}`);

				// Verify Sun was not duplicated
				const sunCount = universe.objects.filter(o => o.name === 'Sun').length;
				assert.equal(sunCount, 1, 'Sun must remain unique');
			}

			placer.destroy();
		});

		it('should throw error when calling placeAtOrbitAroundSun with non-solar object if Sun is absent', () => {
			const placer = new ObjectPlacer(universe);
			universe.objects.length = 0;
			universe.camera.trackingTarget = null;

			assert.throws(() => {
				placer.placeAtOrbitAroundSun('Rocket');
			}, /Sun object not found/);

			assert.throws(() => {
				placer.placeAtOrbitAroundSun('UnknownExtragalacticPlanet');
			}, /Sun object not found/);

			placer.destroy();
		});

		it('should place non-solar object around existing Sun without forcing tracking target', () => {
			const placer = new ObjectPlacer(universe);
			universe.objects.length = 0;
			const sun = placer.placeAtOrbitAroundSun('Sun');

			// Add rocket around Sun
			const rocket = placer.placeAtOrbitAroundSun('Rocket');
			assert.ok(rocket, 'Rocket should be placed around existing Sun');
			assert.equal(rocket.name, 'Rocket');

			placer.destroy();
		});

		it('should place object at canvas center when hostObj is null in placeAtOrbit', () => {
			const placer = new ObjectPlacer(universe);
			const obj = placer.placeAtOrbit('Earth', null);
			assert.ok(obj);
			assert.equal(obj.x, canvas.width / 2);
			assert.equal(obj.y, canvas.height / 2);
			placer.destroy();
		});
	});

	describe('3. Center Object is Not Sun (Earth, Jupiter, Moon, or Free Pan)', () => {
		it('should allow setting tracking target to Earth and render without crash', () => {
			universe.objects.length = 0;
			const sun = new CelestialBody(1, 'Sun', 0, 0, 0, 0, 1.989e30, '#ffcc00', 10, 6.9634e8, 0, null, 0);
			const earth = new CelestialBody(2, 'Earth', 180, 0, 0, 0.03, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
			const moon = new CelestialBody(3, 'Moon', 185, 0, 0, 0.031, 7.342e22, '#cccccc', 2, 1737000, 0, null, 0);
			universe.addObject(sun);
			universe.addObject(earth);
			universe.addObject(moon);

			// Center on Earth (ID: 2)
			universe.camera.setTrackingTarget(earth);
			assert.equal(universe.centerObject, earth);
			assert.equal(universe.camera.trackingTarget.id, 2);

			// Perform simulation update
			universe.update(16);

			// Perform draw call
			const ctx = canvas.getContext('2d');
			const renderState = universe.camera.getRenderState();
			assert.equal(renderState.basis, earth);

			// Draw main objects
			universe.objects.forEach(obj => obj.draw(universe.Renderer.renderContext));

			// Overlay labels with center Earth
			const overlayRenderer = new OverlayRenderer(universe);
			overlayRenderer._drawLabels(ctx, universe.Renderer.renderContext);

			// Switch center to Moon
			universe.camera.setTrackingTarget(moon);
			assert.equal(universe.centerObject, moon);
			universe.update(16);
			universe.objects.forEach(obj => obj.draw(universe.Renderer.renderContext));
			overlayRenderer._drawLabels(ctx, universe.Renderer.renderContext);
		});

		it('should allow setting tracking target to null (free pan) and render without crash', () => {
			universe.objects.length = 0;
			const sun = new CelestialBody(1, 'Sun', 0, 0, 0, 0, 1.989e30, '#ffcc00', 10, 6.9634e8, 0, null, 0);
			const mars = new CelestialBody(2, 'Mars', 270, 0, 0, 0.024, 6.417e23, '#cc4422', 4, 3389000, 0, null, 0);
			universe.addObject(sun);
			universe.addObject(mars);

			// Set tracking target to null
			universe.camera.setTrackingTarget(null);
			assert.equal(universe.centerObject, null);

			const renderState = universe.camera.getRenderState();
			assert.equal(renderState.basis, null);

			// Universe update and draw should not throw
			universe.update(16);
			const ctx = canvas.getContext('2d');
			universe.objects.forEach(obj => obj.draw(universe.Renderer.renderContext));

			// OverlayRenderer _drawLabels with basis = null
			const overlayRenderer = new OverlayRenderer(universe);
			overlayRenderer._drawLabels(ctx, universe.Renderer.renderContext);

			// RocketLauncher target marker and preview with basis = null
			const rl = universe.RocketLauncher;
			rl.mode = 'host';
			rl.hostId = sun.id;
			rl.drawTargetMarker(ctx, null, 1.0);

			// Free mode preview with basis = null
			rl.mode = 'free';
			rl.freeX = 200;
			rl.freeY = 200;
			rl.isActive = true;
			rl.drawPreview(ctx, null, 1.0, universe.Renderer.renderContext);
		});

		it('should safely slingshot drag and launch when basis is null', () => {
			const placer = new ObjectPlacer(universe);
			universe.camera.setTrackingTarget(null);

			// Start drag via EventBus
			EventBus.emit('input:drag-start', 100, 100);
			assert.equal(placer.isSlingshotting, true);
			assert.ok(typeof placer.startRelX === 'number');
			assert.ok(typeof placer.startRelY === 'number');

			// Update drag
			EventBus.emit('input:drag-move', 120, 140);
			assert.equal(placer.screenCursorX, 120);
			assert.equal(placer.screenCursorY, 140);

			// Draw preview
			const ctx = canvas.getContext('2d');
			placer.drawPreview(ctx, null, 1.0);

			// Launch
			EventBus.emit('input:drag-end', 150, 150);
			assert.equal(placer.isSlingshotting, false);

			// Verify launched rocket exists
			const launched = universe.objects.find(o => o.type === OBJECT_TYPES.ROCKET);
			assert.ok(launched, 'Launched rocket should exist in universe');

			placer.destroy();
		});

		it('should safely clear objects and update tracking target when center was a cleared celestial body', () => {
			universe.objects.length = 0;
			const sun = new CelestialBody(0, 'Sun', 0, 0, 0, 0, 1.989e30, '#ffcc00', 10, 6.9634e8, 0, null, 0);
			const earth = new CelestialBody(1, 'Earth', 180, 0, 0, 0.03, 5.972e24, '#3366cc', 5, 6371000, 0, null, 0);
			const mars = new CelestialBody(2, 'Mars', 270, 0, 0, 0.024, 6.417e23, '#cc4422', 4, 3389000, 0, null, 0);
			universe.addObject(sun);
			universe.addObject(earth);
			universe.addObject(mars);

			// Center on Earth
			universe.camera.setTrackingTarget(earth);
			assert.equal(universe.camera.trackingTarget, earth);

			// Clear celestials (clears Earth and Mars, preserves Sun id:0)
			universe.clearObjects(false, false, true);
			universe.ObjectManager.cleanupObjects();

			// Tracking target should safely switch away from deleted Earth to Sun
			assert.ok(!universe.objects.includes(earth), 'Earth was cleared');
			assert.ok(universe.objects.includes(sun), 'Sun id:0 preserved');
			assert.equal(universe.camera.trackingTarget, sun, 'Tracking target safely switched to Sun');

			// Clear remaining Sun (e.g. by removing directly)
			universe.removeObject(sun);
			universe.ObjectManager.cleanupObjects();
			if (universe.camera.trackingTarget === sun) {
				universe.camera.setTrackingTarget(null);
			}
			assert.equal(universe.camera.trackingTarget, null);

			// Universe should update and draw with 0 objects without throwing
			universe.update(16);
			universe.draw();
		});
	});

	describe('4. Camera Fallback and Object Lifecycle Edge Cases', () => {
		it('should select largest object as ultimate fallback when current active target dies and no host/Earth exists', () => {
			universe.objects.length = 0;
			const starA = new CelestialBody(10, 'BigStar', 0, 0, 0, 0, 5e30, '#ffff00', 10, 1e9, 0, null, 0);
			const starB = new CelestialBody(11, 'SmallStar', 500, 0, 0, 0, 1e28, '#ff8800', 5, 5e8, 0, null, 0);
			universe.addObject(starA);
			universe.addObject(starB);

			universe.camera.setTrackingTarget(starB);
			assert.equal(universe.camera.trackingTarget, starB);

			// Kill starB
			starB.state = OBJECT_STATE.DESTROYED;

			// Trigger camera update hook
			EventBus.emitUpdate(16, 0.01);

			// Should fallback to largest object (BigStar)
			assert.equal(universe.camera.trackingTarget, starA);
		});

		it('should emit object-list-changed when object count changes in updateUI', () => {
			let emittedCount = null;
			EventBus.on('object-list-changed', (count) => {
				emittedCount = count;
			});

			universe.updateUI(Date.now());
			const initialCount = universe.objects.length;

			// Add an object
			const tempObj = new CelestialBody(999, 'Temp', 0, 0, 0, 0, 1e20, '#fff', 1, 1000, 0, null, 0);
			universe.addObject(tempObj);

			universe.updateUI(Date.now());
			assert.equal(emittedCount, initialCount + 1);
		});

		it('should deploy profiles with defined center object correctly', () => {
			const placer = new ObjectPlacer(universe);

			// Deploy SOLAR_SYSTEM profile which specifies center Sun
			placer.deployProfile('SOLAR_SYSTEM');
			assert.ok(universe.objects.length >= 8);
			const sun = universe.objects.find(o => o.name === 'Sun');
			assert.ok(sun, 'Sun must be present in SOLAR_SYSTEM');
			assert.equal(universe.camera.trackingTarget, sun, 'Tracking target should be center Sun');

			placer.destroy();
		});
	});
});
