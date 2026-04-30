/**
 * Host-side container config for the \`opencode\` provider.
 *
 * OpenCode looks up provider credentials in \`auth.json\` under XDG_DATA_HOME.
 * We write a per-session auth.json with the API key for the configured
 * OPENCODE_PROVIDER (e.g. deepseek), then mount the directory into the
 * container. OpenCode then uses its built-in provider preset (which knows
 * the right baseURL, model formats, etc.) — no manual override needed.
 *
 * NO_PROXY / no_proxy are merged with host values so the in-container
 * OpenCode SDK can talk to the local 'opencode serve' on 127.0.0.1 even
 * when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  const opencodeAuthDir = path.join(opencodeDir, 'opencode');
  fs.mkdirSync(opencodeAuthDir, { recursive: true });

  // Write auth.json with the API key for the configured provider.
  // OpenCode's built-in preset for that provider reads this file at startup.
  const provider = ctx.hostEnv.OPENCODE_PROVIDER;
  const apiKey = ctx.hostEnv.DEEPSEEK_API_KEY || ctx.hostEnv.OPENAI_API_KEY;
  if (provider && apiKey) {
    const authPath = path.join(opencodeAuthDir, 'auth.json');
    fs.writeFileSync(
      authPath,
      JSON.stringify({ [provider]: { type: 'api', key: apiKey } }, null, 2) + '\n',
    );
    fs.chmodSync(authPath, 0o600);
  }

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  for (const key of ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
