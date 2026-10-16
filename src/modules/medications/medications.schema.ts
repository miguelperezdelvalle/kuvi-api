import { z } from 'zod';

const id = z.string().trim().min(1).max(160);
const quantity = z.number().finite().min(0).max(1_000_000_000)
  .refine(n => Math.abs(n * 1e6 - Math.round(n * 1e6)) < 0.001, 'Use at most six decimal places');
const positive = quantity.refine(n => n > 0, 'Must be positive');
const date = z.iso.datetime({ offset: true });
const unit = z.enum(['tablet', 'capsule', 'mL', 'drop', 'puff', 'unit']);
const ingredient = z.object({ name: z.string().trim().min(1).max(120), amount: positive,
  amountUnit: z.enum(['mg', 'mcg', 'g', 'IU']), perQuantity: positive, perUnit: unit }).strict();
const limit = z.object({ quantity: positive, unit: z.string().min(1).max(20),
  period: z.enum(['calendar_day', 'rolling_24h']), ingredientName: z.string().max(120).optional() }).strict();
const timezone = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid timezone');
export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), timezone, times: z.array(z.number().int().min(0).max(1439)).min(1).max(24),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7) }).strict(),
  z.object({ kind: z.literal('interval'), timezone, intervalMinutes: z.number().int().min(1).max(43200), anchorAt: date }).strict(),
  z.object({ kind: z.literal('as_needed'), timezone, reason: z.string().max(500).default(''),
    minIntervalMinutes: z.number().int().min(0).max(43200), limits: z.array(limit).max(8) }).strict(),
]);
const save = z.object({ type: z.literal('save'), id, expectedVersion: z.number().int().min(0),
  product: z.object({ name: z.string().trim().min(1).max(200), form: z.string().trim().min(1).max(60), unit,
    ingredients: z.array(ingredient).max(20) }).strict(),
  treatment: z.object({ doctor: z.string().max(200), dose: positive, schedule: scheduleSchema,
    startsAt: date.nullable(), endsAt: date.nullable(), status: z.enum(['active', 'paused', 'finished', 'archived']),
    reminders: z.boolean(), lowStockDays: z.number().int().min(1).max(90), lowStockUnits: quantity }).strict(),
  openingStock: quantity.optional(),
  legacyIntakes: z.array(z.object({ id, occurredAt: date, legacySlotIndex: z.number().int().nullable() }).strict()).max(5000).optional(),
}).strict();
const intake = z.object({ type: z.literal('intake'), id, treatmentId: id, quantity: positive,
  scheduledAt: date.nullable(), occurredAt: date, status: z.enum(['taken', 'skipped']),
  expectedVersion: z.number().int().positive(), overrideWarning: z.boolean().default(false) }).strict();
const stock = z.object({ type: z.literal('stock'), id, treatmentId: id, kind: z.enum(['refill', 'adjust']),
  quantity, expectedStockVersion: z.number().int().min(0), occurredAt: date, reason: z.string().trim().min(1).max(500) }).strict();
export const operationSchema = z.object({ operationId: id,
  action: z.discriminatedUnion('type', [save, intake, stock,
    z.object({ type: z.literal('void_intake'), intakeId: id, reason: z.string().trim().min(1).max(500) }).strict(),
  ]),
}).strict().superRefine(({ action }, ctx) => {
  if (action.type !== 'save') return;
  const t = action.treatment;
  if (t.startsAt && t.endsAt && new Date(t.endsAt) < new Date(t.startsAt))
    ctx.addIssue({ code: 'custom', message: 'End precedes start', path: ['action', 'treatment', 'endsAt'] });
  if (action.expectedVersion > 0 && (action.openingStock !== undefined || action.legacyIntakes !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Opening stock and legacy intake import are create-only' });
  if (action.expectedVersion === 0 && action.openingStock === undefined)
    ctx.addIssue({ code: 'custom', message: 'Opening stock is required for creation' });
  const schedule = t.schedule;
  if (schedule.kind === 'fixed' && (new Set(schedule.times).size !== schedule.times.length || new Set(schedule.weekdays).size !== schedule.weekdays.length))
    ctx.addIssue({ code: 'custom', message: 'Duplicate schedule entries' });
  const ingredients = action.product.ingredients;
  if (new Set(ingredients.map(i => i.name.toLowerCase())).size !== ingredients.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate ingredient' });
  if (ingredients.some(i => i.perUnit !== action.product.unit))
    ctx.addIssue({ code: 'custom', message: 'Ingredient base must match inventory unit' });
  if (schedule.kind === 'as_needed') {
    for (const l of schedule.limits) {
      if (l.unit === 'takes' || l.unit === action.product.unit) continue;
      if (!ingredients.some(i => i.name === l.ingredientName && i.amountUnit === l.unit))
        ctx.addIssue({ code: 'custom', message: 'Ingredient limit requires matching concentration and ingredient' });
    }
  }
});
export type MedicationOperationInput = z.infer<typeof operationSchema>;
