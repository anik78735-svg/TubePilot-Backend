const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

/**
 * Helper function to generate Facebook OAuth URL
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
 * Common Controller Handler for Facebook Auth URL
 */
const handleGetFacebookOAuthUrl = async (req, res) => {
  try {
    if (!process.env.FACEBOOK_APP_ID) {
      return res.status(500).json({
        success: false,
        message: 'Facebook App ID is missing in environment variables.'
      });
    }

    const authUrl = getFacebookOAuthUrl(req);

    return res.json({
      success: true,
      url: authUrl,
      authUrl: authUrl,
      oauthUrl: authUrl
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
 * Facebook OAuth Callback Handler
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

    // 1. Exchange authorization code for access token
    const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        redirect_uri: redirectUri,
        code
      }
    });

    const { access_token } = tokenResponse.data;

    // 2. Get Meta User Info
    const profileResponse = await axios.get('https://graph.facebook.com/me', {
      params: {
        fields: 'id,name,email',
        access_token
      }
    });

    const metaUser = profileResponse.data;

    if (state) {
      await User.findByIdAndUpdate(state, {
        facebookConnected: true,
        facebookAccessToken: access_token,
        facebookId: metaUser.id
      });
    }

    return res.send(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#121212;color:#fff;">
          <div style="text-align:center;">
            <h2>🎉 Facebook Connected Successfully!</h2>
            <p>You can close this tab and return to TubePilot app.</p>
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
// Route Mappings (Covers ALL possibilities to prevent Route Not Found)
// -----------------------------------------------------------------------

// GET Auth URL Endpoints (Supports /url, /facebook-auth-url, /connect, /oauth-url, etc.)
router.get('/facebook/url', protect, handleGetFacebookOAuthUrl);
router.get('/facebook-auth-url', protect, handleGetFacebookOAuthUrl);
router.get('/facebook/connect', protect, handleGetFacebookOAuthUrl);
router.get('/connect/facebook', protect, handleGetFacebookOAuthUrl);
router.get('/facebook/oauth-url', protect, handleGetFacebookOAuthUrl);
router.get('/oauth-url', protect, handleGetFacebookOAuthUrl);
router.get('/auth-url', protect, handleGetFacebookOAuthUrl);
router.get('/connect', protect, handleGetFacebookOAuthUrl);

// OAuth Callback Endpoints
router.get('/facebook/callback', handleFacebookCallback);
router.get('/callback', handleFacebookCallback);

// Default fallback for GET /api/meta or /api/facebook
router.get('/', protect, handleGetFacebookOAuthUrl);

// Export module properly
module.exports = router;
module.exports.getFacebookOAuthUrl = getFacebookOAuthUrl;
