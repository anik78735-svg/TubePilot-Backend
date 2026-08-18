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

console.log(`ℹ️  Google Drive OAuth redirect URI configured as: ${process.env.GOOGLE_DRIVE_REDIRECT_URI || '⚠️ EMPTY — check GOOGLE_DRIVE_REDIRECT_URI in .env'}`);
console.log(`ℹ️  JWT_SECRET is ${process.env.JWT_SECRET ? 'set (length ' + process.env.JWT_SECRET.length + ')' : '⚠️ EMPTY — check JWT_SECRET in .env'}`);

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

  console.log(`🔗 [Drive OAuth] Generated auth URL for user ${req.user._id} (platform=${platform}). state length=${state.length}. Full URL: ${url}`);

  res.json({ success: true, url });
});

// @route GET /api/drive/oauth/callback
router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';

  console.log(`🔗 [Drive OAuth] Callback hit. Full query received:`, JSON.stringify(req.query));
  console.log(`🔗 [Drive OAuth] Raw request URL: ${req.originalUrl}`);

  try {
    const { code, state } = req.query;

    if (!state) {
      console.warn('⚠️ [Drive OAuth] Callback hit with no state — ignoring (likely browser retry/prefetch, not a real OAuth redirect).');
      return res.status(204).end();
    }

    if (!process.env.JWT_SECRET) {
      console.error('❌ [Drive OAuth] JWT_SECRET env var is empty — cannot verify state.');
      throw new Error('Server misconfiguration: JWT_SECRET is not set');
    }

    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';
    console.log(`✅ [Drive OAuth] state verified OK. userId=${decoded.id}, platform=${platform}`);

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

    // Only reset folder/upload-progress state when the connecting account
    // is genuinely DIFFERENT from what was already connected — reconnecting
    // the SAME account (e.g. a token-refresh style OAuth round-trip) keeps
    // everything the user already configured, including uploadMode.
    const previousEmail = user.connectedDrive?.email || null;
    const newEmail = accountInfo?.emailAddress || '';
    const isSameAccount = previousEmail && previousEmail === newEmail;

    user.connectedDrive = {
      email: newEmail,
      displayName: accountInfo?.displayName || '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.connectedDrive?.refreshToken,
      tokenExpiryDate: tokens.expiry_date,
      folderId: isSameAccount ? (user.connectedDrive?.folderId ?? null) : null,
      folderName: isSameAccount ? (user.connectedDrive?.folderName ?? null) : null,
      dailyUploadTime: user.connectedDrive?.dailyUploadTime || null,
      uploadMode: isSameAccount ? (user.connectedDrive?.uploadMode || 'scheduled') : 'scheduled',
      lastAutoUploadDate: isSameAccount ? (user.connectedDrive?.lastAutoUploadDate ?? null) : null,
      driveProcessedFileIds: isSameAccount ? (user.connectedDrive?.driveProcessedFileIds || []) : [],
      noNewVideoSinceDate: isSameAccount ? (user.connectedDrive?.noNewVideoSinceDate ?? null) : null,
      connectedAt: new Date()
    };
    user.driveConnectCount = (user.driveConnectCount || 0) + 1;
    await user.save();

    console.log(`✅ [Drive OAuth] Drive connected successfully for user ${user._id} (${newEmail || 'unknown email'}). sameAccountReconnect=${isSameAccount}`);

    if (platform === 'mobile') {
      res.redirect('tubepilot://oauth-success?drive_connected=1');
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?drive_connected=1`);
    }
  } catch (err) {
    console.error('❌ Google Drive OAuth callback failed:', err.message);
    console.error(err.stack);

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
  const { email, displayName, folderId, folderName, dailyUploadTime, uploadMode, connectedAt } = req.user.connectedDrive;
  res.json({
    success: true,
    drive: { email, displayName, folderId, folderName, dailyUploadTime, uploadMode: uploadMode || 'scheduled', connectedAt },
    driveConnectCount: req.user.driveConnectCount || 0,
    nextConnectDiamondCost: (req.user.driveConnectCount || 0) === 0 ? 0 : DRIVE_RECONNECT_DIAMOND_COST
  });
});

// @route PATCH /api/drive/settings  { dailyUploadTime?, folderId?, folderName?, uploadMode? }
// NOTE: the frontend (lib/services/api_service.dart -> updateDriveSettings)
// only includes folderId/folderName/uploadMode in the request body when it
// actually intends to change them — see the fix note there. This route's
// `!== undefined` checks are correct AS LONG AS the client honors that
// contract.
router.patch('/settings', protect, async (req, res) => {
  try {
    if (!req.user.connectedDrive) {
      return res.status(400).json({ success: false, message: 'Please connect Google Drive first' });
    }
    const { dailyUploadTime, folderId, folderName, uploadMode } = req.body;

    if (dailyUploadTime && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyUploadTime)) {
      return res.status(400).json({ success: false, message: 'dailyUploadTime must be in HH:mm (24-hour) format' });
    }
    if (uploadMode !== undefined && !['scheduled', 'live'].includes(uploadMode)) {
      return res.status(400).json({ success: false, message: "uploadMode must be 'scheduled' or 'live'" });
    }

    if (dailyUploadTime !== undefined) req.user.connectedDrive.dailyUploadTime = dailyUploadTime;
    if (folderId !== undefined) req.user.connectedDrive.folderId = folderId;
    if (folderName !== undefined) req.user.connectedDrive.folderName = folderName;
    if (uploadMode !== undefined) req.user.connectedDrive.uploadMode = uploadMode;
    await req.user.save();

    console.log(
      `⚙️ [Drive Settings] User ${req.user._id} updated Drive settings — ` +
      `dailyUploadTime=${req.user.connectedDrive.dailyUploadTime || '(not set)'}, ` +
      `folder=${req.user.connectedDrive.folderName || '(whole drive)'}, ` +
      `uploadMode=${req.user.connectedDrive.uploadMode}`
    );

    const { email, displayName, folderId: fId, folderName: fName, dailyUploadTime: dt, uploadMode: mode, connectedAt } = req.user.connectedDrive;
    res.json({ success: true, drive: { email, displayName, folderId: fId, folderName: fName, dailyUploadTime: dt, uploadMode: mode, connectedAt } });

    // ⚡ Instant test trigger: if the user just switched to (or already
    // was in) Live Upload mode, kick off an immediate background check
    // right now instead of making them wait up to a minute for the next
    // cron tick. Fire-and-forget — the response above has already gone
    // out, this just makes the Render logs light up right away so testing
    // doesn't require waiting.
    if (req.user.connectedDrive.uploadMode === 'live') {
      const { runDriveAutoUploadForUser, getCurrentISTHHMM } = require('../cron/scheduler');
      const { istDate } = getCurrentISTHHMM();
      const todayStr = istDate.toISOString().slice(0, 10);
      console.log(`⚡ [Drive Settings] User ${req.user._id}: Live Upload mode active — firing immediate check (not waiting for next cron tick)...`);
      runDriveAutoUploadForUser(req.user, todayStr).catch((err) => {
        console.error(`❌ [Drive Settings] Immediate Live Upload check failed for user ${req.user._id}:`, err.message);
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/drive/folders?parentId=xxx
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
