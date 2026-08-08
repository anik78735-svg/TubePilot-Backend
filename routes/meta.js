const express = require('express');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/auth');
const {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages
} = require('../utils/meta');
const User = require('../models/User');

const router = express.Router();

const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

// Quick sanity check of required env vars — logs once at startup
(function checkMetaEnv() {
  const required = ['JWT_SECRET', 'FRONTEND_URL', 'FB_APP_ID', 'FB_APP_SECRET', 'FB_REDIRECT_URI'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`⚠️ [Meta Routes] Missing env vars: ${missing.join(', ')} — OAuth flow WILL fail without these.`);
  } else {
    console.log('✅ [Meta Routes] Required env vars present.');
  }
})();

router.get('/oauth/url', protect, (req, res) => {
  try {
    const platform = req.query.platform === 'mobile' ? 'mobile' : 'web';
    const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const url = getFacebookOAuthUrl(state);
    console.log(`▶️ [Meta OAuth URL] user=${req.user._id} platform=${platform}`);
    console.log(`ℹ️ [Meta OAuth URL] Generated URL: ${url}`);
    res.json({ success: true, url });
  } catch (err) {
    console.error(`❌ [Meta OAuth URL] Failed to generate URL:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/oauth/callback', async (req, res) => {
  let platform = 'web';
  try {
    const { code, state, error, error_reason, error_description } = req.query;

    // Facebook itself can redirect back with an error (e.g. user cancelled, permissions denied)
    if (error) {
      console.error(`❌ [Meta OAuth Callback] Facebook returned an error: error=${error} reason=${error_reason} description=${error_description}`);
      throw new Error(error_description || error_reason || error);
    }

    if (!code) {
      console.error(`❌ [Meta OAuth Callback] No "code" param in callback query:`, req.query);
      throw new Error('Missing authorization code from Facebook');
    }

    if (!state) {
      console.error(`❌ [Meta OAuth Callback] No "state" param in callback query`);
      throw new Error('Missing state param');
    }

    let decoded;
    try {
      decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch (jwtErr) {
      console.error(`❌ [Meta OAuth Callback] state JWT verify failed:`, jwtErr.message);
      throw new Error(`Invalid or expired state token: ${jwtErr.message}`);
    }

    platform = decoded.platform || 'web';
    console.log(`▶️ [Meta OAuth Callback] Starting for user ${decoded.id}, platform=${platform}`);

    const user = await User.findById(decoded.id);
    if (!user) {
      console.error(`❌ [Meta OAuth Callback] No user found for id ${decoded.id}`);
      throw new Error('User not found');
    }

    // Step 1: short-lived token
    let shortLivedToken;
    try {
      shortLivedToken = await exchangeCodeForToken(code);
      console.log(`✅ [Meta OAuth Callback] Got short-lived token (len=${shortLivedToken ? shortLivedToken.length : 0})`);
    } catch (stepErr) {
      console.error(`❌ [Meta OAuth Callback] exchangeCodeForToken failed:`, stepErr.response?.data || stepErr.message);
      throw new Error(`Token exchange failed: ${stepErr.response?.data?.error?.message || stepErr.message}`);
    }

    // Step 2: long-lived token
    let longLivedToken;
    try {
      longLivedToken = await getLongLivedUserToken(shortLivedToken);
      console.log(`✅ [Meta OAuth Callback] Got long-lived token (len=${longLivedToken ? longLivedToken.length : 0})`);
    } catch (stepErr) {
      console.error(`❌ [Meta OAuth Callback] getLongLivedUserToken failed:`, stepErr.response?.data || stepErr.message);
      throw new Error(`Long-lived token exchange failed: ${stepErr.response?.data?.error?.message || stepErr.message}`);
    }

    // Step 3: pages
    let pages;
    try {
      pages = await getUserPages(longLivedToken);
      console.log(`✅ [Meta OAuth Callback] getUserPages returned ${pages ? pages.length : 0} page(s):`, (pages || []).map(p => ({ id: p.id, name: p.name })));
    } catch (stepErr) {
      console.error(`❌ [Meta OAuth Callback] getUserPages failed:`, stepErr.response?.data || stepErr.message);
      throw new Error(`Fetching Pages failed: ${stepErr.response?.data?.error?.message || stepErr.message}`);
    }

    if (!pages.length) {
      console.error(`❌ [Meta OAuth Callback] User ${user._id} has 0 Facebook Pages on this account`);
      throw new Error('No Facebook Pages found on this account. You need a Facebook Page to publish Reels.');
    }

    if (pages.length === 1) {
      console.log(`ℹ️ [Meta OAuth Callback] Exactly 1 page found, auto-connecting: ${pages[0].name} (${pages[0].id})`);
      await connectPageToUser(user, pages[0]);
    } else {
      console.log(`ℹ️ [Meta OAuth Callback] ${pages.length} pages found, awaiting user selection`);
      user.set('metaPendingPages', pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token })));
      await user.save();
    }

    console.log(`✅ [Meta OAuth Callback] Done. connectedFacebook=${!!user.connectedFacebook}`);

    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?meta_connected=1&multiple_pages=${pages.length > 1 ? '1' : '0'}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=1`);
    }
  } catch (err) {
    console.error(`❌ [Meta OAuth Callback] Failed:`, err.message);
    console.error(err.stack);
    if (platform === 'mobile') {
      res.redirect(`tubepilot://oauth-success?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    } else {
      res.redirect(`${PRIMARY_FRONTEND_URL}/dashboard.html?meta_connected=0&error=${encodeURIComponent(err.message)}`);
    }
  }
});

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
    console.log(`✅ [connectPageToUser] Saved connectedFacebook for user ${user._id}: page=${page.name} (${page.id})`);
  } catch (err) {
    console.error(`❌ [connectPageToUser] Failed to save user:`, err.message);
    throw err;
  }
};

router.get('/pages', protect, async (req, res) => {
  try {
    const pending = req.user.get('metaPendingPages') || [];
    console.log(`ℹ️ [Meta Pages] user=${req.user._id} pendingCount=${pending.length}`);
    res.json({ success: true, pages: pending.map((p) => ({ id: p.id, name: p.name })) });
  } catch (err) {
    console.error(`❌ [Meta Pages] Failed:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/select-page', protect, async (req, res) => {
  try {
    const pending = req.user.get('metaPendingPages') || [];
    console.log(`▶️ [Meta Select Page] user=${req.user._id} requestedPageId=${req.body.pageId} pendingCount=${pending.length}`);
    const chosen = pending.find((p) => p.id === req.body.pageId);
    if (!chosen) {
      console.error(`❌ [Meta Select Page] pageId ${req.body.pageId} not found in pending list:`, pending.map(p => p.id));
      return res.status(400).json({ success: false, message: 'Page not found in your pending list' });
    }

    await connectPageToUser(req.user, chosen);
    res.json({
      success: true,
      facebook: { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName }
    });
  } catch (err) {
    console.error(`❌ [Meta Select Page] Failed:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/facebook/disconnect', protect, async (req, res) => {
  try {
    console.log(`ℹ️ [Meta Disconnect] user=${req.user._id}`);
    req.user.connectedFacebook = null;
    await req.user.save();
    res.json({ success: true, message: 'Facebook disconnected' });
  } catch (err) {
    console.error(`❌ [Meta Disconnect] Failed:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/status', protect, async (req, res) => {
  try {
    res.json({
      success: true,
      facebook: req.user.connectedFacebook
        ? { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName, connectedAt: req.user.connectedFacebook.connectedAt }
        : null
    });
  } catch (err) {
    console.error(`❌ [Meta Status] Failed:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
