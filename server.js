require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');
const { startScheduler, startFreeUploadReset, startPrivacyPublishScheduler } = require('./cron/scheduler');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const youtubeRoutes = require('./routes/youtube');
const videoRoutes = require('./routes/video');
const diamondRoutes = require('./routes/diamond');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const analyticsRoutes = require('./routes/analytics');
const seedAdminRoute = require('./routes/seedAdmin');

const app = express();

// --- Trust proxy (required on Render/Heroku/Vercel etc, hosted behind a reverse proxy) ---
// This must be set BEFORE any middleware that reads req.ip / X-Forwarded-For,
// including express-rate-limit below. Value "1" means: trust the first hop
// (Render's own proxy) — correct for a standard single-proxy deployment.
app.set('trust proxy', 1);

// --- Security & core middleware ---
app.use(helmet());

// FRONTEND_URL can be a comma-separated list, e.g.
// http://127.0.0.1:5500,http://localhost:5500,capacitor://localhost,http://localhost
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (curl/Postman) which send no origin,
    // and any origin that matches our whitelist.
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

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/diamonds', diamondRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/seed-admin', seedAdminRoute);

app.get('/api/health', (req, res) => res.json({ success: true, message: 'TubePilot API is running' }));

// 404 handler
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Global error handler (multer errors, etc.)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

// --- Keep-alive self-ping (prevents Render free-tier service from sleeping) ---
// Render sets RENDER_EXTERNAL_URL automatically on deployed services, so this
// only runs in that environment and stays inactive during local development.
const startKeepAlivePing = () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) {
    console.log('ℹ️  RENDER_EXTERNAL_URL not set, skipping keep-alive ping (likely local dev)');
    return;
  }

  const pingIntervalMs = 13 * 60 * 1000; // 13 minutes (under most free-tier ~15min idle timeouts)

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
    startKeepAlivePing();
  });
};

start();

module.exports = app;
