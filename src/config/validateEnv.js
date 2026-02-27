/**
 * Fail-fast environment variable validation.
 * Called once at startup — before any DB / Redis / HTTP work.
 */

const REQUIRED = [
  { key: "MONGODB_URI", hint: "MongoDB connection string" },
  { key: "JWT_SECRET", hint: "Secret used to sign access tokens" },
  { key: "JWT_REFRESH_SECRET", hint: "Secret used to sign refresh tokens" },
];

const OPTIONAL_GROUPS = [
  {
    label: "Redis",
    vars: [{ key: "REDIS_URL", hint: "Redis connection URL" }],
  },
  {
    label: "AWS S3",
    vars: [
      { key: "AWS_ACCESS_KEY_ID", hint: "AWS access key" },
      { key: "AWS_SECRET_ACCESS_KEY", hint: "AWS secret key" },
      { key: "AWS_REGION", hint: "AWS region (e.g. ap-south-1)" },
      { key: "AWS_S3_BUCKET", hint: "S3 bucket name" },
    ],
  },
];

/**
 * Validate required environment variables.
 * Throws on any missing required var so the process exits immediately.
 * Warns for incomplete optional groups.
 */
const validateEnv = (logger) => {
  const missing = REQUIRED.filter((v) => !process.env[v.key]);

  if (missing.length > 0) {
    const list = missing.map((v) => `  - ${v.key}: ${v.hint}`).join("\n");
    const msg = `Missing required environment variables:\n${list}`;
    // Use console.error as logger may depend on config that hasn't loaded
    console.error(`\n❌  ${msg}\n`);
    throw new Error(msg);
  }

  // Warn for incomplete optional groups
  for (const group of OPTIONAL_GROUPS) {
    const present = group.vars.filter((v) => process.env[v.key]);
    const absent = group.vars.filter((v) => !process.env[v.key]);

    if (present.length > 0 && absent.length > 0) {
      const list = absent.map((v) => `  - ${v.key}: ${v.hint}`).join("\n");
      const msg = `${group.label} is partially configured. Missing:\n${list}`;
      if (logger) {
        logger.warn(msg);
      } else {
        console.warn(`⚠️  ${msg}`);
      }
    }
  }

  if (logger) {
    logger.info("Environment variables validated successfully");
  }
};

export default validateEnv;
