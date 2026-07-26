const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

const account1 = {
  cloud_name: process.env.CLOUDINARY_1_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_1_API_KEY,
  api_secret: process.env.CLOUDINARY_1_API_SECRET,
  maxBytes: Number(process.env.CLOUDINARY_1_MAX_GB || 25) * 1024 * 1024 * 1024
};
const account2 = {
  cloud_name: process.env.CLOUDINARY_2_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_2_API_KEY,
  api_secret: process.env.CLOUDINARY_2_API_SECRET,
  maxBytes: Number(process.env.CLOUDINARY_2_MAX_GB || 25) * 1024 * 1024 * 1024
};

const getAccountUsage = async (account) => {
  cloudinary.config(account);
  const usage = await cloudinary.api.usage();
  return usage.storage ? usage.storage.usage : 0;
};

const pickAvailableCloudinaryAccount = async (incomingFileBytes) => {
  try {
    const used1 = await getAccountUsage(account1);
    if (used1 + incomingFileBytes < account1.maxBytes) {
      return { key: 'cloudinary_1', account: account1 };
    }
  } catch (err) {
    console.error('Cloudinary account 1 usage check failed:', err.message);
  }
  try {
    const used2 = await getAccountUsage(account2);
    if (used2 + incomingFileBytes < account2.maxBytes) {
      return { key: 'cloudinary_2', account: account2 };
    }
  } catch (err) {
    console.error('Cloudinary account 2 usage check failed:', err.message);
  }
  return null;
};

const uploadBufferToCloudinary = (account, buffer, options = {}) => {
  cloudinary.config(account);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'video', folder: 'tubepilot', ...options },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
};

const deleteFromCloudinary = async (account, publicId) => {
  cloudinary.config(account);
  return cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
};

module.exports = { pickAvailableCloudinaryAccount, uploadBufferToCloudinary, deleteFromCloudinary, account1, account2 };
