import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { badRequest, notFound } from '../lib/httpError';
import { authenticate } from '../middleware/auth';
import { env } from '../config/env';

const router = Router();

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.cwd(), env.uploadDir);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error('File type not allowed'));
      return;
    }
    cb(null, true);
  },
});

router.post(
  '/',
  authenticate,
  upload.array('files', 5),
  async (req, res, next) => {
    try {
      const entity = String(req.body.entity || '');
      const entityId = Number(req.body.entityId);
      if (!entity || !entityId) throw badRequest('entity and entityId are required');
      const files = (req as any).files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) throw badRequest('No files uploaded');

      const uploaded = await Promise.all(
        files.map((file) =>
          prisma.attachment.create({
            data: {
              entity,
              entityId,
              fileName: file.originalname,
              filePath: path.join(env.uploadDir, file.filename),
              mimeType: file.mimetype,
              size: file.size,
              uploadedById: req.user!.id,
            },
          }),
        ),
      );

      res.status(201).json({ attachments: uploaded });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:entity/:entityId',
  authenticate,
  async (req, res, next) => {
    try {
      const entity = String(req.params.entity).toUpperCase();
      const entityId = Number(req.params.entityId);
      const attachments = await prisma.attachment.findMany({ where: { entity, entityId } });
      res.json({ items: attachments });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
