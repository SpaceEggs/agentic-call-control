import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { get } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { McpRuntimeManager } from '@3cx-examples/mcp';
import { AdminServer } from './admin-server.ts';
import { CertificateManager } from './certificate-manager.ts';
import { AdminConfigStore } from './config-store.ts';
import { AdminLogHub } from './log-hub.ts';

async function freePort(): Promise<number> {
    return new Promise((resolvePort, rejectPort) => {
        const server = createNetServer();
        server.once('error', rejectPort);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => resolvePort(port));
        });
    });
}

test('HTTPS admin server serves status without an HTTP fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qwen-admin-server-'));
    const domain = '127.0.0.1';
    const dataDir = join(root, 'lego');
    const certDir = join(dataDir, 'certificates');
    mkdirSync(certDir, { recursive: true });
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=127.0.0.1',
        '-keyout', join(certDir, `${domain}.key`),
        '-out', join(certDir, `${domain}.crt`),
    ], { stdio: 'ignore' });
    const port = await freePort();
    const publicBaseUrl = `https://127.0.0.1:${port}`;
    const certificateManager = new CertificateManager({
        domain,
        email: 'admin@example.test',
        dataDir,
        legoPath: join(root, 'missing-lego'),
    });
    const runtime = new McpRuntimeManager([]);
    await runtime.initialize();
    const server = new AdminServer({
        config: {
            publicBaseUrl,
            host: '127.0.0.1',
            port,
            tls: { domain, email: 'admin@example.test', dataDir },
        },
        configStore: new AdminConfigStore([], join(root, 'state.json'), publicBaseUrl),
        mcpRuntime: runtime,
        certificateManager,
        logHub: new AdminLogHub(join(root, 'runtime.log')),
        getActiveCallCount: () => 0,
    });
    await server.start();
    try {
        const body = await new Promise<string>((resolveBody, rejectBody) => {
            get(`${publicBaseUrl}/api/status`, { rejectUnauthorized: false }, (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
            }).once('error', rejectBody);
        });
        const status = JSON.parse(body) as { activeCalls: number; csrfToken: string };
        assert.equal(status.activeCalls, 0);
        assert.ok(status.csrfToken.length >= 32);
    } finally {
        server.close();
        runtime.close();
    }
});
