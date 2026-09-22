/**
 * Untrusted JSON → a typed `ControlCommand`, or `null` — pure.
 *
 * The worker runs only what this returns, and this returns only the typed
 * shapes: an operation kind outside `BROWSER_OPERATION_KINDS` (an `evaluate`,
 * a `cookies`, a CDP method name) has no branch here and comes back `null`.
 * Fields the shape does not declare are dropped rather than passed through,
 * so nothing rides along into the driver. Elements are addressed by the
 * snapshot `ref` alphabet only — a CSS selector is a DOM query and is refused.
 */
import { BROWSER_OPERATION_LIMITS, type BrowserOperation, type TabAction } from './browser-operation.js';
import { HUMAN_KEYS, type ControlCommand, type HumanInput, type HumanKey } from './control-instruction.js';

type Json = Readonly<Record<string, unknown>>;

/** Largest pane coordinate accepted; a viewport is far smaller. */
const MAX_COORDINATE = 16_384;
const REF_PATTERN = new RegExp(`^[A-Za-z0-9]{1,${BROWSER_OPERATION_LIMITS.maxRefLength}}$`);
const TAB_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${BROWSER_OPERATION_LIMITS.maxTabIdLength}}$`);

const asObject = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;

const asUrl = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= BROWSER_OPERATION_LIMITS.maxUrlLength ? value : null;

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= BROWSER_OPERATION_LIMITS.maxTextLength ? value : null;

const asRef = (value: unknown): string | null => (typeof value === 'string' && REF_PATTERN.test(value) ? value : null);

const asTabId = (value: unknown): string | null => (typeof value === 'string' && TAB_ID_PATTERN.test(value) ? value : null);

const asCoordinate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_COORDINATE ? value : null;

const parseTabAction = (operation: Json): TabAction | null => {
  switch (operation.action) {
    case 'list':
      return { action: 'list' };
    case 'open': {
      const url = asUrl(operation.url);
      return url === null ? null : { action: 'open', url };
    }
    case 'select':
    case 'close': {
      const tabId = asTabId(operation.tabId);
      return tabId === null ? null : { action: operation.action, tabId };
    }
    default:
      return null;
  }
};

const parseOperation = (value: unknown): BrowserOperation | null => {
  const operation = asObject(value);
  if (operation === null) return null;
  switch (operation.kind) {
    case 'navigate': {
      const url = asUrl(operation.url);
      return url === null ? null : { kind: 'navigate', url };
    }
    case 'click': {
      const ref = asRef(operation.ref);
      return ref === null ? null : { kind: 'click', ref };
    }
    case 'type': {
      const ref = asRef(operation.ref);
      const text = asText(operation.text);
      if (ref === null || text === null || typeof operation.submit !== 'boolean') return null;
      return { kind: 'type', ref, text, submit: operation.submit };
    }
    case 'read':
      return { kind: 'read' };
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'tabs': {
      const action = parseTabAction(operation);
      return action === null ? null : { kind: 'tabs', ...action };
    }
    default:
      return null;
  }
};

const isHumanKey = (value: unknown): value is HumanKey => (HUMAN_KEYS as readonly unknown[]).includes(value);

const parseHumanInput = (value: unknown): HumanInput | null => {
  const input = asObject(value);
  if (input === null) return null;
  switch (input.kind) {
    case 'click': {
      const x = asCoordinate(input.x);
      const y = asCoordinate(input.y);
      return x === null || y === null ? null : { kind: 'click', x, y };
    }
    case 'text': {
      const text = asText(input.text);
      return text === null ? null : { kind: 'text', text };
    }
    case 'key':
      return isHumanKey(input.key) ? { kind: 'key', key: input.key } : null;
    default:
      return null;
  }
};

export const parseControlCommand = (value: unknown): ControlCommand | null => {
  const command = asObject(value);
  if (command === null) return null;
  switch (command.type) {
    case 'operation': {
      const operation = parseOperation(command.operation);
      return operation === null ? null : { type: 'operation', operation };
    }
    case 'human-input': {
      const input = parseHumanInput(command.input);
      return input === null ? null : { type: 'human-input', input };
    }
    case 'take-over':
    case 'release':
    case 'view-frame':
    case 'audit':
      return { type: command.type };
    default:
      return null;
  }
};
