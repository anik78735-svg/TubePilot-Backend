const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const {
  getDriveOAuthClient,
  exchangeCodeForDriveTokens,
  getUserDriveAccountInfo
} = require('../utils/googleDrive');
const User = require('../models/User');

const router = express.Router();

// Reuses the same FRONTEND_URL / redirect pattern as routes/youtube.js
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// @route GET /api/drive/oauth/url?platform=mobile|web
router.get('/oauth/url', protect, (req, res) => {
  const oauth2Client = getDriveOAuthClient();
  const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // ensures refresh_token is always returned
    scope: DRIVE_SCOPES,
    state
  });
  res.json({ success: true, url });
});

// @route GET /api/drive/oauth/callback
router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state } = req.query;
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';
    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User not found');

    const tokens = await exchangeCodeForDriveTokens(code);
    const accountInfo = await getUserDriveAccountInfo(tokens.access_token);

    user.connectedDrive = {
      email: accountInfo?.emailAddress || '',
      displayName: accountInfo?.displayName || '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.connectedDrive?.refreshToken,
      tokenExpiryDate: tokens.expiry_date,
      folderId: user.connectedDrive?.folderId || null,
      dailyUploadTime: user.connectedDrive?.dailyUploadTime || null,
      lastAutoUploadDate: user.connectedDrive?.lastAutoUploadDate || null,
      driveProcessedFileIds: user.connectedDrive?.driveProcessedFileIds || [],
      connectedAt: new Date()
    };
    await user.save();

    if (platform === 'mobile') {
      res.redirect('tubepilot://oauth-success?drive_connected=1');
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?drive_connected=1`);
    }
  } catch (err) {
    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?drive_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?drive_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
});

// @route DELETE /api/drive/disconnect
router.delete('/disconnect', protect, async (req, res) => {
  req.user.connectedDrive = null;
  await req.user.save();
  res.json({ success: true, message: 'Google Drive disconnected' });
});

// @route GET /api/drive/status
router.get('/status', protect, async (req, res) => {
  if (!req.user.connectedDrive) {
    return res.status(404).json({ success: false, message: 'No Google Drive connected' });
  }
  const { email, displayName, folderId, dailyUploadTime, connectedAt } = req.user.connectedDrive;
  res.json({ success: true, drive: { email, displayName, folderId, dailyUploadTime, connectedAt } });
});

// @route PATCH /api/drive/settings  { dailyUploadTime: "09:00", folderId? }
router.patch('/settings', protect, async (req, res) => {
  try {
    if (!req.user.connectedDrive) {
      return res.status(400).json({ success: false, message: 'Please connect Google Drive first' });
    }
    const { dailyUploadTime, folderId } = req.body;
    if (dailyUploadTime && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyUploadTime)) {
      return res.status(400).json({ success: false, message: 'dailyUploadTime must be in HH:mm (24-hour) format' });
    }
    if (dailyUploadTime !== undefined) req.user.connectedDrive.dailyUploadTime = dailyUploadTime;
    if (folderId !== undefined) req.user.connectedDrive.folderId = folderId;
    await req.user.save();

    const { email, displayName, folderId: fId, dailyUploadTime: dt, connectedAt } = req.user.connectedDrive;
    res.json({ success: true, drive: { email, displayName, folderId: fId, dailyUploadTime: dt, connectedAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
