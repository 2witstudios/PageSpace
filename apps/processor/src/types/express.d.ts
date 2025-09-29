import type { ProcessorServiceAuth } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      serviceAuth?: ProcessorServiceAuth;
    }
  }
}

export {};
