require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');

const {
  startPublishScheduler,
  startRetryScheduler,
  startFreeUploadReset,
  startDriveAutoUploadScheduler
} = require('./cron/scheduler');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const youtubeRoutes = require('./routes/youtube');
const driveRoutes = require('./routes/drive');
const metaRoutes = require('./routes/meta');
const videoRoutes = require('./routes/video');
const diamondRoutes = require('./routes/diamond');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const analyticsRoutes = require('./routes/analytics');
const ratingsRoutes = require('./routes/ratings');
const seedAdminRoute = require('./routes/seedAdmin');

const app = express();

/* -------------------- Security -------------------- */

app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`⚠️ CORS blocked: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({
  extended: true,
  limit: '10mb'
}));
app.use(cookieParser());

/* -------------------- Rate Limit -------------------- */

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300
});

app.use('/api', globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);

/* -------------------- Root Route -------------------- */

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    application: 'TubePilot API',
    version: '1.0.0',
    status: 'Running',
    environment: process.env.NODE_ENV || 'development',
    documentation: '/api/health',
    timestamp: new Date().toISOString()
  });
});

/* -------------------- Health -------------------- */

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'TubePilot API is running'
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'TubePilot API is running'
  });
});

/* -------------------- API Routes -------------------- */

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/diamonds', diamondRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ratings', ratingsRoutes);
app.use('/api/seed-admin', seedAdminRoute);

/* -------------------- API 404 -------------------- */

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API Route Not Found'
  });
});

/* -------------------- Global Error Handler -------------------- */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

/* -------------------- Server -------------------- */

const PORT = process.env.PORT || 5000;

const start = async () => {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`🚀 TubePilot backend running on port ${PORT}`);

      startPublishScheduler();
      startRetryScheduler();
      startFreeUploadReset();
      startDriveAutoUploadScheduler();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

start();

module.exports = app;
