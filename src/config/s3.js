import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import logger from "../utils/logger.js";
import crypto from "crypto";
import path from "path";

// Lazy-initialised S3 client — env vars are not available at import time
// because ES-module imports are hoisted before dotenv.config() runs.
let _s3Client = null;

const getS3Client = () => {
  if (!_s3Client) {
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!region || !accessKeyId || !secretAccessKey) {
      const missing = [
        !region && "AWS_REGION",
        !accessKeyId && "AWS_ACCESS_KEY_ID",
        !secretAccessKey && "AWS_SECRET_ACCESS_KEY",
      ].filter(Boolean);
      throw new Error(
        `S3 configuration incomplete – missing env vars: ${missing.join(", ")}`,
      );
    }

    _s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return _s3Client;
};

const getBucket = () => {
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "S3 configuration incomplete – missing env var: AWS_S3_BUCKET",
    );
  }
  return bucket;
};

/**
 * Generate a unique filename
 * @param {string} originalName - Original filename
 * @returns {string} Unique filename
 */
const generateUniqueFilename = (originalName) => {
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString("hex");
  const ext = path.extname(originalName);
  return `${timestamp}-${randomString}${ext}`;
};

/**
 * Upload file to S3
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} originalName - Original filename
 * @param {string} mimeType - File MIME type
 * @param {string} folder - Folder path in S3
 * @returns {Promise<Object>} Upload result with key and URL
 */
const uploadToS3 = async (
  fileBuffer,
  originalName,
  mimeType,
  folder = "visiting-cards",
) => {
  try {
    const filename = generateUniqueFilename(originalName);
    const key = `${folder}/${filename}`;

    const command = new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
      // Make the object publicly readable (optional)
      // ACL: 'public-read',
    });

    await getS3Client().send(command);

    const url = `https://${getBucket()}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    logger.info(`File uploaded to S3: ${key}`);

    return {
      success: true,
      key,
      url,
      filename,
    };
  } catch (error) {
    logger.error(`S3 upload error: ${error.message}`, {
      code: error.Code || error.name,
      bucket: process.env.AWS_S3_BUCKET,
      region: process.env.AWS_REGION,
    });
    throw new Error(
      `Failed to upload file to S3: ${error.message || "Unknown error"}`,
    );
  }
};

/**
 * Delete file from S3
 * @param {string} key - S3 object key
 * @returns {Promise<boolean>} Success status
 */
const deleteFromS3 = async (key) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    });

    await getS3Client().send(command);
    logger.info(`File deleted from S3: ${key}`);
    return true;
  } catch (error) {
    logger.error(`S3 delete error: ${error.message}`);
    throw new Error("Failed to delete file from S3");
  }
};

/**
 * Read a stored object from S3 into memory.
 * @param {string} key - S3 object key
 * @returns {Promise<{ buffer: Buffer, contentType: string|null, contentLength: number|null }>}
 */
const getFromS3 = async (key) => {
  if (!key) throw new Error("getFromS3: key is required");
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  });
  try {
    const response = await getS3Client().send(command);
    const body = response.Body;
    if (!body) {
      throw new Error("S3 GetObject returned an empty body");
    }
    let buffer;
    if (typeof body.transformToByteArray === "function") {
      buffer = Buffer.from(await body.transformToByteArray());
    } else if (Buffer.isBuffer(body)) {
      buffer = body;
    } else if (body instanceof Uint8Array) {
      buffer = Buffer.from(body);
    } else if (typeof body[Symbol.asyncIterator] === "function") {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
    } else {
      throw new Error("Unsupported S3 response body type");
    }
    return {
      buffer,
      contentType: response.ContentType || null,
      contentLength:
        typeof response.ContentLength === "number"
          ? response.ContentLength
          : buffer.length,
    };
  } catch (error) {
    logger.error(`S3 download error: ${error.message}`, {
      code: error.Code || error.name,
      bucket: process.env.AWS_S3_BUCKET,
      region: process.env.AWS_REGION,
      key,
    });
    throw new Error(
      `Failed to download file from S3: ${error.message || "Unknown error"}`,
    );
  }
};

/**
 * Get signed URL for private file access
 * @param {string} key - S3 object key
 * @param {number} expiresIn - URL expiration in seconds (default: 1 hour)
 * @returns {Promise<string>} Signed URL
 */
const getSignedFileUrl = async (key, expiresIn = 3600) => {
  try {
    const command = new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    });

    const signedUrl = await getSignedUrl(getS3Client(), command, { expiresIn });
    return signedUrl;
  } catch (error) {
    logger.error(`S3 signed URL error: ${error.message}`);
    throw new Error("Failed to generate signed URL");
  }
};

export {
  getS3Client as s3Client,
  uploadToS3,
  deleteFromS3,
  getFromS3,
  getSignedFileUrl,
  generateUniqueFilename,
};
