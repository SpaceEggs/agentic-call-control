import type { CustomMcpServerConfig } from '@3cx-examples/mcp';

export interface AppConfig {
  appId: string;
  appSecret: string;
  pbxBase: string;
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;
  agentProfile?: string;
  agentInstructions?: string;
  companyName?: string;
  agentName?: string;
  initialGreeting: string;
  speakOnRouteFailure: boolean;
  routeFailureUserReply: string;
  /** Realtime model. Default: qwen3.5-omni-plus-realtime */
  realtimeModel?: string;
  /** Fallback voice; agent profile voice takes priority */
  realtimeVoice?: string;
  /** Server VAD silence duration in ms */
  realtimeVadSilenceDurationMs?: number;
  /**
   * Optional extra MCP servers (in addition to 3CX `{pbxBase}/mcp`).
   * See `@3cx-examples/mcp`. Omit or leave empty to use only 3CX MCP.
   */
  customMcpServers?: CustomMcpServerConfig[];
  /** Optional Zoho Desk knowledge-base and support-ticket workflow. */
  desk?: DeskConfig;
  admin?: AdminConfig;
}

export interface DeskToolNames {
  getOrganizations: string;
  searchSolutions: string;
  getArticle: string;
  searchContacts: string;
  createContact: string;
  searchTickets: string;
  createTicket: string;
  getDepartments: string;
}

export interface DeskConfig {
  /** Desk tools stay completely hidden when false or omitted. */
  enabled?: boolean;
  /** Fixed Zoho Desk organization ID returned by getOrganizations. */
  orgId?: string;
  /** Fixed department selected after the target Desk organization is authorized. */
  departmentId?: string;
  /** Human-readable audit label; never used to select a department automatically. */
  departmentName?: string;
  channel?: string;
  priority?: string;
  /** Window used to suppress duplicate open tickets for the same caller and issue. */
  duplicateWindowHours?: number;
  /** Exact names returned by MCP tools/list; override these after authorization if needed. */
  toolNames?: Partial<DeskToolNames>;
}

export interface AdminConfig {
  enabled?: boolean;
  /** Direct HTTPS with lego, or public HTTPS terminated by Tailscale Funnel. Default: https. */
  mode?: 'https' | 'tailscale-funnel';
  host?: string;
  port?: number;
  /** Browser-visible HTTPS origin, for example https://qwen-admin.example.com:8443. */
  publicBaseUrl?: string;
  stateFile?: string;
  tailscaleFunnel?: TailscaleFunnelConfig;
  tls?: AdminTlsConfig;
}

export interface AdminTlsConfig {
  domain: string;
  email: string;
  legoPath?: string;
  legoVersion?: string;
  dataDir?: string;
  renewCheckHours?: number;
  dnsResolvers?: string[];
}

export interface TailscaleFunnelConfig {
  tailscalePath?: string;
  publicBaseUrl?: string;
  publicPort?: 443 | 8443 | 10000;
  stopOnExit?: boolean;
}

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';

const DASHSCOPE_DEFAULT_BASE = 'https://dashscope-intl.aliyuncs.com';

function loadConfig(): AppConfig {
    const configPath = resolve(process.cwd(), 'config.yaml');
    const raw = readFileSync(configPath, 'utf-8');
    const cfg = load(raw) as AppConfig;
    // Numeric-looking RoutePoint DNs are parsed as numbers by YAML unless quoted.
    // Normalize here because the SDK compares event DN keys as strings.
    cfg.appId = String(cfg.appId);
    cfg.dashscopeBaseUrl ??= DASHSCOPE_DEFAULT_BASE;
    return cfg;
}

export default loadConfig();
