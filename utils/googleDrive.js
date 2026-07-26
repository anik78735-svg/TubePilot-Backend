const { google } = require('googleapis');
const stream = require('stream');

const getDriveClient = () => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2Client });
};

const uploadBufferToDrive = async (buffer, filename, mimeType) => {
  const drive = getDriveClient();
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType, body: bufferStream },
    fields: 'id, webViewLink, webContentLink'
  });

  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return res.data;
};

const getDriveFileStream = async (fileId) => {
  const drive = getDriveClient();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return res.data;
};

const deleteDriveFile = async (fileId) => {
  const drive = getDriveClient();
  return drive.files.delete({ fileId });
};

module.exports = { uploadBufferToDrive, getDriveFileStream, deleteDriveFile };
