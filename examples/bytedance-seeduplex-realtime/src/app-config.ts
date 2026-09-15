import type { CustomMcpServerConfig } from '@3cx-examples/mcp';

export interface AppConfig {
  /** 3CX service principal application id. Distinct from volcAppId. */
  appId: string;
  appSecret: string;
  pbxBase: string;
  /** Volcengine / Doubao speech APP ID (Seeduplex). Distinct from 3CX appId. */
  volcAppId?: string;
  /** Volcengine API Key for Seeduplex WebSocket auth (X-Api-Key). */
  volcApiKey: string;
  agentProfile?: string;
  agentInstructions?: string;
  companyName?: string;
  agentName?: string;
  initialGreeting: string;
  speakOnRouteFailure: boolean;
  routeFailureUserReply: string;
  /**
   * Seeduplex model version string. Issue default: 1.2.6.0.
   * Stored as a string; treated as an upstream fixed value, not a free-form alias.
   */
  realtimeModel?: string;
  /** Fallback voice; agent profile voice takes priority */
  realtimeVoice?: string;
  /**
   * Optional extra MCP servers (in addition to 3CX `{pbxBase}/mcp`).
   * See `@3cx-examples/mcp`. Omit or leave empty to use only 3CX MCP.
   */
  customMcpServers?: CustomMcpServerConfig[];
}

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';

export const DEFAULT_REALTIME_MODEL = '1.2.6.0';
export const DEFAULT_REALTIME_VOICE = 'zh_female_vv_jupiter_bigtts';

export const CONFIG_PATH = resolve(process.cwd(), 'config.yaml');

function requireNonEmpty(value: unknown, field: string, missing: string[]): string {
    if (typeof value !== 'string' || value.trim() === '') {
        missing.push(field);
        return '';
    }
    return value;
}

/** Coerce numeric-looking YAML unquoted DNs / app ids to string. */
function asString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

export function validateConfig(cfg: AppConfig): void {
    const missing: string[] = [];
    requireNonEmpty(cfg.appId, 'appId', missing);
    requireNonEmpty(cfg.appSecret, 'appSecret', missing);
    requireNonEmpty(cfg.pbxBase, 'pbxBase', missing);
    requireNonEmpty(cfg.volcApiKey, 'volcApiKey', missing);
    if (missing.length > 0) {
        throw new Error(`Missing required config fields: ${missing.join(', ')}`);
    }
}

export function loadAppConfig(path: string = CONFIG_PATH): AppConfig {
    const raw = readFileSync(path, 'utf-8');
    const loaded = load(raw) as Record<string, unknown>;

    const cfg: AppConfig = {
        appId: asString(loaded.appId) ?? '',
        appSecret: asString(loaded.appSecret) ?? '',
        pbxBase: asString(loaded.pbxBase) ?? '',
        volcAppId: asString(loaded.volcAppId),
        volcApiKey: asString(loaded.volcApiKey) ?? '',
        agentProfile: asString(loaded.agentProfile),
        agentInstructions: asString(loaded.agentInstructions),
        companyName: asString(loaded.companyName),
        agentName: asString(loaded.agentName),
        initialGreeting: asString(loaded.initialGreeting) ?? '',
        speakOnRouteFailure: loaded.speakOnRouteFailure !== false,
        routeFailureUserReply: asString(loaded.routeFailureUserReply) ?? '',
        realtimeModel: asString(loaded.realtimeModel) ?? DEFAULT_REALTIME_MODEL,
        realtimeVoice: asString(loaded.realtimeVoice) ?? DEFAULT_REALTIME_VOICE,
        customMcpServers: loaded.customMcpServers as CustomMcpServerConfig[] | undefined,
    };

    validateConfig(cfg);
    return cfg;
}
