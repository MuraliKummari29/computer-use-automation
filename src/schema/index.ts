export * from './locator.js';
export * from './capability.js';
export * from './result.js';
export * from './policy.js';

import { z } from 'zod/v4';
import { Capability } from './capability.js';
import { ReplayResult } from './result.js';
import { Policy } from './policy.js';

/** JSON Schema exports so reviewers and calling agents can read the contract without running code. */
export function jsonSchemas() {
  return {
    capability: z.toJSONSchema(Capability, { target: 'draft-7' }),
    replayResult: z.toJSONSchema(ReplayResult, { target: 'draft-7' }),
    policy: z.toJSONSchema(Policy, { target: 'draft-7' }),
  };
}
