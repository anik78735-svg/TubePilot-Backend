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

// -----------------------------------------------------------------------
// YouTube upload flow:
//   - If the user picked a future scheduledAt for YouTube, we upload the
//     video RIGHT AWAY as 'unlisted' (so it's fully processed and ready on
//     YouTube's side), then a separate tick (promoteScheduledYouTubeVideos
//     below) flips it to the user's real target privacy (targetPrivacyStatus)
//     the moment scheduledAt arrives — no re-upload needed, just a fast
//     metadata patch.
//   - If there's no scheduledAt, we upload directly with the target privacy.
//
// This exact flow is what Drive auto-upload now relies on for Problem 2:
// runDriveAutoUploadForUser() (below) creates the Video with scheduledAt
// set to the user's chosen "Daily Upload Time" — so it uploads unlisted at
// 06:00 IST and this same promoteScheduledYouTubeVideos() tick promotes it
// to public later, with zero new upload logic needed.
// -----------------------------------------------------------------------
const publishToYouTube = async (video, target, user) => {
  const accessToken = await ensureFreshYouTubeToken(user);
  const fileStream = await getVideoFileStream(video);

  const hasFutureSchedule = target.scheduledAt && new Date(target.scheduledAt) > new Date();
  const uploadPrivacy = hasFutureSchedule ? 'unlisted' : (target.privacyStatus || 'public');

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
const PLATFORM_LABELS = { youtube: 'YouTube', facebook: 'Facebook Reels' };

const processVideoTargets = async (video) => {
  const user = await User.findById(video.user);
  if (!user) {
    console.error(`❌ [Scheduler] Video ${video._id} has no matching user (${video.user}) — skipping`);
    return;
  }

  const targets = video.platforms.filter((t) => t.status === 'queued');
  console.log(`▶️ [Scheduler] Video ${video._id}: processing ${targets.length} queued target(s) — ${targets.map((t) => t.platform).join(', ') || 'none'}`);

  for (const target of targets) {
    target.status = 'processing';
    await video.save();
    console.log(`ℹ️ [Scheduler] Video ${video._id} / ${target.platform}: status -> processing`);

    try {
      const publisher = PUBLISHERS[target.platform];
      const result = await publisher(video, target, user);
      target.status = 'uploaded';
      target.platformPostId = result.platformPostId;
      target.platformUrl = result.platformUrl;
      target.failReason = '';
      console.log(`✅ [Scheduler] Video ${video._id} / ${target.platform}: SUCCESS -> ${result.platformUrl}`);

      await Notification.create({
        user: user._id,
        type: 'upload_completed',
        title: `${PLATFORM_LABELS[target.platform]} Upload Completed ✅`,
        message: target.platform === 'youtube' && !target.youtubePrivacyPromoted
          ? `Your video is uploaded to ${PLATFORM_LABELS[target.platform]} as unlisted and will go public at your scheduled time.`
          : `Your video is now live on ${PLATFORM_LABELS[target.platform]}.`
      });
      await sendPushToUser(user, {
        title: `Live on ${PLATFORM_LABELS[target.platform]}! 🎉`,
        body: target.platform === 'youtube' && !target.youtubePrivacyPromoted
          ? 'Uploaded (unlisted) — will go public at your scheduled time.'
          : 'Your video just went live.',
        data: { type: 'upload_completed', videoId: video._id.toString(), platform: target.platform, platformUrl: target.platformUrl }
      });
    } catch (err) {
      console.error(`❌ [Scheduler] Video ${video._id} / ${target.platform}: FAILED — ${err.message}`);
      if (err.response?.data) {
        console.error(`❌ [Scheduler] Video ${video._id} / ${target.platform}: raw error detail:`, JSON.stringify(err.response.data));
      }
      target.failReason = err.message;
      target.status = 'failed';

      const needsYouTubeReauth = target.platform === 'youtube' && err.code === 'YOUTUBE_REAUTH_REQUIRED';

      if (needsYouTubeReauth) {
        target.retryCount = MAX_RETRIES;
        console.log(`ℹ️ [Scheduler] Video ${video._id} / youtube: refresh token invalid/revoked — retries stopped, reauth required`);

        await Notification.create({
          user: user._id,
          type: 'upload_failed',
          title: 'YouTube Reconnection Needed 🔑',
          message: 'Your YouTube authorization expired or was revoked. Please reconnect your YouTube account to keep publishing.'
        });
        await sendPushToUser(user, {
          title: 'Reconnect your YouTube account',
          body: 'Your YouTube authorization expired. Tap to reconnect and resume publishing.',
          data: { type: 'youtube_reauth_required', videoId: video._id.toString(), platform: target.platform }
        });
      } else {
        target.retryCount += 1;
        console.log(`ℹ️ [Scheduler] Video ${video._id} / ${target.platform}: retryCount now ${target.retryCount}/${MAX_RETRIES}`);

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

// -----------------------------------------------------------------------
// Promotes YouTube targets that were uploaded early as 'unlisted' to their
// real target privacy (usually 'public') the moment scheduledAt arrives.
// This does NOT re-upload the video — it's a fast videos.update() patch.
//
// For Drive auto-upload (Problem 2), this IS the "second cron job that
// goes public at the user's set time" — no separate cron needed, this
// already runs every minute as part of startPublishScheduler and reacts
// to whatever scheduledAt was stamped on the target when it was created.
// -----------------------------------------------------------------------
const promoteScheduledYouTubeVideos = async () => {
  const now = new Date();
  const dueVideos = await Video.find({
    'platforms.platform': 'youtube',
    'platforms.status': 'uploaded',
    'platforms.youtubePrivacyPromoted': false,
    'platforms.scheduledAt': { $lte: now }
  }).limit(20);

  for (const video of dueVideos) {
    const target = video.platforms.find(
      (t) => t.platform === 'youtube' && t.status === 'uploaded' && !t.youtubePrivacyPromoted && t.scheduledAt && t.scheduledAt <= now
    );
    if (!target) continue;

    try {
      const user = await User.findById(video.user);
      if (!user || !user.youtubeChannel) continue;

      const accessToken = await ensureFreshYouTubeToken(user);
      await updateVideoPrivacy({
        accessToken,
        refreshToken: user.youtubeChannel.refreshToken,
        videoId: target.platformPostId,
        privacyStatus: target.targetPrivacyStatus || 'public'
      });

      target.privacyStatus = target.targetPrivacyStatus || 'public';
      target.youtubePrivacyPromoted = true;
      await video.save();

      console.log(`✅ [Scheduler] Video ${video._id} / youtube: promoted to ${target.privacyStatus} at scheduled time`);

      await Notification.create({
        user: user._id,
        type: 'upload_completed',
        title: 'YouTube Video Now Public 🎉',
        message: 'Your scheduled video just went public on YouTube.'
      });
      await sendPushToUser(user, {
        title: 'Your video is public on YouTube! 🎉',
        body: 'It just switched from unlisted to public as scheduled.',
        data: { type: 'youtube_promoted', videoId: video._id.toString(), platformUrl: target.platformUrl }
      });
    } catch (err) {
      console.error(`❌ [Scheduler] Video ${video._id} / youtube: privacy promotion failed — ${err.message}`);
    }
  }
};

const startPublishScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();

      const promoted = await Video.updateMany(
        { 'platforms.status': 'pending', 'platforms.scheduledAt': { $lte: now }, 'platforms.platform': { $ne: 'youtube' } },
        { $set: { 'platforms.$[elem].status': 'queued' } },
        { arrayFilters: [{ 'elem.status': 'pending', 'elem.scheduledAt': { $lte: now }, 'elem.platform': { $ne: 'youtube' } }] }
      );
      if (promoted.modifiedCount > 0) {
        console.log(`ℹ️ [Scheduler] Promoted ${promoted.modifiedCount} video doc(s) from pending -> queued (scheduled time reached)`);
      }

      const dueVideos = await Video.find({ 'platforms.status': 'queued' }).limit(10);
      if (dueVideos.length > 0) {
        console.log(`▶️ [Scheduler] Tick found ${dueVideos.length} video(s) with queued platform target(s)`);
      }
      for (const video of dueVideos) {
        await processVideoTargets(video);
      }

      await promoteScheduledYouTubeVideos();
    } catch (err) {
      console.error('❌ [Scheduler] Publish scheduler tick error:', err.message);
    }
  });
  console.log('⏰ Multi-platform publish scheduler is running (checks every minute)');
};

const startRetryScheduler = () => {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await Video.updateMany(
        { 'platforms.status': 'failed', 'platforms.retryCount': { $lt: MAX_RETRIES } },
        { $set: { 'platforms.$[elem].status': 'queued' } },
        { arrayFilters: [{ 'elem.status': 'failed', 'elem.retryCount': { $lt: MAX_RETRIES } }] }
      );
      if (result.modifiedCount > 0) {
        console.log(`🔁 [Retry Scheduler] Promoted ${result.modifiedCount} video doc(s) with failed targets back to queued`);
      }
    } catch (err) {
      console.error('❌ [Retry Scheduler] Tick error:', err.message);
    }
  });
  console.log('🔁 Retry scheduler is running (every 15 minutes)');
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

// -----------------------------------------------------------------------
// Timezone helpers. Render's server clock runs in UTC, but every time
// value the user sets (and every "today" boundary) needs to be evaluated
// in IST (UTC+5:30 — India doesn't observe DST). getCurrentISTHHMM() gives
// the current wall-clock time/date in IST; buildISTInstant() converts an
// IST calendar date + HH:mm wall-clock time into the correct absolute UTC
// Date instant.
// -----------------------------------------------------------------------
const IST_OFFSET_MINUTES = 5 * 60 + 30;

const getCurrentISTHHMM = () => {
  const nowUtcMs = Date.now();
  const istMs = nowUtcMs + IST_OFFSET_MINUTES * 60 * 1000;
  const istDate = new Date(istMs);
  const hh = String(istDate.getUTCHours()).padStart(2, '0');
  const mm = String(istDate.getUTCMinutes()).padStart(2, '0');
  return { hhmm: `${hh}:${mm}`, istDate };
};

// istDateStr: 'YYYY-MM-DD' (IST calendar day), hhmm: 'HH:mm' (IST wall clock)
// Returns the real UTC Date instant that wall-clock moment corresponds to.
const buildISTInstant = (istDateStr, hhmm) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  const asIfUTC = new Date(`${istDateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);
  return new Date(asIfUTC.getTime() - IST_OFFSET_MINUTES * 60 * 1000);
};

// Days between two 'YYYY-MM-DD' strings (calendar days, not exact 24h blocks).
const daysBetweenDateStrings = (fromStr, toStr) => {
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T00:00:00.000Z`);
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
};

// -----------------------------------------------------------------------
// Drive auto-upload for one user, fixed to run at 06:00 IST daily.
//
// Flow (Problem 2 requirements):
//   1. Pull the next un-processed video from the user's Drive scope.
//   2. Upload it to YouTube RIGHT NOW (06:00 IST) as 'unlisted', with
//      scheduledAt = today's date + the user's chosen "Daily Upload Time".
//      publishToYouTube() (above) already knows how to do this — it just
//      needs a Video doc with status 'queued' and a future scheduledAt.
//   3. The existing promoteScheduledYouTubeVideos() tick (runs every
//      minute) flips it to public the moment that scheduledAt arrives —
//      no separate/new cron needed for that half.
//   4. If there's NO new video in Drive, mark today as a "no video" day.
//      The first time this happens, notify the user. If it stays empty for
//      2 IST calendar days in a row, auto-disconnect Drive (see
//      checkDriveInactivityAndDisconnect below) and notify.
// -----------------------------------------------------------------------
const runDriveAutoUploadForUser = async (user, todayStr) => {
  console.log(`📁 [Drive Auto-Upload] Running for user ${user._id} (${user.connectedDrive?.email || 'unknown email'}), folderId=${user.connectedDrive?.folderId || '(whole drive)'}`);

  try {
    if (!user.youtubeChannel) {
      console.warn(`⚠️ [Drive Auto-Upload] User ${user._id} has Drive connected but NO YouTube channel connected — skipping, marking today as done.`);
      user.connectedDrive.lastAutoUploadDate = todayStr;
      await user.save();
      return;
    }

    const files = await listUserDriveVideoFiles(user);
    console.log(`📁 [Drive Auto-Upload] User ${user._id}: found ${files.length} video file(s) in Drive scope. Names: ${files.map((f) => f.name).join(', ') || '(none)'}`);

    const processedIds = user.connectedDrive.driveProcessedFileIds || [];
    const nextFile = files.find((f) => !processedIds.includes(f.id));

    user.connectedDrive.lastAutoUploadDate = todayStr;

    if (!nextFile) {
      // Nothing new to upload today. Track how long this has been true so
      // the 2-day auto-disconnect rule and the "video exhausted" notice
      // (sent once, not every day) can key off it.
      const wasAlreadyEmpty = !!user.connectedDrive.noNewVideoSinceDate;
      if (!wasAlreadyEmpty) {
        user.connectedDrive.noNewVideoSinceDate = todayStr;
        console.warn(`⚠️ [Drive Auto-Upload] User ${user._id}: Drive has no new video — starting inactivity tracking from ${todayStr}.`);

        await Notification.create({
          user: user._id,
          type: 'upload_failed',
          title: 'No New Video Found in Drive 📁',
          message: 'Your Drive folder has no new video to upload today. Add a new video, or your Drive will auto-disconnect after 2 days with nothing new.'
        });
        await sendPushToUser(user, {
          title: 'No new video in your Drive 📁',
          body: 'Add a new video soon — Drive auto-disconnects after 2 days with nothing new to upload.',
          data: { type: 'drive_no_new_video' }
        });
        sendOneSignalToUser(user, {
          title: 'No new video in your Drive 📁',
          body: 'Add a new video soon — Drive auto-disconnects after 2 days with nothing new to upload.',
          data: { type: 'drive_no_new_video' }
        }).catch(() => {});
      } else {
        console.warn(`⚠️ [Drive Auto-Upload] User ${user._id}: still no new video (empty since ${user.connectedDrive.noNewVideoSinceDate}).`);
      }
      await user.save();
      return;
    }

    // Found a video — clear any inactivity tracking from previous empty days.
    user.connectedDrive.noNewVideoSinceDate = null;

    console.log(`📁 [Drive Auto-Upload] User ${user._id}: picked file "${nextFile.name}" (id=${nextFile.id}, mimeType=${nextFile.mimeType}, size=${nextFile.size}) to upload.`);

    let charge;
    try {
      charge = chargeForUpload(user);
    } catch (err) {
      console.warn(`⚠️ [Drive Auto-Upload] User ${user._id}: charge failed — ${err.message}`);
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
    console.log(`📁 [Drive Auto-Upload] User ${user._id}: downloaded "${nextFile.name}" (${buffer.length} bytes) from Drive, now storing + queueing for YouTube upload...`);

    const stored = await storeVideoFile(buffer, `${user.userId}_drive_${Date.now()}`, nextFile.mimeType || 'video/mp4');

    // Go-public time: the user's "Daily Upload Time" setting, applied to
    // TODAY's IST calendar date. If the user hasn't set one, publish
    // straight away (no unlisted staging step) rather than blocking the
    // whole flow on a missing setting.
    const dailyTime = user.connectedDrive.dailyUploadTime;
    const scheduledAt = dailyTime ? buildISTInstant(todayStr, dailyTime) : null;
    if (scheduledAt) {
      console.log(`📁 [Drive Auto-Upload] User ${user._id}: video will upload unlisted now and go public at ${scheduledAt.toISOString()} (UTC) = ${dailyTime} IST.`);
    } else {
      console.log(`📁 [Drive Auto-Upload] User ${user._id}: no Daily Upload Time set — publishing directly as public, no unlisted staging.`);
    }

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
        targetPrivacyStatus: 'public',
        scheduledAt,
        youtubePrivacyPromoted: false
      }]
    });

    user.storageUsedBytes += buffer.length;
    user.connectedDrive.driveProcessedFileIds = [...processedIds, nextFile.id];
    await user.save();

    console.log(`✅ [Drive Auto-Upload] User ${user._id}: Video doc created for "${nextFile.name}" with status 'queued' — the publish scheduler will upload it (unlisted, if scheduled) within the next minute, then promote to public at the scheduled time.`);
  } catch (err) {
    console.error(`❌ [Drive Auto-Upload] FAILED for user ${user._id}:`, err.message);
    console.error(err.stack);
  }
};

// -----------------------------------------------------------------------
// Auto-disconnects any user's Drive that has gone 2+ IST calendar days
// with no new video found (noNewVideoSinceDate set and stale by >= 2 days).
// Runs once daily, shortly after the 06:00 upload attempt.
// -----------------------------------------------------------------------
const checkDriveInactivityAndDisconnect = async (todayStr) => {
  const candidates = await User.find({
    'connectedDrive.noNewVideoSinceDate': { $ne: null }
  });

  for (const user of candidates) {
    const since = user.connectedDrive?.noNewVideoSinceDate;
    if (!since) continue;
    const idleDays = daysBetweenDateStrings(since, todayStr);
    if (idleDays < 2) continue;

    console.log(`📁 [Drive Auto-Upload] User ${user._id}: no new video for ${idleDays} day(s) (since ${since}) — auto-disconnecting Drive.`);

    user.connectedDrive = null;
    await user.save();

    await Notification.create({
      user: user._id,
      type: 'upload_failed',
      title: 'Google Drive Auto-Disconnected 🔌',
      message: `No new video was found in your Drive for ${idleDays} days, so it has been automatically disconnected. Reconnect anytime to resume auto-upload.`
    });
    await sendPushToUser(user, {
      title: 'Drive auto-disconnected 🔌',
      body: 'No new video for 2 days, so your Drive was disconnected. Reconnect anytime.',
      data: { type: 'drive_auto_disconnected' }
    });
    sendOneSignalToUser(user, {
      title: 'Drive auto-disconnected 🔌',
      body: 'No new video for 2 days, so your Drive was disconnected. Reconnect anytime.',
      data: { type: 'drive_auto_disconnected' }
    }).catch(() => {});
  }
};

const startDriveAutoUploadScheduler = () => {
  cron.schedule('* * * * *', async () => {
    try {
      const { hhmm, istDate } = getCurrentISTHHMM();
      const todayStr = istDate.toISOString().slice(0, 10);

      console.log(`📁 [Drive Auto-Upload] Tick — IST time: ${hhmm} on ${todayStr}`);

      // Fixed 06:00 IST trigger for EVERY Drive-connected user, regardless
      // of their individual "Daily Upload Time" — that setting now only
      // controls when the video goes public (handled by
      // promoteScheduledYouTubeVideos in the publish scheduler), not when
      // it's pulled from Drive and uploaded unlisted.
      if (hhmm === '06:00') {
        const dueUsers = await User.find({
          connectedDrive: { $ne: null },
          'connectedDrive.lastAutoUploadDate': { $ne: todayStr }
        });

        if (dueUsers.length > 0) {
          console.log(`📁 [Drive Auto-Upload] 06:00 IST trigger: found ${dueUsers.length} Drive-connected user(s) due for today.`);
        }
        for (const user of dueUsers) {
          await runDriveAutoUploadForUser(user, todayStr);
        }
      }

      // Runs once a day, shortly after the 06:00 trigger above so today's
      // upload attempt has already updated noNewVideoSinceDate.
      if (hhmm === '06:05') {
        await checkDriveInactivityAndDisconnect(todayStr);
      }
    } catch (err) {
      console.error('❌ Drive auto-upload scheduler tick error:', err.message);
      console.error(err.stack);
    }
  });
  console.log('📁 Drive auto-upload scheduler is running (fixed 06:00 IST pull + unlisted upload, 06:05 inactivity check; go-public time still controlled by promoteScheduledYouTubeVideos)');
};

module.exports = {
  startPublishScheduler,
  startRetryScheduler,
  startFreeUploadReset,
  startDriveAutoUploadScheduler
};
