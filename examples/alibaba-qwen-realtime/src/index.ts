import chalk from 'chalk';
import { CallControlClient } from '@3cx/call-control-sdk';
import { createCallStore } from './callcontrol/call-store.ts';
import { filterMcpTools, McpManager, McpRuntimeManager } from '@3cx-examples/mcp';
import appconfig from './app-config.ts';
import { loadAgentProfile } from './agent/agent-profiles.ts';
import type { AgentProfile } from './agent/agent-profiles.ts';
import { AdminConfigStore } from './admin/config-store.ts';
import { AdminLogHub } from './admin/log-hub.ts';
import { CertificateManager, assertSecretFilePermissions } from './admin/certificate-manager.ts';
import { AdminServer } from './admin/admin-server.ts';
import { TailscaleFunnelManager } from './admin/tailscale-funnel.ts';

const adminLogHub = new AdminLogHub();
adminLogHub.installConsoleMirror();

async function main() {
    console.log(chalk.cyan('alibaba-qwen-realtime starting'));
    console.log(chalk.cyan(`   3CX PBX: ${appconfig.pbxBase}`));
    console.log(chalk.cyan(`   DashScope: ${appconfig.dashscopeBaseUrl}`));
    console.log(chalk.cyan(`   Model: ${appconfig.realtimeModel ?? 'qwen3.5-omni-plus-realtime'}`));

    let profile: AgentProfile | null = null;

    if (appconfig.agentProfile) {
        profile = loadAgentProfile(appconfig.agentProfile);
        console.log(chalk.cyan(`   Agent profile: ${appconfig.agentProfile} (role: ${profile.role})`));
    } else if (appconfig.agentInstructions) {
        console.log(chalk.cyan('   Agent: legacy agentInstructions mode'));
    } else {
        console.error(chalk.red('Error: neither agentProfile nor agentInstructions is set in config.yaml'));
        process.exit(1);
    }

    console.log(chalk.cyan(`   Voice: ${profile?.voice ?? appconfig.realtimeVoice ?? 'Ethan'}`));

    const adminConfig = appconfig.admin;
    const adminEnabled = Boolean(adminConfig && adminConfig.enabled !== false);
    const adminMode = adminConfig?.mode ?? 'https';
    if (adminEnabled && adminMode !== 'https' && adminMode !== 'tailscale-funnel') {
        throw new Error('admin.mode must be https or tailscale-funnel');
    }
    const tailscaleFunnel = adminEnabled && adminMode === 'tailscale-funnel'
        ? new TailscaleFunnelManager(adminConfig?.tailscaleFunnel ?? {})
        : undefined;
    const adminPublicBaseUrl = tailscaleFunnel
        ? await tailscaleFunnel.getPublicBaseUrl()
        : (adminEnabled ? adminConfig?.publicBaseUrl : undefined);
    if (adminEnabled && !adminPublicBaseUrl) {
        throw new Error('admin.publicBaseUrl is required when admin.mode is https');
    }
    const configStore = new AdminConfigStore(
        appconfig.customMcpServers,
        adminConfig?.stateFile,
        adminPublicBaseUrl,
    );
    let certificateManager: CertificateManager | undefined;
    if (adminEnabled && adminMode === 'https') {
        if (!adminConfig?.tls) throw new Error('admin.tls is required when admin.mode is https');
        assertSecretFilePermissions();
        certificateManager = new CertificateManager(adminConfig.tls);
        // Fail before opening PBX/Qwen connections rather than silently exposing HTTP.
        certificateManager.tlsOptions();
    }

    const client = new CallControlClient({
        pbxBase: appconfig.pbxBase,
        appId: appconfig.appId,
        appSecret: appconfig.appSecret,
    });

    await client.connect();
    console.log(chalk.green('   SDK connected (auth + WebSocket + state)'));

    let mcpManager: McpManager | undefined;
    let mcpToolDefs: { name: string; description: string; parameters: Record<string, unknown> }[] = [];

    try {
        mcpManager = new McpManager({
            mcpUrl: client.getMcpUrl(),
            authProvider: client.createMcpAuthProvider(),
        });
        await mcpManager.connect();

        const toolsResult = await mcpManager.listTools();
        const filtered = filterMcpTools(toolsResult.tools, profile?.mcpTools);
        mcpToolDefs = filtered.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        }));

        console.log(chalk.cyan(`   MCP tools (${filtered.length}/${toolsResult.tools.length}):`));
        for (const t of filtered) {
            console.log(chalk.gray(`     - ${t.name}: ${t.description ?? '(no description)'}`));
        }
    } catch (err) {
        console.warn(chalk.yellow('[MCP] connection failed, continuing without MCP tools:'), (err as Error).message);
        mcpManager = undefined;
        mcpToolDefs = [];
    }

    const runtimeServers = adminEnabled
        ? configStore.getServers()
        : (appconfig.customMcpServers ?? []);
    const customMcpRuntime = new McpRuntimeManager(runtimeServers, profile?.mcpTools);
    await customMcpRuntime.initialize();

    const callStore = createCallStore(client, appconfig, profile, mcpManager, mcpToolDefs, customMcpRuntime);

    let adminServer: AdminServer | undefined;
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        await tailscaleFunnel?.stop().catch((error) => {
            console.error(chalk.red('[Tailscale] shutdown failed:'), (error as Error).message);
        });
        adminServer?.close();
        customMcpRuntime.close();
        mcpManager?.dispose();
        client.disconnect();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    try {
        if (adminEnabled && adminConfig && adminPublicBaseUrl) {
            adminServer = new AdminServer({
                config: adminConfig,
                publicBaseUrl: adminPublicBaseUrl,
                configStore,
                mcpRuntime: customMcpRuntime,
                certificateManager,
                logHub: adminLogHub,
                getActiveCallCount: callStore.getActiveCallCount,
            });
            const adminHandle = await adminServer.start();
            await tailscaleFunnel?.start(adminHandle.localOrigin);
        } else {
            console.log(chalk.yellow('[Admin] dashboard disabled; add admin configuration to config.yaml to enable it'));
        }
    } catch (error) {
        await shutdown();
        throw error;
    }

    console.log(chalk.green('All systems ready (Qwen realtime mode)'));
}

main().catch((err) => {
    console.error(chalk.red('Fatal error:'), err);
    process.exit(1);
});
