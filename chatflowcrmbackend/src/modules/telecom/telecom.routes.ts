import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { AuthRequest, requireAuth, requirePermission } from '../../middleware/auth';
import { maybeRecordPhoneNumberUsage, maybeRecordVoiceUsage } from './telecom.usage';
import { getOutboundVoiceConfigurationError, getTelecomProvider, getTelecomProviderName } from './telecom.service';
import { env } from '../../config/env';
import { TelecomCapability, TelecomNumberType } from './telecom.types';
import { sensitiveActionRateLimit } from '../../middleware/rate-limit';
import { ensureTelecomOperation, normalizeIdempotencyKey, toTelecomOperationResponse } from './telecom.operations';

const router = Router();
const provider = getTelecomProvider();
const providerName = getTelecomProviderName();

router.get('/overview', requireAuth, requirePermission('reports.read'), async (req: AuthRequest, res) => {
	const organizationId = req.user!.organizationId;
	const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
	const [activeNumbers, callsToday, inboundCalls, outboundCalls, missedCalls, smsToday, minutes] = await Promise.all([
		prisma.phoneNumber.count({ where: { organizationId, status: 'ACTIVE' } }),
		prisma.telecomCall.count({ where: { organizationId, createdAt: { gte: startOfDay } } }),
		prisma.telecomCall.count({ where: { organizationId, direction: 'INBOUND' } }),
		prisma.telecomCall.count({ where: { organizationId, direction: 'OUTBOUND' } }),
		prisma.telecomCall.count({ where: { organizationId, status: { in: ['NO_ANSWER', 'BUSY', 'CANCELLED'] } } }),
		prisma.telecomMessage.count({ where: { organizationId, createdAt: { gte: startOfDay } } }),
		prisma.telecomCall.aggregate({ where: { organizationId }, _sum: { durationSeconds: true } }),
	]);
	return res.json({ data: { activeNumbers, callsToday, inboundCalls, outboundCalls, missedCalls, smsToday, totalCallMinutes: Math.ceil((minutes._sum.durationSeconds || 0) / 60) } });
});

const searchSchema = z.object({ country: z.string().length(2).transform((value) => value.toUpperCase()), numberType: z.enum(['LOCAL', 'NATIONAL', 'TOLL_FREE', 'MOBILE', 'VIRTUAL', 'VANITY']).optional(), areaCode: z.string().max(10).optional(), capabilities: z.string().optional() });
router.get('/numbers/search', requireAuth, requirePermission('customers.read'), async (req, res) => {
	const parsed = searchSchema.safeParse(req.query); if (!parsed.success) return res.status(400).json({ message: 'Invalid number search', issues: parsed.error.issues });
	const capabilities = parsed.data.capabilities?.split(',').map((item) => item.trim()).filter(Boolean) as TelecomCapability[] | undefined;
	return res.json({ data: await provider.searchNumbers({ country: parsed.data.country, numberType: parsed.data.numberType as TelecomNumberType | undefined, areaCode: parsed.data.areaCode, capabilities }), provider: providerName });
});

router.get('/numbers', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => res.json({ data: await prisma.phoneNumber.findMany({ where: { organizationId: req.user!.organizationId }, include: { assignedUser: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } }) }));
router.get('/users', requireAuth, requirePermission('settings.manage'), async (req: AuthRequest, res) => res.json({ data: await prisma.user.findMany({ where: { organizationId: req.user!.organizationId, isActive: true }, select: { id: true, firstName: true, lastName: true, email: true }, orderBy: { firstName: 'asc' } }) }));

router.use((req, res, next) => {
	if (req.method === 'POST' && req.path === '/calls') {
		const voiceConfigurationError = getOutboundVoiceConfigurationError(providerName, env.telnyxConnectionId);
		if (voiceConfigurationError) return res.status(503).json({ message: voiceConfigurationError });
	}
	next();
});

router.post('/numbers/purchase', sensitiveActionRateLimit, requireAuth, requirePermission('settings.manage'), async (req: AuthRequest, res) => {
	const parsed = z.object({ providerNumberId: z.string().min(1) }).safeParse(req.body);
	if (!parsed.success) return res.status(400).json({ message: 'Invalid number purchase' });
	const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);
	if (!idempotencyKey) return res.status(400).json({ message: 'Idempotency-Key header is required' });
	const result = await ensureTelecomOperation({
		organizationId: req.user!.organizationId,
		userId: req.user!.id,
		operationType: 'NUMBER_PURCHASE',
		provider: providerName,
		requestPayload: { providerNumberId: parsed.data.providerNumberId },
		idempotencyKey,
	});
	if (result.status === 'conflict') return res.status(409).json({ message: result.message });
	if (result.status === 'replay') return res.status(200).json({ message: 'Telecom operation already exists', data: toTelecomOperationResponse(result.operation) });
	return res.status(201).json({ message: 'Telecom operation created', data: toTelecomOperationResponse(result.operation) });
});

router.delete('/numbers/:id', sensitiveActionRateLimit, requireAuth, requirePermission('settings.manage'), async (req: AuthRequest, res) => { const number = await prisma.phoneNumber.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } }); if (!number) return res.status(404).json({ message: 'Phone number not found' }); await provider.releaseNumber(number.providerNumberId || number.phoneNumber); await prisma.phoneNumber.delete({ where: { id: number.id } }); return res.json({ message: 'Phone number released' }); });
router.patch('/numbers/:id/assignment', sensitiveActionRateLimit, requireAuth, requirePermission('settings.manage'), async (req: AuthRequest, res) => { const parsed = z.object({ assignedUserId: z.string().min(1).nullable() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Invalid assignment' }); const number = await prisma.phoneNumber.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } }); if (!number) return res.status(404).json({ message: 'Phone number not found' }); if (parsed.data.assignedUserId && !(await prisma.user.findFirst({ where: { id: parsed.data.assignedUserId, organizationId: req.user!.organizationId, isActive: true } }))) return res.status(400).json({ message: 'User not found in this organization' }); return res.json({ data: await prisma.phoneNumber.update({ where: { id: number.id }, data: { assignedUserId: parsed.data.assignedUserId } }) }); });

router.get('/calls', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => res.json({ data: await prisma.telecomCall.findMany({ where: { organizationId: req.user!.organizationId }, include: { customer: true, phoneNumber: true }, orderBy: { createdAt: 'desc' } }) }));
router.post('/calls', sensitiveActionRateLimit, requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
	const parsed = z.object({ phoneNumberId: z.string().min(1), toNumber: z.string().min(3), customerId: z.string().optional(), recordingEnabled: z.boolean().default(false) }).safeParse(req.body);
	if (!parsed.success) return res.status(400).json({ message: 'Invalid call request' });
	const number = await prisma.phoneNumber.findFirst({ where: { id: parsed.data.phoneNumberId, organizationId: req.user!.organizationId } });
	if (!number || !number.capabilities.includes('voice')) return res.status(400).json({ message: 'Voice-capable business number required' });
	if (parsed.data.customerId && !(await prisma.customer.findFirst({ where: { id: parsed.data.customerId, organizationId: req.user!.organizationId } }))) return res.status(400).json({ message: 'Customer not found in this organization' });
	const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);
	if (!idempotencyKey) return res.status(400).json({ message: 'Idempotency-Key header is required' });
	const result = await ensureTelecomOperation({
		organizationId: req.user!.organizationId,
		userId: req.user!.id,
		operationType: 'VOICE_CALL',
		provider: providerName,
		requestPayload: {
			phoneNumberId: number.id,
			toNumber: parsed.data.toNumber,
			customerId: parsed.data.customerId || null,
			recordingEnabled: parsed.data.recordingEnabled,
		},
		idempotencyKey,
		customerId: parsed.data.customerId || null,
		phoneNumberId: number.id,
	});
	if (result.status === 'conflict') return res.status(409).json({ message: result.message });
	if (result.status === 'replay') return res.status(200).json({ message: 'Telecom operation already exists', data: toTelecomOperationResponse(result.operation) });
	return res.status(201).json({ message: 'Telecom operation created', data: toTelecomOperationResponse(result.operation) });
});
router.post('/calls/:id/hangup', sensitiveActionRateLimit, requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => { const call = await prisma.telecomCall.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } }); if (!call) return res.status(404).json({ message: 'Call not found' }); if (!call.providerCallId) return res.status(409).json({ message: 'Call has no provider control ID' }); if (['COMPLETED', 'FAILED', 'BUSY', 'NO_ANSWER', 'CANCELLED'].includes(call.status)) return res.status(409).json({ message: 'Call is no longer active' }); try { await provider.hangupCall(call.providerCallId); } catch (_error) { return res.status(502).json({ message: 'Call provider action failed' }); } const endedAt = new Date(); const durationSeconds = z.object({ durationSeconds: z.number().int().min(0).optional() }).parse(req.body || {}).durationSeconds ?? (call.startedAt ? Math.max(0, Math.floor((endedAt.getTime() - call.startedAt.getTime()) / 1000)) : 0); return res.json({ data: await prisma.telecomCall.update({ where: { id: call.id }, data: { status: 'COMPLETED', endedAt, durationSeconds, events: { create: { eventType: 'completed', payload: { durationSeconds } } } } }) }); });
router.post('/calls/:id/respond', sensitiveActionRateLimit, requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => { const parsed = z.object({ action: z.enum(['answer', 'decline']) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Invalid call response' }); const call = await prisma.telecomCall.findFirst({ where: { id: req.params.id, organizationId: req.user!.organizationId } }); if (!call) return res.status(404).json({ message: 'Call not found' }); if (!call.providerCallId) return res.status(409).json({ message: 'Call has no provider control ID' }); if (call.status !== 'RINGING' && call.status !== 'INITIATED') return res.status(409).json({ message: 'Call is not waiting for a response' }); try { if (parsed.data.action === 'answer') await provider.answerCall(call.providerCallId); else await provider.declineCall(call.providerCallId); } catch (_error) { return res.status(502).json({ message: 'Call provider action failed' }); } const status = parsed.data.action === 'answer' ? 'ANSWERED' : 'CANCELLED'; return res.json({ data: await prisma.telecomCall.update({ where: { id: call.id }, data: { status, answeredAt: status === 'ANSWERED' ? new Date() : null, endedAt: status === 'CANCELLED' ? new Date() : null, events: { create: { eventType: parsed.data.action, payload: { action: parsed.data.action } } } } }) }); });

router.get('/messages', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => res.json({ data: await prisma.telecomMessage.findMany({ where: { organizationId: req.user!.organizationId }, include: { customer: true, phoneNumber: true }, orderBy: { createdAt: 'desc' } }) }));
router.get('/recordings', requireAuth, requirePermission('customers.read'), async (req: AuthRequest, res) => res.json({ data: await prisma.recording.findMany({ where: { organizationId: req.user!.organizationId }, include: { call: true }, orderBy: { createdAt: 'desc' } }) }));
router.post('/messages', sensitiveActionRateLimit, requireAuth, requirePermission('customers.write'), async (req: AuthRequest, res) => {
	const parsed = z.object({ phoneNumberId: z.string().min(1), toNumber: z.string().min(3), customerId: z.string().optional(), body: z.string().min(1).max(1600) }).safeParse(req.body);
	if (!parsed.success) return res.status(400).json({ message: 'Invalid SMS request' });
	const number = await prisma.phoneNumber.findFirst({ where: { id: parsed.data.phoneNumberId, organizationId: req.user!.organizationId } });
	if (!number || !number.capabilities.includes('sms')) return res.status(400).json({ message: 'SMS-capable business number required' });
	if (parsed.data.customerId && !(await prisma.customer.findFirst({ where: { id: parsed.data.customerId, organizationId: req.user!.organizationId } }))) return res.status(400).json({ message: 'Customer not found in this organization' });
	const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);
	if (!idempotencyKey) return res.status(400).json({ message: 'Idempotency-Key header is required' });
	const result = await ensureTelecomOperation({
		organizationId: req.user!.organizationId,
		userId: req.user!.id,
		operationType: 'SMS_SEND',
		provider: providerName,
		requestPayload: {
			phoneNumberId: number.id,
			toNumber: parsed.data.toNumber,
			customerId: parsed.data.customerId || null,
			body: parsed.data.body,
		},
		idempotencyKey,
		customerId: parsed.data.customerId || null,
		phoneNumberId: number.id,
	});
	if (result.status === 'conflict') return res.status(409).json({ message: result.message });
	if (result.status === 'replay') return res.status(200).json({ message: 'Telecom operation already exists', data: toTelecomOperationResponse(result.operation) });
	return res.status(201).json({ message: 'Telecom operation created', data: toTelecomOperationResponse(result.operation) });
});

export default router;