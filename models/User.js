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
  youtubeChannel: { type: YouTubeChannelSchema, default: null },
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
  return obj;
};
module.exports = mongoose.model('User', UserSchema);
