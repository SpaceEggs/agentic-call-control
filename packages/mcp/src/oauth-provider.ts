import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface OAuthState {
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    authorizationServer?: string;
}

function readState(path: string): OAuthState {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as OAuthState;
    } catch {
        return {};
    }
}

function writeState(path: string, state: OAuthState): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}

function openAuthorizationUrl(url: URL, enabled: boolean): void {
    console.log(`   Complete OAuth authorization in your browser:\n   ${url.toString()}`);
    if (!enabled || process.platform !== 'darwin') return;

    const child = spawn('open', [url.toString()], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
}

export interface OAuthProviderOptions {
    serverName: string;
    callbackPort?: number;
    /** Public callback used by browser-based admin applications. */
    redirectUrl?: string;
    tokenFile?: string;
    openBrowser?: boolean;
    onAuthorizationUrl?: (url: URL) => void;
}

/** OAuth 2.1 provider with dynamic client registration and local token persistence. */
export class PersistentOAuthProvider implements OAuthClientProvider {
    private readonly path: string;
    private readonly callback: URL;
    private readonly metadata: OAuthClientMetadata;
    private readonly shouldOpenBrowser: boolean;
    private readonly onAuthorizationUrl?: (url: URL) => void;
    private readonly oauthState: string;
    private stateData: OAuthState;

    constructor(options: OAuthProviderOptions) {
        const port = options.callbackPort ?? 8090;
        this.callback = new URL(options.redirectUrl ?? `http://127.0.0.1:${port}/oauth/callback`);
        this.path = resolve(options.tokenFile ?? `.mcp-oauth/${options.serverName}.json`);
        this.shouldOpenBrowser = options.openBrowser !== false;
        this.onAuthorizationUrl = options.onAuthorizationUrl;
        this.oauthState = randomBytes(24).toString('hex');
        this.stateData = readState(this.path);
        this.metadata = {
            client_name: `agentic-call-control (${options.serverName})`,
            redirect_uris: [this.callback.toString()],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_post',
        };
    }

    get redirectUrl(): URL {
        return this.callback;
    }

    get clientMetadata(): OAuthClientMetadata {
        return this.metadata;
    }

    state(): string {
        return this.oauthState;
    }

    expectedState(): string {
        return this.oauthState;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this.stateData.clientInformation;
    }

    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this.stateData.clientInformation = clientInformation;
        writeState(this.path, this.stateData);
    }

    tokens(): OAuthTokens | undefined {
        return this.stateData.tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this.stateData.tokens = tokens;
        writeState(this.path, this.stateData);
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this.stateData.authorizationServer = authorizationUrl.origin;
        writeState(this.path, this.stateData);
        if (this.onAuthorizationUrl) {
            this.onAuthorizationUrl(authorizationUrl);
            return;
        }
        openAuthorizationUrl(authorizationUrl, this.shouldOpenBrowser);
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.stateData.codeVerifier = codeVerifier;
        writeState(this.path, this.stateData);
    }

    codeVerifier(): string {
        if (!this.stateData.codeVerifier) throw new Error('OAuth PKCE verifier is missing');
        return this.stateData.codeVerifier;
    }

    /** Remove locally held user credentials while retaining dynamic client registration. */
    clearAuthorization(): void {
        this.stateData.tokens = undefined;
        this.stateData.codeVerifier = undefined;
        writeState(this.path, this.stateData);
    }

    /** Best-effort RFC 7009 revocation when the authorization server advertises it. */
    async revokeTokens(): Promise<boolean> {
        const tokens = this.stateData.tokens;
        const authorizationServer = this.stateData.authorizationServer;
        this.clearAuthorization();
        if (!tokens || !authorizationServer) return false;

        let endpoint: string | undefined;
        try {
            const metadataUrl = new URL('/.well-known/oauth-authorization-server', authorizationServer);
            const response = await fetch(metadataUrl, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(5_000),
            });
            if (response.ok) {
                const metadata = await response.json() as { revocation_endpoint?: string };
                endpoint = metadata.revocation_endpoint;
            }
        } catch {
            return false;
        }
        if (!endpoint) return false;

        const client = this.stateData.clientInformation;
        const revoke = async (token: string, hint: string): Promise<boolean> => {
            const body = new URLSearchParams({ token, token_type_hint: hint });
            if (client?.client_id) body.set('client_id', client.client_id);
            if (client && 'client_secret' in client && client.client_secret) {
                body.set('client_secret', client.client_secret);
            }
            const response = await fetch(endpoint!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.timeout(5_000),
            });
            return response.ok;
        };

        const requests: Promise<boolean>[] = [];
        if (tokens.refresh_token) requests.push(revoke(tokens.refresh_token, 'refresh_token'));
        if (tokens.access_token) requests.push(revoke(tokens.access_token, 'access_token'));
        return (await Promise.all(requests)).some(Boolean);
    }
}

export class OAuthCallbackServer {
    private server: Server | undefined;
    private readonly callbackUrl: URL;
    private readonly expectedState: string;

    constructor(
        callbackUrl: URL,
        expectedState: string,
    ) {
        this.callbackUrl = callbackUrl;
        this.expectedState = expectedState;
    }

    waitForCode(timeoutMs = 300_000): Promise<string> {
        return new Promise((resolveCode, rejectCode) => {
            const finish = (error?: Error, code?: string): void => {
                this.close();
                if (error) rejectCode(error);
                else resolveCode(code!);
            };

            const timer = setTimeout(
                () => finish(new Error('OAuth authorization timed out')),
                timeoutMs,
            );
            timer.unref();

            this.server = createServer((request, response) => {
                const requestUrl = new URL(request.url ?? '/', this.callbackUrl);
                if (requestUrl.pathname !== this.callbackUrl.pathname) {
                    response.writeHead(404).end();
                    return;
                }

                const error = requestUrl.searchParams.get('error');
                const code = requestUrl.searchParams.get('code');
                const state = requestUrl.searchParams.get('state');
                if (error) {
                    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                    response.end(`OAuth authorization failed: ${error}`);
                    clearTimeout(timer);
                    finish(new Error(`OAuth authorization failed: ${error}`));
                    return;
                }
                if (!code || state !== this.expectedState) {
                    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                    response.end('Invalid OAuth callback.');
                    clearTimeout(timer);
                    finish(new Error('Invalid OAuth callback code or state'));
                    return;
                }

                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                response.end('<h1>Authorization complete</h1><p>You can close this window.</p>');
                clearTimeout(timer);
                finish(undefined, code);
            });

            this.server.once('error', (error) => {
                clearTimeout(timer);
                finish(error);
            });
            this.server.listen(Number(this.callbackUrl.port), this.callbackUrl.hostname);
        });
    }

    close(): void {
        this.server?.close();
        this.server = undefined;
    }
}
