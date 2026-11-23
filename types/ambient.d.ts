interface Window {
	presetManager?: any;
	universe?: any;
	webkitAudioContext?: typeof AudioContext;
}

declare var process: {
	readonly versions?: { node?: string };
	readonly argv?: string[];
	cwd?(): string;
	getBuiltinModule?(name: string): any;
};
