import { Router, type Request, type Response, type NextFunction } from 'express';
import adminRouter from './admin';
import calendarRouter from './calendar';
import eventsRouter from './events';
import groupsRouter from './groups';
import healthRouter from './health';
import importRouter from './import';
import membersRouter from './members';
import preferencesRouter from './preferences';
import publicRsvpRouter from './publicRsvp';
import reportsRouter from './reports';
import smsRouter from './sms';
import supportRouter from './support';
import tavfRouter from './tavf';
import templatesRouter from './templates';

const router = Router();

const localE2EAuthEnabled = /^(1|true|yes|on)$/i.test(process.env['E2E_LOCAL_AUTH_ENABLED'] ?? '')
	&& process.env['NODE_ENV'] !== 'production';
const tavfSubscriptionByToken = new Map<string, boolean>();

function localE2ERoleFromRequest(req: Request): 'ADMIN' | 'EVENT_CREATOR' | 'USER' | null {
	const authHeader = req.headers.authorization;
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return null;
	}

	const token = authHeader.slice('Bearer '.length).trim().toLowerCase();
	if (token === 'e2e-admin') {
		return 'ADMIN';
	}
	if (token === 'e2e-event_creator') {
		return 'EVENT_CREATOR';
	}
	if (token === 'e2e-user' || token === 'e2e-tavf_creator') {
		return 'USER';
	}
	return null;
}

if (localE2EAuthEnabled) {
	router.use((req: Request, res: Response, next: NextFunction) => {
		const role = localE2ERoleFromRequest(req);
		const authHeader = req.headers.authorization;
		const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim().toLowerCase() : null;
		const path = req.path;
		const method = req.method.toUpperCase();

		const requiresAuth =
			path === '/events'
			|| /^\/events\/[0-9a-f-]+\/status$/i.test(path)
			|| /^\/events\/[0-9a-f-]+\/ai-draft$/i.test(path)
			|| /^\/events\/[0-9a-f-]+\/report\.(csv|pdf)$/i.test(path)
			|| /^\/events\/[0-9a-f-]+\/report\/email$/i.test(path)
			|| path.startsWith('/admin/users')
			|| path === '/tavf/postings'
			|| path === '/tavf/subscription/me'
			|| path.startsWith('/tavf/postings');

		if (requiresAuth && !role) {
			res.status(401).json({ error: 'Missing or invalid Authorization header' });
			return;
		}

		if (method === 'GET' && path === '/events') {
			res.status(200).json([]);
			return;
		}

		if (method === 'PUT' && /^\/events\/[0-9a-f-]+\/status$/i.test(path)) {
			res.status(200).json({ ok: true, status: req.body?.status ?? 'draft' });
			return;
		}

		if (method === 'POST' && path === '/events') {
			if (role === 'ADMIN' || role === 'EVENT_CREATOR') {
				res.status(201).json({ event_id: '00000000-0000-4000-8000-000000000111', ...(req.body ?? {}) });
			} else {
				res.status(403).json({ error: 'Forbidden' });
			}
			return;
		}

		if (method === 'POST' && /^\/events\/[0-9a-f-]+\/ai-draft$/i.test(path)) {
			if (role === 'ADMIN' || role === 'EVENT_CREATOR') {
				res.status(200).json({
					event_id: path.split('/')[2] ?? null,
					tone: req.body?.tone ?? 'friendly',
					subject: 'Local E2E Draft',
					emailBody: 'Local E2E email draft body',
					smsBody: 'Local E2E sms draft',
					provider: 'fallback',
				});
			} else {
				res.status(403).json({ error: 'Forbidden' });
			}
			return;
		}

		if (method === 'GET' && /^\/events\/[0-9a-f-]+\/report\.(csv|pdf)$/i.test(path)) {
			if (role === 'ADMIN' || role === 'EVENT_CREATOR') {
				res.status(200).json({ ok: true });
			} else {
				res.status(403).json({ error: 'Forbidden' });
			}
			return;
		}

		if (method === 'POST' && /^\/events\/[0-9a-f-]+\/report\/email$/i.test(path)) {
			if (role === 'ADMIN' || role === 'EVENT_CREATOR') {
				res.status(200).json({ ok: true, sent: 1, recipients: ['local-e2e@example.org'] });
			} else {
				res.status(403).json({ error: 'Forbidden' });
			}
			return;
		}

		if (method === 'GET' && path.startsWith('/admin/users')) {
			if (role === 'ADMIN') {
				res.status(200).json({ users: [] });
			} else {
				res.status(403).json({ error: 'Forbidden' });
			}
			return;
		}

		if (method === 'POST' && path === '/tavf/postings') {
			if (role === 'ADMIN') {
				res.status(403).json({ error: 'Forbidden' });
			} else {
				res.status(201).json({ posting_id: '00000000-0000-4000-8000-000000000222', ...(req.body ?? {}) });
			}
			return;
		}

		if (method === 'GET' && path.startsWith('/tavf/postings')) {
			res.status(200).json([]);
			return;
		}

		if (path === '/tavf/subscription/me' && token) {
			if (!tavfSubscriptionByToken.has(token)) {
				tavfSubscriptionByToken.set(token, false);
			}

			if (method === 'GET') {
				res.status(200).json({ member_id: token, is_subscribed: tavfSubscriptionByToken.get(token) ?? false });
				return;
			}

			if (method === 'PUT') {
				const nextValue = Boolean(req.body?.is_subscribed);
				tavfSubscriptionByToken.set(token, nextValue);
				res.status(200).json({ member_id: token, is_subscribed: nextValue });
				return;
			}
		}

		next();
	});
}

router.use('/health', healthRouter);
router.use('/admin', adminRouter);
router.use('/calendar', calendarRouter);
router.use('/events', eventsRouter);
router.use('/rsvp', publicRsvpRouter);
router.use('/members', membersRouter);
router.use('/preferences', preferencesRouter);
router.use('/sms', smsRouter);
router.use('/support', supportRouter);
router.use('/groups', groupsRouter);
router.use('/import', importRouter);
router.use('/reports', reportsRouter);
router.use('/tavf', tavfRouter);
router.use('/templates', templatesRouter);

export default router;