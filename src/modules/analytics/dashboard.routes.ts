import { Router } from 'express';
import { requireAuth, requirePermission } from '../../middleware/auth';

const router = Router();

router.get('/dashboard', requireAuth, requirePermission('reports.read'), (_req, res) => {
  res.json({
    metrics: {
      totalCustomers: 12400,
      newLeads: 842,
      openConversations: 361,
      unassignedConversations: 47,
      followUpsDueToday: 36,
      overdueFollowUps: 19,
      salesPipelineValue: 248000,
      wonDeals: 184,
      lostDeals: 31,
      conversionRate: 28.4,
      messagesSent: 9234,
      messagesReceived: 7765,
      responseTimeHours: 2.4,
      teamPerformance: 89,
    },
    charts: {
      leadsOverTime: [120, 150, 165, 182, 174, 214, 261],
      conversationFlow: [90, 110, 128, 119, 137, 149, 155],
      salesConversion: [18, 22, 26, 31, 38, 41],
      pipelineRevenue: { 'New': 34000, 'Qualified': 62000, 'Proposal': 54000, 'Negotiation': 33000, 'Won': 68000 },
      agentPerformance: [
        { name: 'Maya', deals: 18, velocity: 92 },
        { name: 'Leo', deals: 14, velocity: 88 },
        { name: 'Nia', deals: 12, velocity: 86 },
      ],
    },
  });
});

export default router;
