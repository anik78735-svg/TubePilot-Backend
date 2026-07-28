const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const {
  getDriveOAuthClient,
  exchangeCodeForDriveTokens,
  getUserDriveAccountInfo,
  listUserDriveFolders
} = require('../utils/googleDrive');
const { sendOneSignalToUser } = require('../utils/oneSignalPush');
const User = require('../models/User');

const router = express.Router();

const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const DRIVE_RECONNECT_DIAMOND_COST = Number(process.env.DRIVE_RECONNECT_DIAMOND_COST || 30);

// @route GET /api/drive/oauth/url?platform=mobile|web
router.get('/oauth/url', protect, (req, res) => {
  const oauth2Client = getDriveOAuthClient();
  const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_SCOPES,
    state
  });
  res.json({ success: true, url });
});

// @route GET /api/drive/oauth/callback
// 1st-ever Drive connect for a user is free. Every connect after that
// (2nd, 3rd, ...) costs DRIVE_RECONNECT_DIAMOND_COST diamonds — charged
// ONLY after the OAuth exchange succeeds, so cancelling mid-flow never
// costs anything. If the user doesn't have enough diamonds, we do NOT save
// the new connectedDrive and redirect back with an insufficient-diamonds error.
router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state } = req.query;
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';
    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User not found');

    const isFirstConnect = (user.driveConnectCount || 0) === 0;

    if (!isFirstConnect) {
      if (user.diamondBalance < DRIVE_RECONNECT_DIAMOND_COST) {
        sendOneSignalToUser(user, {
          title: 'Not enough diamonds 💎',
          body: `Connecting another Google Drive costs ${DRIVE_RECONNECT_DIAMOND_COST} diamonds. Please buy more diamonds.`,
          data: { type: 'insufficient_diamonds' }
        }).catch(() => {});
        const msg = encodeURIComponent(`You need ${DRIVE_RECONNECT_DIAMOND_COST} diamonds to connect another Drive account.`);
        if (platform === 'mobile') {
          return res.redirect(`tubepilot://oauth-success?drive_connected=0&error=${msg}&code=INSUFFICIENT_DIAMONDS`);
        }
        return res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?drive_connected=0&error=${msg}`);
      }
    }

    const tokens = await exchangeCodeForDriveTokens(code);
    const accountInfo = await getUserDriveAccountInfo(tokens.access_token);

    if (!isFirstConnect) {
      user.diamondBalance -= DRIVE_RECONNECT_DIAMOND_COST;
    }

    user.connectedDrive = {
      email: accountInfo?.emailAddress || '',
      displayName: accountInfo?.displayName || '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.connectedDrive?.refreshToken,
      tokenExpiryDate: tokens.expiry_date,
      folderId: null, // always reset scope on a fresh connect — user re-picks the folder
      folderName: null,
      dailyUploadTime: user.connectedDrive?.dailyUploadTime || null,
      lastAutoUploadDate: null,
      driveProcessedFileIds: [],
      connectedAt: new Date()
    };
    user.driveConnectCount = (user.driveConnectCount || 0) + 1;
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
// Note: driveConnectCount is NOT reset here on purpose — it tracks lifetime
// connects, so a future reconnect after this disconnect still charges
// (unless this was never actually a paid/free connect yet).
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
  const { email, displayName, folderId, folderName, dailyUploadTime, connectedAt } = req.user.connectedDrive;
  res.json({
    success: true,
    drive: { email, displayName, folderId, folderName, dailyUploadTime, connectedAt },
    driveConnectCount: req.user.driveConnectCount || 0,
    nextConnectDiamondCost: (req.user.driveConnectCount || 0) === 0 ? 0 : DRIVE_RECONNECT_DIAMOND_COST
  });
});

// @route PATCH /api/drive/settings  { dailyUploadTime?, folderId?, folderName? }
router.patch('/settings', protect, async (req, res) => {
  try {
    if (!req.user.connectedDrive) {
      return res.status(400).json({ success: false, message: 'Please connect Google Drive first' });
    }
    const { dailyUploadTime, folderId, folderName } = req.body;
    if (dailyUploadTime && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyUploadTime)) {
      return res.status(400).json({ success: false, message: 'dailyUploadTime must be in HH:mm (24-hour) format' });
    }
    if (dailyUploadTime !== undefined) req.user.connectedDrive.dailyUploadTime = dailyUploadTime;
    if (folderId !== undefined) req.user.connectedDrive.folderId = folderId;
    if (folderName !== undefined) req.user.connectedDrive.folderName = folderName;
    await req.user.save();

    const { email, displayName, folderId: fId, folderName: fName, dailyUploadTime: dt, connectedAt } = req.user.connectedDrive;
    res.json({ success: true, drive: { email, displayName, folderId: fId, folderName: fName, dailyUploadTime: dt, connectedAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/drive/folders?parentId=xxx
// Lists sub-folders for the folder picker. Omit parentId to list root-level
// folders. Used by the "select/change folder" feature.
router.get('/folders', protect, async (req, res) => {
  try {
    if (!req.user.connectedDrive) {
      return res.status(400).json({ success: false, message: 'Please connect Google Drive first' });
    }
    const parentId = req.query.parentId || undefined;
    const folders = await listUserDriveFolders(req.user, parentId);
    res.json({ success: true, folders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
