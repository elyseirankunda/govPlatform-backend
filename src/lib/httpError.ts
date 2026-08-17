export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new HttpError(403, message);
export const notFound = (message = 'Resource not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, message, details);

export const asyncHandler =
  (fn: (req: any, res: any, next: any) => Promise<unknown>) =>
  (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
