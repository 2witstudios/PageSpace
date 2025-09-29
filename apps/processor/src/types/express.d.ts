import type { ServiceTokenPayload } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      serviceAuth?: ServiceTokenPayload;
    }
  }
}

export {};
