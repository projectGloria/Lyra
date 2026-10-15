const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup() {
	const classes = new Set();
	const classList = {
		add: (name) => classes.add(name),
		remove: (name) => classes.delete(name),
		contains: (name) => classes.has(name),
	};
	const events = {};
	const documentEvents = {};
	const audio = {
		paused: false,
		muted: false,
		volume: 1,
		addEventListener: (name, fn) => {
			events[name] = fn;
		},
	};
	const canvas = { classList, parentElement: null, addEventListener() {} };
	const appShell = { appendChild: (element) => { element.parentElement = appShell; } };
	const fullscreenBackdrop = { appendChild: (element) => { element.parentElement = fullscreenBackdrop; } };
	const connections = [];
	let sources = 0,
		frames = 0;
	class AudioContext {
		state = "running";
		destination = {};
		sampleRate = 48000;
		resume() {
			return Promise.resolve();
		}
		createAnalyser() {
			return { frequencyBinCount: 1024 };
		}
		createMediaElementSource() {
			sources++;
			return { connect: (target) => connections.push(target) };
		}
	}
	const document = {
		hidden: false,
		body: { classList },
		addEventListener(name, fn) {
			documentEvents[name] = fn;
		},
		getElementById: (id) => id === "appShell" ? appShell : null,
		querySelector: (selector) => selector === ".fullscreen-backdrop" ? fullscreenBackdrop : null,
	};
	const sandbox = {
		window: { AudioContext },
		document,
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: () => ++frames,
		cancelAnimationFrame() {},
		console,
		Uint8Array,
	};
	vm.runInNewContext(
		fs.readFileSync(path.join(__dirname, "../src/ink-background.js"), "utf8") +
			"\nthis.Ink = LyraInkBackground;",
		sandbox,
	);
	const ink = new sandbox.Ink(audio, canvas, (error) => {
		throw new Error(error);
	});
	ink.initGraphics = () => {
		ink.gl = {};
	};
	return {
		ink,
		audio,
		document,
		documentEvents,
		classes,
		canvas,
		appShell,
		fullscreenBackdrop,
		events,
		connections,
		sources: () => sources,
	};
}

test("ink background follows app and fullscreen surfaces and remains visible in the app shell", () => {
	const app = setup();
	app.ink.setEnabled(true, "#c9a94a");
	assert.equal(app.canvas.parentElement, app.appShell);
	app.document.body.classList.add("fullscreen-player-open");
	app.ink.setEnabled(true, "#c9a94a");
	assert.equal(app.canvas.parentElement, app.fullscreenBackdrop);
	app.document.body.classList.remove("fullscreen-player-open");
	app.ink.setEnabled(true, "#c9a94a");
	assert.equal(app.canvas.parentElement, app.appShell);
	const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
	assert.match(css, /\.app-shell > \.ink-background\.visible\s*\{[^}]*display:\s*block[^}]*z-index:\s*-1/s);
	assert.match(css, /body\.ink-active \.app-shell:not\(\.has-background\)\s*\{\s*background:\s*transparent/s);
});

test("disabled ink never creates an audio route; toggling reuses a single audible route", async () => {
	const app = setup();
	await app.ink.start();
	assert.equal(app.sources(), 0);
	app.ink.enabled = true;
	await app.ink.start();
	assert.equal(app.sources(), 1);
	assert.equal(app.connections[0], app.ink.context.destination);
	app.ink.setEnabled(false);
	assert.equal(app.ink.frame, 0);
	assert.equal(app.ink.context.state, "running");
	assert.equal(app.connections.length, 2);
	app.ink.enabled = true;
	await app.ink.start();
	assert.equal(app.sources(), 1);
	app.audio.paused = true;
	app.events.pause();
	assert.equal(app.ink.frame, 0);
	assert.ok(!app.classes.has("ink-active"));
});

test("disabling during audio initialization cannot restart the background", async () => {
	const app = setup();
	let resume;
	app.ink.prepareAudio = () =>
		new Promise((resolve) => {
			resume = resolve;
		});
	app.ink.enabled = true;
	const starting = app.ink.start();
	app.ink.setEnabled(false);
	resume(true);
	await starting;
	assert.equal(app.ink.frame, 0);
	assert.ok(!app.classes.has("ink-active"));
});

test("hidden windows do not start rendering or initialize audio", async () => {
	const app = setup();
	app.document.hidden = true;
	app.ink.enabled = true;
	await app.ink.start();
	assert.equal(app.sources(), 0);
	assert.equal(app.ink.frame, 0);
});

test("a pointer gesture primes analysis before playback and retries a policy rejection", async () => {
	const app = setup();
	let attempts = 0;
	app.ink.enabled = true;
	app.ink.prepareAudio = () => {
		attempts++;
		if (attempts === 1)
			return Promise.reject(
				Object.assign(new Error("gesture required"), {
					name: "NotAllowedError",
				}),
			);
		return Promise.resolve(true);
	};

	app.documentEvents.pointerdown();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(app.ink.failed, undefined);
	assert.equal(attempts, 1);

	app.documentEvents.pointerdown();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(attempts, 2);
	assert.ok(app.ink.frame > 0);
});

test("ink shader uses directional advection instead of audio zoom", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "../src/ink-background.js"),
		"utf8",
	);
	assert.match(source, /uniform vec2 flow;/);
	assert.match(source, /uniform2fv\(u\.flow, this\.flow\)/);
	assert.match(source, /targetSpeed = \.05 \+ this\.energy\[0\] \* \.42/);
	assert.doesNotMatch(source, /p\s*\/=\s*1\.\+beat/);
	assert.doesNotMatch(source, /uniform float beat;/);
	assert.doesNotMatch(source, /beat\s*\*\s*\.55/);
});

test("existing media source route resumes suspended AudioContext even when visual is disabled", async () => {
	const app = setup();
	app.ink.setEnabled(true, "#c9a94a");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(app.sources(), 1);
	app.ink.setEnabled(false, "#c9a94a");

	let resumed = 0;
	app.ink.context.state = "suspended";
	app.ink.context.resume = () => {
		resumed++;
		app.ink.context.state = "running";
		return Promise.resolve();
	};

	app.events.play();
	assert.equal(resumed, 1);

	app.ink.context.state = "suspended";
	app.documentEvents.pointerdown();
	assert.equal(resumed, 2);
});
