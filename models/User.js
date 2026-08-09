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

const ConnectedDriveSchema = new mongoose.Schema({
  email: String,
  displayName: String,
  accessToken: String,
  refreshToken: String,
  tokenExpiryDate: Number,
  folderId: { type: String, default: null },
  folderName: { type: String, default: null },
  dailyUploadTime: { type: String, default: null },
  lastAutoUploadDate: { type: String, default: null },
  driveProcessedFileIds: [{ type: String }],
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

// Both Instagram and Facebook publishing go through a connected Facebook
// Page's access token (Meta Graph API requirement — there is no separate
// "Instagram-only" OAuth for content publishing). pageAccessToken is a
// long-lived Page token (does not expire under normal use, but can be
// invalidated by the user revoking access).
const ConnectedFacebookSchema = new mongoose.Schema({
  pageId: String,
  pageName: String,
  pageAccessToken: String,
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

// igUserId/igUsername come from the Facebook Page's linked Instagram
// Business/Creator account. Publishing uses the SAME pageAccessToken stored
// on connectedFacebook above (Instagram Graph API calls are authenticated
// with the Page token, not a separate Instagram token).
const ConnectedInstagramSchema = new mongoose.Schema({
  igUserId: String,
  igUsername: String,
  linkedPageId: String,
  connectedAt: { type: Date, default: Date.now }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
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
  diamondBalance: { type: Number, default: 0 },
  autoRefillDiamonds: { type: Boolean, default: false },
  freeUploadsRemaining: { type: Number, default: 20 },
  freeUploadsResetAt: { type: Date, default: () => new Date(new Date().setMonth(new Date().getMonth() + 1)) },
  storageUsedBytes: { type: Number, default: 0 },
  fcmTokens: [{ type: String }],
  oneSignalPlayerIds: [{ type: String }],
  youtubeChannel: { type: YouTubeChannelSchema, default: null },
  connectedDrive: { type: ConnectedDriveSchema, default: null },
  driveConnectCount: { type: Number, default: 0 },
  connectedFacebook: { type: ConnectedFacebookSchema, default: null },
  connectedInstagram: { type: ConnectedInstagramSchema, default: null },
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
  if (obj.connectedFacebook) {
    delete obj.connectedFacebook.pageAccessToken;
  }
  return obj;
};

// NOTE (Delete Account feature): actual cascade delete (Video, Transaction,
// Notification docs) lives in routes/admin.js so it can run inside a single
// place alongside the User.findByIdAndDelete call, and so this model file
// doesn't need to require other models (avoids circular-require risk).
// This model itself needs no schema changes for the feature — deleting the
// User document is enough to make a future re-login generate a brand new
// userId/referralCode/diamondBalance/freeUploadsRemaining, since those are
// all schema defaults, not something looked up from old data.

module.exports = mongoose.model('User', UserSchema);
