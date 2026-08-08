const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;

const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts'
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
    // temp file from being deleted too early. Real-world processing for
    // longer/larger Reels regularly runs past 3 minutes while Facebook
    // keeps reporting video_status=uploading, so we poll for up to ~8
    // minutes total, checking less frequently once the wait gets long
    // (fewer Graph API calls without slowing down the common fast case).
    const maxWaitMs = 8 * 60 * 1000; // 8 minutes
    const startedAt = Date.now();
    let attempt = 0;
    while (Date.now() - startedAt < maxWaitMs) {
      attempt += 1;
      const status = await getFacebookVideoStatus(videoId, pageAccessToken);
      const videoStatus = status?.video_status;
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(`ℹ️ [Meta:publishFacebookReel] Poll ${attempt} (${elapsedSec}s elapsed): video_status=${videoStatus}`);

      if (videoStatus === 'ready') {
        console.log(`✅ [Meta:publishFacebookReel] Video fully processed and ready after ${elapsedSec}s`);
        return { platformPostId: videoId, platformUrl: `https://www.facebook.com/reel/${videoId}` };
      }
      if (videoStatus === 'error') {
        throw new Error(`Facebook failed to process the video: ${JSON.stringify(status)}`);
      }
      // Poll every 5s for the first 3 minutes, then back off to every 15s.
      const interval = elapsedSec < 180 ? 5000 : 15000;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('Facebook video processing timed out (still not ready after 8 minutes)');
  } catch (err) {
    logMetaError('publishFacebookReel', err);
    throw err;
  }
};

module.exports = {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  publishFacebookReel
};
