import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { unprocessable } from '../lib/httpError';

export const validate =
  (schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(unprocessable('Validation failed', result.error.flatten()));
    }
    (req as any).validated = { ...((req as any).validated ?? {}), [source]: result.data };
    next();
  };
