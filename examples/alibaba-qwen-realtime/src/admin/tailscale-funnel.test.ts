import assert from 'node:assert/strict';
import test from 'node:test';
import { TailscaleFunnelManager } from './tailscale-funnel.ts';
import type { TailscaleCommandRunner } from './tailscale-funnel.ts';

test('Tailscale Funnel publishes the administration origin and stops on exit', async () => {
    const calls: { command: string; args: string[]; timeoutMs: number }[] = [];
    const runner: TailscaleCommandRunner = async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs });
        if (args[0] === 'status') {
            return JSON.stringify({ Self: { DNSName: 'voice-node.example.ts.net.' } });
        }
        return '';
    };
    const manager = new TailscaleFunnelManager({}, runner);

    const publicBaseUrl = await manager.getPublicBaseUrl();
    assert.equal(publicBaseUrl, 'https://voice-node.example.ts.net');
    const handle = await manager.start('http://127.0.0.1:8787');

    assert.equal(handle.publicBaseUrl, publicBaseUrl);
    assert.equal(handle.callbackUrl, `${publicBaseUrl}/api/mcp/oauth/callback`);
    assert.equal(handle.localOrigin, 'http://127.0.0.1:8787');

    await manager.stop();
    assert.deepEqual(calls.map((call) => call.args), [
        ['status', '--json'],
        ['funnel', '--bg', '--yes', '--https=443', 'http://127.0.0.1:8787'],
        ['funnel', '--bg', '--yes', '--https=443', 'off'],
    ]);
});

test('Tailscale Funnel validates an explicit public origin', async () => {
    const manager = new TailscaleFunnelManager({
        publicBaseUrl: 'https://admin.example.com',
    }, async () => '');
    await assert.rejects(manager.getPublicBaseUrl(), /\*\.ts\.net/);
});

test('Tailscale Funnel only accepts a loopback HTTP origin', async () => {
    const manager = new TailscaleFunnelManager({
        publicBaseUrl: 'https://voice-node.example.ts.net',
    }, async () => '');
    await assert.rejects(manager.start('http://0.0.0.0:8787'), /127\.0\.0\.1/);
    await assert.rejects(manager.start('https://127.0.0.1:8787'), /127\.0\.0\.1/);
});
