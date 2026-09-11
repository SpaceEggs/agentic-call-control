import { spawn } from 'node:child_process';
import type { TailscaleFunnelConfig } from '../app-config.ts';

const OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';
const ALLOWED_PUBLIC_PORTS = new Set([443, 8443, 10000]);

export type TailscaleCommandRunner = (
    command: string,
    args: string[],
    timeoutMs: number,
) => Promise<string>;

export interface TailscaleFunnelHandle {
    publicBaseUrl: string;
    callbackUrl: string;
    publicPort: number;
    localOrigin: string;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolveOutput, rejectOutput) => {
        const child = spawn(command, args, {
            shell: false,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const append = (chunk: Buffer): void => {
            output += chunk.toString('utf8');
            if (output.length > 200_000) output = output.slice(-200_000);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            rejectOutput(new Error(`tailscale command timed out: ${args.join(' ')}`));
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            rejectOutput(error);
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolveOutput(output);
            else rejectOutput(new Error(`tailscale exited with code ${code}: ${output.trim()}`));
        });
    });
}

export class TailscaleFunnelManager {
    private readonly config: TailscaleFunnelConfig;
    private readonly runner: TailscaleCommandRunner;
    private cachedPublicBaseUrl: string | undefined;
    private active = false;
    private stopOperation: Promise<void> | undefined;

    constructor(config: TailscaleFunnelConfig, runner: TailscaleCommandRunner = runCommand) {
        this.config = config;
        this.runner = runner;
    }

    private tailscalePath(): string {
        return this.config.tailscalePath?.trim() || 'tailscale';
    }

    private publicPort(explicitUrl?: URL): number {
        const urlPort = explicitUrl?.port ? Number(explicitUrl.port) : 443;
        const port = this.config.publicPort ?? urlPort;
        if (!ALLOWED_PUBLIC_PORTS.has(port)) {
            throw new Error('Tailscale Funnel publicPort must be 443, 8443, or 10000');
        }
        if (explicitUrl && port !== urlPort) {
            throw new Error('tailscaleFunnel.publicBaseUrl port does not match publicPort');
        }
        return port;
    }

    private validatePublicBaseUrl(value: string): string {
        const url = new URL(value);
        if (url.protocol !== 'https:') throw new Error('tailscaleFunnel.publicBaseUrl must use https');
        if (!url.hostname.endsWith('.ts.net')) {
            throw new Error('tailscaleFunnel.publicBaseUrl must use a Tailscale *.ts.net hostname');
        }
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('tailscaleFunnel.publicBaseUrl must be an HTTPS origin without a path');
        }
        this.publicPort(url);
        return url.origin;
    }

    private validateLocalOrigin(value: string): string {
        const url = new URL(value);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
            throw new Error('Tailscale Funnel origin must use HTTP on 127.0.0.1');
        }
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('Tailscale Funnel origin must not include credentials, a path, query, or fragment');
        }
        return url.origin;
    }

    async getPublicBaseUrl(): Promise<string> {
        if (this.cachedPublicBaseUrl) return this.cachedPublicBaseUrl;
        if (this.config.publicBaseUrl) {
            this.cachedPublicBaseUrl = this.validatePublicBaseUrl(this.config.publicBaseUrl);
            return this.cachedPublicBaseUrl;
        }

        const output = await this.runner(this.tailscalePath(), ['status', '--json'], 30_000);
        const status = JSON.parse(output) as { Self?: { DNSName?: string } };
        const hostname = status.Self?.DNSName?.replace(/\.$/, '');
        if (!hostname?.endsWith('.ts.net')) {
            throw new Error('Tailscale status did not return a valid Self.DNSName');
        }
        const port = this.publicPort();
        this.cachedPublicBaseUrl = `https://${hostname}${port === 443 ? '' : `:${port}`}`;
        return this.cachedPublicBaseUrl;
    }

    async start(localOrigin: string): Promise<TailscaleFunnelHandle> {
        if (this.active) throw new Error('Tailscale Funnel is already started');
        const origin = this.validateLocalOrigin(localOrigin);
        const publicBaseUrl = await this.getPublicBaseUrl();
        const publicPort = this.publicPort(new URL(publicBaseUrl));

        try {
            await this.runner(this.tailscalePath(), [
                'funnel',
                '--bg',
                '--yes',
                `--https=${publicPort}`,
                origin,
            ], 30_000);
            this.active = true;
        } catch (error) {
            throw new Error(`Failed to start Tailscale Funnel: ${messageOf(error)}`);
        }

        const callbackUrl = new URL(OAUTH_CALLBACK_PATH, publicBaseUrl).toString();
        console.log(`[Tailscale] administration Funnel ready at ${publicBaseUrl}`);
        console.log(`[Tailscale] OAuth callback ready at ${callbackUrl}`);
        return { publicBaseUrl, callbackUrl, publicPort, localOrigin: origin };
    }

    stop(): Promise<void> {
        if (this.stopOperation) return this.stopOperation;
        this.stopOperation = this.stopInternal().finally(() => {
            this.stopOperation = undefined;
        });
        return this.stopOperation;
    }

    private async stopInternal(): Promise<void> {
        if (!this.active) return;
        this.active = false;
        if (this.config.stopOnExit === false) return;
        const publicBaseUrl = await this.getPublicBaseUrl();
        const publicPort = this.publicPort(new URL(publicBaseUrl));
        await this.runner(this.tailscalePath(), [
            'funnel',
            '--bg',
            '--yes',
            `--https=${publicPort}`,
            'off',
        ], 30_000);
        console.log('[Tailscale] administration Funnel stopped');
    }
}
