import { RequestHandler } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';

const tooManyRequestsMessage = 'Too many requests. Please try again later.';

const loginLimiter = new RateLimiterMemory({
  keyPrefix: 'chatflow:auth:login',
  points: 10,
  duration: 60,
  blockDuration: 300,
});

const refreshLimiter = new RateLimiterMemory({
  keyPrefix: 'chatflow:auth:refresh',
  points: 30,
  duration: 60,
  blockDuration: 120,
});

const registrationLimiter = new RateLimiterMemory({
  keyPrefix: 'chatflow:auth:register',
  points: 5,
  duration: 900,
  blockDuration: 1800,
});

const sensitiveActionLimiter = new RateLimiterMemory({
  keyPrefix: 'chatflow:sensitive-action',
  points: 60,
  duration: 60,
  blockDuration: 120,
});

const webhookLimiter = new RateLimiterMemory({
  keyPrefix: 'chatflow:webhook',
  points: 120,
  duration: 60,
  blockDuration: 60,
});

function clientKey(req: Parameters<RequestHandler>[0]) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function createRateLimitMiddleware(limiter: RateLimiterMemory): RequestHandler {
  return (req, res, next) => {
    limiter.consume(clientKey(req)).then(() => {
      next();
    }).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'msBeforeNext' in error) {
        const msBeforeNext = Number(error.msBeforeNext);
        if (Number.isFinite(msBeforeNext)) {
          res.setHeader('Retry-After', Math.max(1, Math.ceil(msBeforeNext / 1000)));
        }
        return res.status(429).json({ message: tooManyRequestsMessage });
      }

      next(error);
    });
  };
}

export const loginRateLimit = createRateLimitMiddleware(loginLimiter);
export const refreshRateLimit = createRateLimitMiddleware(refreshLimiter);
export const registrationRateLimit = createRateLimitMiddleware(registrationLimiter);
export const sensitiveActionRateLimit = createRateLimitMiddleware(sensitiveActionLimiter);
export const verificationRateLimit = createRateLimitMiddleware(new RateLimiterMemory({ keyPrefix: 'chatflow:auth:verification', points: 5, duration: 900, blockDuration: 1800 }));
export const passwordResetRateLimit = createRateLimitMiddleware(new RateLimiterMemory({ keyPrefix: 'chatflow:auth:password-reset', points: 5, duration: 900, blockDuration: 1800 }));
export const webhookRateLimit = createRateLimitMiddleware(webhookLimiter);
