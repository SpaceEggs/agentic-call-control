import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { CustomMcpRouter } from '@3cx-examples/mcp';
import type { DeskConfig, DeskToolNames } from '../app-config.ts';
import type { ToolDeps, ToolHandler, ToolResult, ToolRegistry } from './tool-registry.ts';

const DEFAULT_DESK_TOOL_NAMES: DeskToolNames = {
    getOrganizations: 'ZohoDesk_getOrganizations',
    searchSolutions: 'ZohoDesk_searchSolutions',
    getArticle: 'ZohoDesk_getArticle',
    searchContacts: 'ZohoDesk_searchContacts',
    createContact: 'ZohoDesk_createContact',
    searchTickets: 'ZohoDesk_searchTickets',
    createTicket: 'ZohoDesk_createTicket',
    getDepartments: 'ZohoDesk_getDepartments',
};

type DeskLanguage = 'en' | 'zh';

function deskLanguage(deps: ToolDeps): DeskLanguage {
    return deps.profile.language?.toLocaleLowerCase().startsWith('en') ? 'en' : 'zh';
}

function lookupFailureReply(language: DeskLanguage): string {
    return language === 'en'
        ? 'I am sorry, I cannot verify the knowledge base right now; would you like me to create a human support ticket?'
        : '抱歉，我暂时无法核实知识库内容，请问需要为您创建人工工单吗？';
}

function ticketFailureReply(language: DeskLanguage): string {
    return language === 'en'
        ? 'I am sorry, the ticket was not created; please try again later.'
        : '抱歉，工单暂时未能创建成功，请稍后再试。';
}

export const TOOL_DESK_SEARCH_KNOWLEDGE: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'desk_search_knowledge',
        description: 'Search the approved Zoho Desk knowledge base and return the full content of the best published article. Use for company product or support questions before offering a human ticket.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The caller\'s complete support question in their own words' },
            },
            required: ['question'],
        },
    },
};

export const TOOL_DESK_CREATE_SUPPORT_TICKET: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'desk_create_support_ticket',
        description: 'Create or reuse a Zoho Desk phone support ticket only after the caller explicitly agrees and their surname and company are saved; summarize the unresolved issue from the earlier conversation without asking for it again.',
        parameters: {
            type: 'object',
            properties: {
                confirmed: { type: 'boolean', description: 'True only when the caller explicitly agreed to create a ticket' },
                issue_summary: { type: 'string', description: 'A concise factual summary of the unresolved issue' },
            },
            required: ['confirmed', 'issue_summary'],
        },
    },
};

export function resolveDeskToolNames(config?: DeskConfig): DeskToolNames {
    return { ...DEFAULT_DESK_TOOL_NAMES, ...(config?.toolNames ?? {}) };
}

export function deskToolsReady(config: DeskConfig | undefined, router: CustomMcpRouter | undefined): boolean {
    if (!config?.enabled || !config.orgId?.trim() || !config.departmentId?.trim() || !router) return false;
    const names = resolveDeskToolNames(config);
    return [
        names.searchSolutions,
        names.getArticle,
        names.searchContacts,
        names.createContact,
        names.searchTickets,
        names.createTicket,
    ].every((name) => router.hasAvailable(name));
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

function findArray(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
    }
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'articles', 'solutions', 'contacts', 'tickets']) {
        const found = findArray(record[key]);
        if (found.length > 0) return found;
    }
    for (const child of Object.values(record)) {
        const found = findArray(child);
        if (found.length > 0) return found;
    }
    return [];
}

function findRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = findRecord(child);
            if (found) return found;
        }
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.id || record.articleId || record.ticketNumber) return record;
    for (const child of Object.values(record)) {
        const found = findRecord(child);
        if (found) return found;
    }
    return undefined;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    }
    return '';
}

function stripHtml(value: string): string {
    return value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function deskSearchQueries(question: string): string[] {
    const normalized = question
        .normalize('NFKC')
        .replace(/[，。！？；：、,.!?;:()[\]{}"“”'‘’/\\]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const candidates: string[] = [];
    const add = (value: string): void => {
        const candidate = value.trim();
        if (candidate.length >= 3 && !candidates.includes(candidate)) candidates.push(candidate);
    };

    for (const chunk of normalized.match(/\p{Script=Han}+/gu) ?? []) {
        const interrogative = chunk.match(/(?:如何|怎么|怎样|为何|能否|是否)(\p{Script=Han}{2,})/u);
        if (interrogative) {
            const start = chunk.indexOf(interrogative[0]);
            add(chunk.slice(start, start + 4));
        }
    }

    const latinTerms = normalized.match(/[A-Za-z0-9][A-Za-z0-9.+_-]{2,}/g) ?? [];
    for (const term of latinTerms.sort((left, right) => right.length - left.length)) add(term);

    for (const rawChunk of normalized.match(/\p{Script=Han}+/gu) ?? []) {
        const chunk = rawChunk
            .replace(/^(?:请问|请帮我|帮我|我想|想要|想了解|了解一下|查询|查一下|关于)+/u, '')
            .replace(/(?:怎么办|怎么处理|如何处理|可以吗|能否|是否|吗|呢|一下)+$/u, '');
        if (chunk.length <= 8) add(chunk);
        for (let index = 0; index + 4 <= chunk.length && candidates.length < 10; index += 1) {
            add(chunk.slice(index, index + 4));
        }
    }
    add(normalized);
    return candidates.slice(0, 10);
}

function deskFailure(content: string, failureReply: string): ToolResult {
    return { content: `TOOL_FAILURE: ${content}`, failed: true, failureReply };
}

async function callDeskTool(
    deps: ToolDeps,
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    if (!deps.customMcpRouter?.hasAvailable(name)) throw new Error('Desk dependency is unavailable');
    return deps.customMcpRouter.callAvailableTool(name, args);
}

const handleDeskSearchKnowledge: ToolHandler = async (args, deps) => {
    const question = String(args.question ?? '').trim();
    const language = deskLanguage(deps);
    if (!question) return { content: JSON.stringify({ status: 'missing_question' }) };
    if (!deps.desk?.departmentId) return deskFailure('Desk is not configured.', lookupFailureReply(language));

    const names = resolveDeskToolNames(deps.desk);
    try {
        let candidate: Record<string, unknown> | undefined;
        for (const searchQuery of deskSearchQueries(question)) {
            const searchRaw = await callDeskTool(deps, names.searchSolutions, {
                query_params: {
                    orgId: deps.desk.orgId,
                    _all: searchQuery,
                    departmentId: deps.desk.departmentId,
                    from: '0',
                    limit: '5',
                    sortBy: 'relevance',
                },
            });
            candidate = findArray(parseMcpJson(searchRaw)).find((item) => {
                const status = stringField(item, 'status', 'publishStatus').toLocaleLowerCase();
                return !status || /publish|public|active/.test(status);
            });
            if (candidate) break;
        }
        if (!candidate) {
            return { content: JSON.stringify({ status: 'no_match', question }) };
        }

        const articleId = stringField(candidate, 'id', 'articleId', 'solutionId');
        if (!articleId) return { content: JSON.stringify({ status: 'no_match', question }) };
        const articleRaw = await callDeskTool(deps, names.getArticle, {
            query_params: { orgId: deps.desk.orgId },
            path_variables: { id: articleId },
        });
        const article = findRecord(parseMcpJson(articleRaw)) ?? candidate;
        const content = stripHtml(stringField(article, 'answer', 'content', 'description', 'body', 'summary'));
        if (!content) return { content: JSON.stringify({ status: 'no_match', question }) };

        return {
            content: JSON.stringify({
                status: 'found',
                question,
                article: {
                    title: stringField(article, 'title', 'subject', 'name'),
                    content: content.slice(0, 6_000),
                    permalink: stringField(article, 'permalink', 'webUrl', 'url'),
                },
                rule: 'Answer only when this article directly and completely resolves the question; otherwise treat it as no_match and offer a human ticket.',
            }),
        };
    } catch {
        console.error('[Desk] knowledge lookup failed');
        return deskFailure('Knowledge lookup failed; do not infer an answer.', lookupFailureReply(language));
    }
};

function normalizePhone(value: string): string {
    return value.replace(/\D/g, '');
}

function normalizeIssue(value: string): string {
    return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 160);
}

function hasExplicitConfirmation(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value !== 'string') return false;
    return new Set(['true', 'yes', 'confirmed', 'confirm', '确认', '同意', '是', '对'])
        .has(value.trim().toLocaleLowerCase());
}

function contactMatches(contact: Record<string, unknown>, phone: string, name: string): boolean {
    const expectedPhone = normalizePhone(phone);
    const phones = [stringField(contact, 'phone'), stringField(contact, 'mobile')]
        .map(normalizePhone)
        .filter(Boolean);
    if (!expectedPhone || !phones.includes(expectedPhone)) return false;
    const contactName = [
        stringField(contact, 'firstName'),
        stringField(contact, 'lastName'),
    ].filter(Boolean).join(' ').trim();
    return !contactName || contactName.toLocaleLowerCase() === name.toLocaleLowerCase();
}

function isRecentOpenTicket(ticket: Record<string, unknown>, issueKey: string, windowHours: number): boolean {
    const status = stringField(ticket, 'status', 'statusType').toLocaleLowerCase();
    if (/closed|resolved|完成|关闭/.test(status)) return false;
    const subjectKey = normalizeIssue(stringField(ticket, 'subject'));
    if (!subjectKey || !issueKey) return false;
    if (!subjectKey.includes(issueKey) && !issueKey.includes(subjectKey)) return false;
    const created = Date.parse(stringField(ticket, 'createdTime', 'createdAt'));
    return !Number.isFinite(created) || Date.now() - created <= windowHours * 3_600_000;
}

function spokenTicketNumber(value: string, language: DeskLanguage): string {
    const digits: Record<DeskLanguage, Record<string, string>> = {
        en: {
            '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
            '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
        },
        zh: {
            '0': '零', '1': '一', '2': '二', '3': '三', '4': '四',
            '5': '五', '6': '六', '7': '七', '8': '八', '9': '九',
        },
    };
    return [...value].map((character) => digits[language][character] ?? character)
        .join(language === 'en' ? ' ' : '');
}

function ticketResult(ticket: Record<string, unknown>, reused: boolean, language: DeskLanguage): ToolResult {
    const ticketNumber = stringField(ticket, 'ticketNumber', 'number');
    return {
        content: JSON.stringify({
            status: reused ? 'existing_ticket' : 'created',
            ticket_created: !reused,
            ticket_ready: true,
            ticket_number: ticketNumber,
            ticket_number_spoken: spokenTicketNumber(ticketNumber, language),
            message: language === 'en'
                ? (reused
                    ? 'An existing open ticket for the same issue will be used.'
                    : 'A human support ticket was created for a callback to the caller number.')
                : (reused
                    ? '已找到同一问题的未关闭工单。'
                    : '人工支持工单已创建，客服将通过来电号码回拨。'),
        }),
    };
}

const handleDeskCreateSupportTicket: ToolHandler = async (args, deps) => {
    const language = deskLanguage(deps);
    if (!hasExplicitConfirmation(args.confirmed)) {
        return {
            content: JSON.stringify({
                status: 'confirmation_required',
                ticket_created: false,
                ticket_ready: false,
                message: language === 'en'
                    ? 'The ticket was not created because the caller has not explicitly agreed.'
                    : '工单尚未创建；必须先取得客户明确同意。',
            }),
        };
    }
    const issueSummary = String(args.issue_summary ?? '').trim();
    if (!issueSummary) {
        return {
            content: JSON.stringify({
                status: 'missing_issue_summary',
                ticket_created: false,
                ticket_ready: false,
                message: language === 'en'
                    ? 'The ticket was not created because the issue summary is missing.'
                    : '工单尚未创建；缺少问题摘要。',
            }),
        };
    }
    if (!deps.desk?.departmentId) return deskFailure('Desk is not configured.', ticketFailureReply(language));

    const missing: string[] = [];
    if (!deps.callState.screening.name) missing.push(language === 'en' ? 'surname' : '姓氏');
    if (!deps.callState.screening.company) missing.push(language === 'en' ? 'company name' : '公司名称');
    if (missing.length > 0) {
        return {
            content: JSON.stringify({
                status: 'screening_required',
                ticket_created: false,
                ticket_ready: false,
                message: language === 'en'
                    ? `The ticket was not created; please confirm the caller's ${missing.join(' and ')}.`
                    : `创建工单前请确认：${missing.join('、')}。`,
            }),
        };
    }
    const callerNumber = deps.callState.callerInfo.number.trim();
    if (!callerNumber) {
        return {
            content: JSON.stringify({
                status: 'caller_number_required',
                ticket_created: false,
                ticket_ready: false,
                message: language === 'en'
                    ? 'The ticket was not created because no callback number is available.'
                    : '工单尚未创建；无法取得回拨号码，不能创建电话回拨工单。',
            }),
        };
    }

    const issueKey = normalizeIssue(issueSummary);
    if (deps.callState.deskTicket?.issueKey === issueKey) {
        return ticketResult({
            id: deps.callState.deskTicket.ticketId,
            ticketNumber: deps.callState.deskTicket.ticketNumber,
        }, true, language);
    }

    const names = resolveDeskToolNames(deps.desk);
    const callerName = deps.callState.screening.name!;
    const company = deps.callState.screening.company!;
    const originalReason = deps.callState.screening.reason?.trim() || issueSummary;
    try {
        const contactsRaw = await callDeskTool(deps, names.searchContacts, {
            query_params: {
                orgId: deps.desk.orgId,
                phone: [callerNumber],
                from: '0',
                limit: '20',
            },
        });
        const contacts = findArray(parseMcpJson(contactsRaw));
        let contact = contacts.find((item) => contactMatches(item, callerNumber, callerName));
        if (!contact) {
            const nameParts = callerName.split(/\s+/).filter(Boolean);
            const lastName = nameParts.pop() ?? callerName;
            const firstName = nameParts.join(' ');
            const createdRaw = await callDeskTool(deps, names.createContact, {
                body: {
                    firstName: firstName || undefined,
                    lastName,
                    phone: callerNumber,
                },
                query_params: { orgId: deps.desk.orgId },
            });
            contact = findRecord(parseMcpJson(createdRaw));
        }
        const contactId = contact ? stringField(contact, 'id', 'contactId') : '';
        if (!contactId) throw new Error('Desk contact has no ID');

        const ticketsRaw = await callDeskTool(deps, names.searchTickets, {
            query_params: {
                orgId: deps.desk.orgId,
                // Zoho's MCP schema declares an array here, but the Desk API adapter
                // accepts only one int64 value and rejects an array as the wrong datatype.
                contactId,
                departmentId: deps.desk.departmentId,
                from: '0',
                limit: '100',
                sortBy: '-createdTime',
            },
        });
        const duplicateWindowHours = deps.desk.duplicateWindowHours ?? 72;
        const existing = findArray(parseMcpJson(ticketsRaw))
            .find((ticket) => isRecentOpenTicket(ticket, issueKey, duplicateWindowHours));
        if (existing) {
            deps.callState.deskTicket = {
                issueKey,
                ticketId: stringField(existing, 'id'),
                ticketNumber: stringField(existing, 'ticketNumber', 'number'),
            };
            return ticketResult(existing, true, language);
        }

        const subject = `${language === 'en' ? '[AI Call]' : '[AI来电]'} ${issueSummary}`.slice(0, 255);
        const description = language === 'en'
            ? [
                `Caller: ${callerName}`,
                `Company: ${company}`,
                `Callback number: ${callerNumber}`,
                `Issue summary: ${issueSummary}`,
                `Caller's original reason: ${originalReason}`,
                `Call time: ${new Date().toISOString()}`,
                'Knowledge base result: No published article fully answered the question.',
            ].join('\n')
            : [
                `来电人：${callerName}`,
                `公司：${company}`,
                `回拨号码：${callerNumber}`,
                `问题摘要：${issueSummary}`,
                `客户原始事由：${originalReason}`,
                `来电时间：${new Date().toISOString()}`,
                '知识库结果：没有可直接、完整回答该问题的已发布文章。',
            ].join('\n');
        const createdRaw = await callDeskTool(deps, names.createTicket, {
            body: {
                subject,
                departmentId: deps.desk.departmentId,
                contactId,
                description,
                phone: callerNumber,
                channel: deps.desk.channel ?? 'Phone',
                status: 'Open',
                priority: deps.desk.priority ?? 'Medium',
            },
            query_params: { orgId: deps.desk.orgId },
        });
        const created = findRecord(parseMcpJson(createdRaw));
        if (!created || !stringField(created, 'id')) throw new Error('Desk ticket has no ID');
        deps.callState.deskTicket = {
            issueKey,
            ticketId: stringField(created, 'id'),
            ticketNumber: stringField(created, 'ticketNumber', 'number'),
        };
        return ticketResult(created, false, language);
    } catch {
        console.error('[Desk] support ticket creation failed');
        return deskFailure(
            'Ticket creation failed; never claim success or invent a ticket number.',
            ticketFailureReply(language),
        );
    }
};

export function registerDeskTools(registry: ToolRegistry): void {
    registry.register('desk_search_knowledge', handleDeskSearchKnowledge);
    registry.register('desk_create_support_ticket', handleDeskCreateSupportTicket);
}
