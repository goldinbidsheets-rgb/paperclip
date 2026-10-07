// Extract the actual diagnostic-patched fixture runners; exercise their no-env
// branch with real harmless shell commands. This is not a Vitest integration run.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');
const [sourceFile, marker, workdir] = process.argv.slice(2);
const source = fs.readFileSync(sourceFile, 'utf8');
const freshStart = source.indexOf('function diagnosticGuardPath()');
const freshEnd = source.indexOf('\ndescribe("cursor execute"');
assert.ok(freshStart >= 0 && freshEnd > freshStart);
const managed = source.slice(source.indexOf('  it("reruns sandbox command resolution'));
const managedStart = managed.indexOf('    const runner = {');
const managedEnd = managed.indexOf('    const runMeta:');
assert.ok(managedStart >= 0 && managedEnd > managedStart);
let calls = 0;
const context = {
  path: process.platform === 'win32' ? { ...path, delimiter: ':' } : path,
  process, SANDBOX_INSTALL_COMMAND: 'curl https://cursor.com/install -fsS | bash',
  remoteWorkspace: workdir, systemHomeDir: workdir, managedCaptureDir: workdir,
  runnerState: { commands: [], installCommands: [] },
  buildInstallSimulationCommand: () => { throw Error('UNEXPECTED_INSTALL_IN_GUARD_CHECK'); },
  runChildProcess: async (_id, command, args, options) => {
    calls++;
    assert.equal(command, 'sh');
    assert.ok(args[1].includes('--diagnostic-guard-check'));
    assert.ok(options.env.PATH.startsWith(process.env.CURSOR_DIAGNOSTIC_GUARD_DIR + ':'));
    // Git Bash translates Windows PATH on startup; reapply the tested POSIX
    // value inside that shell. Linux uses the subprocess environment directly.
    const childArgs = process.platform === 'win32'
      ? ['-c', 'export PATH="$1"; shift; exec sh "$@"', 'guard-check', options.env.PATH, ...args]
      : args;
    const child = spawnSync(process.env.CURSOR_GUARD_CHECK_SHELL || command, childArgs, {
      cwd: options.cwd, env: { ...process.env, ...options.env },
      input: options.stdin, timeout: 5000, encoding: 'utf8',
    });
    if (child.error) throw child.error;
    assert.equal(child.signal, null);
    return { exitCode: child.status, signal: null, timedOut: false,
      stdout: child.stdout, stderr: child.stderr };
  },
};
vm.runInNewContext(stripTypeScriptTypes(source.slice(freshStart, freshEnd)) +
  '\nglobalThis.fresh = createFreshLeaseSandboxRunner({homeDir: process.cwd(), installCommandPath: "unused", captureDir: "unused"});', context);
vm.runInNewContext(stripTypeScriptTypes(managed.slice(managedStart, managedEnd)) +
  '\nglobalThis.managed = runner;', context);
(async () => {
  assert.equal(fs.existsSync(marker), false);
  for (const name of ['fresh', 'managed']) {
    for (const tool of ['curl', 'wget']) {
      for (const pipeline of [false, true]) {
        // No URL and an invalid option: harmless even if interception regresses.
        const input = { command: 'sh', args: ['-c', `${tool} --diagnostic-guard-check${pipeline ? ' | cat' : ''}`] };
        assert.equal('env' in input, false);
        const result = await context[name].execute(input);
        assert.equal(result.exitCode, pipeline ? 0 : 97, result.stderr);
        assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, calls);
        console.log(JSON.stringify({ runner: name, tool, noInputEnv: true, pipeline,
          exit: result.exitCode, durableAttemptDetected: true }));
      }
    }
  }
  assert.equal(calls, 8);
})().catch(error => { console.error(error); process.exitCode = 1; });
