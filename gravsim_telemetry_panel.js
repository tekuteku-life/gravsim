// gravsim_telemetry_panel.js

export class TelemetryPanel {
	constructor(universe) {
		this.universe = universe;
		this.isOpen = false;
		this.lastUpdate = 0;
		this.intervalMs = 100;
		
		// 追加: テレメトリ固有のターゲットIDと、追加検知用のカウント
		this.targetId = null;
		this.lastObjCount = -1;

		this.ui = {
			toggleBtn: document.getElementById('telemetry-toggle-btn'),
			panel: document.getElementById('telemetry-panel'),
			targetSelect: document.getElementById('tm-target-select'), // 変更
			refBody: document.getElementById('tm-refbody'),
			alt: document.getElementById('tm-alt'),
			vel: document.getElementById('tm-vel'),
			gforce: document.getElementById('tm-gforce'),
			mass: document.getElementById('tm-mass'),
			rocketData: document.getElementById('tm-rocket-data'),
			prop: document.getElementById('tm-prop'),
			burn: document.getElementById('tm-burn'),
		};

		this._bindEvents();
	}

	_bindEvents() {
		if (this.ui.toggleBtn) {
			this.ui.toggleBtn.addEventListener('click', () => {
				this.isOpen = !this.isOpen;
				this.ui.panel.style.display = this.isOpen ? 'block' : 'none';
				this.ui.toggleBtn.textContent = this.isOpen ? 'TELEMETRY: ON' : 'TELEMETRY: OFF';
				this.ui.toggleBtn.style.color = this.isOpen ? '#ff5555' : '#00ffcc';
				this.ui.toggleBtn.style.borderColor = this.isOpen ? '#ff5555' : '#00ffcc';
				
				if (this.isOpen) {
					this.lastUpdate = 0;
					this.update();
				}
			});
		}

		// 追加: 手動でテレメトリ対象を切り替えた時の処理
		if (this.ui.targetSelect) {
			this.ui.targetSelect.addEventListener('change', (e) => {
				this.targetId = parseInt(e.target.value, 10);
				this.lastUpdate = 0; // 即時反映
			});
		}
	}

	// 追加: プルダウンの中身を最新のオブジェクトリストで再構築する
	_updateTargetOptions() {
		if (!this.ui.targetSelect) return;
		
		this.ui.targetSelect.innerHTML = '';
		for (const obj of this.universe.objects) {
			const option = document.createElement('option');
			option.value = obj.id;
			option.textContent = `${obj.name.substring(0, 10)} (ID:${obj.id})`;
			
			if (obj.id === this.targetId) {
				option.selected = true;
			}
			this.ui.targetSelect.appendChild(option);
		}
	}

	update() {
		if (!this.isOpen) return;

		const now = Date.now();
		if (now - this.lastUpdate < this.intervalMs) return;
		this.lastUpdate = now;

		// オブジェクト数が増減した場合の処理
		if (this.lastObjCount !== this.universe.objects.length) {
			// 新しいオブジェクトが追加された場合（発射時）、自動的にそれをターゲットに切り替える
			if (this.lastObjCount !== -1 && this.universe.objects.length > this.lastObjCount) {
				const newestObj = this.universe.objects[this.universe.objects.length - 1];
				this.targetId = newestObj.id;
			}
			this._updateTargetOptions();
			this.lastObjCount = this.universe.objects.length;
		}

		// ターゲットの決定（未設定・対象消滅時はCenter Objectにフォールバック）
		let target = this.universe.objects.find(o => o.id === this.targetId);
		if (!target) {
			target = this.universe.centerObject;
			if (target) {
				this.targetId = target.id;
				if (this.ui.targetSelect) this.ui.targetSelect.value = target.id;
			} else {
				return;
			}
		}

		// 1. Find Reference Body
		let refBody = null;
		let maxG = -1;
		let distToRefPx = 0;
		
		for (const obj of this.universe.objects) {
			if (obj.id === target.id) continue;
			const dx = target.x - obj.x;
			const dy = target.y - obj.y;
			const distSqPx = dx * dx + dy * dy;
			const distSqM = Math.pow(this.universe.pix2m(Math.sqrt(distSqPx)), 2);
			if (distSqM === 0) continue;
			
			const gForce = obj.mass / distSqM; 
			if (gForce > maxG) {
				maxG = gForce;
				refBody = obj;
				distToRefPx = Math.sqrt(distSqPx);
			}
		}

		// 2. Update Basic Info
		if (refBody) {
			this.ui.refBody.innerText = refBody.name.substring(0, 14);
			
			const distM = this.universe.pix2m(distToRefPx);
			const altM = distM - target.radius - refBody.radius;
			this.ui.alt.innerText = (altM / 1000).toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(10, ' ');

			const dvx = this.universe.pix2m(target.vx - refBody.vx);
			const dvy = this.universe.pix2m(target.vy - refBody.vy);
			const velM = Math.sqrt(dvx * dvx + dvy * dvy);
			this.ui.vel.innerText = (velM / 1000).toLocaleString('en-US', {minimumFractionDigits: 3, maximumFractionDigits: 3}).padStart(9, ' ');
		} else {
			this.ui.refBody.innerText = "NONE";
			this.ui.alt.innerText = "---".padStart(10, ' ');
			this.ui.vel.innerText = "---".padStart(9, ' ');
		}

		this.ui.mass.innerText = target.mass.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(9, ' ');

		// 3. G-Force Calculation
		let gForce = 0;
		if (target.burnTime > 0 && target.thrustForce > 0) {
			const thrustN = target.thrustForce;
			const massKg = target.mass * 1000;
			gForce = (thrustN / massKg) / 9.80665;
		}
		this.ui.gforce.innerText = gForce.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(7, ' ');

		// 4. Rocket Specific Data
		if (target.emptyMass > 0 && target.massLossRate > 0) {
			this.ui.rocketData.style.display = 'block';
			const currentProp = Math.max(0, target.mass - target.emptyMass);
			this.ui.prop.innerText = currentProp.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).padStart(8, ' ');
			this.ui.burn.innerText = target.burnTime.toLocaleString('en-US', {minimumFractionDigits: 1, maximumFractionDigits: 1}).padStart(8, ' ');
		} else {
			this.ui.rocketData.style.display = 'none';
		}
	}
}