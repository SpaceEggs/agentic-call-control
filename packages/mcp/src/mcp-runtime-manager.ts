import { EventEmitter } from 'node:events';
import {
    CustomMcpConnection,
    CustomMcpRouter,
    McpAuthorizationRequiredError,
    McpLocalAuthorizationRequiredError,
} from './custom-mcp-client.ts';
import type { CustomMcpServerConfig, CustomMcpToolDef } from './custom-mcp-client.ts';

export type McpRuntimeStatus =
    | 'disabled'
    | 'disconnected'
    | 'connecting'
    | 'auth_required'
    | 'connected'
    | 'error';

export interface McpServerRuntimeState {
    id: string;
    name: string;
    status: McpRuntimeStatus;
    toolCount: number;
    tools: string[];
    lastConnectedAt?: string;
    lastToolSuccessAt?: string;
    lastToolErrorAt?: string;
    lastError?: string;
    authorizationUrlReady?: boolean;
}

export interface McpRuntimeLease {
    router?: CustomMcpRouter;
    toolDefs: CustomMcpToolDef[];
    release(): void;
}

interface Generation {
    router?: CustomMcpRouter;
    connections: Map<string, CustomMcpConnection>;
    leases: number;
    retired: boolean;
}

interface PendingOAuth {
    connection: CustomMcpConnection;
    state: string;
    expiresAt: number;
}

function idOf(config: CustomMcpServerConfig): string {
    return config.id ?? config.name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class McpRuntimeManager extends EventEmitter {
    private configs: CustomMcpServerConfig[];
    private readonly allowlist?: string[] | 'all';
    private generation: Generation = { connections: new Map(), leases: 0, retired: false };
    private readonly retired = new Set<Generation>();
    private readonly states = new Map<string, McpServerRuntimeState>();
    private readonly pendingOAuth = new Map<string, PendingOAuth>();
    private operation: Promise<void> = Promise.resolve();

    constructor(configs: CustomMcpServerConfig[] = [], allowlist?: string[] | 'all') {
        super();
        this.configs = configs;
        this.allowlist = allowlist;
        for (const config of configs) this.ensureState(config);
    }

    private ensureState(config: CustomMcpServerConfig): McpServerRuntimeState {
        const id = idOf(config);
        const existing = this.states.get(id);
        if (existing) {
            existing.name = config.name;
            return existing;
        }
        const state: McpServerRuntimeState = {
            id,
            name: config.name,
            status: config.enabled === false ? 'disabled' : 'disconnected',
            toolCount: 0,
            tools: [],
        };
        this.states.set(id, state);
        return state;
    }

    private changed(): void {
        this.emit('changed', this.getStates());
    }

    getConfigs(): CustomMcpServerConfig[] {
        return structuredClone(this.configs);
    }

    getStates(): McpServerRuntimeState[] {
        return this.configs.map((config) => ({ ...this.ensureState(config) }));
    }

    async initialize(): Promise<void> {
        await this.replaceGeneration(this.configs);
    }

    acquire(): McpRuntimeLease {
        const generation = this.generation;
        generation.leases++;
        let released = false;
        return {
            router: generation.router,
            toolDefs: generation.router?.toolDefs.map((tool) => ({ ...tool })) ?? [],
            release: () => {
                if (released) return;
                released = true;
                generation.leases--;
                this.cleanupGeneration(generation);
            },
        };
    }

    async setConfigs(configs: CustomMcpServerConfig[]): Promise<void> {
        const disabledNow = configs
            .filter((next) => next.enabled === false)
            .map(idOf)
            .filter((id) => this.configs.find((previous) => idOf(previous) === id)?.enabled !== false);
        for (const id of disabledNow) this.disconnectServerEverywhere(id);
        this.configs = structuredClone(configs);
        const activeIds = new Set(configs.map(idOf));
        for (const id of this.states.keys()) if (!activeIds.has(id)) this.states.delete(id);
        for (const config of configs) this.ensureState(config);
        await this.replaceGeneration(this.configs);
    }

    async reconnect(id: string): Promise<void> {
        if (!this.configs.some((config) => idOf(config) === id)) throw new Error('Unknown MCP server');
        await this.replaceGeneration(this.configs);
    }

    async beginOAuth(id: string): Promise<{ authorizationUrl: string } | { alreadyAuthorized: true }> {
        const config = this.configs.find((entry) => idOf(entry) === id);
        if (!config) throw new Error('Unknown MCP server');
        if (config.auth?.type !== 'oauth') throw new Error('This MCP server does not use OAuth');

        this.pendingOAuth.get(id)?.connection.disconnect();
        const connection = new CustomMcpConnection(config);
        try {
            await connection.connect({ deferOAuth: true });
            connection.disconnect();
            return { alreadyAuthorized: true };
        } catch (error) {
            if (!(error instanceof McpAuthorizationRequiredError)) {
                connection.disconnect();
                throw error;
            }
            this.setPendingOAuth(id, connection, error.state);
            const state = this.ensureState(config);
            state.status = 'auth_required';
            state.authorizationUrlReady = true;
            state.lastError = undefined;
            this.changed();
            return { authorizationUrl: error.authorizationUrl };
        }
    }

    async finishOAuth(code: string, stateValue: string): Promise<string> {
        const match = [...this.pendingOAuth.entries()].find(([, pending]) => pending.state === stateValue);
        if (!match) throw new Error('OAuth request is missing or has expired');
        const [id, pending] = match;
        this.pendingOAuth.delete(id);
        if (pending.expiresAt < Date.now()) {
            pending.connection.disconnect();
            throw new Error('OAuth request has expired');
        }
        try {
            await pending.connection.finishOAuth(code, stateValue);
        } finally {
            pending.connection.disconnect();
        }
        await this.replaceGeneration(this.configs);
        return id;
    }

    async deauthorize(id: string): Promise<{ revoked: boolean }> {
        const config = this.configs.find((entry) => idOf(entry) === id);
        if (!config) throw new Error('Unknown MCP server');
        const connections = [this.generation, ...this.retired]
            .map((generation) => generation.connections.get(id))
            .filter((connection): connection is CustomMcpConnection => Boolean(connection));
        if (connections.length === 0) connections.push(new CustomMcpConnection(config));
        this.disconnectServerEverywhere(id);
        const state = this.ensureState(config);
        state.status = 'auth_required';
        state.toolCount = 0;
        state.tools = [];
        state.authorizationUrlReady = false;
        state.lastError = undefined;
        this.changed();
        const results = await Promise.all(connections.map((connection) => connection.deauthorize()));
        await this.replaceGeneration(this.configs);
        return { revoked: results.some((result) => result.revoked) };
    }

    async test(id: string): Promise<string> {
        const connection = this.generation.connections.get(id);
        if (!connection) throw new Error('MCP server is not connected');
        const result = await connection.healthCheck();
        const config = this.configs.find((entry) => idOf(entry) === id);
        if (config) {
            const state = this.ensureState(config);
            state.lastToolSuccessAt = new Date().toISOString();
            state.lastError = undefined;
            this.changed();
        }
        return result;
    }

    private async replaceGeneration(configs: CustomMcpServerConfig[]): Promise<void> {
        const run = async (): Promise<void> => {
            const next = await this.buildGeneration(configs);
            const previous = this.generation;
            this.generation = next;
            previous.retired = true;
            this.retired.add(previous);
            this.cleanupGeneration(previous);
            this.changed();
        };
        const operation = this.operation.then(run, run);
        this.operation = operation.catch(() => undefined);
        await operation;
    }

    private async buildGeneration(configs: CustomMcpServerConfig[]): Promise<Generation> {
        const connections = new Map<string, CustomMcpConnection>();
        for (const config of configs) {
            const id = idOf(config);
            const state = this.ensureState(config);
            state.authorizationUrlReady = false;
            state.lastError = undefined;
            if (config.enabled === false) {
                state.status = 'disabled';
                state.toolCount = 0;
                state.tools = [];
                continue;
            }
            state.status = 'connecting';
            this.changed();
            const connection = new CustomMcpConnection(config, (error) => {
                if (this.generation.connections.get(id) !== connection) return;
                state.status = 'error';
                state.lastError = error.message;
                state.lastToolErrorAt = new Date().toISOString();
                this.changed();
            });
            try {
                await connection.connect({
                    deferOAuth: config.transport !== 'mcp-remote'
                        && config.auth?.type === 'oauth'
                        && Boolean(config.auth.redirectUrl),
                });
                connections.set(id, connection);
                state.status = 'connected';
                state.tools = connection.tools.map((tool) => tool.name);
                state.toolCount = state.tools.length;
                state.lastConnectedAt = new Date().toISOString();
            } catch (error) {
                if (error instanceof McpAuthorizationRequiredError) {
                    state.status = 'auth_required';
                    state.authorizationUrlReady = true;
                    this.pendingOAuth.get(id)?.connection.disconnect();
                    this.setPendingOAuth(id, connection, error.state);
                } else if (error instanceof McpLocalAuthorizationRequiredError) {
                    connection.disconnect();
                    state.status = 'auth_required';
                    state.authorizationUrlReady = false;
                    state.lastError = error.message;
                } else {
                    connection.disconnect();
                    state.status = 'error';
                    state.lastError = messageOf(error);
                }
                state.tools = [];
                state.toolCount = 0;
            }
        }

        const router = connections.size === 0
            ? undefined
            : new CustomMcpRouter([...connections.values()], (serverName, _tool, error) => {
                const config = this.configs.find((entry) => entry.name === serverName);
                if (!config) return;
                const state = this.ensureState(config);
                if (error) {
                    state.lastToolErrorAt = new Date().toISOString();
                    state.lastError = error.message;
                } else {
                    state.lastToolSuccessAt = new Date().toISOString();
                    state.lastError = undefined;
                }
                this.changed();
            });
        router?.applyAllowlist(this.allowlist);
        return { router, connections, leases: 0, retired: false };
    }

    private cleanupGeneration(generation: Generation): void {
        if (!generation.retired || generation.leases > 0) return;
        generation.router?.disconnectAll();
        this.retired.delete(generation);
    }

    private setPendingOAuth(id: string, connection: CustomMcpConnection, state: string): void {
        const pending: PendingOAuth = {
            connection,
            state,
            expiresAt: Date.now() + 300_000,
        };
        this.pendingOAuth.set(id, pending);
        const timer = setTimeout(() => {
            if (this.pendingOAuth.get(id) !== pending) return;
            pending.connection.disconnect();
            this.pendingOAuth.delete(id);
            const config = this.configs.find((entry) => idOf(entry) === id);
            if (config) {
                const runtimeState = this.ensureState(config);
                runtimeState.authorizationUrlReady = false;
                this.changed();
            }
        }, 300_000);
        timer.unref();
    }

    private disconnectServerEverywhere(id: string): void {
        this.generation.connections.get(id)?.disconnect();
        for (const generation of this.retired) generation.connections.get(id)?.disconnect();
        this.pendingOAuth.get(id)?.connection.disconnect();
        this.pendingOAuth.delete(id);
    }

    close(): void {
        this.generation.router?.disconnectAll();
        for (const generation of this.retired) generation.router?.disconnectAll();
        for (const pending of this.pendingOAuth.values()) pending.connection.disconnect();
        this.pendingOAuth.clear();
    }
}
