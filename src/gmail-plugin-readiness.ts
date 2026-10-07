import type { Rpc } from './app-server.js';

export interface GmailPluginReadiness {
    ok: boolean;
    code: string;
    phase: 'login' | 'connection' | 'tools' | 'direct-call' | 'identity';
    appId?: string;
    directProfileVerified: boolean;
    deliveryVerified: false;
    session?: { threadId: string; routes: Record<string, { server: string; tool: string }> };
}

// This probe never runs a model, sends mail or changes the account/configuration.
// Metadata alone cannot establish that host-invoked connector calls work.
export async function inspectGmailPlugin(rpc: Rpc, expectedAddress: string): Promise<GmailPluginReadiness> {
    const report: GmailPluginReadiness = { ok: false, code: 'MAIL_CODEX_CHATGPT_LOGIN_REQUIRED', phase: 'login', directProfileVerified: false, deliveryVerified: false };
    try {
        const account = await rpc.request('account/read', { refreshToken: false });
        if (account.account?.type !== 'chatgpt') return report;
        report.phase = 'connection';
        report.code = 'MAIL_GMAIL_PLUGIN_CONNECTION_REQUIRED';
        const installed = await rpc.request('app/installed', { forceRefresh: true });
        const candidates = (installed.apps || []).filter((app: any) => app.runtimeName?.toLowerCase() === 'gmail' && app.enabled && app.callable);
        if (candidates.length !== 1) return report;
        const appId = candidates[0].id;
        if (typeof appId !== 'string' || !appId) return report;
        report.appId = appId;
        report.phase = 'tools';
        report.code = 'MAIL_GMAIL_TOOL_CATALOG_UNAVAILABLE';
        const app = await rpc.request('app/read', { appIds: [appId], includeTools: true });
        const summaries = app.apps?.find((a: any) => a.id === appId)?.toolSummaries || [];
        const required = ['get_profile', 'search_email_ids', 'read_email', 'send_email'];
        const matches = required.map(action => summaries.filter((s: any) => s.isEnabled && typeof s.name === 'string' && (s.name === action || s.name.endsWith('gmail_' + action))));
        if (matches.some(m => m.length !== 1)) return report;
        // Explicitly disable all other tools/apps in the ephemeral probe thread.
        const tools = Object.fromEntries(matches.map(m => [m[0].name, { enabled: true }]));
        const started = await rpc.request('thread/start', {
            ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
            config: { 'features.hooks': false, 'apps._default.enabled': false,
                [`apps.${appId}.enabled`]: true, [`apps.${appId}.default_tools_enabled`]: false,
                [`apps.${appId}.tools`]: tools },
        });
        const threadId = started.thread?.id;
        if (typeof threadId !== 'string') return report;
        report.phase = 'direct-call';
        report.code = 'MAIL_GMAIL_DIRECT_CALL_UNAVAILABLE';
        let cursor: string | null = null;
        const entries: any[] = [];
        const visited = new Set<string>();
        do {
            const page = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', cursor, limit: 100 });
            if (!Array.isArray(page.data)) return report;
            entries.push(...page.data);
            cursor = page.nextCursor || null;
            if (cursor && visited.has(cursor)) return report;
            if (cursor) visited.add(cursor);
        } while (cursor);
        const routes: Record<string, { server: string; tool: string }> = {};
        for (const [index, action] of required.entries()) {
            const catalogName = matches[index][0].name;
            const found = entries.flatMap((server: any) => Object.entries(server.tools || {}).filter(([name, value]: [string, any]) =>
                name === catalogName || value?.name === catalogName || name === 'gmail.' + action || value?.name === 'gmail.' + action
            ).map(([tool]) => ({ server: server.name, tool })));
            if (found.length !== 1 || typeof found[0].server !== 'string') return report;
            routes[action] = found[0];
        }
        for(const action of required){
            const route=routes[action],server=entries.find(s=>s.name===route.server),schema=server?.tools?.[route.tool]?.inputSchema;
            const fields:Record<string,string[]>={get_profile:[],search_email_ids:['query','max_results','next_page_token'],read_email:['message_id','format'],send_email:['to','subject','payload','reply_message_id']};
            if(!schema?.properties||fields[action].some(key=>!Object.hasOwn(schema.properties,key))||action==='read_email'&&!schema.properties.format?.enum?.includes('raw')){report.code='MAIL_GMAIL_TOOL_PROTOCOL_UNSUPPORTED';return report;}
        }
        const result = await rpc.request('mcpServer/tool/call', { threadId, ...routes.get_profile, arguments: {} });
        if (result.isError) return report;
        let profile = result.structuredContent;
        if (!profile) {
            const content = result.content?.filter((c: any) => c.type === 'text');
            if (content?.length !== 1) return report;
            try { profile = JSON.parse(content[0].text); } catch { return report; }
        }
        report.phase = 'identity';
        report.code = 'MAIL_GMAIL_ACCOUNT_MISMATCH';
        const address = profile?.emailAddress || profile?.email_address || profile?.email;
        if (typeof address !== 'string' || address.toLowerCase() !== expectedAddress.toLowerCase()) return report;
        report.directProfileVerified = true;
        report.ok = true;
        report.session = { threadId, routes };
        report.code = 'MAIL_GMAIL_PROFILE_VERIFIED_MORE_ACCEPTANCE_REQUIRED';
        return report;
    } catch {
        // Do not log RPC payloads, credentials or private mail/account details.
        return report;
    }
}
