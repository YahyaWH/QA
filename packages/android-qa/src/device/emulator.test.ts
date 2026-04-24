import { describe, it, expect } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stopChild } from './emulator';

const execFileAsync = promisify(execFile);

async function pidIsRunning(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
      return stdout.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('stopChild', () => {
  it.runIf(process.platform === 'win32')(
    'kills grandchildren on Windows (via taskkill /T)',
    async () => {
      // Spawn a node process that forks its own long-lived child and prints the
      // grandchild's pid. `child.kill()` on the top-level node would NOT reach
      // the grandchild — only stopChild's `taskkill /T` sweep should.
      const bootstrap = `
        const cp = require('child_process');
        const g = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore', detached: false, windowsHide: true,
        });
        process.stdout.write(String(g.pid) + '\\n');
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['-e', bootstrap], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });

      expect(child.pid).toBeDefined();
      const rootPid = child.pid!;

      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('no pid line from bootstrap')), 5_000);
        let buf = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const m = buf.match(/^(\d+)/);
          if (m) {
            clearTimeout(timeout);
            resolve(Number(m[1]));
          }
        });
      });

      expect(await pidIsRunning(rootPid)).toBe(true);
      expect(await pidIsRunning(grandchildPid)).toBe(true);

      await stopChild(child, `emulator-test:${rootPid}`);

      expect(await pidIsRunning(rootPid), 'root node process should be dead').toBe(false);
      expect(
        await pidIsRunning(grandchildPid),
        'grandchild node process should be dead after stopChild',
      ).toBe(false);
    },
    15_000,
  );
});
