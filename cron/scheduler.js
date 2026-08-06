const cron = require('node-cron');
const axios = require('axios');
const Video = require('../models/Video');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { sendOneSignalToUser } = require('../utils/oneSignalPush');
const { refreshAccessToken, uploadVideoToYouTube } = require('../utils/youtube');
const { getDriveFileStream, deleteDriveFile, listUserDriveVideoFiles, downloadUserDriveFileBuffer } = require('../utils/googleDrive');
const { publishFacebookReel, publishInstagramReel } = require('../utils/meta');
const { deleteFromCloudinary, account1, account2 } = require('../utils/cloudinary');
const { chargeForUpload, storeVideoFile } = require('../routes/video');

const MAX_RETRIES = 3;

// ---------------- Shared storage helpers ----------------

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
  const credentials = await refreshAccessToken(channel.refreshToken);
  user.youtubeChannel.accessToken = credentials.access_token;
  user.youtubeChannel.tokenExpiryDate = credentials.expiry_date;
  await user.save();
  return credentials.access_token;
};

// ---------------- Per-platform publish ----------------

const publishToYouTube = async (video, target, user) => {
  const accessToken = await ensureFreshYouTubeToken(user);
  const fileStream = await getVideoFileStream(video);
  const result = await uploadVideoToYouTube({
    accessToken,
    refreshToken: user.youtubeChannel.refreshToken,
    fileStream,
    title: target.title,
    description: target.description,
    tags: target.tags,
    categoryId: target.category,
    privacyStatus: target.privacyStatus || 'public',
    madeForKids: target.audience === 'made_for_kids'
  });
  return { platformPostId: result.id, platformUrl: `https://youtube.com/watch?v=${result.id}` };
};

const publishToInstagram = async (video, target, user) => {
  if (!user.connectedInstagram || !user.connectedFacebook) {
    throw new Error('Instagram is not connected');
  }
  const caption = [target.caption, ...(target.hashtags || []).map((h) => `#${h.replace(/^#/, '')}`)].filter(Boolean).join('\n\n');
  return publishInstagramReel({
    igUserId: user.connectedInstagram.igUserId,
    pageAccessToken: user.connectedFacebook.pageAccessToken,
    videoUrl: video.storageUrl,
    caption
  });
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

const PUBLISHERS = { youtube: publishToYouTube, instagram: publishToInstagram, facebook: publishToFacebook };

const PLATFORM_LABELS = { youtube: 'YouTube', instagram: 'Instagram Reels', facebook: 'Facebook Reels' };

// Processes every 'queued' platform target on one Video document. Each
// target is independent: one platform failing never blocks or re-triggers
// the others (e.g. YouTube succeeds, Instagram fails -> only Instagram is
// retried later; Facebook, if also queued, is attempted regardless of what
// happened to the other two in this same pass).
const processVideoTargets = async (video) => {
  const user = await User.findById(video.user);
  if (!user) return;

  const targets = video.platforms.filter((t) => t.status === 'queued');
  for (const target of targets) {
    target.status = 'processing';
    await video.save();

    try {
      const publisher = PUBLISHERS[target.platform];
      const result = await publisher(video, target, user);
      target.status = 'uploaded';
      target.platformPostId = result.platformPostId;
      target.platformUrl = result.platformUrl;
      target.failReason = '';

      await Notification.create({
        user: user._id,
        type: 'upload_completed',
        title: `${PLATFORM_LABELS[target.platform]} Upload Completed ✅`,
        message: `Your video is now live on ${PLATFORM_LABELS[target.platform]}.`
      });
      await sendPushToUser(user, {
        title: `Live on ${PLATFORM_LABELS[target.platform]}! 🎉`,
        body: 'Your video just went live.',
        data: { type: 'upload_completed', videoId: video._id.toString(), platform: target.platform, platformUrl: target.platformUrl }
      });
    } catch (err) {
      console.error(`${target.platform} publish failed for video ${video._id}:`, err.message);
      target.failReason = err.message;
      target.retryCount += 1;
      target.status = target.retryCount >= MAX_RETRIES ? 'failed' : 'failed'; // stays 'failed'; retry job re-queues it if under the limit

      await Notification.create({
        user: user._id,
        type: 'upload_failed',
        title: `${PLATFORM_LABELS[target.platform]} Upload Failed ❌`,
        message: target.retryCount >= MAX_RETRIES
          ? `Your video could not be published to ${PLATFORM_LABELS[target.platform]} after ${MAX_RETRIES} attempts: ${err.message}`
          : `${PLATFORM_LABELS[target.platform]} upload failed, retrying automatically: ${err.message}`
      });
      await sendPushToUser(user, {
        title: `${PLATFORM_LABELS[target.platform]} upload failed ❌`,
        body: target.retryCount >= MAX_RETRIES ? 'Retries exhausted. Tap to see why.' : 'Retrying automatically...',
        data: { type: 'upload_failed', videoId: video._id.toString(), platform: target.platform }
      });
    }

    await video.save();
  }

  video.recomputeStatus();
  await video.save();

  // Once every target has reached a terminal state (uploaded, or failed with
  // retries exhausted), the shared temp file is no longer needed by anyone —
  // delete it immediately rather than waiting on a 24h retention window.
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
      const now = new Date();

      // Promote any 'pending' targets whose scheduled time has arrived into 'queued'.
      await Video.updateMany(
        { 'platforms.status': 'pending', 'platforms.scheduledAt': { $lte: now } },
        { $set: { 'platforms.$[elem].status': 'queued' } },
        { arrayFilters: [{ 'elem.status': 'pending', 'elem.scheduledAt': { $lte: now } }] }
      );

      const dueVideos = await Video.find({ 'platforms.status': 'queued' }).limit(10);
      for (const video of dueVideos) {
        await processVideoTargets(video);
      }
    } catch (err) {
      console.error('Publish scheduler tick error:', err.message);
    }
  });
  console.log('⏰ Multi-platform publish scheduler is running (checks every minute)');
};

// Retries failed targets under the retry limit, with a short backoff so we
// don't hammer a platform that's temporarily down. Runs every 15 minutes.
const startRetryScheduler = () => {
  cron.schedule('*/15 * * * *', async () => {
    try {
      await Video.updateMany(
        { 'platforms.status': 'failed', 'platforms.retryCount': { $lt: MAX_RETRIES } },
        { $set: { 'platforms.$[elem].status': 'queued' } },
        { arrayFilters: [{ 'elem.status': 'failed', 'elem.retryCount': { $lt: MAX_RETRIES } }] }
      );
      console.log('🔁 Retry scheduler promoted eligible failed targets back to queued');
    } catch (err) {
      console.error('Retry scheduler tick error:', err.message);
    }
  });
  console.log('🔁 Retry scheduler is running (every 15 minutes)');
};

// ---------------- Free upload monthly reset (unchanged) ----------------
const startFreeUploadReset = () => {
  cron.schedule('0 0 * * *', async () => {
    try {
      const now = new Date();
      const dueUsers = await User.find({ freeUploadsResetAt: { $lte: now } });
      const freeLimit = Number(process.env.FREE_UPLOADS_PER_MONTH || 20);
      for (const user of dueUsers) {
        user.freeUploadsRemaining = freeLimit;
        user.freeUploadsResetAt = new Date(new Date().setMonth(new Date().getMonth() + 1));
        await user.save();
        await Notification.create({
          user: user._id,
          type: 'free_upload_reset',
          title: 'Free Uploads Reset 🎁',
          message: `Your ${freeLimit} free uploads for this month have been refreshed.`
        });
      }
    } catch (err) {
      console.error('Free upload reset error:', err.message);
    }
  });
  console.log('📅 Monthly free-upload reset job is running');
};

// ---------------- Google Drive daily auto-upload (adapted to platforms[]) ----------------
const runDriveAutoUploadForUser = async (user, todayStr) => {
  try {
    if (!user.youtubeChannel) {
      user.connectedDrive.lastAutoUploadDate = todayStr;
      await user.save();
      return;
    }

    const files = await listUserDriveVideoFiles(user);
    const processedIds = user.connectedDrive.driveProcessedFileIds || [];
    const nextFile = files.find((f) => !processedIds.includes(f.id));

    user.connectedDrive.lastAutoUploadDate = todayStr;

    if (!nextFile) {
      await user.save();
      return;
    }

    let charge;
    try {
      charge = chargeForUpload(user);
    } catch (err) {
      await user.save();
      if (err.code === 'INSUFFICIENT_DIAMONDS') {
        sendOneSignalToUser(user, {
          title: 'Your credits are over 💎',
          body: 'Your free uploads and diamonds are used up. Please buy diamonds to continue Drive auto-upload.',
          data: { type: 'insufficient_diamonds' }
        }).catch(() => {});
      }
      return;
    }

    const buffer = await downloadUserDriveFileBuffer(user, nextFile.id);
    const stored = await storeVideoFile(buffer, `${user.userId}_drive_${Date.now()}`, nextFile.mimeType || 'video/mp4');

    await Video.create({
      user: user._id,
      storageProvider: stored.storageProvider,
      storageFileId: stored.storageFileId,
      storageUrl: stored.storageUrl,
      fileSizeBytes: Number(nextFile.size) || buffer.length,
      status: 'queued',
      diamondsCharged: charge.diamondsCharged,
      usedFreeUpload: charge.usedFreeUpload,
      sourceProvider: 'drive_auto',
      sourceDriveFileId: nextFile.id,
      platforms: [{
        platform: 'youtube',
        status: 'queued',
        title: nextFile.name || 'Untitled',
        privacyStatus: 'public',
        targetPrivacyStatus: 'public'
      }]
    });

    user.storageUsedBytes += buffer.length;
    user.connectedDrive.driveProcessedFileIds = [...processedIds, nextFile.id];
    await user.save();
  } catch (err) {
    console.error(`Drive auto-upload failed for user ${user._id}:`, err.message);
  }
};

const startDriveAutoUploadScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const todayStr = now.toISOString().slice(0, 10);
      const dueUsers = await User.find({
        'connectedDrive.dailyUploadTime': hhmm,
        'connectedDrive.lastAutoUploadDate': { $ne: todayStr }
      });
      for (const user of dueUsers) {
        await runDriveAutoUploadForUser(user, todayStr);
      }
    } catch (err) {
      console.error('Drive auto-upload scheduler tick error:', err.message);
    }
  });
  console.log('📁 Drive auto-upload scheduler is running (checks every minute)');
};

module.exports = {
  startPublishScheduler,
  startRetryScheduler,
  startFreeUploadReset,
  startDriveAutoUploadScheduler
};
