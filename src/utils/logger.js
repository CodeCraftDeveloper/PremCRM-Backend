import winston from "winston";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === "production";

// ── JSON format (used in production + file transports) ───────
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// ── Pretty format (used in development console) ─────────────
const prettyFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let line = `${timestamp} ${level}: ${message}`;
    const keys = Object.keys(meta).filter(
      (k) => k !== "service" && meta[k] !== undefined,
    );
    if (keys.length > 0) {
      line += ` ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, meta[k]])))}`;
    }
    if (stack) line += `\n${stack}`;
    return line;
  }),
);

// ── Create logger ────────────────────────────────────────────
const logger = winston.createLogger({
  level: isProduction ? "info" : "debug",
  defaultMeta: { service: "crm-api" },
  format: jsonFormat, // default for all transports
  transports: [
    new winston.transports.Console({
      format: isProduction ? jsonFormat : prettyFormat,
    }),
  ],
});

// ── File transports (production only) ────────────────────────
if (isProduction) {
  const logsDir = path.join(__dirname, "../../logs");
  fs.mkdirSync(logsDir, { recursive: true });

  logger.add(
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5_242_880, // 5 MB
      maxFiles: 5,
    }),
  );

  logger.add(
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize: 5_242_880,
      maxFiles: 5,
    }),
  );
}

export default logger;
