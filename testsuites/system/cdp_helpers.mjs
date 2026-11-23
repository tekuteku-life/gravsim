/**
 * Zero-dependency headless Chrome E2E infrastructure for testsuites/system/.
 *
 * - startStaticServer(): serves the repository over node:http on 127.0.0.1 with an ephemeral port
 *   (listen(0)), correct MIME types and path-traversal refusal.
 * - launchChrome(): starts Chromium (/usr/bin/chromium or $CHROME_PATH) headless with a temporary
 *   profile under os.tmpdir() and --remote-debugging-port=0, and reads the DevTools URL from stderr.
 * - CdpConnection / PageSession: a small promise-based Chrome DevTools Protocol client on Node's
 *   built-in global WebSocket (flattened sessions), with event waiters and polling helpers.
 * - startE2E() / bootGravSim(): start server + browser, open a fresh tab that records console errors,
 *   uncaught exceptions (page and Web Workers), log errors and JavaScript dialogs (auto-accepted), and
 *   boot the app; captureDownload() / chooseFileViaClick() drive Save State / Load State.
 * - GravSim UI helpers (tabs, deployment, prediction settling and summaries, the flight-profile
 *   table, range sliders via keyboard) shared by the NN_*.test.mjs files.
 *
 * This file intentionally does not end in ".test.mjs" so that run_all.mjs does not collect it.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_CHROME_PATH = '/usr/bin/chromium';
export const DEFAULT_TIMEOUT_MS = 20000;

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8'
};

/**
 * Resolve the MIME type served for a file name.
 * @param {string} filePath
 * @returns {string}
 */
export function mimeTypeFor(filePath) {
	return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a promise with a timeout that rejects with a descriptive error.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} description
 * @returns {Promise<T>}
 */
export function withTimeout(promise, timeoutMs, description) {
	let timer = null;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms: ${description}`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------------------------------------
 * Static file server
 * ---------------------------------------------------------------------------------------------- */

/**
 * Serve `root` over HTTP on 127.0.0.1 with an ephemeral port.
 * Every request is recorded in `requests` ({ method, url, status }).
 * @param {string} [root]
 * @returns {Promise<{ server: http.Server, port: number, origin: string, requests: Array<{method: string, url: string, status: number}>, close: () => Promise<void> }>}
 */
export function startStaticServer(root = PROJECT_ROOT) {
	const rootDir = path.resolve(root);
	/** @type {Array<{method: string, url: string, status: number}>} */
	const requests = [];
	const sockets = new Set();

	const server = http.createServer((req, res) => {
		const finish = (status, headers, body) => {
			requests.push({ method: req.method || '', url: req.url || '', status });
			res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
			res.end(body);
		};

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			finish(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, 'Method Not Allowed');
			return;
		}

		const rawUrl = req.url || '/';
		const rawPath = rawUrl.split('?')[0].split('#')[0];
		let decodedPath;
		try {
			decodedPath = decodeURIComponent(rawPath);
		} catch {
			finish(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
			return;
		}
		if (decodedPath.includes('\0') || !decodedPath.startsWith('/')) {
			finish(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
			return;
		}

		// Refuse any path whose segments climb out of the root (checked before and after resolution)
		const segments = decodedPath.split(/[\\/]+/);
		const resolved = path.resolve(rootDir, '.' + path.posix.normalize(decodedPath.replace(/\\/g, '/')));
		if (segments.includes('..') || (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep))) {
			finish(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
			return;
		}

		let filePath = resolved;
		try {
			if (fs.statSync(filePath).isDirectory()) {
				filePath = path.join(filePath, 'index.html');
			}
			const stat = fs.statSync(filePath);
			if (!stat.isFile()) { throw new Error('not a file'); }
		} catch {
			finish(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
			return;
		}

		const body = fs.readFileSync(filePath);
		finish(200, { 'Content-Type': mimeTypeFor(filePath), 'Content-Length': String(body.length) }, req.method === 'HEAD' ? undefined : body);
	});

	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const close = () => new Promise((resolveClose) => {
				for (const socket of sockets) { socket.destroy(); }
				server.close(() => resolveClose());
			});
			resolve({ server, port, origin: `http://127.0.0.1:${port}`, requests, close });
		});
	});
}

/**
 * Issue a raw GET without URL normalization (used to verify the server's traversal refusal).
 * @param {number} port
 * @param {string} rawPath
 * @returns {Promise<{ status: number, contentType: string, body: string }>}
 */
export function rawGet(port, rawPath) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({
				status: res.statusCode || 0,
				contentType: String(res.headers['content-type'] || ''),
				body: Buffer.concat(chunks).toString('utf8')
			}));
		});
		req.on('error', reject);
		req.end();
	});
}

/* ------------------------------------------------------------------------------------------------
 * Chromium launcher
 * ---------------------------------------------------------------------------------------------- */

/**
 * Flags for deterministic headless runs. WSL2 has no GPU (--disable-gpu) and a small /dev/shm
 * (--disable-dev-shm-usage); the Chromium sandbox works there, so --no-sandbox is not used by
 * default. Audio goes to Chromium's fake output (--disable-audio-output): the Web Audio graph and
 * its clock run as usual, but no host audio device is opened, so a device error cannot stall the
 * page (one run stalled the first click, which creates the AudioContext, for over 20 s with "The
 * AudioContext encountered an error from the audio device"); --mute-audio stays as a fallback. Environments without user namespaces can append flags through GRAVSIM_E2E_CHROME_ARGS
 * (space separated, e.g. GRAVSIM_E2E_CHROME_ARGS=--no-sandbox).
 */
export const CHROME_BASE_FLAGS = [
	'--headless=new',
	'--remote-debugging-port=0',
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-gpu',
	'--window-size=1400,900',
	'--disable-dev-shm-usage',
	'--disable-background-networking',
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',
	'--disable-extensions',
	'--disable-component-update',
	'--disable-default-apps',
	'--disable-sync',
	'--disable-breakpad',
	'--disable-audio-output',
	'--mute-audio',
	'--autoplay-policy=no-user-gesture-required',
	'--password-store=basic',
	'--use-mock-keychain'
];

/** Live launches: process-group id -> temporary profile directory. */
const liveChromes = new Map();
/** Other temporary directories (downloads, scratch files) removed on process exit if still present. */
const liveTempDirs = new Set();
let exitHookInstalled = false;

/**
 * PIDs of processes whose command line mentions `marker` (Linux /proc). Used for the crashpad
 * handlers, which detach into their own process groups but carry the profile-local database path.
 * @param {string} marker
 * @returns {number[]}
 */
function findPidsByCmdline(marker) {
	let entries = [];
	try { entries = fs.readdirSync('/proc'); } catch { return []; }
	const pids = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) { continue; }
		const pid = Number(entry);
		if (pid === process.pid) { continue; }
		try {
			const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
			if (cmdline.includes(marker)) { pids.push(pid); }
		} catch { /* process exited or not readable */ }
	}
	return pids;
}

function killSync(pgid, userDataDir) {
	try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
	for (const pid of findPidsByCmdline(userDataDir)) {
		try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
	}
}

function installExitHook() {
	if (exitHookInstalled) { return; }
	exitHookInstalled = true;
	// Last-resort synchronous cleanup if the test process exits without running finally blocks.
	process.on('exit', () => {
		for (const [pgid, userDataDir] of liveChromes) {
			killSync(pgid, userDataDir);
			try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
		}
		for (const dir of liveTempDirs) {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
		}
	});
}

/**
 * Create a temporary directory under os.tmpdir() that is also removed on process exit.
 * @param {string} prefix
 * @returns {{ dir: string, remove: () => void }}
 */
export function makeTempDir(prefix) {
	installExitHook();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	liveTempDirs.add(dir);
	return {
		dir,
		remove: () => {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			liveTempDirs.delete(dir);
		}
	};
}

function isProcessGroupAlive(pid) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Launch headless Chromium. Fails (throws) with a clear message when the binary is missing or the
 * DevTools endpoint does not come up; it never silently skips.
 *
 * Isolation: the profile is a fresh `fs.mkdtempSync(os.tmpdir()/gravsim-e2e-)` directory, and
 * XDG_CONFIG_HOME points inside it so the crashpad database (otherwise ~/.config/chromium/Crash
 * Reports) also lives there and is deleted with it.
 * @param {{ chromePath?: string, extraArgs?: string[], timeoutMs?: number }} [options]
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, wsUrl: string, userDataDir: string, stderrTail: () => string, close: (conn?: CdpConnection | null) => Promise<void> }>}
 */
export async function launchChrome(options = {}) {
	const chromePath = options.chromePath || process.env.CHROME_PATH || DEFAULT_CHROME_PATH;
	try {
		fs.accessSync(chromePath, fs.constants.X_OK);
	} catch {
		throw new Error(`[system E2E] Chromium is not available at "${chromePath}". Install Chromium or set CHROME_PATH to an executable Chrome/Chromium binary. The headless UI tests cannot run without it.`);
	}

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gravsim-e2e-'));
	const xdgConfigHome = path.join(userDataDir, 'xdg-config');
	fs.mkdirSync(xdgConfigHome);
	const envArgs = (process.env.GRAVSIM_E2E_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
	const args = [...CHROME_BASE_FLAGS, `--user-data-dir=${userDataDir}`, ...envArgs, ...(options.extraArgs || []), 'about:blank'];

	installExitHook();
	const proc = spawn(chromePath, args, {
		stdio: ['ignore', 'ignore', 'pipe'],
		detached: true,
		env: { ...process.env, XDG_CONFIG_HOME: xdgConfigHome }
	});
	if (proc.pid) { liveChromes.set(proc.pid, userDataDir); }

	let stderr = '';
	let exited = false;
	const exitPromise = new Promise((resolve) => {
		proc.once('exit', (code, signal) => {
			exited = true;
			resolve({ code, signal });
		});
	});
	proc.once('error', () => { /* reported through the launch promise below */ });

	const removeProfile = () => {
		try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
	};

	/** Kill the browser's process group and its detached crashpad handlers, and wait until gone. */
	const killAll = async () => {
		if (!proc.pid) { return; }
		for (const signal of ['SIGTERM', 'SIGKILL']) {
			const stragglers = findPidsByCmdline(userDataDir);
			if (!isProcessGroupAlive(proc.pid) && stragglers.length === 0) { break; }
			try { process.kill(-proc.pid, signal); } catch { /* already gone */ }
			for (const pid of stragglers) {
				try { process.kill(pid, signal); } catch { /* already gone */ }
			}
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline && (isProcessGroupAlive(proc.pid) || findPidsByCmdline(userDataDir).length > 0)) {
				await sleep(50);
			}
		}
		liveChromes.delete(proc.pid);
	};

	let wsUrl;
	try {
		wsUrl = await withTimeout(new Promise((resolve, reject) => {
			proc.stderr.setEncoding('utf8');
			proc.stderr.on('data', (chunk) => {
				stderr += chunk;
				if (stderr.length > 64 * 1024) { stderr = stderr.slice(-32 * 1024); }
				const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
				if (match) { resolve(match[1]); }
			});
			proc.once('error', (err) => reject(new Error(`[system E2E] Failed to start Chromium "${chromePath}": ${err.message}`)));
			exitPromise.then(({ code, signal }) => reject(new Error(`[system E2E] Chromium exited before DevTools was ready (code=${code}, signal=${signal}). stderr:\n${stderr.slice(-4000)}`)));
		}), options.timeoutMs || 30000, `Chromium DevTools endpoint (stderr so far: ${stderr.slice(-500)})`);
	} catch (err) {
		await killAll();
		removeProfile();
		throw err;
	}

	/**
	 * Close the browser: Browser.close over CDP, wait for exit, then kill whatever is left of the
	 * process group and the crashpad handlers, and delete the temporary profile. Idempotent.
	 * @param {CdpConnection | null} [conn]
	 */
	const close = async (conn = null) => {
		if (conn && !conn.isClosed) {
			try { await conn.send('Browser.close', {}, undefined, 5000); } catch { /* fall through to kill */ }
		}
		if (!exited) {
			await Promise.race([exitPromise, sleep(5000)]);
		}
		if (conn) { conn.close(); }
		await killAll();
		removeProfile();
	};

	return { proc, wsUrl, userDataDir, stderrTail: () => stderr.slice(-4000), close };
}

/* ------------------------------------------------------------------------------------------------
 * CDP connection (flattened sessions over one WebSocket)
 * ---------------------------------------------------------------------------------------------- */

export class CdpConnection {
	/** @param {WebSocket} ws */
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, method: string }>} */
		this.pending = new Map();
		/** @type {Set<(msg: any) => void>} */
		this.listeners = new Set();
		this.isClosed = false;

		ws.addEventListener('message', (event) => {
			const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
			if (msg.id !== undefined) {
				const entry = this.pending.get(msg.id);
				if (!entry) { return; }
				this.pending.delete(msg.id);
				if (msg.error) {
					entry.reject(new Error(`CDP ${entry.method} failed: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
				} else {
					entry.resolve(msg.result);
				}
				return;
			}
			for (const listener of [...this.listeners]) {
				listener(msg);
			}
		});
		ws.addEventListener('close', () => {
			this.isClosed = true;
			for (const entry of this.pending.values()) {
				entry.reject(new Error(`CDP connection closed while waiting for ${entry.method}`));
			}
			this.pending.clear();
		});
	}

	/**
	 * @param {string} wsUrl
	 * @param {number} [timeoutMs]
	 * @returns {Promise<CdpConnection>}
	 */
	static connect(wsUrl, timeoutMs = 10000) {
		if (typeof WebSocket !== 'function') {
			return Promise.reject(new Error('[system E2E] Node global WebSocket is unavailable (Node >= 22 is required).'));
		}
		const ws = new WebSocket(wsUrl);
		return withTimeout(new Promise((resolve, reject) => {
			ws.addEventListener('open', () => resolve(new CdpConnection(ws)), { once: true });
			ws.addEventListener('error', () => reject(new Error(`[system E2E] WebSocket connection to ${wsUrl} failed`)), { once: true });
		}), timeoutMs, `WebSocket connect ${wsUrl}`);
	}

	/**
	 * @param {string} method
	 * @param {object} [params]
	 * @param {string} [sessionId]
	 * @param {number} [timeoutMs]
	 * @returns {Promise<any>}
	 */
	send(method, params = {}, sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT_MS) {
		if (this.isClosed) {
			return Promise.reject(new Error(`CDP connection is closed (${method})`));
		}
		const id = this.nextId++;
		const payload = { id, method, params };
		if (sessionId) { payload.sessionId = sessionId; }
		const promise = new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method });
		});
		this.ws.send(JSON.stringify(payload));
		return withTimeout(promise, timeoutMs, `CDP ${method}`).catch((err) => {
			this.pending.delete(id);
			throw err;
		});
	}

	/**
	 * Subscribe to a CDP event. Returns the unsubscribe function.
	 * @param {string} method
	 * @param {(params: any, sessionId: string | undefined) => void} handler
	 * @param {string | null} [sessionId] null = any session
	 */
	on(method, handler, sessionId = null) {
		const listener = (msg) => {
			if (msg.method !== method) { return; }
			if (sessionId !== null && msg.sessionId !== sessionId) { return; }
			handler(msg.params, msg.sessionId);
		};
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Wait for an event matching `predicate`.
	 * @param {string} method
	 * @param {{ predicate?: (params: any) => boolean, sessionId?: string | null, timeoutMs?: number }} [options]
	 * @returns {Promise<any>}
	 */
	waitForEvent(method, { predicate = () => true, sessionId = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
		let off = () => {};
		const promise = new Promise((resolve) => {
			off = this.on(method, (params) => {
				if (predicate(params)) {
					off();
					resolve(params);
				}
			}, sessionId);
		});
		return withTimeout(promise, timeoutMs, `CDP event ${method}`).finally(() => off());
	}

	close() {
		if (!this.isClosed) {
			this.isClosed = true;
			try { this.ws.close(); } catch { /* ignore */ }
		}
	}
}

/* ------------------------------------------------------------------------------------------------
 * Page session
 * ---------------------------------------------------------------------------------------------- */

const KEY_DEFINITIONS = {
	Home: { code: 'Home', keyCode: 36 },
	End: { code: 'End', keyCode: 35 },
	ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
	ArrowUp: { code: 'ArrowUp', keyCode: 38 },
	ArrowRight: { code: 'ArrowRight', keyCode: 39 },
	ArrowDown: { code: 'ArrowDown', keyCode: 40 },
	Enter: { code: 'Enter', keyCode: 13, text: '\r' },
	Tab: { code: 'Tab', keyCode: 9 },
	Backspace: { code: 'Backspace', keyCode: 8 },
	Delete: { code: 'Delete', keyCode: 46 },
	a: { code: 'KeyA', keyCode: 65, text: 'a' }
};

export class PageSession {
	/**
	 * @param {CdpConnection} conn
	 * @param {string} sessionId
	 * @param {string} targetId
	 */
	constructor(conn, sessionId, targetId) {
		this.conn = conn;
		this.sessionId = sessionId;
		this.targetId = targetId;
		/** Console errors (console.error / console.assert) from the page and its workers. */
		this.consoleErrors = [];
		/** Uncaught exceptions (Runtime.exceptionThrown) from the page and its workers. */
		this.exceptions = [];
		/** Log.entryAdded entries with level "error" (network failures, interventions...). */
		this.logErrors = [];
		/** Every JavaScript dialog that opened ({ type, message }); each is accepted automatically. */
		this.dialogs = [];
		/** Attached worker sessions (sessionId -> url). */
		this.workers = new Map();
		this._unsubs = [];
	}

	send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
		return this.conn.send(method, params, this.sessionId, timeoutMs);
	}

	on(method, handler) {
		const off = this.conn.on(method, handler, this.sessionId);
		this._unsubs.push(off);
		return off;
	}

	waitForEvent(method, options = {}) {
		return this.conn.waitForEvent(method, { ...options, sessionId: this.sessionId });
	}

	/** Install console / exception / dialog / worker collectors. */
	async installCollectors() {
		const describeException = (d) => {
			const ex = d?.exceptionDetails || {};
			const desc = ex.exception?.description || ex.exception?.value || ex.text || 'unknown exception';
			return `${desc} @ ${ex.url || ''}:${ex.lineNumber ?? ''}:${ex.columnNumber ?? ''}`;
		};
		const formatArgs = (args = []) => args.map((a) => {
			if (a.value !== undefined) { return typeof a.value === 'string' ? a.value : JSON.stringify(a.value); }
			return a.description || a.type;
		}).join(' ');

		const isOurSession = (sid) => sid === this.sessionId || this.workers.has(sid);
		this._unsubs.push(this.conn.on('Runtime.exceptionThrown', (params, sid) => {
			if (!isOurSession(sid)) { return; }
			this.exceptions.push({ source: sid === this.sessionId ? 'page' : `worker:${this.workers.get(sid)}`, text: describeException(params) });
		}));
		this._unsubs.push(this.conn.on('Runtime.consoleAPICalled', (params, sid) => {
			if (!isOurSession(sid)) { return; }
			if (params.type === 'error' || params.type === 'assert') {
				this.consoleErrors.push({ source: sid === this.sessionId ? 'page' : `worker:${this.workers.get(sid)}`, text: formatArgs(params.args) });
			}
		}));
		this._unsubs.push(this.conn.on('Log.entryAdded', (params, sid) => {
			if (!isOurSession(sid)) { return; }
			if (params.entry?.level === 'error') {
				this.logErrors.push({ source: params.entry.source, text: `${params.entry.text} ${params.entry.url || ''}`.trim() });
			}
		}));
		this._unsubs.push(this.conn.on('Page.javascriptDialogOpening', (params, sid) => {
			if (sid !== this.sessionId) { return; }
			this.dialogs.push({ type: params.type, message: params.message });
			this.conn.send('Page.handleJavaScriptDialog', { accept: true }, this.sessionId).catch(() => {});
		}));
		this._unsubs.push(this.conn.on('Target.attachedToTarget', (params, sid) => {
			if (sid !== this.sessionId && !this.workers.has(sid)) { return; }
			const child = params.sessionId;
			const type = params.targetInfo?.type;
			if (type !== 'worker' && type !== 'shared_worker' && type !== 'service_worker') {
				this.conn.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
				return;
			}
			this.workers.set(child, params.targetInfo.url);
			const enable = async () => {
				try {
					await this.conn.send('Runtime.enable', {}, child);
					await this.conn.send('Log.enable', {}, child).catch(() => {});
				} finally {
					await this.conn.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
				}
			};
			enable().catch(() => {});
		}));

		await this.send('Page.enable');
		await this.send('Runtime.enable');
		await this.send('Log.enable');
		await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	}

	/** All problems collected so far (exceptions + console errors + log errors). */
	problems() {
		return [
			...this.exceptions.map((e) => `[exception ${e.source}] ${e.text}`),
			...this.consoleErrors.map((e) => `[console.error ${e.source}] ${e.text}`),
			...this.logErrors.map((e) => `[log ${e.source}] ${e.text}`)
		];
	}

	/** Mark the current counts so later checks can look only at new entries. */
	mark() {
		return {
			exceptions: this.exceptions.length,
			consoleErrors: this.consoleErrors.length,
			logErrors: this.logErrors.length,
			dialogs: this.dialogs.length
		};
	}

	/** Problems recorded after `mark`. */
	problemsSince(mark) {
		return [
			...this.exceptions.slice(mark.exceptions).map((e) => `[exception ${e.source}] ${e.text}`),
			...this.consoleErrors.slice(mark.consoleErrors).map((e) => `[console.error ${e.source}] ${e.text}`),
			...this.logErrors.slice(mark.logErrors).map((e) => `[log ${e.source}] ${e.text}`)
		];
	}

	/**
	 * Evaluate a function in the page: `fn` is serialized with its source and called with JSON args.
	 * Promises are awaited. A thrown error in the page rejects with its description.
	 * @param {Function | string} fnOrExpression
	 * @param {...any} args
	 * @returns {Promise<any>}
	 */
	async evaluate(fnOrExpression, ...args) {
		const expression = typeof fnOrExpression === 'function'
			? `(${fnOrExpression.toString()})(...${JSON.stringify(args)})`
			: fnOrExpression;
		const res = await this.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: false
		});
		if (res.exceptionDetails) {
			const ex = res.exceptionDetails;
			throw new Error(`Page evaluation failed: ${ex.exception?.description || ex.text}`);
		}
		return res.result?.value;
	}

	/**
	 * Poll `fn` in the page until it returns a truthy value; returns that value.
	 * @param {Function | string} fn
	 * @param {{ timeoutMs?: number, intervalMs?: number, description?: string, args?: any[] }} [options]
	 */
	async waitFor(fn, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 50, description = 'condition', args = [] } = {}) {
		const deadline = Date.now() + timeoutMs;
		let last;
		let lastError = null;
		while (Date.now() < deadline) {
			try {
				last = await this.evaluate(fn, ...args);
				lastError = null;
				if (last) { return last; }
			} catch (err) {
				lastError = err;
			}
			await sleep(intervalMs);
		}
		throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description} (last value: ${JSON.stringify(last)}${lastError ? `, last error: ${lastError.message}` : ''})`);
	}

	/**
	 * Summarize the main canvas: a hash of all RGBA bytes and the number of pixels in the predicted-
	 * trajectory hue (RENDER.PREDICTED_TRAJECTORY colors are teal: green dominant, blue >= half of
	 * green, red small; Earth's #1E90FF and white/grey pixels do not match).
	 * @param {string} [canvasSelector]
	 * @returns {Promise<{ hash: number, predictionPixels: number, litPixels: number, width: number, height: number }>}
	 */
	canvasSummary(canvasSelector = '#gravsim-canvas') {
		return this.evaluate((sel) => {
			const c = document.querySelector(sel);
			const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
			let hash = 2166136261;
			let predictionPixels = 0;
			let litPixels = 0;
			for (let i = 0; i < d.length; i += 4) {
				const r = d[i]; const g = d[i + 1]; const b = d[i + 2]; const a = d[i + 3];
				hash = Math.imul(hash ^ (r | (g << 8) | (b << 16)), 16777619) >>> 0;
				hash = Math.imul(hash ^ a, 16777619) >>> 0;
				if (a > 0 && (r | g | b) !== 0) { litPixels++; }
				if (g >= 100 && g > b && b >= 0.5 * g && r < 0.4 * g) { predictionPixels++; }
			}
			return { hash, predictionPixels, litPixels, width: c.width, height: c.height };
		}, canvasSelector);
	}

	/**
	 * Wait until the main canvas renders the same image on consecutive checks (camera lerp finished).
	 * @param {{ timeoutMs?: number, framesBetween?: number }} [options]
	 */
	async waitCanvasStable({ timeoutMs = DEFAULT_TIMEOUT_MS, framesBetween = 4 } = {}) {
		const deadline = Date.now() + timeoutMs;
		let prev = await this.canvasSummary();
		let same = 0;
		while (Date.now() < deadline) {
			await this.waitFrames(framesBetween);
			const cur = await this.canvasSummary();
			same = (cur.hash === prev.hash) ? same + 1 : 0;
			prev = cur;
			if (same >= 2) { return cur; }
		}
		throw new Error(`Canvas did not become stable within ${timeoutMs} ms`);
	}

	/**
	 * Focus an element without moving the mouse (a click on a range input would also move its thumb);
	 * keyboard input then follows the real user path.
	 * @param {string} selector
	 */
	async focus(selector) {
		const ok = await this.evaluate((sel) => {
			const el = document.querySelector(sel);
			if (!el || el.disabled) { return false; }
			el.scrollIntoView({ block: 'center' });
			el.focus();
			return document.activeElement === el;
		}, selector);
		if (!ok) { throw new Error(`focus: ${selector} is missing, disabled or not focusable`); }
	}

	/** Wait for `count` animation frames in the page. */
	waitFrames(count = 2) {
		return this.evaluate((n) => new Promise((resolve) => {
			let left = n;
			const step = () => { left -= 1; if (left <= 0) { resolve(true); } else { requestAnimationFrame(step); } };
			requestAnimationFrame(step);
		}), count);
	}

	/**
	 * Scroll the element into view and return its viewport center and state.
	 * @param {string} selector
	 */
	async elementInfo(selector) {
		return this.evaluate(async (sel) => {
			const el = document.querySelector(sel);
			if (!el) { return null; }
			el.scrollIntoView({ block: 'center', inline: 'nearest' });
			// Wait until CSS transitions (e.g. the sliding telemetry panel) have settled: same rect on
			// three consecutive animation frames.
			const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
			const key = () => { const b = el.getBoundingClientRect(); return `${b.left},${b.top},${b.width},${b.height}`; };
			let prev = key();
			let stable = 0;
			for (let i = 0; i < 240 && stable < 3; i++) {
				await frame();
				const cur = key();
				stable = (cur === prev) ? stable + 1 : 0;
				prev = cur;
			}
			const r = el.getBoundingClientRect();
			const cx = r.left + r.width / 2;
			const cy = r.top + r.height / 2;
			const hit = document.elementFromPoint(cx, cy);
			return {
				x: cx, y: cy, width: r.width, height: r.height,
				disabled: Boolean(el.disabled),
				visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
				hitOk: Boolean(hit && (hit === el || el.contains(hit)))
			};
		}, selector);
	}

	/**
	 * Click an element with real mouse events at its center (it must be visible, enabled and on top).
	 * @param {string} selector
	 * @param {{ clickCount?: number }} [options]
	 */
	async click(selector, { clickCount = 1 } = {}) {
		const info = await this.elementInfo(selector);
		if (!info) { throw new Error(`click: element not found: ${selector}`); }
		if (!info.visible) { throw new Error(`click: element not visible: ${selector}`); }
		if (info.disabled) { throw new Error(`click: element is disabled: ${selector}`); }
		if (!info.hitOk) { throw new Error(`click: element is covered by another element: ${selector}`); }
		await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
		await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount });
		await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount });
	}

	/**
	 * Press a key on the focused element (keyDown + keyUp, with text where applicable).
	 * @param {string} key
	 * @param {{ modifiers?: number }} [options]
	 */
	async pressKey(key, { modifiers = 0 } = {}) {
		const def = KEY_DEFINITIONS[key];
		if (!def) { throw new Error(`pressKey: unsupported key ${key}`); }
		const base = { key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
		const withText = def.text && modifiers === 0;
		await this.send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...base, ...(withText ? { text: def.text, unmodifiedText: def.text } : {}) });
		await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
	}

	/**
	 * Focus an element by clicking it (real user path).
	 * @param {string} selector
	 */
	async focusByClick(selector) {
		await this.click(selector);
		const focused = await this.evaluate((sel) => document.activeElement === document.querySelector(sel), selector);
		if (!focused) { throw new Error(`focusByClick: ${selector} did not receive focus`); }
	}

	/**
	 * Replace the text of an input as a user would: click it, select all, type, then commit with Enter.
	 * @param {string} selector
	 * @param {string} text
	 */
	async typeInto(selector, text) {
		await this.focusByClick(selector);
		await this.pressKey('a', { modifiers: 2 /* Ctrl */ });
		await this.pressKey('Delete');
		if (text.length > 0) {
			await this.send('Input.insertText', { text });
		}
		await this.pressKey('Enter');
	}

	/**
	 * Choose an option of a <select>. Native select popups cannot be driven in headless mode, so the
	 * value is set on the element and the same input/change events a user choice fires are dispatched.
	 * @param {string} selector
	 * @param {string} value
	 */
	async selectOption(selector, value) {
		const ok = await this.evaluate((sel, val) => {
			const el = document.querySelector(sel);
			if (!el) { return 'missing'; }
			if (el.disabled) { return 'disabled'; }
			if (![...el.options].some((o) => o.value === val)) { return 'no-option'; }
			el.focus();
			el.value = val;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return 'ok';
		}, selector, value);
		if (ok !== 'ok') { throw new Error(`selectOption(${selector}, ${value}): ${ok}`); }
	}

	dispose() {
		for (const off of this._unsubs) { off(); }
		this._unsubs = [];
	}
}

/* ------------------------------------------------------------------------------------------------
 * GravSim harness
 * ---------------------------------------------------------------------------------------------- */

/**
 * Start the server and the browser, open a new tab and attach a PageSession with collectors.
 * The caller must call `env.close()` in a finally block / after hook.
 * @param {{ downloadDir?: boolean }} [options]
 */
export async function startE2E(options = {}) {
	/** @type {any} */
	const env = { server: null, chrome: null, conn: null, page: null, downloadDir: null, removeDownloadDir: null };
	env.close = async () => {
		const errors = [];
		if (env.page) { env.page.dispose(); }
		if (env.chrome) {
			try { await env.chrome.close(env.conn); } catch (err) { errors.push(err); }
		} else if (env.conn) {
			env.conn.close();
		}
		if (env.server) {
			try { await env.server.close(); } catch (err) { errors.push(err); }
		}
		if (env.removeDownloadDir) {
			try { env.removeDownloadDir(); } catch (err) { errors.push(err); }
		}
		env.page = null; env.chrome = null; env.conn = null; env.server = null; env.downloadDir = null; env.removeDownloadDir = null;
		if (errors.length > 0) { throw errors[0]; }
	};

	try {
		env.server = await startStaticServer();
		env.chrome = await launchChrome();
		env.conn = await CdpConnection.connect(env.chrome.wsUrl);

		const { targetId } = await env.conn.send('Target.createTarget', { url: 'about:blank' });
		const { sessionId } = await env.conn.send('Target.attachToTarget', { targetId, flatten: true });
		env.page = new PageSession(env.conn, sessionId, targetId);
		await env.page.installCollectors();
		await env.page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
		await env.page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
		await env.page.send('Page.bringToFront');

		if (options.downloadDir) {
			const tmp = makeTempDir('gravsim-e2e-dl-');
			env.downloadDir = tmp.dir;
			env.removeDownloadDir = tmp.remove;
			await env.conn.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: env.downloadDir, eventsEnabled: true });
		}
	} catch (err) {
		try { await env.close(); } catch { /* keep the original error */ }
		throw err;
	}
	return env;
}

/**
 * Navigate to the app and wait until it has booted: Universe created, presets loaded, the bootstrap
 * loader hidden and both Workers attached.
 * @param {any} env
 */
export async function bootGravSim(env) {
	const page = env.page;
	const loaded = page.waitForEvent('Page.loadEventFired', { timeoutMs: 30000 });
	const nav = await page.send('Page.navigate', { url: `${env.server.origin}/index.html` });
	if (nav.errorText) { throw new Error(`Navigation failed: ${nav.errorText}`); }
	await loaded;
	await page.waitFor(() => Boolean(
		window.universe
		&& window.universe.RocketLauncher
		&& window.presetManager
		&& window.presetManager.getVehicles().length > 0
		&& document.getElementById('bootstrap-loader')?.style.display === 'none'
		&& window.universe.objects.length >= 1
	), { timeoutMs: 30000, description: 'GravSim boot (universe, presets, loader hidden)' });
	// Physics + predictor workers are attached through Target.setAutoAttach
	const deadline = Date.now() + 10000;
	while (page.workers.size < 2 && Date.now() < deadline) {
		await sleep(50);
	}
	if (page.workers.size < 2) {
		throw new Error(`Expected the physics and predictor Workers to start, attached: ${JSON.stringify([...page.workers.values()])}`);
	}
	// The worker must be producing physics updates
	await page.waitFor(() => window.universe.objects[0] && Number.isFinite(window.universe.currentSubSteps) && window.universe.currentSubSteps > 0,
		{ timeoutMs: 15000, description: 'first physics update from the Worker' });
}

/**
 * Wait for a browser download to finish and return its absolute file path.
 * @param {any} env
 * @param {() => Promise<void>} trigger action that starts the download
 * @param {number} [timeoutMs]
 * @returns {Promise<{ filePath: string, suggestedFilename: string }>}
 */
export async function captureDownload(env, trigger, timeoutMs = 15000) {
	const begin = env.conn.waitForEvent('Browser.downloadWillBegin', { timeoutMs });
	await trigger();
	const info = await begin;
	await env.conn.waitForEvent('Browser.downloadProgress', {
		predicate: (p) => p.guid === info.guid && (p.state === 'completed' || p.state === 'canceled'),
		timeoutMs
	}).then((p) => {
		if (p.state !== 'completed') { throw new Error(`Download ${info.suggestedFilename} was canceled`); }
	});
	return { filePath: path.join(env.downloadDir, info.guid), suggestedFilename: info.suggestedFilename };
}

/**
 * Choose `filePath` in the file chooser opened by clicking `selector` (real "Load State" path).
 * @param {any} env
 * @param {string} selector
 * @param {string} filePath
 */
export async function chooseFileViaClick(env, selector, filePath) {
	const page = env.page;
	await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
	try {
		const opened = page.waitForEvent('Page.fileChooserOpened', { timeoutMs: 10000 });
		await page.click(selector);
		const chooser = await opened;
		await page.send('DOM.setFileInputFiles', { files: [filePath], backendNodeId: chooser.backendNodeId });
	} finally {
		await page.send('Page.setInterceptFileChooserDialog', { enabled: false });
	}
}

/**
 * Write a scratch file (e.g. an invalid save) inside a fresh temp directory and return its path.
 * @param {string} name
 * @param {string} content
 * @returns {{ filePath: string, cleanup: () => void }}
 */
export function writeTempFile(name, content) {
	const tmp = makeTempDir('gravsim-e2e-file-');
	const filePath = path.join(tmp.dir, name);
	fs.writeFileSync(filePath, content);
	return { filePath, cleanup: tmp.remove };
}

/* ------------------------------------------------------------------------------------------------
 * GravSim UI helpers (shared by the system tests)
 * ---------------------------------------------------------------------------------------------- */

/** End reasons a prediction may report (design §4.3 table). */
export const PREDICTION_END_REASONS = ['horizon', 'impact', 'breakup', 'point_budget', 'step_budget', 'no_host'];
/** TRAJECTORY_PREDICTION.MAX_POINTS (design §4.3, guarantee 2). */
export const MAX_PREDICTION_POINTS = 3000;
/** Test threshold for the drawn angle step (design §4.3, guarantee 1). */
export const MAX_DRAWN_ANGLE_STEP_RAD = 0.15;
/** Seconds per month used by the prediction-duration slider (months * 365.25 / 12 days). */
export const SECONDS_PER_MONTH = (365.25 / 12) * 86400;

/**
 * Click a sidebar tab button ('tab-sys' | 'tab-deploy' | 'tab-rocket' | 'tab-navi') and wait until
 * its panel is the active one.
 * @param {PageSession} page
 * @param {string} target
 */
export async function clickTab(page, target) {
	await page.click(`.tab-btn[data-target="${target}"]`);
	await page.waitFor((t) => document.getElementById(t)?.classList.contains('active')
		&& document.querySelector(`.tab-btn[data-target="${t}"]`)?.classList.contains('active'),
	{ args: [target], description: `tab ${target} to become active` });
}

/**
 * Deploy a planet from the Deploy tab by clicking its button; resolves with the new object's id.
 * @param {PageSession} page
 * @param {string} buttonId e.g. 'put-earth-btn'
 * @param {string} objectName e.g. 'Earth'
 */
export async function deployBody(page, buttonId, objectName) {
	await clickTab(page, 'tab-deploy');
	const before = await page.evaluate((name) => window.universe.objects.filter((o) => o.name === name).length, objectName);
	await page.click(`#${buttonId}`);
	return page.waitFor((name, n) => {
		const list = window.universe.objects.filter((o) => o.name === name);
		return list.length === n + 1 ? list[list.length - 1].id + 1 : false; // +1 keeps id 0 truthy
	}, { args: [objectName, before], description: `${objectName} to be deployed` }).then((idPlusOne) => idPlusOne - 1);
}

/** Current trajectory-predictor request id (incremented each time a Worker request is issued). */
export function predictorRequestId(page) {
	return page.evaluate(() => window.universe.RocketLauncher.predictor._requestId);
}

/**
 * Wait until a Worker prediction requested after `sinceRequestId` has been delivered and adopted as
 * the launcher's current prediction (no request in flight, none queued), and no further request
 * appears during a quiet window (250 ms) longer than the launcher's 150 ms preview debounce.
 * @param {PageSession} page
 * @param {number} sinceRequestId
 * @param {number} [timeoutMs]
 * @returns {Promise<number>} the settled request id
 */
export async function waitPredictionSettled(page, sinceRequestId, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	const settledId = () => page.waitFor((r0) => {
		const rl = window.universe.RocketLauncher;
		const pr = rl.predictor;
		const ok = pr._requestId > r0 && !pr._isBusy && !pr._nextPendingRequest
			&& pr._latestProcessedId === pr._requestId && rl.currentPrediction === pr.prediction;
		return ok ? pr._requestId : false;
	}, { args: [sinceRequestId], timeoutMs: Math.max(1000, deadline - Date.now()), intervalMs: 25, description: `Worker prediction newer than request #${sinceRequestId}` });
	for (;;) {
		const id = await settledId();
		await sleep(250);
		const again = await settledId();
		if (again === id) { return id; }
		if (Date.now() > deadline) {
			throw new Error(`Prediction requests kept coming after #${sinceRequestId} (last #${again})`);
		}
	}
}

/**
 * Summarize the launcher's current prediction in the page: counts, end reason, time monotonicity,
 * finiteness, the drawn-frame angle steps (design §4.3 guarantee 1, measured in the frame of §4.10:
 * surface-fixed `phiSurf` up to `frameSwitchTime`, host-centred inertial `atan2(relY, relX)` minus
 * `frameSwitchHostRot` after it; the constant frame reference rotation cancels out of differences)
 * and the drawn rotation after the frame switch (guarantee 3).
 * @param {PageSession} page
 */
export function predictionSummary(page) {
	return page.evaluate(() => {
		const rl = window.universe.RocketLauncher;
		const pred = rl.currentPrediction;
		if (!pred) { return null; }
		const pts = Array.isArray(pred.points) ? pred.points : [];
		const wrap = (a) => {
			let d = a;
			while (d > Math.PI) { d -= 2 * Math.PI; }
			while (d < -Math.PI) { d += 2 * Math.PI; }
			return d;
		};
		const fs = Number.isFinite(pred.frameSwitchTime) ? pred.frameSwitchTime : Infinity;
		const fsRot = pred.frameSwitchHostRot || 0;
		const drawnAngle = (p) => {
			if (p.r !== undefined && p.phiSurf !== undefined) {
				return (p.time > fs) ? Math.atan2(p.relY, p.relX) - fsRot : p.phiSurf;
			}
			return Math.atan2(p.relY, p.relX);
		};
		let strictlyIncreasing = true;
		let allFinite = true;
		let maxDrawnStep = 0;
		let rotationAfterSwitch = 0;
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i];
			if (![p.time, p.relX, p.relY].every(Number.isFinite)) { allFinite = false; }
			if (p.r !== undefined && !Number.isFinite(p.r)) { allFinite = false; }
			if (i > 0) {
				const q = pts[i - 1];
				if (!(p.time > q.time)) { strictlyIncreasing = false; }
				maxDrawnStep = Math.max(maxDrawnStep, Math.abs(wrap(drawnAngle(p) - drawnAngle(q))));
				if (q.time >= fs) {
					rotationAfterSwitch += wrap(Math.atan2(p.relY, p.relX) - Math.atan2(q.relY, q.relX));
				}
			}
		}
		return {
			points: pts.length,
			endReason: pred.endReason,
			maxSimTime: pred.maxSimTime,
			lastTime: pts.length > 0 ? pts[pts.length - 1].time : null,
			requestedSec: rl.maxSimTimeSec,
			hostId: pred.hostId,
			launcherHostId: rl.hostId,
			frameSwitchTime: Number.isFinite(pred.frameSwitchTime) ? pred.frameSwitchTime : null,
			hasPhiSurf: pts.length > 0 && pts.every((p) => p.phiSurf !== undefined),
			strictlyIncreasing,
			allFinite,
			maxDrawnStep,
			revolutionsAfterSwitch: Math.abs(rotationAfterSwitch) / (2 * Math.PI),
			eventCount: Array.isArray(pred.events) ? pred.events.length : 0,
			impactEvents: Array.isArray(pred.events) ? pred.events.filter((e) => e.id === 'impact').length : 0
		};
	});
}

/**
 * Read the flight-profile table as rendered: one entry per row with each cell's element.
 * @param {PageSession} page
 */
export function readProfileTable(page) {
	return page.evaluate(() => [...document.querySelectorAll('#rl-flight-profile-body > tr')].map((tr) => ({
		cellCount: tr.children.length,
		cells: [...tr.children].map((td) => {
			const el = td.firstElementChild;
			return el ? {
				tag: el.tagName.toLowerCase(),
				type: el.getAttribute('type'),
				className: el.className,
				value: el.value,
				text: el.textContent,
				disabled: Boolean(el.disabled),
				childCount: td.children.length,
				options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, label: o.textContent })) : null
			} : null;
		})
	})));
}

/**
 * Move a range input to `target` with the keyboard (ArrowLeft/ArrowRight from its current value),
 * the same input path a user has; returns the final value.
 * @param {PageSession} page
 * @param {string} selector
 * @param {number} target
 */
export async function setRangeByKeys(page, selector, target) {
	await page.focus(selector);
	const { value, step } = await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		return { value: Number(el.value), step: Number(el.step) || 1 };
	}, selector);
	const presses = Math.round((target - value) / step);
	for (let i = 0; i < Math.abs(presses); i++) {
		await page.pressKey(presses > 0 ? 'ArrowRight' : 'ArrowLeft');
	}
	return page.evaluate((sel) => Number(document.querySelector(sel).value), selector);
}

/**
 * Snapshot of the first live rocket (main-thread object synchronized from the Worker).
 * @param {PageSession} page
 */
export function rocketSnapshot(page) {
	return page.evaluate(() => {
		const r = window.universe.objects.find((o) => o.type === 1 && o.state === 0);
		if (!r) { return null; }
		const tm = r.telemetry || {};
		return {
			id: r.id,
			x: r.x,
			y: r.y,
			flightTime: tm.flightTime,
			altM: tm.altM,
			vV: tm.vV,
			vH: tm.vH,
			mach: r.mach,
			tmMach: tm.mach,
			stageIndex: r.currentStageIndex,
			totalStages: r.totalStages,
			stageState: r.stageState,
			isHoldDown: Boolean(r.isHoldDown),
			isPayloadSeparated: Boolean(r.isPayloadSeparated),
			fuelMass: r.fuelMass,
			oxidMass: r.oxidMass,
			restoredRuntimeState: r.restoredRuntimeState === true,
			hasRuntimeState: Boolean(r.runtimeState)
		};
	});
}

/**
 * Assert-friendly list of problems (exceptions / console errors / log errors) since `mark`, minus
 * entries matching one of `allowed` regular expressions.
 * @param {PageSession} page
 * @param {ReturnType<PageSession['mark']>} mark
 * @param {RegExp[]} [allowed]
 */
export function unexpectedProblems(page, mark, allowed = []) {
	return page.problemsSince(mark).filter((p) => !allowed.some((re) => re.test(p)));
}
