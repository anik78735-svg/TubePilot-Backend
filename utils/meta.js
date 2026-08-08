const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;

const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish'
].join(',');

const logMetaError = (label, err) => {
  const graphError = err.response?.data?.error;
  if (graphError) {
    console.error(`❌ [Meta:${label}] Graph API error:`, JSON.stringify(graphError, null, 2));
  } else {
    console.error(`❌ [Meta:${label}] Non-Graph error:`, err.message);
  }
};

const getFacebookOAuthUrl = (state) => {
  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: META_REDIRECT_URI,
    state,
    scope: META_SCOPES,
    response_type: 'code'
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
};

const exchangeCodeForToken = async (code) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: { client_id: META_APP_ID, redirect_uri: META_REDIRECT_URI, client_secret: META_APP_SECRET, code }
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
      params: { access_token: userAccessToken, fields: 'id,name,access_token' }
    });
    const pages = res.data.data || [];
    console.log(`✅ [Meta:getUserPages] Found ${pages.length} page(s):`, pages.map((p) => p.name).join(', ') || '(none)');
    return pages;
  } catch (err) {
    logMetaError('getUserPages', err);
    throw err;
  }
};

const getInstagramBusinessAccount = async (pageId, pageAccessToken) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/${pageId}`, {
      params: { fields: 'instagram_business_account{id,username}', access_token: pageAccessToken }
    });
    const ig = res.data.instagram_business_account || null;
    console.log(`ℹ️ [Meta:getInstagramBusinessAccount] Page ${pageId} ->`, ig ? `linked to @${ig.username}` : 'NO linked Instagram account');
    return ig;
  } catch (err) {
    logMetaError('getInstagramBusinessAccount', err);
    return null;
  }
};

// Polls a Facebook video's processing status after the "finish" upload
// phase. The finish call returns success as soon as Facebook has ACCEPTED
// the video_url, NOT once it has finished downloading/processing it from
// that URL — Facebook fetches the video in the background. If we delete our
// temporary storage copy before that fetch completes, the Reel ends up
// broken ("This page isn't available"). This poll makes sure Facebook has
// actually finished downloading and processing before we report success.
const getFacebookVideoStatus = async (videoId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${videoId}`, {
    params: { fields: 'status', access_token: pageAccessToken }
  });
  return res.data.status; // { video_status: 'ready'|'processing'|'error', ... }
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

    // Wait for Facebook to actually finish fetching + processing the video
    // from our URL before reporting success — this is what protects the
    // temp file from being deleted too early.
    const maxAttempts = 36; // 36 * 5s = 3 minutes
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await getFacebookVideoStatus(videoId, pageAccessToken);
      const videoStatus = status?.video_status;
      console.log(`ℹ️ [Meta:publishFacebookReel] Poll ${attempt + 1}/${maxAttempts}: video_status=${videoStatus}`);

      if (videoStatus === 'ready') {
        console.log(`✅ [Meta:publishFacebookReel] Video fully processed and ready`);
        return { platformPostId: videoId, platformUrl: `https://www.facebook.com/reel/${videoId}` };
      }
      if (videoStatus === 'error') {
        throw new Error(`Facebook failed to process the video: ${JSON.stringify(status)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error('Facebook video processing timed out (still not ready after 3 minutes)');
  } catch (err) {
    logMetaError('publishFacebookReel', err);
    throw err;
  }
};

const createInstagramContainer = async ({ igUserId, pageAccessToken, videoUrl, caption }) => {
  try {
    const res = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, {
      params: { media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: pageAccessToken }
    });
    console.log(`✅ [Meta:createInstagramContainer] Container created: ${res.data.id}`);
    return res.data.id;
  } catch (err) {
    logMetaError('createInstagramContainer', err);
    throw err;
  }
};

const getInstagramContainerStatus = async (containerId, pageAccessToken) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/${containerId}`, {
      params: { fields: 'status_code', access_token: pageAccessToken }
    });
    return res.data.status_code;
  } catch (err) {
    logMetaError('getInstagramContainerStatus', err);
    throw err;
  }
};

const publishInstagramContainer = async (igUserId, containerId, pageAccessToken) => {
  try {
    const res = await axios.post(`${GRAPH_BASE}/${igUserId}/media_publish`, null, {
      params: { creation_id: containerId, access_token: pageAccessToken }
    });
    console.log(`✅ [Meta:publishInstagramContainer] Published: ${res.data.id}`);
    return res.data.id;
  } catch (err) {
    logMetaError('publishInstagramContainer', err);
    throw err;
  }
};

const publishInstagramReel = async ({ igUserId, pageAccessToken, videoUrl, caption }) => {
  console.log(`▶️ [Meta:publishInstagramReel] Starting for igUserId ${igUserId}, video: ${videoUrl}`);
  const containerId = await createInstagramContainer({ igUserId, pageAccessToken, videoUrl, caption });

  const maxAttempts = 24;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getInstagramContainerStatus(containerId, pageAccessToken);
    console.log(`ℹ️ [Meta:publishInstagramReel] Poll ${attempt + 1}/${maxAttempts}: status=${status}`);
    if (status === 'FINISHED') {
      const mediaId = await publishInstagramContainer(igUserId, containerId, pageAccessToken);
      return { platformPostId: mediaId, platformUrl: `https://www.instagram.com/reel/${mediaId}` };
    }
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Instagram failed to process the video (status: ${status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('Instagram video processing timed out');
};

module.exports = {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  getInstagramBusinessAccount,
  publishFacebookReel,
  publishInstagramReel
};
