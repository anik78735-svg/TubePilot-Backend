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
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights'
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
      throw new Error('Access token missing in Meta response');
    }

    return response.data.access_token;
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - exchangeCodeForToken]:', errorMsg);
    throw new Error(`Meta Code Exchange Failed: ${errorMsg}`);
  }
};

/**
 * Step 2: Convert Short-Lived Token to Long-Lived Token
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
      throw new Error('Long-lived token missing in Meta response');
    }

    return response.data.access_token;
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - getLongLivedUserToken]:', errorMsg);
    throw new Error(`Meta Long-Lived Token Exchange Failed: ${errorMsg}`);
  }
};

/**
 * Step 3: Fetch User Pages & Instagram Accounts
 */
const getUserPages = async (userAccessToken) => {
  try {
    const response = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        fields: 'id,name,access_token,category,tasks,instagram_business_account{id,username,name,profile_picture_url}',
        access_token: userAccessToken
      },
      timeout: 10000
    });

    const pages = response.data?.data || [];
    return pages.map(page => ({
      id: page.id,
      name: page.name,
      access_token: page.access_token,
      instagram: page.instagram_business_account ? {
        id: page.instagram_business_account.id,
        username: page.instagram_business_account.username,
        name: page.instagram_business_account.name,
        profilePicture: page.instagram_business_account.profile_picture_url
      } : null
    }));
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - getUserPages]:', errorMsg);
    throw new Error(`Failed to fetch Pages & Instagram accounts: ${errorMsg}`);
  }
};

/**
 * PUBLISH FEATURE 1: Facebook Reel Publishing (Resumable Upload via URL)
 */
const publishFacebookReel = async ({ pageId, pageAccessToken, videoUrl, caption, title }) => {
  try {
    // 1. Initialize Reel Upload Session
    const initRes = await axios.post(
      `https://graph.facebook.com/v18.0/${pageId}/video_reels`,
      {
        upload_phase: 'start',
        access_token: pageAccessToken
      },
      { timeout: 10000 }
    );

    const videoId = initRes.data.video_id;
    if (!videoId) throw new Error('Failed to initialize Facebook Reel session');

    // 2. Upload Video Binary / Link via URL Transfer
    await axios.post(
      `https://rupload.facebook.com/video-upload/v18.0/${videoId}`,
      {},
      {
        headers: {
          Authorization: `OAuth ${pageAccessToken}`,
          file_url: videoUrl
        },
        timeout: 300000 // 5 min timeout for video download
      }
    );

    // 3. Publish Reel
    const publishRes = await axios.post(
      `https://graph.facebook.com/v18.0/${pageId}/video_reels`,
      {
        upload_phase: 'finish',
        video_id: videoId,
        video_state: 'PUBLISHED',
        description: caption || title || '',
        title: title || '',
        access_token: pageAccessToken
      },
      { timeout: 15000 }
    );

    return {
      success: true,
      postId: publishRes.data.id || videoId,
      videoId: videoId
    };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - publishFacebookReel Error]:', errorMsg);
    throw new Error(`Facebook Reel Publishing Failed: ${errorMsg}`);
  }
};

/**
 * PUBLISH FEATURE 2: Standard Facebook Video Publishing
 */
const publishFacebookVideo = async ({ pageId, pageAccessToken, videoUrl, caption, title }) => {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${pageId}/videos`,
      {
        file_url: videoUrl,
        description: caption || title || '',
        title: title || '',
        access_token: pageAccessToken
      },
      { timeout: 180000 }
    );

    return {
      success: true,
      postId: response.data.id,
      videoId: response.data.id
    };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - publishFacebookVideo Error]:', errorMsg);
    throw new Error(`Facebook Video Publishing Failed: ${errorMsg}`);
  }
};

/**
 * PUBLISH FEATURE 3: Instagram Reel Publishing
 */
const publishInstagramReel = async ({ instagramId, pageAccessToken, videoUrl, caption }) => {
  try {
    // 1. Create Media Container
    const containerRes = await axios.post(
      `https://graph.facebook.com/v18.0/${instagramId}/media`,
      {
        media_type: 'REELS',
        video_url: videoUrl,
        caption: caption || '',
        access_token: pageAccessToken
      },
      { timeout: 30000 }
    );

    const containerId = containerRes.data.id;
    if (!containerId) throw new Error('Failed to create Instagram media container');

    // 2. Poll for Status till READY
    let status = 'IN_PROGRESS';
    let attempts = 0;
    while (status !== 'FINISHED' && attempts < 20) {
      await new Promise((r) => setTimeout(r, 5000)); // wait 5 seconds
      const checkRes = await axios.get(`https://graph.facebook.com/v18.0/${containerId}`, {
        params: { fields: 'status_code', access_token: pageAccessToken }
      });
      status = checkRes.data.status_code;
      if (status === 'ERROR') throw new Error('Instagram video processing failed');
      attempts++;
    }

    if (status !== 'FINISHED') throw new Error('Instagram reel processing timed out');

    // 3. Publish Container
    const publishRes = await axios.post(
      `https://graph.facebook.com/v18.0/${instagramId}/media_publish`,
      {
        creation_id: containerId,
        access_token: pageAccessToken
      },
      { timeout: 15000 }
    );

    return {
      success: true,
      postId: publishRes.data.id
    };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error('❌ [utils/meta - publishInstagramReel Error]:', errorMsg);
    throw new Error(`Instagram Reel Publishing Failed: ${errorMsg}`);
  }
};

/**
 * Revoke Permissions
 */
const revokeFacebookAccess = async (pageId, pageAccessToken) => {
  try {
    await axios.delete(`https://graph.facebook.com/v18.0/${pageId}/permissions`, {
      params: { access_token: pageAccessToken },
      timeout: 8000
    });
    return { revoked: true };
  } catch (err) {
    return { revoked: false, reason: err.message };
  }
};

// EXPORT ALL FUNCTIONS INCLUDING PUBLISHING FUNCTIONS
module.exports = {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  publishFacebookReel,
  publishFacebookVideo,
  publishInstagramReel,
  revokeFacebookAccess
};
