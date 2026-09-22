import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { buildHookConfig, install, isInstalled, uninstall } from '../src/install.js';

const cwd = mkdtempSync(join(tmpdir(), 'boltmem-install-'));
after(() => rmSync(cwd, { recursive: true, force: true }));

const settingsFile = join(cwd, '.claude', 'settings.json');

function readSettings(): { hooks?: Record<string, { hooks: { command: string }[] }[]>; env?: unknown } {
  return JSON.parse(readFileSync(settingsFile, 'utf8')) as never;
}

describe('hook installation', () => {
  it('adds its hooks while leaving existing settings alone', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        env: { FOO: 'bar' },
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo someone-elses-hook' }] }],
        },
      }),
      'utf8',
    );

    install('project', cwd, '/opt/boltmem/dist/cli.js');
    const settings = readSettings();

    assert.deepEqual(settings.env, { FOO: 'bar' });
    const sessionStart = settings.hooks?.SessionStart ?? [];
    assert.ok(sessionStart.some((entry) => entry.hooks.some((hook) => hook.command.includes('someone-elses-hook'))));
    assert.ok(sessionStart.some((entry) => entry.hooks.some((hook) => hook.command.includes('boltmem-hook'))));
    const template = buildHookConfig('/x').SessionStart?.[0];
    assert.deepEqual(Object.keys(template ?? {}).sort(), ['hooks', 'matcher']);
    assert.ok(isInstalled('project', cwd));
  });

  it('is idempotent', () => {
    install('project', cwd, '/opt/boltmem/dist/cli.js');
    install('project', cwd, '/opt/boltmem/dist/cli.js');
    const commands = (readSettings().hooks?.SessionStart ?? []).flatMap((entry) =>
      entry.hooks.filter((hook) => hook.command.includes('boltmem-hook')),
    );
    assert.equal(commands.length, 1);
  });

  it('removes only its own hooks on uninstall', () => {
    const result = uninstall('project', cwd);
    assert.equal(result.removed, 4);

    const settings = readSettings();
    assert.deepEqual(settings.env, { FOO: 'bar' });
    const sessionStart = settings.hooks?.SessionStart ?? [];
    assert.ok(sessionStart.some((entry) => entry.hooks.some((hook) => hook.command.includes('someone-elses-hook'))));
    assert.ok(!isInstalled('project', cwd));
  });

  it('refuses to touch a settings file that is not valid JSON', () => {
    writeFileSync(settingsFile, '{ this is not json', 'utf8');
    assert.throws(() => install('project', cwd), /not valid JSON/);
  });
});
