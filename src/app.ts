import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { env } from './config/env';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/error';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigin.split(',').map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  if (env.nodeEnv !== 'production') {
    app.use(morgan('dev'));
  } else {
    const logDir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const stream = fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' });
    app.use(morgan('combined', { stream }));
  }

  // Global rate limiting
  app.use(
    rateLimit({
      windowMs: env.rateLimitWindowMin * 60 * 1000,
      max: env.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later' },
    }),
  );

  // Static uploads
  app.use('/uploads', express.static(path.join(process.cwd(), env.uploadDir)));

  // Health
  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', time: new Date().toISOString() }),
  );

  app.use('/api/v1', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
