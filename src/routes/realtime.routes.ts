import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { sseRegister } from '../services/realtime.service';

const router = Router();

/** Server-Sent Events stream. EventSource cannot set headers, so auth is via ?token=. */
router.get('/events', (req, res, next) => {
  const token = String(req.query.token ?? '');
  if (token) req.headers.authorization = `Bearer ${token}`;

  authenticate(req, res, (err) => {
    if (err) return next(err);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sseRegister(req.user!.id, res);
  });
});

export default router;