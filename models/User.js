const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const YouTubeChannelSchema = new mongoose.Schema({
  channelId: String,
  channelTitle: String,
  thumbnail: String,
  subscriberCount: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiryDate: Number,
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

// Stores the user's OWN Google Drive connection (separate from the system-wide
// storage Drive account used in utils/googleDrive.js for internal buffering).
// dailyUploadTime is stored as "HH:mm" (24h, server-local time) and is checked
// every minute by cron/scheduler.js -> startDriveAutoUploadScheduler().
// driveProcessedFileIds tracks which Drive file IDs have already been queued
// so the same video is never picked twice. lastAutoUploadDate ("YYYY-MM-DD")
// prevents the scheduler from firing more than once on the same day.
const ConnectedDriveSchema = new mongoose.Schema({
  email: String,
  displayName: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiryDate: Number,
  folderId: { type: String, default: null }, // optional: restrict to one Drive folder; null = whole Drive
  folderName: { type: String, default: null }, // display label for the picked folder ("null" = whole Drive)
  dailyUploadTime: { type: String, default: null }, // "HH:mm"
  lastAutoUploadDate: { type: String, default: null }, // "YYYY-MM-DD"
  driveProcessedFileIds: [{ type: String }],
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true }, // e.g. TP102458
  name: { type: String, default: '' },
  username: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  phone: { type: String, unique: true, sparse: true },
  password: { type: String, select: false },
  authProvider: { type: String, enum: ['local', 'google', 'phone'], default: 'local' },
  googleId: { type: String, sparse: true },
  avatar: { type: String, default: '' },
  language: { type: String, default: 'English' },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: String, default: null },
  diamondBalance: { type: Number, default: 0 }, // no starter bonus — diamonds are only granted when a valid referral code is applied (see routes/auth.js -> /apply-referral)
  autoRefillDiamonds: { type: Boolean, default: false },
  freeUploadsRemaining: { type: Number, default: 20 },
  freeUploadsResetAt: { type: Date, default: () => new Date(new Date().setMonth(new Date().getMonth() + 1)) },
  storageUsedBytes: { type: Number, default: 0 },
  fcmTokens: [{ type: String }],
  oneSignalPlayerIds: [{ type: String }], // used only for the "diamonds exhausted, please buy more" alert via OneSignal
  youtubeChannel: { type: YouTubeChannelSchema, default: null },
  connectedDrive: { type: ConnectedDriveSchema, default: null },
  // How many times this user has ever completed a Drive connect (across
  // connect/disconnect/reconnect cycles). Persists even after disconnect —
  // that's what lets us charge for the 2nd+ connect. 0 = never connected =
  // next connect is free.
  driveConnectCount: { type: Number, default: 0 },
  subscription: {
    isActive: { type: Boolean, default: false },
    plan: { type: String, default: null },
    expiresAt: { type: Date, default: null }
  },
  refreshTokens: [{ type: String }],
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

UserSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

UserSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokens;
  if (obj.youtubeChannel) {
    delete obj.youtubeChannel.accessToken;
    delete obj.youtubeChannel.refreshToken;
  }
  if (obj.connectedDrive) {
    delete obj.connectedDrive.accessToken;
    delete obj.connectedDrive.refreshToken;
    delete obj.connectedDrive.driveProcessedFileIds;
  }
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
