import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { AgentProfile } from './agent-profiles.ts';

export const TOOL_SAVE_CALLER_NAME: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'save_caller_name',
        description: 'Record the caller\'s name into the system.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The caller\'s full name' },
            },
            required: ['name'],
        },
    },
};

export const TOOL_SAVE_CALLER_COMPANY: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'save_caller_company',
        description: 'Record the caller\'s company into the system.',
        parameters: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'The company name' },
            },
            required: ['company'],
        },
    },
};

export const TOOL_SAVE_CALLER_REASON: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'save_caller_reason',
        description: 'Record the reason for calling into the system.',
        parameters: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'The reason for calling' },
            },
            required: ['reason'],
        },
    },
};

export const TOOL_TRANSFER_CALL: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'transfer_call',
        description: 'Transfer the current call to an extension.',
        parameters: {
            type: 'object',
            properties: {
                destination: { type: 'string', description: 'Extension number to transfer to' },
            },
            required: ['destination'],
        },
    },
};

export const TOOL_DROP_CALL: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'drop_call',
        description: 'Hang up after a brief goodbye when the caller wants to end the call.',
        parameters: { type: 'object', properties: {} },
    },
};

export const TOOL_TRANSFER_TO_VOICEMAIL: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'transfer_to_voicemail',
        description: 'Send the current call to voicemail of the specified extension.',
        parameters: {
            type: 'object',
            properties: {
                destination: { type: 'string', description: 'Extension number whose voicemail to send to' },
            },
            required: ['destination'],
        },
    },
};

export const TOOL_CRM_LIST_SALESPEOPLE: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'crm_list_salespeople',
        description: 'Reliably list active CRM salespeople. Use this exact tool for questions such as “CRM 里有哪些销售人员？”.',
        parameters: { type: 'object', properties: {} },
    },
};

export const TOOL_CRM_LIST_OWNER_DEALS: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'crm_list_owner_deals',
        description: 'Reliably list CRM deals owned by a named salesperson. Pass owner_name exactly as the caller said it; never autocorrect or substitute a similar name.',
        parameters: {
            type: 'object',
            properties: {
                owner_name: { type: 'string', description: 'CRM user name copied exactly from the caller’s latest utterance' },
            },
            required: ['owner_name'],
        },
    },
};

export const TOOL_CRM_GET_OWNER_REVENUE: ChatCompletionFunctionTool = {
    type: 'function',
    function: {
        name: 'crm_get_owner_closed_won_revenue_last_month',
        description: 'Reliably calculate the total Amount of closed-won CRM deals owned by a named salesperson during the rolling month ending today. Pass owner_name exactly as the caller said it.',
        parameters: {
            type: 'object',
            properties: {
                owner_name: { type: 'string', description: 'CRM user name copied exactly from the caller’s latest utterance' },
            },
            required: ['owner_name'],
        },
    },
};

export function buildLocalTools(opts?: { callScreening?: boolean; crmQueries?: boolean }): ChatCompletionFunctionTool[] {
    const tools: ChatCompletionFunctionTool[] = [
        TOOL_TRANSFER_CALL,
        TOOL_DROP_CALL,
        TOOL_TRANSFER_TO_VOICEMAIL,
    ];
    if (opts?.callScreening) {
        tools.push(TOOL_SAVE_CALLER_NAME, TOOL_SAVE_CALLER_COMPANY, TOOL_SAVE_CALLER_REASON);
    }
    if (opts?.crmQueries) {
        tools.push(TOOL_CRM_LIST_SALESPEOPLE, TOOL_CRM_LIST_OWNER_DEALS, TOOL_CRM_GET_OWNER_REVENUE);
    }
    return tools;
}

export function isExtensionAllowed(
    ext: string,
    profile: AgentProfile,
): boolean {
    if (profile.allowedExtensions?.length) {
        return profile.allowedExtensions.some((rule) => matchExtensionRule(ext, rule));
    }
    if (profile.blockedExtensions?.length) {
        return !profile.blockedExtensions.some((rule) => matchExtensionRule(ext, rule));
    }
    return true;
}

function matchExtensionRule(ext: string, rule: string): boolean {
    if (rule.includes('-')) {
        const [lo, hi] = rule.split('-');
        const n = parseInt(ext, 10);
        return n >= parseInt(lo, 10) && n <= parseInt(hi, 10);
    }
    return ext === rule;
}
