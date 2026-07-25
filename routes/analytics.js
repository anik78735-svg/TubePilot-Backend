const express = require('express');
const { protect } = require('../middleware/auth');
const Video = require('../models/Video');
const router = express.Router();

// @route GET /api/analytics
// Note: real "Views / Watch Time / CTR / Subscribers" numbers must come from the
// YouTube Analytics API (youtubeAnalytics.reports.query) using the connected channel's
// access token — plug that call in here once the channel has enough data.
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);
    fourteenDaysAgo.setHours(0, 0, 0, 0);

    const [uploadCount, scheduledQueue, failedUploads, trendRows, recentActivity] = await Promise.all([
      Video.countDocuments({ user: userId, status: 'uploaded' }),
      Video.countDocuments({ user: userId, status: 'scheduled' }),
      Video.countDocuments({ user: userId, status: 'failed' }),
      // Daily upload counts for the last 14 days, for the trend chart
      Video.aggregate([
        { $match: { user: userId, status: 'uploaded', createdAt: { $gte: fourteenDaysAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } }
      ]),
      // Most recent 15 videos, for the activity/usage list
      Video.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(15)
        .select('title status diamondsCharged usedFreeUpload createdAt')
    ]);

    // Build a full 14-day array (including zero-count days) so the chart has consistent x-axis points
    const trendMap = {};
    trendRows.forEach((r) => { trendMap[r._id] = r.count; });
    const uploadTrend = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(fourteenDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      uploadTrend.push({ date: key, count: trendMap[key] || 0 });
    }

    res.json({
      success: true,
      analytics: {
        uploadCount,
        remainingUploadCredits: req.user.diamondBalance,
        freeUploadsLeft: req.user.freeUploadsRemaining,
        scheduledQueue,
        failedUploads,
        uploadTrend,
        recentActivity
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
