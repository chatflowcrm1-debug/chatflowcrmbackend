import dotenv from 'dotenv';

dotenv.config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const DEFAULT_TELNYX_WEBHOOK_TOLERANCE_SECONDS = 300;
const DEFAULT_TELNYX_REQUEST_TIMEOUT_MS = 10000;

function isDevelopmentPlaceholder(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === ''
    || normalized.includes('change-me')
    || normalized.includes('dev-secret')
    || normalized.includes('dev-refresh-secret')
    || normalized.includes('default-secret')
    || normalized.includes('replace-this');
}

function requiredProductionValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value || (name === 'JWT_SECRET' || name === 'JWT_REFRESH_SECRET') && isDevelopmentPlaceholder(value)) {
    throw new Error(`Production configuration error: ${name} must be configured with a production value`);
  }
  return value;
}

function positiveIntegerValue(name: string, fallback: number) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function productionCorsOrigins() {
  const value = requiredProductionValue('CORS_ORIGINS');
  const origins = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0 || origins.includes('*')) {
    throw new Error('Production configuration error: CORS_ORIGINS must contain explicit origins');
  }
  return origins;
}

const databaseUrl = isProduction ? requiredProductionValue('DATABASE_URL') : process.env.DATABASE_URL || '******localhost:5432/chatflow_crm';
const directUrl = isProduction ? requiredProductionValue('DIRECT_URL') : process.env.DIRECT_URL;
const jwtSecret = isProduction ? requiredProductionValue('JWT_SECRET') : process.env.JWT_SECRET || 'dev-secret';
const jwtRefreshSecret = isProduction ? requiredProductionValue('JWT_REFRESH_SECRET') : process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';
const appUrl = isProduction ? requiredProductionValue('APP_URL') : process.env.APP_URL || 'http://localhost:3000';
const apiUrl = isProduction ? requiredProductionValue('API_URL') : process.env.API_URL || 'http://localhost:4000';
const smtpHost = isProduction ? requiredProductionValue('SMTP_HOST') : process.env.SMTP_HOST?.trim() || '';
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER?.trim() || '';
const smtpPassword = process.env.SMTP_PASSWORD || '';
const emailFrom = isProduction ? requiredProductionValue('EMAIL_FROM') : process.env.EMAIL_FROM?.trim() || '';
const telecomProvider = (process.env.TELECOM_PROVIDER || 'mock').trim().toLowerCase();
const telnyxApiKey = telecomProvider === 'telnyx' && isProduction
  ? requiredProductionValue('TELNYX_API_KEY')
  : process.env.TELNYX_API_KEY || '';
const telnyxPublicKey = telecomProvider === 'telnyx' && isProduction
  ? requiredProductionValue('TELNYX_PUBLIC_KEY')
  : process.env.TELNYX_PUBLIC_KEY?.trim() || '';
const telnyxWebhookToleranceSeconds = positiveIntegerValue('TELNYX_WEBHOOK_TOLERANCE_SECONDS', DEFAULT_TELNYX_WEBHOOK_TOLERANCE_SECONDS);
const telnyxRequestTimeoutMs = positiveIntegerValue('TELNYX_REQUEST_TIMEOUT_MS', DEFAULT_TELNYX_REQUEST_TIMEOUT_MS);
if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
  throw new Error('SMTP_PORT must be an integer between 1 and 65535');
}
if ((smtpUser && !smtpPassword) || (!smtpUser && smtpPassword)) {
  throw new Error('SMTP_USER and SMTP_PASSWORD must be provided together');
}
const corsOrigins = isProduction
  ? productionCorsOrigins()
  : (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((item) => item.trim()).filter(Boolean);

export const env = {
  nodeEnv,
  port: Number(process.env.PORT || 4000),
  databaseUrl,
  directUrl,
  jwtSecret,
  jwtRefreshSecret,
  appUrl,
  apiUrl,
  smtpHost,
  smtpPort,
  smtpUser,
  smtpPassword,
  emailFrom,
  corsOrigins,
  metaAppId: process.env.META_APP_ID || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  telecomProvider,
  telnyxApiKey,
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID || '',
  telnyxPublicKey,
  telnyxWebhookToleranceSeconds,
  telnyxRequestTimeoutMs,
};
