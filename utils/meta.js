const axios = require('axios');

/**
 * Facebook OAuth URL Generator
 */
const getFacebookOAuthUrl = (state) => {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.BACKEND_URL}/api/meta/oauth/callback`;
  
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
 * Step 1: Authorization Code ko Short-Lived Access Token me exchange karein
 */
const exchangeCodeForToken = async (code) => {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.BACKEND_URL}/api/meta/oauth/callback`;

  const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
    params: {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code
    }
  });

  return response.data.access_token;
};

/**
 * Step 2: Short-Lived Token ko Long-Lived Token (60 days) me convert karein
 */
const getLongLivedUserToken = async (shortLivedToken) => {
  const appId = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;

  const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken
    }
  });

  return response.data.access_token;
};

/**
 * Step 3: User ke Facebook Pages fetch karein
 */
const getUserPages = async (userAccessToken) => {
  const response = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
    params: {
      fields: 'id,name,access_token,category,tasks',
      access_token: userAccessToken
    }
  });

  return response.data.data || [];
};

/**
 * Facebook Access Revoke Handler
 */
const revokeFacebookAccess = async (pageId, pageAccessToken) => {
  try {
    await axios.delete(`https://graph.facebook.com/v18.0/${pageId}/permissions`, {
      params: { access_token: pageAccessToken }
    });
    return { revoked: true };
  } catch (err) {
    return { revoked: false, reason: err.message };
  }
};

// EXPORT ALL FUNCTIONS PROPERLY
module.exports = {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  revokeFacebookAccess
};
