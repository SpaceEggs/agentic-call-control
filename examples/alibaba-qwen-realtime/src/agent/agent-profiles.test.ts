import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAgentProfile, renderPrompt } from './agent-profiles.ts';

test('English demo profile exposes only local Desk semantic tools and has no CRM or phonebook workflow', () => {
    const profile = loadAgentProfile('receptionist_en');
    assert.equal(profile.language, 'en');
    assert.equal(profile.voice, 'Serena');
    assert.deepEqual(profile.mcpTools, []);
    assert.doesNotMatch(profile.prompt, /ZohoCRM|crm_|list_phonebook|Phonebook:/);

    const prompt = renderPrompt(profile, {
        company_name: 'PBX Service',
        agent_name: 'Qwen',
        caller_name: 'Alex',
        caller_number: '+15550100',
    }, [
        {
            type: 'function',
            function: {
                name: 'desk_search_knowledge',
                description: 'Search approved support content.',
                parameters: { type: 'object', properties: {} },
            },
        },
        {
            type: 'function',
            function: {
                name: 'desk_create_support_ticket',
                description: 'Create a support ticket.',
                parameters: { type: 'object', properties: {} },
            },
        },
    ]);
    assert.match(prompt, /For every company-specific 3CX/);
    assert.doesNotMatch(prompt, /support lookup is temporarily unavailable/);
});
