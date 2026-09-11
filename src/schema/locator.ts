/**
 * Locators: how a recorded step finds a control on replay.
 *
 * A Locator is a *bundle* of strategies, tried in order. The order encodes
 * robustness: semantic strategies (role+name, label anchor) first, spatial
 * strategies (bounding box) last. None of them reference DOM structure
 * (no CSS paths, no XPaths), so the same bundle can be resolved by a web
 * surface via the accessibility tree or by a desktop surface via the OS
 * accessibility API. `css` exists only as an explicit, discouraged escape hatch.
 */
import { z } from 'zod/v4';

export const ControlRole = z.enum([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'cell',
  'heading',
  'text',
  'image',
  'unknown',
]);
export type ControlRole = z.infer<typeof ControlRole>;

export const LocatorStrategy = z.discriminatedUnion('kind', [
  // Accessibility role + accessible name. Works on web (ARIA) and desktop (AX/UIA).
  z.object({ kind: z.literal('role'), role: ControlRole, name: z.string(), exact: z.boolean().default(true) }),
  // Visible text of the control itself (links, buttons, cells).
  z.object({ kind: z.literal('text'), text: z.string(), exact: z.boolean().default(true) }),
  // Legacy-friendly: a control positioned relative to a visible label that is
  // NOT programmatically associated with it ("Member Number" cell -> input in same row).
  z.object({
    kind: z.literal('anchor'),
    anchorText: z.string(),
    relation: z.enum(['same-row', 'right-of', 'below']),
    controlRole: ControlRole,
  }),
  // Table cell addressed by row anchor text + column header text.
  z.object({ kind: z.literal('table-cell'), rowAnchor: z.string(), columnHeader: z.string() }),
  // Key/value pair in a two-column table ("Confirmation #" -> value cell).
  z.object({ kind: z.literal('labeled-value'), label: z.string() }),
  // Spatial fallback: bounding box normalised to the viewport at record time.
  // Only used when every semantic strategy fails; a hit here is flagged as drift.
  z.object({
    kind: z.literal('bbox'),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    viewport: z.object({ w: z.number(), h: z.number() }),
    expectRole: ControlRole.optional(),
  }),
  // Escape hatch. DOM-specific, does not generalise to desktop. Discouraged.
  z.object({ kind: z.literal('css'), selector: z.string() }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Locator = z.object({
  /** Ordered from most to least robust. */
  strategies: z.array(LocatorStrategy).min(1),
  /** Frame hint (name path like "main" or "main/inner"). Resolver tries this first, then all frames. */
  frame: z.string().optional(),
  /** Why these strategies were chosen (recorded by the discovery agent or a human). */
  rationale: z.string().optional(),
});
export type Locator = z.infer<typeof Locator>;
