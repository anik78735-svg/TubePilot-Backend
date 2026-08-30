const cron = require('node-cron');
const axios = require('axios');
const Video = require('../models/Video');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { sendOneSignalToUser } = require('../utils/oneSignalPush');
const { refreshAccessToken, uploadVideoToYouTube, updateVideoPrivacy, isInvalidGrantError } = require('../utils/youtube');
const { getDriveFileStream, deleteDriveFile, listUserDriveVideoFiles, downloadUserDriveFileBuffer } = require('../utils/googleDrive');
const { publishFacebookReel } = require('../utils/meta');
const { deleteFromCloudinary, account1, account2 } = require('../utils/cloudinary');
const { chargeForUpload, storeVideoFile } = require('../routes/video');

const MAX_RETRIES = 3;

const getVideoFileStream = async (video) => {
  if (video.storageProvider === 'google_drive') return getDriveFileStream(video.storageFileId);
  const response = await axios.get(video.storageUrl, { responseType: 'stream' });
  return response.data;
};

const deleteStoredVideoFile = async (video) => {
  try {
    if (video.storageProvider === 'cloudinary_1') await deleteFromCloudinary(account1, video.storageFileId);
    else if (video.storageProvider === 'cloudinary_2') await deleteFromCloudinary(account2, video.storageFileId);
    else if (video.storageProvider === 'google_drive') await deleteDriveFile(video.storageFileId);
    video.storageUrl = '';
    video.storageDeleteAt = null;
  } catch (err) {
    console.error(`Failed to delete stored file for video ${video._id}:`, err.message);
  }
};

const ensureFreshYouTubeToken = async (user) => {
  const channel = user.youtubeChannel;
  const isExpired = !channel.tokenExpiryDate || Date.now() > channel.tokenExpiryDate - 60000;
  if (!isExpired) return channel.accessToken;

  try {
    const credentials = await refreshAccessToken(channel.refreshToken);
    user.youtubeChannel.accessToken = credentials.access_token;
    user.youtubeChannel.tokenExpiryDate = credentials.expiry_date;
    await user.save();
    return credentials.access_token;
  } catch (err) {
    if (isInvalidGrantError(err)) {
      const reauthErr = new Error('Your YouTube authorization has expired or was revoked. Please reconnect your YouTube account.');
      reauthErr.code = 'YOUTUBE_REAUTH_REQUIRED';
      throw reauthErr;
    }
    throw err;
  }
};

const publishToYouTube = async (video, target, user) => {
  const accessToken = await ensureFreshYouTubeToken(user);
  const hasFutureSchedule = target.scheduledAt && new Date(target.scheduledAt) > new Date();
  const uploadPrivacy = hasFutureSchedule ? 'unlisted' : (target.privacyStatus || 'public');

  const fileStream = await getVideoFileStream(video);

  const result = await uploadVideoToYouTube({
    accessToken,
    refreshToken: user.youtubeChannel.refreshToken,
    fileStream,
    title: target.title,
    description: target.description,
    tags: target.tags,
    categoryId: target.category,
    privacyStatus: uploadPrivacy,
    madeForKids: target.audience === 'made_for_kids'
  });

  target.targetPrivacyStatus = target.targetPrivacyStatus || target.privacyStatus || 'public';
  target.privacyStatus = uploadPrivacy;
  target.youtubePrivacyPromoted = !hasFutureSchedule;

  return { platformPostId: result.id, platformUrl: `https://youtube.com/watch?v=${result.id}` };
};

const publishToFacebook = async (video, target, user) => {
  if (!user.connectedFacebook) throw new Error('Facebook is not connected');
  const caption = [target.caption, ...(target.hashtags || []).map((h) => `#${h.replace(/^#/, '')}`)].filter(Boolean).join('\n\n');
  return publishFacebookReel({
    pageId: user.connectedFacebook.pageId,
    pageAccessToken: user.connectedFacebook.pageAccessToken,
    videoUrl: video.storageUrl,
    caption
  });
};

const PUBLISHERS = { youtube: publishToYouTube, facebook: publishToFacebook };
const PLATFORM_LABELS = { youtube: 'YouTube', facebook: 'Facebook Reels', instagram: 'Instagram Reels/Carousel' };

const processVideoTargets = async (video) => {
  const user = await User.findById(video.user);
  if (!user) return;

  const targets = video.platforms.filter((t) => t.status === 'queued');

  for (const target of targets) {
    target.status = 'processing';
    await video.save();

    try {
      const publisher = PUBLISHERS[target.platform];
      if (!publisher) {
        throw new Error(`Publisher for ${target.platform} is not configured.`);
      }
      const result = await publisher(video, target, user);
      target.status = 'uploaded';
      target.platformPostId = result.platformPostId;
      target.platformUrl = result.platformUrl;
      target.failReason = '';

      await Notification.create({
        user: user._id,
        type: 'upload_completed',
        title: `${PLATFORM_LABELS[target.platform]} Upload Completed ✅`,
        message: `Your content is now live on ${PLATFORM_LABELS[target.platform]}.`
      });
    } catch (err) {
      target.failReason = err.message;
      target.status = 'failed';
      target.retryCount += 1;
    }

    await video.save();
  }

  video.recomputeStatus();
  await video.save();

  const stillNeedsFile = video.platforms.some((t) =>
    t.status === 'pending' || t.status === 'queued' || t.status === 'processing' ||
    (t.status === 'failed' && t.retryCount < MAX_RETRIES)
  );
  if (!stillNeedsFile && video.storageUrl) {
    await deleteStoredVideoFile(video);
    await video.save();
  }
};

const startPublishScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const dueVideos = await Video.find({ 'platforms.status': 'queued' }).limit(10);
      for (const video of dueVideos) {
        await processVideoTargets(video);
      }
    } catch (err) {
      console.error('❌ Scheduler error:', err.message);
    }
  });
};

const startFreeUploadReset = () => {
  cron.schedule('0 0 * * *', async () => {
    try {
      const now = new Date();
      const dueUsers = await User.find({ freeUploadsResetAt: { $lte: now } });
      const freeLimit = Number(process.env.FREE_UPLOADS_PER_MONTH || 20);
      for (const user of dueUsers) {
        user.freeUploadsRemaining = freeLimit; // Reset to 20 Free Credits
        user.freeUploadsResetAt = new Date(new Date().setMonth(new Date().getMonth() + 1));
        await user.save();
      }
    } catch (err) {
      console.error('Free upload reset error:', err.message);
    }
  });
};

module.exports = {
  startPublishScheduler,
  startFreeUploadReset
};
