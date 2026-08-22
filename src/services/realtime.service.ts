import type { Response } from 'express';

const clients = new Map<number, Set<Response>>();

function sseWrite(res: Response, event: string, data: unknown) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // client gone
  }
}

/** Registers a connected SSE response for a user and keeps it alive. */
export function sseRegister(userId: number, res: Response) {
  let set = clients.get(userId);
  if (!set) {
    set = new Set();
    clients.set(userId, set);
  }
  set.add(res);

  res.write('retry: 3000\n\n');
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // noop
    }
  }, 25000);

  res.on('close', () => {
    clearInterval(keepalive);
    set!.delete(res);
    if (set!.size === 0) clients.delete(userId);
  });
}

/** Publishes an event to every live connection for a user. */
export function ssePublish(userId: number, event: string, data: unknown) {
  const set = clients.get(userId);
  if (!set) return;
  for (const res of set) {
    sseWrite(res, event, data);
  }
}