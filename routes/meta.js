const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

/**
 * Helper to generate Facebook OAuth Dialog URL
 */
const getFacebookOAuthUrl = (req) => {
  const appId = process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/meta/facebook/callback`;
  const scopes = [
    'public_profile',
    'email',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'instagram_basic',
    'instagram_content_publish'
  ].join(',');

  const state = req.user ? req.user._id.toString() : '';

  return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=${encodeURIComponent(scopes)}&state=${state}&response_type=code`;
};

/**
 * @route GET /api/meta/facebook/url
 * @route GET /api/meta/facebook-auth-url
 * @desc Get Facebook OAuth authorization URL for mobile/frontend
 */
const handleGetFacebookOAuthUrl = async (req, res) => {
  try {
    if (!process.env.FACEBOOK_APP_ID) {
      return res.status(500).json({
        success: false,
        message: 'Facebook App ID is not configured on backend env.'
      });
    }

    const authUrl = getFacebookOAuthUrl(req);

    return res.json({
      success: true,
      url: authUrl,
      authUrl: authUrl
    });
  } catch (err) {
    console.error('❌ [Facebook OAuth URL Error]:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate Facebook authorization URL.'
    });
  }
};

/**
 * @route GET /api/meta/facebook/callback
 * @desc Handles Meta/Facebook OAuth callback & Exchanges Code for Access Token
 */
const handleFacebookCallback = async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error('❌ [Facebook Callback Error]:', error_description);
      return res.status(400).send(`Authentication Failed: ${error_description}`);
    }

    if (!code) {
      return res.status(400).send('Authorization code missing.');
    }

    const redirectUri = process.env.META_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/meta/facebook/callback`;

    // 1. Exchange code for access token
    const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        redirect_uri: redirectUri,
        code
      }
    });

    const { access_token } = tokenResponse.data;

    // 2. Fetch User Profile
    const profileResponse = await axios.get('https://graph.facebook.com/me', {
      params: {
        fields: 'id,name,email',
        access_token
      }
    });

    const metaUser = profileResponse.data;

    // Save token if state (userId) was passed
    if (state) {
      await User.findByIdAndUpdate(state, {
        facebookConnected: true,
        facebookAccessToken: access_token,
        facebookId: metaUser.id
      });
    }

    return res.send(`
      <html>
        <head><title>Meta Connected</title></head>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#121212;color:#fff;">
          <div style="text-align:center;">
            <h2>🎉 Facebook Account Connected Successfully!</h2>
            <p>You can close this window and return to TubePilot app.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ [Meta Callback Processing Error]:', err.response?.data || err.message);
    return res.status(500).send('Failed to process Facebook connection.');
  }
};

// -----------------------------------------------------------------------
// Routes Mapping with Aliases (Prevents Undefined Handler / Route Crash)
// -----------------------------------------------------------------------

router.get('/facebook/url', protect, handleGetFacebookOAuthUrl);
router.get('/facebook-auth-url', protect, handleGetFacebookOAuthUrl);
router.get('/facebook/connect', protect, handleGetFacebookOAuthUrl);
router.get('/connect/facebook', protect, handleGetFacebookOAuthUrl);

router.get('/facebook/callback', handleFacebookCallback);

// Exporting both module.exports and explicit function helper
module.exports = router;
module.exports.getFacebookOAuthUrl = getFacebookOAuthUrl;
