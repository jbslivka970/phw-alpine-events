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

type LocalE2EMember = {
	member_id: string;
	first_name: string;
	last_name: string;
	email: string;
	mobile_phone: string | null;
	sms_opt_in: boolean;
	email_opt_out: boolean;
	is_active: boolean;
	created_at: string;
	updated_at: string;
};

function localE2EMemberForToken(token: string | null): LocalE2EMember {
	const now = new Date().toISOString();
	if (token === 'e2e-admin') {
		return {
			member_id: '00000000-0000-4000-8000-000000000101',
			first_name: 'Admin',
			last_name: 'Local',
			email: 'admin@local.e2e',
			mobile_phone: '+13035550101',
			sms_opt_in: true,
			email_opt_out: false,
			is_active: true,
			created_at: now,
			updated_at: now,
		};
	}

	if (token === 'e2e-event_creator') {
		return {
			member_id: '00000000-0000-4000-8000-000000000102',
			first_name: 'Event',
			last_name: 'Creator',
			email: 'event_creator@local.e2e',
			mobile_phone: '+13035550102',
			sms_opt_in: true,
			email_opt_out: false,
			is_active: true,
			created_at: now,
			updated_at: now,
		};
	}

	return {
		member_id: '00000000-0000-4000-8000-000000000103',
		first_name: 'Member',
		last_name: 'User',
		email: 'user@local.e2e',
		mobile_phone: '+13035550103',
		sms_opt_in: false,
		email_opt_out: false,
		is_active: true,
		created_at: now,
		updated_at: now,
	};
}

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

		if (path === '/members' || /^\/members\//i.test(path)) {
			const member = localE2EMemberForToken(token);

			if (method === 'GET' && path === '/members') {
				const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
				const matches = !search
					|| member.email.toLowerCase().includes(search)
					|| `${member.first_name} ${member.last_name}`.toLowerCase().includes(search);
				res.status(200).json({
					data: matches ? [member] : [],
					total: matches ? 1 : 0,
					page: Number(req.query.page ?? 1),
					pageSize: Number(req.query.pageSize ?? 50),
				});
				return;
			}

			if (method === 'GET' && path === '/members/me') {
				res.status(200).json(member);
				return;
			}

			if (method === 'GET' && /^\/members\/[^/]+$/i.test(path)) {
				res.status(200).json(member);
				return;
			}

			if (method === 'GET' && /^\/members\/[^/]+\/sms-rollout-status$/i.test(path)) {
				res.status(200).json({
					member_id: member.member_id,
					sms_rollout_enabled: true,
					reason: 'open_rollout',
					configured_emails: [],
					configured_groups: [],
					matched_groups: [],
				});
				return;
			}

			if (method === 'GET' && /^\/members\/[^/]+\/sms-consent-log$/i.test(path)) {
				res.status(200).json([]);
				return;
			}

			if (method === 'GET' && /^\/members\/me\/rsvps$/i.test(path)) {
				res.status(200).json([]);
				return;
			}
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