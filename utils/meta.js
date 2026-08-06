const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;

// Scopes needed: list the user's Pages, read/manage posts on them, and
// publish content to a linked Instagram Business account.
const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish'
].join(',');

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

// Step 1: exchange the OAuth code for a short-lived user access token.
const exchangeCodeForToken = async (code) => {
  const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      client_id: META_APP_ID,
      redirect_uri: META_REDIRECT_URI,
      client_secret: META_APP_SECRET,
      code
    }
  });
  return res.data.access_token; // short-lived (~1-2 hours)
};

// Step 2: exchange the short-lived token for a long-lived one (~60 days).
// Page access tokens derived from a long-lived user token effectively don't
// expire under normal use.
const getLongLivedUserToken = async (shortLivedToken) => {
  const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: shortLivedToken
    }
  });
  return res.data.access_token;
};

// Step 3: list every Facebook Page the user manages, each with its own
// (effectively non-expiring) Page access token.
const getUserPages = async (userAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/me/accounts`, {
    params: { access_token: userAccessToken, fields: 'id,name,access_token' }
  });
  return res.data.data || []; // [{ id, name, access_token }, ...]
};

// Step 4: check if a Page has a linked Instagram Business/Creator account.
const getInstagramBusinessAccount = async (pageId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${pageId}`, {
    params: { fields: 'instagram_business_account{id,username}', access_token: pageAccessToken }
  });
  return res.data.instagram_business_account || null; // { id, username } or null
};

// Publishes a Facebook Reel. Uses the resumable "video_reels" endpoint:
// start the upload session, point it at the video's public URL, then finish
// (publish) it. videoUrl must be a public HTTPS URL (our Cloudinary
// secure_url works for this).
const publishFacebookReel = async ({ pageId, pageAccessToken, videoUrl, caption }) => {
  const startRes = await axios.post(`${GRAPH_BASE}/${pageId}/video_reels`, null, {
    params: { upload_phase: 'start', access_token: pageAccessToken }
  });
  const videoId = startRes.data.video_id;

  await axios.post(`${GRAPH_BASE}/${videoId}`, null, {
    params: {
      upload_phase: 'finish',
      video_url: videoUrl,
      description: caption || '',
      video_state: 'PUBLISHED',
      access_token: pageAccessToken
    }
  });

  return { platformPostId: videoId, platformUrl: `https://www.facebook.com/reel/${videoId}` };
};

// Publishes an Instagram Reel via the Content Publishing API: create a
// media container from the video URL, poll until Instagram finishes
// processing it, then publish the container.
const createInstagramContainer = async ({ igUserId, pageAccessToken, videoUrl, caption }) => {
  const res = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, {
    params: {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption || '',
      access_token: pageAccessToken
    }
  });
  return res.data.id; // container id
};

const getInstagramContainerStatus = async (containerId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${containerId}`, {
    params: { fields: 'status_code', access_token: pageAccessToken }
  });
  return res.data.status_code; // IN_PROGRESS | FINISHED | ERROR | EXPIRED
};

const publishInstagramContainer = async (igUserId, containerId, pageAccessToken) => {
  const res = await axios.post(`${GRAPH_BASE}/${igUserId}/media_publish`, null, {
    params: { creation_id: containerId, access_token: pageAccessToken }
  });
  return res.data.id; // published media id
};

// Full Instagram Reel publish flow: create container, poll up to ~2 minutes
// for Instagram to finish processing the video, then publish it.
const publishInstagramReel = async ({ igUserId, pageAccessToken, videoUrl, caption }) => {
  const containerId = await createInstagramContainer({ igUserId, pageAccessToken, videoUrl, caption });

  const maxAttempts = 24; // 24 * 5s = 2 minutes
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getInstagramContainerStatus(containerId, pageAccessToken);
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
};const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;

// Scopes needed: list the user's Pages, read/manage posts on them, and
// publish content to a linked Instagram Business account.
const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish'
].join(',');

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

// Step 1: exchange the OAuth code for a short-lived user access token.
const exchangeCodeForToken = async (code) => {
  const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      client_id: META_APP_ID,
      redirect_uri: META_REDIRECT_URI,
      client_secret: META_APP_SECRET,
      code
    }
  });
  return res.data.access_token; // short-lived (~1-2 hours)
};

// Step 2: exchange the short-lived token for a long-lived one (~60 days).
// Page access tokens derived from a long-lived user token effectively don't
// expire under normal use.
const getLongLivedUserToken = async (shortLivedToken) => {
  const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: shortLivedToken
    }
  });
  return res.data.access_token;
};

// Step 3: list every Facebook Page the user manages, each with its own
// (effectively non-expiring) Page access token.
const getUserPages = async (userAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/me/accounts`, {
    params: { access_token: userAccessToken, fields: 'id,name,access_token' }
  });
  return res.data.data || []; // [{ id, name, access_token }, ...]
};

// Step 4: check if a Page has a linked Instagram Business/Creator account.
const getInstagramBusinessAccount = async (pageId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${pageId}`, {
    params: { fields: 'instagram_business_account{id,username}', access_token: pageAccessToken }
  });
  return res.data.instagram_business_account || null; // { id, username } or null
};

// Publishes a Facebook Reel. Uses the resumable "video_reels" endpoint:
// start the upload session, point it at the video's public URL, then finish
// (publish) it. videoUrl must be a public HTTPS URL (our Cloudinary
// secure_url works for this).
const publishFacebookReel = async ({ pageId, pageAccessToken, videoUrl, caption }) => {
  const startRes = await axios.post(`${GRAPH_BASE}/${pageId}/video_reels`, null, {
    params: { upload_phase: 'start', access_token: pageAccessToken }
  });
  const videoId = startRes.data.video_id;

  await axios.post(`${GRAPH_BASE}/${videoId}`, null, {
    params: {
      upload_phase: 'finish',
      video_url: videoUrl,
      description: caption || '',
      video_state: 'PUBLISHED',
      access_token: pageAccessToken
    }
  });

  return { platformPostId: videoId, platformUrl: `https://www.facebook.com/reel/${videoId}` };
};

// Publishes an Instagram Reel via the Content Publishing API: create a
// media container from the video URL, poll until Instagram finishes
// processing it, then publish the container.
const createInstagramContainer = async ({ igUserId, pageAccessToken, videoUrl, caption }) => {
  const res = await axios.post(`${GRAPH_BASE}/${igUserId}/media`, null, {
    params: {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption || '',
      access_token: pageAccessToken
    }
  });
  return res.data.id; // container id
};

const getInstagramContainerStatus = async (containerId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${containerId}`, {
    params: { fields: 'status_code', access_token: pageAccessToken }
  });
  return res.data.status_code; // IN_PROGRESS | FINISHED | ERROR | EXPIRED
};

const publishInstagramContainer = async (igUserId, containerId, pageAccessToken) => {
  const res = await axios.post(`${GRAPH_BASE}/${igUserId}/media_publish`, null, {
    params: { creation_id: containerId, access_token: pageAccessToken }
  });
  return res.data.id; // published media id
};

// Full Instagram Reel publish flow: create container, poll up to ~2 minutes
// for Instagram to finish processing the video, then publish it.
const publishInstagramReel = async ({ igUserId, pageAccessToken, videoUrl, caption }) => {
  const containerId = await createInstagramContainer({ igUserId, pageAccessToken, videoUrl, caption });

  const maxAttempts = 24; // 24 * 5s = 2 minutes
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getInstagramContainerStatus(containerId, pageAccessToken);
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
