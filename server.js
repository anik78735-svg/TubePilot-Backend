require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const {
  startScheduler,
  startFreeUploadReset,
  startPrivacyPublishScheduler,
  startStorageCleanupScheduler,
  startDriveAutoUploadScheduler
} = require('./cron/scheduler');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const youtubeRoutes = require('./routes/youtube');
const driveRoutes = require('./routes/drive');
const videoRoutes = require('./routes/video');
const diamondRoutes = require('./routes/diamond');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const analyticsRoutes = require('./routes/analytics');
const ratingsRoutes = require('./routes/ratings');
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`⚠️  CORS blocked request from origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', globalLimiter);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/diamonds', diamondRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ratings', ratingsRoutes);
app.get('/api/health', (req, res) => res.json({ success: true, message: 'TubePilot API is running' }));
// Root-level health check (no /api prefix) — kept separate from the rate
// limiter above (which only applies to /api/*) so an external uptime
// monitor (e.g. UptimeRobot) hitting this frequently every few minutes can
// never get rate-limited or accidentally counted against /api/* quotas.
// Point UptimeRobot at: https://<your-render-url>/health
app.get('/health', (req, res) => res.status(200).json({ success: true, status: 'ok', uptime: process.uptime() }));
app.get('/', (req, res) => res.status(200).json({ success: true, status: 'ok' }));
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Server error' });
});
const PORT = process.env.PORT || 5000;
const startKeepAlivePing = () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) {
    console.log('ℹ️  RENDER_EXTERNAL_URL not set, skipping keep-alive ping (likely local dev)');
    return;
  }
  const pingIntervalMs = 13 * 60 * 1000;
  setInterval(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      console.log(`🔁 Keep-alive ping: ${res.status} at ${new Date().toISOString()}`);
    } catch (err) {
      console.warn(`⚠️  Keep-alive ping failed: ${err.message}`);
    }
  }, pingIntervalMs);
  console.log(`⏱️  Keep-alive ping scheduled every ${pingIntervalMs / 60000} minutes to ${baseUrl}/api/health`);
};
const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 TubePilot backend running on port ${PORT}`);
    startScheduler();
    startFreeUploadReset();
    startPrivacyPublishScheduler();
    startStorageCleanupScheduler();
    startDriveAutoUploadScheduler();
    startKeepAlivePing();
  });
};
start();
module.exports = app;
