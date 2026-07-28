const cron = require('node-cron');
const axios = require('axios');
const Video = require('../models/Video');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushToUser } = require('../utils/push');
const { sendOneSignalToUser } = require('../utils/oneSignalPush');
const { refreshAccessToken, uploadVideoToYouTube, setThumbnail, updateVideoPrivacy } = require('../utils/youtube');
const { getDriveFileStream, deleteDriveFile, listUserDriveVideoFiles, downloadUserDriveFileBuffer } = require('../utils/googleDrive');
const { deleteFromCloudinary, account1, account2 } = require('../utils/cloudinary');
const { chargeForUpload, storeVideoFile } = require('../routes/video');

const STORAGE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

const getVideoStream = async (video) => {
  if (video.storageProvider === 'google_drive') {
    return getDriveFileStream(video.storageFileId);
  }
  const response = await axios.get(video.storageUrl, { responseType: 'stream' });
  return response.data;
};

const deleteStoredVideoFile = async (video) => {
  try {
    if (video.storageProvider === 'cloudinary_1') {
      await deleteFromCloudinary(account1, video.storageFileId);
    } else if (video.storageProvider === 'cloudinary_2') {
      await deleteFromCloudinary(account2, video.storageFileId);
    } else if (video.storageProvider === 'google_drive') {
      await deleteDriveFile(video.storageFileId);
    } else {
      return;
    }
    video.storageUrl = '';
    video.storageDeleteAt = null;
  } catch (err) {
    console.error(`Failed to delete stored file for video ${video._id}:`, err.message);
  }
};

const ensureFreshAccessToken = async (user) => {
  const channel = user.youtubeChannel;
  const isExpired = !channel.tokenExpiryDate || Date.now() > channel.tokenExpiryDate - 60000;
  if (!isExpired) return channel.accessToken;

  const credentials = await refreshAccessToken(channel.refreshToken);
  user.youtubeChannel.accessToken = credentials.access_token;
  user.youtubeChannel.tokenExpiryDate = credentials.expiry_date;
  await user.save();
  return credentials.access_token;
};

const processVideo = async (video) => {
  const user = await User.findById(video.user);
  if (!user || !user.youtubeChannel) {
    video.status = 'failed';
    video.failReason = 'No YouTube channel connected';
    await video.save();
    return;
  }

  try {
    video.status = 'processing';
    await video.save();

    const accessToken = await ensureFreshAccessToken(user);
    const fileStream = await getVideoStream(video);

    const result = await uploadVideoToYouTube({
      accessToken,
      refreshToken: user.youtubeChannel.refreshToken,
      fileStream,
      title: video.title,
      description: video.description,
      tags: video.tags,
      categoryId: video.category,
      privacyStatus: video.privacyStatus || 'public',
      madeForKids: video.audience === 'made_for_kids'
    });

    video.status = 'uploaded';
    video.youtubeVideoId = result.id;
    video.youtubeUrl = `https://youtube.com/watch?v=${result.id}`;
    video.storageDeleteAt = new Date(Date.now() + STORAGE_RETENTION_MS);

    await video.save();

    const privacyLabel = video.privacyStatus === 'public' ? 'public' : video.privacyStatus;
    const willGoPublicLater = video.targetPrivacyStatus === 'public' && video.privacyStatus !== 'public';
    await Notification.create({
      user: user._id,
      type: 'upload_completed',
      title: 'Upload Completed ✅',
      message: willGoPublicLater
        ? `"${video.title}" is uploaded (unlisted) and will go public at the scheduled time.`
        : `"${video.title}" is now live on YouTube (${privacyLabel}).`
    });
    await sendPushToUser(user, {
      title: 'Your video is live! 🎉',
      body: willGoPublicLater
        ? `"${video.title}" is uploaded and scheduled to go public soon.`
        : `"${video.title}" just went ${privacyLabel} on YouTube.`,
      data: { type: 'upload_completed', videoId: video._id.toString(), youtubeUrl: video.youtubeUrl }
    });
  } catch (err) {
    console.error(`Upload failed for video ${video._id}:`, err.message);
    video.status = 'failed';
    video.failReason = err.message;
    await video.save();

    await Notification.create({
      user: user._id,
      type: 'upload_failed',
      title: 'Upload Failed ❌',
      message: `"${video.title}" failed to upload: ${err.message}`
    });
    await sendPushToUser(user, {
      title: 'Upload failed ❌',
      body: `"${video.title}" couldn't be uploaded. Tap to see why.`,
      data: { type: 'upload_failed', videoId: video._id.toString() }
    });
  }
};

const startScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const dueVideos = await Video.find({ status: 'queued' }).limit(10);
      for (const video of dueVideos) {
        await processVideo(video);
      }
    } catch (err) {
      console.error('Scheduler tick error:', err.message);
    }
  });
  console.log('⏰ Upload scheduler is running (checks every minute)');
};

const processPrivacyPublish = async (video) => {
  const user = await User.findById(video.user);
  if (!user || !user.youtubeChannel) {
    console.error(`Privacy publish skipped for video ${video._id}: no YouTube channel connected`);
    return;
  }

  try {
    const accessToken = await ensureFreshAccessToken(user);
    await updateVideoPrivacy({
      accessToken,
      refreshToken: user.youtubeChannel.refreshToken,
      videoId: video.youtubeVideoId,
      privacyStatus: 'public'
    });

    video.privacyStatus = 'public';
    await video.save();

    await Notification.create({
      user: user._id,
      type: 'upload_completed',
      title: 'Video Is Now Public 🌐',
      message: `"${video.title}" just went public on YouTube as scheduled.`
    });
    await sendPushToUser(user, {
      title: 'Your video is now public! 🎉',
      body: `"${video.title}" just went public on YouTube.`,
      data: { type: 'upload_completed', videoId: video._id.toString(), youtubeUrl: video.youtubeUrl }
    });
  } catch (err) {
    console.error(`Privacy publish failed for video ${video._id}:`, err.message);
  }
};

const startPrivacyPublishScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const dueVideos = await Video.find({
        status: 'uploaded',
        targetPrivacyStatus: 'public',
        privacyStatus: { $ne: 'public' },
        scheduledAt: { $lte: now }
      }).limit(10);

      for (const video of dueVideos) {
        await processPrivacyPublish(video);
      }
    } catch (err) {
      console.error('Privacy publish scheduler tick error:', err.message);
    }
  });
  console.log('🌐 Privacy publish scheduler is running (checks every minute)');
};

const startStorageCleanupScheduler = () => {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const now = new Date();
      const dueVideos = await Video.find({
        status: 'uploaded',
        storageUrl: { $ne: '' },
        storageDeleteAt: { $lte: now }
      }).limit(25);

      for (const video of dueVideos) {
        await deleteStoredVideoFile(video);
        await video.save();
      }
    } catch (err) {
      console.error('Storage cleanup scheduler tick error:', err.message);
    }
  });
  console.log('🗑️  Storage cleanup scheduler is running (every 15 minutes, 24h retention)');
};

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

// ---------------- NEW: Google Drive daily auto-upload ----------------
// For one user: picks the OLDEST not-yet-processed video file from their
// connected Drive, charges a free-upload/diamond credit exactly like a
// manual upload does, copies it into our own storage (Cloudinary/system
// Drive) via the existing storeVideoFile(), and creates a 'queued' Video
// document — which the existing startScheduler() cron above then uploads to
// YouTube automatically, with zero changes to that pipeline.
const runDriveAutoUploadForUser = async (user, todayStr) => {
  try {
    if (!user.youtubeChannel) {
      // Nothing we can do today without a connected YouTube channel — mark
      // today as attempted so we don't retry every minute, and try again tomorrow.
      user.connectedDrive.lastAutoUploadDate = todayStr;
      await user.save();
      return;
    }

    const files = await listUserDriveVideoFiles(user);
    const processedIds = user.connectedDrive.driveProcessedFileIds || [];
    const nextFile = files.find((f) => !processedIds.includes(f.id));

    // Mark today as attempted regardless of outcome below, so this user's
    // scheduled time only fires once per day.
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
      title: nextFile.name || 'Untitled',
      description: '',
      tags: [],
      category: '22',
      audience: 'not_for_kids',
      privacyStatus: 'public',
      targetPrivacyStatus: 'public',
      storageProvider: stored.storageProvider,
      storageFileId: stored.storageFileId,
      storageUrl: stored.storageUrl,
      fileSizeBytes: Number(nextFile.size) || buffer.length,
      status: 'queued',
      diamondsCharged: charge.diamondsCharged,
      usedFreeUpload: charge.usedFreeUpload,
      sourceProvider: 'drive_auto',
      sourceDriveFileId: nextFile.id
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
  startScheduler,
  startFreeUploadReset,
  startPrivacyPublishScheduler,
  startStorageCleanupScheduler,
  startDriveAutoUploadScheduler
};
