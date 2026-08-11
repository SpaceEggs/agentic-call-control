/**
 * Optional extra MCP servers (beyond the built-in 3CX `{pbxBase}/mcp`).
 * Pattern mirrors voice-agent-orchestrator CustomMcpConnection + CustomMcpRouter:
 * connect N servers → merge tools → route callTool by tool name.
 *
 * Enable via config.yaml `customMcpServers`. Empty / omitted = no-op (3CX MCP only).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import chalk from 'chalk';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import type { McpToolDefinition } from './mcp-client.ts';
import { coerceToolArguments } from './tool-schema.ts';
import { OAuthCallbackServer, PersistentOAuthProvider } from './oauth-provider.ts';

export type CustomMcpAuth =
    | { type: 'none' }
    | { type: 'bearer'; token: string }
    | {
        type: 'oauth';
        /** Local callback port used during first-time browser authorization. */
        callbackPort?: number;
        /** Public HTTPS callback used by the admin dashboard. */
        redirectUrl?: string;
        /** Token store path, relative to the process working directory. */
        tokenFile?: string;
        /** Open the authorization URL automatically on macOS. Defaults to true. */
        openBrowser?: boolean;
    };

export interface CustomMcpServerConfig {
    /** Stable runtime identifier. Generated from name when omitted. */
    id?: string;
    name: string;
    url: string;
    auth?: CustomMcpAuth;
    transport?: 'streamable-http' | 'mcp-remote';
    mcpRemote?: {
        configDir?: string;
        transportStrategy?: 'http-first' | 'sse-first' | 'http-only' | 'sse-only';
    };
    healthCheck?: { tool: string; arguments?: Record<string, unknown> };
    providerConsoleUrl?: string;
    /** Defaults to true when omitted. */
    enabled?: boolean;
}

export class McpAuthorizationRequiredError extends Error {
    public readonly authorizationUrl: string;
    public readonly state: string;

    constructor(
        authorizationUrl: string,
        state: string,
    ) {
        super('MCP OAuth authorization is required');
        this.name = 'McpAuthorizationRequiredError';
        this.authorizationUrl = authorizationUrl;
        this.state = state;
    }
}

export class McpLocalAuthorizationRequiredError extends Error {
    constructor() {
        super('mcp-remote OAuth must be completed locally on the server before it can connect');
        this.name = 'McpLocalAuthorizationRequiredError';
    }
}

export interface CustomMcpToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

function authHeaders(auth?: CustomMcpAuth): Record<string, string> {
    if (auth?.type === 'bearer' && auth.token) {
        return { Authorization: `Bearer ${auth.token}` };
    }
    return {};
}

// Tencent Docs currently declares manage.search_file.modify_time as an integer
// but returns it as a string. Bypass only the SDK's per-tool outputSchema check
// for this read-only search tool while retaining the generic result validation.
const OUTPUT_SCHEMA_BYPASS_TOOLS = new Set(['manage.search_file']);

export class CustomMcpConnection {
    private client: Client | null = null;
    private oauthProvider: PersistentOAuthProvider | undefined;
    private pendingAuthTransport: StreamableHTTPClientTransport | undefined;
    private lastAuthorizationUrl: string | undefined;
    private intentionalClose = false;
    private readonly cfg: CustomMcpServerConfig;
    private readonly onUnexpectedClose?: (error: Error) => void;
    public readonly name: string;
    public tools: McpToolDefinition[] = [];

    constructor(cfg: CustomMcpServerConfig, onUnexpectedClose?: (error: Error) => void) {
        this.cfg = cfg;
        this.name = cfg.name;
        this.onUnexpectedClose = onUnexpectedClose;
    }

    private createOAuthProvider(onAuthorizationUrl?: (url: URL) => void): PersistentOAuthProvider | undefined {
        if (this.cfg.auth?.type !== 'oauth') return undefined;
        return new PersistentOAuthProvider({
            serverName: (this.cfg.id ?? this.name).replace(/[^a-zA-Z0-9._-]/g, '_'),
            callbackPort: this.cfg.auth.callbackPort,
            redirectUrl: this.cfg.auth.redirectUrl,
            tokenFile: this.cfg.auth.tokenFile,
            openBrowser: this.cfg.auth.openBrowser,
            onAuthorizationUrl,
        });
    }

    private createRemoteTransport(): StdioClientTransport {
        const require = createRequire(import.meta.url);
        const proxyPath = require.resolve('mcp-remote/dist/proxy.js');
        const args = [proxyPath, this.cfg.url];
        const strategy = this.cfg.mcpRemote?.transportStrategy ?? 'http-first';
        args.push('--transport', strategy, '--auth-timeout', '300');
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            MCP_REMOTE_CONFIG_DIR: this.remoteConfigDir(),
        };
        if (this.cfg.auth?.type === 'bearer') {
            args.push('--header', 'Authorization:${MCP_AUTH_HEADER}');
            env.MCP_AUTH_HEADER = `Bearer ${this.cfg.auth.token}`;
        }
        return new StdioClientTransport({ command: process.execPath, args, env, stderr: 'inherit' });
    }

    private remoteConfigDir(): string {
        return resolve(
            this.cfg.mcpRemote?.configDir
                ?? `.mcp-remote/${(this.cfg.id ?? this.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        );
    }

    private hasRemoteOAuthTokens(path = this.remoteConfigDir()): boolean {
        if (!existsSync(path)) return false;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = resolve(path, entry.name);
            if (entry.isDirectory() && this.hasRemoteOAuthTokens(child)) return true;
            if (entry.isFile() && entry.name === 'tokens.json') return true;
        }
        return false;
    }

    async connect(options: { deferOAuth?: boolean } = {}): Promise<void> {
        this.intentionalClose = false;
        if (this.cfg.transport === 'mcp-remote') {
            if (this.cfg.auth?.type === 'oauth' && !this.hasRemoteOAuthTokens()) {
                throw new McpLocalAuthorizationRequiredError();
            }
            this.client = new Client(
                { name: 'agentic-call-control', version: '1.0.0' },
                { capabilities: {} },
            );
            await this.client.connect(this.createRemoteTransport());
            await this.loadTools();
            return;
        }

        this.lastAuthorizationUrl = undefined;
        const oauth = this.cfg.auth?.type === 'oauth'
            ? this.createOAuthProvider((url) => { this.lastAuthorizationUrl = url.toString(); })
            : undefined;
        this.oauthProvider = oauth;
        const createTransport = () => new StreamableHTTPClientTransport(
            new URL(this.cfg.url),
            {
                authProvider: oauth,
                requestInit: { headers: authHeaders(this.cfg.auth) },
            },
        );
        const createClient = () => new Client(
            { name: 'agentic-call-control', version: '1.0.0' },
            { capabilities: {} },
        );

        let transport = createTransport();
        this.client = createClient();
        const deferOAuth = options.deferOAuth === true || Boolean(this.cfg.auth?.type === 'oauth' && this.cfg.auth.redirectUrl);
        if (oauth && deferOAuth) {
            try {
                await this.client.connect(transport);
                await this.loadTools();
                return;
            } catch (error) {
                if (!(error instanceof UnauthorizedError)) throw error;
                this.pendingAuthTransport = transport;
                if (!this.lastAuthorizationUrl) throw new Error('OAuth server did not provide an authorization URL');
                throw new McpAuthorizationRequiredError(this.lastAuthorizationUrl, oauth.expectedState());
            }
        }
        if (oauth) {
            // Existing tokens (including refresh tokens) normally connect without
            // opening a callback port. Fall through to interactive auth only when
            // the server rejects the persisted credentials.
            if (oauth.tokens()) {
                let connected = false;
                try {
                    await this.client.connect(transport);
                    connected = true;
                } catch (error) {
                    if (!(error instanceof UnauthorizedError)) throw error;
                }
                if (connected) {
                    await this.loadTools();
                    return;
                }
                transport = createTransport();
                this.client = createClient();
            }

            const callback = new OAuthCallbackServer(oauth.redirectUrl, oauth.expectedState());
            const codePromise = callback.waitForCode();
            try {
                await this.client.connect(transport);
                callback.close();
                void codePromise.catch(() => undefined);
            } catch (error) {
                if (!(error instanceof UnauthorizedError)) {
                    callback.close();
                    void codePromise.catch(() => undefined);
                    throw error;
                }

                const code = await codePromise;
                await transport.finishAuth(code);
                transport = createTransport();
                this.client = createClient();
                await this.client.connect(transport);
            }
        } else {
            await this.client.connect(transport);
        }

        await this.loadTools();
    }

    authorizationRequest(): { authorizationUrl: string; state: string } | undefined {
        if (!this.lastAuthorizationUrl || !this.oauthProvider) return undefined;
        return { authorizationUrl: this.lastAuthorizationUrl, state: this.oauthProvider.expectedState() };
    }

    async finishOAuth(code: string, state: string): Promise<void> {
        if (!this.oauthProvider || !this.pendingAuthTransport) throw new Error('No OAuth authorization is pending');
        if (state !== this.oauthProvider.expectedState()) throw new Error('Invalid OAuth state');
        await this.pendingAuthTransport.finishAuth(code);
        await this.client?.close?.().catch(() => undefined);
        this.client = null;
        this.pendingAuthTransport = undefined;
        await this.connect({ deferOAuth: true });
    }

    async deauthorize(): Promise<{ revoked: boolean }> {
        if (this.cfg.transport === 'mcp-remote') {
            const path = this.remoteConfigDir();
            if (path.length < 10 || path === resolve('/') || path === resolve('.')) {
                throw new Error('Refusing to clear an unsafe mcp-remote cache path');
            }
            rmSync(path, { recursive: true, force: true });
            this.disconnect();
            return { revoked: false };
        }
        const oauth = this.oauthProvider ?? this.createOAuthProvider();
        if (!oauth) return { revoked: false };
        const revoked = await oauth.revokeTokens().catch(() => false);
        oauth.clearAuthorization();
        this.disconnect();
        return { revoked };
    }

    async healthCheck(): Promise<string> {
        if (!this.cfg.healthCheck) {
            if (!this.client) throw new Error(`CustomMCP "${this.name}" not connected`);
            const result = await this.client.listTools();
            return `${result.tools.length} tools available`;
        }
        return this.callTool(this.cfg.healthCheck.tool, this.cfg.healthCheck.arguments ?? {});
    }

    private async loadTools(): Promise<void> {
        if (!this.client) throw new Error(`CustomMCP "${this.name}" not connected`);
        const { tools } = await this.client.listTools();
        this.tools = tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown> | undefined,
        }));

        console.log(chalk.green(`[CustomMCP] "${this.name}" connected — ${this.tools.length} tools`));
        this.client.onclose = () => {
            if (!this.intentionalClose) {
                this.onUnexpectedClose?.(new Error(`CustomMCP "${this.name}" transport closed unexpectedly`));
            }
        };
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        if (!this.client) throw new Error(`CustomMCP "${this.name}" not connected`);
        const result = OUTPUT_SCHEMA_BYPASS_TOOLS.has(name)
            ? await this.client.request(
                { method: 'tools/call', params: { name, arguments: args } },
                CallToolResultSchema,
            )
            : await this.client.callTool({ name, arguments: args });
        if (result.isError) {
            const errText = typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content);
            throw new Error(`Custom MCP tool "${name}" error: ${errText}`);
        }
        if (typeof result.content === 'string') return result.content;
        if (Array.isArray(result.content)) {
            return result.content
                .map((c) => {
                    if (typeof c === 'string') return c;
                    if (c.type === 'text') return (c as { text: string }).text;
                    return JSON.stringify(c);
                })
                .join('\n');
        }
        return JSON.stringify(result.content);
    }

    disconnect(): void {
        this.intentionalClose = true;
        void this.client?.close?.().catch(() => undefined);
        this.client = null;
        this.pendingAuthTransport = undefined;
    }
}

/** Routes tool calls to the connection that registered that tool name. */
export class CustomMcpRouter {
    private readonly registry = new Map<string, CustomMcpConnection>();
    private readonly schemaByName = new Map<string, Record<string, unknown>>();
    private readonly connections: CustomMcpConnection[];
    private readonly onCallResult?: (serverName: string, toolName: string, error?: Error) => void;
    /** All tools discovered from custom servers (before allowlist). */
    public readonly allToolDefs: CustomMcpToolDef[] = [];
    /** Tools exposed to the agent (after allowlist). */
    public readonly toolDefs: CustomMcpToolDef[] = [];

    constructor(
        connections: CustomMcpConnection[],
        onCallResult?: (serverName: string, toolName: string, error?: Error) => void,
    ) {
        this.connections = connections;
        this.onCallResult = onCallResult;
        for (const conn of connections) {
            for (const tool of conn.tools) {
                if (this.registry.has(tool.name)) {
                    console.warn(chalk.yellow(
                        `[CustomMCP] duplicate tool "${tool.name}" from "${conn.name}" — overrides previous server`,
                    ));
                }
                const def: CustomMcpToolDef = {
                    name: tool.name,
                    description: tool.description ?? '',
                    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
                };
                this.registry.set(tool.name, conn);
                this.schemaByName.set(tool.name, def.parameters);
                this.allToolDefs.push(def);
                this.toolDefs.push(def);
            }
        }
    }

    /**
     * Restrict exposed/callable tools to the agent profile `mcpTools` allowlist.
     * Same semantics as filterMcpTools for 3CX MCP (`undefined` / `'all'` = keep everything).
     */
    applyAllowlist(filter?: string[] | 'all'): void {
        if (!filter || filter === 'all') return;

        const allowed = new Set(filter);
        this.toolDefs.length = 0;
        this.registry.clear();
        this.schemaByName.clear();

        for (const conn of this.connections) {
            for (const tool of conn.tools) {
                if (!allowed.has(tool.name)) continue;
                const parameters = (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} };
                this.registry.set(tool.name, conn);
                this.schemaByName.set(tool.name, parameters);
                this.toolDefs.push({
                    name: tool.name,
                    description: tool.description ?? '',
                    parameters,
                });
            }
        }
    }

    has(toolName: string): boolean {
        return this.registry.has(toolName);
    }

    async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
        const conn = this.registry.get(toolName);
        if (!conn) return `Unknown custom MCP tool: ${toolName}`;
        const coerced = coerceToolArguments(args, this.schemaByName.get(toolName));
        try {
            const result = await conn.callTool(toolName, coerced);
            this.onCallResult?.(conn.name, toolName);
            return result;
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.onCallResult?.(conn.name, toolName, normalized);
            throw normalized;
        }
    }

    disconnectAll(): void {
        for (const conn of this.connections) conn.disconnect();
    }
}

/** Connect enabled custom MCP servers from config. Returns undefined when none configured. */
export async function connectCustomMcpServers(
    configs: CustomMcpServerConfig[] | undefined,
    allowlist?: string[] | 'all',
): Promise<CustomMcpRouter | undefined> {
    const enabled = (configs ?? []).filter((c) => c.enabled !== false && c.name && c.url);
    if (enabled.length === 0) return undefined;

    const connected: CustomMcpConnection[] = [];
    for (const cfg of enabled) {
        const conn = new CustomMcpConnection(cfg);
        try {
            await conn.connect();
            connected.push(conn);
        } catch (err) {
            console.warn(
                chalk.yellow(`[CustomMCP] "${cfg.name}" failed, skipping:`),
                (err as Error).message,
            );
        }
    }

    if (connected.length === 0) return undefined;
    const router = new CustomMcpRouter(connected);
    router.applyAllowlist(allowlist);

    const enabledNames = new Set(router.toolDefs.map((t) => t.name));
    console.log(chalk.cyan(
        `   Custom MCP tools (${router.toolDefs.length}/${router.allToolDefs.length}):`,
    ));
    for (const t of router.allToolDefs) {
        const on = enabledNames.has(t.name);
        const label = on ? chalk.green('✓') : chalk.gray('✗');
        const color = on ? chalk.gray : chalk.dim;
        const desc = (t.description || '(no description)').replace(/\s+/g, ' ').trim();
        const short = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
        console.log(color(`     ${label} ${t.name}: ${short}`));
    }

    return router;
}
