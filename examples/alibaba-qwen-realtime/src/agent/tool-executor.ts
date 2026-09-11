import type { Participant } from '@3cx/call-control-sdk';
import chalk from 'chalk';
import { availabilityUnknownHint, blockIfAvailabilityUnknown, finalizePhonebookResult, isRouteNotTransferable } from './call-routing.ts';
import { isExtensionAllowed } from './local-tools.ts';
import type { AgentProfile } from './agent-profiles.ts';
import type { CallState } from './call-state.ts';
import { formatScreening, isScreeningReady, missingScreeningFields } from './call-state.ts';
import type { CallLogger } from '../logging/call-logger.ts';
import type { CustomMcpRouter, McpManager } from '@3cx-examples/mcp';
import { ToolRegistry } from './tool-registry.ts';
import type { ToolResult, ToolDeps, ToolHandler } from './tool-registry.ts';
import type { DeskConfig } from '../app-config.ts';
import { registerDeskTools } from './desk-tools.ts';

export type { ToolResult };

export interface ToolExecutorDeps {
    participant: Participant;
    mcpManager?: McpManager;
    customMcpRouter?: CustomMcpRouter;
    profile: AgentProfile;
    callState: CallState;
    desk?: DeskConfig;
    onCleanup: () => void;
    logger?: CallLogger;
}

async function submitScreening(participant: Participant, callState: CallState): Promise<void> {
    const text = formatScreening(callState.screening);
    try {
        console.log(chalk.cyan(`[ToolExec] attachPartyData: ${text}`));
        await participant.attachPartyData({ public_call_screening: text });
        console.log(chalk.green(`[ToolExec] attachPartyData OK`));
    } catch (e) {
        console.error(chalk.red('[ToolExec] attachPartyData error:'), e);
    }
}

const handleTransferCall: ToolHandler = async (args, deps) => {
    const destination = String(args.destination ?? '');
    if (!destination) return { content: 'No destination specified.' };

    const routeBlocked = blockIfRouteNotTransferable(deps, 'transfer');
    if (routeBlocked) return routeBlocked;

    if (!/^\d+$/.test(destination)) {
        console.log(chalk.yellow(`[ToolExec] transfer_call rejected — "${destination}" is not an extension number`));
        return { content: `"${destination}" is not a valid extension number. Use the extensionNumber from list_phonebook result.` };
    }

    if (!isExtensionAllowed(destination, deps.profile)) {
        return { content: `Transfer to ${destination} is not allowed.` };
    }

    if (deps.profile.callScreening && !isScreeningReady(deps.callState.screening)) {
        const missing = missingScreeningFields(deps.callState.screening);
        console.log(chalk.yellow(`[ToolExec] transfer blocked — missing: ${missing.join(', ')}`));
        return { content: `Before transferring, ask the caller for: ${missing.join(', ')}.` };
    }

    const blocked = blockRouteIfAvailabilityUnknown(deps, destination, 'transfer');
    if (blocked) return blocked;

    if (deps.profile.callScreening) await submitScreening(deps.participant, deps.callState);
    console.log(chalk.magentaBright(`[ToolExec] transfer_call → ${destination}`));
    return { content: `Transfer to ${destination} initiated.`, action: 'transfer', destination };
};

const handleDropCall: ToolHandler = async () => {
    console.log(chalk.magentaBright('[ToolExec] drop_call'));
    return { content: 'Call will be ended.', action: 'drop' };
};

const handleTransferToVoicemail: ToolHandler = async (args, deps) => {
    const destination = String(args.destination ?? '');
    if (!destination) return { content: 'No destination specified.' };

    const routeBlocked = blockIfRouteNotTransferable(deps, 'voicemail');
    if (routeBlocked) return routeBlocked;

    if (!/^\d+$/.test(destination)) {
        console.log(chalk.yellow(`[ToolExec] transfer_to_voicemail rejected — "${destination}" is not an extension number`));
        return { content: `"${destination}" is not a valid extension number. Use the extensionNumber from the contact result.` };
    }

    if (!isExtensionAllowed(destination, deps.profile)) {
        return { content: `Transfer to voicemail of ${destination} is not allowed.` };
    }

    if (deps.profile.callScreening && !isScreeningReady(deps.callState.screening)) {
        const missing = missingScreeningFields(deps.callState.screening);
        console.log(chalk.yellow(`[ToolExec] voicemail blocked — missing: ${missing.join(', ')}`));
        return { content: `Before sending to voicemail, ask the caller for: ${missing.join(', ')}.` };
    }

    const blocked = blockRouteIfAvailabilityUnknown(deps, destination, 'voicemail');
    if (blocked) return blocked;

    if (deps.profile.callScreening) await submitScreening(deps.participant, deps.callState);
    console.log(chalk.magentaBright(`[ToolExec] transfer_to_voicemail → ${destination}`));
    return { content: `Sending to voicemail of ${destination}.`, action: 'transfer_voicemail', destination };
};

function screeningStatus(s: CallState['screening']): string {
    const saved = [
        s.name ? `name="${s.name}"` : null,
        s.company ? `company="${s.company}"` : null,
        s.reason ? `reason="${s.reason}"` : null,
    ].filter(Boolean).join(', ');
    const missing = missingScreeningFields(s);
    if (missing.length === 0) return `Screening complete (${saved}). You may now transfer or send to voicemail.`;
    return `Saved so far: ${saved}. Still need: ${missing.join(', ')}.`;
}

const handleSaveCallerName: ToolHandler = async (args, deps) => {
    const routeBlocked = blockIfRouteNotTransferable(deps, 'screening');
    if (routeBlocked) return routeBlocked;

    const name = String(args.name ?? '');
    if (!name) return { content: 'No name provided.' };
    deps.callState.screening.name = name;
    console.log(chalk.cyan(`[ToolExec] screening.name = "${name}"`));
    return { content: `Caller name saved: ${name}. ${screeningStatus(deps.callState.screening)}` };
};

const handleSaveCallerCompany: ToolHandler = async (args, deps) => {
    const routeBlocked = blockIfRouteNotTransferable(deps, 'screening');
    if (routeBlocked) return routeBlocked;

    const company = String(args.company ?? '');
    if (!company) return { content: 'No company provided.' };
    deps.callState.screening.company = company;
    console.log(chalk.cyan(`[ToolExec] screening.company = "${company}"`));
    return { content: `Company saved: ${company}. ${screeningStatus(deps.callState.screening)}` };
};

const handleSaveCallerReason: ToolHandler = async (args, deps) => {
    const routeBlocked = blockIfRouteNotTransferable(deps, 'screening');
    if (routeBlocked) return routeBlocked;

    const reason = String(args.reason ?? '');
    if (!reason) return { content: 'No reason provided.' };
    deps.callState.screening.reason = reason;
    console.log(chalk.cyan(`[ToolExec] screening.reason = "${reason}"`));
    return { content: `Reason saved: ${reason}. ${screeningStatus(deps.callState.screening)}` };
};

function blockIfRouteNotTransferable(deps: ToolDeps, action: string): ToolResult | null {
    const route = deps.callState.pendingRoute;
    if (!isRouteNotTransferable(route, deps.profile.checkAvailability ?? false)) return null;
    const block = availabilityUnknownHint(route);
    console.log(chalk.yellow(`[ToolExec] ${action} blocked — ${block}`));
    return { content: block };
}

function blockRouteIfAvailabilityUnknown(deps: ToolDeps, destination: string, action: string): ToolResult | null {
    if (!deps.profile.checkAvailability) return null;
    const block = blockIfAvailabilityUnknown(deps.callState.pendingRoute, destination);
    if (!block) return null;
    console.log(chalk.yellow(`[ToolExec] ${action} blocked — ${block}`));
    return { content: block };
}

function createMcpHandler(toolName: string): ToolHandler {
    return async (args, deps) => {
        if (!deps.mcpManager) return {
            content: `TOOL_FAILURE: ${toolName} is unavailable. Do not infer or invent any result.`,
            failed: true,
            failureReply: '抱歉，系统暂时无法完成查询，请稍后再试。',
        };

        const mcpArgs = toolName === 'list_phonebook'
            ? {
                ...args,
                searchExtensions: true,
                searchCompany: false,
                searchPersonal: false,
                searchGroup: false,
            }
            : args;

        console.log(chalk.cyan(`[MCP] calling tool "${toolName}"`, JSON.stringify(mcpArgs)));
        try {
            const result = await deps.mcpManager.callTool(toolName, mcpArgs);
            console.log(chalk.cyan(`[MCP] tool "${toolName}" result:`, result.substring(0, 300)));

            if (toolName === 'list_phonebook') {
                const { content, pendingRoute } = finalizePhonebookResult(result, deps.profile.checkAvailability ?? false);
                deps.callState.pendingRoute = pendingRoute;
                if (pendingRoute && isRouteNotTransferable(pendingRoute, deps.profile.checkAvailability ?? false)) {
                    console.log(chalk.yellow(`[ToolExec] phonebook — ${pendingRoute.displayName} not transferable (no presence)`));
                }
                return { content };
            }

            return { content: result };
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.error(chalk.red(`[MCP] tool "${toolName}" error:`), msg);
            return {
                content: `TOOL_FAILURE: ${toolName} failed. No result was retrieved. Do not infer or invent any data. Error: ${msg}`,
                failed: true,
                failureReply: '抱歉，系统暂时无法完成查询，请稍后再试。',
            };
        }
    };
}

function createCustomMcpHandler(toolName: string): ToolHandler {
    return async (args, deps) => {
        if (!deps.customMcpRouter?.has(toolName)) {
            return {
                content: `TOOL_FAILURE: ${toolName} is unavailable. Do not infer or invent any result.`,
                failed: true,
                failureReply: '抱歉，系统暂时无法完成查询，请稍后再试。',
            };
        }
        console.log(chalk.cyan(`[CustomMCP] calling "${toolName}"`, JSON.stringify(args)));
        try {
            const result = await deps.customMcpRouter.callTool(toolName, args);
            console.log(chalk.cyan(`[CustomMCP] "${toolName}" result:`, result.substring(0, 300)));
            return { content: result };
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.error(chalk.red(`[CustomMCP] "${toolName}" error:`), msg);
            const isZohoCrm = toolName.startsWith('ZohoCRM_');
            return {
                content: `TOOL_FAILURE: ${toolName} failed. No CRM data was retrieved. Do not infer, guess, or invent names, records, counts, amounts, or statuses. Error: ${msg}`,
                failed: true,
                failureReply: isZohoCrm
                    ? '抱歉，CRM系统暂时无法查询，请稍后再试。'
                    : '抱歉，系统暂时无法完成查询，请稍后再试。',
            };
        }
    };
}

interface ZohoUser {
    id?: unknown;
    full_name?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    role?: { name?: unknown };
    profile?: { name?: unknown };
    Currency?: unknown;
}

interface ZohoDeal {
    Deal_Name?: unknown;
    Stage?: unknown;
    Amount?: unknown;
    Closing_Date?: unknown;
    Account_Name?: { name?: unknown } | unknown;
}

const CRM_FAILURE_REPLY = '抱歉，CRM系统暂时无法查询，请稍后再试。';

function crmFailure(message: string): ToolResult {
    return {
        content: `TOOL_FAILURE: ${message} No CRM data was retrieved. Do not infer or invent any result.`,
        failed: true,
        failureReply: CRM_FAILURE_REPLY,
    };
}

function parseMcpJson(raw: string): unknown {
    let value: unknown = raw.trim();
    for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) {
        try {
            value = JSON.parse(value);
        } catch {
            break;
        }
    }
    return value;
}

function findArray(value: unknown, key: string): unknown[] | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record[key])) return record[key];
    for (const child of Object.values(record)) {
        const found = findArray(child, key);
        if (found) return found;
    }
    return undefined;
}

async function getActiveCrmUsers(deps: ToolDeps): Promise<ZohoUser[]> {
    if (!deps.customMcpRouter?.has('ZohoCRM_getUsers')) {
        throw new Error('ZohoCRM_getUsers is unavailable.');
    }
    const allUsers: ZohoUser[] = [];
    for (let page = 1; page <= 20; page++) {
        const raw = await deps.customMcpRouter.callTool('ZohoCRM_getUsers', {
            query_params: { type: 'ActiveUsers', page, per_page: 200 },
        });
        const users = findArray(parseMcpJson(raw), 'users');
        if (!users) throw new Error('ZohoCRM_getUsers returned no usable users array.');
        allUsers.push(...users as ZohoUser[]);
        if (users.length < 200) return allUsers;
    }
    throw new Error('ZohoCRM_getUsers exceeded the safe pagination limit.');
}

function displayUserName(user: ZohoUser): string {
    const fullName = String(user.full_name ?? '').trim();
    if (fullName) return fullName;
    return [user.first_name, user.last_name].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
}

function findOwner(users: ZohoUser[], requestedName: string): ZohoUser[] {
    const needle = requestedName.trim().toLocaleLowerCase();
    if (!needle) return [];
    const exact = users.filter((user) => displayUserName(user).toLocaleLowerCase() === needle);
    if (exact.length > 0) return exact;
    return users.filter((user) => displayUserName(user).toLocaleLowerCase().includes(needle));
}

async function queryOwnerDeals(deps: ToolDeps, ownerId: string, extraCriteria = ''): Promise<ZohoDeal[]> {
    if (!deps.customMcpRouter?.has('ZohoCRM_executeCOQLQuery')) {
        throw new Error('ZohoCRM_executeCOQLQuery is unavailable.');
    }
    if (!/^\d+$/.test(ownerId)) throw new Error('CRM returned an invalid owner ID.');
    const where = `Owner = '${ownerId}'${extraCriteria}`;
    const allDeals: ZohoDeal[] = [];
    for (let offset = 0; offset < 100_000; offset += 2000) {
        const selectQuery = `select Deal_Name, Stage, Amount, Closing_Date, Account_Name, Owner from Deals where (${where}) order by Closing_Date desc limit ${offset}, 2000`;
        const raw = await deps.customMcpRouter.callTool('ZohoCRM_executeCOQLQuery', {
            body: { select_query: selectQuery },
        });
        const deals = findArray(parseMcpJson(raw), 'data');
        if (!deals) throw new Error('ZohoCRM_executeCOQLQuery returned no usable data array.');
        allDeals.push(...deals as ZohoDeal[]);
        if (deals.length < 2000) return allDeals;
    }
    throw new Error('Zoho CRM deal query exceeded the safe pagination limit.');
}

async function resolveUniqueOwner(deps: ToolDeps, requestedName: string): Promise<ZohoUser | ToolResult> {
    const users = await getActiveCrmUsers(deps);
    const matches = findOwner(users, requestedName);
    if (matches.length === 0) {
        return { content: JSON.stringify({ status: 'not_found', message: `CRM 中没有找到名为 ${requestedName} 的在职用户。` }) };
    }
    if (matches.length > 1) {
        return {
            content: JSON.stringify({
                status: 'ambiguous',
                message: '匹配到多名用户，请让来电者提供完整姓名。',
                matches: matches.map(displayUserName),
            }),
        };
    }
    return matches[0];
}

function rollingMonthDates(now = new Date()): { start: string; end: string } {
    const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(dateParts.find((part) => part.type === type)?.value);
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? year - 1 : year;
    const daysInPreviousMonth = new Date(Date.UTC(previousYear, previousMonth, 0)).getUTCDate();
    const startDay = Math.min(day, daysInPreviousMonth);
    const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { start: iso(previousYear, previousMonth, startDay), end: iso(year, month, day) };
}

const handleCrmListSalespeople: ToolHandler = async (_args, deps) => {
    try {
        const users = await getActiveCrmUsers(deps);
        const salespeople = users.filter((user) => {
            const role = String(user.role?.name ?? '');
            const profile = String(user.profile?.name ?? '');
            return /销售|sales/i.test(`${role} ${profile}`);
        }).map((user) => ({
            name: displayUserName(user),
            role: String(user.role?.name ?? ''),
            profile: String(user.profile?.name ?? ''),
        }));
        return { content: JSON.stringify({ status: 'success', count: salespeople.length, salespeople }) };
    } catch (error) {
        return crmFailure((error as Error).message);
    }
};

const handleCrmListOwnerDeals: ToolHandler = async (args, deps) => {
    const ownerName = String(args.owner_name ?? '').trim();
    if (!ownerName) return { content: JSON.stringify({ status: 'missing_owner_name', message: '请询问销售人员姓名。' }) };
    try {
        const owner = await resolveUniqueOwner(deps, ownerName);
        if ('content' in owner) return owner;
        const deals = await queryOwnerDeals(deps, String(owner.id ?? ''));
        return {
            content: JSON.stringify({
                status: 'success', owner: displayUserName(owner), count: deals.length,
                deals: deals.map((deal) => ({
                    name: String(deal.Deal_Name ?? ''), stage: String(deal.Stage ?? ''),
                    amount: deal.Amount ?? null, closing_date: deal.Closing_Date ?? null,
                    account: typeof deal.Account_Name === 'object' && deal.Account_Name
                        ? String((deal.Account_Name as { name?: unknown }).name ?? '') : '',
                })),
            }),
        };
    } catch (error) {
        return crmFailure((error as Error).message);
    }
};

const handleCrmOwnerRevenue: ToolHandler = async (args, deps) => {
    const ownerName = String(args.owner_name ?? '').trim();
    if (!ownerName) return { content: JSON.stringify({ status: 'missing_owner_name', message: '请询问销售人员姓名。' }) };
    try {
        const owner = await resolveUniqueOwner(deps, ownerName);
        if ('content' in owner) return owner;
        const range = rollingMonthDates();
        const deals = await queryOwnerDeals(
            deps,
            String(owner.id ?? ''),
            ` and Closing_Date between '${range.start}' and '${range.end}'`,
        );
        const wonDeals = deals.filter((deal) => /^(closed won|closed_won|成交|已成交|赢单|成功成交)$/i.test(String(deal.Stage ?? '').trim()));
        const amount = wonDeals.reduce((sum, deal) => {
            const value = typeof deal.Amount === 'number' ? deal.Amount : Number(String(deal.Amount ?? '').replace(/,/g, ''));
            return Number.isFinite(value) ? sum + value : sum;
        }, 0);
        return {
            content: JSON.stringify({
                status: 'success', owner: displayUserName(owner), period: range,
                closed_won_count: wonDeals.length, total_amount: amount,
                currency: owner.Currency ?? null,
            }),
        };
    } catch (error) {
        return crmFailure((error as Error).message);
    }
};

function registerBuiltinTools(registry: ToolRegistry): void {
    registry.register('transfer_call', handleTransferCall);
    registry.register('drop_call', handleDropCall);
    registry.register('transfer_to_voicemail', handleTransferToVoicemail);
    registry.register('save_caller_name', handleSaveCallerName);
    registry.register('save_caller_company', handleSaveCallerCompany);
    registry.register('save_caller_reason', handleSaveCallerReason);
    registry.register('crm_list_salespeople', handleCrmListSalespeople);
    registry.register('crm_list_owner_deals', handleCrmListOwnerDeals);
    registry.register('crm_get_owner_closed_won_revenue_last_month', handleCrmOwnerRevenue);
    registerDeskTools(registry);
}

export function createToolExecutor(deps: ToolExecutorDeps) {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const toolDeps: ToolDeps = deps;

    function setMcpToolNames(names: string[]) {
        for (const name of names) {
            if (!registry.has(name)) {
                registry.register(name, createMcpHandler(name));
            }
        }
    }

    function setCustomMcpToolNames(names: string[]) {
        for (const name of names) {
            if (!registry.has(name)) {
                registry.register(name, createCustomMcpHandler(name));
            }
        }
    }

    async function execute(toolName: string, argsJson: string): Promise<ToolResult> {
        const toolStart = Date.now();
        const args = safeParse(argsJson);
        const result = await registry.execute(toolName, args, toolDeps);
        deps.logger?.toolCall(0, toolName, Date.now() - toolStart);
        return result;
    }

    return { execute, setMcpToolNames, setCustomMcpToolNames, registry };
}

function safeParse(json: string): Record<string, unknown> {
    try { return JSON.parse(json || '{}'); }
    catch { return {}; }
}
