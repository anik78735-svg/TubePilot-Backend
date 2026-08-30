const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;

// Scopes required for Facebook Pages & linked Instagram Business/Creator accounts
const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'publish_video',
  'instagram_basic',
  'instagram_content_publish'
].join(',');

// Helper delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logMetaError = (label, err) => {
  const graphError = err.response?.data?.error;
  if (graphError) {
    console.error(`❌ [Meta:${label}] Graph API error:`, JSON.stringify(graphError, null, 2));
  } else if (err.response?.data) {
    console.error(`❌ [Meta:${label}] HTTP ${err.response.status || ''}:`, JSON.stringify(err.response.data, null, 2));
  } else {
    console.error(`❌ [Meta:${label}] Non-Graph error:`, err.message);
  }
};

// -----------------------------------------------------------------------
// Authentication & Account Management
// -----------------------------------------------------------------------

const getFacebookOAuthUrl = (state) => {
  const params = new URLSearchParams({
    client_id: META_APP_ID || '',
    redirect_uri: META_REDIRECT_URI || '',
    state: state || '',
    scope: META_SCOPES,
    response_type: 'code'
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
};

const exchangeCodeForToken = async (code) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: { 
        client_id: META_APP_ID, 
        redirect_uri: META_REDIRECT_URI, 
        client_secret: META_APP_SECRET, 
        code 
      }
    });
    console.log('✅ [Meta:exchangeCodeForToken] Got short-lived token');
    return res.data.access_token;
  } catch (err) {
    logMetaError('exchangeCodeForToken', err);
    throw err;
  }
};

const getLongLivedUserToken = async (shortLivedToken) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: shortLivedToken
      }
    });
    console.log('✅ [Meta:getLongLivedUserToken] Got long-lived token');
    return res.data.access_token;
  } catch (err) {
    logMetaError('getLongLivedUserToken', err);
    throw err;
  }
};

const getUserPages = async (userAccessToken) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/me/accounts`, {
      params: { access_token: userAccessToken, fields: 'id,name,access_token,instagram_business_account' }
    });
    const pages = res.data.data || [];
    console.log(`✅ [Meta:getUserPages] Found ${pages.length} page(s):`, pages.map((p) => p.name).join(', ') || '(none)');
    return pages;
  } catch (err) {
    logMetaError('getUserPages', err);
    throw err;
  }
};

/**
 * Fetch the Instagram Business / Creator Account ID linked to a Facebook Page
 */
const getInstagramAccountId = async (pageId, pageAccessToken) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/${pageId}`, {
      params: {
        fields: 'instagram_business_account',
        access_token: pageAccessToken
      }
    });

    const igAccountId = res.data?.instagram_business_account?.id;
    if (!igAccountId) {
      throw new Error(`No Instagram Business Account linked to Facebook Page ID ${pageId}`);
    }

    console.log(`✅ [Meta:getInstagramAccountId] Found IG Account ID: ${igAccountId}`);
    return igAccountId;
  } catch (err) {
    logMetaError('getInstagramAccountId', err);
    throw err;
  }
};

const revokeFacebookAccess = async (pageId, pageAccessToken) => {
  if (!pageId || !pageAccessToken) {
    console.warn('⚠️ [Meta:revokeFacebookAccess] Missing pageId or pageAccessToken, skipping revoke call');
    return { revoked: false, reason: 'missing pageId or pageAccessToken' };
  }
  try {
    const res = await axios.delete(`${GRAPH_BASE}/${pageId}/permissions`, {
      params: { access_token: pageAccessToken }
    });
    console.log(`✅ [Meta:revokeFacebookAccess] Revoked permissions for page ${pageId}:`, JSON.stringify(res.data));
    return { revoked: true };
  } catch (err) {
    logMetaError('revokeFacebookAccess', err);
    return { revoked: false, reason: err.response?.data?.error?.message || err.message };
  }
};

// -----------------------------------------------------------------------
// Facebook Reels Publishing
// -----------------------------------------------------------------------

const getFacebookVideoStatus = async (videoId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${videoId}`, {
    params: { fields: 'status', access_token: pageAccessToken }
  });
  return res.data.status;
};

const publishFacebookReel = async ({ pageId, pageAccessToken, videoUrl, caption }) => {
  try {
    console.log(`▶️ [Meta:publishFacebookReel] Starting for page ${pageId}, video: ${videoUrl}`);
    const startRes = await axios.post(`${GRAPH_BASE}/${pageId}/video_reels`, null, {
      params: { upload_phase: 'start', access_token: pageAccessToken }
    });
    const videoId = startRes.data.video_id;
    console.log(`ℹ️ [Meta:publishFacebookReel] Upload session started, video_id=${videoId}`);

    const finishRes = await axios.post(`${GRAPH_BASE}/${videoId}`, null, {
      params: {
        upload_phase: 'finish',
        video_url: videoUrl,
        description: caption || '',
        video_state: 'PUBLISHED',
        access_token: pageAccessToken
      }
    });
    console.log(`ℹ️ [Meta:publishFacebookReel] Finish accepted:`, JSON.stringify(finishRes.data));

    const maxWaitMs = 8 * 60 * 1000; // 8 minutes
    const startedAt = Date.now();
    let attempt = 0;

    while (Date.now() - startedAt < maxWaitMs) {
      attempt += 1;
      let status;

      try {
        status = await getFacebookVideoStatus(videoId, pageAccessToken);
      } catch (pollErr) {
        console.warn(`⚠️ [Meta:publishFacebookReel] Poll ${attempt} failed, retrying...`, pollErr.message);
      }

      const videoStatus = status?.video_status;
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(`ℹ️ [Meta:publishFacebookReel] Poll ${attempt} (${elapsedSec}s elapsed): video_status=${videoStatus || 'unknown'}`);

      if (videoStatus === 'ready') {
        console.log(`✅ [Meta:publishFacebookReel] Video fully processed after ${elapsedSec}s`);
        return { platformPostId: videoId, platformUrl: `https://www.facebook.com/reel/${videoId}` };
      }
      if (videoStatus === 'error') {
        throw new Error(`Facebook failed to process the video: ${JSON.stringify(status)}`);
      }

      const interval = elapsedSec < 180 ? 5000 : 15000;
      await sleep(interval);
    }

    throw new Error('Facebook video processing timed out (still not ready after 8 minutes)');
  } catch (err) {
    logMetaError('publishFacebookReel', err);
    throw err;
  }
};

// -----------------------------------------------------------------------
// Instagram Publishing (Reels & Carousels)
// -----------------------------------------------------------------------

/**
 * Checks status of an Instagram Media Container during processing
 */
const getInstagramContainerStatus = async (creationId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${creationId}`, {
    params: {
      fields: 'status_code,status',
      access_token: pageAccessToken
    }
  });
  return res.data; // { status_code: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS', ... }
};

/**
 * Polls an Instagram container until status_code becomes 'FINISHED'
 */
const waitForInstagramContainer = async (creationId, pageAccessToken, maxWaitMs = 8 * 60 * 1000) => {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < maxWaitMs) {
    attempt += 1;
    let statusData;

    try {
      statusData = await getInstagramContainerStatus(creationId, pageAccessToken);
    } catch (pollErr) {
      console.warn(`⚠️ [Meta:waitForInstagramContainer] Poll ${attempt} failed for ${creationId}, retrying...`, pollErr.message);
    }

    const statusCode = statusData?.status_code;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.log(`ℹ️ [Meta:waitForInstagramContainer] Poll ${attempt} (${elapsedSec}s elapsed): status_code=${statusCode || 'unknown'}`);

    if (statusCode === 'FINISHED') {
      return true;
    }

    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new Error(`Instagram container ${creationId} failed processing with status: ${statusCode}`);
    }

    const interval = elapsedSec < 180 ? 5000 : 15000;
    await sleep(interval);
  }

  throw new Error(`Instagram container ${creationId} timed out after ${Math.round(maxWaitMs / 1000)}s`);
};

/**
 * Publishes a Reel to a connected Instagram Business/Creator Account
 */
const publishInstagramReel = async ({ igUserId, pageAccessToken, videoUrl, caption }) => {
  try {
    console.log(`▶️ [Meta:publishInstagramReel] Starting for IG user ${igUserId}, video: ${videoUrl}`);

    // STEP 1: Create Media Container for Reel
    const createRes = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, {
      params: {
        media_type: 'REELS',
        video_url: videoUrl,
        caption: caption || '',
        access_token: pageAccessToken
      }
    });

    const creationId = createRes.data.id;
    console.log(`ℹ️ [Meta:publishInstagramReel] Container created, creation_id=${creationId}`);

    // STEP 2: Wait for video container processing to complete
    await waitForInstagramContainer(creationId, pageAccessToken);

    // STEP 3: Publish Media Container
    console.log(`▶️ [Meta:publishInstagramReel] Publishing container ${creationId}...`);
    const publishRes = await axios.post(`${GRAPH_BASE}/${igUserId}/media_publish`, null, {
      params: {
        creation_id: creationId,
        access_token: pageAccessToken
      }
    });

    const mediaId = publishRes.data.id;
    console.log(`✅ [Meta:publishInstagramReel] Published successfully, media_id=${mediaId}`);

    let permalink = `https://www.instagram.com/reel/${mediaId}`;
    try {
      const permalinkRes = await axios.get(`${GRAPH_BASE}/${mediaId}`, {
        params: { fields: 'permalink', access_token: pageAccessToken }
      });
      if (permalinkRes.data?.permalink) {
        permalink = permalinkRes.data.permalink;
      }
    } catch (e) {
      // Non-critical error
    }

    return {
      platformPostId: mediaId,
      platformUrl: permalink
    };

  } catch (err) {
    logMetaError('publishInstagramReel', err);
    throw err;
  }
};

/**
 * Publishes a multi-item Carousel (Images/Videos) to Instagram
 * @param {Object} params
 * @param {string} params.igUserId - Instagram Business/Creator Account ID
 * @param {string} params.pageAccessToken - Page Access Token
 * @param {Array<{ url: string, isVideo?: boolean }>} params.mediaItems - Array of 2-10 items
 * @param {string} [params.caption] - Caption for the carousel post
 */
const publishInstagramCarousel = async ({ igUserId, pageAccessToken, mediaItems, caption }) => {
  try {
    if (!Array.isArray(mediaItems) || mediaItems.length < 2 || mediaItems.length > 10) {
      throw new Error('Instagram Carousel requires between 2 and 10 media items.');
    }

    console.log(`▶️ [Meta:publishInstagramCarousel] Starting for IG user ${igUserId} with ${mediaItems.length} items`);

    // STEP 1: Create child item containers for each media asset
    const childrenIds = [];

    for (let index = 0; index < mediaItems.length; index++) {
      const item = mediaItems[index];
      const isVideo = !!item.isVideo;

      console.log(`ℹ️ [Meta:publishInstagramCarousel] Processing item ${index + 1}/${mediaItems.length} (${isVideo ? 'VIDEO' : 'IMAGE'})`);

      const params = {
        is_carousel_item: true,
        access_token: pageAccessToken
      };

      if (isVideo) {
        params.media_type = 'VIDEO';
        params.video_url = item.url;
      } else {
        params.image_url = item.url;
      }

      const itemRes = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, { params });
      const itemId = itemRes.data.id;

      // Videos inside carousels need to finish processing before parent container creation
      if (isVideo) {
        console.log(`ℹ️ [Meta:publishInstagramCarousel] Waiting for video item ${itemId} to process...`);
        await waitForInstagramContainer(itemId, pageAccessToken);
      }

      childrenIds.push(itemId);
    }

    // STEP 2: Create Parent Carousel Container
    console.log(`▶️ [Meta:publishInstagramCarousel] Creating parent container with children: [${childrenIds.join(', ')}]`);
    const carouselRes = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, {
      params: {
        media_type: 'CAROUSEL',
        children: childrenIds.join(','),
        caption: caption || '',
        access_token: pageAccessToken
      }
    });

    const carouselContainerId = carouselRes.data.id;

    // STEP 3: Wait for parent container readiness
    await waitForInstagramContainer(carouselContainerId, pageAccessToken);

    // STEP 4: Publish Parent Carousel Container
    console.log(`▶️ [Meta:publishInstagramCarousel] Publishing parent carousel ${carouselContainerId}...`);
    const publishRes = await axios.post(`${GRAPH_BASE}/${igUserId}/media_publish`, null, {
      params: {
        creation_id: carouselContainerId,
        access_token: pageAccessToken
      }
    });

    const mediaId = publishRes.data.id;
    console.log(`✅ [Meta:publishInstagramCarousel] Carousel published successfully, media_id=${mediaId}`);

    let permalink = `https://www.instagram.com/p/${mediaId}`;
    try {
      const permalinkRes = await axios.get(`${GRAPH_BASE}/${mediaId}`, {
        params: { fields: 'permalink', access_token: pageAccessToken }
      });
      if (permalinkRes.data?.permalink) {
        permalink = permalinkRes.data.permalink;
      }
    } catch (e) {
      // Non-critical error
    }

    return {
      platformPostId: mediaId,
      platformUrl: permalink
    };

  } catch (err) {
    logMetaError('publishInstagramCarousel', err);
    throw err;
  }
};

module.exports = {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  getInstagramAccountId,
  revokeFacebookAccess,
  publishFacebookReel,
  publishInstagramReel,
  publishInstagramCarousel
};
