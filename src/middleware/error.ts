import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { HttpError } from '../lib/httpError';
import { prisma } from '../lib/prisma';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let status = 500;
  let message = 'Internal server error';
  let details: unknown;

  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
    details = err.details;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      status = 409;
      message = 'A record with this unique value already exists';
      details = err.meta;
    } else if (err.code === 'P2025') {
      status = 404;
      message = 'Record not found';
    } else {
      message = `Database error (${err.code})`;
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    status = 400;
    message = 'Invalid data provided to database';
  } else if (err instanceof Error) {
    message = err.message;
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  // Best-effort audit of failures is avoided here (avoid recursion).

  res.status(status).json({
    error: message,
    ...(env.nodeEnv !== 'production' && details !== undefined ? { details } : {}),
    ...(env.nodeEnv !== 'production' && status === 500 ? { stack: err instanceof Error ? err.stack : undefined } : {}),
  });
}
