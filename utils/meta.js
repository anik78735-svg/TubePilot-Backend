const axios = require('axios');

/**
 * Facebook OAuth URL Generator
 */
const getFacebookOAuthUrl = (state) => {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.tubepilot.shop'}/api/meta/oauth/callback`;
  
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

/**
 * Step 1: Exchange Code for Short-Lived Access Token
 */
const exchangeCodeForToken = async (code) => {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.tubepilot.shop'}/api/meta/oauth/callback`;

  try {
    const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code
      },
      timeout: 10000
    });

    if (!response.data || !response.data.access_token) {
      throw new Error('Access token not present in Meta response');
    }

    return response.data.access_token;
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - exchangeCodeForToken]:', errorMsg);
    throw new Error(`Facebook Code Exchange Failed: ${errorMsg}`);
  }
};

/**
 * Step 2: Convert Short-Lived Token to Long-Lived Token (60 Days)
 */
const getLongLivedUserToken = async (shortLivedToken) => {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;

  try {
    const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken
      },
      timeout: 10000
    });

    if (!response.data || !response.data.access_token) {
      throw new Error('Long-lived token not present in Meta response');
    }

    return response.data.access_token;
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - getLongLivedUserToken]:', errorMsg);
    throw new Error(`Facebook Long-Lived Token Exchange Failed: ${errorMsg}`);
  }
};

/**
 * Step 3: Fetch User's Facebook Pages
 */
const getUserPages = async (userAccessToken) => {
  try {
    const response = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        fields: 'id,name,access_token,category,tasks',
        access_token: userAccessToken
      },
      timeout: 10000
    });

    return response.data?.data || [];
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - getUserPages]:', errorMsg);
    throw new Error(`Failed to fetch Facebook Pages: ${errorMsg}`);
  }
};

/**
 * Revoke App Permissions on Facebook's Side
 */
const revokeFacebookAccess = async (pageId, pageAccessToken) => {
  try {
    await axios.delete(`https://graph.facebook.com/v18.0/${pageId}/permissions`, {
      params: { access_token: pageAccessToken },
      timeout: 8000
    });
    return { revoked: true };
  } catch (err) {
    console.warn('⚠️ [utils/meta - revokeFacebookAccess] Revoke failed:', err.response?.data?.error?.message || err.message);
    return { revoked: false, reason: err.message };
  }
};

module.exports = {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  revokeFacebookAccess
};
