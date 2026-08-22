import { Router } from 'express';
import authRoutes from './auth.routes';
import catalogRoutes from './catalog.routes';
import adminRoutes from './admin.routes';
import complaintRoutes from './complaints.routes';
import requestRoutes from './requests.routes';
import reportRoutes from './reports.routes';
import announcementRoutes from './announcements.routes';
import projectRoutes from './projects.routes';
import eventRoutes from './events.routes';
import notificationRoutes from './notifications.routes';
import dashboardRoutes from './dashboard.routes';
import auditRoutes from './audit.routes';
import uploadRoutes from './upload.routes';
import citizenRoutes from './citizens.routes';
import taskRoutes from './tasks.routes';
import meetingRoutes from './meetings.routes';
import cooperativeRoutes from './cooperatives.routes';
import realtimeRoutes from './realtime.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/catalog', catalogRoutes);
router.use('/admin', adminRoutes);
router.use('/complaints', complaintRoutes);
router.use('/requests', requestRoutes);
router.use('/reports', reportRoutes);
router.use('/announcements', announcementRoutes);
router.use('/projects', projectRoutes);
router.use('/events', eventRoutes);
router.use('/notifications', notificationRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/upload', uploadRoutes);
router.use('/citizens', citizenRoutes);
router.use('/tasks', taskRoutes);
router.use('/meetings', meetingRoutes);
router.use('/cooperatives', cooperativeRoutes);
router.use('/realtime', realtimeRoutes);

router.get('/', (_req, res) => {
  res.json({ name: 'Northern Province Governance API', version: 'v1' });
});

export default router;
