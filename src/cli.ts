#!/usr/bin/env tsx
/**
 * CLI entry points.
 *
 *   discover  run the LLM-driven discovery agent on a goal and save a capability
 *   replay    replay a saved capability with typed params (no LLM)
 *   catalog   list saved capabilities as an agent-facing tool catalog, or invoke one
 *   schemas   export JSON Schemas for the artifact, result and policy contracts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchemas } from './schema/index.js';
import { loadCapability, loadPolicy, runReplay } from './replay/run.js';
import { discover } from './agent/discover.js';
import { PlaywrightSurface } from './surface/playwright.js';
import { Redactor } from './policy/redact.js';
import { RunEvidence, newRunId } from './evidence/logger.js';
import { OperatorConsole } from './handoff/operators.js';

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags: Record<string, string[]> = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      (flags[key] ??= []).push(next);
      i++;
    } else (flags[key] ??= []).push('true');
  }
}
const flag = (k: string) => flags[k]?.[flags[k].length - 1];
const has = (k: string) => flags[k]?.includes('true') || !!flags[k];
const params = () =>
  Object.fromEntries(
    (flags['param'] ?? []).map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );

// ---------- .env (optional) ----------
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// Synthetic credentials for the mock console. Real deployments read these from a secret store.
process.env.CORESERV_USER ??= 'operator';
process.env.CORESERV_PASSWORD ??= 'demo123';

function usage() {
  console.log(`Usage:
  npm run discover -- --goal "<goal>" [--entry http://localhost:4310/] [--param k=v ...] [--sensitive k ...] [--out capabilities/<id>.json] [--headed] [--operator] [--tenant harbor]
  npm run replay   -- --capability <file.json> [--param k=v ...] [--tenant summit] [--approve-irreversible] [--headed] [--operator] [--fault <name>]
  npm run catalog  -- [--invoke <capabilityId> --param k=v ...]
  npm run schemas`);
}

async function withOperator<T>(enabled: boolean, headed: boolean, fn: (op?: OperatorConsole) => Promise<T>): Promise<T> {
  if (!enabled) return fn(undefined);
  const op = new OperatorConsole(Number(process.env.OPERATOR_PORT ?? 4400));
  await op.start();
  console.log(`Operator console: ${op.url}${headed ? '' : ' (tip: add --headed so the human can act in the live browser window)'}`);
  try {
    return await fn(op);
  } finally {
    await op.stop();
  }
}

async function main() {
  switch (cmd) {
    case 'schemas': {
      mkdirSync('schema', { recursive: true });
      const s = jsonSchemas();
      for (const [name, schema] of Object.entries(s)) writeFileSync(join('schema', `${name}.schema.json`), JSON.stringify(schema, null, 2));
      console.log('wrote schema/capability.schema.json, schema/replayResult.schema.json, schema/policy.schema.json');
      return;
    }

    case 'discover': {
      const goal = flag('goal');
      if (!goal) return usage();
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        console.error('ANTHROPIC_API_KEY is required for discovery (replay does not need it).');
        process.exit(2);
      }
      const policy = loadPolicy(flag('policy'));
      const redactor = new Redactor(policy);
      const evidence = new RunEvidence(newRunId('discovery'), redactor);
      const headed = has('headed');
      const surface = await PlaywrightSurface.launch({ headless: !headed });
      try {
        const result = await withOperator(has('operator'), headed, (operator) =>
          discover({
            goal,
            entryUrl: flag('entry') ?? 'http://localhost:4310/',
            params: params(),
            sensitiveParams: flags['sensitive'] ?? [],
            secretNames: ['CORESERV_USER', 'CORESERV_PASSWORD'],
            policy,
            surface,
            evidence,
            redactor,
            operator,
            model: flag('model'),
            tenantId: flag('tenant') ?? 'harbor',
          }),
        );
        if (result.status === 'success') {
          const out = flag('out') ?? join('capabilities', `${result.capability.id}.json`);
          mkdirSync('capabilities', { recursive: true });
          writeFileSync(out, JSON.stringify(result.capability, null, 2));
          evidence.json('capability.json', result.capability);
          console.log(`\nDiscovery succeeded in ${result.steps} steps. Capability written to ${out}\nEvidence: ${evidence.dir}\nSummary: ${result.summary}`);
        } else {
          console.error(`\nDiscovery failed after ${result.steps} steps: ${result.reason}\nEvidence: ${evidence.dir}`);
          process.exitCode = 1;
        }
      } finally {
        await surface.close();
      }
      return;
    }

    case 'replay': {
      const capPath = flag('capability');
      if (!capPath) return usage();
      const headed = has('headed');
      const result = await withOperator(has('operator'), headed, (operator) =>
        runReplay({
          capability: capPath,
          params: params(),
          tenantId: flag('tenant'),
          approveIrreversible: has('approve-irreversible'),
          headless: !headed,
          operator,
          fault: flag('fault'),
          policy: flag('policy'),
          interventionTimeoutMs: Number(flag('intervention-timeout') ?? 10 * 60_000),
        }),
      );
      console.log('\n=== RESULT ===');
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === 'failure' ? 1 : 0;
      return;
    }

    case 'catalog': {
      const dir = 'capabilities';
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
      const caps = files.map((f) => loadCapability(join(dir, f)));
      const invoke = flag('invoke');
      if (!invoke) {
        // Agent-facing view: each capability as a tool definition a calling agent could be given.
        const tools = caps.map((c) => ({
          name: c.id,
          description: `${c.description} When to use: ${c.usage.whenToUse}${c.usage.notFor ? ` Not for: ${c.usage.notFor}` : ''} [status=${c.status}, version=${c.version}, risk=${c.policy.maxRisk}${c.policy.requiresApproval ? ', requires approval' : ''}]`,
          input_schema: {
            type: 'object',
            properties: Object.fromEntries(c.params.map((p) => [p.name, { type: p.type, description: p.description, ...(p.pattern ? { pattern: p.pattern } : {}) }])),
            required: c.params.filter((p) => p.required).map((p) => p.name),
          },
          returns: Object.fromEntries(c.outputs.map((o) => [o.name, { type: o.type, description: o.description }])),
        }));
        console.log(JSON.stringify(tools, null, 2));
        return;
      }
      const cap = caps.find((c) => c.id === invoke);
      if (!cap) {
        console.error(`unknown capability ${invoke}; available: ${caps.map((c) => c.id).join(', ')}`);
        process.exit(2);
      }
      if (cap.status !== 'approved' && !has('allow-draft')) {
        console.error(`capability ${cap.id} is ${cap.status}; unattended invocation requires status=approved (pass --allow-draft to override)`);
        process.exit(2);
      }
      const result = await runReplay({ capability: cap, params: params(), tenantId: flag('tenant'), approveIrreversible: has('approve-irreversible'), echo: false });
      console.log(JSON.stringify(result.status === 'success' ? { status: 'success', outputs: result.outputs } : result, null, 2));
      process.exitCode = result.status === 'failure' ? 1 : 0;
      return;
    }

    default:
      usage();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
