import assert from 'node:assert/strict';
import test from 'node:test';
import type { Participant } from '@3cx/call-control-sdk';
import type { CustomMcpRouter } from '@3cx-examples/mcp';
import type { DeskConfig } from '../app-config.ts';
import { createCallState } from './call-state.ts';
import { deskToolsReady, resolveDeskToolNames } from './desk-tools.ts';
import { createToolExecutor } from './tool-executor.ts';

class FakeDeskRouter {
    public readonly toolDefs: never[] = [];
    public readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    private readonly handlers = new Map<string, (args: Record<string, unknown>) => string | Promise<string>>();

    reply(name: string, handler: (args: Record<string, unknown>) => string | Promise<string>): this {
        this.handlers.set(name, handler);
        return this;
    }

    has(): boolean { return false; }
    hasAvailable(name: string): boolean { return this.handlers.has(name); }

    async callAvailableTool(name: string, args: Record<string, unknown>): Promise<string> {
        this.calls.push({ name, args });
        const handler = this.handlers.get(name);
        if (!handler) throw new Error(`Unexpected tool: ${name}`);
        return handler(args);
    }
}

const desk: DeskConfig = {
    enabled: true,
    orgId: 'organization-64',
    departmentId: 'department-42',
    departmentName: 'Support',
    duplicateWindowHours: 72,
};

function fullRouter(): FakeDeskRouter {
    const names = resolveDeskToolNames(desk);
    const router = new FakeDeskRouter();
    for (const name of Object.values(names)) router.reply(name, () => JSON.stringify({ data: [] }));
    return router;
}

function executor(router: FakeDeskRouter, language = 'zh') {
    const state = createCallState('沈先生', '+86 138-0013-8000');
    state.screening = {
        name: '沈先生',
        company: '深圳市沃宇科技有限公司',
        reason: '产品无法登录',
    };
    return {
        state,
        execute: createToolExecutor({
            participant: {} as Participant,
            customMcpRouter: router as unknown as CustomMcpRouter,
            profile: { role: 'receptionist', prompt: '', greeting: '', language },
            callState: state,
            desk,
            onCleanup: () => undefined,
        }).execute,
    };
}

test('Desk stays disabled until enabled, fixed department, and all runtime dependencies exist', () => {
    const router = fullRouter();
    assert.equal(deskToolsReady(undefined, router as unknown as CustomMcpRouter), false);
    assert.equal(deskToolsReady({ enabled: true }, router as unknown as CustomMcpRouter), false);
    assert.equal(deskToolsReady({ ...desk, orgId: '' }, router as unknown as CustomMcpRouter), false);
    assert.equal(deskToolsReady(desk, router as unknown as CustomMcpRouter), true);

    const names = resolveDeskToolNames(desk);
    // Replace the router with one that omits the ticket writer.
    const incomplete = new FakeDeskRouter();
    for (const name of Object.values(names).filter((value) => value !== names.createTicket)) {
        incomplete.reply(name, () => '{}');
    }
    assert.equal(deskToolsReady(desk, incomplete as unknown as CustomMcpRouter), false);
});

test('knowledge search returns full published article content without exposing raw Desk tools', async () => {
    const names = resolveDeskToolNames(desk);
    const router = fullRouter()
        .reply(names.searchSolutions, () => JSON.stringify({
            data: [{ id: 'article-1', title: '登录问题', status: 'Published' }],
        }))
        .reply(names.getArticle, () => JSON.stringify({
            data: { id: 'article-1', title: '登录问题', content: '<p>请先重置密码，然后重新登录。</p>' },
        }));
    const { execute } = executor(router);
    const result = await execute('desk_search_knowledge', JSON.stringify({ question: '产品无法登录怎么办？' }));
    const body = JSON.parse(result.content) as { status: string; article: { content: string } };

    assert.equal(result.failed, undefined);
    assert.equal(body.status, 'found');
    assert.equal(body.article.content, '请先重置密码，然后重新登录。');
    assert.deepEqual(router.calls.map((call) => call.name), [names.searchSolutions, names.getArticle]);
    assert.deepEqual(router.calls[0]!.args, {
        query_params: {
            orgId: 'organization-64',
            _all: '产品无法登录',
            departmentId: 'department-42',
            from: '0',
            limit: '5',
            sortBy: 'relevance',
        },
    });
    assert.deepEqual(router.calls[1]!.args, {
        query_params: { orgId: 'organization-64' },
        path_variables: { id: 'article-1' },
    });
});

test('knowledge search retries with a compact keyword when the full phrase has no match', async () => {
    const names = resolveDeskToolNames(desk);
    const router = fullRouter()
        .reply(names.searchSolutions, (args) => {
            const query = (args.query_params as { _all: string })._all;
            return JSON.stringify(query === '如何扩大'
                ? { data: [{ id: 'article-recording', title: '如何扩大存储录音', status: 'Published' }] }
                : { data: [] });
        })
        .reply(names.getArticle, () => JSON.stringify({
            id: 'article-recording',
            title: '如何扩大存储录音',
            answer: '<p>进入管理控制台的录音配额设置。</p>',
        }));
    const result = await executor(router).execute(
        'desk_search_knowledge',
        JSON.stringify({ question: '3CX如何扩大录音存储配额？' }),
    );
    const body = JSON.parse(result.content) as { status: string; article: { title: string } };

    assert.equal(body.status, 'found');
    assert.equal(body.article.title, '如何扩大存储录音');
    assert.equal(
        ((router.calls[0]!.args.query_params as { _all: string })._all),
        '如何扩大',
    );
});

test('knowledge lookup distinguishes no match from an MCP failure', async () => {
    const names = resolveDeskToolNames(desk);
    const noMatchRouter = fullRouter().reply(names.searchSolutions, () => JSON.stringify({ data: [] }));
    const noMatch = await executor(noMatchRouter).execute(
        'desk_search_knowledge', JSON.stringify({ question: '未知问题' }),
    );
    assert.equal(JSON.parse(noMatch.content).status, 'no_match');
    assert.equal(noMatch.failed, undefined);

    const failureRouter = fullRouter().reply(names.searchSolutions, () => { throw new Error('OAuth token=secret'); });
    const failure = await executor(failureRouter).execute(
        'desk_search_knowledge', JSON.stringify({ question: '未知问题' }),
    );
    assert.equal(failure.failed, true);
    assert.doesNotMatch(failure.content, /secret/);
    assert.match(failure.failureReply ?? '', /无法核实知识库/);
});

test('ticket creation requires explicit confirmation and complete screening', async () => {
    const router = fullRouter();
    const { execute, state } = executor(router);
    const unconfirmed = await execute('desk_create_support_ticket', JSON.stringify({
        confirmed: false,
        issue_summary: '无法登录',
    }));
    assert.deepEqual(JSON.parse(unconfirmed.content), {
        status: 'confirmation_required',
        ticket_created: false,
        ticket_ready: false,
        message: '工单尚未创建；必须先取得客户明确同意。',
    });
    assert.equal(router.calls.length, 0);

    const missingConfirmation = await execute('desk_create_support_ticket', JSON.stringify({
        issue_summary: '无法登录',
    }));
    assert.equal(JSON.parse(missingConfirmation.content).ticket_created, false);
    assert.equal(router.calls.length, 0);

    state.screening.company = undefined;
    const incomplete = await execute('desk_create_support_ticket', JSON.stringify({
        confirmed: true,
        issue_summary: '无法登录',
    }));
    assert.equal(JSON.parse(incomplete.content).status, 'screening_required');
    assert.equal(router.calls.length, 0);
});

test('ticket creation accepts explicit Qwen confirmation strings but rejects ambiguous values', async () => {
    const names = resolveDeskToolNames(desk);
    const router = fullRouter()
        .reply(names.searchContacts, () => JSON.stringify({ data: [{ id: 'contact-7', phone: '+86 138-0013-8000' }] }))
        .reply(names.searchTickets, () => JSON.stringify({ data: [] }))
        .reply(names.createTicket, () => JSON.stringify({ data: { id: 'ticket-9', ticketNumber: '109' } }));
    const { execute, state } = executor(router);
    state.screening.reason = undefined;

    const rejected = await execute('desk_create_support_ticket', JSON.stringify({
        confirmed: 'maybe',
        issue_summary: '产品无法登录',
    }));
    assert.equal(JSON.parse(rejected.content).status, 'confirmation_required');
    assert.equal(router.calls.length, 0);

    const created = await execute('desk_create_support_ticket', JSON.stringify({
        confirmed: ' 同意 ',
        issue_summary: '产品无法登录',
    }));
    assert.equal(JSON.parse(created.content).status, 'created');
    assert.equal(JSON.parse(created.content).ticket_created, true);
    assert.equal(JSON.parse(created.content).ticket_ready, true);
    assert.equal(router.calls.filter((call) => call.name === names.createTicket).length, 1);
    const ticketBody = router.calls.find((call) => call.name === names.createTicket)!.args.body as { description: string };
    assert.match(ticketBody.description, /客户原始事由：产品无法登录/);
});

test('ticket workflow creates once, uses the 3CX caller number, and reuses within the call', async () => {
    const names = resolveDeskToolNames(desk);
    const router = fullRouter()
        .reply(names.searchContacts, () => JSON.stringify({ data: [] }))
        .reply(names.createContact, () => JSON.stringify({ data: { id: 'contact-7' } }))
        .reply(names.searchTickets, () => JSON.stringify({ data: [] }))
        .reply(names.createTicket, () => JSON.stringify({ data: { id: 'ticket-9', ticketNumber: '109' } }));
    const { execute } = executor(router);
    const args = JSON.stringify({ confirmed: true, issue_summary: '产品无法登录' });
    const created = await execute('desk_create_support_ticket', args);
    const repeated = await execute('desk_create_support_ticket', args);

    assert.equal(JSON.parse(created.content).status, 'created');
    assert.equal(JSON.parse(created.content).ticket_created, true);
    assert.equal(JSON.parse(created.content).ticket_ready, true);
    assert.equal(JSON.parse(created.content).ticket_number, '109');
    assert.equal(JSON.parse(created.content).ticket_number_spoken, '一零九');
    assert.equal(JSON.parse(repeated.content).status, 'existing_ticket');
    assert.equal(JSON.parse(repeated.content).ticket_created, false);
    assert.equal(JSON.parse(repeated.content).ticket_ready, true);
    assert.equal(JSON.parse(repeated.content).ticket_number_spoken, '一零九');
    assert.equal(router.calls.filter((call) => call.name === names.createTicket).length, 1);

    const contactCall = router.calls.find((call) => call.name === names.createContact)!;
    assert.equal((contactCall.args.body as { phone: string }).phone, '+86 138-0013-8000');
    assert.deepEqual(contactCall.args.query_params, { orgId: 'organization-64' });
    const contactSearch = router.calls.find((call) => call.name === names.searchContacts)!;
    assert.deepEqual(contactSearch.args.query_params, {
        orgId: 'organization-64',
        phone: ['+86 138-0013-8000'],
        from: '0',
        limit: '20',
    });
    const ticketSearch = router.calls.find((call) => call.name === names.searchTickets)!;
    assert.deepEqual(ticketSearch.args.query_params, {
        orgId: 'organization-64',
        contactId: 'contact-7',
        departmentId: 'department-42',
        from: '0',
        limit: '100',
        sortBy: '-createdTime',
    });
    const ticketCall = router.calls.find((call) => call.name === names.createTicket)!;
    const body = ticketCall.args.body as Record<string, unknown>;
    assert.equal(body.departmentId, 'department-42');
    assert.equal(body.contactId, 'contact-7');
    assert.equal(body.channel, 'Phone');
    assert.deepEqual(ticketCall.args.query_params, { orgId: 'organization-64' });
});

test('ticket failure never returns a fabricated success or upstream secret', async () => {
    const names = resolveDeskToolNames(desk);
    const router = fullRouter().reply(names.searchContacts, () => { throw new Error('MCP URL secret-value'); });
    const result = await executor(router).execute('desk_create_support_ticket', JSON.stringify({
        confirmed: true,
        issue_summary: '产品无法登录',
    }));

    assert.equal(result.failed, true);
    assert.doesNotMatch(result.content, /secret-value|ticket_number|created/);
    assert.match(result.failureReply ?? '', /未能创建成功/);
});

test('English Desk workflow localizes messages, ticket content, and spoken ticket digits', async () => {
    const names = resolveDeskToolNames(desk);
    const router = fullRouter()
        .reply(names.searchContacts, () => JSON.stringify({ data: [] }))
        .reply(names.createContact, () => JSON.stringify({ data: { id: 'contact-7' } }))
        .reply(names.searchTickets, () => JSON.stringify({ data: [] }))
        .reply(names.createTicket, () => JSON.stringify({ data: { id: 'ticket-9', ticketNumber: '109' } }));
    const { execute } = executor(router, 'en');

    const unconfirmed = await execute('desk_create_support_ticket', JSON.stringify({
        confirmed: false,
        issue_summary: 'SIP trunk intermittently drops outbound calls',
    }));
    assert.match(JSON.parse(unconfirmed.content).message, /not created.*explicitly agreed/i);

    const created = await execute('desk_create_support_ticket', JSON.stringify({
        confirmed: true,
        issue_summary: 'SIP trunk intermittently drops outbound calls',
    }));
    const body = JSON.parse(created.content) as Record<string, unknown>;
    assert.equal(body.status, 'created');
    assert.equal(body.ticket_number_spoken, 'one zero nine');
    assert.match(String(body.message), /created.*callback/i);

    const ticketBody = router.calls.find((call) => call.name === names.createTicket)!.args.body as {
        subject: string;
        description: string;
    };
    assert.equal(ticketBody.subject, '[AI Call] SIP trunk intermittently drops outbound calls');
    assert.match(ticketBody.description, /^Caller: 沈先生/m);
    assert.match(ticketBody.description, /^Company: 深圳市沃宇科技有限公司/m);
    assert.match(ticketBody.description, /^Callback number: \+86 138-0013-8000/m);
    assert.match(ticketBody.description, /^Issue summary: SIP trunk intermittently drops outbound calls/m);
    assert.match(ticketBody.description, /^Knowledge base result: No published article fully answered the question\.$/m);
});

test('English Desk failures do not leak Chinese caller-facing messages', async () => {
    const names = resolveDeskToolNames(desk);
    const router = fullRouter().reply(names.searchSolutions, () => { throw new Error('upstream secret'); });
    const result = await executor(router, 'en').execute(
        'desk_search_knowledge', JSON.stringify({ question: 'How do I configure voicemail?' }),
    );

    assert.equal(result.failed, true);
    assert.match(result.failureReply ?? '', /cannot verify the knowledge base/i);
    assert.doesNotMatch(result.failureReply ?? '', /[\u3400-\u9fff]/u);
    assert.doesNotMatch(result.content, /secret/);
});
