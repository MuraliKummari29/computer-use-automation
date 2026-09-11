/**
 * Produce the replay half of /evidence/: a successful replay, a business
 * outcome, an injected hard failure, and an approval handoff. Discovery
 * evidence comes from `npm run discover` (needs a model API key).
 *
 *   npx tsx scripts/make-evidence.ts
 */
import { ensureMockApp } from '../mock-app/server.js';
import { runReplay } from '../src/replay/run.js';
import { ScriptedOperator } from '../src/handoff/operators.js';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';

process.env.CORESERV_USER ??= 'operator';
process.env.CORESERV_PASSWORD ??= 'demo123';

const READ = existsSync('capabilities/coreserv.member.read_balances.json') ? 'capabilities/coreserv.member.read_balances.json' : 'tests/fixtures/read_balances.json';
const OPEN = 'capabilities/coreserv.member.open_subaccount.json';

const apps = [await ensureMockApp({ port: 4310, tenant: 'harbor' }), await ensureMockApp({ port: 4311, tenant: 'summit' })];
const runs: { label: string; run: () => Promise<{ status: string; evidenceDir: string }> }[] = [
  { label: 'replay: success (harbor)', run: () => runReplay({ capability: READ, params: { memberNumber: '10001' }, echo: false }) },
  { label: 'replay: business outcome MEMBER_NOT_FOUND', run: () => runReplay({ capability: READ, params: { memberNumber: '99999' }, echo: false }) },
  { label: 'replay: recoverable interstitial + session expiry', run: () => runReplay({ capability: READ, params: { memberNumber: '10003' }, fault: 'session_expired', echo: false }) },
  { label: 'replay: second tenant via overrides (summit)', run: () => runReplay({ capability: READ, params: { memberNumber: '10042' }, tenantId: 'summit', echo: false }) },
  { label: 'replay: validation rejected (business outcome)', run: () => runReplay({ capability: OPEN, params: { memberNumber: '10001', product: 'CLUB', nickname: 'Evidence', initialDeposit: '5' }, approveIrreversible: true, echo: false }) },
  { label: 'replay: hard failure APP_ERROR with trace', run: () => runReplay({ capability: OPEN, params: { memberNumber: '10001', product: 'CLUB', nickname: 'Evidence', initialDeposit: '50' }, approveIrreversible: true, fault: 'app_error', echo: false }) },
  { label: 'replay: permission denied (business outcome, block_card)', run: () => runReplay({ capability: 'capabilities/coreserv.member.block_card.json', params: { memberNumber: '10001' }, approveIrreversible: true, fault: 'permission_denied', echo: false }) },
  {
    label: 'replay: irreversible step escalated to human, approved, completed',
    run: () =>
      runReplay({
        capability: OPEN,
        params: { memberNumber: '10003', product: 'SAV2', nickname: 'Evidence', initialDeposit: '10' },
        operator: new ScriptedOperator((req) => ({ resolution: req.options.includes('approve') ? 'approve' : 'abort', operator: 'reviewer', notes: 'scripted operator for evidence generation' })),
        echo: false,
      }),
  },
];
const rows: string[] = [];
for (const r of runs) {
  const res = await r.run();
  console.log(`${res.status.padEnd(17)} ${r.label}  ->  ${res.evidenceDir}`);
  rows.push(`| ${r.label} | \`${res.status}\` | [${res.evidenceDir.replace(/^evidence\//, '')}](${res.evidenceDir.replace(/^evidence\//, '')}/) |`);
}
const discovery = readdirSync('evidence').filter((d) => d.startsWith('discovery-'));
writeFileSync(
  'evidence/INDEX.md',
  `# Evidence index

Each directory holds \`run.jsonl\` (structured, redacted log), \`step-NN.png\` screenshots, \`result.json\`, and on failure
\`failure.png\` + \`trace.zip\` (\`npx playwright show-trace <file>\`). Handoffs add \`intervention-N.json\`.

## Discovery (real LLM-driven runs)

${discovery.length ? discovery.map((d) => `- [${d}](${d}/): transcript.json, capability.json, screenshots, run.jsonl`).join('\n') : '- (none yet: run `npm run discover`)'}

## Replay (deterministic, no model)

| Scenario | Result | Evidence |
|---|---|---|
${rows.join('\n')}
`,
);
for (const a of apps) await a.close();
