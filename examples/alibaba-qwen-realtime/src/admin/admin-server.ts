import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server as HttpServer,
    type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CustomMcpServerConfig, McpRuntimeManager } from '@3cx-examples/mcp';
import type { AdminConfig } from '../app-config.ts';
import type { AdminMcpServerInput, AdminConfigStore } from './config-store.ts';
import type { AdminLogHub } from './log-hub.ts';
import type { CertificateManager, CertificateStatus } from './certificate-manager.ts';

interface AdminServerDeps {
    config: AdminConfig;
    publicBaseUrl: string;
    configStore: AdminConfigStore;
    mcpRuntime: McpRuntimeManager;
    certificateManager?: CertificateManager;
    logHub: AdminLogHub;
    getActiveCallCount: () => number;
}

export interface AdminServerHandle {
    localOrigin: string;
}

const webRoot = fileURLToPath(new URL('../../web/admin', import.meta.url));
const mimeTypes: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
};

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > 128 * 1024) throw new Error('Request body is too large');
        chunks.push(data);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function urlFingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function publicServer(config: CustomMcpServerConfig, state: ReturnType<McpRuntimeManager['getStates']>[number]) {
    const endpoint = new URL(config.url);
    return {
        id: config.id,
        name: config.name,
        enabled: config.enabled !== false,
        transport: config.transport ?? 'streamable-http',
        authType: config.auth?.type ?? 'none',
        urlDisplay: `${endpoint.origin}/•••`,
        urlFingerprint: urlFingerprint(config.url),
        providerConsoleUrl: config.providerConsoleUrl,
        healthCheck: config.healthCheck,
        status: state,
        upstreamAuthorization: config.name.toLowerCase().includes('zoho')
            ? 'Zoho Authorization via Connection must be managed by a Zoho Super Admin.'
            : undefined,
    };
}

export class AdminServer {
    private readonly csrf = randomBytes(32).toString('hex');
    private readonly expectedUrl: URL;
    private server: HttpServer | HttpsServer | undefined;
    private readonly deps: AdminServerDeps;

    constructor(deps: AdminServerDeps) {
        this.deps = deps;
        this.expectedUrl = new URL(deps.publicBaseUrl);
        if (this.expectedUrl.protocol !== 'https:') throw new Error('admin.publicBaseUrl must use https');
        if (!deps.certificateManager && deps.config.host && deps.config.host !== '127.0.0.1') {
            throw new Error('Tailscale Funnel admin host must be 127.0.0.1');
        }
    }

    async start(): Promise<AdminServerHandle> {
        const handler = (req: IncomingMessage, res: ServerResponse): void => {
            void this.handle(req, res).catch((error) => {
                console.error('[Admin] request failed:', messageOf(error));
                if (!res.headersSent) json(res, 500, { error: messageOf(error) });
                else res.end();
            });
        };
        const certificateManager = this.deps.certificateManager;
        const server = certificateManager
            ? createHttpsServer(certificateManager.tlsOptions(), handler)
            : createHttpServer(handler);
        this.server = server;
        if (certificateManager) certificateManager.attach(server as HttpsServer);
        const host = this.deps.config.host ?? (certificateManager ? '0.0.0.0' : '127.0.0.1');
        const port = this.deps.config.port ?? (certificateManager ? 8443 : 8787);
        await new Promise<void>((resolveReady, rejectReady) => {
            server.once('error', rejectReady);
            server.listen(port, host, () => resolveReady());
        });
        certificateManager?.startScheduler();
        const address = server.address() as AddressInfo;
        const localOrigin = `${certificateManager ? 'https' : 'http'}://127.0.0.1:${address.port}`;
        console.log(`[Admin] dashboard ready at ${this.expectedUrl.origin}`);
        return { localOrigin };
    }

    close(): void {
        this.deps.certificateManager?.stopScheduler();
        this.server?.close();
        this.server = undefined;
    }

    private certificateStatus(): Promise<CertificateStatus> {
        if (this.deps.certificateManager) return this.deps.certificateManager.status();
        return Promise.resolve({
            managedBy: 'tailscale',
            available: true,
            domain: this.expectedUrl.hostname,
            issuer: 'Tailscale Funnel',
            legoAvailable: false,
            credentialsConfigured: false,
            busy: false,
        });
    }

    private headers(res: ServerResponse): void {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.setHeader('Set-Cookie', `admin_csrf=${this.csrf}; Secure; SameSite=Strict; Path=/`);
    }

    private verifyRequest(req: IncomingMessage, mutating = false): void {
        if (req.headers.host !== this.expectedUrl.host) throw new Error('Invalid Host header');
        if (!mutating) return;
        if (req.headers.origin !== this.expectedUrl.origin) throw new Error('Invalid Origin header');
        const cookie = req.headers.cookie ?? '';
        if (!cookie.split(/;\s*/).includes(`admin_csrf=${this.csrf}`)) throw new Error('Missing CSRF cookie');
        if (req.headers['x-csrf-token'] !== this.csrf) throw new Error('Invalid CSRF token');
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        this.headers(res);
        const requestUrl = new URL(req.url ?? '/', this.expectedUrl);
        const path = requestUrl.pathname;

        if (path === '/api/mcp/oauth/callback' && req.method === 'GET') {
            this.verifyRequest(req);
            const error = requestUrl.searchParams.get('error');
            const code = requestUrl.searchParams.get('code');
            const state = requestUrl.searchParams.get('state');
            if (error || !code || !state) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>授权失败</h1><p>OAuth 回调无效。</p>');
                return;
            }
            try {
                const id = await this.deps.mcpRuntime.finishOAuth(code, state);
                const configs = this.deps.configStore.setServerEnabled(id, true);
                await this.deps.mcpRuntime.setConfigs(configs);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>授权完成</h1><p>可以关闭此窗口并返回管理页。</p>');
            } catch (callbackError) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<h1>授权失败</h1><p>${this.escapeHtml(messageOf(callbackError))}</p>`);
            }
            return;
        }

        if (path.startsWith('/api/')) {
            this.verifyRequest(req, req.method !== 'GET');
            await this.handleApi(req, res, requestUrl);
            return;
        }
        this.verifyRequest(req);
        this.serveStatic(path, res);
    }

    private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const path = url.pathname;
        if (req.method === 'GET' && path === '/api/status') {
            json(res, 200, {
                csrfToken: this.csrf,
                activeCalls: this.deps.getActiveCallCount(),
                mcp: this.deps.mcpRuntime.getStates(),
                certificate: await this.certificateStatus(),
            });
            return;
        }
        if (req.method === 'GET' && path === '/api/mcp/servers') {
            const states = new Map(this.deps.mcpRuntime.getStates().map((state) => [state.id, state]));
            json(res, 200, {
                revision: this.deps.configStore.revision,
                servers: this.deps.configStore.getServers().map((config) => publicServer(config, states.get(config.id!)!)),
            });
            return;
        }
        const serverMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)(?:\/(reconnect|test))?$/);
        if (serverMatch && req.method === 'PATCH' && !serverMatch[2]) {
            const body = await readJson(req);
            const configs: AdminMcpServerInput[] = this.deps.configStore.getServers().map((server) => ({
                ...server,
                auth: { type: server.auth?.type ?? 'none' },
            }));
            const index = configs.findIndex((server) => server.id === serverMatch[1]);
            if (index < 0) throw new Error('Unknown MCP server');
            const existing = configs[index];
            const authInput = body.auth as { type?: string; token?: string } | undefined;
            configs[index] = {
                ...existing,
                name: typeof body.name === 'string' ? body.name : existing.name,
                url: typeof body.url === 'string' && body.url.trim() ? body.url : existing.url,
                enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
                transport: body.transport === 'mcp-remote' ? 'mcp-remote' : 'streamable-http',
                auth: {
                    type: (authInput?.type ?? existing.auth?.type ?? 'none') as 'none' | 'oauth' | 'bearer',
                    ...(authInput?.token ? { token: authInput.token } : {}),
                },
            };
            const saved = this.deps.configStore.saveServers(
                configs,
                Number(body.revision),
            );
            await this.deps.mcpRuntime.setConfigs(saved);
            json(res, 200, { revision: this.deps.configStore.revision });
            return;
        }
        if (serverMatch && req.method === 'POST' && serverMatch[2] === 'reconnect') {
            await this.deps.mcpRuntime.reconnect(serverMatch[1]);
            json(res, 200, { ok: true });
            return;
        }
        if (serverMatch && req.method === 'POST' && serverMatch[2] === 'test') {
            const result = await this.deps.mcpRuntime.test(serverMatch[1]);
            json(res, 200, { ok: true, result: result.slice(0, 500) });
            return;
        }
        if (req.method === 'POST' && path === '/api/mcp/oauth/authorize') {
            const body = await readJson(req);
            const id = String(body.id ?? '');
            const result = await this.deps.mcpRuntime.beginOAuth(id);
            if ('alreadyAuthorized' in result) {
                const configs = this.deps.configStore.setServerEnabled(id, true);
                await this.deps.mcpRuntime.setConfigs(configs);
            }
            json(res, 200, result);
            return;
        }
        if (req.method === 'POST' && path === '/api/mcp/oauth/deauthorize') {
            const body = await readJson(req);
            const id = String(body.id ?? '');
            const configs = this.deps.configStore.setServerEnabled(id, false);
            await this.deps.mcpRuntime.setConfigs(configs);
            const result = await this.deps.mcpRuntime.deauthorize(id);
            json(res, 200, { ok: true, ...result });
            return;
        }
        if (req.method === 'GET' && path === '/api/logs/runtime') {
            json(res, 200, { entries: this.deps.logHub.list(Number(url.searchParams.get('after') ?? 0)) });
            return;
        }
        if (req.method === 'GET' && path === '/api/logs/calls') {
            const root = resolve('logs');
            const files = existsSync(root)
                ? readdirSync(root).filter((name) => name.endsWith('.log')).map((name) => {
                    const stat = statSync(join(root, name));
                    return { name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
                }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
                : [];
            json(res, 200, { files });
            return;
        }
        if (req.method === 'GET' && path.startsWith('/api/logs/calls/')) {
            const name = decodeURIComponent(path.slice('/api/logs/calls/'.length));
            if (basename(name) !== name || !name.endsWith('.log')) throw new Error('Invalid log file');
            const file = resolve('logs', name);
            if (!existsSync(file)) { json(res, 404, { error: 'Log not found' }); return; }
            const stat = statSync(file);
            if (stat.size > 10 * 1024 * 1024) throw new Error('Log is larger than 10 MB');
            json(res, 200, { name, content: readFileSync(file, 'utf8') });
            return;
        }
        if (req.method === 'GET' && path === '/api/certificates/status') {
            json(res, 200, await this.certificateStatus());
            return;
        }
        if (req.method === 'POST' && path === '/api/certificates/issue') {
            if (!this.deps.certificateManager) {
                json(res, 409, { error: 'HTTPS is managed by Tailscale Funnel' });
                return;
            }
            const body = await readJson(req);
            const output = await this.deps.certificateManager.issue(body.environment === 'staging');
            json(res, 200, { ok: true, output: output.slice(-4_000) });
            return;
        }
        if (req.method === 'POST' && path === '/api/certificates/renew') {
            if (!this.deps.certificateManager) {
                json(res, 409, { error: 'HTTPS is managed by Tailscale Funnel' });
                return;
            }
            const output = await this.deps.certificateManager.renew();
            json(res, 200, { ok: true, output: output.slice(-4_000) });
            return;
        }
        if (req.method === 'GET' && path === '/api/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                Connection: 'keep-alive',
            });
            const send = (event: string, data: unknown): void => {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };
            send('ready', { ok: true });
            const onLog = (entry: unknown) => send('log', entry);
            const onMcp = (states: unknown) => send('mcp', states);
            const onCert = () => void this.certificateStatus().then((status) => send('certificate', status));
            this.deps.logHub.on('entry', onLog);
            this.deps.mcpRuntime.on('changed', onMcp);
            this.deps.certificateManager?.on('changed', onCert);
            req.once('close', () => {
                this.deps.logHub.off('entry', onLog);
                this.deps.mcpRuntime.off('changed', onMcp);
                this.deps.certificateManager?.off('changed', onCert);
            });
            return;
        }
        json(res, 404, { error: 'Not found' });
    }

    private serveStatic(path: string, res: ServerResponse): void {
        const requested = path === '/' ? 'index.html' : path.slice(1);
        const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
        let file = join(webRoot, safe);
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html');
        res.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream' });
        createReadStream(file).pipe(res);
    }

    private escapeHtml(value: string): string {
        return value.replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[char]!);
    }
}
