const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { protect } = require('../middleware/auth');
const User = require('../models/User');

// Directly import other utils if needed, or handle safely
let metaUtils = {};
try {
  metaUtils = require('../utils/meta');
} catch (e) {
  console.warn('⚠️ [Meta Routes] utils/meta.js import warning:', e.message);
}

const router = express.Router();
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

/**
 * Self-contained Facebook OAuth URL Generator
 */
const generateFacebookOAuthUrl = (state) => {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  
  const scopes = [
    'public_profile',
    'email',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'instagram_basic',
    'instagram_content_publish'
  ].join(',');

  return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=${encodeURIComponent(scopes)}&state=${state}&response_type=code`;
};

// OAuth URL Generator Handler
const handleGetOAuthUrl = async (req, res) => {
  try {
    const platform = req.query.platform === 'web' ? 'web' : 'mobile';
    const state = jwt.sign({ id: req.user._id, platform }, process.env.JWT_SECRET, { expiresIn: '15m' });
    
    // Safely use local generator or utility function
    const url = typeof metaUtils.getFacebookOAuthUrl === 'function' 
      ? metaUtils.getFacebookOAuthUrl(state) 
      : generateFacebookOAuthUrl(state);

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

// OAuth Callback Handler
const handleOAuthCallback = async (req, res) => {
  let platform = 'mobile';
  try {
    const { code, state, error, error_description } = req.query;

    if (error) throw new Error(error_description || error);
    if (!code || !state) throw new Error('Missing code or state parameter from Facebook');

    const decoded = jwt.verify(state, process.env.JWT_SECRET);
    platform = decoded.platform || 'mobile';

    const user = await User.findById(decoded.id);
    if (!user) throw new Error('User not found');

    if (typeof metaUtils.exchangeCodeForToken !== 'function') {
      throw new Error('Meta utility functions missing in utils/meta.js');
    }

    const shortLivedToken = await metaUtils.exchangeCodeForToken(code);
    const longLivedToken = await metaUtils.getLongLivedUserToken(shortLivedToken);
    const pages = await metaUtils.getUserPages(longLivedToken);

    if (!pages || !pages.length) {
      throw new Error('No Facebook Pages found on this account.');
    }

    if (pages.length === 1) {
      user.connectedFacebook = {
        pageId: pages[0].id,
        pageName: pages[0].name,
        pageAccessToken: pages[0].access_token,
        connectedAt: new Date()
      };
      user.set('metaPendingPages', undefined);
      await user.save();
    } else {
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

// Disconnect Handler
const handleDisconnect = async (req, res) => {
  try {
    req.user.connectedFacebook = null;
    req.user.set('metaPendingPages', undefined);
    await req.user.save();
    return res.json({ success: true, message: 'Facebook disconnected successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Route Definitions & Endpoints
router.get('/oauth/url', protect, handleGetOAuthUrl);
router.get('/facebook/url', protect, handleGetOAuthUrl);
router.get('/facebook-auth-url', protect, handleGetOAuthUrl);
router.get('/oauth-url', protect, handleGetOAuthUrl);
router.get('/auth-url', protect, handleGetOAuthUrl);
router.get('/connect', protect, handleGetOAuthUrl);

router.get('/oauth/callback', handleOAuthCallback);
router.get('/facebook/callback', handleOAuthCallback);
router.get('/callback', handleOAuthCallback);

router.delete('/facebook/disconnect', protect, handleDisconnect);
router.delete('/disconnect', protect, handleDisconnect);

router.get('/status', protect, async (req, res) => {
  res.json({
    success: true,
    facebook: req.user.connectedFacebook
      ? { pageId: req.user.connectedFacebook.pageId, pageName: req.user.connectedFacebook.pageName, connectedAt: req.user.connectedFacebook.connectedAt }
      : null
  });
});

module.exports = router;
