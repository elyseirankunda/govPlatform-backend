import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';

export const hashPassword = async (plain: string): Promise<string> =>
  bcrypt.hash(plain, env.bcryptRounds);

export const verifyPassword = async (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

export interface JwtPayload {
  sub: number;
  role: string;
  type: 'access' | 'refresh' | 'mfa';
}

/** Short-lived token used to complete a 2FA challenge at login. */
export const signMfaToken = (userId: number): string =>
  jwt.sign({ sub: userId, role: '', type: 'mfa' }, env.jwtSecret, {
    expiresIn: '5m',
  } as jwt.SignOptions);

export const signAccessToken = (userId: number, role: string): string =>
  jwt.sign({ sub: userId, role, type: 'access' }, env.jwtSecret, {
    expiresIn: env.jwtAccessExpires as jwt.SignOptions['expiresIn'],
  } as jwt.SignOptions);

export const signRefreshToken = (userId: number, role: string): string =>
  jwt.sign({ sub: userId, role, type: 'refresh' }, env.jwtSecret, {
    expiresIn: env.jwtRefreshExpires as jwt.SignOptions['expiresIn'],
  } as jwt.SignOptions);

export const verifyToken = (token: string): JwtPayload => {
  try {
    return jwt.verify(token, env.jwtSecret) as unknown as JwtPayload;
  } catch {
    throw new Error('Invalid or expired token');
  }
};

export const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('hex');

export const randomOtp = (digits = 6): string =>
  crypto.randomInt(0, Math.pow(10, digits)).toString().padStart(digits, '0');
