/**
 * Control transfer model for human-in-the-loop handoff.
 *
 * Exactly one party controls the live session at any time. The ControlToken
 * is the single source of truth and every transition is logged:
 *
 *   automation --request()--> intervention_requested --take()--> human
 *   human --handBack()--> resuming --resumed()--> automation
 *
 * While the token is not in `automation`, the replay engine does not act.
 * While it is in `human`, the surface records what the human does.
 */
import type { HumanAction, InterventionRecord } from '../schema/result.js';
import type { Surface } from '../surface/types.js';

export type ControlState = 'automation' | 'intervention_requested' | 'human' | 'resuming';

export interface InterventionRequest {
  id: string;
  runId: string;
  capabilityId: string;
  goal: string;
  stepId: string;
  stepDescription: string;
  code: string;
  reason: string;
  url: string;
  screenshotPath?: string;
  expected?: string;
  observed?: string;
  /** Actions the operator can choose from for this request. */
  options: InterventionResolutionKind[];
  createdAt: string;
}

export type InterventionResolutionKind = 'retry' | 'skip' | 'abort' | 'approve';

export interface InterventionResolution {
  resolution: InterventionResolutionKind | 'timeout';
  operator?: string;
  notes?: string;
}

/** The channel to a human operator. The console implementation is HTTP; tests use a scripted one. */
export interface OperatorChannel {
  /** Present the request and wait until a human resolves it (or the timeout elapses). */
  request(req: InterventionRequest, opts: { timeoutMs: number; onTaken?: () => void }): Promise<InterventionResolution>;
}

export class ControlToken {
  private state: ControlState = 'automation';
  readonly transitions: { at: string; from: ControlState; to: ControlState; by: string }[] = [];

  get current(): ControlState {
    return this.state;
  }
  get automationMayAct(): boolean {
    return this.state === 'automation';
  }

  transition(to: ControlState, by: string) {
    const allowed: Record<ControlState, ControlState[]> = {
      automation: ['intervention_requested'],
      intervention_requested: ['human', 'automation'],
      human: ['resuming'],
      resuming: ['automation'],
    };
    if (!allowed[this.state].includes(to)) throw new Error(`illegal control transition ${this.state} -> ${to}`);
    this.transitions.push({ at: new Date().toISOString(), from: this.state, to, by });
    this.state = to;
  }
}

export class Handoff {
  readonly token = new ControlToken();
  private seq = 0;

  constructor(
    private surface: Surface,
    private channel: OperatorChannel | undefined,
    private log: (event: string, data?: Record<string, unknown>) => void,
  ) {}

  get available() {
    return !!this.channel;
  }

  newRequestId(runId: string) {
    return `${runId}-int${++this.seq}`;
  }

  /**
   * Cede control to a human, wait for them to hand it back, and return what
   * they decided plus everything they did on the live session.
   */
  async escalate(req: InterventionRequest, timeoutMs: number): Promise<InterventionRecord> {
    const record: InterventionRecord = {
      id: req.id,
      requestedAt: req.createdAt,
      stepId: req.stepId,
      reason: req.reason,
      code: req.code,
      screenshot: req.screenshotPath,
      humanActions: [],
    };
    if (!this.channel) {
      this.log('intervention.unavailable', { id: req.id, code: req.code });
      record.resolution = 'timeout';
      record.notes = 'no operator channel configured';
      record.resolvedAt = new Date().toISOString();
      return record;
    }
    this.token.transition('intervention_requested', 'engine');
    this.log('intervention.requested', { id: req.id, stepId: req.stepId, code: req.code, reason: req.reason, url: req.url });

    const actions: HumanAction[] = [];
    const recorder = (e: { kind: string; detail: string }) => {
      const a: HumanAction = { at: new Date().toISOString(), kind: e.kind as HumanAction['kind'], detail: e.detail };
      actions.push(a);
      this.log('intervention.human_action', { id: req.id, ...a });
    };
    await this.surface.startHumanRecording(recorder);

    const resolution = await this.channel.request(req, {
      timeoutMs,
      onTaken: () => {
        if (this.token.current === 'intervention_requested') {
          this.token.transition('human', 'operator');
          this.log('intervention.taken', { id: req.id });
        }
      },
    });
    // If the operator resolved without explicitly taking control, model it as an instantaneous take.
    if (this.token.current === 'intervention_requested') this.token.transition('human', resolution.operator ?? 'operator');
    this.surface.stopHumanRecording();
    this.token.transition('resuming', 'engine');
    record.resolvedAt = new Date().toISOString();
    record.resolution = resolution.resolution;
    record.operator = resolution.operator;
    record.notes = resolution.notes;
    record.humanActions = actions;
    this.log('intervention.resolved', { id: req.id, resolution: resolution.resolution, operator: resolution.operator, humanActions: actions.length, notes: resolution.notes });
    this.token.transition('automation', 'engine');
    return record;
  }
}
