import type Anthropic from '@anthropic-ai/sdk';
import type { Observation } from '../surface/types.js';

export const SYSTEM_PROMPT = `You are the discovery agent of a computer-use automation system for bank and credit-union back-office software.

You operate a legacy, server-rendered console the way a human operator would: you look at a screenshot with numbered marks over interactive controls, decide one action, and act. Your successful run is recorded as a deterministic, replayable capability, so act deliberately and minimally: the fewest steps that reliably reach the goal.

How to work
- Refer to controls by their mark number. Never guess coordinates.
- One action per turn. After each action you receive a fresh screenshot and control list.
- Values: when you must enter a value the caller supplies, use the "param" field with the parameter name rather than typing the literal. Credentials are secrets: use the "secret" field with the secret name; you never see or type the actual secret. The parameters and secrets available to you are listed in the task.
- When the goal asks you to read something off the screen, call "extract" for each output with a robust on-screen locator: for a table, give the row anchor text and column header text; for a label/value pair, give the label text. Include the value you read so it can be verified against the live page.
- Irreversible actions (final confirm/commit/submit of a change) are blocked during discovery by policy. They are recorded for approved replay. If the goal says to reach a confirmation/review screen, stop there and call "finish".
- Dismiss interstitials or notices only if they block progress; do not explore unrelated screens.
- If the app shows an error you cannot get past, a login you have no credentials for, or an unexpected dialog, call "escalate" with a clear reason instead of guessing.
- Call "finish" as soon as the goal is achieved. In "finish", describe the capability contract (id, name, description, when to use, params and outputs with descriptions) so the artifact is understandable to a human reviewer and a calling agent.
- Stay within the allowed application. Do not navigate to external sites.`;

export function toolDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: 'act',
      description: 'Perform one UI action on the live surface.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'select', 'press', 'navigate'] },
          mark: { type: 'integer', description: 'Mark number of the control (click/type/select/press).' },
          text: { type: 'string', description: 'Literal text to type or option label to select (only for non-parameter, non-secret values).' },
          param: { type: 'string', description: 'Name of a caller-supplied parameter whose value should be typed/selected.' },
          secret: { type: 'string', description: 'Name of a secret (e.g. CORESERV_PASSWORD) whose value should be typed. You never see it.' },
          key: { type: 'string', description: 'Key to press (e.g. Enter).' },
          url: { type: 'string', description: 'URL for navigate.' },
          reason: { type: 'string', description: 'One sentence: why this action, what you expect to happen.' },
        },
        required: ['action', 'reason'],
      },
    },
    {
      name: 'extract',
      description: 'Record an output value read from the current screen, with a robust locator so replay can read it too.',
      input_schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Output name in camelCase, e.g. savingsBalance.' },
          value: { type: 'string', description: 'The value as shown on screen.' },
          type: { type: 'string', enum: ['string', 'number', 'currency', 'boolean'] },
          rowAnchor: { type: 'string', description: 'For a table cell: text that uniquely identifies the row (e.g. "Primary Savings").' },
          columnHeader: { type: 'string', description: 'For a table cell: header text of the column (e.g. "Balance").' },
          label: { type: 'string', description: 'For a label/value pair: the label text (e.g. "Confirmation #").' },
          description: { type: 'string', description: 'What this output means to the caller.' },
          sensitive: { type: 'boolean', description: 'True if the value is PII that must be masked in logs.' },
        },
        required: ['output', 'value', 'type'],
      },
    },
    {
      name: 'finish',
      description: 'Declare the goal achieved and describe the capability contract.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          capabilityId: { type: 'string', description: 'Dotted lowercase id, e.g. coreserv.member.read_balances' },
          name: { type: 'string' },
          description: { type: 'string' },
          whenToUse: { type: 'string' },
          notFor: { type: 'string' },
          params: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] },
          },
        },
        required: ['summary', 'capabilityId', 'name', 'description', 'whenToUse'],
      },
    },
    {
      name: 'escalate',
      description: 'You are stuck or it is unsafe to proceed. Hand the live session to a human operator with a reason.',
      input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  ];
}

export function taskPrompt(o: { goal: string; entryUrl: string; params: Record<string, string>; secretNames: string[] }) {
  const params = Object.entries(o.params)
    .map(([k, v]) => `- ${k} = ${JSON.stringify(v)}`)
    .join('\n');
  return `Goal: ${o.goal}

Application entry point: ${o.entryUrl}
Parameters supplied by the caller (use "param" to enter them):
${params || '- (none)'}
Secrets available (use "secret" to enter them; you never see the values):
${o.secretNames.map((s) => `- ${s}`).join('\n') || '- (none)'}

Begin by navigating to the entry point.`;
}

/** Render an observation as the text half of a tool result / user turn. */
export function describeObservation(obs: Observation, note?: string): string {
  const lines = obs.elements.map((e) => {
    const v = e.value !== undefined && e.value !== '' ? ` value=${JSON.stringify(e.value)}` : '';
    return `${e.mark}: ${e.role} "${e.name}" [${e.frame}]${v}${e.enabled ? '' : ' (disabled)'}`;
  });
  const dialogs = obs.dialogs.length ? `\nDialogs since last action: ${obs.dialogs.map((d) => `${d.type} "${d.message}" (${d.response}ed)`).join('; ')}` : '';
  const text = obs.text.length > 3500 ? obs.text.slice(0, 3500) + '\n[...]' : obs.text;
  return `${note ? note + '\n' : ''}Current page: title="${obs.title}" url=${obs.url}${dialogs}
Interactive controls (mark: role "name" [frame]):
${lines.join('\n') || '(none)'}

Visible text:
${text}`;
}
