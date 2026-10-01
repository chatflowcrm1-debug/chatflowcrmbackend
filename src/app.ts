import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { logger } from './utils/logger';
import authRoutes from './modules/auth/auth.routes';
import customerRoutes from './modules/customers/customers.routes';
import leadsRoutes from './modules/leads/leads.routes';
import dealsRoutes from './modules/deals/deals.routes';
import followUpsRoutes from './modules/followups/followups.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import whatsappRoutes from './modules/whatsapp/whatsapp.routes';
import conversationRoutes from './modules/conversations/conversations.routes';
import campaignRoutes from './modules/campaigns/campaigns.routes';
import marketingContactRoutes from './modules/marketing-contacts/marketing-contacts.routes';
import billingRoutes from './modules/billing/billing.routes';
import telecomRoutes from './modules/telecom/telecom.routes';
import telecomWebhookRoutes from './modules/telecom/telecom.webhook.routes';
import { requireAuth } from './middleware/auth';

const app = express();

function captureRawBody(req: express.Request, _res: express.Response, buffer: Buffer) {
  (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(express.json({ limit: '4mb', verify: captureRawBody }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/customers', requireAuth, customerRoutes);
app.use('/api/leads', requireAuth, leadsRoutes);
app.use('/api/deals', requireAuth, dealsRoutes);
app.use('/api/followups', requireAuth, followUpsRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/marketing', marketingContactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/telecom', telecomRoutes);
app.use('/api/telecom', telecomWebhookRoutes);

app.get('/api/profile', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', err.message);
  res.status(500).json({ message: 'Internal server error' });
});

export default app;
