import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';

const router = Router();

const dashboardSchema = z.object({
  range: z.enum(['7d', '30d', '90d']).optional(),
});

router.get('/', requireAuth, requirePermission('reports.read'), async (req: AuthRequest, res) => {
  const range = dashboardSchema.parse({ range: req.query.range || '30d' });
  const organizationId = req.user!.organizationId;

  const [customers, leads, deals, followUps, activities] = await Promise.all([
    prisma.customer.count({ where: { organizationId } }),
    prisma.lead.count({ where: { organizationId } }),
    prisma.deal.count({ where: { organizationId, status: 'OPEN' } }),
    prisma.followUp.count({ where: { organizationId, dueAt: { gte: new Date() } } }),
    prisma.activity.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { user: { select: { firstName: true, lastName: true } } },
    }),
  ]);

  const wonDeals = await prisma.deal.count({ where: { organizationId, status: 'WON' } });
  const lostDeals = await prisma.deal.count({ where: { organizationId, status: 'LOST' } });
  const pipelineValue = await prisma.deal.aggregate({
    where: { organizationId },
    _sum: { value: true },
  });
  const overdueFollowUps = await prisma.followUp.count({ where: { organizationId, status: 'OVERDUE' } });

  const data = {
    metrics: {
      totalCustomers: customers,
      newLeads: leads,
      openDeals: deals,
      wonDeals,
      lostDeals,
      totalPipelineValue: Number(pipelineValue._sum.value || 0),
      upcomingFollowUps: followUps,
      overdueFollowUps,
      recentActivities: activities,
    },
    range,
  };

  return res.json({ data });
});

export default router;
