import dotenv from 'dotenv';

dotenv.config();

const required = ['DATABASE_URL', 'JWT_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    console.warn(`[config] Missing environment variable: ${key}`);
  }
}

export const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  jwtAccessExpires: process.env.JWT_ACCESS_EXPIRES || '2h',
  jwtRefreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
  rateLimitWindowMin: parseInt(process.env.RATE_LIMIT_WINDOW_MIN || '15', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '200', 10),
  authRateLimitWindowMin: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MIN || '15', 10),
  authRateLimitMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '10', 10),
  appUrl: process.env.APP_URL || 'http://localhost:5173',
};
