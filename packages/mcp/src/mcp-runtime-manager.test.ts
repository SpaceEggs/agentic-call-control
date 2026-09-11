import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { McpRuntimeManager } from './mcp-runtime-manager.ts';
import { CustomMcpConnection, McpAuthorizationRequiredError } from './custom-mcp-client.ts';

test('disabled MCP servers do not expose tools or open connections', async () => {
    const manager = new McpRuntimeManager([{
        id: 'disabled',
        name: 'Disabled',
        url: 'https://example.test/mcp',
        enabled: false,
        auth: { type: 'none' },
    }]);
    await manager.initialize();
    assert.equal(manager.getStates()[0]?.status, 'disabled');
    const lease = manager.acquire();
    assert.equal(lease.router, undefined);
    assert.deepEqual(lease.toolDefs, []);
    lease.release();
    manager.close();
});

test('mcp-remote OAuth deauthorization clears its local credential cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-remote-test-'));
    const cache = join(root, 'cache');
    mkdirSync(join(cache, 'nested'), { recursive: true });
    writeFileSync(join(cache, 'nested', 'tokens.json'), '{}');
    const connection = new CustomMcpConnection({
        id: 'remote-oauth',
        name: 'Remote OAuth',
        url: 'https://example.test/mcp',
        transport: 'mcp-remote',
        mcpRemote: { configDir: cache },
        auth: { type: 'oauth' },
    });
    await connection.deauthorize();
    assert.equal(existsSync(cache), false);
});

test('mcp-remote OAuth exposes a browser authorization URL with the public callback', async () => {
    const server = createServer((request, response) => {
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.startsWith('/.well-known/oauth-protected-resource')) {
            response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
            return;
        }
        if (request.url?.startsWith('/.well-known/oauth-authorization-server')) {
            response.end(JSON.stringify({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                registration_endpoint: `${origin}/register`,
                response_types_supported: ['code'],
                code_challenge_methods_supported: ['S256'],
            }));
            return;
        }
        if (request.url === '/register') {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { redirect_uris: string[] };
                response.end(JSON.stringify({ ...metadata, client_id: 'test-client' }));
            });
            return;
        }
        response.statusCode = 401;
        response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
        response.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const publicCallback = 'https://admin.example.test/api/mcp/oauth/callback';
    const connection = new CustomMcpConnection({
        id: 'remote-browser-oauth',
        name: 'Remote Browser OAuth',
        url: `${origin}/mcp`,
        transport: 'mcp-remote',
        mcpRemote: { configDir: mkdtempSync(join(tmpdir(), 'mcp-remote-oauth-')) },
        auth: { type: 'oauth', redirectUrl: publicCallback },
    });
    try {
        await assert.rejects(connection.connect({ deferOAuth: true }), (error: unknown) => {
            assert.ok(error instanceof McpAuthorizationRequiredError);
            assert.equal(new URL(error.authorizationUrl).searchParams.get('redirect_uri'), publicCallback);
            return true;
        });
    } finally {
        connection.disconnect();
        await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    }
});

test('deauthorized disabled servers stay disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-deauthorize-test-'));
    const manager = new McpRuntimeManager([{
        id: 'oauth',
        name: 'OAuth',
        url: 'https://example.test/mcp',
        enabled: false,
        auth: { type: 'oauth', tokenFile: join(root, 'oauth.json') },
    }]);
    await manager.initialize();
    await manager.deauthorize('oauth');
    assert.equal(manager.getStates()[0]?.status, 'disabled');
    manager.close();
});
