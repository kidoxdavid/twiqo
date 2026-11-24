import { z } from 'zod';

type Strip<F> = F extends z.ZodDefault<infer I> ? I : F;

/**
 * Build a PATCH schema from a create schema: every field optional, and NO defaults applied.
 * In Zod 4, `.partial()` keeps `.default()` values, so a PATCH that sends one field would silently reset
 * the others (visibility, tags, photos...). Always use this for update endpoints.
 */
export function patchOf<T extends z.ZodObject<any>>(schema: T) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(schema.shape)) {
    const f = v as any;
    shape[k] = (f._zod?.def?.type === 'default' ? f.unwrap() : f).optional();
  }
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T['shape']]: z.ZodOptional<Strip<T['shape'][K]>> }>;
}
