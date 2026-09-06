#!/usr/bin/env node
/**
 * GravSim Unified Test Suite CLI Runner
 * Executes regression and unit test suites with formatted console output.
 * 
 * Usage:
 *   node testsuites/run_all.mjs                     # Run all tests (regressions + unit)
 *   node testsuites/run_all.mjs --regressions       # Run only regression tests
 *   node testsuites/run_all.mjs --unit              # Run only unit tests
 *   node testsuites/run_all.mjs --coverage          # Run all tests with code coverage
 *   node testsuites/run_all.mjs --verbose           # Run with detailed debug output
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const isCoverage = process.argv.includes('--coverage');
const isVerbose = process.argv.includes('--verbose') || process.env.DEBUG === '1';
const onlyRegressions = process.argv.includes('--regressions');
const onlyUnit = process.argv.includes('--unit');
const onlyIntegration = process.argv.includes('--integration');
const onlySystem = process.argv.includes('--system');

const regressionsDir = path.join(__dirname, 'regressions');
const unitDir = path.join(__dirname, 'unit');
const integrationDir = path.join(__dirname, 'integration');
const systemDir = path.join(__dirname, 'system');

const collectTestFiles = (dir, relativePrefix) => {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter(f => f.endsWith('.test.mjs'))
		.sort()
		.map(f => path.join(relativePrefix, f).replace(/\\/g, '/'));
};

let testFiles = [];

if (onlyRegressions) {
	testFiles = collectTestFiles(regressionsDir, 'testsuites/regressions');
} else if (onlyUnit) {
	testFiles = collectTestFiles(unitDir, 'testsuites/unit');
} else if (onlyIntegration) {
	testFiles = collectTestFiles(integrationDir, 'testsuites/integration');
} else if (onlySystem) {
	testFiles = collectTestFiles(systemDir, 'testsuites/system');
} else {
	testFiles = [
		...collectTestFiles(regressionsDir, 'testsuites/regressions'),
		...collectTestFiles(unitDir, 'testsuites/unit'),
		...collectTestFiles(integrationDir, 'testsuites/integration'),
		...collectTestFiles(systemDir, 'testsuites/system')
	];
}

const targetDesc = onlyRegressions ? 'Regressions Only' :
	(onlyUnit ? 'Unit Tests Only' :
	(onlyIntegration ? 'Integration Tests Only' :
	(onlySystem ? 'System Tests Only' : 'Full Suite (Regressions + Unit + Integration + System)')));

console.log('===============================================================');
console.log('       GravSim Unified Automated Verification Test Suite       ');
console.log('===============================================================');
console.log(`Target:    ${targetDesc}`);
console.log(`Mode:      ${isCoverage ? 'Coverage Analysis' : (isVerbose ? 'Verbose Debug' : 'Standard Execution')}`);
console.log(`Suites:    ${testFiles.length} files targeted`);
console.log(`Directory: ${projectRoot}`);
console.log('---------------------------------------------------------------\n');

const nodeArgs = ['--test'];

if (isCoverage) {
	nodeArgs.push('--experimental-test-coverage');
	nodeArgs.push('--test-coverage-exclude=testsuites/**');
}

nodeArgs.push(...testFiles);

const env = { ...process.env };
if (isVerbose) {
	env.DEBUG = '1';
}

const child = spawn('node', nodeArgs, {
	cwd: projectRoot,
	stdio: 'inherit',
	env
});

child.on('close', (code) => {
	console.log('\n---------------------------------------------------------------');
	if (code === 0) {
		console.log(' [SUCCESS] All GravSim automated test suites passed successfully! ');
	} else {
		console.log(` [FAILED] Test suite exited with error code: ${code} `);
	}
	console.log('===============================================================\n');
	process.exit(code ?? 1);
});
