const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const { getOAuthClient, exchangeCodeForTokens, getChannelInfo, refreshAccessToken } = require('../utils/youtube');
const User = require('../models/User');

const router = express.Router();

// FRONTEND_URL may be a comma-separated list — use the first one to redirect back after OAuth
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();
console.log(`ℹ️  YouTube OAuth callback will redirect back to: ${PRIMARY_FRONTEND_URL || '⚠️ EMPTY — check FRONTEND_URL in .env'}`);

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube'
];

// @route GET /api/youtube/oauth/url?platform=mobile|web
// Returns the Google consent URL. We encode the user's id + platform in `state` (signed) so the
// callback (which Google redirects to, no auth header available) knows who connected and where to send them back.
router.get('/oauth/url', protect, (req, res) => {
  const oauth2Client = getOAuthClient();
  const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // ensures refresh_token is always returned
    scope: SCOPES,
    state
  });

  res.json({ success: true, url });
});

// @route GET /api/youtube/oauth/callback
// Google redirects here after user grants permission.
router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state } = req.query;
    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'web';
    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User not found');

    const tokens = await exchangeCodeForTokens(code);
    const channel = await getChannelInfo(tokens.access_token);

    if (!channel) {
      throw new Error('No YouTube channel found on this Google account');
    }

    user.youtubeChannel = {
      channelId: channel.id,
      channelTitle: channel.snippet.title,
      thumbnail: channel.snippet.thumbnails?.default?.url || '',
      subscriberCount: channel.statistics?.subscriberCount || '0',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || user.youtubeChannel?.refreshToken,
      tokenExpiryDate: tokens.expiry_date,
      connectedAt: new Date()
    };
    await user.save();

    // Mobile (Flutter app, opened via external browser) -> bounce back into the app via a custom deep link
    // Web (Live Server / deployed site) -> redirect to the existing dashboard.html page
    if (platform === 'mobile') {
      res.redirect('tubepilot://oauth-success?youtube_connected=1');
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?youtube_connected=1`);
    }
  } catch (err) {
    // Logged with full detail so Render logs show the real cause
    // (redirect_uri_mismatch, invalid_grant, missing test-user access, etc.)
    // instead of just a generic "failed to connect" toast in the app.
    console.error('❌ YouTube OAuth callback failed:', err.message);
    console.error(err.stack);

    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?youtube_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?youtube_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
});

// @route DELETE /api/youtube/disconnect
router.delete('/disconnect', protect, async (req, res) => {
  req.user.youtubeChannel = null;
  await req.user.save();
  res.json({ success: true, message: 'YouTube channel disconnected' });
});

// @route GET /api/youtube/channel
// Returns the connected channel's info with a LIVE subscriber count.
//
// Previously this just read whatever was stored in the DB — which was only
// ever set once, at the moment of OAuth connect (see /oauth/callback above).
// That meant subscriberCount silently went stale forever: if a channel
// grew from 100 to 10,000 subscribers after connecting, the app would keep
// showing 100 until the user disconnected and reconnected.
//
// Now: every call to this route fetches fresh stats from the YouTube API
// (refreshing the access token first if it's expired) and updates the
// stored value before responding, so the number shown in the app is always
// current as of whenever the profile/settings screen was last opened.
//
// If the live fetch fails for any reason (token revoked, API hiccup,
// channel deleted on YouTube's side, etc.) we fall back to the last known
// stored value instead of erroring out the whole screen — a slightly stale
// number is a much better experience than a broken profile page.
router.get('/channel', protect, async (req, res) => {
  if (!req.user.youtubeChannel) {
    return res.status(404).json({ success: false, message: 'No YouTube channel connected' });
  }

  const stored = req.user.youtubeChannel;
  let accessToken = stored.accessToken;
  let refreshTokenValue = stored.refreshToken;
  let tokenExpiryDate = stored.tokenExpiryDate;
  let needsSave = false;

  try {
    const isExpired = !tokenExpiryDate || Date.now() >= tokenExpiryDate - 60_000; // refresh 1 min early
    if (isExpired) {
      if (!refreshTokenValue) throw new Error('No refresh token stored — cannot refresh access token');
      const credentials = await refreshAccessToken(refreshTokenValue);
      accessToken = credentials.access_token;
      tokenExpiryDate = credentials.expiry_date;
      needsSave = true;
    }

    const channel = await getChannelInfo(accessToken);
    if (!channel) throw new Error('Channel not found on YouTube');

    const freshSubscriberCount = channel.statistics?.subscriberCount || '0';
    const freshThumbnail = channel.snippet.thumbnails?.default?.url || stored.thumbnail;
    const freshTitle = channel.snippet.title || stored.channelTitle;

    if (
      freshSubscriberCount !== stored.subscriberCount ||
      freshThumbnail !== stored.thumbnail ||
      freshTitle !== stored.channelTitle ||
      needsSave
    ) {
      req.user.youtubeChannel.subscriberCount = freshSubscriberCount;
      req.user.youtubeChannel.thumbnail = freshThumbnail;
      req.user.youtubeChannel.channelTitle = freshTitle;
      req.user.youtubeChannel.accessToken = accessToken;
      req.user.youtubeChannel.tokenExpiryDate = tokenExpiryDate;
      await req.user.save();
    }

    return res.json({
      success: true,
      channel: {
        channelId: stored.channelId,
        channelTitle: freshTitle,
        thumbnail: freshThumbnail,
        subscriberCount: freshSubscriberCount,
        connectedAt: stored.connectedAt
      }
    });
  } catch (err) {
    console.error('⚠️  Live YouTube channel refresh failed, falling back to stored value:', err.message);
    const { channelId, channelTitle, thumbnail, subscriberCount, connectedAt } = stored;
    return res.json({
      success: true,
      channel: { channelId, channelTitle, thumbnail, subscriberCount, connectedAt },
      stale: true
    });
  }
});

module.exports = router;
