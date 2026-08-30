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

// Route Imports
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
const postsRoutes = require('./routes/posts');

const app = express();

// Required because Render (and most hosts) sit behind a reverse proxy
app.set('trust proxy', 1);

// --- Security & Core Middleware ---
app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Enhanced CORS setup: Supports Web, Mobile Apps, and API clients
app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser calls (like Mobile Apps or Postman) or matched frontend origins
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    console.warn(`⚠️ CORS blocked request from origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Rate Limiters
const globalLimiter = rateLimit({ 
  windowMs: 15 * 60 * 1000, 
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', globalLimiter);

const authLimiter = rateLimit({ 
  windowMs: 15 * 60 * 1000, 
  max: 20,
  message: { success: false, message: 'Too many authentication attempts, please try again later.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);

// --- API Route Registrations & Fallback Aliases ---
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/meta', metaRoutes);

// Video Routes (Supports both Singular and Plural aliases)
app.use('/api/videos', videoRoutes);
app.use('/api/video', videoRoutes);

// Diamond & Payment Routes (Supports plural, singular, and payment aliases)
app.use('/api/diamonds', diamondRoutes);
app.use('/api/diamond', diamondRoutes);
app.use('/api/payment', diamondRoutes);

app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ratings', ratingsRoutes);
app.use('/api/seed-admin', seedAdminRoute);
app.use('/api/posts', postsRoutes);

// Health Check Endpoint
app.get('/api/health', (req, res) => res.json({ 
  success: true, 
  message: 'TubePilot API is running',
  timestamp: new Date().toISOString()
}));

// Catch-all 404 for API endpoints
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Centralized Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('❌ [Global Server Error]:', err.stack || err.message);
  
  // Handle CORS Error explicitly
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'CORS policy blocked this request' });
  }

  res.status(err.status || 500).json({ 
    success: false, 
    message: err.message || 'Internal Server Error' 
  });
});

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
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

start();

module.exports = app;
