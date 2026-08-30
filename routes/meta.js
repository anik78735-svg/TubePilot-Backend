const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  revokeFacebookAccess
} = require('../utils/meta');
const User = require('../models/User');

const router = express.Router();

const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

// Quick sanity check of required env vars
(function checkMetaEnv() {
  const required = ['JWT_SECRET', 'FRONTEND_URL', 'META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`⚠️ [Meta Routes] Missing env vars: ${missing.join(', ')} — OAuth flow WILL fail without these.`);
  } else {
    console.log('✅ [Meta Routes] Required env vars present.');
  }
})();

/**
 * Controller: Generate OAuth URL for Facebook
 * Supports mobile & web platforms
 */
const handleGetOAuthUrl = async (req, res) => {
  try {
    const platform = req.query.platform === 'web' ? 'web' : 'mobile';
    const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const url = getFacebookOAuthUrl(state);
    
    console.log(`▶️ [Meta OAuth URL] user=${req.user._id} platform=${platform}`);
    console.log(`ℹ️ [Meta OAuth URL] Generated URL: ${url}`);
    
    return res.json({ 
      success: true, 
      url,
      authUrl: url,
      oauthUrl: url
    });
  } catch (err) {
    console.error(`❌ [Meta OAuth URL] Failed to generate URL:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Controller: OAuth Callback Handler
 */
const handleOAuthCallback = async (req, res) => {
  let platform = 'mobile';
  try {
    const { code, state, error, error_reason, error_description } = req.query;

    if (error) {
      console.error(`❌ [Meta OAuth Callback] Facebook error: error=${error} description=${error_description}`);
      throw new Error(error_description || error_reason || error);
    }

    if (!code) {
      console.error(`❌ [Meta OAuth Callback] Missing code param`);
      throw new Error('Missing authorization code from Facebook');
    }

    if (!state) {
      console.error(`❌ [Meta OAuth Callback] Missing state param`);
      throw new Error('Missing state param');
    }

    let decoded;
    try {
      decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch (jwtErr) {
      console.error(`❌ [Meta OAuth Callback] state JWT verify failed:`, jwtErr.message);
      throw new Error(`Invalid or expired state token: ${jwtErr.message}`);
    }

    platform = decoded.platform || 'mobile';
    console.log(`▶️ [Meta OAuth Callback] Starting for user ${decoded.id}, platform=${platform}`);

    const user = await User.findById(decoded.id);
    if (!user) {
      throw new Error('User not found');
    }

    // Step 1: Exchange code for short-lived token
    const shortLivedToken = await exchangeCodeForToken(code);
    console.log(`✅ [Meta OAuth Callback] Got short-lived token`);

    // Step 2: Get long-lived token
    const longLivedToken = await getLongLivedUserToken(shortLivedToken);
    console.log(`✅ [Meta OAuth Callback] Got long-lived token`);

    // Step 3: Fetch User Facebook Pages
    const pages = await getUserPages(longLivedToken);
    console.log(`✅ [Meta OAuth Callback] getUserPages returned ${pages ? pages.length : 0} page(s)`);

    if (!pages || !pages.length) {
      throw new Error('No Facebook Pages found on this account. You need a Facebook Page to publish Reels.');
    }

    if (pages.length === 1) {
      console.log(`ℹ️ [Meta OAuth Callback] 1 page found, auto-connecting: ${pages[0].name}`);
      await connectPageToUser(user, pages[0]);
    } else {
      console.log(`ℹ️ [Meta OAuth Callback] ${pages.length} pages found, awaiting page selection`);
      user.set('metaPendingPages', pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token })));
      await user.save();
    }

    if (platform === 'mobile') {
      return res.redirect(`tubepilot://oauth-success?meta_connected=1&multiple_pages=${pages.length > 1 ? '1' : '0'}`);
    } else {
      return res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=1`);
    }
  } catch (err) {
    console.error(`❌ [Meta OAuth Callback] Failed:`, err.message);
    if (platform === 'mobile') {
      return res.redirect(`tubepilot://oauth-success?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      return res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
};

const connectPageToUser = async (user, page) => {
  try {
    user.connectedFacebook = {
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.access_token,
      connectedAt: new Date()
    };

    user.set('metaPendingPages', undefined);
    await user.save();
    console.log(`✅ [connectPageToUser] Saved connectedFacebook for user ${user._id}: ${page.name}`);
  } catch (err) {
    console.error(`❌ [connectPageToUser] Failed to save user:`, err.message);
    throw err;
  }
};

/**
 * Disconnect Handler
 */
const handleDisconnect = async (req, res) => {
  try {
    console.log(`ℹ️ [Meta Disconnect] user=${req.user._id}`);
    const existing = req.user.connectedFacebook;

    if (existing?.pageId && existing?.pageAccessToken) {
      const result = await revokeFacebookAccess(existing.pageId, existing.pageAccessToken);
      if (!result.revoked) {
        console.warn(`⚠️ [Meta Disconnect] Revoke failed (${result.reason}), proceeding locally.`);
      }
    }

    req.user.connectedFacebook = null;
    req.user.set('metaPendingPages', undefined);
    await req.user.save();

    res.json({ success: true, message: 'Facebook disconnected successfully' });
  } catch (err) {
    console.error(`❌ [Meta Disconnect] Failed:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// -----------------------------------------------------------------------
// ROUTE REGISTRATION & ALIASES (Fixes Route Not Found Errors)
// -----------------------------------------------------------------------

// OAuth URL generation endpoints
router.get('/oauth/url', protect, handleGetOAuthUrl);
router.get('/facebook/url', protect, handleGetOAuthUrl);
router.get('/facebook-auth-url', protect, handleGetOAuthUrl);
router.get('/oauth-url', protect, handleGetOAuthUrl);
router.get('/auth-url', protect, handleGetOAuthUrl);
router.get('/connect', protect, handleGetOAuthUrl);
router.get('/facebook/connect', protect, handleGetOAuthUrl);

// Callback endpoints
router.get('/oauth/callback', handleOAuthCallback);
router.get('/facebook/callback', handleOAuthCallback);
router.get('/callback', handleOAuthCallback);

// Pages & Page Selection
router.get('/pages', protect, async (req, res) => {
  try {
    const pending = req.user.get('metaPendingPages') || [];
    res.json({ success: true, pages: pending.map((p) => ({ id: p.id, name: p.name })) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/select-page', protect, async (req, res) => {
  try {
    const pending = req.user.get('metaPendingPages') || [];
    const chosen = pending.find((p) => p.id === req.body.pageId);
    if (!chosen) {
      return res.status(400).json({ success: false, message: 'Page not found in pending list' });
    }

    await connectPageToUser(req.user, chosen);
    res.json({
      success: true,
      facebook: { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Disconnect Endpoints
router.delete('/facebook/disconnect', protect, handleDisconnect);
router.delete('/disconnect', protect, handleDisconnect);

// Connection Status Endpoint
router.get('/status', protect, async (req, res) => {
  try {
    res.json({
      success: true,
      facebook: req.user.connectedFacebook
        ? { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName, connectedAt: req.user.connectedFacebook.connectedAt }
        : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.getFacebookOAuthUrl = getFacebookOAuthUrl;
